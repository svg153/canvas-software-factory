# Software Factory Desktop (Tauri v2 skeleton)

Native window that loads the canvas UI served by a local node sidecar
(`runner/server.mjs --repo <r> --port <p> --allow-repo <r>`). Everything is local, no telemetry.

## Prerequisites
- Node 20+, Rust (stable, via rustup), WebView2 runtime (Windows 11 ships it), MSVC build tools.

## Run (dev)
```
cd desktop && npm install
$env:SF_REPO = "C:\path\to\repo"; $env:SF_PORT = "4317"
npm run dev
```
The window URL (`src-tauri/tauri.conf.json`) is fixed to `127.0.0.1:4317`; change it with `SF_PORT`.
`desktop/sidecar.mjs` is the plain-node equivalent of the Rust launcher (testable without Rust): `npm test`.

## Verified vs unverified
- Verified (CI, plain node, `node --test desktop/test/`): `tauri.conf.json`/`package.json` parse, `frontendDist` (`dist/index.html`) and bundle icons exist, `Cargo.toml` basic structure, sidecar flag parser (missing/valueless flags → defaults), sidecar arg contract and stub-server launch.
- **NOT verified: Rust side.** No `cargo check`/`tauri dev`/`tauri build` has been run (no Rust toolchain, webkit deps unavailable in CI). Do not assume the app builds.
- Icons are generated placeholders (solid colour); replace with real artwork via `tauri icon`.
- Requires `runner/server.mjs` (standalone sidecar); the sidecar fails with a clear error if absent.
- No harness/model selector, Play/Pause wiring or `state.json` persistence yet.
- No packaging, signing or CI build (`bundle.active=false`). The port is not auto-chosen.