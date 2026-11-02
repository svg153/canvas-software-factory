---
name: software-factory
description: >
  Ejecuta el bucle autónomo "Software Factory" sobre un repo: descubrimiento →
  plan GSD → grill-me → creación de issues + GitHub Project → implementación →
  revisión/auditoría, en rounds. Úsala cuando el usuario pida "lanza la fábrica",
  "software factory", o al recibir un prompt de arranque del canvas Software Factory.
---

# Software Factory — bucle de mejora autónoma

El **runner** (`runner/sf.mjs`, instalado con la extensión `software-factory` en
`~/.copilot/extensions/software-factory/runner/sf.mjs`) mantiene el estado de la fábrica
en `<repo>/.software-factory/state.json`. Tú eres el **motor cognitivo**: ejecutas los
*work orders* que el runner emite y le devuelves los resultados.

## Contrato del bucle

1. `node <runner>/sf.mjs start <repoPath>` (si no está en running).
2. `node <runner>/sf.mjs next <repoPath>` → JSON con las tareas pendientes de la fase
   actual, cada una con su `prompt` (work order).
3. Para cada tarea pendiente, EN ORDEN:
   - Trabaja el prompt del work order contra el repo (usa subagentes cuando aporte
     parallelismo: explore para búsqueda, code-review/security-review para la fase review).
   - Escribe el resultado en el `result_file` indicado por el work order.
   - Marca `node <runner>/sf.mjs complete <repoPath> <taskId>`.
4. Repite 2–3. Cuando la fase se vacía, el runner avanza solo a la siguiente:
   - `issues` es mecánica: el runner ejecuta `gh issue create` + `gh project item-add`
     con `<repo>/.software-factory/issues-draft.json`. NO la trabajes tú. Si el Project
     pertenece a un owner distinto del repo, inicializa con `--project-owner <owner>`.
   - Tras `review`, el runner abre el siguiente round o termina (`max_rounds`).
5. Nunca saltes `grill`: el plan debe autocrítica antes de crear issues.
6. **Ideas del usuario**: el canvas (acción `add_idea`) o `node <runner>/sf.mjs idea <repo> "texto"`
   guardan una semilla en `state.seeds`. No la trabajes a parte: se materializa en la fase `plan`
   del round que corresponda y recorre el mismo flujo (grill → issues → Project → implement →
   review). El `status` de la semilla (`new → planned → triaged`) lo mueve el runner, no tú.

## Reglas por fase

- **discover**: 10 debilidades priorizadas con evidencia archivo:línea. Rápido, sin edits.
- **plan**: estilo GSD (Goal → Spec → Deliverables), olas wave1 quick wins / wave2 estructural /
  wave3 deuda+seguridad. 6–12 issues en el draft JSON, criterios de aceptación medibles.
  Si hay **semillas de usuario pendientes** (`state.seeds` con `status:"new"`), el work order
  las lista: descompón CADA idea en 1 o más issues del draft con label `user-idea` y campos
  extra `origin:"user"` + `seed_id` (prioritarias sobre la auditoría). El runner marca la semilla
  como `planned` solo si ya existía cuando se emitió el plan; una idea añadida a mitad de round
  espera al próximo plan.
- **grill**: contéstote tú mismo el debate (estilo grill-me): objeción → respuesta →
  **opción recomendada** y aplica el ajuste al draft. No preguntes al usuario. Las issues
  `user-idea` se trían con el mismo criterio que las de auditoría: **pueden pasar o tacharse**,
  no tienen pase automático. El runner marca `planned → triaged` al cerrar la fase.
- **implement**: una rama `task/issue-<n>` por issue, PR con `Closes #n`, gates de
  build/lint/tests del repo pasando.
- **review**: subagente code-review + security-review sobre los PRs del round; añade
  nuevas oportunidades al draft para el siguiente round; veredicto SÍ/NO continuar.

## Seguridad y límites

- Máximo `max_rounds` rounds; `pause` del canvas = deja de reclutar tareas al terminar la actual.
- No hagas merge sin que el repo lo permita; abre PR y deja que las policies decidan.
- Si `gh` falla por permisos, registra el fallo en la tarea con `--fail` y sigue con las demás.
- El estado vive SOLO en `.software-factory/` del repo; no uses memoria del chat como fuente.
- El `.gitignore` de este repo no cubre otros repos: antes de commitear en el repo
  objetivo, asegúrate de que su `.gitignore` incluye `.software-factory/` (los
  work orders y resultados los escribe un agente y pueden contener contenido del repo).
