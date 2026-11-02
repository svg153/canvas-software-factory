const PHASES = ["discover", "plan", "grill", "issues", "implement", "review"];
const PHASE_LABELS = {
  discover: "Descubrimiento",
  plan: "Plan GSD",
  grill: "Grill-me",
  issues: "Issues + Project",
  implement: "Implementación",
  review: "Revisión/Auditoría",
};
const TASK_STATUSES = new Set(["pending", "awaiting_agent", "done", "failed"]);

export function createInitPayload({ repo, project, projectOwner, rounds }) {
  return {
    repo,
    project,
    project_owner: projectOwner,
    rounds,
  };
}

export function routeWithRepo(path, repo) {
  return repo ? `${path}?repo=${encodeURIComponent(repo)}` : path;
}

function appendEmpty(container, text, doc) {
  const element = doc.createElement("div");
  element.className = "empty";
  element.textContent = text;
  container.appendChild(element);
}

function issueHref(value) {
  try {
    const url = new URL(value);
    return url.protocol === "https:" ? url.href : null;
  } catch {
    return null;
  }
}

export function renderState(state, doc = document) {
  const status = doc.getElementById("status");
  status.textContent = state?.status || "sin estado";
  status.className = `status ${state?.status || ""}`;
  doc.getElementById("round").textContent = state?.round
    ? `round ${state.round} / ${state.max_rounds}`
    : "";

  const tasks = Array.isArray(state?.tasks) ? state.tasks : [];
  const tasksByPhase = new Map();
  for (const task of tasks) {
    const phaseTasks = tasksByPhase.get(task.phase) || [];
    phaseTasks.push(task);
    tasksByPhase.set(task.phase, phaseTasks);
  }

  const pipeline = doc.getElementById("pipeline");
  pipeline.replaceChildren();
  const phaseIndex = state ? PHASES.indexOf(state.phase) : -1;
  for (const [index, phase] of PHASES.entries()) {
    const element = doc.createElement("div");
    element.className = "phase"
      + (state?.phase === phase ? " active" : "")
      + (state && index < phaseIndex ? " donep" : "");

    const label = doc.createElement("b");
    label.textContent = PHASE_LABELS[phase];
    element.appendChild(label);

    const phaseTasks = tasksByPhase.get(phase) || [];
    const count = doc.createElement("span");
    count.textContent = phaseTasks.length
      ? `${phaseTasks.filter((task) => task.status === "done").length}/${phaseTasks.length} tareas`
      : "—";
    element.appendChild(count);
    pipeline.appendChild(element);
  }

  const taskList = doc.getElementById("tasks");
  taskList.replaceChildren();
  const openTasks = tasks.filter((task) => task.phase === state?.phase);
  if (openTasks.length) {
    for (const task of openTasks) {
      const row = doc.createElement("div");
      row.className = "task";

      const dot = doc.createElement("span");
      const taskStatus = TASK_STATUSES.has(task.status) ? task.status : "pending";
      dot.className = `dot ${taskStatus}`;
      row.appendChild(dot);

      const title = doc.createElement("span");
      title.className = "t";
      title.textContent = String(task.title ?? "");
      row.appendChild(title);

      const id = doc.createElement("span");
      id.className = "id";
      id.textContent = `${String(task.id ?? "")} · ${String(task.status ?? "")}`;
      row.appendChild(id);
      taskList.appendChild(row);
    }
  } else {
    appendEmpty(taskList, `Fase ${state?.phase || "—"} sin tareas (pulsa Play o next).`, doc);
  }

  const issueList = doc.getElementById("issues");
  issueList.replaceChildren();
  const issues = Array.isArray(state?.issues) ? state.issues : [];
  if (issues.length) {
    for (const issue of issues) {
      const row = doc.createElement("div");
      row.className = "issue";

      const href = issueHref(issue.url);
      const link = doc.createElement(href ? "a" : "span");
      if (href) {
        link.href = href;
        link.target = "_blank";
        link.rel = "noopener noreferrer";
      }
      link.textContent = `#${String(issue.number ?? "")} ${String(issue.title ?? "")}`;
      row.appendChild(link);
      issueList.appendChild(row);
    }
  } else {
    appendEmpty(issueList, "Ninguna todavía.", doc);
  }
}
