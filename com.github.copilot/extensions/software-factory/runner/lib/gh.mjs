// gh CLI helpers for the mechanical "issues" phase.
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { readFile } from "node:fs/promises";
import { sameIssue } from "./state.mjs";

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

export function projectsV2Args(slug) {
  if (typeof slug !== "string" || !REPO_RE.test(slug) || slug.split("/")[1].startsWith("-")) {
    throw new Error(`slug de repo inválido: ${JSON.stringify(slug)}`);
  }
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

// Create issues from the draft JSON and add them to the GitHub Project (if set).
// Draft schema: { "issues": [ { title, body, labels: [..], number? } ] }
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
    // Un fallo determinista idéntico (mismos args) no se repite en re-runs.
    const signature = JSON.stringify(args);
    const prev = state.issue_failures[it.title];
    if (prev && prev.signature === signature) {
      created.failures.push({ title: it.title, error: prev.error, skipped: true });
      continue;
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
      state.issue_failures[it.title] = { signature, error: e.message };
      created.failures.push({ title: it.title, error: e.message });
      addNote(`issue create failed for "${it.title}": ${e.message}`);
      await persistState();
      continue;
    }
    delete state.issue_failures[it.title];
    created.push({ title: it.title, url, number });
    state.issues.push({ title: it.title, url, number, at: new Date().toISOString() });
    await persistState();
    await logAndAdd(state, url, runGh);
    await persistState();
  }
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
