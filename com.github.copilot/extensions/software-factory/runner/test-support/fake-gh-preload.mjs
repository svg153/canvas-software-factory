// Preload EXCLUSIVO de pruebas (nunca importado por código de producción).
// Se activa solo cuando un test lanza el CLI con
// NODE_OPTIONS=--import=<este archivo>, y sustituye child_process.execFile en el
// proceso hijo para simular la CLI `gh` sin binario ni red:
//  - SF_TEST_FAKE_GH_LOG      archivo donde se registran las llamadas (JSON por línea)
//  - SF_TEST_FAKE_GH_COUNTER  archivo con el contador de números de issue (multi-proceso)
//  - SF_TEST_FAKE_GH_MODE     "fail" -> exit 1 con stderr de error; "garbage" -> stdout no-URL
// Cualquier otro comando distinto de "gh" se delega al execFile real.
// El código de producción (lib/gh.mjs) no lee ninguna de estas variables: si se
// retira la simulación, no queda nada que "contamine" el estado, porque nunca
// existió un modo simulado en producción.
import { createRequire, syncBuiltinESMExports } from "node:module";
import { promisify } from "node:util";
import { appendFileSync, existsSync, readFileSync, writeFileSync } from "node:fs";

const require = createRequire(import.meta.url);
const cp = require("node:child_process");
const originalExecFile = cp.execFile; // referencia estable, no afecta el parche
const originalPromisified = promisify(originalExecFile);

const LOG = process.env.SF_TEST_FAKE_GH_LOG;
const COUNTER = process.env.SF_TEST_FAKE_GH_COUNTER;
const MODE = process.env.SF_TEST_FAKE_GH_MODE;

function nextIssueNumber() {
  let n = COUNTER && existsSync(COUNTER) ? Number(readFileSync(COUNTER, "utf8")) : 0;
  n += 1;
  if (COUNTER) writeFileSync(COUNTER, String(n));
  return n;
}

// Devuelve { err, stdout, stderr } como lo haría execFile real.
function simulateGh(args) {
  if (LOG) appendFileSync(LOG, JSON.stringify(args) + "\n");
  if (args[0] === "issue" && args[1] === "create") {
    if (MODE === "fail") {
      const err = new Error(`Command failed: gh ${args.join(" ")}`);
      err.code = 1;
      err.stderr = "error: gh auth could not complete";
      return { err, stdout: "", stderr: err.stderr };
    }
    const stdout = MODE === "garbage"
      ? "not a url at all\n"
      : `https://github.com/org/repo/issues/${nextIssueNumber()}\n`;
    // Ruido legítimo en stderr con exit 0: como gh real (regresión del heurístico regex).
    return { err: null, stdout, stderr: "warning: could not check for updates (harmless notice)\n" };
  }
  return { err: null, stdout: "{}\n", stderr: "" };
}

function patchedExecFile(file, args, options, callback) {
  if (file !== "gh") return originalExecFile(file, args, options, callback);
  let cb = callback;
  if (typeof options === "function") { cb = options; }
  process.nextTick(() => {
    const { err, stdout, stderr } = simulateGh(args ?? []);
    if (err) { err.stdout = stdout; err.stderr = stderr; return cb(err); }
    cb(null, stdout, stderr);
  });
}

// util.promisify(execFile) resuelve a { stdout, stderr } vía su implementación
// custom; hay que replicarla para que el `run()` de lib/gh.mjs siga funcionando.
patchedExecFile[promisify.custom] = function (file, args, options) {
  if (file !== "gh") return originalPromisified(file, args, options);
  return new Promise((resolveP, rejectP) => {
    patchedExecFile(file, args, options ?? {}, (err, stdout, stderr) => {
      if (err) return rejectP(err);
      resolveP({ stdout, stderr });
    });
  });
};

cp.execFile = patchedExecFile;
syncBuiltinESMExports();
