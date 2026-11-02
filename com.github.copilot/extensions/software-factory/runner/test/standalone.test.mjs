import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtemp, mkdir, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

const RUNNER_DIR = join(dirname(fileURLToPath(import.meta.url)), "..");

async function sources(dir) {
  const out = [];
  for (const e of await readdir(dir, { withFileTypes: true })) {
    if (e.name === "test" || e.name === "test-support" || e.name === "node_modules") continue;
    const p = join(dir, e.name);
    if (e.isDirectory()) out.push(...(await sources(p)));
    else if (e.name.endsWith(".mjs")) out.push(p);
  }
  return out;
}

test("runner/ no importa @github/copilot-sdk", async () => {
  for (const file of await sources(RUNNER_DIR)) {
    assert.doesNotMatch(await readFile(file, "utf8"), /(?:from\s*|import\s*\(?\s*)["']@github\/copilot-sdk/, file);
  }
});

test("server.mjs standalone sirve /state, aplica CSRF y allowlist", async () => {
  const repo = await mkdtemp(join(tmpdir(), "sf-standalone-"));
  await mkdir(join(repo, ".software-factory"));
  await writeFile(join(repo, ".software-factory", "state.json"), JSON.stringify({ phase: "discover", round: 1, status: "paused" }));
  const child = spawn(process.execPath, [join(RUNNER_DIR, "server.mjs"), "--repo", repo], { stdio: ["ignore", "pipe", "inherit"] });
  try {
    const url = await new Promise((resolve, reject) => {
      let buf = "";
      child.stdout.on("data", (d) => {
        buf += d;
        const m = buf.match(/(http:\/\/127\.0\.0\.1:\d+)/);
        if (m) resolve(m[1]);
      });
      child.once("exit", () => reject(new Error("server terminó")));
    });
    const state = await (await fetch(`${url}/state`)).json();
    assert.equal(state.phase, "discover");
    const html = await (await fetch(`${url}/`)).text();
    const token = html.match(/[0-9a-f]{48}/)?.[0];
    const post = (headers) => fetch(`${url}/action`, { method: "POST", headers: { "content-type": "application/json", ...headers }, body: JSON.stringify({ actionName: "play" }) });
    assert.equal((await post({})).status, 403);
    assert.equal((await post({ "x-sf-action-token": token, origin: "http://evil.example" })).status, 403);
    const ok = await post({ "x-sf-action-token": token });
    assert.match((await ok.json()).status, /sf-run/);
    assert.equal((await fetch(`${url}/state?repo=${encodeURIComponent(tmpdir())}`)).status, 400);
  } finally {
    child.kill();
    await rm(repo, { recursive: true, force: true });
  }
});
