# 🏭 Software Factory

Plugin for **GitHub Copilot** (desktop app + CLI): press **▶ Play** in the canvas and
an agent iterates over a repo autonomously — audits it, plans (GSD style), grills its
own plan, files GitHub issues wired into your Project, implements them with PRs,
reviews/audits the round, and repeats for a bounded number of rounds.

## What's inside

| Component | Path | Purpose |
|---|---|---|
| Canvas extension | `com.github.copilot/extensions/software-factory/` | Control panel: live pipeline (SSE), tasks, created issues, Play/Pause. Play sends the kick-off prompt to the session agent via `session.send`. |
| Runner CLI | `com.github.copilot/extensions/software-factory/runner/sf.mjs` | State machine in `<repo>/.software-factory/`: emits work orders per phase and executes the mechanical `issues` phase (`gh issue create` + `gh project item-add`). |
| Skill | `skills/software-factory/SKILL.md` | The loop contract the agent follows (phases, subagents, rules). |

Phases: `discover → plan → grill → issues → implement → review` · rounds capped by
`max_rounds` (default 3) · `pause` stops re-cruitment at any time.

## Requirements

- Node 20+, `gh` CLI authenticated (issues/Project phase), a GitHub Project number if you
  want issues enqueued (`gh project list`).
- GitHub Copilot desktop app with canvas extensions enabled.
- For `install.ps1` and the install test suite: PowerShell 7+ (`pwsh`) on Windows, as
  used by CI. `@github/copilot-sdk` is resolved by the app's canvas runtime, so a fresh
  install does not need `node_modules`.

## Install

**Universal install (any OS, any harness; Node 20+, no dependencies):**

```bash
node tools/sf-install.mjs --harness <copilot|claude|codex|opencode|generic> [--home DIR] [--dry-run]
node tools/sf-install.mjs --harness <x> --check   # read-only; also prints `STALE: <path>` for installed runner files no longer in the repo (never deletes); exit 1 + reinstall hint if the installed copy drifts from plugin.json
```

It copies the dependency-free runner plus `SKILL.md` to the harness convention
(`~/.copilot|.claude|.codex/skills/software-factory`, `~/.config/opencode/skill/software-factory`)
or, for `generic`, appends an idempotent marked block to `~/AGENTS.md` (runner in
`~/.software-factory/runner`). It is additive (never deletes), validates the source before
writing, and records a version marker (`.sf-install.json`) used by `--check`.
`--dry-run` lists actions without writing; `--home` overrides the home directory.

**Option A — installer script (Windows):**

```powershell
git clone https://github.com/svg153/canvas-software-factory.git
cd canvas-software-factory
.\install.ps1        # copies canvas+runner to ~/.copilot/extensions/software-factory
                     # and the skill to ~/.copilot/skills/software-factory
```

The distributed extension tree deliberately ships **no** `canvas.json`: per the
awesome-copilot convention for canvas extensions ("Extension website metadata is
sourced from the matching plugin manifest"), `install.ps1` instead *generates*
`canvas.json` in the install target from `canvas-meta.json` + `plugin.json` using
`tools/make-canvas-manifest.mjs`. `plugin.json` at the repository root remains the
marketplace manifest.

The repo uses the **Agent Plugins 1.0** layout for external distribution: the single
canonical source of the canvas extension lives under the Copilot namespace
(`com.github.copilot/extensions/software-factory/extension.mjs`), which is what the
official canvas structure gate requires when the manifest declares the `canvas`
keyword; skills are discovered by convention from `skills/` at the package root.
`tools/check-external-layout.mjs` is a **local partial check** that runs in CI: it
mirrors some of that gate's structure assertions and validates `plugin.json` against
the vendored copy of the official Agent Plugins 1.0.0 schema
(`tools/schemas/agent-plugins-1.0.0.plugin.schema.json`) using a dependency-free
minimal validator covering exactly the keywords that schema uses (unsupported
keywords fail loudly). It does not run the full official awesome-copilot gate and
does not claim to. That vendored schema is Apache-2.0 licensed material from
`agentplugins/agent-plugins-spec`; a verbatim copy of the license
(`tools/schemas/LICENSE-Apache-2.0.txt`) and a third-party notice
(`tools/schemas/NOTICE.md`) ship beside it, and a regression test checks they are
present. Everything else in this repo remains MIT.
The installer is **additive**: it validates the source first (required files present,
`canvas-meta.json`/`plugin.json` parseable, `main` resolving) and aborts *before
writing anything* if the source is invalid, leaving an existing installation intact.
It then copies files in place and never deletes the target directory, so data such as
`artifacts/` or local files you added survive installs and updates. Use `-Force` to
skip the update confirmation and `-CopilotHome <path>` to install into a different
home (the test suite uses this so it never touches your real install). Then reload
extensions in the app (or restart it).

**Option B — manual:** copy `com.github.copilot/extensions/software-factory/` to
`<COPILOT_HOME>/extensions/software-factory/`, generate its `canvas.json` with
`node tools/make-canvas-manifest.mjs . <COPILOT_HOME>/extensions/software-factory`,
and copy `skills/software-factory/` to `<COPILOT_HOME>/skills/software-factory/`.

**Option C — awesome-copilot:** once accepted as an external plugin, install it from
the catalog with one click. To propose it, open an external-plugin submission issue in
`github/awesome-copilot` pointing at a release tag + commit SHA of this repo.

## Use

```powershell
# 1. One-time setup per repo
node ~/.copilot/extensions/software-factory/runner/sf.mjs init C:\path\to\repo `
  --repo owner/name --project <project-number> --rounds 3
# Add --project-owner <owner> if the Project belongs to a different owner

# 2. Open the "Software Factory" canvas (pass repo=<absolute path> as input
#    if the factory should target a repo other than the session workspace).

# 3. ▶ Play. Watch the pipeline; the agent executes work orders and marks them done.
#    ⏸ Pause anytime. State lives in <repo>/.software-factory/.
```

A finished factory (`status=done`) is terminal: `start` and canvas ▶ Play refuse to
reopen it and `next` emits no further tasks. To run a new execution, re-`init` the
repo with `--force` (see contract below).

## Runner contract (v2 semantics)

- **`init` never overwrites silently.** If `<repo>/.software-factory/state.json`
  exists (even corrupt), `init` refuses and exits 1 with the current progress.
  `--force` is the explicit, destructive reset. The canvas follows the same path,
  so a Play on an existing factory cannot wipe its progress by accident.
- **Simulation is fully isolated.** `--dry` and `--dry-run` are equivalent and are
  accepted **only** by `next`, `advance` and `issues`; every other command
  (`init`/`start`/`pause`/`complete`/`status`…) rejects the flag with exit 2 before
  writing anything. Dry runs operate on an in-memory clone: they never call `gh`, never touch
  `state.json`, `events.log` or work-order files, and never advance the real phase.
  `next`/`advance` in dry mode return an explicit preview (`dry_run: true` plus an
  `advance` object with the transition that *would* happen; preview issues are marked
  `dry: true` and numbered from 901 upward without colliding with real ones). The
  later real run therefore still creates the same draft titles exactly once.
- **Duplicate titles inside one draft are created once.** `createIssuesFromDraft`
  de-duplicates by title within a single invocation as well as against already
  persisted issues, in both dry and real mode, while still persisting after each
  creation for partial-failure recovery.
- **`complete <taskId>` requires the report.** Closing a task as `done` demands the
  result file written by the agent (`results/<id>.md`) to exist **and be non-empty**
  after trimming whitespace; otherwise it exits 1.
  `--force` closes without the report as the explicit alternative; `--fail` marks
  the task failed.
- **Failed tasks don't loop forever.** A `--fail` task is never re-claimed, but the
  rest of the phase keeps working and the phase advances normally. The failure
  surfaces in `next` output (`failed: [...]`), `status` (`tasks_failed`, `notes`),
  `state.notes` and `events.log` — never silently hidden.
- **`gh` is judged by its exit code only** (stderr notices like "could not check
  for updates" no longer abort a successful create), and the create output is
  validated as an issue URL *before* anything is persisted. The repo slug
  `owner/name` is validated before touching the CLI, so a misconfigured state can
  never create issues against the runner's cwd.
- **`state.json` is written atomically** (unique temp file + rename): a crash mid
  write leaves the previous state intact. It does not protect against concurrent
  lost updates; drive one factory per repo from one process at a time.
- **No simulation mode in production.** Nothing in `sf.mjs` or `lib/gh.mjs` reads an
  environment variable to divert `gh` calls, and no state entry is ever marked as
  simulated: a previous `SF_FAKE_GH` hook was removed because its entries polluted
  `state.issues` and could block a later real run. End-to-end tests simulate `gh`
  with a test-only preload (`runner/test-support/fake-gh-preload.mjs`, loaded via
  `NODE_OPTIONS=--import`) that replaces `child_process.execFile` inside the test
  process; unit tests inject `runGh` into `createIssuesFromDraft`. Removing the
  simulation therefore cannot leave anything behind that blocks or fakes a real run.

## Privacy & security

- The plugin stores state **only** inside `<repo>/.software-factory/` (JSON + markdown).
- The plugin code never reads, writes or sends credentials. All GitHub operations go
  through the official `gh` CLI using *your* existing auth, with the permissions of
  *your* account. Note, however, that work orders and result files are agent-written
  text and may quote repository content: review them before committing anywhere. We
  do not guarantee that no secret ever ends up in `.software-factory/`.
- This repo's `.gitignore` covers this repo only. When the factory targets **another**
  repo, `<repo>/.software-factory/` is *not* automatically ignored there — add it to
  that repo's `.gitignore` (or delete the folder) before committing.
- The canvas HTTP server binds to `127.0.0.1` on a random port (localhost-only UI).
  `POST /action` additionally requires a per-instance CSRF token: the server generates
  a random token at startup, embeds it in the served HTML (`meta[name="sf-action-token"]`)
  and rejects any request without the matching `x-sf-action-token` header (403). A
  foreign website can send a simple POST but cannot read the token or the response.
- Project item-add failures are recorded in `state.notes`; issue creation can continue.
- When a Project owner is not provided, the runner uses the owner from `--repo`.

## Validate

From `com.github.copilot/extensions/software-factory/`, run `npm test` to execute the built-in Node.js
regression tests. Install/maintainability tests (temp `COPILOT_HOME` only, never the
real install) run with `pwsh -NoProfile -File tests/install-tests.ps1` from the repo
root. The GitHub Actions workflow also checks the JavaScript syntax, validates the
plugin, package and `canvas-meta.json` manifests, runs
`node tools/check-external-layout.mjs` (partial local check: namespaced canvas entry,
no duplicate outside the namespace, no versioned `canvas.json`, plus `plugin.json`
validated against the vendored Agent Plugins 1.0.0 schema — the full official
awesome-copilot gate is not executed here),
generates the install-target `canvas.json` with
`tools/make-canvas-manifest.mjs`, and runs the install suite on `windows-latest`.

## Limitations (verified, not promised)

- The installer updates files in place but does not remove files deleted upstream; a
  file that no longer exists in the source can linger in the install target.
- `install.ps1` uses Windows-style paths; on Linux/macOS use the manual install.
- Canvas discovery relies on the generated `canvas.json` and the app's extension host,
  which this repo does not ship or control.

## Repo layout notes

This is a standalone repo on purpose: the plugin bundles a canvas extension with its
runner and has its own release cadence. It can still be listed from a marketplace
(`marketplace.json`) like sibling plugins. MIT licensed, except the vendored
Agent Plugins schema under `tools/schemas/` which is Apache-2.0 (see
`tools/schemas/NOTICE.md`).
