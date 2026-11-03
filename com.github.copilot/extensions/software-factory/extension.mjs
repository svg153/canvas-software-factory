// Software Factory canvas — panel de control de la fábrica.
// Patrón tomado de agentic-kanban: http server + createCanvas + joinSession/session.send.
import { readFile } from "node:fs/promises";
import { statSync, realpathSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { CanvasError, createCanvas, joinSession } from "@github/copilot-sdk/extension";
import { createFactoryServer } from "./runner/lib/http.mjs";
import { createRepoAllowlist } from "./runner/lib/allowlist.mjs";
import { initRunnerArgs, ideaRunnerArgs, startGuardError } from "./runner/lib/actions.mjs";
import { bootstrapPrompt } from "./runner/lib/prompts.mjs";
import { updateState, saveState } from "./runner/lib/state.mjs";
import { deriveGithubRepo } from "./runner/lib/git.mjs";
import { listLinkedProjects, getGithubStatus, importOpenIssues } from "./runner/lib/gh.mjs";

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
    try {
      const out = await promisify(execFile)("node", [RUNNER, ...initRunnerArgs(repoDir, input)], { windowsHide: true });
      return { status: "inicializado", output: out.stdout.trim() };
    } catch (e) {
      // #88: el runner aborta exit 1 con un mensaje accionable (p. ej. estado existente
      // sin --force). Sin este catch el usuario solo veía el código genérico.
      const detail = String(e.stderr || e.stdout || e.message || "").trim().split("\n").filter(Boolean).join(" ").slice(0, 300);
      if (/--force/.test(detail)) return { status: "aviso", needs_force: true, message: detail };
      throw Object.assign(new CanvasError("sf_init_fallo", detail), { code: "sf_init_fallo", message: detail });
    }
  }
  if (actionName === "autofill") {
    // #82/#83: derivar owner/repo del remote y detectar el Project vinculado.
    const githubRepo = await deriveGithubRepo(repoDir);
    const out = { status: "autofill", github_repo: githubRepo, projects: [] };
    if (githubRepo) {
      try {
        out.projects = await listLinkedProjects(githubRepo);
      } catch (e) {
        out.note = `gh api falló: ${String(e.message).slice(0, 160)}`;
      }
    } else {
      out.note = "el repo no tiene remote origin en github.com";
    }
    return out;
  }
  if (actionName === "idea") {
    const { execFile } = await import("node:child_process");
    const { promisify } = await import("node:util");
    const out = await promisify(execFile)("node", [RUNNER, ...ideaRunnerArgs(repoDir, input)], { windowsHide: true });
    return JSON.parse(out.stdout.trim());
  }
  if (actionName === "github_status") {
    // #90: el panel debe poder continuar trabajo ya existente en GitHub: muestra las
    // issues/PRs abiertas reales del repo, no solo las del state.json del run actual.
    const state = await readState(repoDir);
    const rawRepo = typeof state?.repo === "string" ? state.repo : "";
    // state.repo puede ser basura (o faltar en un run sin Init): fallback al remote.
    const slug = /^[\w.-]+\/[\w.-]+$/.test(rawRepo) ? rawRepo : await deriveGithubRepo(repoDir);
    if (!slug) {
      return { status: "github_status", issues: [], pulls: [], note: "sin owner/repo: pulsa «Detectar» o completa Init" };
    }
    // getGithubStatus es blando: nunca lanza, devuelve listas + nota parcial.
    const out = await getGithubStatus(slug);
    return { status: "github_status", slug, ...out };
  }
  if (actionName === "import_issues") {
    // #90: vincula las issues abiertas al run para que la fase issues no las duplique.
    const state = await readState(repoDir);
    if (!state) throw new CanvasError("sf_no_state", "Ejecuta primero: node <runner>/sf.mjs init <repo> --repo owner/repo");
    let out;
    try {
      out = await importOpenIssues(state, {
        persistState: async () => {
          await saveState(repoDir, state);
          broadcast(repoDir, state);
        },
      });
    } catch {
      // Mensaje fijo: los errores de repoSlug/gh pueden citar valores del estado.
      throw new CanvasError("sf_import_fallo", "no se pudieron vincular las issues: revisa owner/repo con «Detectar»");
    }
    return { status: "import_issues", ...out };
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
        return applyAction(repoFrom(input), "next");
      },
    },
    {
      name: "github_status",
      description: "#90: lista issues y PRs abiertos del repo en GitHub (solo lectura).",
      handler({ input }) {
        return applyAction(repoFrom(input), "github_status");
      },
    },
    {
      name: "import_issues",
      description: "#90: vincula las issues abiertas de GitHub al run para no duplicarlas.",
      handler({ input }) {
        return applyAction(repoFrom(input), "import_issues");
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
