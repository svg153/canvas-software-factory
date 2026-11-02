// Canonical harness registry: the ONLY list of harness ids/launch metadata.
// bin/base/model: command construction; stdin: prompt piped via stdin (else last arg);
// winShell: spawn through the shell on win32 (npm .cmd shims); headless:false => no CLI to launch.
export const HARNESSES = {
  copilot: { id: 'copilot', bin: 'copilot', base: ['-p'], model: ['--model'], stdin: true, winShell: true, headless: true, hint: 'npm i -g @github/copilot' },
  claude: { id: 'claude', bin: 'claude', base: ['-p', '--permission-mode', 'acceptEdits'], model: ['--model'], stdin: true, winShell: true, headless: true, hint: 'npm i -g @anthropic-ai/claude-code' },
  codex: { id: 'codex', bin: 'codex', base: ['exec', '--full-auto'], model: ['--model'], stdin: true, winShell: true, headless: true, hint: 'npm i -g @openai/codex' },
  opencode: { id: 'opencode', bin: 'opencode', base: ['run'], model: ['-m'], stdin: false, winShell: true, headless: true, hint: 'npm i -g opencode-ai' },
  gemini: { id: 'gemini', bin: 'gemini', base: ['-p'], model: ['--model'], stdin: true, winShell: true, headless: true, hint: 'npm i -g @google/gemini-cli' },
  vscode: { id: 'vscode', headless: false, winShell: false, hint: 'VS Code has no headless agent CLI; use another harness.' },
};

export const HARNESS_IDS = Object.keys(HARNESSES);

// Throws a clear error for an unknown harness id or a malformed model; '' / undefined mean "not set".
export function validateHarnessConfig({ harness, model } = {}, source = 'config') {
  if (harness && harness !== 'auto' && !HARNESSES[harness]) {
    throw new Error(`Unknown harness '${harness}' (${source}). Valid: ${HARNESS_IDS.join(', ')}`);
  }
  if (model !== undefined && model !== '' && (typeof model !== 'string' || /\s/.test(model) || model.startsWith('-'))) {
    throw new Error(`Invalid model '${model}' (${source}): must be a single token not starting with '-'`);
  }
}
