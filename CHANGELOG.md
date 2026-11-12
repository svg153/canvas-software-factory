# Changelog

## Unreleased

### Changed
- Canvas panel redesigned to match the awesome-copilot reference canvases (#85): host-theme
  variables with light/dark fallback, live status dot and per-state counters in the header,
  pipeline phases as a connected stepper, task rows as cards, and the log as a timestamped
  feed. Accessibility: `aria-live` regions, `focus-visible` outlines, `prefers-reduced-motion`,
  state dots distinguished by color *and* shape. Action buttons now disable while a request is
  in flight and init validates the `owner/repo` format. DOM ids and action payloads unchanged.

## v0.1.2

### Changed
- TODO: describe this release.
## v0.1.2

### Fixed
- Canvas Init appeared dead: the extension host is not bound to any chat session, so
  the panel had no real repo. The panel now has a **Repo field** ("Usar repo") that
  accepts any absolute path that is a git workspace; non-git paths are rejected
  (`sf_repo_no_permitido`) and the previous repo is kept on failure.
- `/state` errors are reported in the panel log instead of failing silently.
- Writes are guarded to git workspaces only (`repoIsGitWorkspace`), avoiding stray
  `.software-factory/` directories.
- Clearer init labels: "Project nº" (number of the GitHub Project) vs "projectOwner"
  (owner/org of that Project, defaults to the repo owner) with tooltips.

### Added
- Release workflow (`release.yml`), `tools/check-release.mjs` and `tools/bump-version.mjs`.
- `install.ps1 -Check` detects stale installations (version, files, skill drift).
- SECURITY, CONTRIBUTING, CODEOWNERS, issue/PR templates; `engines.node >=20`.

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
