// Software Factory canvas — panel de control de la fábrica.
// Patrón tomado de agentic-kanban: http server + createCanvas + joinSession/session.send.
import { readFile, writeFile, mkdir, watch } from "node:fs/promises";
import http from "node:http";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { homedir } from "node:os";

import { CanvasError, createCanvas, joinSession } from "@github/copilot-sdk/extension";

const __dirname = dirname(fileURLToPath(import.meta.url));
const RUNNER = join(__dirname, "runner", "sf.mjs");
const PHASES = ["discover", "plan", "grill", "issues", "implement", "review"];
const subscribers = new Map();
let session;

function sfPaths(repoDir) {
  const root = join(repoDir, ".software-factory");
  return { root, state: join(root, "state.json") };
}

async function readState(repoDir) {
  try {
    return JSON.parse(await readFile(sfPaths(repoDir).state, "utf8"));
  } catch {
    return null;
  }
}

async function writeStatus(repoDir, status) {
  const p = sfPaths(repoDir);
  const state = await readState(repoDir);
  if (!state) throw new CanvasError("sf_no_state", "Ejecuta primero: node <runner>/sf.mjs init <repo> --repo owner/repo");
  state.status = status;
  state.updated_at = new Date().toISOString();
  await mkdir(p.root, { recursive: true });
  await writeFile(p.state, JSON.stringify(state, null, 2));
  broadcast(repoDir, state);
  return state;
}

function factoryPrompt(repoDir, state) {
  return [
    `# Software Factory — arrancar bucle`,
    ``,
    `Lee la skill "software-factory" y ejecuta el bucle de la fábrica contra ${repoDir}.`,
    `Runner: node "${RUNNER}"`,
    state
      ? `Estado actual: round ${state.round}/${state.max_rounds}, fase "${state.phase}", status ${state.status}.`
      : `Sin estado: ejecuta primero init con el repo appropriate (usa gh para owner/name).`,
    `Empieza con: node "${RUNNER}" next ${repoDir} — luego trabaja cada work order pendiente,`,
    `guarda resultados y marca complete. Avanza fases hasta pausar o terminar.`,
  ].join("\n");
}

// Polling del state.json por repo para re-broadcast SSE.
const watchers = new Map();
function ensureWatch(repoDir) {
  if (watchers.has(repoDir)) return;
  const timer = setInterval(async () => {
    const state = await readState(repoDir);
    if (state) broadcast(repoDir, state);
  }, 2500);
  watchers.set(repoDir, timer);
  // watch() es opcional; polling basta en V0.
  watch(join(sfPaths(repoDir).root, "state.json"), () => {}).catch(() => {});
}

function broadcast(repoDir, state) {
  const subs = subscribers.get(repoDir);
  if (!subs) return;
  const payload = `data: ${JSON.stringify(state)}\n\n`;
  for (const res of subs) res.write(payload);
}

async function applyAction(repoDir, actionName, input = {}) {
  if (actionName === "get_state") {
    const state = await readState(repoDir);
    return { status: state ? `${state.phase} (round ${state.round})` : "sin estado", state, runner: RUNNER };
  }
  if (actionName === "play") {
    const state = await writeStatus(repoDir, "running");
    if (session) await session.send({ prompt: factoryPrompt(repoDir, state) });
    return { status: "Fábrica lanzada — el agente recibió el prompt de arranque", state };
  }
  if (actionName === "pause") {
    const state = await writeStatus(repoDir, "paused");
    return { status: "Fábrica en pausa", state };
  }
  if (actionName === "init") {
    const args = ["init", repoDir];
    if (input.repo) args.push("--repo", input.repo);
    if (input.project) args.push("--project", input.project);
    if (input.rounds) args.push("--rounds", String(input.rounds));
    const { execFile } = await import("node:child_process");
    const { promisify } = await import("node:util");
    const out = await promisify(execFile)("node", [RUNNER, ...args], { windowsHide: true });
    return { status: "inicializado", output: out.stdout.trim() };
  }
  if (actionName === "next") {
    const { execFile } = await import("node:child_process");
    const { promisify } = await import("node:util");
    const out = await promisify(execFile)("node", [RUNNER, "next", repoDir], { windowsHide: true });
    return JSON.parse(out.stdout.trim());
  }
  throw new CanvasError("sf_unknown_action", `Acción desconocida: ${actionName}`);
}

function repoFromReq(req) {
  const url = new URL(req.url, "http://127.0.0.1");
  const q = url.searchParams.get("repo");
  return q || session?.workspacePath || process.cwd();
}

const server = http.createServer(async (req, res) => {
  try {
    const repoDir = repoFromReq(req);
    if (req.method === "GET" && (req.url === "/" || req.url?.startsWith("/?"))) {
      res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
      res.end(await readFile(join(__dirname, "index.html")));
      return;
    }
    if (req.method === "GET" && req.url?.startsWith("/state")) {
      ensureWatch(repoDir);
      const state = await readState(repoDir);
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify(state || { status: "missing", repo: repoDir }));
      return;
    }
    if (req.method === "GET" && req.url?.startsWith("/events")) {
      ensureWatch(repoDir);
      res.writeHead(200, { "Content-Type": "text/event-stream", "Cache-Control": "no-cache", Connection: "keep-alive" });
      const state = await readState(repoDir);
      res.write(`data: ${JSON.stringify(state || { status: "missing" })}\n\n`);
      if (!subscribers.has(repoDir)) subscribers.set(repoDir, new Set());
      subscribers.get(repoDir).add(res);
      req.on("close", () => subscribers.get(repoDir)?.delete(res));
      return;
    }
    if (req.method === "POST" && req.url?.startsWith("/action")) {
      const body = await new Promise((resolve) => {
        let data = "";
        req.on("data", (c) => (data += c));
        req.on("end", () => resolve(data ? JSON.parse(data) : {}));
      });
      const result = await applyAction(repoDir, body.actionName, body.input || {});
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify(result));
      return;
    }
    res.writeHead(404);
    res.end();
  } catch (error) {
    res.writeHead(400, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ error: error instanceof Error ? error.message : "Unknown error" }));
  }
});

await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
const baseUrl = `http://127.0.0.1:${server.address().port}`;

const factoryCanvas = createCanvas({
  id: "software-factory",
  displayName: "Software Factory",
  description:
    "Panel de control de la fábrica de software: discover → plan GSD → grill-me → issues → implement → review, en rounds autónomos.",
  inputSchema: {
    type: "object",
    properties: {
      repo: { type: "string", description: "Ruta absoluta del repo (por defecto, el workspace de la sesión)." },
      title: { type: "string" },
    },
  },
  actions: [
    {
      name: "get_state",
      description: "Devuelve el estado de la fábrica (state.json).",
      handler({ input }) {
        return applyAction(input?.repo || session?.workspacePath || process.cwd(), "get_state");
      },
    },
    {
      name: "play",
      description: "Pone la fábrica en running y envía al agente el prompt de arranque del bucle.",
      handler({ input }) {
        return applyAction(input?.repo || session?.workspacePath || process.cwd(), "play");
      },
    },
    {
      name: "pause",
      description: "Pausa la fábrica (status=paused).",
      handler({ input }) {
        return applyAction(input?.repo || session?.workspacePath || process.cwd(), "pause");
      },
    },
    {
      name: "init_factory",
      description: "Inicializa .software-factory en el repo (owner/repo, project id, rounds).",
      inputSchema: {
        type: "object",
        properties: {
          repo: { type: "string" },
          github_repo: { type: "string", description: "owner/name en GitHub" },
          project: { type: "string" },
          rounds: { type: "number" },
        },
      },
      handler({ input }) {
        const repoDir = input?.repo || session?.workspacePath || process.cwd();
        return applyAction(repoDir, "init", { repo: input?.github_repo, project: input?.project, rounds: input?.rounds });
      },
    },
    {
      name: "next_work",
      description: "Pide al runner la siguiente tanda de work orders (fase actual).",
      handler({ input }) {
        return applyAction(input?.repo || session?.workspacePath || process.cwd(), "next");
      },
    },
  ],
  async open({ instanceId, input }) {
    return {
      url: `${baseUrl}/?instanceId=${encodeURIComponent(instanceId)}&repo=${encodeURIComponent(input?.repo || "")}`,
      title: input?.title || "Software Factory",
      status: "listo",
    };
  },
  onClose() {
    // dejamos watchers: son baratos y otros panels pueden reutilizarlos
  },
});

session = await joinSession({ canvases: [factoryCanvas] });
