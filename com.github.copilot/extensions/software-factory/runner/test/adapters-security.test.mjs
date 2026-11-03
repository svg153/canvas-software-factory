import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { get } from '../lib/adapters/index.mjs';
import { createAdapter, HARNESSES, validateModel, validateHarnessId } from '../lib/adapters/core.mjs';

const adaptersDir = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'lib', 'adapters');

const PAYLOADS = ['x && calc.exe', '`calc`', 'a | b', '" & echo PWNED & "', '$(calc) > out.txt'];

test('malicious prompt reaches argv literally (shell:false), never interpreted', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sf57-'));
  const script = path.join(dir, 'argv.mjs');
  fs.writeFileSync(script, 'process.stdout.write(JSON.stringify(process.argv.slice(2)));');
  try {
    for (const p of PAYLOADS) {
      const r = await get('opencode').run({ prompt: p, model: 'gpt-5.6', cwd: dir, command: { cmd: process.execPath, args: [script] } });
      assert.equal(r.ok, true, r.error);
      assert.deepEqual(JSON.parse(r.output), ['run', '-m', 'gpt-5.6', p]);
    }
    assert.equal(fs.existsSync(path.join(dir, 'out.txt')), false);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('model validation accepts safe ids and rejects injection', () => {
  for (const m of ['gpt-5.6', 'anthropic/claude-3:x', 'a_b'.replace('_', '-')]) assert.equal(validateModel(m), m);
  for (const m of ['a;rm -rf', 'x && calc.exe', '`x`', 'a|b', '', 'a'.repeat(65), 'a b', 5]) assert.throws(() => validateModel(m), /invalid model/);
});

test('run() with invalid model fails without spawning', async () => {
  const r = await get('copilot').run({ prompt: 'hi', model: 'x && calc.exe', command: { cmd: 'definitely-not-run', args: [] } });
  assert.equal(r.ok, false);
  assert.match(r.error, /invalid model/);
});

test('harness ids must be known', () => {
  assert.equal(validateHarnessId('claude'), 'claude');
  assert.throws(() => validateHarnessId('x && calc'), /unknown harness/);
  assert.throws(() => createAdapter('evil', HARNESSES.claude), /unknown harness/);
});

test('no shell:true / dynamic shell option in adapters sources', () => {
  for (const f of fs.readdirSync(adaptersDir).filter((n) => n.endsWith('.mjs'))) {
    const src = fs.readFileSync(path.join(adaptersDir, f), 'utf8');
    assert.doesNotMatch(src, /shell\s*:\s*true/, f);
    assert.doesNotMatch(src, /shell\s*:\s*!/, f);
    for (const m of src.matchAll(/shell\s*:\s*([^,}\s]+)/g)) assert.equal(m[1], 'false', `${f}: shell: ${m[1]}`);
  }
});
