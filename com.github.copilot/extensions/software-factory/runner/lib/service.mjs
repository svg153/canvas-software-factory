// Lógica compartida (estado, SSE, acciones) usada por el canvas de Copilot y por server.mjs.
// Sin dependencia del SDK de Copilot: el ejecutor de "play" se inyecta con onPlay.
import { readFile, writeFile, mkdir } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { execFile } from "node:child_process";
import { promisify } from "node:util";

import { createFactoryServer } from "./http.mjs";
import { initRunnerArgs, startGuardError } from "./actions.mjs";

const RUNNER_DIR = join(dirname(fileURLToPath(import.meta.url)), "..");
export const RUNNER = join(RUNNER_DIR, "sf.mjs");
export const EXTENSION_DIR = join(RUNNER_DIR, "..");
const run = promisify(execFile);

export class ActionError extends Error {
  constructor(code, message) {
    super(message);
    this.code = code;
  }
}

export function createFactoryService({ defaultRepo, onPlay, resolveRepo, playMessage, allowHosts }) {
  const subscribers = new Map();
  const watchers = new Map();
  const statePath = (repoDir) => join(repoDir, ".software-factory", "state.json");

  async function readState(repoDir) {
    try {
      return JSON.parse(await readFile(statePath(repoDir), "utf8"));
    } catch {
      return null;
    }
  }

  function broadcast(repoDir, state) {
    const subs = subscribers.get(repoDir);
    if (!subs) return;
    const payload = `data: ${JSON.stringify(state)}\n\n`;
    for (const res of subs) res.write(payload);
  }

  // El timer se libera cuando el repo se queda sin suscriptores.
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
    timer.unref?.();
    watchers.set(repoDir, timer);
  }

  async function writeStatus(repoDir, status) {
    const state = await readState(repoDir);
    if (!state) throw new ActionError("sf_no_state", "Ejecuta primero: node <runner>/sf.mjs init <repo> --repo owner/repo");
    state.status = status;
    state.updated_at = new Date().toISOString();
    await mkdir(join(repoDir, ".software-factory"), { recursive: true });
    await writeFile(statePath(repoDir), JSON.stringify(state, null, 2));
    broadcast(repoDir, state);
    return state;
  }

  async function applyAction(repoDir, actionName, input = {}) {
    if (actionName === "get_state") {
      const state = await readState(repoDir);
      return { status: state ? `${state.phase} (round ${state.round})` : "sin estado", state, notes: state?.notes || "", runner: RUNNER };
    }
    if (actionName === "play") {
      const guard = startGuardError(await readState(repoDir));
      if (guard) throw new ActionError("sf_done", guard);
      const state = await writeStatus(repoDir, "running");
      const launched = onPlay ? await onPlay(repoDir, state) : false;
      return { status: launched ? "Fábrica lanzada — el agente recibió el prompt de arranque" : playMessage, state };
    }
    if (actionName === "pause") {
      return { status: "Fábrica en pausa", state: await writeStatus(repoDir, "paused") };
    }
    if (actionName === "init") {
      const out = await run("node", [RUNNER, ...initRunnerArgs(repoDir, input)], { windowsHide: true });
      return { status: "inicializado", output: out.stdout.trim() };
    }
    if (actionName === "next") {
      const out = await run("node", [RUNNER, "next", repoDir], { windowsHide: true });
      return JSON.parse(out.stdout.trim());
    }
    throw new ActionError("sf_unknown_action", `Acción desconocida: ${actionName}`);
  }

  const server = createFactoryServer({
    extensionDir: EXTENSION_DIR,
    defaultRepo,
    resolveRepo,
    allowHosts,
    readState,
    ensureWatch,
    applyAction,
    subscribe(repoDir, res) {
      if (!subscribers.has(repoDir)) subscribers.set(repoDir, new Set());
      subscribers.get(repoDir).add(res);
      res.on("close", () => subscribers.get(repoDir)?.delete(res));
    },
  });

  async function listen(port = 0) {
    await new Promise((resolve, reject) => {
      server.once("error", reject);
      server.listen(port, "127.0.0.1", resolve);
    });
    return `http://127.0.0.1:${server.address().port}`;
  }

  return { server, listen, applyAction, readState };
}
