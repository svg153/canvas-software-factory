import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { createServer } from "node:http";

async function readJsonBody(req) {
  let data = "";
  for await (const chunk of req) data += chunk;
  return data ? JSON.parse(data) : {};
}

export function createFactoryServer({
  extensionDir,
  defaultRepo,
  readState,
  ensureWatch,
  applyAction,
  subscribe,
}) {
  return createServer(async (req, res) => {
    try {
      const requestUrl = new URL(req.url, "http://127.0.0.1");
      const repoDir = requestUrl.searchParams.get("repo") || defaultRepo();
      const path = requestUrl.pathname;

      if (req.method === "GET" && path === "/") {
        res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
        res.end(await readFile(join(extensionDir, "index.html")));
        return;
      }
      if (req.method === "GET" && (path === "/ui.mjs" || path === "/app.mjs")) {
        res.writeHead(200, { "Content-Type": "text/javascript; charset=utf-8" });
        res.end(await readFile(join(extensionDir, path.slice(1))));
        return;
      }
      if (req.method === "GET" && path === "/state") {
        ensureWatch(repoDir);
        const state = await readState(repoDir);
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify(state || { status: "missing", repo: repoDir }));
        return;
      }
      if (req.method === "GET" && path === "/events") {
        ensureWatch(repoDir);
        res.writeHead(200, {
          "Content-Type": "text/event-stream",
          "Cache-Control": "no-cache",
          Connection: "keep-alive",
        });
        const state = await readState(repoDir);
        res.write(`data: ${JSON.stringify(state || { status: "missing" })}\n\n`);
        subscribe(repoDir, res, req);
        return;
      }
      if (req.method === "POST" && path === "/action") {
        const body = await readJsonBody(req);
        const result = await applyAction(repoDir, body.actionName, body.input || {});
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify(result));
        return;
      }
      res.writeHead(404);
      res.end();
    } catch (error) {
      res.writeHead(400, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: error instanceof Error ? error.message : "Unknown error" }));
    }
  });
}
