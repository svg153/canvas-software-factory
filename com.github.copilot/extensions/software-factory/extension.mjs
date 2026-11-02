// Software Factory canvas — panel de control de la fábrica.
// Patrón tomado de agentic-kanban: http server + createCanvas + joinSession/session.send.
import { readFile } from "node:fs/promises";
import { statSync, realpathSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { CanvasError, createCanvas, joinSession } from "@github/copilot-sdk/extension";
import { createFactoryServer } from "./runner/lib/http.mjs";
import { createRepoAllowlist } from "./runner/lib/allowlist.mjs";
import { initRunnerArgs, startGuardError } from "./runner/lib/actions.mjs";
import { bootstrapPrompt } from "./runner/lib/prompts.mjs";
import { updateState } from "./runner/lib/state.mjs";

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
  if (!repoDir) return null;
  try {
    return JSON.parse(await readFile(sfPaths(repoDir).state, "utf8"));
  } catch {
    return null;
  }
}

async function writeStatus(repoDir, status) {
  const state = await updateState(repoDir, (current) => {
    if (!current) throw new CanvasError("sf_no_state", "Ejecuta primero: node <runner>/sf.mjs init <repo> --repo owner/repo");
    current.status = status;
    return current;
  });
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
  if (!repoDir) return;
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
  // El host de extensiones no es una sesión de chat: sin ?repo= válido el defaultRepo
  // cae a un directorio cualquiera. Nunca escribamos estado de fábrica fuera de un git.
  if (!repoIsGitWorkspace(repoDir)) {
    throw new CanvasError("sf_repo_no_permitido",
      "El panel no tiene un repo de trabajo. Escribe la ruta absoluta de tu workspace (git) en el campo «Repo» y pulsa «Usar repo».");
  }
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
  if (actionName === "next") {
    const { execFile } = await import("node:child_process");
    const { promisify } = await import("node:util");
    const out = await promisify(execFile)("node", [RUNNER, "next", repoDir], { windowsHide: true });
    return JSON.parse(out.stdout.trim());
  }
  throw new CanvasError("sf_unknown_action", `Acción desconocida: ${actionName}`);
}

const defaultRepo = () => session?.workspacePath || process.cwd();
const allowlist = createRepoAllowlist({ defaultRepo });
// El host de extensiones no es una sesión de chat: su cwd/workspacePath no es un repo.
// Sin input.repo el panel debe avisar en vez de gestionar un directorio cualquiera.
const repoIsGitWorkspace = (dir) => {
  try {
    statSync(join(dir, ".git"));
    return true;
  } catch {
    return false;
  }
};
// Las acciones del canvas también pasan por el allowlist (no solo HTTP).
const repoFrom = (input) => allowlist.resolve(input?.repo);

// El input de open_canvas no siempre es utilizable (limitación de la app al serializar),
// así que el panel permite escribir la ruta del repo en su propia UI. Aceptamos cualquier
// ruta absoluta que sea un workspace git; el servidor solo escucha en 127.0.0.1 y exige
// Host+CSRF, y applyAction sigue rechazando todo lo que no sea git.
function resolveRepoInput(requested) {
  if (requested === undefined || requested === null || requested === "") return "";
  try {
    return allowlist.resolve(requested);
  } catch {
    /* fuera de raíces autorizadas; probamos el criterio de workspace git */
  }
  let real;
  try {
    real = realpathSync.native(requested);
  } catch {
    throw new Error("sf_repo_no_permitido");
  }
  if (!repoIsGitWorkspace(real)) throw new Error("sf_repo_no_permitido");
  return real;
}

const server = createFactoryServer({
  extensionDir: __dirname,
  defaultRepo,
  resolveRepo: resolveRepoInput,
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
      repo: { type: "string", description: "Ruta absoluta del repo a gestionar (obligatoria: el host de extensiones no está ligado a una sesión)." },
      title: { type: "string" },
    },
  },
  actions: [
    {
      name: "get_state",
      description: "Devuelve el estado de la fábrica (state.json).",
      handler({ input }) {
        return applyAction(repoFrom(input), "get_state");
      },
    },
    {
      name: "play",
      description: "Pone la fábrica en running y envía al agente el prompt de arranque del bucle.",
      handler({ input }) {
        return applyAction(repoFrom(input), "play");
      },
    },
    {
      name: "pause",
      description: "Pausa la fábrica (status=paused).",
      handler({ input }) {
        return applyAction(repoFrom(input), "pause");
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
        const repoDir = repoFrom(input);
        return applyAction(repoDir, "init", {
          repo: input?.github_repo,
          project: input?.project,
          project_owner: input?.project_owner,
          rounds: input?.rounds,
        });
      },
    },
    {
      name: "next_work",
      description: "Pide al runner la siguiente tanda de work orders (fase actual).",
      handler({ input }) {
        return applyAction(repoFrom(input), "next");
      },
    },
  ],
  async open({ instanceId, input }) {
    // El host de extensiones es un proceso propio (no una sesión de chat): la única
    // forma fiable de conocer el repo es input.repo. Sin él, dejar repo vacío para
    // que la UI muestre el aviso en lugar de gestionar un directorio aleatorio.
    const repoDir = input?.repo ? allowlist.authorize(input.repo) : "";
    return {
      url: `${baseUrl}/?instanceId=${encodeURIComponent(instanceId)}&repo=${encodeURIComponent(repoDir)}`,
      title: input?.title || "Software Factory",
      status: "listo",
    };
  },
  onClose() {
    // dejamos watchers: son baratos y otros panels pueden reutilizarlos
  },
});

session = await joinSession({ canvases: [factoryCanvas] });
