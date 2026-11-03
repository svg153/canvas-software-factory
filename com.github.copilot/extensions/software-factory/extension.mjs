// Software Factory canvas — cliente fino del SDK; la lógica vive en runner/lib/service.mjs.
import { statSync, realpathSync } from "node:fs";
import { join } from "node:path";
import { CanvasError, createCanvas, joinSession } from "@github/copilot-sdk/extension";
import { createFactoryService, ActionError } from "./runner/lib/service.mjs";
import { createRepoAllowlist } from "./runner/lib/allowlist.mjs";
import { bootstrapPrompt } from "./runner/lib/prompts.mjs";
import { RUNNER } from "./runner/lib/service.mjs";

let session;
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

const service = createFactoryService({
  defaultRepo,
  resolveRepo: resolveRepoInput,
  async onPlay(repoDir, state) {
    if (!session) return false;
    await session.send({ prompt: bootstrapPrompt(repoDir, RUNNER, state) });
    return true;
  },
  playMessage: "Fábrica en running (sin sesión Copilot activa).",
});
const baseUrl = await service.listen(0);
const applyAction = (repoDir, name, input) =>
  service.applyAction(repoDir, name, input).catch((e) => {
    if (e instanceof ActionError) throw new CanvasError(e.code, e.message);
    // El host de extensiones no es una sesión de chat: sin repo válido no hay fábrica.
    if (name !== "get_state" && !repoIsGitWorkspace(repoDir)) {
      throw new CanvasError("sf_repo_no_permitido",
        "El panel no tiene un repo de trabajo. Escribe la ruta absoluta de tu workspace (git) en el campo «Repo» y pulsa «Usar repo».");
    }
    throw e;
  });
const factoryCanvas = createCanvas({
  id: "software-factory",
  displayName: "Software Factory",
  description:
    "Panel tipo GitHub Project: pipeline por fases, tablero kanban, grafo de dependencias por olas y orden de merge, en rounds autónomos.",
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
        // #92: no usar session.workspacePath (apunta al repo equivocado en worktrees).
        // repoFrom() ya resuelve: input.repo → allowlist.resolve().
        const repoDir = repoFrom(input);
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
    {
      name: "create_project",
      description: "Crea el GitHub Project (tablero kanban) para el run si no existe y lo enlaza al repo.",
      handler({ input }) {
        return applyAction(repoFrom(input), "create_project");
      },
    },
    {
      name: "sync_project",
      description: "Sincroniza el campo Status del Project con el tablero derivado del estado (Backlog/Todo/In Progress/In Review/Done).",
      handler({ input }) {
        return applyAction(repoFrom(input), "sync_project");
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