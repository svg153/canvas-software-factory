import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath, pathToFileURL } from "node:url";
import test from "node:test";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);
const here = dirname(fileURLToPath(import.meta.url));
const sfPath = join(here, "..", "sf.mjs");
const runPath = join(here, "..", "sf-run.mjs");
const adapterPath = join(here, "..", "test-support", "fake-run-adapter.mjs");
const preload = pathToFileURL(join(here, "..", "test-support", "fake-gh-preload.mjs")).href;

async function setup() {
  const repo = await mkdtemp(join(tmpdir(), "sf-e2e-"));
  const env = {
    ...process.env,
    NODE_OPTIONS: `--import=${preload}`,
    SF_TEST_FAKE_GH_LOG: join(repo, "gh.log"),
    SF_TEST_FAKE_GH_COUNTER: join(repo, "gh.counter"),
  };
  const sf = (...a) => execFileAsync(process.execPath, [sfPath, a[0], repo, ...a.slice(1)], { env });
  await sf("init", "--repo", "fake/x", "--project", "999", "--rounds", "2");
  await writeFile(join(repo, ".software-factory", "issues-draft.json"), JSON.stringify({
    issues: [{ title: "Issue A", body: "a", labels: ["x"] }, { title: "Issue B", body: "b" }],
  }));
  await sf("start");
  const run = (extra = {}) => execFileAsync(process.execPath, [runPath, repo, "--adapter-module", adapterPath, "--yes"], { env: { ...env, ...extra } })
    .then((r) => ({ code: 0, ...r }), (e) => ({ code: e.code, stdout: e.stdout, stderr: e.stderr }));
  const state = async () => JSON.parse(await readFile(join(repo, ".software-factory", "state.json"), "utf8"));
  const ghCalls = async () => (existsSync(env.SF_TEST_FAKE_GH_LOG)
    ? (await readFile(env.SF_TEST_FAKE_GH_LOG, "utf8")).trim().split("\n").map((l) => JSON.parse(l)) : []);
  const events = () => readFile(join(repo, ".software-factory", "events.log"), "utf8");
  return { repo, sf, run, state, ghCalls, events };
}

test("e2e happy path: all phases, 2 rounds, fake gh + fake adapter", async () => {
  const h = await setup();
  try {
    const r = await h.run();
    assert.equal(r.code, 0, r.stderr);
    const s = await h.state();
    assert.equal(s.status, "done");assert.equal(s.round, 2);
    assert.equal(s.tasks.filter((t) => t.status === "failed").length, 0);
    assert.ok(s.tasks.every((t) => t.status === "done"));
    for (const t of s.tasks) assert.ok((await readFile(t.result_file, "utf8")).trim().length > 0);
    // issues phase created 2 issues once (round 2 dedupes) and one implement task each in round 1
    assert.deepEqual(s.issues.map((i) => i.title), ["Issue A", "Issue B"]);
    const phases = s.tasks.filter((t) => t.round === 1).map((t) => t.phase);
    assert.deepEqual(phases.slice(0, 3), ["discover", "plan", "grill"]);
    assert.equal(phases.filter((p) => p === "implement").length, 2);
    assert.equal(phases.at(-1), "review");
    const calls = await h.ghCalls();
    assert.equal(calls.filter((c) => c[0] === "issue" && c[1] === "create").length, 2);
    const adds = calls.filter((c) => c[0] === "project" && c[1] === "item-add");
    assert.equal(adds.length, 2);
    assert.deepEqual(adds[0].slice(0, 5), ["project", "item-add", "999", "--owner", "fake"]);
    assert.match(await h.events(), /issues phase: 2 issues/);
    assert.match(r.stdout, /resumen: done=\d+ failed=0/);
    // re-init needs --force and then resets state
    await assert.rejects(h.sf("init", "--repo", "fake/x"));
    await h.sf("init", "--repo", "fake/x", "--force");
    const fresh = await h.state();
    assert.equal(fresh.tasks.length, 0);
    assert.equal(fresh.status, "idle");
  } finally { await rm(h.repo, { recursive: true, force: true }); }
});

test("e2e failure path: failed task is not reclaimed and the loop still finishes", async () => {
  const h = await setup();
  try {
    const marker = join(h.repo, "fail-once.marker");
    const r = await h.run({ FAKE_FAIL_ONCE: marker });
    assert.equal(r.code, 1);
    const s = await h.state();
    const failed = s.tasks.filter((t) => t.status === "failed");
    assert.equal(failed.length, 1);
    assert.equal(failed[0].phase, "discover");
    assert.match(s.notes, /fallida/);
    assert.equal(s.status, "done");
    assert.match(r.stdout, /failed=1/);
    assert.equal(s.tasks.filter((t) => t.id === failed[0].id).length, 1);
  } finally { await rm(h.repo, { recursive: true, force: true }); }
});

