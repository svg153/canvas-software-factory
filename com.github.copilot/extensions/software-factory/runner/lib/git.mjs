// Derivación del identificador GitHub (owner/repo) desde el remote origin (#82).
import { execFile } from "node:child_process";
import { promisify } from "node:util";

const run = promisify(execFile);

// Acepta https://[user@]github.com/o/r(.git)[/], ssh://git@github.com/o/r(.git) y
// la forma scp git@github.com:o/r(.git). Devuelve "" para cualquier otra cosa.
export function parseRemoteUrl(url) {
  const s = String(url || "").trim().replace(/\/+$/, "").replace(/\.git$/, "");
  const m =
    /^git@github\.com:(.+)$/i.exec(s) ||
    /^ssh:\/\/git@github\.com\/(.+)$/i.exec(s) ||
    /^https?:\/\/(?:[^/@]+@)?github\.com\/(.+)$/i.exec(s);
  if (!m) return "";
  const slug = m[1];
  return /^[\w.-]+\/[\w.-]+$/.test(slug) && !slug.split("/")[1].startsWith("-") ? slug : "";
}

export async function deriveGithubRepo(repoDir, { exec = run } = {}) {
  try {
    const { stdout } = await exec("git", ["-C", repoDir, "remote", "get-url", "origin"], { windowsHide: true });
    return parseRemoteUrl(stdout);
  } catch {
    return "";
  }
}
