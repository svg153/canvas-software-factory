// Lógica compartida (estado, SSE, acciones) usada por el canvas de Copilot y por server.mjs.
// Sin dependencia del SDK de Copilot: el ejecutor de "play" se inyecta con onPlay.
import { readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { execFile } from "node:child_process";
import { promisify } from "node:util";

import { createFactoryServer } from "./http.mjs";
import { initRunnerArgs, ideaRunnerArgs, intakeRunnerArgs, startGuardError } from "./actions.mjs";
import { deriveGithubRepo } from "./git.mjs";
import { listLinkedProjects, getGithubStatus, importOpenIssues } from "./gh.mjs";
import { saveState, updateState } from "./state.mjs";

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
    if (!(await readState(repoDir))) throw new ActionError("sf_no_state", "Ejecuta primero: node <runner>/sf.mjs init <repo> --repo owner/repo");
    // Escritura bajo lock: paneles/runner concurrentes no se pisan (main #writeStatus).
    const state = await updateState(repoDir, (s) => {
      s.status = status;
      s.updated_at = new Date().toISOString();
      return s;
    });
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
      let out;
      try {
        out = await run("node", [RUNNER, ...initRunnerArgs(repoDir, input)], { windowsHide: true });
      } catch (e) {
        // #88: el runner aborta exit 1 con un mensaje accionable (p. ej. estado existente
        // sin --force). Sin este catch el usuario solo veía el código genérico.
        const detail = String(e.stderr || e.stdout || e.message || "").trim().split("\n").filter(Boolean).join(" ").slice(0, 300);
        if (/--force/.test(detail)) return { status: "aviso", needs_force: true, message: detail };
        throw new ActionError("sf_init_fallo", detail);
      }
      return { status: "inicializado", output: out.stdout.trim() };
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
    if (actionName === "idea" || actionName === "add_idea") {
      const out = await run("node", [RUNNER, ...ideaRunnerArgs(repoDir, input)], { windowsHide: true });
      return JSON.parse(out.stdout.trim());
    }
    if (actionName === "intake") {
      // Ingesta del repo (#56): issues/PRs/Project ya abiertos → state.inventory.
      const out = await run("node", [RUNNER, ...intakeRunnerArgs(repoDir)], { windowsHide: true });
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
      if (!state) throw new ActionError("sf_no_state", "Ejecuta primero: node <runner>/sf.mjs init <repo> --repo owner/repo");
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
        throw new ActionError("sf_import_fallo", "no se pudieron vincular las issues: revisa owner/repo con «Detectar»");
      }
      return { status: "import_issues", ...out };
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
