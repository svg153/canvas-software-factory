// Fake adapter for sf-run tests. FAKE_RUN_MODE=ok|fail|noreport. Writes a report to resultFile.
import { writeFileSync, appendFileSync } from "node:fs";

export default {
  id: "fake",
  available: () => true,
  async run({ taskId, resultFile, cwd }) {
    const mode = process.env.FAKE_RUN_MODE || "ok";
    if (process.env.FAKE_RUN_LOG) appendFileSync(process.env.FAKE_RUN_LOG, `${taskId}@${cwd}\n`);
    if (mode === "fail") return { ok: false, output: "", exitCode: 3, error: "boom" };
    if (mode === "ok") writeFileSync(resultFile, `# result ${taskId}\nok\n`);
    return { ok: true, output: "", exitCode: 0 };
  },
};
