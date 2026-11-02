# Contributing

## Workflow

1. Open or pick an issue; work on a branch and open a PR against `main`.
2. Run the gates locally (no `npm install` is needed; there are no runtime dependencies
   beyond Node 20+):
   - `npm test` in `com.github.copilot/extensions/software-factory`
   - `node --check` on every `.mjs` under `com.github.copilot` and `tools`
   - `node tools/check-external-layout.mjs`
   - `pwsh -NoProfile -File tests/install-tests.ps1`
   - `git diff --check`
3. Do not version `canvas.json` in the extension tree (it is generated on install).
4. The `Validate` workflow must pass before merge.

## Release process

Releases are automatic once a version bump lands on `main`:

1. In a PR run `node tools/bump-version.mjs patch|minor|major` (updates `plugin.json`
   and the extension `package.json`, adds a CHANGELOG stub), then fill in the CHANGELOG.
2. Merge the PR. `.github/workflows/release.yml` runs `tools/check-release.mjs`
   (versions agree, CHANGELOG section exists, skill present), the tests, then creates
   the tag `vX.Y.Z` and the GitHub release (with a SHA-256 of the released `SKILL.md`).
   It can also be run manually via *Actions → Release → Run workflow*; if the tag
   already exists it does nothing.
3. Users verify an installation with `install.ps1 -Check` (detects stale version,
   skill drift or missing files) and update by re-running `install.ps1`.

## Branch protection (maintainer checklist)

Settings are not managed from code. Configure once under *Settings → Rules → Rulesets*
(or *Branches*) for `main`:

- [ ] Require a pull request before merging
- [ ] Require status checks to pass: `test` and `install` (jobs of the `Validate` workflow)
- [ ] Require branches to be up to date before merging
- [ ] Block force pushes and deletions
- [ ] Restrict direct pushes (allow only the release workflow if bumps are ever automated)

## Reproducibility

The extension declares `engines.node >= 20`. No `package-lock.json` is committed on
purpose: the only dependency (`@github/copilot-sdk`) is pinned to an exact version and
the runner itself uses only Node built-ins. CI therefore runs `npm test` without an
install step.