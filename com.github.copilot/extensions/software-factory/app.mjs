import { createInitPayload, renderGithub, renderState, routeWithRepo } from "/ui.mjs";

const params = new URLSearchParams(location.search);
let repo = params.get("repo") || "";
let events = null;

function log(message) {
  const element = document.getElementById("log");
  element.textContent += `${message}\n`;
  element.scrollTop = element.scrollHeight;
}

// El token se obtiene de /token (mismo origen); no va incrustado en el HTML.
// Si /token falla (server caído) el panel sigue cargando y lo muestra en el log.
let actionToken = "";
try {
  actionToken = (await (await fetch("/token")).json()).token || "";
} catch (error) {
  log(`error: ${error.message}`);
}

async function action(actionName, input = {}) {
  const response = await fetch(routeWithRepo("/action", repo), {
    method: "POST",
    headers: { "Content-Type": "application/json", "x-sf-token": actionToken },
    body: JSON.stringify({ actionName, input }),
  });
  const result = await response.json();
  if (result.error) log(`⚠ ${result.error}${result.message ? `: ${result.message}` : ""}`);
  else log(`✔ ${result.status || JSON.stringify(result).slice(0, 120)}`);
  if (result.needs_force) log(`el repo ya tiene estado: marca «Forzar reinicio» y vuelve a pulsar Init solo si quieres perder el progreso`);
  return result;
}

document.getElementById("play").onclick = () => action("play");
document.getElementById("pause").onclick = () => action("pause");
document.getElementById("detectBtn").onclick = () => autofill();
document.getElementById("ghBtn").onclick = () => refreshGithub();
document.getElementById("importBtn").onclick = () => importExisting();

// #90: ver el estado real del repo en GitHub (issues/PRs abiertos) y poder continuar
// trabajo existente en lugar de empezar siempre de cero.
async function refreshGithub() {
  const result = await action("github_status");
  if (result.error) return result;
  renderGithub(result);
  log(`github${result.slug ? ` (${result.slug})` : ""}: ${result.issues?.length ?? 0} issues abiertas, ${result.pulls?.length ?? 0} PRs${result.note ? ` — ${result.note}` : ""}`);
  return result;
}

// Vincula las issues abiertas al run: la fase issues no las duplicará al crear.
async function importExisting() {
  const result = await action("import_issues");
  if (result.error) return result;
  log(`vinculadas ${result.imported} de ${result.open} issues abiertas (no se duplicarán al crear)`);
  return result;
}

// #82/#83: rellena owner/repo desde el remote origin y el Project vinculado al repo.
async function autofill() {
  const result = await action("autofill");
  if (result.error) return result;
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
document.getElementById("initBtn").onclick = () => action("init", createInitPayload({
  repo: document.getElementById("ghrepo").value,
  project: document.getElementById("project").value,
  projectOwner: document.getElementById("projectOwner").value,
  rounds: Number(document.getElementById("rounds").value) || 3,
  force: document.getElementById("forceInit")?.checked,
}));
document.getElementById("ideaBtn").onclick = async () => {
  const input = document.getElementById("ideaText");
  const idea = input.value.trim();
  if (!idea) { log("⚠ escribe una idea antes de pulsar Añadir idea"); return; }
  const result = await action("add_idea", { idea });
  if (!result.error) input.value = "";
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
  const state = await (await fetch(routeWithRepo("/state", repo), { headers: { "x-sf-token": actionToken } })).json();
  if (state.error) throw new Error(state.error);
  showRepoPath(state.repo || repo);
  renderState(state.status === "missing" ? null : state);
  events = new EventSource(`${routeWithRepo("/events", repo)}${repo ? "&" : "?"}token=${encodeURIComponent(actionToken)}`);
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
    await autofillOnSet();
  } catch (error) {
    repo = prev;
    log(`error: ${error.message}`);
  }
};

// Al asignar un repo, rellenar owner/repo (y Project) salvo que el usuario haya
// editado el campo a mano: solo sobrescribimos vacío o nuestro propio valor previo.
let autoFilledRepo = "";
async function autofillOnSet() {
  const gh = document.getElementById("ghrepo");
  if (gh.value && gh.value !== autoFilledRepo) return;
  const result = await autofill();
  if (result.github_repo) autoFilledRepo = result.github_repo;
}

try {
  await loadRepo();
} catch (error) {
  log(`error: ${error.message}`);
}
