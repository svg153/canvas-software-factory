// Software Factory canvas — panel de control de la fábrica.
// Patrón tomado de agentic-kanban: http server + createCanvas + joinSession/session.send.
import { readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { CanvasError, createCanvas, joinSession } from "@github/copilot-sdk/extension";
import { createFactoryServer } from "./runner/lib/http.mjs";
import { initRunnerArgs, ideaRunnerArgs, startGuardError } from "./runner/lib/actions.mjs";
import { bootstrapPrompt } from "./runner/lib/prompts.mjs";
import { saveState } from "./runner/lib/state.mjs";

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
  const state = await readState(repoDir);
  if (!state) throw new CanvasError("sf_no_state", "Ejecuta primero: node <runner>/sf.mjs init <repo> --repo owner/repo");
  state.status = status;
  await saveState(repoDir, state);
  broadcast(repoDir, state);
  return state;
}

function factoryPrompt(repoDir, state) {
  return bootstrapPrompt(repoDir, RUNNER, state);
}

// Polling del state.json por repo para re-broadcast SSE. El timer se libera solo
// cuando el repo se queda sin suscriptores (antes quedaba vivo para siempre).
const watchers = new Map();
function ensureWatch(repoDir) {
  if (watchers.has(repoDir)) return;
  const timer = setInterval(async () => {
    if (!subscribers.get(repoDir)?.size) {
      clearInterval(timer);
      watchers.delete(repoDir);
      return;
    }
    const state = await readState(repoDir);
    if (state) broadcast(repoDir, state);
  }, 2500);
  watchers.set(repoDir, timer);
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
    return { status: state ? `${state.phase} (round ${state.round})` : "sin estado", state, notes: state?.notes || "", runner: RUNNER };
  }
  if (actionName === "play") {
    const guard = startGuardError(await readState(repoDir));
    if (guard) throw new CanvasError("sf_done", guard);
    const state = await writeStatus(repoDir, "running");
    if (session) await session.send({ prompt: factoryPrompt(repoDir, state) });
    return { status: "Fábrica lanzada — el agente recibió el prompt de arranque", state };
  }
  if (actionName === "pause") {
    const state = await writeStatus(repoDir, "paused");
    return { status: "Fábrica en pausa", state };
  }
  if (actionName === "init") {
    const { execFile } = await import("node:child_process");
    const { promisify } = await import("node:util");
    const out = await promisify(execFile)("node", [RUNNER, ...initRunnerArgs(repoDir, input)], { windowsHide: true });
    return { status: "inicializado", output: out.stdout.trim() };
  }
  if (actionName === "idea") {
    const { execFile } = await import("node:child_process");
    const { promisify } = await import("node:util");
    const out = await promisify(execFile)("node", [RUNNER, ...ideaRunnerArgs(repoDir, input)], { windowsHide: true });
    return JSON.parse(out.stdout.trim());
  }
  if (actionName === "next") {
    const { execFile } = await import("node:child_process");
    const { promisify } = await import("node:util");
    const out = await promisify(execFile)("node", [RUNNER, "next", repoDir], { windowsHide: true });
    return JSON.parse(out.stdout.trim());
  }
  throw new CanvasError("sf_unknown_action", `Acción desconocida: ${actionName}`);
}

const server = createFactoryServer({
  extensionDir: __dirname,
  defaultRepo: () => session?.workspacePath || process.cwd(),
  readState,
  ensureWatch,
  applyAction,
  subscribe(repoDir, res) {
    if (!subscribers.has(repoDir)) subscribers.set(repoDir, new Set());
    subscribers.get(repoDir).add(res);
    res.on("close", () => subscribers.get(repoDir)?.delete(res));
  },
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
          project_owner: { type: "string", description: "Owner del GitHub Project (por defecto, el owner del repo)" },
          rounds: { type: "number" },
        },
      },
      handler({ input }) {
        const repoDir = input?.repo || session?.workspacePath || process.cwd();
        return applyAction(repoDir, "init", {
          repo: input?.github_repo,
          project: input?.project,
          project_owner: input?.project_owner,
          rounds: input?.rounds,
        });
      },
    },
    {
      name: "add_idea",
      description:
        "Guarda una idea del usuario como semilla (vocal idea). La próxima fase plan la descompone en 1 o más issues (origin:user) que pasan por grill/issues/Project/implement/review igual que las de la auditoría; no lanza un round propio.",
      inputSchema: {
        type: "object",
        properties: {
          repo: { type: "string" },
          idea: { type: "string", description: "Texto de la idea del usuario." },
        },
        required: ["idea"],
      },
      handler({ input }) {
        const repoDir = input?.repo || session?.workspacePath || process.cwd();
        return applyAction(repoDir, "idea", { idea: input?.idea });
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
