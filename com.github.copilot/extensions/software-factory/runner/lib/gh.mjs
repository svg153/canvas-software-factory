// gh CLI helpers for the mechanical "issues" phase.
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { readFile } from "node:fs/promises";
import { sameIssue } from "./state.mjs";
import { rebuildGraph } from "./graph.mjs";

const run = promisify(execFile);

async function gh(args) {
  // El criterio de error es SOLO el exit code: execFile rechaza si != 0 (stderr
  // incluido en el error). Scannear stderr con /error|could not|failed/ falsaba
  // con avisos legítimos de gh (p. ej. "warning: ... failed to check for updates").
  // No hay modo simulado en produccion: las pruebas e2e sustituyen execFile con
  // un preload exclusivo de tests (test-support/fake-gh-preload.mjs via NODE_OPTIONS
  // =--import), y los tests unitarios inyectan runGh. Ninguna variable de
  // entorno puede desviar una ejecucion real aqui.
  const { stdout } = await run("gh", args, {
    windowsHide: true,
    maxBuffer: 16 * 1024 * 1024,
  });
  return stdout.trim();
}

const PROJECT_ID_RE = /^(\d+|PVT_\w+)$/;
const OWNER_RE = /^[A-Za-z0-9][A-Za-z0-9-]{0,38}$/;
const REPO_RE = /^[A-Za-z0-9][A-Za-z0-9-]{0,38}\/[\w.-]+$/;

// Validación temprana (init): valores con "-" inicial serían parseados como flags de gh.
export function validateInitInputs({ repo = "", project = "", projectOwner = "" } = {}) {
  const errors = [];
  if (repo && !(REPO_RE.test(repo) && !repo.split("/")[1].startsWith("-"))) errors.push(`--repo inválido (${JSON.stringify(repo)}): usa owner/name`);
  if (project && !PROJECT_ID_RE.test(String(project))) errors.push(`--project inválido (${JSON.stringify(project)}): usa un número o PVT_xxx`);
  if (projectOwner && !OWNER_RE.test(projectOwner)) errors.push(`--project-owner inválido (${JSON.stringify(projectOwner)}): usa [A-Za-z0-9-]+`);
  return errors;
}

// Detección del Project enlazado al repo (#83) vía GraphQL projectsV2.
// ProjectV2Owner es una unión (User|Organization|Team): `login` solo existe en los
// fragments, no en la unión — pedirlo directo devuelve undefinedField y gh sale con error.
const PROJECTS_V2_QUERY =
  "query($owner:String!,$name:String!){ repository(owner:$owner,name:$name){ projectsV2(first:10){ nodes{ number title owner{ __typename ... on User { login } ... on Organization { login } } } } } }";

// Un slug con "-" inicial en el nombre sería parseado por gh como un flag: se rechaza
// antes de construir cualquier args (--repo, issue list, pr list comparten criterio).
function assertRepoSlug(slug) {
  if (typeof slug !== "string" || !REPO_RE.test(slug) || slug.split("/")[1].startsWith("-")) {
    throw new Error(`slug de repo inválido: ${JSON.stringify(slug)}`);
  }
}

export function projectsV2Args(slug) {
  assertRepoSlug(slug);
  const [owner, name] = slug.split("/");
  return ["api", "graphql", "-f", `owner=${owner}`, "-f", `name=${name}`, "-f", `query=${PROJECTS_V2_QUERY}`];
}

export function parseProjectsV2(stdout) {
  let data;
  try {
    data = JSON.parse(stdout);
  } catch {
    return [];
  }
  const nodes = data?.data?.repository?.projectsV2?.nodes;
  if (!Array.isArray(nodes)) return [];
  return nodes
    .filter((n) => Number.isFinite(Number(n?.number)))
    .map((n) => ({ number: Number(n.number), title: n.title || "", owner: n.owner?.login || "" }));
}

export async function listLinkedProjects(slug, { runGh = gh } = {}) {
  return parseProjectsV2(await runGh(projectsV2Args(slug)));
}

// ---- #90: estado real del repo en GitHub (issues/PRs abiertos) ----

export function openIssuesArgs(slug) {
  assertRepoSlug(slug);
  return ["issue", "list", "--repo", slug, "--state", "open", "--limit", "200",
    "--json", "number,title,url,labels"];
}

export function openPullsArgs(slug) {
  assertRepoSlug(slug);
  return ["pr", "list", "--repo", slug, "--state", "open", "--limit", "200",
    "--json", "number,title,url,isDraft,mergeable,headRefName,statusCheckRollup"];
}

// gh devuelve basura si falla de forma inesperada: nunca lanzamos, devolvemos [].
export function parseIssueList(stdout) {
  let data;
  try {
    data = JSON.parse(stdout);
  } catch {
    return [];
  }
  if (!Array.isArray(data)) return [];
  return data
    .filter((n) => Number.isFinite(Number(n?.number)) && n?.title != null)
    .map((n) => ({
      number: Number(n.number),
      title: String(n.title),
      url: String(n.url ?? ""),
      labels: (Array.isArray(n.labels) ? n.labels : [])
        .map((l) => String(l?.name ?? ""))
        .filter(Boolean),
    }));
}

// statusCheckRollup → "fail" | "pending" | "pass" | "none" (lo esencial para decidir
// si un PR es mezclable de hecho; el detalle queda en GitHub).
function summarizeChecks(rollup) {
  if (!Array.isArray(rollup) || rollup.length === 0) return "none";
  const states = rollup.map((c) => String(c?.state ?? c?.status ?? "").toUpperCase());
  if (states.some((s) => ["FAILURE", "ERROR", "TIMED_OUT", "CANCELLED"].includes(s))) return "fail";
  if (states.some((s) => ["PENDING", "IN_PROGRESS", "QUEUED", ""].includes(s))) return "pending";
  return "pass";
}

export function parsePullList(stdout) {
  let data;
  try {
    data = JSON.parse(stdout);
  } catch {
    return [];
  }
  if (!Array.isArray(data)) return [];
  return data
    .filter((n) => Number.isFinite(Number(n?.number)) && n?.title != null)
    .map((n) => ({
      number: Number(n.number),
      title: String(n.title),
      url: String(n.url ?? ""),
      isDraft: Boolean(n.isDraft),
      mergeable: String(n.mergeable ?? "UNKNOWN"),
      head: String(n.headRefName ?? ""),
      checks: summarizeChecks(n.statusCheckRollup),
    }));
}

// Blando por diseño: un fallo parcial (auth, rate limit) no vacía la otra lista;
// se devuelve una nota cortada (los errores de gh mencionan el slug, nunca rutas locales).
export async function getGithubStatus(slug, { runGh = gh } = {}) {
  const out = { issues: [], pulls: [], note: "" };
  const notes = [];
  try {
    out.issues = parseIssueList(await runGh(openIssuesArgs(slug)));
  } catch (e) {
    notes.push(`issues: ${String(e.message).slice(0, 120)}`);
  }
  try {
    out.pulls = parsePullList(await runGh(openPullsArgs(slug)));
  } catch (e) {
    notes.push(`pulls: ${String(e.message).slice(0, 120)}`);
  }
  out.note = notes.join("; ");
  return out;
}

// Vincula las issues abiertas en GitHub al estado del run (state.issues) para que la
// fase issues no las duplique: createIssuesFromDraft ya deduce contra state.issues (sameIssue).
// Solo escribe si hay novedades; devuelve {imported, open}.
export async function importOpenIssues(state, { runGh = gh, persistState = async () => {} } = {}) {
  const slug = repoSlug(state);
  const list = parseIssueList(await runGh(openIssuesArgs(slug)));
  if (!Array.isArray(state.issues)) state.issues = [];
  const known = [...state.issues];
  let imported = 0;
  for (const it of list) {
    if (known.some((k) => sameIssue(k, it))) continue;
    state.issues.push({ title: it.title, url: it.url, number: it.number, at: new Date().toISOString(), imported: true });
    known.push(it);
    imported += 1;
  }
  if (imported > 0) await persistState();
  return { imported, open: list.length };
}

export function projectItemAddArgs(state, url) {
  const owner = state.project_owner || state.repo?.split("/")[0];
  if (!owner) throw new Error("Project owner is required to add an issue to a project");
  if (!OWNER_RE.test(owner)) throw new Error(`Project owner inválido: ${JSON.stringify(owner)}`);
  if (!PROJECT_ID_RE.test(String(state.project_id))) throw new Error(`project_id inválido: ${JSON.stringify(state.project_id)}`);
  return [
    "project", "item-add", state.project_id,
    "--owner", owner,
    "--url", url,
  ];
}

// Slug válido de GitHub: owner/name. Sin él, "--repo ." crearía issues en el cwd del
// runner (no en el repo de la fábrica), así que se valida antes de tocar la CLI.
export function repoSlug(state) {
  if (typeof state.repo === "string" && /^[\w.-]+\/[\w.-]+$/.test(state.repo)) return state.repo;
  throw new Error(
    `El estado no tiene un repo GitHub válido (repo=${JSON.stringify(state.repo ?? null)}). ` +
    "Configúralo con: node sf.mjs init <repo> --repo owner/name",
  );
}

// gh --json emite un array; cualquier otra salida (objeto, basura, "") se lee como
// vacío para que una ingesta nunca reviente el bucle.
function parseJsonArray(out) {
  try {
    const parsed = JSON.parse(out);
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

// `gh project item-list --format json` devuelve { "items": [ ... ] }.
function parseProjectItems(out) {
  try {
    const parsed = JSON.parse(out);
    return Array.isArray(parsed?.items) ? parsed.items : [];
  } catch {
    return [];
  }
}

// Ingesta mecánica del repo: snapshot del trabajo ya abierto (issues abiertas, PRs
// abiertas e items del Project). Es de SOLO LECTURA y resiliente: cada fuente que
// falla se degrada a [] y anota el motivo; nunca lanza salvo slug inválido (que
// decide el llamador). Así un repo "a medias" puede continuar de forma autónoma.
export async function readRepoInventory(state, { runGh = gh } = {}) {
  const slug = repoSlug(state); // lanza si el repo no es owner/name: intake lo captura
  const inv = {
    fetched_at: new Date().toISOString(),
    issues: [],
    prs: [],
    project: [],
    notes: "",
  };
  try {
    inv.issues = parseJsonArray(await runGh([
      "issue", "list", "--repo", slug, "--state", "open", "--limit", "200",
      "--json", "number,title,url,labels",
    ]));
  } catch (e) {
    inv.notes += `issue list: ${e.message}\n`;
  }
  try {
    inv.prs = parseJsonArray(await runGh([
      "pr", "list", "--repo", slug, "--state", "open", "--limit", "200",
      "--json", "number,title,url,labels,reviewDecision",
    ]));
  } catch (e) {
    inv.notes += `pr list: ${e.message}\n`;
  }
  if (state.project_id) {
    const owner = state.project_owner || slug.split("/")[0];
    try {
      inv.project = parseProjectItems(await runGh([
        "project", "item-list", String(state.project_id), "--owner", owner, "--format", "json",
      ]));
    } catch (e) {
      inv.notes += `project item-list: ${e.message}\n`;
    }
  }
  return inv;
}

// #27: los fallos de creacion se clasifican para que un error TRANSITORIO (rate
// limit, 5xx, red) no quede descartado para siempre solo porque los args no cambian.
// Transitorios: se reintentan hasta MAX_TRANSIENT_ATTEMPTS (el contador se resetea
// tras FAILURE_TTL_MS). Deterministas (auth, validacion): se siguen saltando mientras
// los args sean identicos, con el resultado visible en state.notes.
const TRANSIENT_ISSUE_ERROR = /rate limit|secondary rate|temporar|try again|timed[ _-]?out|timeout|\b5\d{2}\b|\b50[234]\b|ECONN|EAI_AGAIN|ENOTFOUND|EPROTO|EPIPE|socket hang up|fetch failed|aborted|network/i;
const MAX_TRANSIENT_ATTEMPTS = 3;
const FAILURE_TTL_MS = 24 * 60 * 60 * 1000;

export function isTransientIssueError(error) {
  const msg = error && typeof error === "object"
    ? `${error.message || ""}\n${error.stderr || ""}`
    : String(error || "");
  return TRANSIENT_ISSUE_ERROR.test(msg);
}

// Intentos efectivos de un registro previo: 0 si es de otra firma o si caduco el TTL.
function effectiveAttempts(rec, signature) {
  if (!rec || rec.signature !== signature) return 0;
  if (rec.last_at && Date.now() - Date.parse(rec.last_at) > FAILURE_TTL_MS) return 0;
  return rec.attempts || 0;
}

// Create issues from the draft JSON and add them to the GitHub Project (if set).
// Draft schema: { "issues": [ { id?, title, body, labels: [..], depends_on?: [refs], number? } ] }
// `id` es una referencia local al draft y `depends_on` acepta ese id, un número de
// issue (#12) o un título exacto; al terminar se normalizan a números reales y se
// calculan las olas de implementación con rebuildGraph (vease graph.mjs).
export async function createIssuesFromDraft(state, {
  dryRun = false,
  persistState = async () => {},
  runGh = gh,
} = {}) {
  const p = state.repo_path;
  const draftRaw = await readFile(
    `${p}/.software-factory/issues-draft.json`,
    "utf8",
  ).catch(() => '{"issues":[]}');
  const draft = JSON.parse(draftRaw);
const known = [...state.issues];
  const isKnown = (it) => known.some((k) => sameIssue(k, it));
  const pending = (draft.issues || []).filter((it) => it?.title && !isKnown(it));
  // Valida el slug antes de crear nada (también en dry-run): config inválida = fallo
  // accionable inmediato, nunca operación sobre el cwd del runner.
  if (pending.length > 0) repoSlug(state);
  const created = [];
  created.failures = [];
  state.issue_failures = state.issue_failures || {};
  const labelOk = new Map();
  const addNote = (m) => { state.notes = (state.notes || "") + `\n${m}`; };
  // Pre-crea cada label (idempotente con --force); si no se puede, se filtra con nota.
  const ensureLabel = async (name) => {
    if (labelOk.has(name)) return labelOk.get(name);
    let ok = false;
    if (typeof name === "string" && name && !name.startsWith("-")) {
      try {
        await runGh(["label", "create", name, "--repo", repoSlug(state), "--force",
          "--color", "ededed", "--description", "Created by Software Factory"]);
        ok = true;
      } catch (e) {
        addNote(`label "${name}" no se pudo crear; se omite: ${e.message}`);
      }
    } else {
      addNote(`label inválido omitido: ${JSON.stringify(name)}`);
    }
    labelOk.set(name, ok);
    return ok;
  };
  // Numeración ficticia continúa del mayor número ya presente en el state (real o
  // sembrada por pruebas) para no solaparse con issues existentes.
  let nextFakeNumber = state.issues.reduce((max, i) => Math.max(max, Number(i.number) || 0), 900);

  for (const it of draft.issues || []) {
      if (!it?.title || isKnown(it)) continue;
      // Deduplicación DENTRO de la invocación (dry y real): dos títulos iguales en el
      // mismo draft se procesan una sola vez, no solo contra lo ya persistido.
      known.push({ number: it.number, url: it.url, title: it.title });
      // Adopción de trabajo YA abierto: si el ítem del draft trae un `number` real, NO se
      // crea (existiría duplicado); se registra en state.issues para que `implement` lo
      // tome como tarea y se añada al Project. Así la fábrica continúa un repo "a medias".
      const adoptNum = Number(it.number);
      if (Number.isInteger(adoptNum) && adoptNum > 0) {
        const url = (typeof it.url === "string" && it.url) || `https://github.com/${repoSlug(state)}/issues/${adoptNum}`;
        if (dryRun) {
          created.push({ title: it.title, url, number: adoptNum, adopted: true, dry: true });
          continue;
        }
        state.issues.push({ title: it.title, url, number: adoptNum, adopted: true, at: new Date().toISOString() });
        await persistState();
        await logAndAdd(state, url, runGh);
        await persistState();
        created.push({ title: it.title, url, number: adoptNum, adopted: true });
        continue;
      }
      const wanted = Array.isArray(it.labels) ? it.labels : [];
      const usable = dryRun ? wanted : [];
      if (!dryRun) for (const l of wanted) if (await ensureLabel(l)) usable.push(l);
      const labels = usable.flatMap((l) => ["--label", l]);
    const args = [
      "issue", "create",
      "--repo", repoSlug(state),
      "--title", it.title,
      "--body", it.body || "",
      ...labels,
    ];
    if (dryRun) {
      // Los ficticios van SOLO al output (dry: true): si entraran en state.issues,
      // una ejecución real los omitiría por título y la fase implement crearía
      // work orders contra números de issue inexistentes.
      created.push({ title: it.title, url: "(dry-run)", number: ++nextFakeNumber, dry: true });
      continue;
    }
    // Un fallo determinista (o un transitorio ya agotado) con los mismos args no se
    // repite; un transitorio con intentos pendientes se reintenta en esta pasada (#27).
    const signature = JSON.stringify(args);
    const prev = state.issue_failures[it.title];
    if (prev && prev.signature === signature) {
      const attempts = effectiveAttempts(prev, signature);
      if (!prev.transient || attempts >= MAX_TRANSIENT_ATTEMPTS) {
        created.failures.push({
          title: it.title, error: prev.error, skipped: true,
          transient: !!prev.transient, attempts,
        });
        continue;
      }
    }
    let url;
    let number;
    try {
      url = await runGh(args);
      // Validar la salida ANTES de guardar: sin URL utilizable no se persiste nada.
      const match = /^https?:\/\/\S+\/issues\/(\d+)\/?$/i.exec(url);
      number = match ? Number(match[1]) : NaN;
      if (!Number.isFinite(number)) {
        throw new Error(`salida de gh issue create no utilizable para "${it.title}": ${JSON.stringify(String(url).slice(0, 200))}`);
      }
    } catch (e) {
      const transient = isTransientIssueError(e);
      const attempts = effectiveAttempts(state.issue_failures[it.title], signature) + 1;
      state.issue_failures[it.title] = {
        signature, error: e.message, transient, attempts,
        last_at: new Date().toISOString(),
      };
      created.failures.push({ title: it.title, error: e.message, transient, attempts });
      addNote(`issue create failed for "${it.title}" (${transient ? `transitorio, intento ${attempts}/${MAX_TRANSIENT_ATTEMPTS}` : "determinista"}): ${e.message}`);
      await persistState();
      continue;
    }
    delete state.issue_failures[it.title];
    created.push({ title: it.title, url, number });
    state.issues.push({
      title: it.title,
      url,
      number,
      at: new Date().toISOString(),
      draft_id: it.id ? String(it.id) : undefined,
      depends_on: Array.isArray(it.depends_on) ? it.depends_on.map(String) : [],
    });
    await persistState();
    await logAndAdd(state, url, runGh);
    await persistState();
  }
  // Normaliza depends_on a números reales y asigna waves. En dry-run el state es
  // una copia de trabajo que se descarta, así que no persistimos.
  const graph = rebuildGraph(state);
  if (graph.dropped.length) {
    for (const d of graph.dropped) {
      addNote(`dependencia descartada en #${d.issue}: ${JSON.stringify(d.ref)}${d.cycle ? " (ciclo roto)" : ""}`);
    }
    await persistState();
  }
  if (graph.changed && !dryRun) await persistState();
  created.graph = { waves: graph.waves, dropped: graph.dropped.length };
  return created;
}

async function logAndAdd(state, url, runGh = gh) {
  if (!state.project_id || !url || url === "(dry-run)") return;
  const num = url.split("/").pop();
  try {
    await runGh(projectItemAddArgs(state, url));
  } catch (e) {
    // Project add failures should not break the factory run; surface in note.
    state.notes = (state.notes || "") + `\nproject add failed for #${num}: ${e.message}`;
  }
}

// --- GitHub Project (kanban) board -------------------------------------------
// gh CLI no expone "crear con template" ni gestionar vistas, así que creamos un
// Project V2 normal (sus estados por defecto Backlog/Todo/In Progress/In Review/
// Done equivalen al template kanban), lo enlazamos al repo y lo guardamos en el
// state como project_id. Todo lo que falle aquí es blando: se anota, nunca rompe.
export async function createProjectBoard(state, { runGh = gh, persistState = async () => {} } = {}) {
  if (state.project_id) return { created: false, project_id: state.project_id, url: state.project_url || null };
  const owner = state.project_owner || state.repo?.split("/")[0];
  if (!owner || !OWNER_RE.test(owner)) throw new Error("No hay owner válido para crear el Project (define repo con sf.mjs init --repo owner/name)");
  const title = `Software Factory — ${state.repo || owner}`;
  const out = await runGh(["project", "create", "--owner", owner, "--title", title, "--format", "json"]);
  let data;
  try { data = JSON.parse(out); } catch { throw new Error(`salida de gh project create no utilizable: ${String(out).slice(0, 120)}`); }
  const number = Number(data?.number);
  if (!Number.isFinite(number)) throw new Error("gh project create no devolvió un número de Project válido");
  state.project_id = String(number);
  state.project_pvt_id = data.id || null;
  state.project_url = data.url || null;
  state.project_owner = owner;
  const failures = [];
  try {
    await runGh(["project", "link", state.project_id, "--owner", owner, "--repo", repoSlug(state)]);
  } catch (e) {
    failures.push(`link: ${e.message}`);
  }
  await persistState();
  return { created: true, project_id: state.project_id, url: state.project_url, title, failures };
}

// Opciones del campo Status de un Project V2 (equivalente al tablero kanban).
export const BOARD_STATUS_OPTIONS = ["Backlog", "Todo", "In Progress", "In Review", "Done"];

// Sincroniza el estado kanban de cada issue con el board. `edits` es una lista
// {url, status}; item-edit resuelve el item por URL y el campo por nombre, así
// que no necesitamos el pvt id del item. Los fallos se recogen, no lanzan.
export async function syncProjectStatuses(state, edits, { runGh = gh } = {}) {
  const owner = state.project_owner || state.repo?.split("/")[0];
  if (!state.project_id || !owner) return { updated: 0, failures: [{ error: "no hay project_id/owner; crea el board primero" }] };
  const wanted = new Set(BOARD_STATUS_OPTIONS);
  let updated = 0;
  const failures = [];
  for (const { url, status } of edits || []) {
    if (!url || url === "(dry-run)" || !wanted.has(status)) continue;
    try {
      await runGh([
        "project", "item-edit", state.project_id,
        "--owner", owner,
        "--url", url,
        "--field", "Status",
        "--value", status,
      ]);
      updated += 1;
    } catch (e) {
      failures.push({ url, status, error: e.message });
    }
  }
  return { updated, failures };
}
