import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import http from "node:http";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { buildSidecarArgs, getFlag, parseCliArgs, sidecarUrl, startSidecar } from "../sidecar.mjs";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const read = (p) => fs.readFileSync(path.join(root, p), "utf8");

test("config JSON files parse and have expected shape", () => {
  const conf = JSON.parse(read("src-tauri/tauri.conf.json"));
  assert.equal(conf.app.windows[0].title, "Software Factory");
  assert.match(conf.build.devUrl, /^http:\/\/127\.0\.0\.1:\d+\/$/);
  assert.equal(conf.app.windows[0].url, conf.build.devUrl);
  const pkg = JSON.parse(read("package.json"));
  assert.ok(pkg.scripts.dev && pkg.scripts.build && pkg.devDependencies["@tauri-apps/cli"]);
});

test("Cargo.toml has basic tauri v2 structure", () => {
  const toml = read("src-tauri/Cargo.toml");
  assert.match(toml, /^\[package\]/m);
  assert.match(toml, /^tauri = \{ version = "2"/m);
  assert.match(toml, /^\[build-dependencies\]/m);
});

test("sidecar args and url contract", () => {
  assert.deepEqual(buildSidecarArgs({ server: "s.mjs", repo: "r", port: 4317 }), ["s.mjs", "--repo", "r", "--port", "4317", "--allow-repo", "r"]);
  assert.equal(sidecarUrl(4317), "http://127.0.0.1:4317/");
  assert.throws(() => buildSidecarArgs({ port: 1 }));
});

test("missing entrypoint gives a clear error", () => {
  assert.throws(() => startSidecar({ server: path.join(root, "nope.mjs"), repo: "r", port: 4317 }),   /runner\/server\.mjs/);
});

  test("flag parser: missing/valueless flags fall back to defaults", () => {
    assert.deepEqual(parseCliArgs([]), { repo: undefined, port: 4317 });
    assert.deepEqual(parseCliArgs(["--repo", "r"]), { repo: "r", port: 4317 });
    assert.deepEqual(parseCliArgs(["--port", "--repo", "r"]), { repo: "r", port: 4317 });
    assert.deepEqual(parseCliArgs(["--repo", "r", "--port", "5000"]), { repo: "r", port: 5000 });
    assert.deepEqual(parseCliArgs([], { SF_REPO: "e", SF_PORT: "6000" }), { repo: "e", port: 6000 });
    assert.equal(getFlag(["--port"], "--port"), undefined);
  });

  test("tauri.conf.json: frontendDist and icons exist", () => {
    const conf = JSON.parse(read("src-tauri/tauri.conf.json"));
    assert.ok(fs.statSync(path.join(root, "src-tauri", conf.build.frontendDist)).isDirectory());
    assert.ok(fs.existsSync(path.join(root, "src-tauri", conf.build.frontendDist, "index.html")));
    assert.ok(conf.bundle.icon.some((i) => i.endsWith(".ico")));
    for (const i of conf.bundle.icon) assert.ok(fs.existsSync(path.join(root, "src-tauri", i)), i);
  });

test("stub sidecar serves on the URL the window loads", async () => {
  const stub = path.join(root, "test", "stub-server.mjs");
  fs.writeFileSync(stub, `import http from "node:http";
const a = process.argv; const port = Number(a[a.indexOf("--port") + 1]);
http.createServer((q, r) => r.end("stub-ok")).listen(port, "127.0.0.1");\n`);
  const probe = http.createServer().listen(0, "127.0.0.1");
  await new Promise((r) => probe.once("listening", r));
  const port = probe.address().port;
  await new Promise((r) => probe.close(r));
  const sc = startSidecar({ server: stub, repo: "r", port });
  try {
    let body;
    for (let i = 0; i < 50 && !body; i++) {
      body = await fetch(sidecarUrl(port)).then((r) => r.text()).catch(() => null);
      if (!body) await new Promise((r) => setTimeout(r, 100));
    }
    assert.equal(body, "stub-ok");
  } finally { sc.stop(); fs.rmSync(stub); }
});