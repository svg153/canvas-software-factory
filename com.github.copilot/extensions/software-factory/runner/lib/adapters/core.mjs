import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

export const DEFAULT_TIMEOUT_MS = 30 * 60 * 1000;
const KILL_GRACE_MS = 3000;
const STDERR_TAIL = 2000;

// Single matrix of harness flags. stdin:true => prompt piped via stdin; otherwise last arg.
export const HARNESSES = {
  copilot: { bin: 'copilot', base: ['-p'], model: ['--model'], stdin: true, hint: 'npm i -g @github/copilot' },
  claude: { bin: 'claude', base: ['-p', '--permission-mode', 'acceptEdits'], model: ['--model'], stdin: true, hint: 'npm i -g @anthropic-ai/claude-code' },
  codex: { bin: 'codex', base: ['exec', '--full-auto'], model: ['--model'], stdin: true, hint: 'npm i -g @openai/codex' },
  opencode: { bin: 'opencode', base: ['run'], model: ['-m'], stdin: false, hint: 'npm i -g opencode-ai' },
  gemini: { bin: 'gemini', base: ['-p'], model: ['--model'], stdin: true, hint: 'npm i -g @google/gemini-cli' },
};

export const MODEL_PATTERN = /^[A-Za-z0-9._:/-]{1,64}$/;
const CMD_SAFE_ARG = /^[A-Za-z0-9._:/\\\\=@+,-]+$/;

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
    run({ prompt, model, cwd, timeoutMs = DEFAULT_TIMEOUT_MS, command, env } = {}) {
      let built;
      try { built = this.buildCommand({ prompt, model }); } catch (e) { return Promise.resolve({ ok: false, output: '', exitCode: null, error: e.message }); }
      const cmd = command ? command.cmd : built.cmd;
      const args = command ? [...(command.args || []), ...built.args] : built.args;
      if (!command && !this.available(env)) {
        return Promise.resolve({ ok: false, output: '', exitCode: null, error: `${id} CLI ('${spec.bin}') not found on PATH. Install: ${spec.hint}` });
      }
      let launch = { cmd, args };
      if (!command) { try { launch = resolveLaunch(cmd, args, env); } catch (e) { return Promise.resolve({ ok: false, output: '', exitCode: null, error: e.message }); } }
      return spawnCollect(launch.cmd, launch.args, built.stdin, { cwd, timeoutMs, env, verbatim: launch.verbatim });
    },
  };
}

function spawnCollect(cmd, args, stdin, { cwd, timeoutMs, env, verbatim }) {
  return new Promise((resolve) => {
    let out = '', err = '', timedOut = false, settled = false;
    let child;
    const done = (r) => { if (settled) return; settled = true; clearTimeout(timer); clearTimeout(killTimer); resolve(r); };
    let timer, killTimer;
    try {
      child = spawn(cmd, args, { cwd, env: env || process.env, shell: false, windowsVerbatimArguments: !!verbatim, stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true });
    } catch (e) { return resolve({ ok: false, output: '', exitCode: null, error: e.message }); }
    child.stdout.on('data', (d) => { out += d; });
    child.stderr.on('data', (d) => { err += d; });
    child.on('error', (e) => done({ ok: false, output: out, exitCode: null, error: e.message }));
    child.stdin.on('error', () => {});
    if (stdin !== undefined) child.stdin.end(stdin); else child.stdin.end();
    timer = setTimeout(() => {
      timedOut = true;
      child.kill('SIGTERM');
      killTimer = setTimeout(() => child.kill('SIGKILL'), KILL_GRACE_MS);
    }, timeoutMs);
    child.on('close', (code, signal) => {
      const tail = err.slice(-STDERR_TAIL);
      if (timedOut) return done({ ok: false, output: out, exitCode: code, error: `timed out after ${timeoutMs}ms` });
      if (code === 0) return done({ ok: true, output: out, exitCode: 0, error: null });
      done({ ok: false, output: out, exitCode: code, error: tail || `exited with ${code ?? signal}` });
    });
  });
}
