import assert from "node:assert/strict";
import { exec, execFile } from "node:child_process";
import { mkdtemp, mkdir, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath, pathToFileURL } from "node:url";
import test from "node:test";
import { promisify } from "node:util";
import { request as httpRequest } from "node:http";

import { createFactoryServer } from "../lib/http.mjs";
import { createRepoAllowlist } from "../lib/allowlist.mjs";
import { symlink } from "node:fs/promises";
import { createIssuesFromDraft, projectItemAddArgs, repoSlug } from "../lib/gh.mjs";
import { initRunnerArgs, startGuardError } from "../lib/actions.mjs";
import { unclaimedIssues, failedTasks, loadState, saveState } from "../lib/state.mjs";
import { bootstrapPrompt, discoverPrompt, grillPrompt, planPrompt } from "../lib/prompts.mjs";
import { createInitPayload, renderState, routeWithRepo } from "../../ui.mjs";
import { buildCanvasManifest } from "../../../../../tools/make-canvas-manifest.mjs";
import { checkExternalLayout, validatePluginManifest, validateAgainstSchema } from "../../../../../tools/check-external-layout.mjs";

const execFileAsync = promisify(execFile);
const execAsync = promisify(exec);
const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../../../../../");
const extensionDir = join(repoRoot, "com.github.copilot", "extensions", "software-factory");
const runnerPath = join(extensionDir, "runner", "sf.mjs");

// El token de acción se obtiene como la UI: leyendo el HTML servido por el propio servidor.
async function actionTokenFrom(server) {
  const html = await (await fetch(`http://127.0.0.1:${server.address().port}/`)).text();
  const token = html.match(/name="sf-action-token" content="([0-9a-f]+)"/)?.[1];
  assert.ok(token, "el HTML debe exponer el token de acción");
  return token;
}

function listen(server) {
  return new Promise((resolveListen) => server.listen(0, "127.0.0.1", resolveListen));
}

function closeServer(server) {
  return new Promise((resolveClose, reject) => {
    server.close((error) => (error ? reject(error) : resolveClose()));
  });
}

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
  const base = await mkdtemp(join(tmpdir(), "sf-route-"));
  t.after(() => rm(base, { recursive: true, force: true }));
  const sessionDir = join(base, "session");
  const selectedRepo = join(sessionDir, "target & one");
  await mkdir(selectedRepo, { recursive: true });
  const allowlist = createRepoAllowlist({ defaultRepo: () => sessionDir, env: {} });
  const canonicalRepo = allowlist.resolve(selectedRepo);
  const accesses = [];
  const watches = [];
  let subscription;
  const server = createFactoryServer({
    extensionDir,
    defaultRepo: () => sessionDir,
    resolveRepo: (requested) => allowlist.resolve(requested),
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
  assert.equal((await stateResponse.json()).repo, canonicalRepo);

  const eventsResponse = await fetch(`${baseUrl}${routeWithRepo("/events", selectedRepo)}`);
  const reader = eventsResponse.body.getReader();
  const firstEvent = await reader.read();
  assert.equal(JSON.parse(new TextDecoder().decode(firstEvent.value).slice(6)).repo, canonicalRepo);
  assert.equal(subscription, canonicalRepo);
  await reader.cancel();

  const actionResponse = await fetch(`${baseUrl}${routeWithRepo("/action", selectedRepo)}`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "x-sf-action-token": await actionTokenFrom(server),
    },
    body: JSON.stringify({ actionName: "pause", input: {} }),
  });
  const action = await actionResponse.json();
  assert.equal(action.repo, canonicalRepo);
  assert.deepEqual(accesses, [canonicalRepo, canonicalRepo, canonicalRepo]);
  assert.deepEqual(watches, [canonicalRepo, canonicalRepo]);

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
    headers: {
      "Content-Type": "application/json",
      "x-sf-action-token": await actionTokenFrom(server),
    },
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

  const first = await createIssuesFromDraft(state, { runGh: simulatedGh, persistState: persist });
  assert.deepEqual(first.failures.map((f) => f.title), ["Second"]);
  assert.match(first.failures[0].error, /simulated gh create failure/);
  assert.deepEqual(persistedIssues.map((issue) => issue.title), ["First"]);

  state.issues = persistedIssues;
  assert.equal(state.issue_failures.Second.error, "simulated gh create failure");
  delete state.issue_failures; // reset manual del registro de fallos para forzar el reintento
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

test("missing labels are auto-created before issue create and failures never abort the phase", async (t) => {
  const tempDir = await mkdtemp(join(tmpdir(), "sf-labels-"));
  t.after(() => rm(tempDir, { recursive: true, force: true }));
  await mkdir(join(tempDir, ".software-factory"));
  await writeFile(join(tempDir, ".software-factory", "issues-draft.json"), JSON.stringify({
    issues: [
      { title: "A", labels: ["brand-new", "-evil"] },
      { title: "B", labels: ["brand-new"] },
      { title: "C" },
    ],
  }));
  const state = { repo_path: tempDir, repo: "org/repo", project_id: "", issues: [] };
  const calls = [];
  const runGh = async (args) => {
    calls.push(args);
    if (args[0] === "issue" && args.includes("B")) throw new Error("boom");
    if (args[0] === "issue") return `https://github.com/org/repo/issues/${calls.length}`;
    return "";
  };
  const created = await createIssuesFromDraft(state, { runGh });
  const labelCalls = calls.filter((c) => c[0] === "label");
  assert.equal(labelCalls.length, 1, "label se crea una sola vez");
  assert.deepEqual(labelCalls[0].slice(0, 3), ["label", "create", "brand-new"]);
  assert.ok(labelCalls[0].includes("--force"));
  assert.ok(calls.findIndex((c) => c[0] === "label") < calls.findIndex((c) => c[0] === "issue"));
  assert.deepEqual(created.map((i) => i.title), ["A", "C"]);
  assert.deepEqual(created.failures.map((f) => f.title), ["B"]);
  assert.match(state.notes, /label inválido omitido/);
  assert.match(state.notes, /issue create failed for "B": boom/);

  calls.length = 0;
  const again = await createIssuesFromDraft(state, { runGh });
  assert.equal(calls.filter((c) => c[0] === "issue").length, 0, "fallo determinista no se repite");
  assert.equal(again.failures[0].skipped, true);
});

test("init rejects invalid repo, project and project-owner early", async (t) => {
  const runnerPath = join(dirname(fileURLToPath(import.meta.url)), "..", "sf.mjs");
  for (const bad of [["--repo", "-x/y"], ["--repo", "nope"], ["--repo", "org/repo", "--project", "-1"], ["--repo", "org/repo", "--project", "abc"], ["--repo", "org/repo", "--project-owner", "-bad"]]) {
    const repoPath = await mkdtemp(join(tmpdir(), "sf-init-bad-"));
    t.after(() => rm(repoPath, { recursive: true, force: true }));
    await assert.rejects(execFileAsync(process.execPath, [runnerPath, "init", repoPath, ...bad]), (e) => e.code === 1 && /inválido/.test(e.stderr));
    assert.equal(existsSync(join(repoPath, ".software-factory", "state.json")), false);
  }
});

// Regresión QA: el flujo real create -> project item-add confirmado por probe en gh
// se cubre aqui con runGh inyectado (sin GitHub real), en exito y en fallo parcial.
test("created issue is added to the Project with the right owner and URL", async (t) => {
  const tempDir = await mkdtemp(join(tmpdir(), "sf-item-add-"));
  t.after(() => rm(tempDir, { recursive: true, force: true }));
  await mkdir(join(tempDir, ".software-factory"));
  await writeFile(join(tempDir, ".software-factory", "issues-draft.json"),
    JSON.stringify({ issues: [{ title: "Alpha" }] }));

  const state = { repo_path: tempDir, repo: "org/repo", project_id: "17", project_owner: "project-org", issues: [] };
  const calls = [];
  const runGh = async (args) => {
    calls.push(args);
    if (args[0] === "issue") return "https://github.com/org/repo/issues/42";
    return "{}\n";
  };
  let saves = 0;
  const created = await createIssuesFromDraft(state, { runGh, persistState: async () => { saves += 1; } });

  assert.equal(created.length, 1);
  assert.equal(calls.length, 2, "tras crear la issue se invoca project item-add");
  assert.deepEqual(calls[1], [
    "project", "item-add", "17",
    "--owner", "project-org",
    "--url", "https://github.com/org/repo/issues/42",
  ], "item-add usa el project_id, owner y URL de la issue recien creada");
});

test("project item-add failure keeps the issue persisted and notes it", async (t) => {
  const tempDir = await mkdtemp(join(tmpdir(), "sf-item-add-fail-"));
  t.after(() => rm(tempDir, { recursive: true, force: true }));
  await mkdir(join(tempDir, ".software-factory"));
  await writeFile(join(tempDir, ".software-factory", "issues-draft.json"),
    JSON.stringify({ issues: [{ title: "Alpha" }] }));

  const state = { repo_path: tempDir, repo: "org/repo", project_id: "17", issues: [] };
  const snapshots = [];
  const runGh = async (args) => {
    if (args[0] === "issue") return "https://github.com/org/repo/issues/7";
    throw new Error("project not visible to this user");
  };
  const created = await createIssuesFromDraft(state, {
    runGh,
    persistState: async () => { snapshots.push({ issues: state.issues.map((i) => ({ ...i })), notes: state.notes || "" }); },
  });

  // El fallo de item-add NO aborta la fabrica: la issue queda creada y persistida.
  assert.deepEqual(created.map((i) => i.number), [7]);
  assert.deepEqual(state.issues.map((i) => i.number), [7], "la issue se conserva pese al fallo de item-add");
  assert.match(state.notes, /project add failed for #7: project not visible/);
  // owner derivado de state.repo cuando no hay project_owner
  const last = snapshots.at(-1);
  assert.deepEqual(last.issues.map((i) => i.number), [7], "la persistencia posterior al fallo incluye la issue");
  assert.match(last.notes, /project add failed for #7/, "la nota del fallo queda en la ultima persistencia");
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

test("work order prompts emit the full complete command with the repo path", () => {
  const repoPath = "C:\\repos\\my factory";
  const state = { repo: "org/repo", repo_path: repoPath, round: 1 };
  const task = { id: "r1-discover-01", round: 1, result_file: join(repoPath, ".software-factory", "results", "r1-discover-01.md") };
  const prompt = discoverPrompt(state, task);
  assert.match(prompt, new RegExp(`complete "${repoPath.replace(/[\\.*+^${}()|[\]\\]/g, "\\$&")}" r1-discover-01`));
  assert.match(prompt, /node "[^"]*sf\.mjs" complete/);
});

test("bootstrap prompt quotes the repo dir so paths with spaces work", () => {
  const repoDir = "C:\\Users\\me\\My Projects\\app";
  const prompt = bootstrapPrompt(repoDir, "C:\\runner\\sf.mjs", null);
  assert.match(prompt, /next "C:\\Users\\me\\My Projects\\app"/);
  assert.match(prompt, /complete "C:\\Users\\me\\My Projects\\app" <taskId>/);
});

test("the complete command copied from a work order runs end to end", async (t) => {
  const tempDir = await mkdtemp(join(tmpdir(), "sf-complete-"));
  t.after(() => rm(tempDir, { recursive: true, force: true }));
  const repoPath = join(tempDir, "repo with spaces");
  await mkdir(repoPath);

  await execFileAsync(process.execPath, [runnerPath, "init", repoPath, "--repo", "org/repo"]);
  await execFileAsync(process.execPath, [runnerPath, "start", repoPath]);
  const state = await loadState(repoPath);
  const task = state.tasks.find((entry) => entry.phase === "discover");
  assert.ok(task, "start should emit the discover work order");
  const promptText = await readFile(task.prompt_file, "utf8");
  const command = promptText.match(/Reporta con: (.+)/)?.[1];
  assert.ok(command, "work order must contain a runnable report command");

  // Contract: done exige informe en result_file; lo escribe primero el "agente".
  await writeFile(task.result_file, "# Informe\nTarea completada.\n");

  // Ejecutar la cadena tal cual la vería un usuario: vía shell, para validar el quoting.
  await execAsync(command);

  const updated = await loadState(repoPath);
  assert.equal(updated.tasks.find((entry) => entry.id === task.id).status, "done");
});

test("canvas.json is not distributed; the installer generates it from plugin metadata", async () => {
  await assert.rejects(
    readFile(join(extensionDir, "canvas.json")),
    "la extensión distribuida no debe contener canvas.json",
  );
  const [readme, pluginManifest, installer, generated] = await Promise.all([
    readFile(join(repoRoot, "README.md"), "utf8"),
    readFile(join(repoRoot, "plugin.json"), "utf8").then(JSON.parse),
    readFile(join(repoRoot, "install.ps1"), "utf8"),
    buildCanvasManifest(repoRoot),
  ]);
  assert.equal(generated.id, "software-factory");
  assert.equal(generated.name, "Software Factory");
  assert.equal(generated.main, "extension.mjs");
  assert.equal(generated.version, pluginManifest.version);
  assert.equal(generated.author, pluginManifest.author.name);
  assert.match(readme, /git clone https:\/\/github\.com\/svg153\/canvas-software-factory\.git/);
  assert.match(readme, /cd canvas-software-factory/);
  assert.match(readme, /\.\\install\.ps1/);
  assert.equal(pluginManifest.repository, "https://github.com/svg153/canvas-software-factory");
  assert.match(installer, /extensions\\software-factory/);
  assert.match(installer, /skills\\software-factory/);
  assert.match(installer, /tools\\make-canvas-manifest\.mjs/);
});

test("external layout passes the local partial check (official awesome-copilot gate not run here)", async () => {
  // El checker solo debe anunciar lo que comprueba: espejo parcial de estructura
  // + esquema Agent Plugins 1.0.0 vendido. El gate oficial completo no se ejecuta.
  const checker = await readFile(join(repoRoot, "tools", "check-external-layout.mjs"), "utf8");
  assert.match(checker, /Comprobaci[oó]n LOCAL y PARCIAL/, "el checker debe declararse parcial");
  assert.match(checker, /gate oficial completo de awesome-copilot no se ejecuta/i,
    "el checker debe dejar constancia de que el gate oficial no corre aquí");
  assert.doesNotMatch(checker, /Layout externo OK \((gate|esquema Agent Plugins 1\.0\))/,
    "el checker no puede anunciar conformidad completa que no valida");

  const pluginManifest = await readFile(join(repoRoot, "plugin.json"), "utf8").then(JSON.parse);
  assert.deepEqual(await validatePluginManifest(pluginManifest), [],
    "plugin.json debe validar contra el esquema Agent Plugins 1.0.0 vendido");
  assert.deepEqual(await checkExternalLayout(repoRoot), [],
    "el repo debe pasar la comprobación parcial de layout/manifest");
  assert.ok(pluginManifest.keywords.includes("canvas"), "keywords debe incluir 'canvas' para activar el gate de estructura");
  // runCanvasStructureGate exige com.github.copilot/extensions/<id>/extension.mjs versionado.
  await readFile(join(repoRoot, "com.github.copilot", "extensions", "software-factory", "extension.mjs"));
  // Fuente canónica única: la antigua ruta raíz no debe contener una copia.
  await assert.rejects(
    readFile(join(repoRoot, "extensions", "software-factory", "extension.mjs")),
    "existe una segunda copia de la extensión fuera del namespace",
  );
  // Skills descubiertas por convención en skills/ de la raíz del paquete.
  await readFile(join(repoRoot, "skills", "software-factory", "SKILL.md"));
  // Logo exactamente en assets/preview.png (convención awesome-copilot).
  assert.equal(pluginManifest.extensions["com.github.copilot"].logo, "assets/preview.png");
  // Ningún canvas.json versionado en el árbol distribuido.
  await assert.rejects(
    readFile(join(repoRoot, "com.github.copilot", "extensions", "software-factory", "canvas.json")),
  );
});

test("the vendored schema validator rejects manifests the old key-list check would miss", async () => {
  // Regresión: antes el checker solo miraba algunas claves y anunciaba "esquema
  // Agent Plugins 1.0" completo. Ahora valida tipos, nombre requerido/patrón,
  // const, additionalProperties anidados y palabras no soportadas, en abierto.
  const schema = JSON.parse(await readFile(join(repoRoot, "tools", "schemas", "agent-plugins-1.0.0.plugin.schema.json"), "utf8"));
  const good = {
    $schema: "https://agent-plugins.org/schemas/1.0.0/plugin.schema.json",
    name: "software-factory",
    keywords: ["canvas"],
    extensions: { "com.github.copilot": { logo: "assets/preview.png" } },
  };
  assert.deepEqual(validateAgainstSchema(good, schema, "$"), [], "el esquema vendido debe aceptar un manifest válido");
  assert.ok(validateAgainstSchema({ ...good, name: "Bad_Name" }, schema, "$").some((e) => /patrón/.test(e)), "name con mayúsculas/guion bajo viola el patrón");
  assert.ok(validateAgainstSchema({ ...good, name: "a--b" }, schema, "$").some((e) => /patrón/.test(e)), "name con '--' viola el patrón");
  assert.ok(validateAgainstSchema({ ...good, $schema: "https://example.com/other.json" }, schema, "$").some((e) => /exactamente/.test(e)), "$schema debe coincidir con el const");
  assert.ok(validateAgainstSchema({ keywords: "canvas", name: "ok" }, schema, "$").some((e) => /requerido/.test(e)), "falta $schema requerido");
  assert.ok(validateAgainstSchema({ ...good, version: 1 }, schema, "$").some((e) => /tipo esperado 'string'/.test(e)), "version debe ser string");
  assert.ok(validateAgainstSchema({ ...good, author: { name: "x", twitter: "y" } }, schema, "$").some((e) => /no permitido 'twitter'/.test(e)), "author rechaza campos extra");
  assert.ok(validateAgainstSchema({ ...good, keywords: ["canvas", 42] }, schema, "$").some((e) => /keywords\[1\]/.test(e)), "keywords items string");
  assert.ok(validateAgainstSchema({ ...good, extensions: { "com.github.copilot": "logo.png" } }, schema, "$").some((e) => /tipo esperado 'object'/.test(e)), "namespaces deben ser object");
  assert.ok(validateAgainstSchema(good, { type: "object", unknownKeyword: true }, "$").some((e) => /no soportada/.test(e)), "palabras no soportadas fallan en abierto");
});

test("schema audit visits the whole tree even when the instance omits the field", () => {
  // Regresión: antes properties[k] solo se visitaba si k estaba en la instancia
  // e items solo si habia elementos, asi que una keyword desconocida en un campo
  // opcional ausente pasaba inadvertida (contradecía el fallo cerrado).
  const schema = {
    type: "object",
    properties: {
      name: { type: "string" },
      optional: { type: "string", deprecated: true },
      tags: { type: "array", items: { type: "string", unevaluatedItems: false } },
    },
  };
  const errors = validateAgainstSchema({ name: "ok", tags: [] }, schema, "$");
  assert.ok(errors.some((e) => e.includes("properties.optional: palabra de esquema 'deprecated' no soportada")),
    "keyword desconocida en un campo opcional AUSENTE debe fallar");
  assert.ok(errors.some((e) => e.includes("properties.tags.items: palabra de esquema 'unevaluatedItems' no soportada")),
    "keyword desconocida en items de un array VACIO debe fallar");
  assert.ok(!errors.some((e) => /'type'|'properties'|'items'/.test(e)), "sin falsos positivos sobre palabras soportadas");
});

test("layout check treats only ENOENT as absence and propagates other read errors", async (t) => {
  const dir = await mkdtemp(join(tmpdir(), "sf-layout-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const manifest = JSON.parse(await readFile(join(repoRoot, "plugin.json"), "utf8"));
  await writeFile(join(dir, "plugin.json"), JSON.stringify(manifest));

  // Ausencia real (ENOENT): se reporta como error de layout, sin lanzar.
  const missing = await checkExternalLayout(dir);
  assert.ok(missing.some((e) => /falta software-factory\/extension\.mjs/.test(e)), "ENOENT se reporta como ausencia");
  assert.ok(missing.some((e) => /falta skills\/software-factory\/SKILL\.md/.test(e)), "SKILL.md ausente se reporta como ausencia");

  // extension.mjs como DIRECTORIO: lectura falla con EISDIR/EPERM, no es
  // ausencia; debe propagarse en lugar de contarse como error de layout.
  await mkdir(join(dir, "com.github.copilot", "extensions", "software-factory", "extension.mjs"), { recursive: true });
  await assert.rejects(checkExternalLayout(dir), (error) => {
    assert.ok(["EISDIR", "EPERM", "ENOTDIR"].includes(error.code), `se esperaba un error de lectura propagado, recibido ${error.code}`);
    return true;
  }, "un error de lectura que no es ENOENT debe propagarse");
});

test("vendored schema ships its Apache-2.0 license copy and third-party notice", async () => {
  // Cumplimiento de licencia antes de publicar: el esquema vendido es Apache-2.0
  // (agentplugins/agent-plugins-spec); su copia y el aviso de terceros deben
  // versionarse junto a él. El código propio sigue siendo MIT (LICENSE raíz).
  const schemaDir = join(repoRoot, "tools", "schemas");
  assert.ok(existsSync(join(schemaDir, "agent-plugins-1.0.0.plugin.schema.json")), "el esquema vendido debe existir");
  const license = await readFile(join(schemaDir, "LICENSE-Apache-2.0.txt"), "utf8");
  assert.match(license, /Apache License\s*\n\s*Version 2\.0/, "copia textual de Apache-2.0");
  const notice = await readFile(join(schemaDir, "NOTICE.md"), "utf8");
  assert.match(notice, /agentplugins\/agent-plugins-spec/, "NOTICE identifica el proyecto de origen");
  assert.match(notice, /schemas\/1\.0\.0\/plugin\.schema\.json/, "NOTICE identifica la ruta upstream");
  assert.match(notice, /agent-plugins-1\.0\.0\.plugin\.schema\.json/, "NOTICE identifica el archivo vendido");
  assert.match(notice, /Apache License 2\.0|Apache-2\.0/, "NOTICE declara la licencia Apache-2.0");
  assert.match(notice, /MIT/, "NOTICE preserva la licencia MIT del código propio");
});

test("POST /action rejects missing or wrong CSRF token and accepts the HTML-exposed one", async (t) => {
  const applied = [];
  const server = createFactoryServer({
    extensionDir,
    defaultRepo: () => "C:\\repo",
    readState: async () => null,
    ensureWatch() {},
    subscribe() {},
    applyAction: async (repo, actionName) => {
      applied.push(actionName);
      return { status: `ok ${actionName}` };
    },
  });
  await listen(server);
  t.after(() => closeServer(server));
  const baseUrl = `http://127.0.0.1:${server.address().port}`;
  const token = await actionTokenFrom(server);
  assert.match(token, /^[0-9a-f]{48}$/);

  const post = (headers) => fetch(`${baseUrl}/action`, {
    method: "POST",
    headers: { "Content-Type": "application/json", ...headers },
    body: JSON.stringify({ actionName: "pause", input: {} }),
  });

  let response = await post({});
  assert.equal(response.status, 403);
  assert.match((await response.json()).error, /sf_csrf_token_invalido/);

  response = await post({ "x-sf-action-token": "f".repeat(48) });
  assert.equal(response.status, 403);

  response = await post({ "x-sf-action-token": token });
  assert.equal(response.status, 200);
  assert.deepEqual(applied, ["pause"]);

  // La UI debe enviar la cabecera con el mismo nombre que valida el servidor.
  const appSource = await readFile(join(extensionDir, "app.mjs"), "utf8");
  assert.match(appSource, /x-sf-action-token/);
  assert.match(appSource, /sf-action-token/);

  // Cada instancia genera un token distinto.
  const server2 = createFactoryServer({
    extensionDir,
    defaultRepo: () => "C:\\repo",
    readState: async () => null,
    ensureWatch() {},
    subscribe() {},
    applyAction: async () => ({ status: "ok" }),
  });
  await listen(server2);
  t.after(() => closeServer(server2));
  assert.notEqual(await actionTokenFrom(server2), token);
});

test("loopback server validates Host/Origin, caps bodies and hides paths", async (t) => {
  const applied = [];
  const server = createFactoryServer({
    extensionDir,
    defaultRepo: () => "C:\\repo",
    readState: async () => null,
    ensureWatch() {},
    subscribe() {},
    applyAction: async (repo, actionName) => {
      if (actionName === "boom") throw new Error("ENOENT: C:\\secret\\dir\\file.json");
      applied.push(actionName);
      return { status: "ok" };
    },
  });
  await listen(server);
  t.after(() => closeServer(server));
  const port = server.address().port;
  const baseUrl = `http://127.0.0.1:${port}`;
  const token = await actionTokenFrom(server);
  const body = (actionName) => JSON.stringify({ actionName, input: {} });
  const post = (headers, payload = body("pause")) => fetch(`${baseUrl}/action`, {
    method: "POST",
    headers: { "Content-Type": "application/json", "x-sf-action-token": token, ...headers },
    body: payload,
  });
  // fetch no permite forjar Host; http.request sí.
  const rawRequest = (headers, payload) => new Promise((resolveReq, reject) => {
    const req = httpRequest({ host: "127.0.0.1", port, path: "/", method: payload ? "POST" : "GET", headers }, (res) => {
      let text = "";
      res.on("data", (chunk) => { text += chunk; });
      res.on("end", () => resolveReq({ status: res.statusCode, text, headers: res.headers }));
    });
    req.on("error", reject);
    req.end(payload);
  });

  { const r0 = await post({}); assert.equal(r0.status, 200, await r0.text()); }
  { const r1 = await post({ Origin: `http://localhost:${port}` }); assert.equal(r1.status, 200, await r1.text()); }
  assert.equal((await post({ Origin: baseUrl, "Sec-Fetch-Site": "same-origin" })).status, 200);

  let response = await post({ Origin: "https://evil.example" });
  assert.equal(response.status, 403);
  assert.ok(!(await response.text()).includes(token));
  assert.equal((await post({ "Sec-Fetch-Site": "cross-site" })).status, 403);
  assert.deepEqual(applied, ["pause", "pause", "pause"]);

  // Rebinding: el Host forjado no obtiene el HTML (ni el token) ni puede actuar.
  const forgedPage = await rawRequest({ Host: `evil.example:${port}` });
  assert.equal(forgedPage.status, 403);
  assert.ok(!forgedPage.text.includes(token));
  const forgedAction = await rawRequest({ Host: "evil.example", "x-sf-action-token": token, "Content-Type": "application/json" }, body("pause"));
  assert.equal(forgedAction.status, 403);
  assert.equal(applied.length, 3);

  response = await post({}, JSON.stringify({ actionName: "pause", input: { pad: "x".repeat(70 * 1024) } }));
  assert.equal(response.status, 413);

  for (const bad of [await post({}, "{no-json"), await post({}, body("boom"))]) {
    assert.equal(bad.status, 400);
    const text = await bad.text();
    assert.ok(!/[A-Za-z]:\\|ENOENT|secret/.test(text), `sin paths en errores: ${text}`);
  }

  for (const path of ["/", "/state"]) {
    const res = await fetch(`${baseUrl}${path}`);
    assert.equal(res.headers.get("x-content-type-options"), "nosniff");
    assert.match(res.headers.get("content-security-policy") || "", /default-src 'self'/);
    await res.arrayBuffer();
  }
});
test("startGuardError only blocks finished factories; canvas play uses it", () => {
  assert.match(startGuardError({ status: "done" }), /ya terminó/);
  assert.equal(startGuardError({ status: "running" }), null);
  assert.equal(startGuardError({ status: "paused" }), null);
  assert.equal(startGuardError(null), null);
});

test("full CLI cycle ends done at max_rounds without extra-round tasks", async (t) => {
  const tempDir = await mkdtemp(join(tmpdir(), "sf-cycle-"));
  t.after(() => rm(tempDir, { recursive: true, force: true }));
  const repo = join(tempDir, "repo");
  await mkdir(repo);
  const run = (...args) => execFileAsync(process.execPath, [runnerPath, ...args]);

  await run("init", repo, "--repo", "org/repo", "--rounds", "1");
  await run("start", repo);
  let out = JSON.parse((await run("next", repo)).stdout);
  let iterations = 0;
  while (out.status === "running" && iterations++ < 40) {
    for (const task of out.tasks || []) await run("complete", repo, task.id, "--force");
    out = JSON.parse((await run("next", repo)).stdout);
  }
  assert.equal(out.status, "done", `la fábrica debía terminar, quedó ${out.status}`);

  const state = await loadState(repo);
  assert.equal(state.round, 1, "round no debe superar max_rounds al terminar");
  assert.equal(state.status, "done");
  assert.ok(state.tasks.every((task) => task.round <= state.max_rounds));
  assert.equal(state.tasks.filter((task) => task.phase === "review").length, 1);

  // next sobre fábrica done: hint hacia init y cero tareas nuevas.
  const before = state.tasks.length;
  const after = JSON.parse((await run("next", repo)).stdout);
  assert.equal(after.status, "done");
  assert.deepEqual(after.tasks, []);
  assert.match(after.hint, /init/);
  assert.equal((await loadState(repo)).tasks.length, before, "next no debe emitir tareas tras done");
});

test("start right after completing a phase's last task does not re-emit it", async (t) => {
  const tempDir = await mkdtemp(join(tmpdir(), "sf-restart-"));
  t.after(() => rm(tempDir, { recursive: true, force: true }));
  const repo = join(tempDir, "repo");
  await mkdir(repo);
  const run = (...args) => execFileAsync(process.execPath, [runnerPath, ...args]);

  await run("init", repo, "--repo", "org/repo", "--rounds", "2");
  await run("start", repo);
  const state1 = await loadState(repo);
  const discover = state1.tasks.filter((task) => task.phase === "discover");
  assert.equal(discover.length, 1);
  await run("complete", repo, discover[0].id, "--force");

  await run("start", repo); // reanudar justo tras cerrar la última tarea de la fase
  const state2 = await loadState(repo);
  assert.equal(state2.status, "running");
  assert.equal(
    state2.tasks.filter((task) => task.phase === "discover" && task.round === 1).length,
    1,
    "start no debe duplicar tareas de una fase ya completada",
  );

  // next debe cerrar la fase y emitir la siguiente (plan), sin duplicar discover.
  const next = JSON.parse((await run("next", repo)).stdout);
  assert.equal(next.phase, "plan");
  assert.equal(next.tasks.length, 1);
  assert.equal((await loadState(repo)).tasks.filter((task) => task.phase === "discover").length, 1);
});

test("start refuses a finished factory and keeps status done", async (t) => {
  const tempDir = await mkdtemp(join(tmpdir(), "sf-done-start-"));
  t.after(() => rm(tempDir, { recursive: true, force: true }));
  const repo = join(tempDir, "repo");
  await mkdir(repo);

  const state = await (async () => {
    await execFileAsync(process.execPath, [runnerPath, "init", repo, "--repo", "org/repo"]);
    const loaded = await loadState(repo);
    loaded.status = "done";
    return saveState(repo, loaded);
  })();
  assert.equal(state.status, "done");

  await assert.rejects(
    execFileAsync(process.execPath, [runnerPath, "start", repo]),
    (error) => {
      assert.equal(error.code, 1);
      assert.match(error.stderr, /ya terminó/);
      return true;
    },
  );
  const after = await loadState(repo);
  assert.equal(after.status, "done", "start rechazado no debe reabrir la fábrica");
  assert.equal(after.tasks.length, 0, "start rechazado no debe emitir tareas");
});

test("extension play guards a done factory via the shared startGuardError", async () => {
  const extSource = await readFile(join(extensionDir, "extension.mjs"), "utf8");
  assert.match(extSource, /startGuardError/);
  assert.match(extSource, /actionName === "play"[\s\S]{0,220}startGuardError/);
});

// gh falso para pruebas e2e: preload EXCLUSIVO de tests (test-support/fake-gh-preload.mjs)
// cargado via NODE_OPTIONS=--import en el proceso del CLI. Registra llamadas, crea
// issues con número incremental y tolera ruido en stderr con exit 0 (como gh real).
// El código de producción no conoce ninguna variable de simulación.
const fakeGhPreload = join(dirname(fileURLToPath(import.meta.url)), "..", "test-support", "fake-gh-preload.mjs");

function ghEnv(tempDir, mode) {
  return {
    ...process.env,
    NODE_OPTIONS: `--import=${pathToFileURL(fakeGhPreload).href}`,
    SF_TEST_FAKE_GH_LOG: join(tempDir, "gh-calls.log"),
    SF_TEST_FAKE_GH_COUNTER: join(tempDir, "gh-counter"),
    ...(mode ? { SF_TEST_FAKE_GH_MODE: mode } : {}),
  };
}

async function ghCalls(logPath) {
  if (!existsSync(logPath)) return [];
  return (await readFile(logPath, "utf8")).split("\n").filter(Boolean).map((l) => JSON.parse(l));
}

test("production code has no simulation hook: SF_FAKE_GH cannot exist outside tests", async () => {
  // Regresión: el hook SF_FAKE_GH en produccion contaminaba state.issues con
  // entradas simuladas que bloqueaban la creacion real posterior al retirarlo.
  // La simulacion vive solo en el preload de tests; la produccion siempre invoca
  // al gh real y no lee variables de simulacion.
  const ghSource = await readFile(join(extensionDir, "runner", "lib", "gh.mjs"), "utf8");
  const sfSource = await readFile(join(extensionDir, "runner", "sf.mjs"), "utf8");
  assert.doesNotMatch(ghSource, /SF_FAKE_GH/, "lib/gh.mjs no puede referenciar SF_FAKE_GH");
  assert.doesNotMatch(sfSource, /SF_FAKE_GH/, "sf.mjs no puede referenciar SF_FAKE_GH");
  assert.doesNotMatch(ghSource + sfSource, /simulated/, "nada se marca simulated en produccion");
  // La unica diferencia entre sandbox y real es el binario detras de execFile
  // (sustituido por el preload), no una puerta en el codigo: retirar la
  // simulacion no puede dejar entradas que bloqueen una ejecucion real.
  const preloadSource = await readFile(fakeGhPreload, "utf8");
  assert.match(preloadSource, /syncBuiltinESMExports/, "el preload simula execFile sin tocar la produccion");
});

test("multi-round CLI with fake gh keeps issue numbers unique and claims only new round-2 issues", async (t) => {
  const tempDir = await mkdtemp(join(tmpdir(), "sf-multi-round-"));
  t.after(() => rm(tempDir, { recursive: true, force: true }));
  const repo = join(tempDir, "repo");
  await mkdir(repo);
  const run = (...args) => execFileAsync(process.execPath, [runnerPath, ...args], { env: ghEnv(tempDir) });

  await run("init", repo, "--repo", "org/repo", "--rounds", "2");
  await run("start", repo);
  const draftFile = join(repo, ".software-factory", "issues-draft.json");
  await writeFile(draftFile, JSON.stringify({ issues: [{ title: "Alpha" }, { title: "Beta" }] }));

  let out = JSON.parse((await run("next", repo)).stdout);
  let iterations = 0;
  let injectedRound2 = false;
  while (out.status === "running" && iterations++ < 60) {
    for (const task of out.tasks || []) await run("complete", repo, task.id, "--force");
    if (!injectedRound2 && out.phase === "discover" && out.round === 2) {
      // Issue nueva en ronda 2: no debe reutilizar los números de la ronda 1.
      await writeFile(draftFile, JSON.stringify({
        issues: [{ title: "Alpha" }, { title: "Beta" }, { title: "Gamma" }],
      }));
      injectedRound2 = true;
    }
    out = JSON.parse((await run("next", repo)).stdout);
  }
  assert.equal(out.status, "done", `la fábrica debía terminar, quedó ${out.status}`);
  assert.ok(injectedRound2, "el ciclo debe haber alcanzado la ronda 2");

  const state = await loadState(repo);
  const numbers = state.issues.map((i) => i.number);
  assert.deepEqual(numbers, [1, 2, 3], "gh falso creó 3 issues únicas entre rondas");
  assert.equal(new Set(numbers).size, numbers.length);
  assert.ok(state.issues.every((i) => !("simulated" in i)),
    "el state no admite marcas de simulacion: la produccion no conoce modos simulados");

  const creates = (await ghCalls(join(tempDir, "gh-calls.log")))
    .filter((a) => a[0] === "issue" && a[1] === "create");
  assert.equal(creates.length, 3, "solo Gamma se creó en ronda 2; Alpha/Beta se omitieron por título");

  const r1 = state.tasks.filter((task) => task.phase === "implement" && task.round === 1);
  const r2 = state.tasks.filter((task) => task.phase === "implement" && task.round === 2);
  assert.equal(r1.length, 2, "ronda 1: Alpha y Beta");
  assert.equal(r2.length, 1, "ronda 2: solo Gamma, sin repetir Alpha/Beta");
  assert.match(r2[0].title, /Gamma/);
  assert.equal(r2[0].issue.number, 3, "Gamma no debe colisionar con Alpha (1)");

  const gammaOrder = await readFile(r2[0].prompt_file, "utf8");
  assert.match(gammaOrder, /# Implementar issue #3 — Gamma/);
  assert.doesNotMatch(gammaOrder, /Alpha|Beta/, "el work order de Gamma no debe repetir otras issues");
});

test("dry-run never advances nor touches production state; the real run afterwards creates issues exactly once", async (t) => {
  const tempDir = await mkdtemp(join(tmpdir(), "sf-dry-purity-"));
  t.after(() => rm(tempDir, { recursive: true, force: true }));
  const repo = join(tempDir, "repo");
  await mkdir(repo);
  const logPath = join(tempDir, "gh-calls.log");
  const run = (...args) => execFileAsync(process.execPath, [runnerPath, ...args], { env: ghEnv(tempDir) });

  await run("init", repo, "--repo", "org/repo", "--rounds", "1");
  await run("start", repo);
  const draftFile = join(repo, ".software-factory", "issues-draft.json");
  await writeFile(draftFile, JSON.stringify({ issues: [{ title: "Alpha" }, { title: "Beta" }] }));

  // Ciclo real hasta agotar grill (la fase issues se cruza sola dentro de un next real).
  let out = JSON.parse((await run("next", repo)).stdout);
  let iterations = 0;
  while (out.phase !== "grill" && out.status === "running" && iterations++ < 20) {
    for (const task of out.tasks || []) await run("complete", repo, task.id, "--force");
    out = JSON.parse((await run("next", repo)).stdout);
  }
  assert.equal(out.phase, "grill", "el ciclo real debe llegar a grill");
  for (const task of out.tasks || []) await run("complete", repo, task.id, "--force");
  // Un advance explícito deja la fábrica justo en la fase issues, sin crear nada.
  await run("advance", repo);
  assert.equal((await loadState(repo)).phase, "issues", "la fábrica debe quedar plantada en la fase issues");
  assert.deepEqual(await ghCalls(logPath), [], "llegar a issues no invoca gh");

  const stateFile = join(repo, ".software-factory", "state.json");
  const eventsFile = join(repo, ".software-factory", "events.log");
  const stateBefore = await readFile(stateFile, "utf8");
  const eventsBefore = await readFile(eventsFile, "utf8");

  // next --dry-run: previsualización explícita sin tocar producción.
  const dryNext = JSON.parse((await run("next", repo, "--dry-run")).stdout);
  assert.equal(dryNext.dry_run, true);
  assert.equal(dryNext.phase, "issues", "next --dry-run no avanza la fase real");
  assert.equal(dryNext.advance.dryRun, true);
  assert.equal(dryNext.advance.to, "implement", "la preview muestra el avance que haría");
  assert.deepEqual(dryNext.advance.issues.map((i) => i.title), ["Alpha", "Beta"]);
  assert.ok(dryNext.advance.issues.every((i) => i.dry === true), "preview marcada dry:true");
  assert.deepEqual(dryNext.advance.issues.map((i) => i.number), [901, 902], "números ficticios 901+");
  assert.equal(await readFile(stateFile, "utf8"), stateBefore, "next --dry-run no escribe state.json");
  assert.equal(await readFile(eventsFile, "utf8"), eventsBefore, "next --dry-run no escribe events.log");

  // advance --dry: mismo contrato de pureza.
  const dryAdv = JSON.parse((await run("advance", repo, "--dry")).stdout);
  assert.equal(dryAdv.dryRun, true);
  assert.equal(dryAdv.from, "issues");
  assert.equal(dryAdv.to, "implement");
  assert.equal(dryAdv.issues.length, 2, "advance --dry devuelve la previsualización explícita");
  assert.equal(await readFile(stateFile, "utf8"), stateBefore, "advance --dry no escribe state.json");
  assert.deepEqual(await ghCalls(logPath), [], "la simulación no invoca gh nunca");
  assert.deepEqual((await loadState(repo)).issues, [], "la simulación no contamina state.issues");

  // Continuación en modo real: cada issue se crea exactamente una vez y la fase avanza.
  const realOut = JSON.parse((await run("next", repo)).stdout);
  assert.equal(realOut.phase, "implement", "la ejecución real sí avanza la fase");
  const creates = (await ghCalls(logPath)).filter((a) => a[0] === "issue" && a[1] === "create");
  assert.equal(creates.length, 2, "las issues del draft se crean exactamente una vez");
  assert.deepEqual(creates.map((a) => a[a.indexOf("--title") + 1]).sort(), ["Alpha", "Beta"]);
  const realState = await loadState(repo);
  assert.deepEqual(realState.issues.map((i) => i.title).sort(), ["Alpha", "Beta"]);
  assert.ok(realState.issues.every((i) => !("simulated" in i) && !("dry" in i)),
    "la continuacion real persiste issues sin marcas ficticias: nada de la simulacion anterior queda en el estado");
  const eventsAfter = await readFile(eventsFile, "utf8");
  assert.match(eventsAfter, /issues phase: 2 issues/);
  assert.doesNotMatch(eventsBefore, /issues phase/, "la simulación no dejó rastro en events.log");

  // Segunda pasada real: no duplica creaciones.
  await run("next", repo);
  const creates2 = (await ghCalls(logPath)).filter((a) => a[0] === "issue" && a[1] === "create");
  assert.equal(creates2.length, 2, "una segunda pasada no duplica las issues");
});

test("duplicate titles within one draft are created once (real) and previewed once (dry)", async (t) => {
  const tempDir = await mkdtemp(join(tmpdir(), "sf-dup-draft-"));
  t.after(() => rm(tempDir, { recursive: true, force: true }));
  const repo = join(tempDir, "repo");
  await mkdir(repo);
  const logPath = join(tempDir, "gh-calls.log");
  const run = (...args) => execFileAsync(process.execPath, [runnerPath, ...args], { env: ghEnv(tempDir) });

  await run("init", repo, "--repo", "org/repo");
  const draftFile = join(repo, ".software-factory", "issues-draft.json");
  await writeFile(draftFile, JSON.stringify({ issues: [{ title: "Alpha" }, { title: "Alpha" }, { title: "Beta" }] }));

  // dry: la preview queda deduplicada dentro de la misma invocación.
  const dryOut = JSON.parse((await run("issues", repo, "--dry")).stdout);
  assert.equal(dryOut.created, 2, "Alpha duplicado se previsualiza una sola vez");
  assert.deepEqual(dryOut.urls.map((u) => u.title), ["Alpha", "Beta"]);
  assert.ok(dryOut.urls.every((u) => u.dry === true));
  assert.deepEqual((await loadState(repo)).issues, [], "el dry no escribe state.issues");
  assert.deepEqual(await ghCalls(logPath), [], "el dry no invoca gh");

  // real: gh se llama una vez por título único; sin duplicados persistidos.
  const realOut = JSON.parse((await run("issues", repo)).stdout);
  assert.equal(realOut.created, 2);
  assert.deepEqual(realOut.urls.map((u) => u.number), [1, 2]);
  const creates = (await ghCalls(logPath)).filter((a) => a[0] === "issue" && a[1] === "create");
  assert.equal(creates.length, 2, "el título repetido no genera una segunda creación");
  const state = await loadState(repo);
  assert.deepEqual(state.issues.map((i) => i.title), ["Alpha", "Beta"]);
});

test("commands without dry preview reject --dry/--dry-run before writing anything", async (t) => {
  // Regresión: la ayuda prometía dry "en cualquier comando", pero start/pause/init/
  // complete/status ignoraban la bandera y mutaban el estado igualmente.
  // Ahora solo next/advance/issues admiten dry; el resto sale con código 2 SIN escribir.
  const tempDir = await mkdtemp(join(tmpdir(), "sf-dry-reject-"));
  t.after(() => rm(tempDir, { recursive: true, force: true }));
  const repo = join(tempDir, "repo");
  await mkdir(repo);
  const run = (...args) => execFileAsync(process.execPath, [runnerPath, ...args]);

  await run("init", repo, "--repo", "org/repo");
  await run("start", repo);
  const stateFile = join(repo, ".software-factory", "state.json");
  const eventsFile = join(repo, ".software-factory", "events.log");
  const stateBefore = await readFile(stateFile, "utf8");
  const eventsBefore = await readFile(eventsFile, "utf8");

  const rejectCases = [
    ["start", repo],
    ["pause", repo],
    ["init", repo, "--repo", "org/repo", "--force"], // ni con --force: dry se rechaza primero
    ["status", repo],
    ["complete", repo, "t1", "--force"],
    ["set-status", repo, "paused"],
  ];
  for (const base of rejectCases) {
    for (const flag of ["--dry", "--dry-run"]) {
      await assert.rejects(run(...base, flag), (error) => {
        assert.equal(error.code, 2, `${base[0]} ${flag} debe salir con codigo 2`);
        assert.match(error.stderr, /solo se admite en next\/advance\/issues/);
        return true;
      }, `${base[0]} debe rechazar ${flag} explicitamente`);
    }
  }
  assert.equal(await readFile(stateFile, "utf8"), stateBefore, "el rechazo no escribe state.json");
  assert.equal(await readFile(eventsFile, "utf8"), eventsBefore, "el rechazo no escribe events.log");

  // next/advance/issues sí aceptan la bandera (previsualización real ya cubierta en
  // otra prueba; aquí solo el contrato de admisión). advance informa dryRun en camel.
  for (const cmd of ["next", "advance", "issues"]) {
    const out = JSON.parse((await run(cmd, repo, "--dry")).stdout);
    assert.ok(out.dry_run === true || out.dryRun === true, `${cmd} admite --dry`);
  }
  assert.equal(await readFile(stateFile, "utf8"), stateBefore, "los dry admitidos tampoco escriben");
});

test("init refuses to overwrite existing or corrupt state without --force", async (t) => {
  const tempDir = await mkdtemp(join(tmpdir(), "sf-init-guard-"));
  t.after(() => rm(tempDir, { recursive: true, force: true }));
  const repo = join(tempDir, "repo");
  await mkdir(repo);
  const run = (...args) => execFileAsync(process.execPath, [runnerPath, ...args]);

  await run("init", repo, "--repo", "org/repo");
  await run("start", repo);
  const before = await loadState(repo);
  assert.equal(before.tasks.length, 1);

  await assert.rejects(run("init", repo, "--repo", "other/repo"), (error) => {
    assert.equal(error.code, 1);
    assert.match(error.stderr, /Ya existe estado/);
    assert.match(error.stderr, /--force/);
    return true;
  });
  const kept = await loadState(repo);
  assert.equal(kept.repo, "org/repo", "init sin --force no pisa el estado existente");
  assert.equal(kept.tasks.length, 1);

  const stateFile = join(repo, ".software-factory", "state.json");
  await writeFile(stateFile, "no-es-json{{{");
  await assert.rejects(run("init", repo, "--repo", "org/repo"), (error) => {
    assert.equal(error.code, 1);
    assert.match(error.stderr, /ilegible/);
    return true;
  });
  assert.equal(await readFile(stateFile, "utf8"), "no-es-json{{{", "el estado corrupto no se pisa en silencio");

  await run("init", repo, "--repo", "org/repo", "--force");
  const reset = await loadState(repo);
  assert.equal(reset.tasks.length, 0, "--force reinicia de verdad, de forma explícita");
});

test("complete requires the report file; --force is the explicit documented alternative", async (t) => {
  const tempDir = await mkdtemp(join(tmpdir(), "sf-report-guard-"));
  t.after(() => rm(tempDir, { recursive: true, force: true }));
  const repo = join(tempDir, "repo");
  await mkdir(repo);
  const run = (...args) => execFileAsync(process.execPath, [runnerPath, ...args]);

  await run("init", repo, "--repo", "org/repo");
  await run("start", repo);
  const state = await loadState(repo);
  const discover = state.tasks.find((task) => task.phase === "discover");

  await assert.rejects(run("complete", repo, discover.id), (error) => {
    assert.equal(error.code, 1);
    assert.match(error.stderr, /Sin informe utilizable en/);
    assert.match(error.stderr, /--force/);
    return true;
  });
  assert.equal((await loadState(repo)).tasks.find((task) => task.id === discover.id).status, "awaiting_agent");

  // Regresión QA: un informe vacio o solo-espacios NO cuenta como informe.
  await writeFile(discover.result_file, "");
  await assert.rejects(run("complete", repo, discover.id), (error) => {
    assert.equal(error.code, 1);
    assert.match(error.stderr, /Sin informe utilizable en/);
    return true;
  }, "el archivo vacio no debe cerrar la tarea");
  await writeFile(discover.result_file, "   \n\t \n");
  await assert.rejects(run("complete", repo, discover.id), (error) => {
    assert.equal(error.code, 1);
    assert.match(error.stderr, /Sin informe utilizable en/);
    return true;
  }, "solo espacios no debe cerrar la tarea");
  assert.equal((await loadState(repo)).tasks.find((task) => task.id === discover.id).status, "awaiting_agent");
  // --force y --fail siguen siendo excepciones explicitas aunque exista vacio.
  await run("complete", repo, discover.id, "--force");
  assert.equal((await loadState(repo)).tasks.find((task) => task.id === discover.id).status, "done");

  // Con informe escrito, el cierre contractual funciona sin --force.
  await run("next", repo); // discover done -> fase plan, emite tarea plan
  const plan = (await loadState(repo)).tasks.find((task) => task.phase === "plan");
  await assert.rejects(run("complete", repo, plan.id), (error) => {
    assert.equal(error.code, 1);
    return true;
  }, "tarea nueva sin informe sigue protegida tras el fix");
  await writeFile(plan.result_file, "# Informe\nhallazgos\n");
  await run("complete", repo, plan.id);
  assert.equal((await loadState(repo)).tasks.find((task) => task.id === plan.id).status, "done");

  // --force cierra sin informe (alternativa explícita).
  await run("next", repo); // plan done -> fase grill, emite tarea grill
  const grill = (await loadState(repo)).tasks.find((task) => task.phase === "grill");
  await run("complete", repo, grill.id, "--force");
  assert.equal((await loadState(repo)).tasks.find((task) => task.id === grill.id).status, "done");
});

test("failed task is not re-claimed, other phase tasks proceed, failure stays visible", async (t) => {
  const tempDir = await mkdtemp(join(tmpdir(), "sf-failed-task-"));
  t.after(() => rm(tempDir, { recursive: true, force: true }));
  const repo = join(tempDir, "repo");
  await mkdir(repo);
  const run = (...args) => execFileAsync(process.execPath, [runnerPath, ...args], { env: ghEnv(tempDir) });

  await run("init", repo, "--repo", "org/repo", "--rounds", "1");
  await run("start", repo);
  await writeFile(join(repo, ".software-factory", "issues-draft.json"),
    JSON.stringify({ issues: [{ title: "Alpha" }, { title: "Beta" }] }));

  let out = JSON.parse((await run("next", repo)).stdout);
  let iterations = 0;
  while (!(out.phase === "implement" && out.tasks.length === 2) && iterations++ < 30) {
    for (const task of out.tasks || []) await run("complete", repo, task.id, "--force");
    out = JSON.parse((await run("next", repo)).stdout);
  }
  const [first, second] = out.tasks;

  await run("complete", repo, first.id, "--fail");
  const afterFail = JSON.parse((await run("next", repo)).stdout);
  assert.deepEqual(afterFail.tasks.map((task) => task.id), [second.id],
    "la tarea fallida no se re-clama; la pendiente de la fase sí sigue disponible");
  assert.deepEqual(afterFail.failed.map((task) => task.id), [first.id], "el fallo se reporta, no se oculta");

  await run("complete", repo, second.id, "--force");
  const advanced = JSON.parse((await run("next", repo)).stdout);
  assert.equal(advanced.phase, "review", "la fase avanza sin quedar bloqueada por la fallida");
  assert.ok(!advanced.tasks.some((task) => task.id === first.id), "review no re-emite la fallida");

  const state = await loadState(repo);
  assert.match(state.notes, /tarea\(s\) fallida\(s\)/);
  assert.match(state.notes, new RegExp(`fallida\\(s\\): ${first.id}`));
  const events = await readFile(join(repo, ".software-factory", "events.log"), "utf8");
  assert.match(events, /avanza con fallidas/);
  const status = JSON.parse((await run("status", repo)).stdout);
  assert.equal(status.tasks_failed, 1);
  assert.match(status.notes, /fallida/);
});

test("gh exit code decides: stderr noise with 0 succeeds, exit 1 aborts, garbage stdout persists nothing", async (t) => {
  const tempDir = await mkdtemp(join(tmpdir(), "sf-gh-exit-"));
  t.after(() => rm(tempDir, { recursive: true, force: true }));
  const repo = join(tempDir, "repo");
  await mkdir(repo);
  const runWith = (mode, ...args) => execFileAsync(process.execPath, [runnerPath, ...args], {
    env: ghEnv(tempDir, mode || undefined),
  });
  await runWith("", "init", repo, "--repo", "org/repo");
  await runWith("", "start", repo);
  await writeFile(join(repo, ".software-factory", "issues-draft.json"), JSON.stringify({ issues: [{ title: "Alpha" }] }));

  // Regresión del heurístico por regex: "could not" en stderr con exit 0 NO es error.
  const ok = JSON.parse((await runWith("", "issues", repo)).stdout);
  assert.equal(ok.created, 1);
  assert.equal((await loadState(repo)).issues.length, 1);

  // exit != 0: el fallo se registra sin abortar y nada nuevo se persiste.
  const stateFile = join(repo, ".software-factory", "state.json");
  await writeFile(join(repo, ".software-factory", "issues-draft.json"), JSON.stringify({ issues: [{ title: "Beta" }] }));
  const failed = JSON.parse((await runWith("fail", "issues", repo)).stdout);
  assert.equal(failed.created, 0);
  assert.equal(failed.failures.length, 1);
  assert.equal(failed.failures[0].title, "Beta");
  assert.deepEqual((await loadState(repo)).issues.map((i) => i.title), ["Alpha"], "exit!=0 no persiste nada nuevo");

  // exit 0 con stdout inservible: error accionable, nada persistido.
  await writeFile(join(repo, ".software-factory", "issues-draft.json"), JSON.stringify({ issues: [{ title: "Gamma" }] }));
  const garbage = JSON.parse((await runWith("garbage", "issues", repo)).stdout);
  assert.match(garbage.failures[0].error, /no utilizable/);
  assert.deepEqual((await loadState(repo)).issues.map((i) => i.title), ["Alpha"]);
  assert.ok(existsSync(stateFile), "state.json sigue íntegro");
});

test("repoSlug validates owner/name before touching gh; invalid slug creates nothing", async (t) => {
  assert.equal(repoSlug({ repo: "org/repo" }), "org/repo");
  for (const bad of [{ repo: "org" }, { repo: "" }, { repo: "a/b/c" }, {}]) {
    assert.throws(() => repoSlug(bad), /repo GitHub válido/);
  }
  const tempDir = await mkdtemp(join(tmpdir(), "sf-slug-guard-"));
  t.after(() => rm(tempDir, { recursive: true, force: true }));
  const repo = join(tempDir, "repo");
  await mkdir(join(repo, ".software-factory"), { recursive: true });
  const calls = [];
  const state = { repo_path: repo, repo: "", issues: [] };
  await writeFile(join(repo, ".software-factory", "issues-draft.json"), JSON.stringify({ issues: [{ title: "Alpha" }] }));
  await assert.rejects(
    createIssuesFromDraft(state, { runGh: async (args) => { calls.push(args); return "https://github.com/x/y/issues/1"; } }),
    /sf\.mjs init/,
    "el mensaje debe ser accionable",
  );
  assert.deepEqual(calls, [], "ninguna llamada gh con slug inválido");
  // dry-run también falla rápido con config inválida
  await assert.rejects(createIssuesFromDraft(state, { dryRun: true }));
});

test("saveState writes state.json atomically leaving no .tmp residue", async (t) => {
  const tempDir = await mkdtemp(join(tmpdir(), "sf-atomic-"));
  t.after(() => rm(tempDir, { recursive: true, force: true }));
  const repo = join(tempDir, "repo");
  await mkdir(repo);
  const run = (...args) => execFileAsync(process.execPath, [runnerPath, ...args]);
  await run("init", repo, "--repo", "org/repo");
  await run("start", repo);
  const sfDir = join(repo, ".software-factory");
  const files = await readdir(sfDir);
  assert.deepEqual(files.filter((name) => name.endsWith(".tmp")), [], "sin .tmp residuales");
  const state = JSON.parse(await readFile(join(sfDir, "state.json"), "utf8"));
  assert.equal(state.repo, "org/repo");
  assert.equal(state.tasks.length, 1);
});

test("grill prompt is fully Spanish (no CJK glyphs)", async () => {
  const src = await readFile(join(extensionDir, "runner", "lib", "prompts.mjs"), "utf8");
  assert.doesNotMatch(src, /[\u3400-\u9FFF\u3000-\u303F\uFF00-\uFFEF]/, "prompts.mjs no debe contener caracteres CJK");
  const text = grillPrompt({ repo_path: "C:\\repos\\demo" }, { round: 1, id: "r1-grill-01" });
  assert.match(text, /qué supuesto es frágil/);
});

test("plan reads the discover report from the discover task result_file (single source)", () => {
  const repo = join(tmpdir(), "sf-plan-src");
  const discoverTask = { id: "r2-discover-07", phase: "discover", round: 2, result_file: join(repo, ".software-factory", "results", "r2-discover-07.md") };
  const state = { repo_path: repo, repo: "org/repo", round: 2, tasks: [discoverTask] };
  const discover = discoverPrompt(state, discoverTask);
  assert.doesNotMatch(discover, /discover-r\d/, "discover ya no pide un segundo fichero que complete no valida");
  assert.ok(discover.includes(discoverTask.result_file));
  const plan = planPrompt(state, { id: "r2-plan-08", phase: "plan", round: 2, result_file: join(repo, "x.md") });
  assert.ok(plan.includes(discoverTask.result_file), "plan lee el informe que complete exige");
  assert.doesNotMatch(plan, /discover-r\d/);
});

test("bootstrap prompt without state gives the exact quoted init command", () => {
  const prompt = bootstrapPrompt("C:\\repo con espacios", "C:\\runner\\sf.mjs", null);
  assert.match(prompt, /node "C:\\runner\\sf\.mjs" init "C:\\repo con espacios" --repo owner\/name/);
  assert.doesNotMatch(prompt, /appropriate/);
});

test("init refuses a repo directory that does not exist", async (t) => {
  const tempDir = await mkdtemp(join(tmpdir(), "sf-init-missing-"));
  t.after(() => rm(tempDir, { recursive: true, force: true }));
  const missing = join(tempDir, "no-clonado");
  await assert.rejects(execFileAsync(process.execPath, [runnerPath, "init", missing, "--repo", "org/repo"]), (error) => {
    assert.equal(error.code, 1);
    assert.match(error.stderr, /no existe/);
    return true;
  });
  assert.equal(existsSync(missing), false, "init no crea el directorio de un repo inexistente");
});

test("?repo= allowlist rejects traversal, siblings and symlink escapes; accepts workspace and authorized roots", async (t) => {
  const base = await mkdtemp(join(tmpdir(), "sf-allow-"));
  t.after(() => rm(base, { recursive: true, force: true }));
  const workspace = join(base, "workspace");
  const sub = join(workspace, "pkg");
  const sibling = join(base, "workspace-evil");
  const external = join(base, "external");
  const outside = join(base, "outside");
  for (const dir of [sub, sibling, external, outside]) await mkdir(dir, { recursive: true });
  await mkdir(join(sibling, ".software-factory"));
  await writeFile(join(sibling, ".software-factory", "state.json"), '{"secret":true}');
  let linkOk = true;
  try {
    await symlink(outside, join(workspace, "escape"), "junction");
  } catch {
    linkOk = false;
  }
  const allowlist = createRepoAllowlist({ defaultRepo: () => workspace, env: {} });
  const touched = [];
  const server = createFactoryServer({
    extensionDir,
    defaultRepo: () => workspace,
    resolveRepo: (requested) => allowlist.resolve(requested),
    readState: async (repo) => { touched.push(repo); return { repo }; },
    ensureWatch: (repo) => touched.push(repo),
    applyAction: async (repo) => { touched.push(repo); return { repo }; },
    subscribe: (repo) => touched.push(repo),
  });
  await listen(server);
  t.after(() => closeServer(server));
  const baseUrl = `http://127.0.0.1:${server.address().port}`;
  const token = await actionTokenFrom(server);
  const get = (path, repo) => fetch(`${baseUrl}${routeWithRepo(path, repo)}`);
  const post = (repo) => fetch(`${baseUrl}${routeWithRepo("/action", repo)}`, {
    method: "POST",
    headers: { "Content-Type": "application/json", "x-sf-action-token": token },
    body: JSON.stringify({ actionName: "pause", input: {} }),
  });

  const rejected = [
    join(workspace, "..", "outside"),
    sibling,
    external,
    "relative/path",
    join(workspace, "missing"),
    `${workspace}\0`,
  ];
  if (linkOk) rejected.push(join(workspace, "escape"));
  for (const repo of rejected) {
    for (const response of [await get("/state", repo), await get("/events", repo), await post(repo)]) {
      assert.equal(response.status, 400, repo);
      assert.deepEqual(await response.json(), { error: "sf_repo_no_permitido" });
    }
  }
  assert.deepEqual(touched, [], "rutas fuera del allowlist no tocan disco ni estado");

  assert.equal((await (await get("/state", "")).json()).repo, workspace);
  assert.equal((await (await get("/state", sub)).json()).repo, allowlist.resolve(sub));
  assert.equal((await post(sub)).status, 200);

  allowlist.authorize(external);
  assert.equal((await (await get("/state", external)).json()).repo, allowlist.resolve(external));
  assert.equal((await get("/state", sibling)).status, 400, "autorizar una raíz no abre las demás");
});

test("SF_ALLOWED_ROOTS authorizes extra roots at startup", async (t) => {
  const base = await mkdtemp(join(tmpdir(), "sf-env-"));
  t.after(() => rm(base, { recursive: true, force: true }));
  const workspace = join(base, "ws");
  const extra = join(base, "extra");
  await mkdir(workspace);
  await mkdir(extra);
  const allowlist = createRepoAllowlist({ defaultRepo: () => workspace, env: { SF_ALLOWED_ROOTS: extra } });
  assert.equal(allowlist.resolve(extra), allowlist.resolve(join(extra, ".")));
  assert.throws(() => createRepoAllowlist({ defaultRepo: () => workspace, env: {} }).resolve(extra), /sf_repo_no_permitido/);
});

test("canvas writeStatus delegates to atomic saveState and interleaved writes keep state.json parseable", async (t) => {
  const src = await readFile(join(extensionDir, "extension.mjs"), "utf8");
  assert.match(src, /await saveState\(repoDir, state\)/);
  assert.doesNotMatch(src, /writeFile/);

  const repo = await mkdtemp(join(tmpdir(), "sf-writestatus-"));
  t.after(() => rm(repo, { recursive: true, force: true }));
  await saveState(repo, { status: "idle", tasks: [{ id: "t1", status: "open" }], notes: ["keep"] });
  const statePath = join(repo, ".software-factory", "state.json");
  // Misma mutación que writeStatus: loadState -> status -> saveState.
  const writeStatus = async (status) => {
    const s = await loadState(repo);
    s.status = status;
    return saveState(repo, s);
  };
  const statuses = ["running", "paused", "running", "paused", "done", "running"];
  // Secuencial: el rename concurrente sobre un destino abierto da EPERM en Windows.
  for (let k = 0; k < 5; k++) {
    for (const s of statuses) {
      await writeStatus(s);
      JSON.parse(await readFile(statePath, "utf8"));
    }
  }
  const final = JSON.parse(await readFile(statePath, "utf8"));
  assert.equal(final.status, statuses.at(-1));
  assert.deepEqual(final.tasks, [{ id: "t1", status: "open" }]);
  assert.deepEqual(final.notes, ["keep"]);
  const leftovers = (await readdir(join(repo, ".software-factory"))).filter((n) => n.endsWith(".tmp"));
  assert.deepEqual(leftovers, []);
});
