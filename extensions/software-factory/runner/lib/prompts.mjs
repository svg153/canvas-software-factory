// Work-order prompt templates for each factory phase.
import { paths } from "./state.mjs";

const RESULTS_NOTE = (task) =>
  `Cuando termines, guarda el resultado en ${task.result_file} (crear/actualizar el archivo). ` +
  `Reporta con: node <ruta-runner>/sf.mjs complete ${task.id}`;

export function discoverPrompt(state, task) {
  const p = paths(state.repo_path);
  return `# Fase ${task.round} · Descubrimiento (auditoría del repo)

Eres el auditor de la Software Factory para ${state.repo || state.repo_path}.
Analiza el repo (_stack_, tests, CI, lint, deuda, seguridad, docs) y devuelve:

1. Inventario técnico (lenguajes, framework, comandos de build/test/lint).
2. 10 debilidades priorizadas (impacto × esfuerzo), con evidencias (archivos/líneas).
3. 3 "apuestas rápidas" (quick wins) y 3 mejoras estructurales.
4. Riesgos de seguridad (usa la skill de seguridad si está disponible).
5. Estado de la documentación y del GitHub Project actual.

Guarda el informe en ${p.results}/discover-r${task.round}.md.
${RESULTS_NOTE(task)}`;
}

export function planPrompt(state, task) {
  const p = paths(state.repo_path);
  const discover = `${p.results}/discover-r${state.round}.md`;
  return `# Fase ${task.round} · Plan GSD (Goal → Spec → Deliverables)

Actúa como el planificador GSD de la Software Factory.
Lectura obligatoria: ${discover} (informe de descubrimiento) y ${p.plan} (plan vigente, si existe).

Entrega:
1. Un plan por olas (wave 1 = quick wins, wave 2 = estructural, wave 3 = deuda/security).
2. Para cada ítem: objetivo, criterios de aceptación, archivos afectados, riesgo, y label sugerida.
3. Escribe el plan en ${p.plan} (reemplazando la versión anterior).
4. Escribe ${p.draft} como JSON estricto: { "issues": [ { "title", "body", "labels": [] } ] } (6–12 issues accionables, sin duplicar las ya creadas; revisa state.json → issues).
${RESULTS_NOTE(task)}`;
}

export function grillPrompt(state, task) {
  const p = paths(state.repo_path);
  return `# Fase ${task.round} · Grill-me (crítica del plan)

Actúa como el crítico implacable de la Software Factory (estilo skill "grilling"),
pero TÚ MISMO respondes cada objeción y cierras con la opción recomendada.

Lectura: ${p.plan} y ${p.draft}.

Por cada decisión relevante del plan:
1. Objeción (qué puede salir mal / qué假设 es frágil).
2. Respuesta recomendada y por qué gana.
3. Ajuste concreto al plan si procede.

Al final: (a) revisa ${p.draft} eliminando issues débiles/duplicadas y corrigiendo títulos/criterios;
(b) añade una sección "Decisiones tras grill-me" al final de ${p.plan}.
${RESULTS_NOTE(task)}`;
}

export function implementPrompt(state, task, issue) {
  return `# Implementar issue #${issue.number} — ${issue.title}

Eres el agente de implementación de la Software Factory (round ${state.round}).

1. Lee la issue completa: gh issue view ${issue.number} --repo ${state.repo}
2. Crea una rama task/issue-${issue.number}, implementa el cambio mínimo completo con tests.
3. Ejecuta build/lint/tests del repo. Abre PR con "Closes #${issue.number}".
4. Pide revisión (subagente code-review) y aplica correcciones razonadas.
${RESULTS_NOTE(task)}`;
}

export function reviewPrompt(state, task) {
  const p = paths(state.repo_path);
  return `# Fase ${task.round} · Revisión, auditoría y nuevas oportunidades

Eres el panel revisor de la Software Factory (round ${state.round}).

1. Resume el estado del repo tras las implementaciones (gh pr list / issue list).
2. Ejecuta revisión de código + auditoría de seguridad de los cambios del round.
3. Detecta NUEVAS mejoras (deuda emergente, gaps de tests, docs): 4–8 issues.
4. Añádelas a ${p.draft} (manteniendo las pendientes y añadiendo las nuevas; sin duplicar issues ya creadas en state.json).
5. Veredicto: ¿hay trabajo suficiente para un nuevo round? di SÍ/NO y por qué.
${RESULTS_NOTE(task)}`;
}
