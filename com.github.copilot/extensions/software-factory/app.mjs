import { createInitPayload, renderState, routeWithRepo } from "/ui.mjs";

const params = new URLSearchParams(location.search);
let repo = params.get("repo") || "";
let events = null;
let sseDown = false;
let loadSeq = 0;
let repoSeq = 0;
const LOG_CAP = 200;

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
  while (element.children.length > LOG_CAP) element.removeChild(element.firstChild);
  element.scrollTop = element.scrollHeight;
}

// Banner de error inline: la página ya está abierta, el registro no es el canal de corrección.
function showError(message) {
  const el = document.getElementById("actionError");
  el.textContent = message;
  el.hidden = false;
}

function clearError() {
  document.getElementById("actionError").hidden = true;
}

function setStartCard(collapsed) {
  document.getElementById("startCard").hidden = collapsed;
  const toggle = document.getElementById("configToggle");
  toggle.textContent = collapsed ? "Ajustes" : "Ocultar ajustes";
  toggle.ariaExpanded = String(!collapsed);
}

function roundsOrDefault(raw) {
  const parsed = Number(raw);
  if (raw === "" || !Number.isFinite(parsed)) return 3;
  return Math.min(10, Math.max(1, Math.round(parsed)));
}

function parseRounds(raw) {
  const parsed = Number(raw);
  if (raw === "" || !Number.isFinite(parsed)) return 3;
  const fixed = Math.min(10, Math.max(1, Math.round(parsed)));
  if (fixed !== parsed) {
    log(`⚠ rounds fuera de rango (${raw}): se usa ${fixed}. Válido: 1 a 10.`);
  }
  return fixed;
}

function updatePreFlight() {
  const el = document.getElementById("preFlight");
  if (!repo) {
    el.textContent = "Asigna la carpeta del workspace para habilitar el arranque de la fábrica.";
    return;
  }
  const ghrepo = document.getElementById("ghrepo").value.trim();
  const rounds = roundsOrDefault(document.getElementById("rounds").value.trim());
  el.textContent = `Al arrancar se crearán issues y PRs en ${ghrepo || "el repo configurado"}, hasta ${rounds} rounds. Puedes pausar en cualquier momento.`;
}

// Token CSRF expuesto por el servidor en el HTML (meta sf-action-token).
const actionToken = document.querySelector('meta[name="sf-action-token"]')?.content || "";

async function action(actionName, input = {}, btn) {
  if (btn) btn.disabled = true;
  clearError();
  try {
    const response = await fetch(routeWithRepo("/action", repo), {
      method: "POST",
      headers: { "Content-Type": "application/json", "x-sf-action-token": actionToken },
      body: JSON.stringify({ actionName, input }),
    });
    const result = await response.json();
    if (result.error) {
      log(`⚠ ${result.error}`);
      showError(`«${actionName}» falló: ${result.error}. Corrige la configuración e inténtalo de nuevo.`);
    } else {
      log(`✔ ${result.status || JSON.stringify(result).slice(0, 120)}`);
      if (actionName === "play" || actionName === "init") setStartCard(true);
    }
    return result;
  } catch (error) {
    log(`error: ${error.message}`);
    showError(`El runner no respondió: ${error.message}. Revisa que la extensión sigue activa e inténtalo de nuevo.`);
    return null;
  } finally {
    if (btn) btn.disabled = false;
  }
}

function applyConfig() {
  const ghrepo = document.getElementById("ghrepo").value.trim();
  if (ghrepo && !/^[\w.-]+\/[\w.-]+$/.test(ghrepo)) {
    log("⚠ owner/repo no válido: usa el formato owner/name (ej. svg153/mi-repo)");
    showError("El repositorio debe tener el formato owner/name (ej. svg153/mi-repo).");
    return undefined;
  }
  clearError();
  return action("init", createInitPayload({
    repo: ghrepo,
    project: document.getElementById("project").value,
    projectOwner: document.getElementById("projectOwner").value,
    rounds: parseRounds(document.getElementById("rounds").value.trim()),
  }), document.getElementById("initBtn"));
}

document.getElementById("play").onclick = () => action("play", {}, document.getElementById("play"));
document.getElementById("pause").onclick = () => action("pause", {}, document.getElementById("pause"));
document.getElementById("initBtn").onclick = applyConfig;
document.getElementById("configToggle").onclick = () => setStartCard(!document.getElementById("startCard").hidden);

function showRepoPath(text) {
  const repoPathEl = document.getElementById("repopath");
  if (!repoPathEl) return;
  repoPathEl.textContent = repo
    ? `Carpeta local: ${text}`
    : "Sin carpeta asignada: escribe la ruta de tu workspace git en «Arrancar la fábrica» y pulsa «Usar carpeta».";
}

async function loadRepo() {
  const seq = ++loadSeq;
  if (events) events.close?.();
  events = null;
  const state = await (await fetch(routeWithRepo("/state", repo))).json();
  if (seq !== loadSeq) return null;
  if (state.error) throw new Error(state.error);
  showRepoPath(state.repo || repo);
  const current = state.status === "missing" ? null : state;
  renderState(current);
  if (current) setStartCard(true);
  events = new EventSource(routeWithRepo("/events", repo));
  events.onmessage = (event) => {
    if (sseDown) {
      sseDown = false;
      log("conexión SSE recuperada");
    }
    renderState(JSON.parse(event.data));
  };
  events.onerror = () => {
    sseDown = true;
    log("conexión SSE perdida, reintentando…");
    const statusEl = document.getElementById("status");
    statusEl.textContent = "desconectado";
    statusEl.className = "status off";
    document.getElementById("live").className = "live off";
  };
}

async function applyRepoPath() {
  const value = document.getElementById("repoInput").value.trim();
  if (!value) {
    log("escribe primero la ruta absoluta del repo");
    return;
  }
  const seq = ++repoSeq;
  const prev = repo;
  repo = value;
  try {
    await loadRepo();
    if (seq !== repoSeq) return;
    log(`repo asignado: ${value}`);
    clearError();
    updatePreFlight();
  } catch (error) {
    if (seq !== repoSeq) return;
    repo = prev;
    log(`error: ${error.message}`);
    showError(`No se pudo usar la carpeta «${value}»: ${error.message}. Verifica la ruta e inténtalo de nuevo.`);
  }
}

document.getElementById("setRepo").onclick = applyRepoPath;
document.getElementById("repoInput").onkeydown = (event) => {
  if (event.key === "Enter") return applyRepoPath();
  return undefined;
};
for (const id of ["ghrepo", "project", "projectOwner", "rounds"]) {
  const el = document.getElementById(id);
  el.oninput = updatePreFlight;
  el.onkeydown = (event) => {
    if (event.key === "Enter") return applyConfig();
    return undefined;
  };
}

updatePreFlight();
try {
  await loadRepo();
} catch (error) {
  log(`error: ${error.message}`);
  showError(`El panel no pudo leer el estado actual: ${error.message}. Asigna la carpeta en «Arrancar la fábrica» para reintentar.`);
}
