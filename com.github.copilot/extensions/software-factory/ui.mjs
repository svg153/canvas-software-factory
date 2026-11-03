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

// --- Tablero/grafo: espejo display-only de runner/lib/graph.mjs ---------------
// El navegador solo carga ui.mjs (http.mjs no sirve el runner), así que estas
// funciones puras se duplican a propósito; graph.mjs es la fuente canónica.
const BOARD_COLUMNS = [
  { key: "backlog", label: "Backlog" },
  { key: "ready", label: "Ready" },
  { key: "in_progress", label: "In Progress" },
  { key: "in_review", label: "In Review" },
  { key: "done", label: "Done" },
];

function latestImplementTaskFor(state, number) {
  let latest = null;
  for (const t of state?.tasks || []) {
    if (t.phase !== "implement") continue;
    const n = t.issue?.number ?? t.meta?.issue?.number;
    if (Number(n) === Number(number)) latest = t;
  }
  return latest;
}

function depsSatisfiedFor(state, issue) {
  for (const d of issue.depends_on || []) {
    const dep = (state?.issues || []).find((i) => Number(i.number) === Number(d));
    if (!dep) continue; // fuera del grafo: no bloquea
    if (latestImplementTaskFor(state, d)?.status !== "done") return false;
  }
  return true;
}

export function issueColumnFor(state, issue, closedNumbers) {
  const n = Number(issue.number);
  if (closedNumbers?.has(n)) return "done";
  const task = latestImplementTaskFor(state, n);
  if (task) {
    if (task.status === "done") return "in_review"; // PR abierto por el work order; el merge es humano
    if (task.status === "pending" || task.status === "awaiting_agent") return "in_progress";
    // failed: re-reclamable, vuelve a la cola abajo
  }
  return depsSatisfiedFor(state, issue) ? "ready" : "backlog";
}

export function deriveBoard(state, closedNumbers) {
  const buckets = new Map(BOARD_COLUMNS.map((c) => [c.key, []]));
  for (const issue of state?.issues || []) {
    if (!Number.isFinite(Number(issue.number))) continue;
    buckets.get(issueColumnFor(state, issue, closedNumbers)).push({
      number: Number(issue.number),
      title: String(issue.title ?? ""),
      url: String(issue.url ?? ""),
      wave: Number(issue.wave ?? 0),
      depends_on: Array.isArray(issue.depends_on) ? issue.depends_on : [],
    });
  }
  for (const list of buckets.values()) list.sort((a, b) => a.wave - b.wave || a.number - b.number);
  return { columns: BOARD_COLUMNS.map((c) => ({ ...c, cards: buckets.get(c.key) })) };
}

// Layout del DAG por olas: fila = wave, de arriba a abajo. Coordenadas listas para SVG.
export function graphLayout(state) {
  const issues = (state?.issues || []).filter((i) => Number.isFinite(Number(i.number)));
  const nodeW = 170, nodeH = 46, gapX = 30, gapY = 90, pad = 20;
  const byWave = new Map();
  for (const i of issues) {
    const w = Number(i.wave ?? 0);
    if (!byWave.has(w)) byWave.set(w, []);
    byWave.get(w).push(i);
  }
  const waves = [...byWave.keys()].sort((a, b) => a - b);
  const nodes = new Map();
  let widest = 0;
  for (const w of waves) {
    const list = byWave.get(w).sort((a, b) => Number(a.number) - Number(b.number));
    widest = Math.max(widest, list.length);
    list.forEach((i, col) => {
      nodes.set(Number(i.number), {
        number: Number(i.number),
        title: String(i.title ?? ""),
        wave: w,
        x: pad + col * (nodeW + gapX),
        y: pad + waves.indexOf(w) * (nodeH + gapY),
      });
    });
  }
  const edges = [];
  for (const i of issues) {
    for (const d of i.depends_on || []) {
      const from = nodes.get(Number(d));
      const to = nodes.get(Number(i.number));
      if (from && to) edges.push({ from: from.number, to: to.number });
    }
  }
  return {
    nodes: [...nodes.values()],
    edges,
    nodeW, nodeH,
    width: pad * 2 + Math.max(1, widest) * nodeW + Math.max(0, widest - 1) * gapX,
    height: pad * 2 + Math.max(1, waves.length) * nodeH + Math.max(0, waves.length - 1) * gapY,
    waves: waves.length,
  };
}


export function createInitPayload({ repo, project, projectOwner, rounds, force }) {
  const payload = {
    repo,
    project,
    project_owner: projectOwner,
    rounds,
  };
  // #88: force solo viaja si está activo, para no alterar el contrato init existente.
  if (force) payload.force = true;
  return payload;
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

export function renderGithub(result, doc = document) {
  // Contenido no confiable (títulos de terceros): siempre textContent; enlaces solo https.
  const issueList = doc.getElementById("ghIssues");
  issueList.replaceChildren();
  const issues = Array.isArray(result?.issues) ? result.issues : [];
  if (!issues.length) {
    appendEmpty(issueList, "Sin issues abiertas (pulsa «Actualizar GitHub»).", doc);
  }
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
    for (const label of Array.isArray(issue.labels) ? issue.labels : []) {
      const chip = doc.createElement("span");
      chip.className = "chip";
      chip.textContent = String(label);
      row.appendChild(chip);
    }
    issueList.appendChild(row);
  }

  const pullList = doc.getElementById("ghPulls");
  pullList.replaceChildren();
  const pulls = Array.isArray(result?.pulls) ? result.pulls : [];
  if (!pulls.length) {
    appendEmpty(pullList, "Sin PRs abiertos (pulsa «Actualizar GitHub»).", doc);
  }
  for (const pr of pulls) {
    const row = doc.createElement("div");
    row.className = "issue";
    const href = issueHref(pr.url);
    const link = doc.createElement(href ? "a" : "span");
    if (href) {
      link.href = href;
      link.target = "_blank";
      link.rel = "noopener noreferrer";
    }
    link.textContent = `#${String(pr.number ?? "")} ${String(pr.title ?? "")}`;
    row.appendChild(link);
    const meta = doc.createElement("span");
    meta.className = "chip";
    const flags = [
      pr.isDraft ? "draft" : "",
      pr.mergeable === "CONFLICTING" ? "conflictos" : "",
      pr.checks && pr.checks !== "none" ? pr.checks : "",
    ].filter(Boolean);
    meta.textContent = flags.join(" · ") || "abierto";
    row.appendChild(meta);
    pullList.appendChild(row);
  }
}

export function renderState(state, doc = document, closedNumbers = null) {
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

  // Chips de ola/dependencias en la lista de issues + paneles kanban/grafo/orden.
  if (issues.length) {
    for (const [index, issue] of issues.entries()) {
      const row = issueList.children[index];
      if (!row) break;
      if (Number.isFinite(Number(issue.wave))) {
        const chip = doc.createElement("span");
        chip.className = "chip";
        chip.textContent = `W${Number(issue.wave)}`;
        row.appendChild(chip);
      }
      for (const d of Array.isArray(issue.depends_on) ? issue.depends_on : []) {
        const chip = doc.createElement("span");
        chip.className = "chip";
        chip.textContent = `←#${Number(d)}`;
        row.appendChild(chip);
      }
    }
  }
  renderBoardView(state, doc, closedNumbers);
  renderGraphView(state, doc);
  renderOrderView(state, doc);
}

function renderBoardView(state, doc, closedNumbers) {
  const host = doc.getElementById("board");
  if (!host) return;
  const board = deriveBoard(state || {}, closedNumbers);
  host.replaceChildren();
  for (const col of board.columns) {
    const section = doc.createElement("div");
    section.className = `col col-${col.key}`;
    const head = doc.createElement("h3");
    head.textContent = `${col.label} (${col.cards.length})`;
    section.appendChild(head);
    for (const card of col.cards) {
      const el = doc.createElement("div");
      el.className = "card";
      const href = issueHref(card.url);
      const link = doc.createElement(href ? "a" : "span");
      if (href) {
        link.href = href;
        link.target = "_blank";
        link.rel = "noopener noreferrer";
      }
      link.textContent = `#${card.number} ${card.title}`;
      el.appendChild(link);
      const chips = [`W${card.wave}`];
      for (const d of card.depends_on) chips.push(`←#${d}`);
      for (const text of chips) {
        const chip = doc.createElement("span");
        chip.className = "chip";
        chip.textContent = text;
        el.appendChild(chip);
      }
      section.appendChild(el);
    }
    if (!col.cards.length) appendEmpty(section, "—", doc);
    host.appendChild(section);
  }
}

const SVG_NS = "http://www.w3.org/2000/svg";

function renderGraphView(state, doc) {
  const host = doc.getElementById("graph");
  if (!host || typeof doc.createElementNS !== "function") return;
  const layout = graphLayout(state || {});
  host.replaceChildren();
  if (!layout.nodes.length) {
    appendEmpty(host, "Sin issues con grafo de dependencias todavía (fase issues las normaliza).", doc);
    return;
  }
  const svg = doc.createElementNS(SVG_NS, "svg");
  svg.setAttribute("viewBox", `0 0 ${layout.width} ${layout.height}`);
  svg.setAttribute("width", String(layout.width));
  svg.setAttribute("height", String(layout.height));
  svg.setAttribute("class", "dag");
  const byNumber = new Map(layout.nodes.map((n) => [n.number, n]));
  for (const edge of layout.edges) {
    const a = byNumber.get(edge.from);
    const b = byNumber.get(edge.to);
    const path = doc.createElementNS(SVG_NS, "path");
    const x1 = a.x + layout.nodeW / 2, y1 = a.y + layout.nodeH;
    const x2 = b.x + layout.nodeW / 2, y2 = b.y;
    const bend = Math.max(20, (y2 - y1) / 2);
    path.setAttribute("d", `M ${x1} ${y1} C ${x1} ${y1 + bend}, ${x2} ${y2 - bend}, ${x2} ${y2}`);
    path.setAttribute("class", "dagEdge");
    svg.appendChild(path);
  }
  for (const node of layout.nodes) {
    const g = doc.createElementNS(SVG_NS, "g");
    g.setAttribute("class", `dagNode wave${node.wave % 4}`);
    g.setAttribute("transform", `translate(${node.x},${node.y})`);
    const rect = doc.createElementNS(SVG_NS, "rect");
    rect.setAttribute("width", String(layout.nodeW));
    rect.setAttribute("height", String(layout.nodeH));
    rect.setAttribute("rx", "8");
    g.appendChild(rect);
    const num = doc.createElementNS(SVG_NS, "text");
    num.setAttribute("x", "10");
    num.setAttribute("y", "18");
    num.setAttribute("class", "dagNum");
    num.textContent = `#${node.number} · ola ${node.wave}`;
    g.appendChild(num);
    const title = doc.createElementNS(SVG_NS, "text");
    title.setAttribute("x", "10");
    title.setAttribute("y", "36");
    title.setAttribute("class", "dagTitle");
    title.textContent = node.title.length > 26 ? `${node.title.slice(0, 25)}…` : node.title;
    g.appendChild(title);
    svg.appendChild(g);
  }
  host.appendChild(svg);
}

function renderOrderView(state, doc) {
  const host = doc.getElementById("order");
  if (!host) return;
  host.replaceChildren();
  const issues = (state?.issues || []).filter((i) => Number.isFinite(Number(i.number)));
  if (!issues.length) {
    appendEmpty(host, "Sin issues todavía: el orden aparece tras la fase issues.", doc);
    return;
  }
  const byWave = new Map();
  for (const i of issues) {
    const w = Number(i.wave ?? 0);
    if (!byWave.has(w)) byWave.set(w, []);
    byWave.get(w).push(i);
  }
  for (const w of [...byWave.keys()].sort((a, b) => a - b)) {
    const block = doc.createElement("div");
    block.className = "waveBlock";
    const head = doc.createElement("h3");
    head.textContent = `Ola ${w} — se implementa en paralelo (sin dependencias pendientes)`;
    block.appendChild(head);
    const list = doc.createElement("ol");
    for (const i of byWave.get(w).sort((a, b) => Number(a.number) - Number(b.number))) {
      const li = doc.createElement("li");
      li.className = "issue";
      const href = issueHref(i.url);
      const link = doc.createElement(href ? "a" : "span");
      if (href) {
        link.href = href;
        link.target = "_blank";
        link.rel = "noopener noreferrer";
      }
      link.textContent = `#${String(i.number)} ${String(i.title ?? "")}`;
      li.appendChild(link);
      for (const d of Array.isArray(i.depends_on) ? i.depends_on : []) {
        const chip = doc.createElement("span");
        chip.className = "chip";
        chip.textContent = `←#${Number(d)}`;
        li.appendChild(chip);
      }
      list.appendChild(li);
    }
    block.appendChild(list);
    host.appendChild(block);
  }
}
