import test from 'node:test';
import assert from 'node:assert/strict';
import { validateHarnessConfig, pickHarness, HARNESSES } from '../lib/harnesses.mjs';
import { resolve } from '../lib/adapters/index.mjs';
import { createAdapter } from '../lib/adapters/core.mjs';

test('no harness spec uses a shell', () => {
  for (const spec of Object.values(HARNESSES)) assert.equal('winShell' in spec, false);
});

test('malicious model from state.json is rejected before any launch', async () => {
  for (const model of ['x&calc', 'a|b', 'a"b', '%PATH%', 'x;y', '--help', '-x', '--dangerously-skip']) {
    assert.throws(() => validateHarnessConfig({ model }, 'state.json'), /Invalid model/);
    assert.throws(() => resolve('copilot', { model }), /Invalid model/);
    const r = await createAdapter('copilot', HARNESSES.copilot).run({ prompt: 'p', model, command: { cmd: process.execPath, args: ['-e', 'process.exit(9)'] } });
    assert.equal(r.ok, false);
    assert.match(r.error, /invalid model/);
  }
});

test('--harness auto does not override cfg.harness', () => {
  assert.equal(pickHarness('auto', 'codex'), 'codex');
  assert.equal(pickHarness('claude', 'codex'), 'claude');
  assert.equal(pickHarness(undefined, 'auto'), undefined);
  assert.equal(resolve('auto', { harness: 'codex' }).id, 'codex');
});

test('non-headless harness fails fast', () => {
  assert.throws(() => validateHarnessConfig({ harness: 'vscode' }, 'state.json'), /not headless/);
  assert.throws(() => resolve('auto', { harness: 'vscode' }), /not headless/);
});
