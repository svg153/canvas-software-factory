#!/usr/bin/env node
// Cross-platform Software Factory installer (runner + skill per harness). Node 20+, no deps.
// Usage: sf-install.mjs --harness <copilot|claude|codex|opencode|generic> [--home DIR] [--dry-run] [--check]
//   --check: read-only; reports DRIFT and 'STALE: <path>' for installed runner files no longer in the repo (exit 1).
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const EXT = path.join(REPO, 'com.github.copilot', 'extensions', 'software-factory');
const SKILL_SRC = path.join(REPO, 'skills', 'software-factory', 'SKILL.md');
const MARKER = '.sf-install.json';
const BEGIN = '<!-- BEGIN software-factory -->';
const END = '<!-- END software-factory -->';

const REQUIRED = [
  ['com.github.copilot', 'extensions', 'software-factory', 'runner', 'sf.mjs'],
  ['com.github.copilot', 'extensions', 'software-factory', 'runner', 'lib', 'actions.mjs'],
  ['com.github.copilot', 'extensions', 'software-factory', 'runner', 'lib', 'gh.mjs'],
  ['com.github.copilot', 'extensions', 'software-factory', 'runner', 'lib', 'http.mjs'],
  ['com.github.copilot', 'extensions', 'software-factory', 'runner', 'lib', 'prompts.mjs'],
  ['com.github.copilot', 'extensions', 'software-factory', 'runner', 'lib', 'state.mjs'],
  ['skills', 'software-factory', 'SKILL.md'],
  ['plugin.json'],
];

export const HARNESSES = ['copilot', 'claude', 'codex', 'opencode', 'generic'];

// Pure path resolution per harness (unit-testable).
export function targetsFor(harness, home) {
  const j = (...p) => path.join(home, ...p);
  const skillDirs = {
    copilot: j('.copilot', 'skills', 'software-factory'),
    claude: j('.claude', 'skills', 'software-factory'),
    codex: j('.codex', 'skills', 'software-factory'),
    opencode: j('.config', 'opencode', 'skill', 'software-factory'),
  };
  if (harness === 'generic') {
    const base = j('.software-factory');
    return { runnerDir: path.join(base, 'runner'), markerDir: base, skillDir: null, agentsFile: j('AGENTS.md') };
  }
  const dir = skillDirs[harness];
  if (!dir) throw new Error(`harness desconocido: ${harness} (usa ${HARNESSES.join('|')})`);
  return { runnerDir: path.join(dir, 'runner'), markerDir: dir, skillDir: dir, agentsFile: null };
}

function parseArgs(argv) {
  const o = { harness: null, home: null, check: false, dryRun: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--harness') o.harness = argv[++i];
    else if (a === '--home') o.home = argv[++i];
    else if (a === '--check') o.check = true;
    else if (a === '--dry-run') o.dryRun = true;
    else throw new Error(`argumento desconocido: ${a}`);
  }
  if (!o.harness) throw new Error('falta --harness <' + HARNESSES.join('|') + '>');
  return o;
}

function validateSource() {
  const missing = REQUIRED.filter((p) => !fs.existsSync(path.join(REPO, ...p))).map((p) => p.join('/'));
  if (missing.length) throw new Error(`Origen incompleto, no se escribe nada. Faltan: ${missing.join(', ')}`);
  try { return JSON.parse(fs.readFileSync(path.join(REPO, 'plugin.json'), 'utf8')); }
  catch (e) { throw new Error(`plugin.json no es JSON valido: ${e.message}`); }
}

function listFiles(dir, base = dir) {
  const out = [];
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, e.name);
    if (e.isDirectory()) out.push(...listFiles(full, base));
    else if (e.isFile()) out.push(path.relative(base, full).split(path.sep).join('/'));
  }
  return out.sort();
}

const sha = (file) => crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');

// Runner tree excludes tests and test-support; it has no SDK dependency.
function runnerFiles() {
  const root = path.join(EXT, 'runner');
  return listFiles(root).filter((f) => !f.startsWith('test/') && !f.startsWith('test-support/'));
}

function skillBlock() {
  const body = fs.readFileSync(SKILL_SRC, 'utf8').replace(/\r\n/g, '\n').trimEnd();
  return `${BEGIN}\n${body}\n${END}\n`;
}

function applyBlock(existing, block) {
  const s = existing.indexOf(BEGIN);
  const e = existing.indexOf(END);
  if (s !== -1 && e > s) return existing.slice(0, s) + block.trimEnd() + existing.slice(e + END.length);
  const sep = existing.length === 0 ? '' : existing.endsWith('\n') ? '\n' : '\n\n';
  return existing + sep + block;
}

function buildPlan(harness, home, version) {
  const t = targetsFor(harness, home);
  const actions = [];
  const hashes = {};
  const root = path.join(EXT, 'runner');
  for (const rel of runnerFiles()) {
    actions.push({ type: 'copy', src: path.join(root, ...rel.split('/')), dest: path.join(t.runnerDir, ...rel.split('/')) });
    hashes['runner/' + rel] = sha(path.join(root, ...rel.split('/')));
  }
  if (t.skillDir) {
    actions.push({ type: 'copy', src: SKILL_SRC, dest: path.join(t.skillDir, 'SKILL.md') });
    hashes['SKILL.md'] = sha(SKILL_SRC);
  } else {
    actions.push({ type: 'block', dest: t.agentsFile });
    hashes['SKILL.md'] = sha(SKILL_SRC);
  }
  const marker = { name: 'software-factory', harness, version, files: hashes };
  actions.push({ type: 'marker', dest: path.join(t.markerDir, MARKER), marker });
  return { t, actions, marker };
}

function install(plan, dryRun, log) {
  for (const a of plan.actions) {
    log(`${dryRun ? '[dry-run] ' : ''}${a.type} -> ${a.dest}`);
    if (dryRun) continue;
    fs.mkdirSync(path.dirname(a.dest), { recursive: true });
    if (a.type === 'copy') fs.copyFileSync(a.src, a.dest);
    else if (a.type === 'marker') fs.writeFileSync(a.dest, JSON.stringify(a.marker, null, 2) + '\n');
    else if (a.type === 'block') {
      const cur = fs.existsSync(a.dest) ? fs.readFileSync(a.dest, 'utf8') : '';
      fs.writeFileSync(a.dest, applyBlock(cur, skillBlock()));
    }
  }
}

// Files under the owned runner dir that the current plan no longer ships. Read-only.
function staleFiles(plan) {
  const dir = plan.t.runnerDir;
  if (!fs.existsSync(dir)) return [];
  const expected = new Set(plan.actions.filter((x) => x.type === 'copy').map((x) => path.resolve(x.dest)));
  return listFiles(dir).filter((rel) => !expected.has(path.resolve(dir, ...rel.split('/')))).map((rel) => path.join(dir, ...rel.split('/')));
}

function check(plan, harness, home, log) {
  const markerPath = path.join(plan.t.markerDir, MARKER);
  const reinstall = `node tools/sf-install.mjs --harness ${harness}${home ? ` --home "${home}"` : ''}`;
  const diffs = [];
  let installed = null;
  if (!fs.existsSync(markerPath)) diffs.push('no hay marcador instalado (no instalado)');
  else {
    try { installed = JSON.parse(fs.readFileSync(markerPath, 'utf8')); }
    catch { diffs.push('marcador instalado ilegible'); }
  }
  if (installed) {
    if (installed.version !== plan.marker.version) diffs.push(`version: instalada ${installed.version} != repo ${plan.marker.version}`);
    for (const a of plan.actions.filter((x) => x.type === 'copy')) {
      const rel = a.dest.startsWith(plan.t.runnerDir) ? 'runner/' + path.relative(plan.t.runnerDir, a.dest).split(path.sep).join('/') : 'SKILL.md';
      if (!fs.existsSync(a.dest)) diffs.push(`falta: ${rel}`);
      else if (sha(a.dest) !== plan.marker.files[rel]) diffs.push(`distinto: ${rel}`);
    }
    if (plan.t.agentsFile) {
      const cur = fs.existsSync(plan.t.agentsFile) ? fs.readFileSync(plan.t.agentsFile, 'utf8') : '';
      if (!cur.includes(skillBlock().trimEnd())) diffs.push(`bloque obsoleto o ausente en ${plan.t.agentsFile}`);
    }
  }
  const stale = staleFiles(plan);
  if (!diffs.length && !stale.length) { log(`OK: ${harness} al dia (version ${plan.marker.version})`); return 0; }
  if (diffs.length) {
    log(`DRIFT en ${harness}:`);
    diffs.forEach((d) => log(`  - ${d}`));
  }
  stale.forEach((s) => log(`STALE: ${s}`));
  log(`Reinstala con: ${reinstall}`);
  return 1;
}

function main() {
  const log = (m) => console.log(m);
  let o;
  try { o = parseArgs(process.argv.slice(2)); } catch (e) { console.error(e.message); return 2; }
  try {
    const plugin = validateSource();
    const home = path.resolve(o.home || os.homedir());
    const plan = buildPlan(o.harness, home, plugin.version);
    if (o.check) return check(plan, o.harness, o.home ? home : null, log);
    install(plan, o.dryRun, log);
    log(o.dryRun ? 'Dry-run: nada escrito.' : `Instalado ${o.harness} v${plugin.version}. Archivos ajenos se conservan.`);
    return 0;
  } catch (e) { console.error(e.message); return 2; }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) process.exit(main());
