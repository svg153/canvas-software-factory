// Una fábrica terminada (status=done) no debe relanzarse en silencio: exige init.
export function startGuardError(state) {
  if (state?.status === "done") {
    return "La fábrica ya terminó (status=done). Ejecuta init <repo> --repo owner/repo para una nueva ejecución.";
  }
  return null;
}

export function initRunnerArgs(repoDir, input = {}) {
  const args = ["init", repoDir];
  if (input.repo) args.push("--repo", input.repo);
  if (input.project) args.push("--project", input.project);
  if (input.project_owner) args.push("--project-owner", input.project_owner);
  if (input.rounds) args.push("--rounds", String(input.rounds));
  return args;
}

// El texto de la idea viaja como argumento posicional (no como flag) para que el runner
// lo lea tal cual; se recorta por si el campo llega con espacios o vacío.
export function ideaRunnerArgs(repoDir, input = {}) {
  const text = typeof input.idea === "string" ? input.idea.trim() : "";
  return ["idea", repoDir, text];
}

// Args para la ingesta mecánica del repo (snapshot de issues/PRs/Project abiertos).
// Sin argumentos extra: `sf.mjs intake <repoDir>`.
export function intakeRunnerArgs(repoDir) {
  return ["intake", repoDir];
}
