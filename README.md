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

## Install

**Option A — installer script (Windows):**

```powershell
git clone https://github.com/svg153/canvas-software-factory.git
cd canvas-software-factory
./install.ps1        # copies canvas+runner to ~/.copilot/extensions/software-factory
                     # and the skill to ~/.copilot/skills/software-factory
```

Then reload extensions in the app (or restart it).

**Option B — awesome-copilot:** once accepted as an external plugin, install it from
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
- It never reads, writes or sends credentials. All GitHub operations go through the
  official `gh` CLI using *your* existing auth, with the permissions of *your* account.
- The canvas HTTP server binds to `127.0.0.1` on a random port (localhost-only UI).
- `gh project item-add` failures are recorded in `state.notes`; they never leak output.

## Repo layout notes

This is a standalone repo on purpose: the plugin bundles a canvas extension with its
runner and has its own release cadence. It can still be listed from a marketplace
(`marketplace.json`) like sibling plugins. MIT licensed.

## Development

No dependencies needed for the runner: tests use the built-in `node:test` runner.

```bash
node --test extensions/software-factory/runner/test/   # unit + CLI e2e
```

CI (`.github/workflows/ci.yml`) runs `node --check` on every `.mjs` plus the test
suite on each push/PR. Tests never call `gh` for real (dry-run paths only).
