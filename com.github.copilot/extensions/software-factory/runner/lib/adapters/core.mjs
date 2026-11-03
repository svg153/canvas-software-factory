import { spawn, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { HARNESSES, MODEL_PATTERN } from '../harnesses.mjs';

export const DEFAULT_TIMEOUT_MS = 30 * 60 * 1000;
const STDERR_TAIL = 2000;

export { HARNESSES };

// Kills pid and all its descendants. execFn/killFn injectable for tests.
export function killTree(pid, platform = process.platform, execFn = spawnSync, killFn = process.kill.bind(process)) {
  if (!pid) return;
  try {
    if (platform === 'win32') execFn('taskkill', ['/T', '/F', '/PID', String(pid)], { windowsHide: true });
    else killFn(-pid, 'SIGKILL');
  } catch { /* already gone */ }
}

const liveChildren = new Set();
export function killAllChildren() { for (const pid of liveChildren) killTree(pid); liveChildren.clear(); }

export { MODEL_PATTERN };
// Charsets con propositos distintos, NO unificados a proposito:
// - CMD_SAFE_ARG valida argv arbitrario que atraviesa cmd.exe (shim .cmd de npm):
//   permite = @ + , - (comunes en rutas y flags) pero jamas espacio, comillas ni
//   metacaracteres; los flags legitimos empiezan por '-', asi que el guion inicial vale.
// - MODEL_PATTERN (harnesses.mjs) valida SOLO ids de modelo y es mas estricto: arranca
//   alfanumerico para que un model de state.json no pueda interpretarse como flag.
// La tabla compartida de casos vive en test/harness-hardening.test.mjs.
const CMD_SAFE_ARG = /^[A-Za-z0-9._:/\\\\=@+,-]+$/;
export { CMD_SAFE_ARG };

export function validateModel(model) {
  if (typeof model !== 'string' || !MODEL_PATTERN.test(model)) {
    throw new Error('invalid model: must match ' + MODEL_PATTERN);
  }
  return model;
}

export function validateHarnessId(id) {
  if (!Object.prototype.hasOwnProperty.call(HARNESSES, id)) throw new Error('unknown harness: ' + String(id));
  return id;
}

// Lets --adapter-module modules register their own harness id before createAdapter().
// Format-validated; selection via state.json still goes through resolve()'s known-id check.
const HARNESS_ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,31}$/;
export function registerHarness(id, spec) {
  if (typeof id !== 'string' || !HARNESS_ID.test(id)) throw new Error('invalid harness id: ' + String(id));
  if (!spec || typeof spec !== 'object' || typeof spec.bin !== 'string' || !Array.isArray(spec.base) || !Array.isArray(spec.model)) {
    throw new Error('invalid harness spec for ' + id + ': bin/base/model required');
  }
  HARNESSES[id] = { ...spec };
  return id;
}

// Never uses a shell. npm .cmd/.bat shims on Windows need cmd.exe, so every argv is strictly allow-listed first.
export function resolveLaunch(cmd, args, env) {
  if (process.platform !== 'win32' || path.isAbsolute(cmd) === false && !/^[\w.-]+$/.test(cmd)) return { cmd, args };
  const resolved = path.isAbsolute(cmd) ? cmd : findOnPath(cmd, env);
  if (!resolved || !/\.(cmd|bat)$/i.test(resolved)) return { cmd: resolved || cmd, args };
  const bad = [resolved, ...args].find((a) => !CMD_SAFE_ARG.test(a));
  if (bad !== undefined) throw new Error('argument contains characters unsafe for a Windows .cmd shim; refusing to launch');
  return { cmd: process.env.ComSpec || 'cmd.exe', args: ['/d', '/s', '/c', [resolved, ...args].map((a) => '"' + a + '"').join(' ')], verbatim: true };
}

export function findOnPath(bin, env = process.env) {
  const dirs = (env.PATH || env.Path || '').split(path.delimiter).filter(Boolean);
  const exts = process.platform === 'win32' ? (env.PATHEXT || '.EXE;.CMD;.BAT').split(';') : [''];
  for (const d of dirs) for (const e of exts) {
    const p = path.join(d, bin + e);
    try { if (fs.statSync(p).isFile()) return p; } catch { /* next */ }
  }
  return null;
}

export function createAdapter(id, spec) {
  validateHarnessId(id);
  return {
    id,
    hint: spec.hint,
    available(env) { return findOnPath(spec.bin, env) !== null; },
    buildCommand({ prompt, model } = {}) {
      const args = [...spec.base];
      if (model) args.push(...spec.model, validateModel(model));
      if (spec.stdin) return { cmd: spec.bin, args, stdin: String(prompt ?? '') };
      args.push(String(prompt ?? ''));
      return { cmd: spec.bin, args };
    },
    // `command` ({cmd,args}) lets tests substitute the binary; extra args are appended after its args.
    run({ prompt, model, cwd, timeoutMs = DEFAULT_TIMEOUT_MS, command, env, treeKill } = {}) {
      let built;
      try { built = this.buildCommand({ prompt, model }); } catch (e) { return Promise.resolve({ ok: false, output: '', exitCode: null, error: e.message }); }
      const cmd = command ? command.cmd : built.cmd;
      const args = command ? [...(command.args || []), ...built.args] : built.args;
      if (!command && !this.available(env)) {
        return Promise.resolve({ ok: false, output: '', exitCode: null, error: `${id} CLI ('${spec.bin}') not found on PATH. Install: ${spec.hint}` });
      }
      let launch = { cmd, args };
      if (!command) { try { launch = resolveLaunch(cmd, args, env); } catch (e) { return Promise.resolve({ ok: false, output: '', exitCode: null, error: e.message }); } }
      return spawnCollect(launch.cmd, launch.args, built.stdin, { cwd, timeoutMs, env, verbatim: launch.verbatim, treeKill });
    },
  };
}

function spawnCollect(cmd, args, stdin, { cwd, timeoutMs, env, verbatim, treeKill = killTree }) {
  return new Promise((resolve) => {
    let out = '', err = '', timedOut = false, settled = false;
    let child;
    const done = (r) => { if (settled) return; settled = true; clearTimeout(timer); clearTimeout(killTimer); if (child?.pid) liveChildren.delete(child.pid); resolve(r); };
    let timer, killTimer;
    try {
      child = spawn(cmd, args, { cwd, env: env || process.env, shell: false, windowsVerbatimArguments: !!verbatim, stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true, detached: process.platform !== 'win32' });
      if (child.pid) liveChildren.add(child.pid);
    } catch (e) { return resolve({ ok: false, output: '', exitCode: null, error: e.message }); }
    child.stdout.on('data', (d) => { out += d; });
    child.stderr.on('data', (d) => { err += d; });
    child.on('error', (e) => done({ ok: false, output: out, exitCode: null, error: e.message }));
    child.stdin.on('error', () => {});
    if (stdin !== undefined) child.stdin.end(stdin); else child.stdin.end();
    timer = setTimeout(() => {
      timedOut = true;
      treeKill(child.pid);
    }, timeoutMs);
    child.on('close', (code, signal) => {
      const tail = err.slice(-STDERR_TAIL);
      if (timedOut) return done({ ok: false, output: out, exitCode: code, error: `timed out after ${timeoutMs}ms` });
      if (code === 0) return done({ ok: true, output: out, exitCode: 0, error: null });
      done({ ok: false, output: out, exitCode: code, error: tail || `exited with ${code ?? signal}` });
    });
  });
}