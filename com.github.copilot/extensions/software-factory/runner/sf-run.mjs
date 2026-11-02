#!/usr/bin/env node
// sf-run.mjs — headless autonomous executor: next -> adapter.run() -> complete.
// Uso: node sf-run.mjs <repo> --harness <id> [--model X] [--max-tasks N] [--timeout MS]
//        [--dry-run] [--yes] [--adapter-module path]
import { execFile } from "node:child_process";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { promisify } from "node:util";
import { loadState, saveState, logEvent, hasResult } from "./lib/state.mjs";
import { resolve as resolveAdapter, DEFAULT_TIMEOUT_MS } from "./lib/adapters/index.mjs";

const execFileAsync = promisify(execFile);
const sfPath = join(dirname(fileURLToPath(import.meta.url)), "sf.mjs");
// Work orders that only read/plan; they never modify the repo's code.
const READ_ONLY_PHASES = new Set(["discover", "plan", "grill", "review"]);

async function sf(cmd, repo, args = []) {
  try {
    const { stdout } = await execFileAsync(process.execPath, [sfPath, cmd, repo, ...args], { maxBuffer: 64 * 1024 * 1024 });
    return { ok: true, stdout };
  } catch (e) {
    return { ok: false, stdout: e.stdout || "", error: (e.stderr || e.message || "").trim() };
  }
}

const sfJson = async (cmd, repo, args) => {
  const r = await sf(cmd, repo, args);
  if (!r.ok) throw new Error(`sf ${cmd} falló: ${r.error}`);
  return JSON.parse(r.stdout);
};

export async function runFactory({
  repo, harness, model, maxTasks = Infinity, timeoutMs = DEFAULT_TIMEOUT_MS,
  dryRun = false, yes = false, adapter, log = console.log,
}) {
  const summary = { done: 0, failed: 0, skipped: [], attempted: [], stopped: "", dryRun };
  const status = await sfJson("status", repo);
  const ad = adapter || resolveAdapter(harness, { harness, model });
  if (status.status !== "running") {
    summary.stopped = `factory status=${status.status}`;
    log(`[sf-run] ${summary.stopped}; nada que ejecutar`);
    return summary;
  }
  if (!yes) log("[sf-run] sin --yes: solo work orders de solo-lectura (discover/plan/grill/review); implement se omite");
  const attempted = new Set();
  while (summary.attempted.length < maxTasks) {
    const st = await sfJson("status", repo);
    if (st.status !== "running") { summary.stopped = `factory status=${st.status}`; break; }
    const next = await sfJson("next", repo, dryRun ? ["--dry-run"] : []);
    const open = (next.tasks || []).filter((t) => !attempted.has(t.id));
    const runnable = open.filter((t) => yes || READ_ONLY_PHASES.has(t.phase));
    for (const t of open) {
      if (!runnable.includes(t) && !summary.skipped.includes(t.id)) {
        summary.skipped.push(t.id);
        log(`[sf-run] omitida ${t.id} (${t.phase}): requiere --yes`);
      }
    }
    const task = runnable[0];
    if (!task) { summary.stopped = open.length ? "solo quedan tareas que requieren --yes" : "sin tareas pendientes"; break; }
    if (dryRun) {
      log(`[sf-run] DRY-RUN plan: ${task.id} (${task.phase}) "${task.title}" harness=${ad.id || harness} model=${model || "default"}`);
      summary.attempted.push(task.id);
      summary.stopped = "dry-run";
      break;
    }
    attempted.add(task.id);
    summary.attempted.push(task.id);
    const state = await loadState(repo);
    const full = state.tasks.find((t) => t.id === task.id);
    const started = Date.now();
    let outcome = "done";
    let note = "";
    try {
      const res = await ad.run({
        prompt: task.prompt || "", model, cwd: repo, timeoutMs,
        taskId: task.id, resultFile: full?.result_file,
      });
      if (!res.ok) { outcome = "failed"; note = `adapter error: ${res.error || "exit " + res.exitCode}`; }
      else if (!full || !(await hasResult(full))) { outcome = "failed"; note = "tarea sin informe en result_file"; }
    } catch (e) {
      outcome = "failed"; note = `adapter error: ${e.message}`;
    }
    const args = outcome === "failed" ? ["--fail"] : [];
    const c = await sf("complete", repo, [task.id, ...args]);
    if (!c.ok) { outcome = "failed"; note ||= `complete falló: ${c.error}`; }
    if (outcome === "failed") {
      summary.failed++;
      const s = await loadState(repo);
      const t = s.tasks.find((x) => x.id === task.id);
      if (t && t.status !== "failed") t.status = "failed";
      s.notes = `${s.notes || ""}\n${task.id}: ${note}`;
      await saveState(repo, s);
      await logEvent(repo, `sf-run ${task.id} failed: ${note}`);
    } else summary.done++;
    log(`[sf-run] ${task.id} harness=${ad.id || harness} ${Date.now() - started}ms -> ${outcome}${note ? ` (${note})` : ""}`);
  }
  if (!summary.stopped) summary.stopped = "max-tasks alcanzado";
  log(`[sf-run] resumen: done=${summary.done} failed=${summary.failed} omitidas=${summary.skipped.length} stop="${summary.stopped}"`);
  if (summary.failed) log("[sf-run] para revertir trabajo de tareas fallidas: git reset --hard <commit previo> o descarta la rama de trabajo");
  return summary;
}

function parseArgs(argv) {
  const o = { repo: null, maxTasks: Infinity, yes: false, dryRun: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    const val = () => argv[++i];
    if (a === "--harness") o.harness = val();
    else if (a === "--model") o.model = val();
    else if (a === "--max-tasks") o.maxTasks = Number(val());
    else if (a === "--timeout") o.timeoutMs = Number(val());
    else if (a === "--adapter-module") o.adapterModule = val();
    else if (a === "--dry-run") o.dryRun = true;
    else if (a === "--yes") o.yes = true;
    else if (!a.startsWith("--") && !o.repo) o.repo = resolve(a);
  }
  return o;
}

async function main() {
  const o = parseArgs(process.argv.slice(2));
  if (!o.repo || (!o.harness && !o.adapterModule)) {
    console.error("Uso: node sf-run.mjs <repo> --harness <id> [--model X] [--max-tasks N] [--timeout MS] [--dry-run] [--yes]");
    process.exit(2);
  }
  if (!Number.isFinite(o.maxTasks) && o.maxTasks !== Infinity) { console.error("--max-tasks inválido"); process.exit(2); }
  if (o.adapterModule) {
    const m = await import(pathToFileURL(resolve(o.adapterModule)).href);
    o.adapter = m.default || m.adapter;
  }
  // Ctrl+C: la tarea en curso queda awaiting_agent (reclamarla de nuevo es idempotente).
  process.on("SIGINT", () => { console.error("\n[sf-run] interrumpido; la tarea sigue awaiting_agent"); process.exit(130); });
  const s = await runFactory(o);
  process.exit(s.failed ? 1 : 0);
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((e) => { console.error("ERROR:", e.message); process.exit(1); });
}
