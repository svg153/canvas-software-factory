# Third-party notices — `tools/schemas/`

## Agent Plugins 1.0.0 plugin manifest schema

- **Vendored file:** `tools/schemas/agent-plugins-1.0.0.plugin.schema.json`
- **Source project:** [`agentplugins/agent-plugins-spec`](https://github.com/agentplugins/agent-plugins-spec)
- **Upstream path:** `schemas/1.0.0/plugin.schema.json`
  (canonical `$id`: `https://agent-plugins.org/schemas/1.0.0/plugin.schema.json`)
- **License:** Apache License 2.0. Per the upstream `LICENSE.md`, "Schemas, source
  code, scripts, and other software material" are licensed under Apache-2.0
  (`LICENSES/Apache-2.0.txt`). A verbatim copy of that license ships here as
  `LICENSE-Apache-2.0.txt`.
- **Modifications:** formatting/indentation only (the vendored copy was
  re-serialized when it was checked in). The JSON content is semantically
  identical to the upstream schema.
- **Purpose:** vendored so `tools/check-external-layout.mjs` can validate
  `plugin.json` reproducibly in CI without network access.
- **Upstream notices:** the upstream repository root contains no `NOTICE` file
  (checked 2026-11-02); no additional attribution beyond the license above is
  required by upstream.

## This repository's own code

All first-party code, documentation and assets in `svg153/canvas-software-factory`
(README, runner, canvas extension, skills, tooling) remain under the MIT license
declared in the repository-root `LICENSE`. This notice applies only to the
vendored schema material above and does not relicense it.
