import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import test from "node:test";

import { createFactoryServer } from "../lib/http.mjs";
import { createIssuesFromDraft, projectItemAddArgs } from "../lib/gh.mjs";
import { initRunnerArgs } from "../lib/actions.mjs";
import { unclaimedIssues } from "../lib/state.mjs";
import { createInitPayload, renderState, routeWithRepo } from "../../ui.mjs";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../../../../");
const extensionDir = join(repoRoot, "extensions", "software-factory");

test("builds the supported gh project item-add arguments", () => {
  assert.deepEqual(
    projectItemAddArgs({ project_id: "17", project_owner: "project-org" }, "https://github.com/repo-org/app/issues/9"),
    [
      "project", "item-add", "17",
      "--owner", "project-org",
      "--url", "https://github.com/repo-org/app/issues/9",
    ],
  );
  assert.deepEqual(
    projectItemAddArgs({ project_id: "17", repo: "repo-org/app" }, "https://github.com/repo-org/app/issues/9"),
    [
      "project", "item-add", "17",
      "--owner", "repo-org",
      "--url", "https://github.com/repo-org/app/issues/9",
    ],
  );
  assert.throws(() => projectItemAddArgs({ project_id: "17" }, "https://github.com/org/repo/issues/9"));
});

test("uses one selected repository for state, SSE, and action routes", async (t) => {
  const selectedRepo = "C:\\repos\\target & one";
  const accesses = [];
  const watches = [];
  let subscription;
  const server = createFactoryServer({
    extensionDir,
    defaultRepo: () => "C:\\session\\workspace",
    readState: async (repo) => {
      accesses.push(repo);
      return { repo, status: "running" };
    },
    ensureWatch: (repo) => watches.push(repo),
    applyAction: async (repo, actionName, input) => {
      accesses.push(repo);
      return { repo, actionName, input };
    },
    subscribe: (repo) => { subscription = repo; },
  });
  await new Promise((resolveListen) => server.listen(0, "127.0.0.1", resolveListen));
  t.after(() => new Promise((resolveClose, reject) => {
    server.close((error) => error ? reject(error) : resolveClose());
  }));
  const address = server.address();
  const baseUrl = `http://127.0.0.1:${address.port}`;

  const stateResponse = await fetch(`${baseUrl}${routeWithRepo("/state", selectedRepo)}`);
  assert.equal((await stateResponse.json()).repo, selectedRepo);

  const eventsResponse = await fetch(`${baseUrl}${routeWithRepo("/events", selectedRepo)}`);
  const reader = eventsResponse.body.getReader();
  const firstEvent = await reader.read();
  assert.match(new TextDecoder().decode(firstEvent.value), /"repo":"C:\\\\repos\\\\target & one"/);
  assert.equal(subscription, selectedRepo);
  await reader.cancel();

  const actionResponse = await fetch(`${baseUrl}${routeWithRepo("/action", selectedRepo)}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ actionName: "pause", input: {} }),
  });
  const action = await actionResponse.json();
  assert.equal(action.repo, selectedRepo);
  assert.deepEqual(accesses, [selectedRepo, selectedRepo, selectedRepo]);
  assert.deepEqual(watches, [selectedRepo, selectedRepo]);

  assert.equal(routeWithRepo("/state", selectedRepo), `/state?repo=${encodeURIComponent(selectedRepo)}`);
  assert.equal(routeWithRepo("/events", selectedRepo), `/events?repo=${encodeURIComponent(selectedRepo)}`);
  assert.equal(routeWithRepo("/action", selectedRepo), `/action?repo=${encodeURIComponent(selectedRepo)}`);
});

test("passes the form Project owner through the action route to runner arguments", async (t) => {
  const formPayload = createInitPayload({
    repo: "repo-org/app",
    project: "17",
    projectOwner: "project-org",
    rounds: 4,
  });
  assert.deepEqual(formPayload, {
    repo: "repo-org/app",
    project: "17",
    project_owner: "project-org",
    rounds: 4,
  });

  const server = createFactoryServer({
    extensionDir,
    defaultRepo: () => "C:\\session\\workspace",
    readState: async () => null,
    ensureWatch() {},
    applyAction: async (repoDir, actionName, input) => ({
      actionName,
      args: initRunnerArgs(repoDir, input),
    }),
    subscribe() {},
  });
  await new Promise((resolveListen) => server.listen(0, "127.0.0.1", resolveListen));
  t.after(() => new Promise((resolveClose, reject) => {
    server.close((error) => error ? reject(error) : resolveClose());
  }));
  const response = await fetch(`http://127.0.0.1:${server.address().port}/action`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ actionName: "init", input: formPayload }),
  });
  const result = await response.json();
  assert.equal(result.actionName, "init");
  assert.deepEqual(result.args, [
    "init", "C:\\session\\workspace",
    "--repo", "repo-org/app",
    "--project", "17",
    "--project-owner", "project-org",
    "--rounds", "4",
  ]);
});

test("does not re-emit issue implementations across rounds or legacy task shapes", () => {
  const existingIssue = { number: 12, title: "Existing issue" };
  const newIssue = { number: 13, title: "New issue" };
  const state = {
    round: 2,
    tasks: [
      { round: 1, phase: "implement", issue: existingIssue },
      { round: 1, phase: "implement", meta: { issue: { number: 11 } } },
      { round: 2, phase: "discover", issue: { number: 99 } },
    ],
    issues: [existingIssue, { number: 11 }, newIssue],
  };
  assert.deepEqual(unclaimedIssues(state), [newIssue]);
});

test("persists created issues before a later failure so retry skips them", async (t) => {
  const tempDir = await mkdtemp(join(tmpdir(), "sf-issue-retry-"));
  t.after(() => rm(tempDir, { recursive: true, force: true }));
  const softwareFactoryDir = join(tempDir, ".software-factory");
  await mkdir(softwareFactoryDir);
  await writeFile(join(softwareFactoryDir, "issues-draft.json"), JSON.stringify({
    issues: [{ title: "First" }, { title: "Second" }],
  }));

  const state = { repo_path: tempDir, repo: "org/repo", project_id: "", issues: [] };
  let persistedIssues = [];
  let failSecond = true;
  const simulatedGh = async (args) => {
    assert.equal(args[0], "issue");
    const title = args[args.indexOf("--title") + 1];
    if (title === "Second" && failSecond) {
      failSecond = false;
      throw new Error("simulated gh create failure");
    }
    return `https://github.com/org/repo/issues/${title === "First" ? 1 : 2}`;
  };
  const persist = async () => {
    persistedIssues = state.issues.map((issue) => ({ ...issue }));
  };

  await assert.rejects(
    createIssuesFromDraft(state, { runGh: simulatedGh, persistState: persist }),
    /simulated gh create failure/,
  );
  assert.deepEqual(persistedIssues.map((issue) => issue.title), ["First"]);

  state.issues = persistedIssues;
  const retriedTitles = [];
  const retryGh = async (args) => {
    const title = args[args.indexOf("--title") + 1];
    retriedTitles.push(title);
    return `https://github.com/org/repo/issues/${title === "First" ? 1 : 2}`;
  };
  const created = await createIssuesFromDraft(state, {
    runGh: retryGh,
    persistState: persist,
  });
  assert.deepEqual(retriedTitles, ["Second"]);
  assert.deepEqual(created.map((issue) => issue.title), ["Second"]);
  assert.deepEqual(state.issues.map((issue) => issue.title), ["First", "Second"]);
});

class FakeElement {
  constructor(tagName) {
    this.tagName = tagName;
    this.children = [];
    this._text = "";
    this.className = "";
  }

  set textContent(value) {
    this._text = String(value);
    this.children = [];
  }

  get textContent() {
    return this._text + this.children.map((child) => child.textContent).join("");
  }

  appendChild(child) {
    this.children.push(child);
    return child;
  }

  replaceChildren(...children) {
    this.children = children;
    this._text = "";
  }
}

class FakeDocument {
  constructor(ids) {
    this.elements = new Map(ids.map((id) => [id, new FakeElement("div")]));
  }

  getElementById(id) {
    return this.elements.get(id);
  }

  createElement(tagName) {
    return new FakeElement(tagName);
  }
}

test("renders untrusted task and issue content as text and rejects script URLs", () => {
  const doc = new FakeDocument(["status", "round", "pipeline", "tasks", "issues"]);
  const taskTitle = '<img src=x onerror="alert(1)">';
  const issueTitle = '<script>alert("xss")</script>';
  renderState({
    status: "running",
    round: 1,
    max_rounds: 3,
    phase: "discover",
    tasks: [{ phase: "discover", status: '<svg onload="alert(1)">', title: taskTitle, id: "<b>id</b>" }],
    issues: [{ number: 9, title: issueTitle, url: "javascript:alert(1)" }],
  }, doc);

  const taskTitleElement = doc.getElementById("tasks").children[0].children[1];
  assert.equal(taskTitleElement.textContent, taskTitle);
  assert.equal(taskTitleElement.children.length, 0);
  assert.equal(doc.getElementById("tasks").children[0].children[0].className, "dot pending");

  const issueElement = doc.getElementById("issues").children[0].children[0];
  assert.equal(issueElement.tagName, "span");
  assert.equal(issueElement.textContent, `#9 ${issueTitle}`);
  assert.equal(issueElement.children.length, 0);
});

test("documents and installer point to the checked-out repository layout", async () => {
  const [readme, pluginManifest, canvasManifest, installer] = await Promise.all([
    readFile(join(repoRoot, "README.md"), "utf8"),
    readFile(join(repoRoot, "plugin.json"), "utf8").then(JSON.parse),
    readFile(join(extensionDir, "canvas.json"), "utf8").then(JSON.parse),
    readFile(join(repoRoot, "install.ps1"), "utf8"),
  ]);
  assert.match(readme, /git clone https:\/\/github\.com\/svg153\/canvas-software-factory\.git/);
  assert.match(readme, /cd canvas-software-factory/);
  assert.match(readme, /\.\\install\.ps1/);
  assert.equal(pluginManifest.repository, "https://github.com/svg153/canvas-software-factory");
  assert.equal(canvasManifest.id, "software-factory");
  assert.equal(canvasManifest.main, "extension.mjs");
  assert.match(installer, /extensions\\software-factory/);
  assert.match(installer, /skills\\software-factory/);
});
