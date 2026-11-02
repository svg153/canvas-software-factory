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

  // Ideas del usuario (semillas). Se muestra solo si el contenedor existe: los tests
  // de render usan un doc mínimo sin este id y no deben romperse.
  const seedList = doc.getElementById("seeds");
  if (seedList) {
    seedList.replaceChildren();
    const seeds = Array.isArray(state?.seeds) ? state.seeds : [];
    if (seeds.length) {
      for (const seed of seeds) {
        const row = doc.createElement("div");
        row.className = "issue";
        const label = doc.createElement("span");
        label.textContent = `[${String(seed.status ?? "new")}] ${String(seed.text ?? "")}`;
        row.appendChild(label);
        seedList.appendChild(row);
      }
    } else {
      appendEmpty(seedList, "Ninguna idea todavía.", doc);
    }
  }

  // Ingesta del repo: snapshot de trabajo abierto (issues/PRs/Project). Solo si el
  // contenedor existe (los tests de render usan un doc mínimo sin este id).
  const invEl = doc.getElementById("inventory");
  if (invEl) {
    invEl.replaceChildren();
    const inv = state?.inventory;
    if (inv) {
      const issues = Array.isArray(inv.issues) ? inv.issues : [];
      const prs = Array.isArray(inv.prs) ? inv.prs : [];
      const project = Array.isArray(inv.project) ? inv.project : [];
      const head = doc.createElement("div");
      head.className = "issue";
      head.textContent = `Issues abiertas: ${issues.length} · PRs abiertas: ${prs.length} · Items Project: ${project.length}`;
      invEl.appendChild(head);
      for (const it of issues.slice(0, 20)) {
        const row = doc.createElement("div");
        row.className = "issue";
        row.textContent = `#${it.number} ${it.title}`;
        invEl.appendChild(row);
      }
      for (const pr of prs.slice(0, 20)) {
        const row = doc.createElement("div");
        row.className = "issue";
        row.textContent = `PR #${pr.number} ${pr.title}`;
        invEl.appendChild(row);
      }
    } else {
      appendEmpty(invEl, "Sin ingesta todavía (pulsa Ingestar repo).", doc);
    }
  }
}
