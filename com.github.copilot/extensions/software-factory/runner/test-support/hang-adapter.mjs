// Adapter that really spawns a long-running child through core.mjs (exercises tree kill).
import { writeFileSync } from "node:fs";
import { createAdapter } from "../lib/adapters/core.mjs";

const real = createAdapter("hang", { bin: "node", base: [], model: [], stdin: false, hint: "n/a" });
export default {
  id: "hang",
  available: () => true,
  async run(o) {
    const child = { cmd: process.execPath, args: ["-e", `require("fs").writeFileSync(${JSON.stringify(process.env.HANG_PID_FILE)}, String(process.pid)); setTimeout(()=>{},60000)`] };
    return real.run({ ...o, command: child });
  },
};
