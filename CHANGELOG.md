# Changelog

## v0.1.6

### Added
- Sección «GitHub — trabajo existente» (#90): el panel ahora puede listar las issues y PRs
  abiertos reales del repo (`gh issue list` / `gh pr list`), no solo lo que hay en el
  `state.json` del run actual. Botón «Actualizar GitHub» (solo lectura) con dos columnas:
  issues (nº, título, labels) y PRs (nº, título, draft/conflictos/estado de checks).
- Botón «Importar abiertas»: vincula las issues abiertas de GitHub a `state.issues` para que
  la fase issues no las duplique (`createIssuesFromDraft` ya deduce contra el estado vía
  `sameIssue`). Solo persiste si hay novedades; cada issue importada queda marcada
  `imported: true`.
- Nuevas acciones runner/extension: `github_status` y `import_issues`, registradas también
  como acciones del canvas.

### Fixed
- `getGithubStatus` es blando: si `gh` falla en una de las dos listas (auth, rate limit),
  la otra se muestra igualmente y el fallo parcial se devuelve como `note` recortada.
  Los errores de importación se traducen a un mensaje fijo (no se filtra el estado interno).

### Changed
- `gh.mjs`: validación de slug unificada en `assertRepoSlug` (la compartían
  `projectsV2Args` a mano y ahora los comandos `issue/pr list`).

## v0.1.5

### Fixed
- Init sobre un repo con estado existente mostraba solo `⚠ sf_solicitud_fallida` (#88):
  el runner aborta con «Ya existe estado… usa --force» pero ese mensaje se perdía. Ahora
  la rama init de `extension.mjs` captura el fallo y, si pide `--force`, devuelve un aviso
  accionable (`needs_force`); si no, lanza `sf_init_fallo` con el detalle del runner.
- `http.mjs` difunde el `code` y `message` de los errores intencionales (CanvasError), pero
  mantiene el código genérico sin mensaje para errores crudos (no se filtran rutas internas).
- Nuevo checkbox «Forzar reinicio» junto a Init: añade `--force` al runner (`initRunnerArgs` +
  `createInitPayload`, que solo incluye `force` cuando está marcado para no alterar el contrato).

### Changed
- `app.mjs` registra `⚠ <code>: <message>` y, ante `needs_force`, sugiere marcar «Forzar reinicio».

## v0.1.4

### Fixed
- «Detectar»/autofill del Project (#83): la consulta GraphQL pedía `owner { login }`
  directamente sobre `ProjectV2Owner`, que es una unión (`User | Organization | Team`)
  sin ese campo; GitHub respondía `undefinedField` y `gh` fallaba. Ahora `login` se
  pide con inline fragments (`... on User`, `... on Organization`), como exige la API.

## v0.1.3

### Added
- Autofill de `owner/repo` (#82): al pulsar «Usar repo» (o el botón «Detectar»), el
  servidor deriva el identificador GitHub del workspace con `git remote get-url origin`
  (https, ssh y scp-form) y rellena el campo; no pisa ediciones manuales.
- Detección del Project vinculado (#83): acción `autofill` consulta GraphQL
  `projectsV2` vía `gh api` y rellena «Project board ID» y «Project owner» si hay un
  único Project; lista las opciones si hay varios; registra el motivo si no hay o
  falla la API.
- Botón «Detectar» en la barra Configurar para lanzar el autofill bajo demanda.

### Changed
- El campo Project se rotula ahora «Project board ID (opc.)» con tooltip que explica
  que es el número de la URL del board (`.../projects/5` → 5) o el id `PVT_xxx` (#84).
  La clave del payload (`project`) no cambia.

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
