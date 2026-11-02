#!/usr/bin/env node
// sf.mjs — Software Factory runner CLI.
// Uso: node sf.mjs <command> <repoPath> [args...]
import { resolve } from "node:path";
import { readFile } from "node:fs/promises";
import {
  loadState, saveState, defaultState, logEvent, paths,
  newTask, writeWorkOrder, openTasks, PHASES,
  hasResult,
} from "./lib/state.mjs";
import {
  discoverPrompt, planPrompt, grillPrompt, implementPrompt, reviewPrompt,
} from "./lib/prompts.mjs";
import { createIssuesFromDraft } from "./lib/gh.mjs";

const [, , cmd, repoArg = ".", ...rest] = process.argv;
const repoPath = resolve(repoArg);
const flags = (name) => {
  const i = rest.findIndex((a) => a === `--${name}`);
  return i >= 0 ? (rest[i + 1] && !rest[i + 1].startsWith("--") ? rest[i + 1] : true) : undefined;
};

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
    const claimed = new Set(
      s.tasks.filter((t) => t.phase === "implement" && t.meta?.issue?.number)
        .map((t) => t.meta.issue.number),
    );
    return (s.issues || [])
      .filter((i) => i.number && !i.dry && !claimed.has(i.number))
      .map((i) => ({
        title: `Implementar #${i.number} ${i.title}`,
        prompt: (st, t) => implementPrompt(st, t, i),
        meta: { issue: i },
      }));
  },
  review: (s) => [{ title: `Revisión + auditoría round ${s.round}`, prompt: reviewPrompt }],
  issues: () => [], // mechanical phase: no work orders
};

async function emitTasks(state) {
  const plan = phasePlan[state.phase]?.(state) || [];
  for (const entry of plan) {
    const t = newTask(state, state.phase, entry.title);
    Object.assign(t, entry.meta || {});
    await writeWorkOrder(t, entry.prompt(state, t));
  }
  return plan.length;
}

async function cmdInit() {
  const repo = flags("repo") || "";
  const project = flags("project") || "";
  const rounds = flags("rounds") || 3;
  // Re-init sin --force borra el progreso (tasks/issues); 3 inits previos lo demostraron.
  const existing = await loadState(repoPath);
  if (existing && !flags("force")) {
    console.error(
      `Ya existe estado en ${paths(repoPath).root}: fase ${existing.phase}, round ${existing.round}, ` +
      `${existing.tasks.length} tasks, ${existing.issues.length} issues. ` +
      `Usa --force para sobrescribir (perderás el progreso).`,
    );
    process.exit(1);
  }
  const state = defaultState(repoPath, { repo, project, rounds });
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
    issues_created: state.issues.length, updated_at: state.updated_at,
    notes: (state.notes || "").trim(),
  };
  console.log(JSON.stringify(summary, null, 2));
}

// El canvas y el agente leen el próximo paso: tareas pendientes con su work order.
async function cmdNext() {
  const state = need(await loadState(repoPath));
  if (state.status !== "running") {
    console.log(JSON.stringify({ status: state.status, hint: "Ejecuta: node sf.mjs start <repo>" }, null, 2));
    return;
  }
  // Si la fase no tiene tareas: si ya tuvo y están done, avanza; si no tuvo, se generan.
  const hasPhaseTasks = () => state.tasks.some((t) => t.phase === state.phase && t.round === state.round);
  if (openTasks(state).length === 0) {
    if (hasPhaseTasks()) {
      await advance(state);
    }
    if (openTasks(state).length === 0 && !hasPhaseTasks()) {
      const n = await emitTasks(state);
      if (n === 0) await advance(state); // fases mecánicas o sin contenido (issues, implement sin issues)
    }
  }
  const open = openTasks(state);
  if (open.length === 0) {
    console.log(JSON.stringify({ status: state.status, phase: state.phase, tasks: [] }, null, 2));
    return;
  }
  const out = [];
  for (const t of open) {
    let prompt = null;
    try { prompt = await readFile(t.prompt_file, "utf8"); } catch { /* pending */ }
    out.push({ id: t.id, phase: t.phase, title: t.title, status: t.status, prompt });
  }
  await saveState(repoPath, state);
  console.log(JSON.stringify({ status: state.status, round: state.round, phase: state.phase, tasks: out }, null, 2));
}

async function advance(state) {
  const p = paths(state.repo_path);
  if (state.phase === "issues") {
    const created = await createIssuesFromDraft(state, { dryRun: Boolean(flags("dry-run")) });
    await logEvent(state.repo_path, `issues phase: ${created.length} issues`);
  }
  if (state.phase === "review") {
    state.round += 1;
    if (state.round > state.max_rounds) {
      state.status = "done";
      state.phase = "review";
      await logEvent(state.repo_path, `factory done tras ${state.max_rounds} rounds`);
      await saveState(state.repo_path, state);
      return;
    }
    state.phase = "discover";
    await logEvent(state.repo_path, `round ${state.round} iniciado`);
    await saveState(state.repo_path, state);
    return;
  }
  const idx = PHASES.indexOf(state.phase);
  state.phase = PHASES[idx + 1] || PHASES[0];
  await logEvent(state.repo_path, `fase -> ${state.phase} (round ${state.round})`);
  await saveState(state.repo_path, state);
}

async function cmdComplete() {
  const [taskId, ...extra] = rest;
  const state = need(await loadState(repoPath));
  const t = state.tasks.find((x) => x.id === taskId);
  if (!t) { console.error(`task ${taskId} no existe`); process.exit(1); }
  const fail = extra.includes("--fail");
  // Contract de la skill: cerrar "done" exige informe escrito en result_file.
  if (!fail && !extra.includes("--force") && !(await hasResult(t))) {
    console.error(
      `Sin informe en ${t.result_file}. Escribe el resultado de la tarea antes de cerrarla (o usa --force).`,
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
  state.status = next;
  if (next === "running" && !openTasks(state).length) await emitTasks(state);
  await logEvent(repoPath, `status -> ${next}`);
  await saveState(repoPath, state);
  console.log(JSON.stringify({ ok: true, status: state.status, phase: state.phase }, null, 2));
}

async function cmdIssues() {
  const state = need(await loadState(repoPath));
  const created = await createIssuesFromDraft(state, { dryRun: Boolean(flags("dry-run")) });
  await logEvent(repoPath, `issues manual: ${created.length}`);
  await saveState(repoPath, state);
  console.log(JSON.stringify({ ok: true, created: created.length, urls: created }, null, 2));
}

async function main() {
  switch (cmd) {
    case "init": return cmdInit();
    case "status": return cmdStatus();
    case "next": return cmdNext();
    case "complete": return cmdComplete();
    case "start": return cmdSetStatus("running");
    case "pause": return cmdSetStatus("paused");
    case "issues": return cmdIssues();
    case "advance": { const s = need(await loadState(repoPath)); return advance(s); }
    default:
      console.log(`sf.mjs — Software Factory runner
Comandos:
      init <repo> --repo owner/repo [--project NNN] [--rounds 3] [--force]
  start|pause|status|next <repo>
      complete <repo> <taskId> [--fail|--force]
  issues <repo> [--dry-run]   (crea issues del draft + añade al Project)
  advance <repo>              (fuerza avance de fase)`);
  }
}

main().catch((e) => { console.error("ERROR:", e.message); process.exit(1); });
