import { mkdtemp, mkdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createFactoryServer } from "./runner/lib/http.mjs";
import { createRepoAllowlist } from "./runner/lib/allowlist.mjs";

const extensionDir = new URL(".", import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, "$1");
const base = await mkdtemp(join(tmpdir(), "sf-dbg-"));
const workspace = join(base, "workspace");
await mkdir(workspace, { recursive: true });
const allowlist = createRepoAllowlist({ defaultRepo: () => workspace, env: {} });
const server = createFactoryServer({
  extensionDir,
  defaultRepo: () => workspace,
  resolveRepo: (requested) => allowlist.resolve(requested),
  readState: async (repo) => ({ repo }),
  ensureWatch: () => {},
  applyAction: async (repo) => ({ repo }),
  subscribe: () => {},
});
await new Promise((r) => server.listen(0, "127.0.0.1", r));
const baseUrl = `http://127.0.0.1:${server.address().port}`;
const token = (await (await fetch(`${baseUrl}/token`)).json()).token;
console.log("token:", token ? "ok" : "MISSING");
for (const url of ["/state", "/state?repo=", `/state?repo=${encodeURIComponent(workspace)}`]) {
  const res = await fetch(`${baseUrl}${url}`, { headers: { "x-sf-token": token } });
  console.log(url, "->", res.status, await res.text());
}
await new Promise((r) => server.close(r));
await rm(base, { recursive: true, force: true });
