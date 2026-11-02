#!/usr/bin/env node
// Genera el manifiesto de registro canvas.json en el DESTINO de instalación.
// La convención de awesome-copilot (CONTRIBUTING.md, "Adding Canvas Extensions")
// prohíbe distribuir canvas.json dentro del árbol de la extensión: los metadatos
// se obtienen del manifiesto del plugin. Aquí mantenemos la fuente editable en
// canvas-meta.json (datos del canvas) + plugin.json (versión y autor), y el
// instalador materializa el resultado donde la app de Copilot lo carga.
import { readFile, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";

export async function buildCanvasManifest(repoRoot) {
  const [meta, plugin] = await Promise.all([
    readFile(join(repoRoot, "canvas-meta.json"), "utf8").then(JSON.parse),
    readFile(join(repoRoot, "plugin.json"), "utf8").then(JSON.parse),
  ]);
  const manifest = {
    id: meta.id,
    name: meta.name,
    description: meta.description,
    version: plugin.version,
    author: plugin.author?.name ?? meta.author ?? "",
    keywords: meta.keywords ?? [],
    main: meta.main ?? "extension.mjs",
  };
  if (!manifest.id || !manifest.name || !manifest.main) {
    throw new Error("canvas-meta.json requires id, name and main");
  }
  return manifest;
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const [repoRoot, targetDir] = process.argv.slice(2);
  if (!repoRoot || !targetDir) {
    console.error("Uso: node tools/make-canvas-manifest.mjs <repoRoot> <dirExtensiónInstalada>");
    process.exit(1);
  }
  const manifest = await buildCanvasManifest(repoRoot);
  const out = join(targetDir, "canvas.json");
  await writeFile(out, JSON.stringify(manifest, null, 2) + "\n");
  console.log(`canvas.json -> ${out}`);
}
