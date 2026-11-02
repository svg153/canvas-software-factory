import { createInitPayload, renderState, routeWithRepo } from "/ui.mjs";

const params = new URLSearchParams(location.search);
const repo = params.get("repo") || "";

function log(message) {
  const element = document.getElementById("log");
  element.textContent += `${message}\n`;
  element.scrollTop = element.scrollHeight;
}

async function action(actionName, input = {}) {
  const response = await fetch(routeWithRepo("/action", repo), {
    method: "POST",
    headers: { "Content-Type": "application/json" },
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

try {
  const state = await (await fetch(routeWithRepo("/state", repo))).json();
  renderState(state.status === "missing" ? null : state);
  const events = new EventSource(routeWithRepo("/events", repo));
  events.onmessage = (event) => renderState(JSON.parse(event.data));
  events.onerror = () => log("conexión SSE perdida, reintentando…");
} catch (error) {
  log(`error: ${error.message}`);
}
