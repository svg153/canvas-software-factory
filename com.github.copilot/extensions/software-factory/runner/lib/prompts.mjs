// Work-order prompt templates for each factory phase.
import { fileURLToPath } from "node:url";
import { paths, newSeeds } from "./state.mjs";

// Ruta real del runner relativa a este módulo (funciona en repo y en instalación).
const RUNNER = fileURLToPath(new URL("../sf.mjs", import.meta.url));

// El CLI exige: sf.mjs complete <repoPath> <taskId>. Rutas entre comillas por si llevan espacios.
const RESULTS_NOTE = (state, task) =>
  `Cuando termines, guarda el resultado en ${task.result_file} (crear/actualizar el archivo con contenido no vacío). ` +
  `Reporta con: node "${RUNNER}" complete "${state.repo_path}" ${task.id}`;

// Prompt de arranque que el canvas envía a la sesión del agente.
export function bootstrapPrompt(repoDir, runnerPath, state) {
  return [
    `# Software Factory — arrancar bucle`,
    ``,
    `Lee la skill "software-factory" y ejecuta el bucle de la fábrica contra ${repoDir}.`,
    `Runner: node "${runnerPath}"`,
    state
      ? `Estado actual: round ${state.round}/${state.max_rounds}, fase "${state.phase}", status ${state.status}.`
      : `Sin estado: ejecuta primero node "${runnerPath}" init "${repoDir}" --repo owner/name (deduce owner/name con gh repo view --json nameWithOwner; no continúes sin estado).`,
    `Empieza con: node "${runnerPath}" next "${repoDir}" — luego trabaja cada work order pendiente,`,
    `guarda resultados y marca complete con: node "${runnerPath}" complete "${repoDir}" <taskId>.`,
    `Avanza fases hasta pausar o terminar.`,
  ].join("\n");
}

export function discoverPrompt(state, task) {
  return `# Fase ${task.round} · Descubrimiento (auditoría del repo)

Eres el auditor de la Software Factory para ${state.repo || state.repo_path}.
Analiza el repo (_stack_, tests, CI, lint, deuda, seguridad, docs) y devuelve:

1. Inventario técnico (lenguajes, framework, comandos de build/test/lint).
2. 10 debilidades priorizadas (impacto × esfuerzo), con evidencias (archivos/líneas).
3. 3 "apuestas rápidas" (quick wins) y 3 mejoras estructurales.
4. Riesgos de seguridad (usa la skill de seguridad si está disponible).
5. Estado de la documentación y del GitHub Project actual.

${RESULTS_NOTE(state, task)}`;
}

export function planPrompt(state, task) {
  const p = paths(state.repo_path);
  // El informe discover vive en el result_file de su tarea: es lo que `complete` exige.
  const discoverTask = (state.tasks || []).find((t) => t.phase === "discover" && t.round === task.round);
  const discover = discoverTask?.result_file || `${p.results}/r${task.round}-discover-*.md`;
  const seeds = newSeeds(state);
  const seedBlock = seeds.length
    ? `

IDEAS DEL USUARIO (semillas pendientes, PRIORITARIAS sobre la auditoría):
${seeds.map((s) => `- [${s.id}] ${s.text}`).join("\n")}
Descompón CADA semilla en 1 o más issues accionables del draft. Cada una de esas issues
debe llevar en "labels" la etiqueta "user-idea" y los campos extra "origin": "user" y
"seed_id": "<id>" (la fase issues ignora esos campos extra: solo trazan la idea de origen).
No dupliques títulos ya creados (revisa state.json → issues).`
    : "";
  return `# Fase ${task.round} · Plan GSD (Goal → Spec → Deliverables)

Actúa como el planificador GSD de la Software Factory.
Lectura obligatoria: ${discover} (informe de descubrimiento) y ${p.plan} (plan vigente, si existe).

Entrega:
1. Un plan por olas (wave 1 = quick wins, wave 2 = estructural, wave 3 = deuda/security).
2. Para cada ítem: objetivo, criterios de aceptación, archivos afectados, riesgo, y label sugerida.
3. Escribe el plan en ${p.plan} (reemplazando la versión anterior).
4. Escribe ${p.draft} como JSON estricto: { "issues": [ { "title", "body", "labels": [] } ] } (6–12 issues accionables, sin duplicar las ya creadas; revisa state.json → issues).
${seedBlock}
${RESULTS_NOTE(state, task)}`;
}

export function grillPrompt(state, task) {
  const p = paths(state.repo_path);
  return `# Fase ${task.round} · Grill-me (crítica del plan)

Actúa como el crítico implacable de la Software Factory (estilo skill "grilling"),
pero TÚ MISMO respondes cada objeción y cierras con la opción recomendada.

Lectura: ${p.plan} y ${p.draft}.

Por cada decisión relevante del plan:
1. Objeción (qué puede salir mal / qué supuesto es frágil).
2. Respuesta recomendada y por qué gana.
3. Ajuste concreto al plan si procede.

Las issues con label "user-idea" (ideas del usuario) se trían con el MISMO criterio que
las de la auditoría: si una idea es débil, duplicada o inviable, se tala del draft; si
pasa, se afina su título y criterios de aceptación. Una idea del usuario NO tiene pase
automático.

Al final: (a) revisa ${p.draft} eliminando issues débiles/duplicadas y corrigiendo títulos/criterios;
(b) añade una sección "Decisiones tras grill-me" al final de ${p.plan}.
${RESULTS_NOTE(state, task)}`;
}

export function implementPrompt(state, task, issue) {
  return `# Implementar issue #${issue.number} — ${issue.title}

Eres el agente de implementación de la Software Factory (round ${state.round}).

1. Lee la issue completa: gh issue view ${issue.number} --repo ${state.repo}
2. Crea una rama task/issue-${issue.number}, implementa el cambio mínimo completo con tests.
3. Ejecuta build/lint/tests del repo. Abre PR con "Closes #${issue.number}".
4. Pide revisión (subagente code-review) y aplica correcciones razonadas.
${RESULTS_NOTE(state, task)}`;
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
${RESULTS_NOTE(state, task)}`;
}
