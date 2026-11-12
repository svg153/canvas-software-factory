// E2E del gating por olas: un draft con depends_on debe emitir work orders de
// implement SOLO en orden topológico (una ola a la vez), reportar las bloqueadas
// en `blocked` y avanzar a review al terminar todas. Usa el gh falso de los tests.
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath, pathToFileURL } from "node:url";
import test from "node:test";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);
const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../../../../../");
const extensionDir = join(repoRoot, "com.github.copilot", "extensions", "software-factory");
const runnerPath = join(extensionDir, "runner", "sf.mjs");
const fakeGhPreload = join(extensionDir, "runner", "test-support", "fake-gh-preload.mjs");

function ghEnv(tempDir) {
  return {
    ...process.env,
    NODE_OPTIONS: `--import=${pathToFileURL(fakeGhPreload).href}`,
    SF_TEST_FAKE_GH_LOG: join(tempDir, "gh-calls.log"),
    SF_TEST_FAKE_GH_COUNTER: join(tempDir, "gh-counter"),
  };
}

test("implement se emite ola a ola según depends_on y avanza a review al completar", async (t) => {
  const tempDir = await mkdtemp(join(tmpdir(), "sf-waves-"));
  t.after(() => rm(tempDir, { recursive: true, force: true }));
  const repo = join(tempDir, "repo");
  await mkdir(repo);
  const run = (...args) => execFileAsync(process.execPath, [runnerPath, ...args], { env: ghEnv(tempDir) });
  const next = async () => JSON.parse((await run("next", repo)).stdout);

  await run("init", repo, "--repo", "org/repo", "--rounds", "1");
  await run("start", repo);
  await writeFile(join(repo, ".software-factory", "issues-draft.json"), JSON.stringify({
    issues: [
      { id: "base", title: "Extraer módulo base", depends_on: [] },
      { id: "consumidor", title: "Consumir módulo base", depends_on: ["base"] },
      { id: "docs", title: "Documentar", depends_on: ["consumidor"] },
    ],
  }));

  // discover/plan/grill/issues: completar work orders hasta llegar a implement.
  let out = await next();
  let guard = 0;
  while (!(out.phase === "implement" && out.tasks.length) && guard++ < 30) {
    for (const task of out.tasks || []) await run("complete", repo, task.id, "--force");
    out = await next();
  }

  // Ola 0: SOLO "base" es reclamable; las otras dos aparecen en blocked.
  assert.deepEqual(out.tasks.map((x) => x.title), ["Implementar #1 Extraer módulo base"]);
  assert.deepEqual(out.blocked.map((b) => b.title), ["Consumir módulo base", "Documentar"]);
  assert.deepEqual(out.blocked[0].depends_on, [1]);

  // Grafo persistido: refs resueltos a números reales + olas 0/1/2.
  const state = JSON.parse(await readFile(join(repo, ".software-factory", "state.json"), "utf8"));
  assert.deepEqual(state.issues.map((i) => i.wave), [0, 1, 2]);
  assert.deepEqual(state.issues.map((i) => i.depends_on), [[], [1], [2]]);

  // Completar la ola 0 libera la 1 en el mismo call a next.
  await run("complete", repo, out.tasks[0].id, "--force");
  out = await next();
  assert.deepEqual(out.tasks.map((x) => x.title), ["Implementar #2 Consumir módulo base"]);
  assert.deepEqual(out.blocked.map((b) => b.number), [3]);

  await run("complete", repo, out.tasks[0].id, "--force");
  out = await next();
  assert.deepEqual(out.tasks.map((x) => x.title), ["Implementar #3 Documentar"]);
  assert.equal(out.blocked, undefined);

  await run("complete", repo, out.tasks[0].id, "--force");
  out = await next();
  assert.equal(out.phase, "review", "sin bloqueos pendientes: la fase avanza");
});
