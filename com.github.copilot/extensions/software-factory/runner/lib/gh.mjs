// gh CLI helpers for the mechanical "issues" phase.
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { readFile } from "node:fs/promises";

const run = promisify(execFile);

async function gh(args) {
  // El criterio de error es SOLO el exit code: execFile rechaza si != 0 (stderr
  // incluido en el error). Scannear stderr con /error|could not|failed/ falsaba
  // con avisos legítimos de gh (p. ej. "warning: ... failed to check for updates").
  // SF_FAKE_GH permite pruebas e2e con un gh falso (script Node) sin tocar GitHub.
  const fake = process.env.SF_FAKE_GH;
  const [cmd, base] = fake ? [process.execPath, [fake]] : ["gh", []];
  const { stdout } = await run(cmd, [...base, ...args], {
    windowsHide: true,
    maxBuffer: 16 * 1024 * 1024,
  });
  return stdout.trim();
}

export function projectItemAddArgs(state, url) {
  const owner = state.project_owner || state.repo?.split("/")[0];
  if (!owner) throw new Error("Project owner is required to add an issue to a project");
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
  const existing = new Set(state.issues.map((i) => i.title));
  const pending = (draft.issues || []).filter((it) => it?.title && !existing.has(it.title));
  // Valida el slug antes de crear nada (también en dry-run): config inválida = fallo
  // accionable inmediato, nunca operación sobre el cwd del runner.
  if (pending.length > 0) repoSlug(state);
  const created = [];
  // Numeración ficticia continúa del mayor número ya presente en el state (real o
  // sembrada por pruebas) para no solaparse con issues existentes.
  let nextFakeNumber = state.issues.reduce((max, i) => Math.max(max, Number(i.number) || 0), 900);

  for (const it of draft.issues || []) {
    if (!it?.title || existing.has(it.title)) continue;
    const labels = (it.labels || []).flatMap((l) => ["--label", l]);
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
    const url = await runGh(args);
    // Validar la salida ANTES de guardar: sin URL utilizable no se persiste nada.
    const match = /^https?:\/\/\S+\/issues\/(\d+)\/?$/i.exec(url);
    const number = match ? Number(match[1]) : NaN;
    if (!Number.isFinite(number)) {
      throw new Error(`salida de gh issue create no utilizable para "${it.title}": ${JSON.stringify(url.slice(0, 200))}`);
    }
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
