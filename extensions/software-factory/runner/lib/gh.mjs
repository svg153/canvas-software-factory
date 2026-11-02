// gh CLI helpers for the mechanical "issues" phase.
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { readFile } from "node:fs/promises";

const run = promisify(execFile);

async function gh(args, opts = {}) {
  // execFile rechaza con exit code != 0 (stderr incluido en el error);
  // scannear stderr con /error|could not|failed/ falsaba con warnings legitimos de gh.
  const { stdout } = await run("gh", args, {
    windowsHide: true,
    maxBuffer: 16 * 1024 * 1024,
    ...opts,
  });
  return stdout.trim();
}

// Create issues from the draft JSON and add them to the GitHub Project (if set).
// Draft schema: { "issues": [ { title, body, labels: [..], number? } ] }
export async function createIssuesFromDraft(state, { dryRun = false } = {}) {
  const p = state.repo_path;
  const draftRaw = await readFile(
    `${p}/.software-factory/issues-draft.json`,
    "utf8",
  ).catch(() => '{"issues":[]}');
  const draft = JSON.parse(draftRaw);
  const existing = new Set(state.issues.map((i) => i.title));
  const created = [];

  // gh issue create exige owner/repo: con "." o vacío fallaría cada issue.
  if (!dryRun && !/^[^/]+\/[^/]+$/.test(state.repo || "")) {
    throw new Error(
      `state.repo="${state.repo}" no es owner/repo. Ejecuta: sf.mjs init <repo> --repo owner/name --force`,
    );
  }

  for (const it of draft.issues || []) {
    if (!it?.title || existing.has(it.title)) continue;
    const labels = (it.labels || []).flatMap((l) => ["--label", l]);
    const args = [
      "issue",
      "create",
      "--repo",
      state.repo,
      "--title",
      it.title,
      "--body",
      it.body || "",
      ...labels,
    ];
    if (dryRun) {
      // Los ficticios van SOLO al output: si entran en state.issues, la fase
      // implement crearía work orders contra números de issue inexistentes.
      created.push({
        title: it.title,
        url: "(dry-run)",
        number: 900 + created.length + 1,
        dry: true,
      });
      continue;
    }
    const url = await gh(args);
    const number = Number(url.split("/").pop());
    created.push({ title: it.title, url, number });
    state.issues.push({
      title: it.title,
      url,
      number,
      at: new Date().toISOString(),
    });
    await logAndAdd(state, url);
  }
  return created;
}

async function logAndAdd(state, url) {
  if (!state.project_id || !url || url === "(dry-run)") return;
  const owner = (state.repo || "").split("/")[0] || "@me";
  try {
    await gh([
      "project",
      "item-add",
      state.project_id,
      "--owner",
      owner,
      "--url",
      url,
    ]);
  } catch (e) {
    // Project add failures should not break the factory run; surface in note.
    state.notes =
      (state.notes || "") + `\nproject add failed for ${url}: ${e.message}`;
  }
}
