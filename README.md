# 🏭 Software Factory

Plugin for **GitHub Copilot** (desktop app + CLI): press **▶ Play** in the canvas and
an agent iterates over a repo autonomously — audits it, plans (GSD style), grills its
own plan, files GitHub issues wired into your Project, implements them with PRs,
reviews/audits the round, and repeats for a bounded number of rounds.

## What's inside

| Component | Path | Purpose |
|---|---|---|
| Canvas extension | `extensions/software-factory/` | Control panel: live pipeline (SSE), tasks, created issues, Play/Pause. Play sends the kick-off prompt to the session agent via `session.send`. |
| Runner CLI | `extensions/software-factory/runner/sf.mjs` | State machine in `<repo>/.software-factory/`: emits work orders per phase and executes the mechanical `issues` phase (`gh issue create` + `gh project item-add`). |
| Skill | `skills/software-factory/SKILL.md` | The loop contract the agent follows (phases, subagents, rules). |

Phases: `discover → plan → grill → issues → implement → review` · rounds capped by
`max_rounds` (default 3) · `pause` stops re-cruitment at any time.

## Requirements

- Node 20+, `gh` CLI authenticated (issues/Project phase), a GitHub Project id if you
  want issues enqueued (`gh project list`).
- GitHub Copilot desktop app with canvas extensions enabled.
- For `install.ps1` and the test suite: PowerShell 7+ (`pwsh`) on Windows.

## Install

**Option A — installer script (Windows, PowerShell 7+):**

```powershell
git clone https://github.com/svg153/canvas-software-factory.git
cd canvas-software-factory
./install.ps1        # syncs canvas+runner to <COPILOT_HOME>\extensions\software-factory
                     # and the skill to <COPILOT_HOME>\skills\software-factory
```

The installer is **additive**: it validates the source first (required files present,
`canvas.json` parseable and its `main` resolving) and then copies files in place. It
never deletes the target directory, so foreign data you may have added there (e.g.
`artifacts/`, local config) survives both fresh installs and updates. If the source is
invalid, it aborts *before writing anything* and your existing installation stays intact.
Use `-Force` to skip the confirmation prompt and `-CopilotHome <path>` to install to a
different home (this is what the test suite uses to avoid touching your real install).

Then reload extensions in the app (or restart it). `@github/copilot-sdk` is resolved by
the app's canvas runtime — a fresh install does not need `node_modules`.

**Option B — manual:** copy `extensions/software-factory/` (including `canvas.json`,
which declares `main: extension.mjs` and makes the canvas discoverable) into
`<COPILOT_HOME>/extensions/software-factory/` and `skills/software-factory/` into
`<COPILOT_HOME>/skills/`.

**Option C — awesome-copilot:** once accepted as an external plugin, install it from
the catalog with one click. To propose it, open an external-plugin submission issue in
`github/awesome-copilot` pointing at a release tag + commit SHA of this repo.

## Use

```powershell
# 1. One-time setup per repo
node ~/.copilot/extensions/software-factory/runner/sf.mjs init C:\path\to\repo `
  --repo owner/name --project <github-project-id> --rounds 3

# 2. Open the "Software Factory" canvas (pass repo=<absolute path> as input
#    if the factory should target a repo other than the session workspace).

# 3. ▶ Play. Watch the pipeline; the agent executes work orders and marks them done.
#    ⏸ Pause anytime. State lives in <repo>/.software-factory/.
```

## Privacy & security

- The plugin stores state **only** inside `<repo>/.software-factory/` (JSON + markdown).
  Note: `.software-factory/` is git-ignored **in this repository only** — for any repo
  you point the factory at, add `.software-factory/` to that repo's `.gitignore`
  yourself, or the factory state may get committed.
- It never reads, writes or sends credentials. All GitHub operations go through the
  official `gh` CLI using *your* existing auth, with the permissions of *your* account.
- The canvas HTTP server binds to `127.0.0.1` on a random port (localhost-only UI).
- `gh project item-add` failures are recorded in `state.notes`; they never leak output.

## Development & tests

```powershell
pwsh -NoProfile -File tests/install-tests.ps1
```

The suite (plain PowerShell, no Pester) checks manifests and URLs, runs `node --check`
on every `.mjs`, and exercises the installer against **temporary** `COPILOT_HOME`
directories only: clean install, update preserving foreign files, and abort-without-
damage on invalid sources. It never touches your real `~/.copilot` install and creates
no GitHub data. CI (`.github/workflows/ci.yml`) runs this suite on `windows-latest`
plus syntax checks and `npm test` for the runner once a test script is defined in
`extensions/software-factory/package.json` (skipped with a notice while absent).

## Limitations (verified, not promised)

- `install.ps1` uses Windows-style relative paths in validation; on Linux/macOS use
  the manual copy or run it under PowerShell 7 with the same layout caveats.
- The installer updates files in place but does not remove files deleted upstream;
  a stale file that no longer exists in the source can linger in the target.
- Canvas discovery relies on `canvas.json` + the app's extension host; this repo does
  not ship or control that host.

## Repo layout notes

This is a standalone repo on purpose: the plugin bundles a canvas extension with its
runner and has its own release cadence. It can still be listed from a marketplace
(`marketplace.json`) like sibling plugins. MIT licensed.
