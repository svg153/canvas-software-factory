// Unit tests del grafo de dependencias (runner/lib/graph.mjs): resolución de refs,
// capa de olas (Kahn con rotura determinista de ciclos), gating claimable/blocked
// y derivación del tablero kanban.
import test from "node:test";
import assert from "node:assert/strict";

import {
  resolveDepRef,
  rebuildGraph,
  latestImplementTask,
  depSatisfied,
  claimableIssues,
  blockedIssues,
  issueColumn,
  deriveBoard,
} from "../lib/graph.mjs";

function index(issues) {
  const byDraftId = new Map();
  const numbers = new Map();
  const byTitle = new Map();
  for (const it of issues) {
    numbers.set(Number(it.number), it);
    if (it.draft_id) byDraftId.set(String(it.draft_id), Number(it.number));
    const t = String(it.title ?? "").normalize("NFKC").toLowerCase().replace(/\s+/g, " ").trim();
    if (t && !byTitle.has(t)) byTitle.set(t, Number(it.number));
  }
  return { byDraftId, numbers, byTitle };
}

test("resolveDepRef acepta draft id, número, #n y título exacto", () => {
  const issues = [
    { number: 12, draft_id: "w1-auth", title: "Add  Auth  module" },
    { number: 13, title: "Docs" },
  ];
  const ix = index(issues);
  assert.equal(resolveDepRef("w1-auth", ix), 12);
  assert.equal(resolveDepRef(13, ix), 13);
  assert.equal(resolveDepRef("#12", ix), 12);
  assert.equal(resolveDepRef("12", ix), 12);
  assert.equal(resolveDepRef("add auth module", ix), 12); // normTitle tolera espacios
  assert.equal(resolveDepRef("no existe", ix), null);
  assert.equal(resolveDepRef(999, ix), null);
  assert.equal(resolveDepRef(null, ix), null);
  assert.equal(resolveDepRef("", ix), null);
});

test("rebuildGraph normaliza depends_on a números y calcula olas (diamante)", () => {
  const state = {
    issues: [
      { number: 1, draft_id: "a", title: "A", depends_on: [] },
      { number: 2, draft_id: "b", title: "B", depends_on: ["a"] },
      { number: 3, draft_id: "c", title: "C", depends_on: ["#2"] },
      { number: 4, draft_id: "d", title: "D", depends_on: [2, "c"] },
    ],
    tasks: [],
  };
  const { waves, dropped } = rebuildGraph(state);
  assert.deepEqual(dropped, []);
  assert.equal(waves, 4);
  const [a, b, c, d] = state.issues;
  assert.equal(a.wave, 0);
  assert.deepEqual(b.depends_on, [1]);
  assert.equal(b.wave, 1);
  assert.deepEqual(c.depends_on, [2]);
  assert.equal(c.wave, 2);
  assert.deepEqual(d.depends_on, [2, 3]); // orden ascendente determinista
  assert.equal(d.wave, 3);
});

test("rebuildGraph descarta refs desconocidas y autoreferencias con nota", () => {
  const state = {
    issues: [
      { number: 5, title: "E", depends_on: ["fantasma", 5, "#9"] },
      { number: 6, title: "F", depends_on: [] },
    ],
    tasks: [],
  };
  const { dropped, waves } = rebuildGraph(state);
  assert.equal(waves, 1);
  assert.deepEqual(dropped.map((x) => x.ref).sort(), ["#9", "5", "fantasma"]);
  assert.deepEqual(state.issues[0].depends_on, []);
  assert.equal(state.issues[0].wave, 0);
});

test("rebuildGraph rompe ciclos de forma determinista y los reporta", () => {
  const state = {
    issues: [
      { number: 1, title: "A", depends_on: [2] },
      { number: 2, title: "B", depends_on: [1] },
    ],
    tasks: [],
  };
  const { dropped, waves } = rebuildGraph(state);
  assert.equal(waves, 2);
  assert.equal(dropped.length, 1);
  assert.equal(dropped[0].cycle, true);
  assert.equal(dropped[0].issue, 1);
  assert.equal(dropped[0].ref, "#2");
  assert.equal(state.issues[0].wave, 0); // se rompió la arista 1→2: #1 queda en ola 0
  assert.equal(state.issues[1].wave, 1);
});

test("claimableIssues/blockedIssues gatean por olas según el estado de tareas", () => {
  const base = () => ({
    issues: [
      { number: 1, title: "A", wave: 0, depends_on: [] },
      { number: 2, title: "B", wave: 1, depends_on: [1] },
      { number: 3, title: "C", wave: 2, depends_on: [2] },
    ],
    tasks: [],
  });
  const s0 = base();
  assert.deepEqual(claimableIssues(s0).map((i) => i.number), [1]);
  assert.deepEqual(blockedIssues(s0).map((i) => i.number), [2, 3]);

  s0.tasks.push({ phase: "implement", issue: { number: 1 }, status: "done" });
  assert.deepEqual(claimableIssues(s0).map((i) => i.number), [2]);
  assert.deepEqual(blockedIssues(s0).map((i) => i.number), [3]);

  // dependencia fallida → sigue bloqueada (historial de fallos no satisface)
  const sf = base();
  sf.tasks.push({ phase: "implement", issue: { number: 1 }, status: "failed" });
  assert.deepEqual(claimableIssues(sf).map((i) => i.number), [1]); // 1 es re-reclamable
  assert.deepEqual(blockedIssues(sf).map((i) => i.number), [2, 3]);

  // tarea viva (awaiting_agent) excluye del claimable pero no bloquea a los demás
  const sa = base();
  sa.tasks.push({ phase: "implement", issue: { number: 1 }, status: "awaiting_agent" });
  assert.deepEqual(claimableIssues(sa).map((i) => i.number), []);
  assert.deepEqual(blockedIssues(sa).map((i) => i.number), [2, 3]);
});

test("dependencias fuera del run no bloquean (issue ya existente/cerrada)", () => {
  const state = {
    issues: [{ number: 7, title: "G", wave: 0, depends_on: [99] }],
    tasks: [],
  };
  assert.equal(depSatisfied(state, 99), true);
  assert.deepEqual(claimableIssues(state).map((i) => i.number), [7]);
});

test("latestImplementTask devuelve la última tarea implement de la issue", () => {
  const state = {
    issues: [],
    tasks: [
      { phase: "implement", issue: { number: 1 }, status: "failed" },
      { phase: "plan", issue: { number: 1 }, status: "done" },
      { phase: "implement", meta: { issue: { number: 1 } }, status: "done" },
    ],
  };
  assert.equal(latestImplementTask(state, 1)?.status, "done");
  assert.equal(latestImplementTask(state, 2), null);
});

test("deriveBoard: columnas kanban derivadas del estado + closedNumbers", () => {
  const state = {
    issues: [
      { number: 1, title: "A", wave: 0, depends_on: [], url: "https://github.com/o/r/issues/1" },
      { number: 2, title: "B", wave: 1, depends_on: [1] },
      { number: 3, title: "C", wave: 1, depends_on: [1] },
      { number: 4, title: "D", wave: 2, depends_on: [3] },
    ],
    tasks: [
      { phase: "implement", issue: { number: 1 }, status: "done" },
      { phase: "implement", issue: { number: 2 }, status: "awaiting_agent" },
    ],
  };
  const board = deriveBoard(state, null);
  const col = (k) => board.columns.find((c) => c.key === k).cards.map((i) => i.number);
  assert.deepEqual(col("backlog"), [4]); // dep #3 sin terminar
  assert.deepEqual(col("ready"), [3]); // dep #1 done
  assert.deepEqual(col("in_progress"), [2]);
  assert.deepEqual(col("in_review"), [1]); // PR abierto; el merge es humano
  assert.deepEqual(col("done"), []);
  assert.deepEqual(deriveBoard(state, new Set([1])).columns.find((c) => c.key === "done").cards.map((i) => i.number), [1]);
  assert.equal(issueColumn(state, state.issues[0], new Set([1])), "done");
});
