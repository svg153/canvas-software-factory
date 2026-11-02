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

## Install

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
`tools/check-external-layout.mjs` mirrors that gate locally and runs in CI.
Use the same command with `-Force` to replace an existing installation (your
`<repo>/.software-factory/` state and any installed `artifacts/` are preserved),
then reload extensions in the app (or restart it).

**Option B — awesome-copilot:** once accepted as an external plugin, install it from
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
- **Simulation is fully isolated.** `--dry` and `--dry-run` are equivalent on every
  command. Dry runs operate on an in-memory clone: they never call `gh`, never touch
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
  result file written by the agent (`results/<id>.md`); otherwise it exits 1.
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
- Simulation hook (documented, not hidden): `SF_FAKE_GH=<script.mjs>` makes the
  runner invoke that Node script instead of the real `gh` CLI. It is read by
  production code, so it only works on an explicit real (non-dry) run — the
  regression suite uses it with a PATH-independent fake executable. Everything
  created while it is active is marked `simulated: true` in `state.issues` and the
  command output, and `events.log` records the run as `SIMULADO SF_FAKE_GH`, so a
  simulation can never be mistaken for real GitHub creation. Unit tests should
  prefer injecting `runGh` into `createIssuesFromDraft` instead.

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
`node tools/check-external-layout.mjs` (namespaced canvas entry, no duplicate
outside the namespace, no versioned `canvas.json`, schema-allowed manifest fields),
generates the install-target `canvas.json` with
`tools/make-canvas-manifest.mjs`, and runs the install suite on `windows-latest`.

## Repo layout notes

This is a standalone repo on purpose: the plugin bundles a canvas extension with its
runner and has its own release cadence. It can still be listed from a marketplace
(`marketplace.json`) like sibling plugins. MIT licensed.
