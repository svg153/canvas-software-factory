export function initRunnerArgs(repoDir, input = {}) {
  const args = ["init", repoDir];
  if (input.repo) args.push("--repo", input.repo);
  if (input.project) args.push("--project", input.project);
  if (input.project_owner) args.push("--project-owner", input.project_owner);
  if (input.rounds) args.push("--rounds", String(input.rounds));
  return args;
}
