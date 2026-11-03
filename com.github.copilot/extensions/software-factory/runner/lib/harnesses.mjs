// Canonical harness registry: the ONLY list of harness ids/launch metadata.
// bin/base/model: command construction; stdin: prompt piped via stdin (else last arg);
// headless:false => no CLI to launch.
export const HARNESSES = {
  copilot: { id: 'copilot', bin: 'copilot', base: ['-p'], model: ['--model'], stdin: true, headless: true, hint: 'npm i -g @github/copilot' },
  claude: { id: 'claude', bin: 'claude', base: ['-p', '--permission-mode', 'acceptEdits'], model: ['--model'], stdin: true, headless: true, hint: 'npm i -g @anthropic-ai/claude-code' },
  codex: { id: 'codex', bin: 'codex', base: ['exec', '--full-auto'], model: ['--model'], stdin: true, headless: true, hint: 'npm i -g @openai/codex' },
  // opencode >= 1.2.24 vuelve a leer el prompt de stdin (1.2.19-1.2.23 tenian una regresion).
  // stdin en vez de argv: el shim .cmd de Windows rechaza prompts con espacios/comillas.
  opencode: { id: 'opencode', bin: 'opencode', base: ['run'], model: ['-m'], stdin: true, headless: true, hint: 'npm i -g opencode-ai (prompt via stdin; requires >= 1.2.24)' },
  gemini: { id: 'gemini', bin: 'gemini', base: ['-p'], model: ['--model'], stdin: true, headless: true, hint: 'npm i -g @google/gemini-cli' },
  vscode: { id: 'vscode', headless: false, hint: 'VS Code has no headless agent CLI; use another harness.' },
};

export const HARNESS_IDS = Object.keys(HARNESSES);

export const MODEL_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:/-]{0,63}$/;

// Throws a clear error for an unknown/non-headless harness or a malformed model; '' / undefined mean "not set".
export function validateHarnessConfig({ harness, model } = {}, source = 'config') {
  if (harness && harness !== 'auto') {
    if (!Object.prototype.hasOwnProperty.call(HARNESSES, harness)) {
      throw new Error(`Unknown harness '${harness}' (${source}). Valid: ${HARNESS_IDS.join(', ')}`);
    }
    if (!HARNESSES[harness].headless) {
      throw new Error(`Harness '${harness}' (${source}) is not headless and cannot run the factory; use one of: ${HARNESS_IDS.filter((i) => HARNESSES[i].headless).join(', ')}`);
    }
  }
  if (model !== undefined && model !== '' && (typeof model !== 'string' || !MODEL_PATTERN.test(model))) {
    throw new Error(`Invalid model '${model}' (${source}): must match ${MODEL_PATTERN}`);
  }
}

// Precedence: explicit CLI id > config id; 'auto' (CLI or config) means "not set".
export function pickHarness(cli, cfg) {
  const real = (h) => (h && h !== 'auto' ? h : undefined);
  return real(cli) || real(cfg);
}