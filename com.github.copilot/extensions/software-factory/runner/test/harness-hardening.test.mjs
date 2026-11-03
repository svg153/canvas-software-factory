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

test('CMD_SAFE_ARG y MODEL_PATTERN: tabla compartida de casos', async () => {
  const { CMD_SAFE_ARG } = await import('../lib/adapters/core.mjs');
  const { MODEL_PATTERN } = await import('../lib/harnesses.mjs');
  // [valor, CMD_SAFE_ARG (argv via cmd.exe), MODEL_PATTERN (id de modelo)]
  const cases = [
    ['gpt-5.6', true, true],
    ['deepseek/v4.1-flash', true, true],
    ['C:/bin/tool.cmd', true, true], // sin metacaracteres de shell: seguro en argv y como id (MODEL_PATTERN permite '/' p.ej. deepseek/v4.1-flash)
    ['a=b', true, false], // '=' seguro en argv, no en un modelo
    ['a@b', true, false],
    ['a+b', true, false],
    ['a,b', true, false],
    ['-x', true, false], // flag legitimo en argv; un modelo nunca puede ser un flag
    ['a b', false, false], // espacio: romperia el shim .cmd
    ['a"b', false, false],
    ['a&b', false, false],
    ['a|b', false, false],
    ['%PATH%', false, false],
    ['a\nb', false, false],
  ];
  for (const [value, cmdOk, modelOk] of cases) {
    assert.equal(CMD_SAFE_ARG.test(value), cmdOk, `CMD_SAFE_ARG('${value}')`);
    assert.equal(MODEL_PATTERN.test(value), modelOk, `MODEL_PATTERN('${value}')`);
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
