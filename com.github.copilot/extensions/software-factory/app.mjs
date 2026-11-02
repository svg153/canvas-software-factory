import { createInitPayload, renderState, routeWithRepo } from "/ui.mjs";

const params = new URLSearchParams(location.search);
let repo = params.get("repo") || "";
let events = null;

function log(message) {
  const element = document.getElementById("log");
  element.textContent += `${message}\n`;
  element.scrollTop = element.scrollHeight;
}

// Token CSRF expuesto por el servidor en el HTML (meta sf-action-token).
const actionToken = document.querySelector('meta[name="sf-action-token"]')?.content || "";

async function action(actionName, input = {}) {
  const response = await fetch(routeWithRepo("/action", repo), {
    method: "POST",
    headers: { "Content-Type": "application/json", "x-sf-action-token": actionToken },
    body: JSON.stringify({ actionName, input }),
  });
  const result = await response.json();
  if (result.error) log(`⚠ ${result.error}`);
  else log(`✔ ${result.status || JSON.stringify(result).slice(0, 120)}`);
  return result;
}

document.getElementById("play").onclick = () => action("play");
document.getElementById("pause").onclick = () => action("pause");
document.getElementById("initBtn").onclick = () => action("init", createInitPayload({
  repo: document.getElementById("ghrepo").value,
  project: document.getElementById("project").value,
  projectOwner: document.getElementById("projectOwner").value,
  rounds: Number(document.getElementById("rounds").value) || 3,
}));

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
  repo = value;
  try {
    await loadRepo();
    log(`repo asignado: ${value}`);
  } catch (error) {
    log(`error: ${error.message}`);
  }
};

try {
  await loadRepo();
} catch (error) {
  log(`error: ${error.message}`);
}
