import { HARNESSES, pickHarness, validateHarnessConfig } from '../harnesses.mjs';
import { createAdapter, DEFAULT_TIMEOUT_MS } from './core.mjs';

export { DEFAULT_TIMEOUT_MS };

// vscode has no headless CLI equivalent: documented stub, never available.
const vscode = {
  id: 'vscode',
  hint: 'VS Code has no headless agent CLI; use another harness.',
  available() { return false; },
  buildCommand() { return null; },
  run() {
    return Promise.resolve({ ok: false, output: '', exitCode: null, error: 'vscode harness is not supported headless' });
  },
};

const adapters = new Map(Object.entries(HARNESSES).filter(([, spec]) => spec.headless).map(([id, spec]) => [id, createAdapter(id, spec)]));
adapters.set('vscode', vscode);

export function list() { return [...adapters.keys()]; }
export function get(id) { return adapters.get(id) || null; }
export const getAdapter = get;

// idOrAuto: explicit id, 'auto' (state.harness, else first available), or falsy (same as auto).
export function resolve(idOrAuto, state = {}) {
  const id = pickHarness(idOrAuto, state && state.harness);
  validateHarnessConfig({ harness: id, model: state && state.model }, 'state.json');
  if (!id) {
    const found = list().map(get).find((a) => a.available());
    if (!found) throw new Error(`No harness CLI available. Known: ${list().join(', ')}`);
    return found;
  }
  const a = get(id);
  if (!a) throw new Error(`Unknown harness '${id}'. Available: ${list().join(', ')}`);
  return a;
}
