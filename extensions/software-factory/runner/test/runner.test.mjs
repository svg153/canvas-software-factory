// Tests del runner: unit (state/gh) + integración CLI end-to-end.
// Ejecutar: node --test extensions/software-factory/runner/test/
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  defaultState,
  openTasks,
  newTask,
  paths,
  hasResult,
  PHASES,
} from "../lib/state.mjs";
import { discoverPrompt, planPrompt } from "../lib/prompts.mjs";
import { createIssuesFromDraft } from "../lib/gh.mjs";

const SF = fileURLToPath(new URL("../sf.mjs", import.meta.url));

// argv de sf.mjs: [node, sf, <command>, <repoPath>, ...flags]
const sf = (dir, cmd, ...args) =>
  spawnSync(process.execPath, [SF, cmd, dir, ...args], { encoding: "utf8" });

const mkRepo = () => mkdtemp(join(tmpdir(), "sf-test-"));
const json = (stdout) => JSON.parse(stdout);

test("openTasks: done y failed cierran la fase (regresión deadlock)", () => {
  const s = defaultState("/x", {});
  s.tasks.push(
    { phase: "discover", status: "pending" },
    { phase: "discover", status: "awaiting_agent" },
    { phase: "discover", status: "done" },
    { phase: "discover", status: "failed" },
  );
  assert.equal(openTasks(s, "discover").length, 2);
});

test("paths: estructura bajo <repo>/.software-factory", () => {
  const p = paths("/repo");
  assert.ok(p.root.endsWith(".software-factory"));
  for (const k of ["state", "pending", "results", "log", "plan", "draft"]) {
    assert.ok(p[k].startsWith(p.root), k);
  }
});

test("newTask: ids sin colisión y ficheros asociados", () => {
  const s = defaultState("/x", {});
  const a = newTask(s, "discover", "A");
  const b = newTask(s, "plan", "B");
  assert.notEqual(a.id, b.id);
  assert.match(a.id, /^r1-discover-\d{2}$/);
  assert.ok(a.result_file.endsWith(".md"));
  assert.equal(s.tasks.length, 2);
});

test("prompts: destino de resultado único = task.result_file", () => {
  const s = defaultState("/abs/repo", {});
  const t = newTask(s, "discover", "A");
  const txt = discoverPrompt(s, t);
  assert.ok(txt.includes(t.result_file));
  assert.ok(!txt.includes("discover-r"), "no debe mencionar rutas alternativas");
  const plan = planPrompt(s, t);
  assert.ok(plan.includes(`r${s.round}-discover-*`));
});

test("gh: guard de repo slug antes de tocar la CLI", async () => {
  const dir = await mkRepo();
  const st = { repo: "", repo_path: dir, issues: [] };
  await assert.rejects(
    createIssuesFromDraft(st, { dryRun: false }),
    /owner\/repo/,
  );
});

test("gh: dry-run sin draft es no-op limpio", async () => {
  const dir = await mkRepo();
  const st = { repo: "foo/bar", repo_path: dir, issues: [] };
  // sin issues-draft.json -> la lectura cae a {"issues":[]}
  const out = await createIssuesFromDraft(st, { dryRun: true });
  assert.equal(out.length, 0);
  assert.equal(st.issues.length, 0);
});

test("CLI e2e: init, guards, next con prompt, complete con/sin informe", async () => {
  const dir = await mkRepo();
  // init fresh
  let r = sf(dir, "init", "--repo", "foo/bar");
  assert.equal(r.status, 0, r.stderr);
  assert.equal(json(r.stdout).state, "idle");

  // re-init bloqueado sin --force
  r = sf(dir, "init", "--repo", "foo/bar");
  assert.equal(r.status, 1);
  assert.match(r.stderr, /--force/);

  // --force pasa
  r = sf(dir, "init", "--repo", "foo/bar", "--force");
  assert.equal(r.status, 0, r.stderr);

  // init sobre ruta inexistente: error claro
  r = sf(join(dir, "no-existe"), "init", "--repo", "foo/bar");
  assert.equal(r.status, 1);
  assert.match(r.stderr, /no existe/);

  // start + next emite work orders con prompt
  assert.equal(sf(dir, "start").status, 0);
  r = sf(dir, "next");
  assert.equal(r.status, 0, r.stderr);
  const next = json(r.stdout);
  assert.equal(next.phase, PHASES[0]);
  assert.ok(next.tasks.length >= 1);
  const t = next.tasks[0];
  assert.ok(t.prompt && t.prompt.length > 10, "el work order debe traer prompt");

  // complete sin informe -> rechazado
  r = sf(dir, "complete", t.id);
  assert.equal(r.status, 1);
  assert.match(r.stderr, /Sin informe/);

  // con informe -> aceptado
  const resultFile = join(dir, ".software-factory", "results", `${t.id}.md`);
  assert.ok(!(await hasResult({ result_file: resultFile })));
  await writeFile(resultFile, "# informe de prueba");
  r = sf(dir, "complete", t.id);
  assert.equal(r.status, 0, r.stderr);
  assert.equal(json(r.stdout).status, "done");

  // status expone notes (aunque esté vacío)
  const s2 = json(sf(dir, "status").stdout);
  assert.ok("notes" in s2);
});

test("CLI: issues --dry-run no contamina el estado", async () => {
  const dir = await mkRepo();
  sf(dir, "init", "--repo", "foo/bar");
  const p = paths(dir);
  await writeFile(
    p.draft,
    JSON.stringify({ issues: [{ title: "T1", body: "b" }] }),
  );
  const r = sf(dir, "issues", "--dry-run");
  assert.equal(r.status, 0, r.stderr);
  const created = json(r.stdout);
  assert.equal(created.created, 1);
  assert.ok(created.urls[0].dry, "fake marcado como dry");
  const s = json(sf(dir, "status").stdout);
  assert.equal(s.issues_created, 0, "state.issues NO debe crecer en dry-run");
});

test("CLI: issues sin repo configurado falla con mensaje accionable", async () => {
  const dir = await mkRepo();
  sf(dir, "init"); // sin --repo
  const p = paths(dir);
  await writeFile(p.draft, JSON.stringify({ issues: [{ title: "T" }] }));
  const r = sf(dir, "issues");
  assert.equal(r.status, 1);
  assert.match(r.stderr, /owner\/repo/);
});
