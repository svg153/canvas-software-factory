// Software Factory runner — state machine shared by the CLI and the canvas.
// Lives in <repo>/.software-factory/
import { mkdir, readFile, writeFile, appendFile, readdir, rename, unlink, stat } from "node:fs/promises";
import { join } from "node:path";

export const SF_DIR = ".software-factory";
export const PHASES = ["discover", "plan", "grill", "issues", "implement", "review"];

export function paths(repoPath) {
  const root = join(repoPath, SF_DIR);
  return {
    root,
    state: join(root, "state.json"),
    pending: join(root, "pending"),
    results: join(root, "results"),
    log: join(root, "events.log"),
    plan: join(root, "plan.md"),
    draft: join(root, "issues-draft.json"),
  };
}

export { HARNESS_IDS as HARNESSES } from "./harnesses.mjs";

export const nowIso = () => new Date().toISOString();

export function defaultState(repoPath, opts = {}) {
  return {
    repo: opts.repo || "",
    repo_path: repoPath,
    project_id: opts.project || "",
    project_owner: opts.projectOwner || opts.repo?.split("/")[0] || "",
    harness: opts.harness || "",
    model: opts.model || "",
    status: "idle", // idle | running | paused | done
    round: 1,
    max_rounds: Number(opts.rounds ?? 3),
    phase: "discover",
    tasks: [],
    issues: [],
    // PRs abiertas por la fábrica, registradas con `sf pr <repo> <taskId> <url>`:
    // { number, url, round, task_id, recorded_at }. alimenta el work order de
    // feedback de la fase implement (un pase por PR y round; vacio = fase auto-skip).
    prs: [],
    // Ideas del usuario ("vocal ideas"): cada una es una semilla que la próxima
    // fase plan descompone en 1+ issues. Ciclo: new -> planned (al salir de plan)
    // -> triaged (al salir de grill). Status lo mueve la máquina de fases, no el agente.
    seeds: [],
    // Ingesta del repo: snapshot mecánico (gh) del trabajo YA abierto — issues y PRs
    // abiertas y items del Project — para que un repo "a medias" continúe de forma
    // autónoma. Lo rellena `sf.mjs intake`; null = aún sin ingesta.
    inventory: null,
    updated_at: nowIso(),
  };
}

// Semillas pendientes de materializar: las que aún no ha visto ninguna fase plan.
export function newSeeds(state) {
  return (state.seeds || []).filter((s) => s.status === "new");
}

export async function loadState(repoPath) {
  const p = paths(repoPath);
  try {
    return JSON.parse(await readFile(p.state, "utf8"));
  } catch {
    return null;
  }
}

// Escritura atómica compartida: tmp único (pid+aleatorio) + rename. Un crash a mitad
// deja el fichero anterior íntegro, nunca a medias.
async function atomicWrite(file, data) {
  const tmp = `${file}.${process.pid}.${Math.random().toString(36).slice(2)}.tmp`;
  try {
    await writeFile(tmp, data);
    await rename(tmp, file);
  } catch (e) {
    await unlink(tmp).catch(() => {});
    throw e;
  }
}

const LOCK_STALE_MS = 30_000;
const LOCK_TIMEOUT_MS = 15_000;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// Lock de fichero (state.json.lock, creación exclusiva) entre procesos: canvas y runner.
export async function withStateLock(repoPath, fn) {
  const p = paths(repoPath);
  await mkdir(p.pending, { recursive: true });
  await mkdir(p.results, { recursive: true });
  const lock = `${p.state}.lock`;
  const deadline = Date.now() + LOCK_TIMEOUT_MS;
  for (let wait = 5; ; wait = Math.min(wait * 2, 100)) {
    try {
      await writeFile(lock, String(process.pid), { flag: "wx" });
      break;
    } catch (e) {
      if (e.code !== "EEXIST" && e.code !== "EPERM" && e.code !== "EACCES") throw e;
      try {
        // Lock huérfano (proceso muerto a mitad): se recupera pasado el umbral.
        if (Date.now() - (await stat(lock)).mtimeMs > LOCK_STALE_MS) await unlink(lock);
      } catch {}
      if (Date.now() > deadline) throw new Error(`state.json bloqueado (${lock}); borra el lock si ningún proceso lo usa`);
      await sleep(wait);
    }
  }
  try {
    return await fn();
  } finally {
    await unlink(lock).catch(() => {});
  }
}

async function writeStateUnlocked(repoPath, state) {
  state.updated_at = nowIso();
  await atomicWrite(paths(repoPath).state, JSON.stringify(state, null, 2));
  return state;
}

export function saveState(repoPath, state) {
  return withStateLock(repoPath, () => writeStateUnlocked(repoPath, state));
}

// Read-modify-write bajo lock: ninguna mutación concurrente se pierde.
// mutate recibe el estado actual (o null) y puede devolver otro objeto; si devuelve
// false no se escribe.
export function updateState(repoPath, mutate) {
  return withStateLock(repoPath, async () => {
    const current = await loadState(repoPath);
    const result = await mutate(current);
    if (result === false) return current;
    return writeStateUnlocked(repoPath, result ?? current);
  });
}
export async function logEvent(repoPath, msg) {
  const p = paths(repoPath);
  await mkdir(p.root, { recursive: true });
  await appendFile(p.log, `[${nowIso()}] ${msg}\n`);
}

export function taskById(state, id) {
  return state.tasks.find((t) => t.id === id);
}

export function openTasks(state, phase = state.phase) {
  // done y failed cierran la tarea: si no, una task fallida se re-clamaría para siempre.
  // El fallo se hace visible aparte (notes/status/output), no se oculta.
  return state.tasks.filter((t) => t.phase === phase && t.status !== "done" && t.status !== "failed");
}

export function failedTasks(state, phase = state.phase, round = state.round) {
  return state.tasks.filter((t) => t.phase === phase && t.round === round && t.status === "failed");
}

export function normTitle(title) {
  return String(title ?? "").normalize("NFKC").toLowerCase().replace(/\s+/g, " ").trim();
}

// Identidad canónica: number/url; el título normalizado solo es fallback.
export function sameIssue(a, b) {
  if (!a || !b) return false;
  if (a.number && b.number) return Number(a.number) === Number(b.number);
  if (a.url && b.url && a.url !== "(dry-run)" && b.url !== "(dry-run)") return a.url === b.url;
  const ta = normTitle(a.title);
  return ta !== "" && ta === normTitle(b.title);
}

// Una issue es reclamable si no tiene tarea implement, o si la última terminó en failed.
// done (o una tarea aún viva) la mantiene excluida; el historial de fallos se conserva.
export function unclaimedIssues(state) {
  const latest = new Map();
  for (const task of state.tasks.filter((t) => t.phase === "implement")) {
    const n = task.issue?.number || task.meta?.issue?.number;
    if (n) latest.set(Number(n), task);
  }
  return (state.issues || []).filter((issue) => {
    if (!issue.number) return false;
    const task = latest.get(Number(issue.number));
    return !task || task.status === "failed";
  });
}
let seq = 0;
export function newTask(state, phase, title) {
  seq = state.tasks.length;
  const id = `r${state.round}-${phase}-${String(++seq).padStart(2, "0")}`;
  const p = paths(state.repo_path);
  const task = {
    id,
    round: state.round,
    phase,
    title,
    status: "pending", // pending | awaiting_agent | done | failed
    prompt_file: join(p.pending, `${id}.md`),
    result_file: join(p.results, `${id}.md`),
    created_at: nowIso(),
  };
  state.tasks.push(task);
  return task;
}

export async function writeWorkOrder(task, prompt) {
  await mkdir(join(task.prompt_file, ".."), { recursive: true });
  await atomicWrite(task.prompt_file, prompt);
  task.status = "awaiting_agent";
}

export async function hasResult(task) {
  try {
    // Un archivo vacío o solo espacios no es un informe: complete sin --force
    // debe exigir contenido real (QA: antes bastaba tocar el archivo).
    const content = await readFile(task.result_file, "utf8");
    return content.trim().length > 0;
  } catch {
    return false;
  }
}

export async function listPendingFiles(dir) {
  try {
    return (await readdir(dir)).filter((f) => f.endsWith(".md"));
  } catch {
    return [];
  }
}
