// Tests de #90: visibilidad del estado real de GitHub (issues/PRs abiertos) y
// vinculación de issues abiertas al run para no duplicarlas.
import test from "node:test";
import assert from "node:assert/strict";

import {
  openIssuesArgs,
  openPullsArgs,
  parseIssueList,
  parsePullList,
  getGithubStatus,
  importOpenIssues,
} from "../lib/gh.mjs";

test("openIssuesArgs/openPullsArgs construyen los comandos list y validan el slug", () => {
  const i = openIssuesArgs("o/r");
  assert.deepEqual(i.slice(0, 4), ["issue", "list", "--repo", "o/r"]);
  assert.ok(i.includes("--state") && i.includes("open"));
  assert.ok(i.includes("--json"));
  const p = openPullsArgs("o/r");
  assert.deepEqual(p.slice(0, 4), ["pr", "list", "--repo", "o/r"]);
  assert.ok(p.some((a) => a.includes("statusCheckRollup")));
  for (const fn of [openIssuesArgs, openPullsArgs]) {
    assert.throws(() => fn("bad slug"), /inválido/);
    assert.throws(() => fn("o/-r"), /inválido/);
    assert.throws(() => fn(null), /inválido/);
  }
});

test("parseIssueList mapea labels y descarta basura sin lanzar", () => {
  const stdout = JSON.stringify([
    { number: 5, title: "Algo", url: "https://github.com/o/r/issues/5", labels: [{ name: "bug" }, { name: "" }, null] },
    { number: "6", title: "Otro", url: "", labels: null },
    { title: "sin número" },
    null,
  ]);
  assert.deepEqual(parseIssueList(stdout), [
    { number: 5, title: "Algo", url: "https://github.com/o/r/issues/5", labels: ["bug"] },
    { number: 6, title: "Otro", url: "", labels: [] },
  ]);
  assert.deepEqual(parseIssueList("no json"), []);
  assert.deepEqual(parseIssueList("{}"), []);
});

test("parsePullList simplifica checks: fail > pending > pass, vacío = none", () => {
  const mk = (rollup) => JSON.stringify([{ number: 1, title: "t", url: "u", isDraft: false, mergeable: "MERGEABLE", headRefName: "b", statusCheckRollup: rollup }]);
  assert.equal(parsePullList(mk([{ state: "SUCCESS" }, { state: "FAILURE" }]))[0].checks, "fail");
  assert.equal(parsePullList(mk([{ state: "SUCCESS" }, { status: "IN_PROGRESS" }]))[0].checks, "pending");
  assert.equal(parsePullList(mk([{ state: "SUCCESS" }, { state: "SKIPPED" }]))[0].checks, "pass");
  assert.equal(parsePullList(mk([]))[0].checks, "none");
  assert.equal(parsePullList(mk(null))[0].checks, "none");
  const one = parsePullList(mk([{ state: "SUCCESS" }]))[0];
  assert.deepEqual(one, { number: 1, title: "t", url: "u", isDraft: false, mergeable: "MERGEABLE", head: "b", checks: "pass" });
  assert.deepEqual(parsePullList("basura"), []);
});

test("getGithubStatus es blando: un fallo parcial no vacía la otra lista", async () => {
  const runGh = async (args) => {
    if (args[0] === "issue") return JSON.stringify([{ number: 1, title: "a", url: "u", labels: [] }]);
    return JSON.stringify([{ number: 2, title: "p", url: "v", isDraft: true, mergeable: "CONFLICTING", headRefName: "x", statusCheckRollup: [] }]);
  };
  const ok = await getGithubStatus("o/r", { runGh });
  assert.equal(ok.note, "");
  assert.equal(ok.issues.length, 1);
  assert.equal(ok.pulls[0].isDraft, true);

  const partial = await getGithubStatus("o/r", {
    runGh: async (args) => {
      if (args[0] === "issue") throw new Error("gh exited 4: bad auth");
      return "[]";
    },
  });
  assert.deepEqual(partial.issues, []);
  assert.deepEqual(partial.pulls, []);
  assert.match(partial.note, /issues: .*bad auth/);
});

test("importOpenIssues vincula abiertas sin duplicar y persiste solo si hay novedades", async () => {
  let saves = 0;
  const state = {
    repo: "o/r",
    issues: [
      { number: 5, title: "Ya conocida", url: "https://github.com/o/r/issues/5" },
      { title: "Mismo título", url: "", number: 0 },
    ],
  };
  const runGh = async () => JSON.stringify([
    { number: 5, title: "Ya conocida", url: "https://github.com/o/r/issues/5", labels: [] },
    { number: 9, title: "Nueva", url: "https://github.com/o/r/issues/9", labels: [] },
    { number: 0, title: "Mismo título", url: "", labels: [] },
  ]);
  const out = await importOpenIssues(state, { runGh, persistState: async () => { saves += 1; } });
  assert.deepEqual(out, { imported: 1, open: 3 });
  assert.equal(state.issues.length, 3);
  assert.equal(state.issues.at(-1).number, 9);
  assert.equal(state.issues.at(-1).imported, true);
  assert.equal(saves, 1);

  // Sin novedades: no escribe.
  const again = await importOpenIssues(state, { runGh, persistState: async () => { saves += 1; } });
  assert.deepEqual(again, { imported: 0, open: 3 });
  assert.equal(saves, 1);

  // Slug inválido: rechaza (el action lo traduce a mensaje fijo).
  await assert.rejects(
    importOpenIssues({ repo: "no-es-slug", issues: [] }, { runGh }),
    /repo GitHub válido/,
  );
});
