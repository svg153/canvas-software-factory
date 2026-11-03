import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtemp, readFile, writeFile, rm } from "node:fs/promises";
import { dirname, join } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { promisify } from "node:util";
import { HARNESSES, HARNESS_IDS } from "../lib/harnesses.mjs";
import { HARNESSES as STATE_IDS } from "../lib/state.mjs";
import { get, list } from "../lib/adapters/index.mjs";

const execFileAsync = promisify(execFile);
const here = dirname(fileURLToPath(import.meta.url));
const sfPath = join(here, "..", "sf.mjs");
const runPath = join(here, "..", "sf-run.mjs");

const exec = (script, args) => execFileAsync(process.execPath, [script, ...args]).then(
  (r) => ({ code: 0, ...r }), (e) => ({ code: e.code, stdout: e.stdout, stderr: e.stderr }));

async function repoWith(cfg) {
  const repo = await mkdtemp(join(tmpdir(), "sf-cfg-"));
  await exec(sfPath, ["init", repo, "--repo", "o/r"]);
  await exec(sfPath, ["start", repo]);
  const p = join(repo, ".software-factory", "state.json");
  const s = JSON.parse(await readFile(p, "utf8"));
  await writeFile(p, JSON.stringify({ ...s, ...cfg }));
  return repo;
}

test("single registry: state ids and adapters derive from harnesses.mjs", () => {
  assert.deepEqual(STATE_IDS, HARNESS_IDS);
  assert.deepEqual(list(), HARNESS_IDS);
  assert.equal(HARNESSES.codex.id, "codex");
});

test("config harness/model -> launch command for that harness and model", async () => {
  const repo = await repoWith({ harness: "codex", model: "gpt-x" });
  try {
    const r = await exec(runPath, [repo, "--dry-run"]);
    assert.equal(r.code, 0, r.stderr);
    assert.match(r.stdout, /harness=codex model=gpt-x/);
    assert.deepEqual(get("codex").buildCommand({ prompt: "p", model: "gpt-x" }),
      { cmd: "codex", args: ["exec", "--full-auto", "--model", "gpt-x"], stdin: "p" });
  } finally { await rm(repo, { recursive: true, force: true }); }
});

test("CLI flags win over config", async () => {
  const repo = await repoWith({ harness: "codex", model: "gpt-x" });
  try {
    const r = await exec(runPath, [repo, "--dry-run", "--harness", "claude", "--model", "opus"]);
    assert.match(r.stdout, /harness=claude model=opus/);
  } finally { await rm(repo, { recursive: true, force: true }); }
});

test("unknown harness in config fails fast listing valid ids", async () => {
  const repo = await repoWith({ harness: "no-existe" });
  try {
    const r = await exec(runPath, [repo, "--dry-run"]);
    assert.notEqual(r.code, 0);
    assert.match(r.stderr, /Unknown harness 'no-existe' \(state\.json\).*copilot, claude, codex/);
  } finally { await rm(repo, { recursive: true, force: true }); }
});

test("invalid model in config fails fast", async () => {
  const repo = await repoWith({ harness: "codex", model: "--evil flag" });
  try {
    const r = await exec(runPath, [repo, "--dry-run"]);
    assert.notEqual(r.code, 0);
    assert.match(r.stderr, /Invalid model/);
  } finally { await rm(repo, { recursive: true, force: true }); }
});
