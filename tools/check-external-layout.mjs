#!/usr/bin/env node
// Comprobación LOCAL y PARCIAL del layout externo del plugin. Dos bloques:
//
// 1) Estructura: espejo de algunas comprobaciones de runCanvasStructureGate
//    (github/awesome-copilot eng/external-plugin-quality-gates.mjs): con la
//    keyword "canvas" exige la fuente canónica versionada en
//    com.github.copilot/extensions/<id>/extension.mjs, sin copias duplicadas
//    fuera del namespace, skills/<id>/SKILL.md por convención en la raíz y
//    sin canvas.json versionado (se genera en el destino de instalación).
// 2) Manifest: plugin.json validado contra la copia VENDIDA del esquema
//    oficial Agent Plugins 1.0.0 (tools/schemas/agent-plugins-1.0.0.plugin.schema.json,
//    descargada de https://agent-plugins.org/schemas/1.0.0/plugin.schema.json)
//    mediante un validador mínimo sin dependencias que implementa exactamente
//    las palabras usadas por ese esquema: type, const, required, properties,
//    additionalProperties, items, pattern, minLength, maxLength. No es un
//    validador JSON Schema completo: cualquier palabra del esquema no
//    soportada se reporta como error (falla en abierto, nunca se ignora en
//    silencio), así que una actualización del esquema oficial no puede pasar
//    como "validado" sin ampliar este validador.
//
// LIMITACIÓN: el gate oficial completo de awesome-copilot (y los requisitos
// semánticos/operacionales adicionales de la especificación Agent Plugins)
// NO se ejecutan aquí; esta herramienta solo anuncia lo que comprueba.
import { readFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";

const SCHEMA_URL = new URL("./schemas/agent-plugins-1.0.0.plugin.schema.json", import.meta.url);

const SUPPORTED_WORDS = new Set([
  "$schema", "$id", "title", "description", "type", "const", "required",
  "properties", "additionalProperties", "items", "pattern", "minLength", "maxLength",
]);

// Validador mínimo JSON Schema (solo las palabras del esquema vendido; ver
// comentario de cabecera). Devuelve una lista de errores legibles.
export function validateAgainstSchema(value, schema, path = "$") {
  const errors = [];
  const fail = (msg) => errors.push(`${path}: ${msg}`);

  if (schema.type) {
    const actual = Array.isArray(value) ? "array"
      : value === null ? "null" : typeof value;
    if (actual !== schema.type) { fail(`tipo esperado '${schema.type}', encontrado '${actual}'`); return errors; }
  }
  if ("const" in schema && value !== schema.const) fail(`debe ser exactamente '${schema.const}'`);

  if (typeof value === "string") {
    if ("minLength" in schema && value.length < schema.minLength) fail(`longitud mínima ${schema.minLength}`);
    if ("maxLength" in schema && value.length > schema.maxLength) fail(`longitud máxima ${schema.maxLength}`);
    if (schema.pattern && !new RegExp(schema.pattern).test(value)) fail(`no coincide con el patrón '${schema.pattern}'`);
  }

  if (Array.isArray(value) && schema.items) {
    value.forEach((item, i) => errors.push(...validateAgainstSchema(item, schema.items, `${path}[${i}]`)));
  }

  if (value && typeof value === "object" && !Array.isArray(value)) {
    for (const key of schema.required ?? []) {
      if (!(key in value)) fail(`falta el campo requerido '${key}'`);
    }
    const known = new Set(Object.keys(schema.properties ?? {}));
    for (const [k, sub] of Object.entries(schema.properties ?? {})) {
      if (k in value) errors.push(...validateAgainstSchema(value[k], sub, `${path}.${k}`));
    }
    if ("additionalProperties" in schema) {
      for (const k of Object.keys(value)) {
        if (known.has(k)) continue;
        const ap = schema.additionalProperties;
        if (ap === false) fail(`campo no permitido '${k}'`);
        else if (ap && typeof ap === "object") errors.push(...validateAgainstSchema(value[k], ap, `${path}.${k}`));
        else fail("additionalProperties con valor no soportado por el validador mínimo");
      }
    }
  }

  for (const word of Object.keys(schema)) {
    if (!SUPPORTED_WORDS.has(word)) {
      fail(`palabra de esquema '${word}' no soportada por el validador mínimo (ampliarlo o revisar el esquema)`);
    }
  }
  return errors;
}

export async function validatePluginManifest(manifest) {
  const schema = JSON.parse(await readFile(SCHEMA_URL, "utf8"));
  return validateAgainstSchema(manifest, schema, "plugin.json");
}

export async function checkExternalLayout(repoRoot) {
  const errors = [];
  const plugin = JSON.parse(await readFile(join(repoRoot, "plugin.json"), "utf8"));

  // 1) Manifest contra la copia vendida del esquema oficial Agent Plugins 1.0.0.
  errors.push(...await validatePluginManifest(plugin));

  // 2) Convenciones semánticas que el esquema JSON no expresa (espejo parcial del gate).
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
  try { await readFile(join(nsDir, "extension.mjs")); } catch { errors.push(`falta ${id}/extension.mjs en com.github.copilot/extensions/`); }

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
    console.error("Comprobación parcial de layout/manifest fallida:");
    for (const error of errors) console.error(`  - ${error}`);
    process.exit(1);
  }
  console.log("Comprobación parcial de layout/manifest OK: estructura espejo del gate de canvas + plugin.json validado contra la copia vendida del esquema Agent Plugins 1.0.0. (El gate oficial completo de awesome-copilot no se ejecuta aquí.)");
}
