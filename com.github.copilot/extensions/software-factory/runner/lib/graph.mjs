// Software Factory runner — dependency graph over state.issues.
// Pure functions (no fs, no gh): the mechanical "issues" phase fills depends_on,
// implement waves are computed here, and the implement phase gates on them so the
// factory never implements everything at once (merge-conflict trains).
import { normTitle, unclaimedIssues } from "./state.mjs";

// Refs allowed in draft depends_on: draft id ("d1"), issue number (12 or "#12"),
// or exact draft title. Anything else is an unknown ref and gets dropped (with a
// note) rather than silently blocking the wave forever.
export function resolveDepRef(ref, { byDraftId, numbers, byTitle }) {
  if (ref === null || ref === undefined) return null;
  if (typeof ref === "number" && Number.isFinite(ref)) {
    const n = Math.trunc(ref);
    return numbers.has(n) ? n : null;
  }
  const s = String(ref).trim();
  if (!s) return null;
  if (byDraftId.has(s)) return byDraftId.get(s);
  const m = /^#?(\d+)$/.exec(s);
  if (m) {
    const n = Number(m[1]);
    return numbers.has(n) ? n : null;
  }
  const t = normTitle(s);
  return byTitle.has(t) ? byTitle.get(t) : null;
}

// Rebuilds depends_on (normalized to real numbers) + wave per issue, in place.
// wave = 1 + max(wave of deps) (Kahn longest-path layering). Cycles are broken
// deterministically: the edge pointing to the highest-numbered node of the cycle
// is dropped and reported. Unknown/self refs are dropped and reported.
// Returns { waves, dropped, changed }.
export function rebuildGraph(state) {
  const issues = Array.isArray(state.issues) ? state.issues : [];
  const numbers = new Map();
  const byDraftId = new Map();
  const byTitle = new Map();
  for (const it of issues) {
    const n = Number(it.number);
    if (!Number.isFinite(n)) continue;
    numbers.set(n, it);
    if (it.draft_id) byDraftId.set(String(it.draft_id), n);
    const t = normTitle(it.title);
    if (t && !byTitle.has(t)) byTitle.set(t, n);
  }
  const dropped = [];
  const edges = new Map(); // number -> Set(numbers)
  for (const it of issues) {
    const n = Number(it.number);
    if (!Number.isFinite(n)) continue;
    const deps = new Set();
    for (const raw of Array.isArray(it.depends_on) ? it.depends_on : []) {
      const d = resolveDepRef(raw, { byDraftId, numbers, byTitle });
      if (d === null || d === n) { dropped.push({ issue: n, ref: String(raw ?? "") }); continue; }
      if (deps.has(d)) continue;
      deps.add(d);
    }
    edges.set(n, deps);
  }
  // Kahn layering with deterministic cycle breaking.
  const wave = new Map();
  let progress = true;
  while (progress) {
    progress = false;
    for (const [n, deps] of edges) {
      if (wave.has(n)) continue;
      let w = 0;
      let ready = true;
      for (const d of deps) {
        if (!wave.has(d)) { ready = false; break; }
        w = Math.max(w, wave.get(d) + 1);
      }
      if (ready) { wave.set(n, w); progress = true; }
    }
    if (!progress && edges.size > wave.size) {
      // Remaining nodes form (or feed) cycles: drop the edge into the highest
      // numbered unresolved dep of the lowest unresolved node, then keep going.
      const stuck = [...edges.keys()].filter((n) => !wave.has(n)).sort((a, b) => a - b);
      const node = stuck[0];
      const badDep = [...edges.get(node)].filter((d) => !stuck.includes(d) || d > node).sort((a, b) => b - a)[0]
        ?? [...edges.get(node)].sort((a, b) => b - a)[0];
      edges.get(node).delete(badDep);
      dropped.push({ issue: node, ref: `#${badDep}`, cycle: true });
      progress = true;
    }
  }
  let changed = false;
  let waves = 0;
  for (const it of issues) {
    const n = Number(it.number);
    const w = Number.isFinite(n) && wave.has(n) ? wave.get(n) : 0;
    const deps = Number.isFinite(n) && edges.has(n) ? [...edges.get(n)].sort((a, b) => a - b) : [];
    waves = Math.max(waves, w + 1);
    if (it.wave !== w || JSON.stringify(it.depends_on ?? []) !== JSON.stringify(deps)) {
      it.wave = w;
      it.depends_on = deps;
      changed = true;
    }
  }
  return { waves, dropped, changed };
}

// Latest implement task for an issue number (done/failed/pending alike).
export function latestImplementTask(state, number) {
  let latest = null;
  for (const t of state.tasks || []) {
    if (t.phase !== "implement") continue;
    const n = t.issue?.number || t.meta?.issue?.number;
    if (Number(n) === Number(number)) latest = t;
  }
  return latest;
}

// A dependency counts as satisfied when its implement task finished done, or when
// it is not part of this run's graph (e.g. an issue closed outside the factory).
export function depSatisfied(state, depNumber) {
  const issue = (state.issues || []).find((i) => Number(i.number) === Number(depNumber));
  if (!issue) return true;
  const task = latestImplementTask(state, depNumber);
  return task?.status === "done";
}

export function depsSatisfied(state, issue) {
  return (issue.depends_on || []).every((d) => depSatisfied(state, d));
}

// Issues ready to be claimed right now: no live implement task AND every dependency
// already implemented. Sorted by wave (top-down order) then number for determinism.
export function claimableIssues(state) {
  return unclaimedIssues(state)
    .filter((i) => depsSatisfied(state, i))
    .sort((a, b) => (a.wave ?? 0) - (b.wave ?? 0) || a.number - b.number);
}

// Unclaimed issues waiting on dependencies whose implement task did not finish done.
export function blockedIssues(state) {
  return unclaimedIssues(state)
    .filter((i) => !depsSatisfied(state, i))
    .sort((a, b) => (a.wave ?? 0) - (b.wave ?? 0) || a.number - b.number);
}

// Kanban columns derived from state (same derivation the canvas shows, and the
// GitHub Project sync uses). closedNumbers: optional Set of issue numbers known
// closed in GitHub.
export const BOARD_COLUMNS = [
  { key: "backlog", label: "Backlog" },
  { key: "ready", label: "Ready" },
  { key: "in_progress", label: "In Progress" },
  { key: "in_review", label: "In Review" },
  { key: "done", label: "Done" },
];

export function issueColumn(state, issue, closedNumbers) {
  const n = Number(issue.number);
  if (closedNumbers?.has(n)) return "done";
  const task = latestImplementTask(state, n);
  if (task) {
    if (task.status === "done") return "in_review"; // PR opened by the work order; merge is human
    if (task.status === "awaiting_agent" || task.status === "pending") return "in_progress";
    // failed: re-claimable, back to the queue
  }
  return depsSatisfied(state, issue) ? "ready" : "backlog";
}

export function deriveBoard(state, closedNumbers) {
  const buckets = new Map(BOARD_COLUMNS.map((c) => [c.key, []]));
  for (const issue of state?.issues || []) {
    if (!Number.isFinite(Number(issue.number))) continue;
    buckets.get(issueColumn(state, issue, closedNumbers)).push({
      number: Number(issue.number),
      title: String(issue.title ?? ""),
      url: String(issue.url ?? ""),
      wave: Number(issue.wave ?? 0),
      depends_on: Array.isArray(issue.depends_on) ? issue.depends_on : [],
    });
  }
  for (const list of buckets.values()) list.sort((a, b) => a.wave - b.wave || a.number - b.number);
  return { columns: BOARD_COLUMNS.map((c) => ({ ...c, cards: buckets.get(c.key) })) };
}
