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

## Honest limitations
- **Unverified build**: this skeleton was written without a Rust toolchain; `tauri dev` has NOT been run. Only config parsing and the sidecar contract are tested (plain node).
- **Depends on PR #52**: the SDK-free `runner/server.mjs` does not exist on this base branch; the sidecar fails with a clear error until it lands.
- No harness/model selector, Play/Pause wiring or `state.json` persistence yet (follow-up; needs #52 and sf-run).
- No icons, packaging, signing or CI build (`bundle.active=false`). Tauri may require adding icons (`tauri icon`) before building.
- Sidecar is spawned on start and killed on exit; the port is not auto-chosen.