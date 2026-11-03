// Software Factory canvas — cliente fino del SDK; la lógica vive en runner/lib/service.mjs.
import { CanvasError, createCanvas, joinSession } from "@github/copilot-sdk/extension";
import { createFactoryService, ActionError } from "./runner/lib/service.mjs";
import { bootstrapPrompt } from "./runner/lib/prompts.mjs";
import { RUNNER } from "./runner/lib/service.mjs";

let session;
const repoOf = (input) => input?.repo || session?.workspacePath || process.cwd();

const service = createFactoryService({
  defaultRepo: () => session?.workspacePath || process.cwd(),
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
    throw e instanceof ActionError ? new CanvasError(e.code, e.message) : e;
  });
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
        return applyAction(repoOf(input), "get_state");
      },
    },
    {
      name: "play",
      description: "Pone la fábrica en running y envía al agente el prompt de arranque del bucle.",
      handler({ input }) {
        return applyAction(repoOf(input), "play");
      },
    },
    {
      name: "pause",
      description: "Pausa la fábrica (status=paused).",
      handler({ input }) {
        return applyAction(repoOf(input), "pause");
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
        const repoDir = repoOf(input);
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
        return applyAction(repoOf(input), "next");
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
