// Regresiones de UI/app: ui.mjs con un DOM mínimo, app.mjs con fetch/EventSource
// simulados y extension.mjs/index.html por validación textual (sin SDK).
// Mutation-check documentado: sustituir textContent por innerHTML en ui.mjs, quitar
// la comprobación https: de issueHref, o cambiar la clave "repo" de createInitPayload
// debe hacer fallar estos tests.
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

import { createInitPayload, renderState, routeWithRepo } from "../../ui.mjs";

const extDir = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const read = (name) => readFileSync(join(extDir, name), "utf8");

class El {
  constructor(tag) {
    this.tag = tag;
    this.children = [];
    this.className = "";
    this._text = "";
    this.innerHTMLSet = false;
  }
  get textContent() { return this._text + this.children.map((c) => c.textContent).join(""); }
  set textContent(v) { this._text = String(v); this.children = []; }
  set innerHTML(_v) { this.innerHTMLSet = true; }
  appendChild(c) { this.children.push(c); }
  replaceChildren() { this.children = []; this._text = ""; }
}
function fakeDoc() {
  const els = {};
  return {
    els,
    getElementById(id) { return (els[id] ||= new El("div")); },
    createElement(tag) { return new El(tag); },
  };
}
const walk = (el, out = []) => { out.push(el); el.children.forEach((c) => walk(c, out)); return out; };

test("createInitPayload usa claves del contrato init (repo = owner/repo de GitHub)", () => {
  assert.deepEqual(
    createInitPayload({ repo: "o/r", project: "5", projectOwner: "me", rounds: 2 }),
    { repo: "o/r", project: "5", project_owner: "me", rounds: 2 },
  );
});

test("routeWithRepo codifica el repo y omite query vacía", () => {
  assert.equal(routeWithRepo("/state", ""), "/state");
  assert.equal(routeWithRepo("/state", "C:\\a b&c"), `/state?repo=${encodeURIComponent("C:\\a b&c")}`);
});

test("renderState: estado nulo muestra estados degradados", () => {
  const doc = fakeDoc();
  renderState(null, doc);
  assert.equal(doc.els.status.textContent, "sin estado");
  assert.equal(doc.els.round.textContent, "");
  assert.equal(doc.els.pipeline.children.length, 6);
  assert.match(doc.els.tasks.textContent, /sin tareas/);
  assert.equal(doc.els.issues.textContent, "Ninguna todavía.");
});

test("renderState: contenido no confiable como texto y solo enlaces https", () => {
  const doc = fakeDoc();
  const evil = "<img src=x onerror=alert(1)>";
  renderState({
    status: "running", phase: "implement", round: 1, max_rounds: 3,
    tasks: [{ id: "t1", phase: "implement", status: "bogus", title: evil }],
    issues: [
      { number: 1, title: evil, url: "https://github.com/o/r/issues/1" },
      { number: 2, title: "js", url: "javascript:alert(1)" },
      { number: 3, title: "http", url: "http://x.test/" },
      { number: 4, title: "bad", url: "no es url" },
    ],
  }, doc);
  const all = [...walk(doc.els.tasks), ...walk(doc.els.issues), ...walk(doc.els.pipeline)];
  assert.ok(all.every((e) => !e.innerHTMLSet));
  assert.ok(doc.els.tasks.textContent.includes(evil));
  assert.equal(doc.els.round.textContent, "round 1 / 3");
  const dot = walk(doc.els.tasks).find((e) => e.className.startsWith("dot"));
  assert.equal(dot.className, "dot pending");
  const rows = doc.els.issues.children;
  assert.equal(rows[0].children[0].tag, "a");
  assert.equal(rows[0].children[0].href, "https://github.com/o/r/issues/1");
  assert.equal(rows[0].children[0].rel, "noopener noreferrer");
  for (const row of rows.slice(1)) {
    assert.equal(row.children[0].tag, "span");
    assert.equal(row.children[0].href, undefined);
  }
  assert.ok(doc.els.issues.textContent.includes(evil));
});

test("renderState: marca fase activa y fases completadas", () => {
  const doc = fakeDoc();
  renderState({ status: "running", phase: "grill", tasks: [{ phase: "plan", status: "done" }] }, doc);
  const cls = doc.els.pipeline.children.map((c) => c.className);
  assert.deepEqual(cls.map((c) => c.includes("donep")), [true, true, false, false, false, false]);
  assert.ok(cls[2].includes("active"));
  assert.equal(doc.els.pipeline.children[1].children[1].textContent, "1/1 tareas");
});

async function runApp({ search = "", token = "tok", state = { status: "running", phase: "plan" }, fetchImpl } = {}) {
  const els = {};
  const mk = (id) => (els[id] ||= Object.assign(new El("div"), { value: "", onclick: null, scrollTop: 0, scrollHeight: 7 }));
  for (const id of ["status", "round", "pipeline", "tasks", "issues", "log", "play", "pause", "initBtn", "ghrepo", "project", "projectOwner", "rounds"]) mk(id);
  const calls = [];
  const sources = [];
  class FakeES {
    constructor(url) { this.url = url; sources.push(this); }
  }
  const g = {
    document: {
      getElementById: (id) => mk(id),
      createElement: (t) => new El(t),
      querySelector: () => (token === null ? null : { content: token }),
    },
    location: { search },
    EventSource: FakeES,
    fetch: async (url, opts) => {
      calls.push({ url, opts });
      if (fetchImpl) return fetchImpl(url, opts);
      return { json: async () => (url.startsWith("/action") ? { status: "ok" } : state) };
    },
  };
  for (const k of Object.keys(g)) Object.defineProperty(globalThis, k, { value: g[k], configurable: true, writable: true });
    const uiUrl = pathToFileURL(join(extDir, "ui.mjs")).href;
    const src = read("app.mjs").replace('"/ui.mjs"', JSON.stringify(uiUrl)) + `\n//${Math.random()}`;
    await import(`data:text/javascript,${encodeURIComponent(src)}`);
  return { els, calls, sources };
}

test("app.mjs: carga /state, renderiza y se suscribe a /events con repo", async () => {
  const { els, calls, sources } = await runApp({ search: "?repo=C%3A%5Cx" });
  assert.equal(calls[0].url, "/state?repo=C%3A%5Cx");
  assert.equal(els.status.textContent, "running");
  assert.equal(sources[0].url, "/events?repo=C%3A%5Cx");
  sources[0].onmessage({ data: JSON.stringify({ status: "paused", phase: "plan" }) });
  assert.equal(els.status.textContent, "paused");
  sources[0].onerror();
  assert.match(els.log.textContent, /conexión SSE perdida/);
});

test("app.mjs: status missing renderiza estado vacío", async () => {
  const { els } = await runApp({ state: { status: "missing" } });
  assert.equal(els.status.textContent, "sin estado");
});

test("app.mjs: acciones play/pause/init envían token y payload; errores se registran", async () => {
  const { els, calls } = await runApp();
  await els.play.onclick();
  const play = calls.find((c) => c.url === "/action");
  assert.equal(play.opts.method, "POST");
  assert.equal(play.opts.headers["x-sf-action-token"], "tok");
  assert.deepEqual(JSON.parse(play.opts.body), { actionName: "play", input: {} });
  assert.match(els.log.textContent, /✔ ok/);

  els.ghrepo.value = "o/r"; els.project.value = "3"; els.projectOwner.value = "me"; els.rounds.value = "x";
  await els.initBtn.onclick();
  const init = JSON.parse(calls.at(-1).opts.body);
  assert.deepEqual(init, { actionName: "init", input: { repo: "o/r", project: "3", project_owner: "me", rounds: 3 } });

  await els.pause.onclick();
  assert.equal(JSON.parse(calls.at(-1).opts.body).actionName, "pause");
});

test("app.mjs: respuesta con error y fallo de fetch inicial se registran en el log", async () => {
  const bad = await runApp({
    fetchImpl: async (url) => ({ json: async () => (url.startsWith("/action") ? { error: "sf_csrf_token_invalido" } : { status: "running" }) }),
  });
  await bad.els.play.onclick();
  assert.match(bad.els.log.textContent, /⚠ sf_csrf_token_invalido/);

  const down = await runApp({ fetchImpl: async () => { throw new Error("boom"); } });
  assert.match(down.els.log.textContent, /error: boom/);
  assert.equal(down.sources.length, 0);
});

test("extension.mjs: acciones, init_factory (github_repo vs repo-dir) y guardas", () => {
  const src = read("extension.mjs");
  for (const name of ["get_state", "play", "pause", "init_factory", "next_work"]) {
    assert.ok(src.includes(`name: "${name}"`), name);
  }
  assert.match(src, /applyAction\(repoDir, "init", \{\s*repo: input\?\.github_repo,/);
  assert.match(src, /const repoDir = repoFrom\(input\)/);
  assert.match(src, /const repoFrom = \(input\) => allowlist\.resolve\(input\?\.repo\)/);
  assert.match(src, /initRunnerArgs\(repoDir, input\)/);
  assert.match(src, /startGuardError\(await readState\(repoDir\)\)/);
  assert.match(src, /throw new CanvasError\("sf_unknown_action"/);
  assert.equal((src.match(/windowsHide: true/g) || []).length, 2);
  assert.match(src, /setInterval\([\s\S]*2500\)/);
  assert.match(src, /clearInterval\(timer\)/);
  assert.match(src, /server\.listen\(0, "127\.0\.0\.1"/);
});

test("index.html: ids que usan app.mjs/ui.mjs, token CSRF y módulo", () => {
  const html = read("index.html");
  const ids = new Set([...(read("app.mjs") + read("ui.mjs")).matchAll(/getElementById\("(\w+)"\)/g)].map((m) => m[1]));
  assert.ok(ids.size >= 10);
  for (const id of ids) assert.ok(html.includes(`id="${id}"`), id);
  assert.ok(html.includes('<meta name="sf-action-token" content="__SF_ACTION_TOKEN__"'));
  assert.ok(html.includes('<script type="module" src="/app.mjs">'));
});

test("app.mjs: la tarjeta de arranque se colapsa al haber fábrica y tras play/init", async () => {
  const running = await runApp({ search: "?repo=C%3A%5Cx" });
  assert.equal(running.els.startCard.hidden, true);
  assert.equal(running.els.configToggle.textContent, "Ajustes");
  assert.equal(running.els.configToggle.ariaExpanded, "false");

  const fresh = await runApp({ state: { status: "missing" } });
  assert.notEqual(fresh.els.startCard?.hidden, true);
  await fresh.els.play.onclick();
  assert.equal(fresh.els.startCard.hidden, true);
  fresh.els.configToggle.onclick();
  assert.equal(fresh.els.startCard.hidden, false);
  assert.equal(fresh.els.configToggle.ariaExpanded, "true");
});

test("app.mjs: rounds fuera de rango avisa y se ajusta al rango 1..10", async () => {
  const { els, calls } = await runApp();
  els.ghrepo.value = "o/r";
  els.rounds.value = "-5";
  await els.initBtn.onclick();
  assert.equal(JSON.parse(calls.at(-1).opts.body).input.rounds, 1);
  assert.match(els.log.textContent, /rounds fuera de rango \(-5\): se usa 1/);
});

test("app.mjs: Enter envía carpeta y configuración sin tocar botones", async () => {
  const { els, calls } = await runApp();
  els.repoInput.value = "C:\\x";
  await els.repoInput.onkeydown({ key: "Enter" });
  assert.ok(calls.some((c) => c.url === "/state?repo=C%3A%5Cx"));
  assert.match(els.log.textContent, /repo asignado: C:\\x/);
  const before = calls.length;
  els.repoInput.onkeydown({ key: "Escape" });
  assert.equal(calls.length, before);
  els.ghrepo.value = "o/r";
  await els.ghrepo.onkeydown({ key: "Enter" });
  assert.match(calls.at(-1).url, /^\/action/);
  assert.equal(JSON.parse(calls.at(-1).opts.body).actionName, "init");
});

test("app.mjs: SSE caído muestra «desconectado» y la recuperación lo anuncia", async () => {
  const { els, sources } = await runApp();
  sources[0].onerror();
  assert.equal(els.status.textContent, "desconectado");
  assert.match(els.status.className, /\boff\b/);
  assert.match(els.live.className, /\boff\b/);
  sources[0].onmessage({ data: JSON.stringify({ status: "running", phase: "plan" }) });
  assert.equal(els.status.textContent, "running");
  assert.match(els.log.textContent, /conexión SSE recuperada/);
});

test("app.mjs: errores de acción y de carga aparecen en el banner inline", async () => {
  const bad = await runApp({
    fetchImpl: async (url) => ({ json: async () => (url.startsWith("/action") ? { error: "sf_csrf_token_invalido" } : { status: "running" }) }),
  });
  assert.notEqual(bad.els.actionError?.hidden, false);
  await bad.els.play.onclick();
  assert.equal(bad.els.actionError.hidden, false);
  assert.match(bad.els.actionError.textContent, /sf_csrf_token_invalido/);

  const down = await runApp({ fetchImpl: async () => { throw new Error("boom"); } });
  assert.equal(down.els.actionError.hidden, false);
  assert.match(down.els.actionError.textContent, /boom/);
});

test("app.mjs: la línea pre-flight describe las consecuencias del arranque", async () => {
  const { els } = await runApp({ search: "?repo=C%3A%5Cx" });
  assert.match(els.preFlight.textContent, /Al arrancar se crearán issues y PRs en el repo configurado, hasta 3 rounds/);
  els.ghrepo.value = "o/r";
  els.ghrepo.oninput();
  assert.match(els.preFlight.textContent, /se crearán issues y PRs en o\/r, hasta 3 rounds/);
});
