import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
export const DEFAULT_SERVER = path.resolve(here, "..", "com.github.copilot", "extensions", "software-factory", "runner", "server.mjs");

export function buildSidecarArgs({ server = DEFAULT_SERVER, repo, port, allowRepo = repo }) {
  if (!repo) throw new Error("repo is required");
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error("valid port is required");
  return [server, "--repo", repo, "--port", String(port), "--allow-repo", allowRepo];
}

export function sidecarUrl(port) {
  return `http://127.0.0.1:${port}/`;
}

// Standalone runner/server.mjs lands with PR #52; until then spawning fails with a clear error.
export function startSidecar({ node = process.execPath, server = DEFAULT_SERVER, ...opts }) {
  if (!existsSync(server)) {
    throw new Error(`sidecar entrypoint not found: ${server} (standalone server.mjs requires PR #52)`);
  }
  const child = spawn(node, buildSidecarArgs({ server, ...opts }), { stdio: "inherit" });
  return { child, url: sidecarUrl(opts.port), stop: () => child.kill() };
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const get = (f) => process.argv[process.argv.indexOf(f) + 1];
  const { child } = startSidecar({ repo: get("--repo"), port: Number(get("--port") ?? 4317) });
  process.on("SIGINT", () => child.kill());
}