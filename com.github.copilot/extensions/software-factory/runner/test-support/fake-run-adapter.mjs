// Fake adapter for sf-run tests. FAKE_RUN_MODE=ok|fail|noreport. Writes a report to resultFile.
// FAKE_FAIL_ONCE=<marker file>: the first run fails (exit 1) and creates the marker; later runs succeed.
import { writeFileSync, appendFileSync, existsSync } from "node:fs";

export default {
  id: "fake",
  available: () => true,
  async run({ taskId, resultFile, cwd }) {
    const mode = process.env.FAKE_RUN_MODE || "ok";
    if (process.env.FAKE_RUN_LOG) appendFileSync(process.env.FAKE_RUN_LOG, `${taskId}@${cwd}\n`);
    const once = process.env.FAKE_FAIL_ONCE;
    if (once && !existsSync(once)) {
      writeFileSync(once, taskId);
      return { ok: false, output: "", exitCode: 1, error: "fail once" };
    }
    if (mode === "fail") return { ok: false, output: "", exitCode: 3, error: "boom" };
    if (mode === "ok") writeFileSync(resultFile, `# result ${taskId}\nok\n`);
    return { ok: true, output: "", exitCode: 0 };
  },
};
