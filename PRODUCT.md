# Product

<!-- impeccable:product-schema 1 -->

> Nota: iniciado sin entrevista disponible (el usuario no respondió al sondeo).
> Los hechos marcados *[inferido]* provienen de evidencia del repo (README, skill,
> tests, issues) y del brief explícito del issue #85; deben confirmarse en una
> futura revisión antes de tratarlos como verdad de producto.

## Platform

web

## Users

- *[inferido]* Desarrollador individual (el propietario del repo) que opera desde la
  app de escritorio de GitHub Copilot, con `gh` autenticado, sobre repos propios en
  GitHub con un GitHub Project enlazado. Su trabajo: lanzar y supervisar ciclos
  autónomos de desarrollo sin estar pendiente de cada paso.
- Audiencia secundaria *[inferido]*: usuarios externos si el canvas se distribuye
  como plugin de awesome-copilot (el README documenta la intención de submission).
  No confirmado como objetivo activo.

## Product Purpose

Software Factory convierte un repo en una fábrica autónoma: al pulsar ▶ Play en el
canvas, un agente itera el repo en rounds acotados — descubre, planifica (GSD), se
auto-tortura el plan (grill), crea issues enlazados al GitHub Project, los
implementa con PRs y revisa/audita el round. Éxito: el humano solo interactúa con
Play/Pausa y con los issues/PRs resultantes, que son el registro auditable del
progreso.

## Positioning

El bucle no es solo un prompt: lo ejecuta una máquina de estados con contrato
verificable. El runner (`sf.mjs`) persiste el estado en `<repo>/.software-factory/`,
emite work orders por fase y ejecuta mecánicamente la fase de issues; la skill fija
el contrato de fases; el panel es una ventana en vivo (SSE) a ese estado. Nadie más
en su entorno copia: el grill auto-aplicado antes de ejecutar y el uso de GitHub
Issues/Project/PRs como sistema de registro con rounds acotados y pausa segura.

## Operating Context

- Puesto de trabajo Windows; app de GitHub Copilot con canvas extensions habilitadas.
- Node 20+, `gh` CLI autenticado; GitHub Project opcional para encolar issues.
- Lenguas: interfaz y documentación mayoritariamente en español, tono técnico directo.
- Instalación por `install.ps1` (aditiva, auto-validada), URL de GitHub o copia manual;
  la skill viaja aparte del canvas.
- Flujo normal: `sf.mjs init` por repo → abrir canvas → "Usar repo" → Play → vigilar
  pipeline → revisar issues/PRs generados.

## Capabilities and Constraints

- Fases fijas por la skill: `discover → plan → grill → issues → implement → review`;
  `max_rounds` por defecto 3; `pause` detiene reclutamiento; `status=done` es terminal.
- Contrato canvas↔tests: ids de elementos, meta `__SF_ACTION_TOKEN__` y payloads de
  acciones (p. ej. init `{repo, project, project_owner, rounds}`) están cubiertos por
  `node --test` (59 tests) — todo rediseño debe preservarlos.
- Sin `canvas.json` versionado en el árbol de la extensión: se genera desde
  `canvas-meta.json` + `plugin.json` (`tools/make-canvas-manifest.mjs`), convención
  awesome-copilot; `tools/check-external-layout.mjs` lo espeja en CI.
- `engines.node >=20`; `@github/copilot-sdk` lo resuelve el runtime de la app (sin
  `node_modules` distribuidos).
- El tema visual debe salir de las variables del host del canvas (webview); sin
  assets externos ni dependencias de red en la UI.
- Hechos decididos pendientes: público objetivo real; si se persigue activamente la
  aceptación en awesome-copilot; política de versionado de releases próximos.

## Brand Commitments

- Nombre: **Software Factory** 🏭 (canvas, skill y runner comparten el nombre).
- *[inferido del brief #85, citado por el usuario]* Referencia vinculante de calidad:
  los canvas de `github/awesome-copilot` (p. ej. `extensions/agent-radar/ui.html`)
  como estándar de acabado — no como mundo visual a copiar.
- Voz de UI en español, operativa y sin adornos ("Usar repo", "▶ Play", "⏸ Pausa").

## Evidence on Hand

- Repo real con historial de releases (v0.1.1, v0.1.2) y CHANGELOG; CI con gates.
- Suite: 59 tests de contrato/runner (`node --test`) + 18 tests de instalador (Pester).
- Issues y PRs abiertos que demuestran el propio bucle (p. ej. #84, #85 y su PR).
- Esquema Agent Plugins 1.0.0 vendorizado en `tools/schemas/` con licencias y notice.
- Ausencias que no deben fabricarse: no existen testimonios, casos de cliente,
  benchmarks ni pricing; no afirmar adopción externa.

## Product Principles

1. La fábrica es una máquina de estados auditable, no un chat: GitHub es el registro.
2. Autonomía acotada: rounds con tope, pausa siempre operativa, estados terminales
   respetados.
3. Cada punto de color del panel muestra verdad del runner; nada decorativo.
4. El contrato (ids, payloads, fases) va antes que los píxeles; el diseño mejora sin
   romper integración.
5. Se empaqueta como awesome-copilot exige: estructura espejo, manifiestos generados,
   instalador que se comprueba antes de escribir.

## Accessibility & Inclusion

*[inferido de los criterios de aceptación del #85]* El panel debe ser operable por
teclado (focus visible), distinguir estados por forma/texto además de color, respetar
`prefers-reduced-motion` y funcionar en esquema claro y oscuro del host. Sin estándar
formal exigido (WCAG no se pidió explícitamente); revisar si el producto busca
adopción externa.
