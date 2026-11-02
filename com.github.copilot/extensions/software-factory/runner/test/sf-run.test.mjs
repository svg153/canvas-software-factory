import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);
const here = dirname(fileURLToPath(import.meta.url));
const sfPath = join(here, "..", "sf.mjs");
const runPath = join(here, "..", "sf-run.mjs");
const fakePath = join(here, "..", "test-support", "fake-run-adapter.mjs");

async function sf(...args) {
  return execFileAsync(process.execPath, [sfPath, ...args]);
}

async function started() {
  const repo = await mkdtemp(join(tmpdir(), "sf-run-"));
  await sf("init", repo, "--repo", "o/r");
  await sf("start", repo);
  return repo;
}

function run(repo, args, env = {}) {
  return execFileAsync(process.execPath, [runPath, repo, "--adapter-module", fakePath, ...args], {
    env: { ...process.env, ...env },
  }).then((r) => ({ code: 0, ...r }), (e) => ({ code: e.code, stdout: e.stdout, stderr: e.stderr }));
}

const readState = async (repo) => JSON.parse(await readFile(join(repo, ".software-factory", "state.json"), "utf8"));

test("full loop: discover->plan->grill complete, state coherent", async () => {
  const repo = await started();
  try {
    const r = await run(repo, ["--yes", "--max-tasks", "3"]);
    assert.equal(r.code, 0, r.stderr);
    const s = await readState(repo);
    assert.deepEqual(s.tasks.map((t) => [t.phase, t.status]), [["discover", "done"], ["plan", "done"], ["grill", "done"]]);
    assert.match(r.stdout, /resumen: done=3 failed=0/);
  } finally { await rm(repo, { recursive: true, force: true }); }
});

test("--dry-run executes nothing and writes no state", async () => {
  const repo = await started();
  const log = join(repo, "calls.log");
  try {
    const before = await readFile(join(repo, ".software-factory", "state.json"), "utf8");
    const r = await run(repo, ["--dry-run", "--yes"], { FAKE_RUN_LOG: log });
    assert.equal(r.code, 0, r.stderr);
    assert.match(r.stdout, /DRY-RUN/);
    assert.equal(existsSync(log), false);
    assert.equal(await readFile(join(repo, ".software-factory", "state.json"), "utf8"), before);
  } finally { await rm(repo, { recursive: true, force: true }); }
});

test("--max-tasks is respected", async () => {
  const repo = await started();
  try {
    await run(repo, ["--yes", "--max-tasks", "1"]);
    const s = await readState(repo);
    assert.equal(s.tasks.filter((t) => t.status === "done").length, 1);
  } finally { await rm(repo, { recursive: true, force: true }); }
});

test("without --yes: implement tasks are not launched and are listed as skipped", async () => {
  const repo = await started();
  const log = join(repo, "calls.log");
  try {
    // Force an implement work order to be the pending one.
    const p = join(repo, ".software-factory", "state.json");
    const s = await readState(repo);
    s.phase = "implement";
    s.tasks = [{ id: "t-impl", phase: "implement", round: s.round, title: "impl", status: "awaiting_agent",
      prompt_file: join(repo, "p.md"), result_file: join(repo, "r.md") }];
    await writeFile(p, JSON.stringify(s));
    await writeFile(join(repo, "p.md"), "do it");
    const r = await run(repo, [], { FAKE_RUN_LOG: log });
    assert.equal(r.code, 0, r.stderr);
    assert.match(r.stdout, /omitida t-impl/);
    assert.equal(existsSync(log), false);
  } finally { await rm(repo, { recursive: true, force: true }); }
});

test("failing adapter and missing report -> task failed, loop continues", async () => {
  for (const mode of ["fail", "noreport"]) {
    const repo = await started();
    try {
      const r = await run(repo, ["--yes", "--max-tasks", "2"], { FAKE_RUN_MODE: mode });
      assert.equal(r.code, 1);
      const s = await readState(repo);
      assert.deepEqual(s.tasks.map((t) => t.status), ["failed", "failed"]);
      assert.match(s.notes, /discover|t-/);
    } finally { await rm(repo, { recursive: true, force: true }); }
  }
});

test("paused factory stops gracefully", async () => {
  const repo = await started();
  try {
    await sf("pause", repo);
    const r = await run(repo, ["--yes"]);
    assert.equal(r.code, 0);
    assert.match(r.stdout, /status=paused/);
  } finally { await rm(repo, { recursive: true, force: true }); }
});

import { validateOptions } from "../sf-run.mjs";
import { killTree } from "../lib/adapters/core.mjs";

test("validateOptions rejects bad --timeout / --max-tasks", () => {
  for (const t of ["abc", "0", "-5", "NaN", "Infinity", ""]) assert.match(validateOptions({ timeoutSec: t }).error, /--timeout/, t);
  for (const m of ["abc", "0", "-1", "1.5"]) assert.match(validateOptions({ maxTasks: m }).error, /--max-tasks/, m);
  assert.equal(validateOptions({ timeoutSec: "1.5", maxTasks: "3" }).timeoutSec, 1.5);
  assert.equal(validateOptions({}).error, undefined);
});

test("sf-run --timeout abc exits 2 without running", async () => {
  const repo = await started();
  try {
    const r = await run(repo, ["--timeout", "abc"]);
    assert.equal(r.code, 2);
    assert.match(r.stderr, /--timeout inválido/);
  } finally { await rm(repo, { recursive: true, force: true }); }
});

test("killTree uses taskkill on win32 and process-group kill on posix", () => {
  const calls = [];
  killTree(42, "win32", (...a) => calls.push(["exec", ...a]), () => calls.push(["kill"]));
  assert.deepEqual(calls[0].slice(0, 3), ["exec", "taskkill", ["/T", "/F", "/PID", "42"]]);
  const k = [];
  killTree(42, "linux", () => k.push("exec"), (...a) => k.push(a));
  assert.deepEqual(k, [[-42, "SIGKILL"]]);
});

test("--timeout 1 kills hung harness tree and exits 124", async () => {
  const repo = await started();
  const pidFile = join(repo, "child.pid");
  const hangPath = join(here, "..", "test-support", "hang-adapter.mjs");
  const t0 = Date.now();
  try {
    const r = await execFileAsync(process.execPath, [runPath, repo, "--adapter-module", hangPath, "--yes", "--timeout", "1"], {
      env: { ...process.env, HANG_PID_FILE: pidFile },
    }).then((x) => ({ code: 0, ...x }), (e) => ({ code: e.code, stderr: e.stderr }));
    assert.equal(r.code, 124, r.stderr);
    assert.ok(Date.now() - t0 < 5000, "exit took too long");
    if (process.platform === "win32" && existsSync(pidFile)) {
      const pid = Number(await readFile(pidFile, "utf8"));
      await new Promise((res) => setTimeout(res, 300));
      let alive = true;
      try { process.kill(pid, 0); } catch { alive = false; }
      assert.equal(alive, false, "child still alive");
    }
  } finally { await rm(repo, { recursive: true, force: true }); }
});
