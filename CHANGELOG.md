# Changelog

## Unreleased

### Added
- Release workflow (`release.yml`), `tools/check-release.mjs` and `tools/bump-version.mjs`.
- `install.ps1 -Check` detects stale installations (version, files, skill drift).
- SECURITY, CONTRIBUTING, CODEOWNERS, issue/PR templates; `engines.node >=20`.
- **User idea injection ("vocal ideas").** The canvas now has an idea box and a
  `add_idea` action, and the runner a `idea <repo> "<text>"` command. An idea is
  stored as a *seed* (`state.seeds`, `status: new`) that does not start its own
  round; the next `plan` phase decomposes it into 1+ issues (label `user-idea`,
  `origin: user`) that flow through grill → issues → Project → implement → review
  exactly like the audit issues. The runner owns the seed lifecycle in `advance()`
  (`new → planned` leaving plan, `planned → triaged` leaving grill) with a
  `created_at` cutoff guard so an idea added after the current plan was emitted
  waits for the next round's plan. `planPrompt`/`grillPrompt`, the canvas UI
  (seeds panel), the `software-factory` skill and the README document the flow.
  Covered by 7 new regression tests.

## v0.1.1

### Fixed
- Consolidated the fixes from #1 (PRs #5 and #6): factory cycle regressions, CSRF
  protection on `/action`, validated installer, unique dry-run numbering across rounds,
  safe contracts for dry-run, `init`, failed tasks, `complete` and `gh`.
- `SF_FAKE_GH` removed from production; `dry` is only required where implemented.
- The layout checker validates against the vendored Agent Plugins 1.0.0 schema and no
  longer claims full conformance; schema audit is instance-independent and only ENOENT
  counts as absence.
- Vendored schema ships its Apache-2.0 license and third-party notice.

### Added
- New Agent Plugins 1.0 layout with a namespaced extension
  (`com.github.copilot/extensions/software-factory`).
- `--dry` flag for the runner.
- `--project-owner` option for `init` (Project owned by a different owner).

### Changed
- Version bumped to `0.1.1` in `plugin.json` and the extension `package.json`.
- README «Option C» now references the `v0.1.1` tag.

## v0.1.0
- Initial release: canvas extension, runner and skill.
