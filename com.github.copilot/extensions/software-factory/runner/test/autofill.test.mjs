// Tests de autocompletado owner/repo (#82), detección de Project (#83) y
// renombrado del campo (#84).
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { parseRemoteUrl, deriveGithubRepo } from "../lib/git.mjs";
import { projectsV2Args, parseProjectsV2, listLinkedProjects } from "../lib/gh.mjs";

const extDir = join(dirname(fileURLToPath(import.meta.url)), "..", "..");

test("parseRemoteUrl acepta las formas habituales de origin en github.com", () => {
  assert.equal(parseRemoteUrl("https://github.com/svg153/canvas-software-factory.git"), "svg153/canvas-software-factory");
  assert.equal(parseRemoteUrl("https://github.com/o/r"), "o/r");
  assert.equal(parseRemoteUrl("git@github.com:o/r.git"), "o/r");
  assert.equal(parseRemoteUrl("ssh://git@github.com/o/r"), "o/r");
  assert.equal(parseRemoteUrl("https://token@github.com/o/r.git\n"), "o/r");
});

test("parseRemoteUrl rechaza todo lo que no sea owner/repo en github.com", () => {
  assert.equal(parseRemoteUrl(""), "");
  assert.equal(parseRemoteUrl("no es una url"), "");
  assert.equal(parseRemoteUrl("https://gitlab.com/o/r.git"), "");
  assert.equal(parseRemoteUrl("https://github.com/o"), "");
  assert.equal(parseRemoteUrl("https://github.com/o/r/s"), "");
  assert.equal(parseRemoteUrl("git@github.com:o/-r.git"), "");
});

test("deriveGithubRepo ejecuta git remote get-url origin y tolera fallos", async () => {
  const calls = [];
  const exec = async (cmd, args) => {
    calls.push([cmd, ...args]);
    return { stdout: "git@github.com:o/r.git\n" };
  };
  assert.equal(await deriveGithubRepo("C:\\repo", { exec }), "o/r");
  assert.deepEqual(calls[0], ["git", "-C", "C:\\repo", "remote", "get-url", "origin"]);
  assert.equal(await deriveGithubRepo("C:\\repo", { exec: async () => { throw new Error("no remote"); } }), "");
});

test("projectsV2Args construye la consulta graphql y valida el slug", () => {
  const args = projectsV2Args("o/r");
  assert.deepEqual(args.slice(0, 6), ["api", "graphql", "-f", "owner=o", "-f", "name=r"]);
  assert.ok(args.at(-1).startsWith("query="));
  assert.match(args.at(-1), /projectsV2/);
  // ProjectV2Owner es unión: login debe pedirse via inline fragments, no directo.
  assert.match(args.at(-1), /\.\.\. on User \{ login \}/);
  assert.match(args.at(-1), /\.\.\. on Organization \{ login \}/);
  assert.ok(!/owner\{\s*login\s*\}/.test(args.at(-1)));
  assert.throws(() => projectsV2Args("bad slug"), /inválido/);
  assert.throws(() => projectsV2Args("o/-r"), /inválido/);
});

test("parseProjectsV2 mapea los nodes y tolera salidas inesperadas", () => {
  const stdout = JSON.stringify({
    data: {
      repository: {
        projectsV2: {
          nodes: [
            { number: 5, title: "Board", owner: { login: "me" } },
            { number: "7", title: "", owner: null },
            { title: "sin número" },
          ],
        },
      },
    },
  });
  assert.deepEqual(parseProjectsV2(stdout), [
    { number: 5, title: "Board", owner: "me" },
    { number: 7, title: "", owner: "" },
  ]);
  assert.deepEqual(parseProjectsV2("no json"), []);
  assert.deepEqual(parseProjectsV2(JSON.stringify({ data: { repository: null } })), []);
});

test("listLinkedProjects inyecta runGh (sin tocar la CLI real)", async () => {
  const seen = [];
  const runGh = async (args) => {
    seen.push(args);
    return JSON.stringify({ data: { repository: { projectsV2: { nodes: [{ number: 5, title: "B", owner: { login: "o" } }] } } } });
  };
  assert.deepEqual(await listLinkedProjects("o/r", { runGh }), [{ number: 5, title: "B", owner: "o" }]);
  assert.equal(seen[0][0], "api");
  await assert.rejects(listLinkedProjects("o/r", { runGh: async () => { throw new Error("auth"); } }), /auth/);
});

test("index.html: campo renombrado a Project board ID y botón Detectar (#84/#83)", () => {
  const html = readFileSync(join(extDir, "index.html"), "utf8");
  assert.ok(html.includes('placeholder="Project board ID (opc.)"'));
  assert.ok(!html.includes("Project nº"));
  assert.ok(html.includes('id="detectBtn"'));
});

test("extension.mjs: acción autofill con las dos derivaciones (#82/#83)", () => {
  // Tras la fusión la lógica de autofill vive en service.mjs (extension.mjs es cliente fino).
  const svc = readFileSync(join(extDir, "runner", "lib", "service.mjs"), "utf8");
  assert.match(svc, /actionName === "autofill"/);
  assert.match(svc, /deriveGithubRepo\(repoDir\)/);
  assert.match(svc, /listLinkedProjects\(githubRepo\)/);
  assert.match(svc, /import \{ deriveGithubRepo \} from "\.\/git\.mjs"/);
});
