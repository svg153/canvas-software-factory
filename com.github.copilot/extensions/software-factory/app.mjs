import { createInitPayload, renderState, routeWithRepo } from "/ui.mjs";

const params = new URLSearchParams(location.search);
let repo = params.get("repo") || "";
let events = null;

function log(message) {
  const element = document.getElementById("log");
  const row = document.createElement("div");
  row.className = "line"
    + (/^⚠|^error/.test(message) ? " err" : /^✔/.test(message) ? " ok" : "");
  const ts = document.createElement("span");
  ts.className = "ts";
  ts.textContent = new Date().toLocaleTimeString();
  const body = document.createElement("span");
  body.className = "msg";
  body.textContent = message;
  row.appendChild(ts);
  row.appendChild(body);
  element.appendChild(row);
  element.scrollTop = element.scrollHeight;
}

// Token CSRF expuesto por el servidor en el HTML (meta sf-action-token).
const actionToken = document.querySelector('meta[name="sf-action-token"]')?.content || "";

async function action(actionName, input = {}, btn) {
  if (btn) btn.disabled = true;
  try {
    const response = await fetch(routeWithRepo("/action", repo), {
      method: "POST",
      headers: { "Content-Type": "application/json", "x-sf-action-token": actionToken },
      body: JSON.stringify({ actionName, input }),
    });
    const result = await response.json();
    if (result.error) log(`⚠ ${result.error}`);
    else log(`✔ ${result.status || JSON.stringify(result).slice(0, 120)}`);
    return result;
  } finally {
    if (btn) btn.disabled = false;
  }
}

document.getElementById("play").onclick = () => action("play", {}, document.getElementById("play"));
document.getElementById("pause").onclick = () => action("pause", {}, document.getElementById("pause"));
document.getElementById("initBtn").onclick = () => {
  const ghrepo = document.getElementById("ghrepo").value.trim();
  if (ghrepo && !/^[\w.-]+\/[\w.-]+$/.test(ghrepo)) {
    log("⚠ owner/repo no válido: usa el formato owner/name (ej. svg153/mi-repo)");
    return undefined;
  }
  return action("init", createInitPayload({
    repo: ghrepo,
    project: document.getElementById("project").value,
    projectOwner: document.getElementById("projectOwner").value,
    rounds: Number(document.getElementById("rounds").value) || 3,
  }), document.getElementById("initBtn"));
};

function showRepoPath(text) {
  const repoPathEl = document.getElementById("repopath");
  if (!repoPathEl) return;
  repoPathEl.textContent = repo
    ? `📁 ${text}`
    : "⚠ Sin repo asignado: escribe la ruta de tu workspace git abajo y pulsa «Usar repo»";
}

async function loadRepo() {
  if (events) events.close?.();
  const state = await (await fetch(routeWithRepo("/state", repo))).json();
  if (state.error) throw new Error(state.error);
  showRepoPath(state.repo || repo);
  renderState(state.status === "missing" ? null : state);
  events = new EventSource(routeWithRepo("/events", repo));
  events.onmessage = (event) => renderState(JSON.parse(event.data));
  events.onerror = () => log("conexión SSE perdida, reintentando…");
}

document.getElementById("setRepo").onclick = async () => {
  const value = document.getElementById("repoInput").value.trim();
  if (!value) {
    log("escribe primero la ruta absoluta del repo");
    return;
  }
  const prev = repo;
  repo = value;
  try {
    await loadRepo();
    log(`repo asignado: ${value}`);
  } catch (error) {
    repo = prev;
    log(`error: ${error.message}`);
  }
};

try {
  await loadRepo();
} catch (error) {
  log(`error: ${error.message}`);
}
