#!/usr/bin/env node
// Servidor standalone del panel (sin Copilot App ni @github/copilot-sdk).
// Uso: node server.mjs [--repo <ruta>] [--port N] [--allow-repo <ruta>]... [--allow-host <host>]...
import { realpathSync } from "node:fs";
import { resolve, relative, isAbsolute } from "node:path";
import { fileURLToPath } from "node:url";
import { createFactoryService } from "./lib/service.mjs";

export const STANDALONE_PLAY_HINT =
  "Máquina de estados iniciada (start). Los work orders los consume `sf-run` (o una sesión de Copilot); este panel no lanza agentes.";

export function parseServerArgs(argv) {
  const out = { repo: process.cwd(), port: 0, allow: [], allowHosts: [] };
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === "--repo") out.repo = argv[++i];
    else if (argv[i] === "--port") out.port = Number(argv[++i]);
    else if (argv[i] === "--allow-repo") out.allow.push(argv[++i]);
    else if (argv[i] === "--allow-host") out.allowHosts.push(argv[++i]);
  }
  if (!Number.isInteger(out.port) || out.port < 0 || out.port > 65535) throw new Error("--port inválido");
  out.repo = resolve(out.repo);
  out.allow = [out.repo, ...out.allow.map((p) => resolve(p))];
  return out;
}

function realOrSelf(p) {
  try {
    return realpathSync.native(p);
  } catch {
    return resolve(p);
  }
}

export async function startStandalone(argv) {
  const { repo, port, allow, allowHosts } = parseServerArgs(argv);
  const inside = (root, p) => {
    const rel = relative(root, p);
    return rel === "" || (!rel.startsWith("..") && !isAbsolute(rel));
  };
  const service = createFactoryService({
    defaultRepo: () => repo,
    playMessage: STANDALONE_PLAY_HINT,
    allowHosts,
    resolveRepo(requested) {
      // Sin ?repo= se usa el repo por defecto (mismo contrato que createRepoAllowlist:
      // resolve("") -> defaultRepo); con ?repo= se valida contra la allowlist.
      const target = resolve(requested || repo);
      // realpath en ambos lados: evita bypass por symlinks o prefijos léxicos.
      const real = realOrSelf(target);
      if (!allow.some((root) => inside(realOrSelf(root), real))) throw new Error("repo fuera de la allowlist (--allow-repo)");
      return real;
    },
  });
  const url = await service.listen(port);
  return { url, repo, close: () => service.server.close() };
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const { url, repo } = await startStandalone(process.argv.slice(2));
  console.log(`Software Factory panel: ${url}/ (repo ${repo})`);
}
