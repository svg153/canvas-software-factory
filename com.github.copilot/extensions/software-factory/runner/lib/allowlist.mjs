import { realpathSync, statSync } from "node:fs";
import { delimiter, isAbsolute, relative, sep } from "node:path";

const CASE_INSENSITIVE = process.platform === "win32" || process.platform === "darwin";

export class RepoNotAllowedError extends Error {
  constructor() {
    super("sf_repo_no_permitido");
    this.code = "sf_repo_no_permitido";
  }
}

function canonicalDir(value) {
  if (typeof value !== "string" || !value || value.includes("\0") || !isAbsolute(value)) return null;
  try {
    const real = realpathSync.native(value);
    return statSync(real).isDirectory() ? real : null;
  } catch {
    return null;
  }
}

function within(root, dir) {
  const norm = (p) => (CASE_INSENSITIVE ? p.toLowerCase() : p);
  const rel = relative(norm(root), norm(dir));
  return rel === "" || (!rel.startsWith("..") && !isAbsolute(rel) && !rel.startsWith(`..${sep}`));
}

// Raíces permitidas: workspace de la sesión + las autorizadas explícitamente
// (apertura del canvas con input.repo o SF_ALLOWED_ROOTS). Todo se compara con realpath.
export function createRepoAllowlist({ defaultRepo, env = process.env }) {
  const extra = new Set();
  for (const root of String(env.SF_ALLOWED_ROOTS || "").split(delimiter)) {
    const real = canonicalDir(root.trim());
    if (real) extra.add(real);
  }
  const roots = () => {
    const base = canonicalDir(defaultRepo());
    return base ? [base, ...extra] : [...extra];
  };
  return {
    authorize(dir) {
      const real = canonicalDir(dir);
      if (!real) throw new RepoNotAllowedError();
      extra.add(real);
      return real;
    },
    resolve(requested) {
      if (requested === undefined || requested === null || requested === "") return defaultRepo();
      const real = canonicalDir(requested);
      if (!real || !roots().some((root) => within(root, real))) throw new RepoNotAllowedError();
      return real;
    },
  };
}
