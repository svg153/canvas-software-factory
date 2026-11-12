import { createInitPayload, renderGithub, renderState, routeWithRepo } from "/ui.mjs";

const params = new URLSearchParams(location.search);
let repo = params.get("repo") || "";
let events = null;
let sseDown = false;
let loadSeq = 0;
let repoSeq = 0;
let lastState = null;
let lastGithub = null;
const LOG_CAP = 200;
const STORE_PREFIX = "sf.";
const TAB_NAMES = ["pipeline", "board", "graph", "order"];

// Persistencia defensiva: sin localStorage (modo privado, tests) todo es no-op.
function storeGet(key) {
  try { return localStorage.getItem(STORE_PREFIX + key) ?? ""; } catch { return ""; }
}
function storeSet(key, value) {
  try { localStorage.setItem(STORE_PREFIX + key, String(value)); } catch { /* sin almacenamiento */ }
}

// Números de issue conocidos por el state que ya NO están entre las abiertas de
// GitHub: alimentan la columna Done del tablero (solo si hay lectura reciente).
function closedNumbers(state) {
  if (!lastGithub || !Array.isArray(lastGithub.issues) || !state?.issues) return null;
  const open = new Set(lastGithub.issues.map((i) => Number(i.number)));
  const closed = new Set();
  for (const i of state.issues) {
    const n = Number(i.number);
    if (Number.isFinite(n) && !open.has(n)) closed.add(n);
  }
  return closed;
}

function renderAll() {
  renderState(lastState, document, closedNumbers(lastState));
}

function relTime(ts) {
  const s = Math.floor((Date.now() - ts) / 1000);
  if (s < 45) return "ahora";
  if (s < 90) return "hace 1 min";
  if (s < 5400) return `hace ${Math.round(s / 60)} min`;
  if (s < 86400) return `hace ${Math.round(s / 3600)} h`;
  return new Date(ts).toLocaleDateString();
}

function refreshLogTimes(element) {
  for (const line of element.children) {
    if (line._ts && line.children?.[0]) line.children[0].textContent = relTime(line._ts);
  }
}

function log(message) {
  const element = document.getElementById("log");
  // Auto-scroll solo si el usuario estaba en el fondo: subir a releer no debe rebotarte abajo.
  const atBottom = element.scrollHeight - element.scrollTop - (element.clientHeight ?? 0) <= 40;
  const row = document.createElement("div");
  row.className = "line"
    + (/^⚠|^error/.test(message) ? " err" : /^✔/.test(message) ? " ok" : "");
  const ts = document.createElement("span");
  ts.className = "ts";
  ts.textContent = "ahora";
  const body = document.createElement("span");
  body.className = "msg";
  body.textContent = message;
  row._ts = Date.now();
  row.appendChild(ts);
  row.appendChild(body);
  element.appendChild(row);
  while (element.children.length > LOG_CAP) element.removeChild(element.firstChild);
  refreshLogTimes(element);
  if (atBottom) element.scrollTop = element.scrollHeight;
}

// Banner de error inline: la página ya está abierta, el registro no es el canal de corrección.
// Se autocierra a los 8 s (salvo problemas de token, que requieren acción del usuario) y
// siempre lleva botón ✕: el setter de textContent borra los hijos, así que se re-acopla.
let errorClose = null;
function showError(message) {
  const el = document.getElementById("actionError");
  el.textContent = message;
  if (!errorClose) {
    errorClose = document.createElement("button");
    errorClose.className = "errclose";
    errorClose.title = "Cerrar aviso";
    errorClose.textContent = "✕";
    errorClose.onclick = () => clearError();
  }
  el.appendChild(errorClose);
  el.hidden = false;
  if (!/csrf|token/.test(message)) {
    const timer = setTimeout(clearError, 8000);
    timer.unref?.(); // no mantiene vivo el proceso en tests Node
  }
}

function clearError() {
  document.getElementById("actionError").hidden = true;
}

function setStartCard(collapsed) {
  document.getElementById("startCard").hidden = collapsed;
  const toggle = document.getElementById("configToggle");
  toggle.textContent = collapsed ? "Ajustes" : "Ocultar ajustes";
  toggle.ariaExpanded = String(!collapsed);
  storeSet("startCard", collapsed ? "1" : "0");
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

// El token se obtiene de /token (mismo origen); no va incrustado en el HTML.
// Si /token falla (server caído) el panel sigue cargando y lo muestra en el log.
let actionToken = "";
try {
  actionToken = (await (await fetch("/token")).json()).token || "";
} catch (error) {
  log(`error: ${error.message}`);
}

async function action(actionName, input = {}, btn) {
  if (btn) {
    btn.disabled = true;
    btn.classList?.add("busy"); // spinner CSS en .btn.busy (respeta prefers-reduced-motion)
  }
  clearError();
  try {
    const response = await fetch(routeWithRepo("/action", repo), {
      method: "POST",
      headers: { "Content-Type": "application/json", "x-sf-token": actionToken },
      body: JSON.stringify({ actionName, input }),
    });
    const result = await response.json();
    if (result.error) {
      log(`⚠ ${result.error}${result.message ? `: ${result.message}` : ""}`);
      showError(`«${actionName}» falló: ${result.error}. Corrige la configuración e inténtalo de nuevo.`);
    } else {
      log(`✔ ${result.status || JSON.stringify(result).slice(0, 120)}`);
      if (result.needs_force) log(`el repo ya tiene estado: marca «Forzar reinicio» y vuelve a pulsar Init solo si quieres perder el progreso`);
      if (actionName === "play" || actionName === "init") setStartCard(true);
    }
    return result;
  } catch (error) {
    log(`error: ${error.message}`);
    showError(`El runner no respondió: ${error.message}. Revisa que la extensión sigue activa e inténtalo de nuevo.`);
    return null;
  } finally {
    if (btn) {
      btn.disabled = false;
      btn.classList?.remove("busy");
    }
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
  persistConfig();
  return action("init", createInitPayload({
    repo: ghrepo,
    project: document.getElementById("project").value,
    projectOwner: document.getElementById("projectOwner").value,
    rounds: parseRounds(document.getElementById("rounds").value.trim()),
    force: document.getElementById("forceInit")?.checked,
  }), document.getElementById("initBtn"));
}

document.getElementById("play").onclick = () => action("play", {}, document.getElementById("play"));
document.getElementById("pause").onclick = () => action("pause", {}, document.getElementById("pause"));
document.getElementById("initBtn").onclick = applyConfig;
document.getElementById("configToggle").onclick = () => setStartCard(!document.getElementById("startCard").hidden);
document.getElementById("detectBtn").onclick = () => autofill();
document.getElementById("ghBtn").onclick = () => refreshGithub();
document.getElementById("importBtn").onclick = () => importExisting();
document.getElementById("createBoardBtn").onclick = async () => {
  const result = await action("create_project");
  if (result && !result.error) {
    log(result.created
      ? `board creado: Project #${result.project_id}${result.url ? ` — ${result.url}` : ""}${(result.failures || []).length ? ` (avisos: ${result.failures.join("; ")})` : ""}`
      : `ya había board vinculado: #${result.project_id}`);
    await loadRepo().catch(() => {}); // refresca state (project_id nuevo) sin perder SSE
  }
};
document.getElementById("syncBoardBtn").onclick = async () => {
  const result = await action("sync_project");
  if (result && !result.error) log(`sync board: ${result.updated} item(s) actualizados${result.failures ? `, ${result.failures} fallo(s)` : ""}`);
};

// Pestañas Pipeline / Tablero / Grafo / Orden de merge.
const tabButtons = [...(document.getElementById("tabs")?.children || [])];
function selectTab(name, { user = true } = {}) {
  for (const btn of tabButtons) btn.classList.toggle("active", btn.dataset.tab === name);
  for (const id of TAB_NAMES) {
    const section = document.getElementById(`tab-${id}`);
    if (section) section.hidden = id !== name;
  }
  if (user) {
    storeSet("tab", name);
    try { location.hash = `tab=${name}`; } catch { /* entorno sin hash */ }
  }
}
for (const btn of tabButtons) btn.addEventListener("click", () => selectTab(btn.dataset.tab));

// Filtro compartido Tablero/Grafo/Orden: ui.mjs lee #tabFilter al renderizar.
document.getElementById("tabFilter").oninput = () => renderAll();

// Vaciar el feed sin recargar el panel.
document.getElementById("clearLogBtn").onclick = () => {
  document.getElementById("log").replaceChildren();
};

// #90: ver el estado real del repo en GitHub (issues/PRs abiertos) y poder continuar
// trabajo existente en lugar de empezar siempre de cero.
async function refreshGithub() {
  const result = await action("github_status");
  if (!result || result.error) return result;
  renderGithub(result);
  lastGithub = result;
  renderAll();
  log(`github${result.slug ? ` (${result.slug})` : ""}: ${result.issues?.length ?? 0} issues abiertas, ${result.pulls?.length ?? 0} PRs${result.note ? ` — ${result.note}` : ""}`);
  return result;
}

// Vincula las issues abiertas al run: la fase issues no las duplicará al crear.
async function importExisting() {
  const result = await action("import_issues");
  if (!result || result.error) return result;
  log(`vinculadas ${result.imported} de ${result.open} issues abiertas (no se duplicarán al crear)`);
  return result;
}

// #82/#83: rellena owner/repo desde el remote origin y el Project vinculado al repo.
async function autofill() {
  const result = await action("autofill");
  if (!result || result.error) return result;
  if (result.github_repo) {
    document.getElementById("ghrepo").value = result.github_repo;
    log(`owner/repo detectado: ${result.github_repo}`);
  } else {
    log(`owner/repo: ${result.note || "sin detectar"} — escríbelo a mano si hace falta`);
  }
  const projects = result.projects || [];
  if (projects.length === 1) {
    document.getElementById("project").value = String(projects[0].number);
    document.getElementById("projectOwner").value = projects[0].owner || "";
    log(`Project detectado: #${projects[0].number} «${projects[0].title}»`);
  } else if (projects.length > 1) {
    log(`varios Projects: ${projects.map((p) => `#${p.number} ${p.title}`).join(", ")} — escribe el nº que quieras usar`);
  } else if (result.github_repo) {
    log(result.note ? `Project sin detectar: ${result.note}` : "el repo no tiene ningún Project vinculado; deja el campo vacío");
  }
  return result;
}

document.getElementById("ideaBtn").onclick = async () => {
  const input = document.getElementById("ideaText");
  const idea = input.value.trim();
  if (!idea) { log("⚠ escribe una idea antes de pulsar Añadir idea"); return; }
  const result = await action("add_idea", { idea });
  if (result && !result.error) input.value = "";
};

document.getElementById("intakeBtn").onclick = () => action("run_intake");

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
  const state = await (await fetch(routeWithRepo("/state", repo), { headers: { "x-sf-token": actionToken } })).json();
  if (seq !== loadSeq) return null;
  if (state.error) throw new Error(state.error);
  showRepoPath(state.repo || repo);
  const current = state.status === "missing" ? null : state;
  lastState = current;
  renderAll();
  if (current) setStartCard(true);
  events = new EventSource(`${routeWithRepo("/events", repo)}${repo ? "&" : "?"}token=${encodeURIComponent(actionToken)}`);
  events.onmessage = (event) => {
    if (sseDown) {
      sseDown = false;
      log("conexión SSE recuperada");
    }
    lastState = JSON.parse(event.data);
    renderAll();
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
    await autofillOnSet();
    clearError();
    updatePreFlight();
  } catch (error) {
    if (seq !== repoSeq) return;
    repo = prev;
    log(`error: ${error.message}`);
    showError(`No se pudo usar la carpeta «${value}»: ${error.message}. Verifica la ruta e inténtalo de nuevo.`);
  }
}

// Al asignar un repo, rellenar owner/repo (y Project) salvo que el usuario haya
// editado el campo a mano: solo sobrescribimos vacío o nuestro propio valor previo.
let autoFilledRepo = "";
async function autofillOnSet() {
  const gh = document.getElementById("ghrepo");
  if (gh.value && gh.value !== autoFilledRepo) return;
  const result = await autofill();
  if (result && result.github_repo) autoFilledRepo = result.github_repo;
}

// Persistencia de la configuración: se restaura al abrir el panel (campos vacíos).
const CONFIG_IDS = ["repoInput", "ghrepo", "project", "projectOwner", "rounds"];
function persistConfig() {
  for (const id of CONFIG_IDS) storeSet(id, document.getElementById(id).value);
}
function restoreConfig() {
  for (const id of CONFIG_IDS) {
    const el = document.getElementById(id);
    const saved = storeGet(id);
    if (saved && !el.value) el.value = saved;
  }
}

document.getElementById("setRepo").onclick = applyRepoPath;
document.getElementById("repoInput").onkeydown = (event) => {
  if (event.key === "Enter") return applyRepoPath();
  return undefined;
};
for (const id of ["ghrepo", "project", "projectOwner", "rounds"]) {
  const el = document.getElementById(id);
  el.oninput = () => {
    updatePreFlight();
    persistConfig();
  };
  el.onkeydown = (event) => {
    if (event.key === "Enter") return applyConfig();
    return undefined;
  };
}
document.getElementById("repoInput").oninput = persistConfig;

// Atajos de teclado globales: 1-4 cambian pestaña, Ctrl+Enter acciona, Esc colapsa ajustes.
const TAB_KEYS = { 1: "pipeline", 2: "board", 3: "graph", 4: "order" };
document.addEventListener?.("keydown", (event) => {
  const tag = String(event.target?.tagName || "").toLowerCase();
  const inField = tag === "input" || tag === "textarea" || tag === "select";
  if (event.ctrlKey && event.key === "Enter") {
    if (repo) action("play", {}, document.getElementById("play"));
    else applyConfig();
    return;
  }
  if (event.key === "Escape") {
    if (!document.getElementById("startCard").hidden) setStartCard(true);
    return;
  }
  if (inField || event.ctrlKey || event.metaKey || event.altKey) return;
  const name = TAB_KEYS[event.key];
  if (name) selectTab(name);
});

// Los tiempos relativos del log se refrescan solos (timer no bloquea el cierre en Node).
const tsTimer = setInterval(() => refreshLogTimes(document.getElementById("log")), 30000);
tsTimer.unref?.();

restoreConfig();
{
  const hashTab = /tab=(\w+)/.exec(location.hash || "")?.[1];
  const wanted = hashTab || storeGet("tab");
  selectTab(TAB_NAMES.includes(wanted) ? wanted : "pipeline", { user: false });
}
try {
  await loadRepo();
} catch (error) {
  log(`error: ${error.message}`);
  showError(`El panel no pudo leer el estado actual: ${error.message}. Asigna la carpeta en «Arrancar la fábrica» para reintentar.`);
}
updatePreFlight();
if (!repo) {
  // Ruta guardada en otra sesión: se aplica sola para no volver a escribirla.
  if (document.getElementById("repoInput").value.trim()) await applyRepoPath();
} else if (!lastState && storeGet("startCard") === "1") {
  setStartCard(true);
}
