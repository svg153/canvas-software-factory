import { spawn, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

export const DEFAULT_TIMEOUT_MS = 30 * 60 * 1000;
const STDERR_TAIL = 2000;

// Single matrix of harness flags. stdin:true => prompt piped via stdin; otherwise last arg.
export const HARNESSES = {
  copilot: { bin: 'copilot', base: ['-p'], model: ['--model'], stdin: true, hint: 'npm i -g @github/copilot' },
  claude: { bin: 'claude', base: ['-p', '--permission-mode', 'acceptEdits'], model: ['--model'], stdin: true, hint: 'npm i -g @anthropic-ai/claude-code' },
  codex: { bin: 'codex', base: ['exec', '--full-auto'], model: ['--model'], stdin: true, hint: 'npm i -g @openai/codex' },
  opencode: { bin: 'opencode', base: ['run'], model: ['-m'], stdin: false, hint: 'npm i -g opencode-ai' },
  gemini: { bin: 'gemini', base: ['-p'], model: ['--model'], stdin: true, hint: 'npm i -g @google/gemini-cli' },
};

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
  return {
    id,
    hint: spec.hint,
    available(env) { return findOnPath(spec.bin, env) !== null; },
    buildCommand({ prompt, model } = {}) {
      const args = [...spec.base];
      if (model) args.push(...spec.model, model);
      if (spec.stdin) return { cmd: spec.bin, args, stdin: String(prompt ?? '') };
      args.push(String(prompt ?? ''));
      return { cmd: spec.bin, args };
    },
    // `command` ({cmd,args}) lets tests substitute the binary; extra args are appended after its args.
    run({ prompt, model, cwd, timeoutMs = DEFAULT_TIMEOUT_MS, command, env, treeKill } = {}) {
      const built = this.buildCommand({ prompt, model });
      const cmd = command ? command.cmd : built.cmd;
      const args = command ? [...(command.args || []), ...built.args] : built.args;
      if (!command && !this.available(env)) {
        return Promise.resolve({ ok: false, output: '', exitCode: null, error: `${id} CLI ('${spec.bin}') not found on PATH. Install: ${spec.hint}` });
      }
      return spawnCollect(cmd, args, built.stdin, { cwd, timeoutMs, env, treeKill, shell: !command && process.platform === 'win32' });
    },
  };
}

function spawnCollect(cmd, args, stdin, { cwd, timeoutMs, env, shell, treeKill = killTree }) {
  return new Promise((resolve) => {
    let out = '', err = '', timedOut = false, settled = false;
    let child;
    const done = (r) => { if (settled) return; settled = true; clearTimeout(timer); clearTimeout(killTimer); if (child?.pid) liveChildren.delete(child.pid); resolve(r); };
    let timer, killTimer;
    try {
      child = spawn(cmd, args, { cwd, env: env || process.env, shell, stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true, detached: process.platform !== 'win32' });
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
