import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtemp, mkdir, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { request } from "node:http";
import { symlink } from "node:fs/promises";
import { startStandalone } from "../server.mjs";

function raw(url, { path = "/", headers = {} } = {}) {
  const u = new URL(url);
  return new Promise((resolve, reject) => {
    const req = request({ host: u.hostname, port: u.port, path, headers }, (res) => {
      res.resume();
      res.on("end", () => resolve(res.statusCode));
    });
    req.on("error", reject);
    req.end();
  });
}

test("Host/Origin allowlist, token y realpath (in-process)", async () => {
  const repo = await mkdtemp(join(tmpdir(), "sf-sec-"));
  const outside = await mkdtemp(join(tmpdir(), "sf-out-"));
  await mkdir(join(repo, ".software-factory"));
  await writeFile(join(repo, ".software-factory", "state.json"), JSON.stringify({ phase: "discover", round: 1, status: "paused" }));
  const srv = await startStandalone(["--repo", repo]);
  try {
    const port = new URL(srv.url).port;
    const token = (await (await fetch(`${srv.url}/token`)).json()).token;
    assert.equal(await raw(srv.url, { headers: { host: "evil.example" } }), 403);
    assert.equal(await raw(srv.url, { path: "/state", headers: { host: `evil.example:${port}`, "x-sf-token": token } }), 403);
    assert.equal(await raw(srv.url, { path: "/state", headers: { origin: "http://evil.example", "x-sf-token": token } }), 403);
    assert.equal(await raw(srv.url, { path: "/state" }), 401);
    assert.equal(await raw(srv.url, { path: "/state", headers: { origin: `http://127.0.0.1:${port}`, "x-sf-token": token } }), 200);
    assert.equal(await raw(srv.url, { path: "/state", headers: { host: `localhost:${port}`, "x-sf-token": token } }), 200);
    assert.equal(await raw(srv.url, { path: "/events" }), 401);
    // symlink dentro del repo que apunta fuera: rechazado por realpath
    let linked = true;
    try {
      await symlink(outside, join(repo, "link"), "junction");
    } catch {
      linked = false;
    }
    if (linked) {
      const p = `/state?repo=${encodeURIComponent(join(repo, "link"))}`;
      assert.equal(await raw(srv.url, { path: p, headers: { "x-sf-token": token } }), 400);
    }
    assert.equal(await raw(srv.url, { path: `/state?repo=${encodeURIComponent(join(repo, "..", "x"))}`, headers: { "x-sf-token": token } }), 400);
  } finally {
    srv.close();
    await rm(repo, { recursive: true, force: true });
    await rm(outside, { recursive: true, force: true });
  }
});

test("--allow-host habilita un host extra", async () => {
  const repo = await mkdtemp(join(tmpdir(), "sf-sec-"));
  const srv = await startStandalone(["--repo", repo, "--allow-host", "lan.test"]);
  try {
    assert.equal(await raw(srv.url, { path: "/token", headers: { host: `lan.test:${new URL(srv.url).port}` } }), 200);
  } finally {
    srv.close();
    await rm(repo, { recursive: true, force: true });
  }
});

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
    const html = await (await fetch(`${url}/`)).text();
    assert.doesNotMatch(html, /[0-9a-f]{48}/, "GET / no debe exponer el token");
    const token = (await (await fetch(`${url}/token`)).json()).token;
    assert.equal((await fetch(`${url}/state`)).status, 401);
    const state = await (await fetch(`${url}/state`, { headers: { "x-sf-token": token } })).json();
    assert.equal(state.phase, "discover");
    const post = (headers) => fetch(`${url}/action`, { method: "POST", headers: { "content-type": "application/json", ...headers }, body: JSON.stringify({ actionName: "play" }) });
    assert.equal((await post({})).status, 403);
    assert.equal((await post({ "x-sf-token": token, origin: "http://evil.example" })).status, 403);
    const ok = await post({ "x-sf-token": token });
    assert.match((await ok.json()).status, /sf-run/);
    assert.equal((await fetch(`${url}/state?repo=${encodeURIComponent(tmpdir())}`, { headers: { "x-sf-token": token } })).status, 400);
  } finally {
    child.kill();
    await rm(repo, { recursive: true, force: true });
  }
});

test("Origin con otro puerto, /token con Sec-Fetch/UA y resolveRepo real", async () => {
  const repo = await mkdtemp(join(tmpdir(), "sf-sec-"));
  const srv = await startStandalone(["--repo", repo]);
  try {
    const port = Number(new URL(srv.url).port);
    const token = (await (await fetch(`${srv.url}/token`)).json()).token;
    assert.equal(await raw(srv.url, { path: "/state", headers: { origin: `http://localhost:${port + 1}`, "x-sf-token": token } }), 403);
    const browserUa = "Mozilla/5.0 (Windows NT 10.0) AppleWebKit/537.36 Chrome/120.0 Safari/537.36";
    assert.equal(await raw(srv.url, { path: "/token", headers: { "sec-fetch-site": "same-origin", "user-agent": browserUa } }), 200);
    assert.equal(await raw(srv.url, { path: "/token", headers: { "user-agent": browserUa } }), 403);
    assert.equal(await raw(srv.url, { path: "/token", headers: { "user-agent": "curl/8.0" } }), 200);
    const { realpathSync } = await import("node:fs");
    const state = await (await fetch(`${srv.url}/state?repo=${encodeURIComponent(repo)}`, { headers: { "x-sf-token": token } })).json();
    assert.ok(state);
    assert.ok(realpathSync(repo));
  } finally {
    srv.close();
    await rm(repo, { recursive: true, force: true });
  }
});
