import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { createServer } from "node:http";
import { randomBytes, timingSafeEqual } from "node:crypto";

// Token aleatorio por instancia: el HTML lo expone y la UI lo devuelve en la cabecera.
// Un sitio externo puede enviar POST "simples" a localhost, pero no conoce el token
// ni puede leer la respuesta, así que sin cabecera correcta la acción se rechaza.
export const ACTION_TOKEN_PLACEHOLDER = "__SF_ACTION_TOKEN__";
export const ACTION_TOKEN_HEADER = "x-sf-action-token";

export const MAX_BODY_BYTES = 64 * 1024;

class HttpError extends Error {
  constructor(status, code) {
    super(code);
    this.status = status;
    this.code = code;
  }
}

async function readJsonBody(req) {
  let size = 0;
  const chunks = [];
  for await (const chunk of req) {
    size += chunk.length;
    if (size > MAX_BODY_BYTES) throw new HttpError(413, "sf_body_demasiado_grande");
    chunks.push(chunk);
  }
  const data = Buffer.concat(chunks).toString("utf8");
  try {
    return data ? JSON.parse(data) : {};
  } catch {
    throw new HttpError(400, "sf_json_invalido");
  }
}

const SECURITY_HEADERS = {
  "X-Content-Type-Options": "nosniff",
  "Content-Security-Policy":
    "default-src 'self'; script-src 'self' 'unsafe-inline'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; connect-src 'self'; frame-ancestors *",
};

const LOOPBACK_HOSTS = new Set(["127.0.0.1", "localhost"]);

function isLoopbackOrigin(origin) {
  try {
    const url = new URL(origin);
    return url.protocol === "http:" && LOOPBACK_HOSTS.has(url.hostname);
  } catch {
    return false;
  }
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
  const server = createServer(async (req, res) => {
    const writeHead = res.writeHead.bind(res);
    res.writeHead = (status, ...rest) => {
      for (const [name, value] of Object.entries(SECURITY_HEADERS)) res.setHeader(name, value);
      return writeHead(status, ...rest);
    };
    try {
      const { port } = server.address();
      if (![`127.0.0.1:${port}`, `localhost:${port}`].includes(String(req.headers.host || "").toLowerCase())) {
        res.writeHead(403, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: "sf_host_no_permitido" }));
        return;
      }
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
        const origin = req.headers.origin;
        const fetchSite = req.headers["sec-fetch-site"];
        if ((origin !== undefined && !isLoopbackOrigin(origin)) || fetchSite === "cross-site") {
          res.writeHead(403, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ error: "sf_origen_no_permitido" }));
          return;
        }
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
      if (!(error instanceof HttpError)) console.error("[software-factory] request failed:", error);
      const status = error instanceof HttpError ? error.status : 400;
      const code = error instanceof HttpError ? error.code : "sf_solicitud_fallida";
      if (res.headersSent) {
        res.end();
        return;
      }
      res.writeHead(status, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: code }));
    }
  });
  return server;
}
