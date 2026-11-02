import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { createServer } from "node:http";
import { randomBytes, timingSafeEqual } from "node:crypto";

// Token aleatorio por instancia: el HTML lo expone y la UI lo devuelve en la cabecera.
// Un sitio externo puede enviar POST "simples" a localhost, pero no conoce el token
// ni puede leer la respuesta, así que sin cabecera correcta la acción se rechaza.
export const ACTION_TOKEN_PLACEHOLDER = "__SF_ACTION_TOKEN__";
export const ACTION_TOKEN_HEADER = "x-sf-action-token";

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
  const actionToken = randomBytes(24).toString("hex");
  const tokenOk = (header) => {
    if (typeof header !== "string" || header.length !== actionToken.length) return false;
    return timingSafeEqual(Buffer.from(header, "utf8"), Buffer.from(actionToken, "utf8"));
  };
  return createServer(async (req, res) => {
    try {
      const requestUrl = new URL(req.url, "http://127.0.0.1");
      const repoDir = requestUrl.searchParams.get("repo") || defaultRepo();
      const path = requestUrl.pathname;

      if (req.method === "GET" && path === "/") {
        const html = await readFile(join(extensionDir, "index.html"), "utf8");
        res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
        res.end(html.replace(ACTION_TOKEN_PLACEHOLDER, actionToken));
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
        if (!tokenOk(req.headers[ACTION_TOKEN_HEADER])) {
          res.writeHead(403, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ error: "sf_csrf_token_invalido" }));
          return;
        }
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
