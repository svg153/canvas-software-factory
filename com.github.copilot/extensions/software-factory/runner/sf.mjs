#!/usr/bin/env node
// sf.mjs — Software Factory runner CLI.
// Uso: node sf.mjs <command> <repoPath> [args...]
import { resolve } from "node:path";
import { existsSync, statSync } from "node:fs";
import { readFile } from "node:fs/promises";
import {
  loadState, saveState, defaultState, logEvent, paths,
  newTask, writeWorkOrder, openTasks, failedTasks, unclaimedIssues, hasResult, PHASES,
} from "./lib/state.mjs";
import {
  discoverPrompt, planPrompt, grillPrompt, implementPrompt, reviewPrompt, flattenIssueText,
} from "./lib/prompts.mjs";
import { createIssuesFromDraft } from "./lib/gh.mjs";
import { startGuardError } from "./lib/actions.mjs";

const [, , cmd, repoArg = ".", ...rest] = process.argv;
const repoPath = resolve(repoArg);
const flags = (name) => {
  const i = rest.findIndex((a) => a === `--${name}`);
  return i >= 0 ? (rest[i + 1] && !rest[i + 1].startsWith("--") ? rest[i + 1] : true) : undefined;
};
// --dry y --dry-run son equivalentes: antes "next --dry-run" se ignoraba y creaba issues reales.
const isDryRun = () => flags("dry") !== undefined || flags("dry-run") !== undefined;
// La simulación SOLO existe donde está implementada (clon aislado). init/start/
// pause/complete/status no la implementan: deben rechazar la bandera en vez de
// ignorarla en silencio y mutar el estado igualmente.
const DRY_COMMANDS = new Set(["next", "advance", "issues"]);

function need(state) {
  if (!state) {
    console.error("Sin state.json. Ejecuta primero: node sf.mjs init <repo> --repo owner/name");
    process.exit(1);
  }
  return state;
}

// Work orders to emit when entering a phase.
const phasePlan = {
  discover: (s) => [{ title: `Auditoría del repo (round ${s.round})`, prompt: discoverPrompt }],
  plan: (s) => [{ title: `Plan GSD round ${s.round}`, prompt: planPrompt }],
  grill: (s) => [{ title: `Grill-me al plan round ${s.round}`, prompt: grillPrompt }],
  implement: (s) => {
    return unclaimedIssues(s)
      .map((i) => ({
        title: `Implementar #${i.number} ${flattenIssueText(i.title)}`,
        prompt: (st, t) => implementPrompt(st, t, i),
        meta: { issue: i },
      }));
  },
  review: (s) => [{ title: `Revisión + auditoría round ${s.round}`, prompt: reviewPrompt }],
  issues: () => [], // mechanical phase: no work orders
};

async function emitTasks(state, { dryRun = false } = {}) {
  const plan = phasePlan[state.phase]?.(state) || [];
  for (const entry of plan) {
    const t = newTask(state, state.phase, entry.title);
    Object.assign(t, entry.meta || {});
    const prompt = entry.prompt(state, t);
    if (dryRun) {
      // Simulación: la preview del prompt vive solo en memoria (el clone nunca se guarda).
      t.prompt_preview = prompt;
      t.status = "awaiting_agent";
    } else {
      await writeWorkOrder(t, prompt);
    }
  }
  return plan.length;
}

async function cmdInit() {
  if (!existsSync(repoPath) || !statSync(repoPath).isDirectory()) {
    console.error(`El directorio ${repoPath} no existe. Clona antes el repo y pasa su ruta absoluta.`);
    process.exit(1);
  }
  // Re-init sin --force destruiría el progreso (tasks, issues, fase actual).
  // Incluye state ilegible: existe decision de datos que no debe pisarse en silencio
  // (el canvas también pasa por aquí, sin --force implícito).
  const stateFile = paths(repoPath).state;
  if (existsSync(stateFile) && !flags("force")) {
    const existing = await loadState(repoPath);
    const detail = existing
      ? `fase ${existing.phase}, round ${existing.round}/${existing.max_rounds}, ${existing.tasks?.length ?? "?"} tasks, ${existing.issues?.length ?? "?"} issues`
      : "state.json ilegible (¿JSON corrupto?)";
    console.error(
      `Ya existe estado en ${paths(repoPath).root}: ${detail}. ` +
      `Usa init <repo> ... --force para reiniciar de verdad (perderás el progreso).`,
    );
    process.exit(1);
  }
  const repo = flags("repo") || "";
  const project = flags("project") || "";
  const projectOwner = flags("project-owner") || "";
  const rounds = flags("rounds") || 3;
  const state = defaultState(repoPath, { repo, project, projectOwner, rounds });
  await saveState(repoPath, state);
  await logEvent(repoPath, `init repo=${repo} project=${project} rounds=${rounds}`);
  console.log(JSON.stringify({ ok: true, sf: paths(repoPath).root, state: "idle" }, null, 2));
}

async function cmdStatus() {
  const state = need(await loadState(repoPath));
  const summary = {
    status: state.status, round: state.round, max_rounds: state.max_rounds,
    phase: state.phase, phase_index: `${PHASES.indexOf(state.phase) + 1}/${PHASES.length}`,
    tasks_open: openTasks(state).length, tasks_done: state.tasks.filter((t) => t.status === "done").length,
    tasks_failed: state.tasks.filter((t) => t.status === "failed").length,
    issues_created: state.issues.length, updated_at: state.updated_at,
    notes: (state.notes || "").trim(),
  };
  console.log(JSON.stringify(summary, null, 2));
}

// El canvas y el agente leen el próximo paso: tareas pendientes con su work order.
// En simulación (--dry/--dry-run) todo se calcula sobre un clon aislado: no se
// guarda state.json, no se escriben work orders, no se toca events.log ni gh.
async function cmdNext() {
  const state0 = need(await loadState(repoPath));
  if (state0.status !== "running") {
    const hint = state0.status === "done"
      ? "Fábrica terminada. Ejecuta init <repo> --repo owner/repo para una nueva ejecución."
      : "Ejecuta: node sf.mjs start <repo>";
    console.log(JSON.stringify({ status: state0.status, round: state0.round, phase: state0.phase, tasks: [], hint }, null, 2));
    return;
  }
  const dry = isDryRun();
  const state = dry ? structuredClone(state0) : state0;
  const persist = () => (dry ? Promise.resolve() : saveState(repoPath, state));
  const log = (msg) => (dry ? Promise.resolve() : logEvent(repoPath, msg));
  // Si la fase no tiene tareas: si ya tuvo y están done, avanza; si no tuvo, se generan.
  const hasPhaseTasks = () => state.tasks.some((t) => t.phase === state.phase && t.round === state.round);
  let advancePreview = null;
  if (openTasks(state).length === 0) {
    if (hasPhaseTasks()) {
      // Tareas fallidas no se re-claman, pero el avance no puede ser silencioso.
      const failed = failedTasks(state);
      if (failed.length) {
        state.notes = (state.notes || "") +
          `\nround ${state.round} ${state.phase}: ${failed.length} tarea(s) fallida(s): ${failed.map((f) => f.id).join(", ")}`;
        await log(`fase ${state.phase} (round ${state.round}) avanza con fallidas: ${failed.map((f) => f.id).join(", ")}`);
      }
      advancePreview = await advance(state, { dryRun: dry });
    }
    // advance puede terminar la fábrica (status=done): entonces no se emite nada más.
    if (state.status === "running" && openTasks(state).length === 0 && !hasPhaseTasks()) {
      const n = await emitTasks(state, { dryRun: dry });
      if (n === 0) advancePreview = await advance(state, { dryRun: dry }); // fases mecánicas o sin contenido (issues, implement sin issues)
    }
  }
  const open = openTasks(state);
  const failedNow = failedTasks(state).map((f) => ({ id: f.id, title: f.title }));
  const base = { dry_run: dry, ...(advancePreview ? { advance: advancePreview } : {}) };
  if (open.length === 0) {
    console.log(JSON.stringify({ status: state.status, phase: state.phase, tasks: [], failed: failedNow, ...base }, null, 2));
    return;
  }
  const out = [];
  for (const t of open) {
    let prompt = t.prompt_preview ?? null;
    if (prompt === null) { try { prompt = await readFile(t.prompt_file, "utf8"); } catch { /* pending */ } }
    out.push({ id: t.id, phase: t.phase, title: t.title, status: t.status, prompt });
  }
  await persist();
  console.log(JSON.stringify({ status: state.status, round: state.round, phase: state.phase, tasks: out, failed: failedNow, ...base }, null, 2));
}

// Avanza la máquina de fases. Con dryRun NO muta el state recibido, NO guarda en
// disco y NO registra eventos: opera sobre un clon desechable y devuelve una
// previsualización explícita (incluidas las issues ficticias del draft). Así una
// simulación no puede dejar la fase `issues` por delante de una ejecución real.
async function advance(state, { dryRun = isDryRun() } = {}) {
  const work = dryRun ? structuredClone(state) : state;
  const preview = {
    dryRun, from: work.phase, to: work.phase, advanced: false,
    status: work.status, round: work.round, issues: [],
  };
  if (work.status === "done") return preview; // fábrica terminada: no avanza ni crea rondas extra
  if (work.phase === "issues") {
    const created = await createIssuesFromDraft(work, {
      dryRun,
      persistState: dryRun ? async () => {} : () => saveState(work.repo_path, work),
    });
    preview.issues = created;
    if (!dryRun) await logEvent(work.repo_path, `issues phase: ${created.length} issues`);
  }
  if (work.phase === "review") {
    if (work.round >= work.max_rounds) {
      // round se queda en max_rounds: done no debe dejar una ronda extra visible.
      work.status = "done";
      work.phase = "review";
      preview.to = "review"; preview.status = "done";
      if (!dryRun) {
        await logEvent(work.repo_path, `factory done tras ${work.max_rounds} rounds`);
        await saveState(work.repo_path, work);
      }
      return preview;
    }
    work.round += 1;
    work.phase = "discover";
    preview.to = "discover"; preview.round = work.round; preview.advanced = true;
    if (!dryRun) {
      await logEvent(work.repo_path, `round ${work.round} iniciado`);
      await saveState(work.repo_path, work);
    }
    return preview;
  }
  const idx = PHASES.indexOf(work.phase);
  work.phase = PHASES[idx + 1] || PHASES[0];
  preview.to = work.phase; preview.advanced = true;
  if (!dryRun) {
    await logEvent(work.repo_path, `fase -> ${work.phase} (round ${work.round})`);
    await saveState(work.repo_path, work);
  }
  return preview;
}

async function cmdComplete() {
  const [taskId, ...extra] = rest;
  const state = need(await loadState(repoPath));
  const t = state.tasks.find((x) => x.id === taskId);
  if (!t) { console.error(`task ${taskId} no existe`); process.exit(1); }
  const fail = extra.includes("--fail");
  // Contract de la skill y de los work orders: cerrar "done" exige el informe
  // escrito en result_file. --force es la alternativa explícita y documentada.
  if (!fail && !extra.includes("--force") && !(await hasResult(t))) {
    console.error(
      `Sin informe utilizable en ${t.result_file} (no existe o esta vacio). Escribe el resultado de la tarea antes de cerrarla ` +
      `(o usa complete <repo> <taskId> --force como alternativa explícita).`,
    );
    process.exit(1);
  }
  t.status = fail ? "failed" : "done";
  t.completed_at = new Date().toISOString();
  await logEvent(repoPath, `task ${taskId} -> ${t.status}`);
  await saveState(repoPath, state);
  const remaining = openTasks(state);
  console.log(JSON.stringify({ ok: true, task: taskId, status: t.status, open_in_phase: remaining.length }, null, 2));
}

async function cmdSetStatus(next) {
  const state = need(await loadState(repoPath));
  if (next === "running") {
    const guard = startGuardError(state);
    if (guard) { console.error(guard); process.exit(1); }
  }
  state.status = next;
  // No re-emitir si la fase actual ya tuvo tareas (aunque estén todas done): next las cierra.
  const phaseHasTasks = state.tasks.some((t) => t.phase === state.phase && t.round === state.round);
  if (next === "running" && !openTasks(state).length && !phaseHasTasks) await emitTasks(state);
  await logEvent(repoPath, `status -> ${next}`);
  await saveState(repoPath, state);
  console.log(JSON.stringify({ ok: true, status: state.status, phase: state.phase }, null, 2));
}

async function cmdIssues() {
  const state0 = need(await loadState(repoPath));
  const dry = isDryRun();
  // Simulación aislada: el clon nunca se persiste ni genera eventos.
  const state = dry ? structuredClone(state0) : state0;
  const created = await createIssuesFromDraft(state, {
    dryRun: dry,
    persistState: () => (dry ? Promise.resolve() : saveState(state.repo_path, state)),
  });
  if (!dry) {
    await logEvent(repoPath, `issues manual: ${created.length}`);
    await saveState(repoPath, state);
  }
  console.log(JSON.stringify({
    ok: true, dry_run: dry,
    created: created.length, urls: created,
  }, null, 2));
}

async function main() {
  // Rechazo explícito ANTES de cualquier escritura: un comando sin previsualización
  // real no puede fingir que simula (antes start/pause/init/complete ignoraban la
  // bandera y mutaban el estado igualmente).
  if (isDryRun() && !DRY_COMMANDS.has(cmd)) {
    console.error(
      `--dry/--dry-run solo se admite en next/advance/issues; '${cmd || "?"}' no tiene previsualizacion y mutaria el estado. ` +
      "Quita la bandera para ejecutar de verdad, o usa next <repo> --dry para previsualizar el proximo paso.",
    );
    process.exit(2);
  }
  switch (cmd) {
    case "init": return cmdInit();
    case "status": return cmdStatus();
    case "next": return cmdNext();
    case "complete": return cmdComplete();
    case "start": return cmdSetStatus("running");
    case "pause": return cmdSetStatus("paused");
    case "issues": return cmdIssues();
    case "advance": {
      const s = need(await loadState(repoPath));
      const preview = await advance(s, { dryRun: isDryRun() });
      console.log(JSON.stringify({ ok: true, ...preview }, null, 2));
      return;
    }
    default:
      console.log(`sf.mjs — Software Factory runner
Comandos:
  init <repo> --repo owner/repo [--project NNN] [--project-owner owner] [--rounds 3] [--force]
      (sin --force no toca un estado existente; reiniciar es decision explicita)
  start|pause|status|next <repo>
  complete <repo> <taskId> [--fail|--force]
      (done exige informe no vacio en result_file; --force es la alternativa explicita)
  issues <repo> [--dry|--dry-run]  (crea issues del draft + añade al Project; la simulacion
      no escribe en state.issues ni llama a gh: solo devuelve la previsualizacion)
  advance <repo> [--dry|--dry-run] (fuerza avance de fase; en simulacion solo previsualiza,
      NO avanza ni guarda: la fase real sigue intacta para la ejecucion posterior)
Simulacion: --dry y --dry-run son equivalentes y se admiten SOLO en next/advance/issues.
  En seco operan sobre un clon aislado: no modifican state.json, events.log ni work
  orders. init/start/pause/complete/status rechazan la bandera (exit 2) sin escribir.
Produccion no tiene modo simulado: ninguna variable de entorno desvia las llamadas a
  gh. Las pruebas e2e simulan gh con un preload exclusivo de tests
  (test-support/fake-gh-preload.mjs, via NODE_OPTIONS=--import) que sustituye execFile en el
  proceso de prueba; los tests unitarios inyectan runGh.
Tareas --fail: no se re-claman; el fallo queda en status/notes/events.log.`);
  }
}

main().catch((e) => { console.error("ERROR:", e.message); process.exit(1); });
