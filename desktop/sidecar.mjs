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

// Standalone runner/server.mjs must exist at DEFAULT_SERVER; otherwise spawning fails with a clear error.
export function startSidecar({ node = process.execPath, server = DEFAULT_SERVER, ...opts }) {
  if (!existsSync(server)) {
    throw new Error(`sidecar entrypoint not found: ${server} (standalone runner/server.mjs is required)`);
  }
  const child = spawn(node, buildSidecarArgs({ server, ...opts }), { stdio: "inherit" });
  return { child, url: sidecarUrl(opts.port), stop: () => child.kill() };
}

export const DEFAULT_PORT = 4317;

// Returns the value following `flag`, or undefined when absent or valueless.
export function getFlag(argv, flag) {
  const i = argv.indexOf(flag);
  if (i === -1) return undefined;
  const v = argv[i + 1];
  return v === undefined || v.startsWith("--") ? undefined : v;
}

export function parseCliArgs(argv, env = {}) {
  const port = getFlag(argv, "--port") ?? env.SF_PORT;
  return { repo: getFlag(argv, "--repo") ?? env.SF_REPO, port: port === undefined ? DEFAULT_PORT : Number(port) };
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const { child } = startSidecar(parseCliArgs(process.argv.slice(2), process.env));
  process.on("SIGINT", () => child.kill());
}