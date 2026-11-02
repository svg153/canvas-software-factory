#!/usr/bin/env node
// Comprobación automatizada del layout externo del plugin, espejo local de
// runCanvasStructureGate (github/awesome-copilot eng/external-plugin-quality-gates.mjs):
// cuando plugin.json declara la keyword "canvas", debe existir la fuente canónica
// versionada en com.github.copilot/extensions/<id>/extension.mjs, sin copias
// duplicadas fuera del namespace, con skills/ descubribles por convención en la
// raíz y con un plugin.json conforme al esquema Agent Plugins 1.0 (sin campos extra).
import { readFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";

const ALLOWED_TOP_LEVEL = new Set([
  "$schema", "name", "version", "description", "author",
  "homepage", "repository", "license", "keywords", "extensions",
]);

export async function checkExternalLayout(repoRoot) {
  const errors = [];
  const plugin = JSON.parse(await readFile(join(repoRoot, "plugin.json"), "utf8"));

  for (const key of Object.keys(plugin)) {
    if (!ALLOWED_TOP_LEVEL.has(key)) errors.push(`plugin.json: campo no permitido '${key}'`);
  }
  if (plugin.$schema !== "https://agent-plugins.org/schemas/1.0.0/plugin.schema.json") {
    errors.push("plugin.json: $schema debe ser la de Agent Plugins 1.0.0");
  }
  const logo = plugin.extensions?.["com.github.copilot"]?.logo;
  if (logo !== "assets/preview.png") {
    errors.push("plugin.json: extensions.com.github.copilot.logo debe ser 'assets/preview.png'");
  }

  const canvasKeyword = Array.isArray(plugin.keywords) && plugin.keywords.includes("canvas");
  if (!canvasKeyword) {
    errors.push("plugin.json: falta la keyword 'canvas' (el gate de estructura no aplicaría)");
  }

  const id = "software-factory";
  const nsDir = join(repoRoot, "com.github.copilot", "extensions", id);
  const nsEntry = join(nsDir, "extension.mjs");
  try { await readFile(nsEntry); } catch { errors.push(`falta ${id}/extension.mjs en com.github.copilot/extensions/`); }

  // Fuente canónica única: no debe quedar una segunda copia en la antigua ruta raíz.
  try {
    await readFile(join(repoRoot, "extensions", id, "extension.mjs"));
    errors.push("existe una copia duplicada de la extensión en extensions/ (sin namespace)");
  } catch { /* correcto: no existe */ }

  // El árbol distribuido no versiona canvas.json (se genera en el destino).
  try {
    await readFile(join(nsDir, "canvas.json"));
    errors.push("canvas.json no debe estar versionado en el árbol de la extensión");
  } catch { /* correcto */ }

  // Skills por convención Agent Plugins 1.0: skills/<id>/SKILL.md en la raíz del paquete.
  try { await readFile(join(repoRoot, "skills", id, "SKILL.md")); }
  catch { errors.push("falta skills/software-factory/SKILL.md en la raíz del paquete"); }

  return errors;
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const repoRoot = process.argv[2] ?? process.cwd();
  const errors = await checkExternalLayout(repoRoot);
  if (errors.length) {
    console.error("Layout externo inválido:");
    for (const error of errors) console.error(`  - ${error}`);
    process.exit(1);
  }
  console.log("Layout externo OK (gate de estructura de canvas + esquema Agent Plugins 1.0).");
}
