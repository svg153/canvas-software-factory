import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import fs from 'node:fs';
import os from 'node:os';
import { fileURLToPath } from 'node:url';
import { list, get, resolve } from '../lib/adapters/index.mjs';
import { killTree } from '../lib/adapters/core.mjs';

const fake = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'test-support', 'fake-harness.mjs');
const command = { cmd: process.execPath, args: [fake] };

test('list/get/resolve', () => {
  assert.deepEqual(list(), ['copilot', 'claude', 'codex', 'opencode', 'gemini', 'vscode']);
  assert.equal(get('nope'), null);
  assert.equal(resolve('claude').id, 'claude');
  assert.equal(resolve('auto', { harness: 'codex' }).id, 'codex');
  assert.throws(() => resolve('zzz'), /Unknown harness 'zzz'.*copilot, claude/);
});

const expected = {
  copilot: { args: ['-p', '--model', 'm1'], stdin: true },
  claude: { args: ['-p', '--permission-mode', 'acceptEdits', '--model', 'm1'], stdin: true },
  codex: { args: ['exec', '--full-auto', '--model', 'm1'], stdin: true },
  opencode: { args: ['run', '-m', 'm1', 'hello "x"'], stdin: false },
  gemini: { args: ['-p', '--model', 'm1'], stdin: true },
};

for (const [id, e] of Object.entries(expected)) {
  test(`${id}: buildCommand and run pipe prompt correctly`, async () => {
    const a = get(id);
    const b = a.buildCommand({ prompt: 'hello "x"', model: 'm1' });
    assert.equal(b.cmd, id);
    assert.deepEqual(b.args, e.args);
    const r = await a.run({ prompt: 'hello "x"', model: 'm1', command });
    assert.equal(r.ok, true);
    const got = JSON.parse(r.output);
    assert.deepEqual(got.argv, e.args);
    assert.equal(got.stdin, e.stdin ? 'hello "x"' : '');
  });
}

test('no model omits flag', () => {
  assert.deepEqual(get('copilot').buildCommand({ prompt: 'p' }).args, ['-p']);
});

test('failure normalizes exit code and stderr', async () => {
  const r = await get('gemini').run({ prompt: 'p', command, env: { ...process.env, FAKE_MODE: 'fail' } });
  assert.equal(r.ok, false);
  assert.equal(r.exitCode, 3);
  assert.equal(r.error, 'boom');
});

test('timeout kills process', async () => {
  const r = await get('gemini').run({ prompt: 'p', command, timeoutMs: 300, env: { ...process.env, FAKE_MODE: 'hang' } });
  assert.equal(r.ok, false);
  assert.match(r.error, /timed out/);
});

test('missing CLI gives actionable error; available() reads PATH', async () => {
  const empty = fs.mkdtempSync(path.join(os.tmpdir(), 'sf-adapters-'));
  const env = { PATH: empty, Path: empty };
  assert.equal(get('codex').available(env), false);
  const r = await get('codex').run({ prompt: 'p', env });
  assert.equal(r.ok, false);
  assert.match(r.error, /not found on PATH.*Install/);
  const ext = process.platform === 'win32' ? '.cmd' : '';
  fs.writeFileSync(path.join(empty, 'codex' + ext), '');
  assert.equal(get('codex').available(env), true);
  fs.rmSync(empty, { recursive: true });
});

test('vscode is a stub', async () => {
  const a = get('vscode');
  assert.equal(a.available(), false);
  const r = await a.run({ prompt: 'p' });
  assert.equal(r.ok, false);
  assert.match(r.error, /not supported headless/);
});

test('per-task timeout kills the whole tree via killTree', async () => {
  const killed = [];
  const r = await get('gemini').run({ prompt: 'p', command, timeoutMs: 200, env: { ...process.env, FAKE_MODE: 'hang' }, treeKill: (pid) => { killed.push(pid); killTree(pid); } });
  assert.equal(r.ok, false);
  assert.match(r.error, /timed out/);
  assert.equal(killed.length, 1);
  assert.ok(Number.isInteger(killed[0]) && killed[0] > 0);
});
