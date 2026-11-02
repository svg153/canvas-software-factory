// gh CLI helpers for the mechanical "issues" phase.
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { readFile } from "node:fs/promises";

const run = promisify(execFile);

async function gh(args, opts = {}) {
  const { stdout, stderr } = await run("gh", args, { windowsHide: true, ...opts });
  if (stderr && /error|could not|failed/i.test(stderr)) {
    throw new Error(`gh ${args[0]}: ${stderr.trim()}`);
  }
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
  const created = [];

  for (const it of draft.issues || []) {
    if (!it?.title || existing.has(it.title)) continue;
    const labels = (it.labels || []).flatMap((l) => ["--label", l]);
    const args = [
      "issue", "create",
      "--repo", state.repo || ".",
      "--title", it.title,
      "--body", it.body || "",
      ...labels,
    ];
    if (dryRun) {
      const fake = { title: it.title, url: "(dry-run)", number: 900 + created.length + 1 };
      created.push(fake);
      state.issues.push({ ...fake, at: new Date().toISOString() });
      continue;
    }
    const url = await runGh(args);
    const number = Number(url.split("/").pop());
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
