import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { createServer } from "node:http";
import { randomBytes, timingSafeEqual } from "node:crypto";

// Token aleatorio por instancia. GET / ya no lo incrusta: la UI lo pide a /token (mismo origen,
// tras validar Host/Origin) y lo envía en `x-sf-token` en /state, /events y POST.
export const ACTION_TOKEN_HEADER = "x-sf-token";
const LOOPBACK_HOSTS = ["127.0.0.1", "localhost", "[::1]"];

export function hostnameOf(hostHeader) {
  if (typeof hostHeader !== "string" || !hostHeader) return null;
  const m = hostHeader.toLowerCase().match(/^(\[[0-9a-f:]+\]|[a-z0-9.-]+)(?::(\d{1,5}))?$/);
  return m ? m[1] : null;
}

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

export function createFactoryServer({
  extensionDir,
  defaultRepo,
  resolveRepo = (requested) => {
    if (requested) throw new HttpError(400, "sf_repo_no_permitido");
    return defaultRepo();
  },
  readState,
  ensureWatch,
  applyAction,
  subscribe,
  allowHosts = [],
}) {
  const allowed = new Set([...LOOPBACK_HOSTS, ...allowHosts.map((h) => h.toLowerCase())]);
  // Host sin puerto (proxy/port-forward que reescribe cabeceras): el control real es la
  // allowlist de hostname, asi que el puerto solo se exige cuando el cliente lo envia.
  const hostAllowed = (hostHeader, port) => {
    const m = typeof hostHeader === "string" ? hostHeader.match(/:(\d{1,5})$/) : null;
    return allowed.has(hostnameOf(hostHeader)) && (m === null || Number(m[1]) === port);
  };
  const originAllowed = (origin, port) => {
    try {
      const u = new URL(origin);
      // Mismo criterio que hostAllowed: Origin sin puerto (default :80 tras proxy) vale por hostname.
      return u.protocol === "http:" && allowed.has(u.hostname.toLowerCase()) && (u.port === "" || Number(u.port) === port);
    } catch {
      return false;
    }
  };
  const deny = (res, status, error) => {
    res.writeHead(status, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ error }));
  };
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
      const serverPort = req.socket.localPort;
      if (!hostAllowed(req.headers.host, serverPort)) return deny(res, 403, "sf_host_no_permitido");
      if (req.headers.origin && !originAllowed(req.headers.origin, serverPort)) return deny(res, 403, "sf_origen_no_permitido");
      const requestUrl = new URL(req.url, "http://127.0.0.1");
      const path = requestUrl.pathname;
      let repoDir;
      if (path === "/state" || path === "/events" || path === "/action") {
        try {
          repoDir = resolveRepo(requestUrl.searchParams.get("repo") || "");
        } catch {
          throw new HttpError(400, "sf_repo_no_permitido");
        }
      }

      if (req.method === "GET" && path === "/") {
        const html = await readFile(join(extensionDir, "index.html"), "utf8");
        res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
        res.end(html);
        return;
      }
      if (req.method === "GET" && path === "/token") {
        const fetchSite = req.headers["sec-fetch-site"];
        const ua = String(req.headers["user-agent"] || "");
        const looksLikeBrowser = /Mozilla\/5\.0/.test(ua) && /(Chrome|Safari|Firefox)\//.test(ua);
        // Defensa en profundidad: un navegador real envia Sec-Fetch-Site; si falta y parece
        // navegador, solo se acepta con Origin valido (validado arriba). Contrato: clientes
        // sin Sec-Fetch-Site (webviews antiguos, proxies que recortan cabeceras) deben enviar
        // Origin valido o no parecer navegador; la UA es falsificable, esto no es la frontera.
        if (fetchSite === "cross-site") return deny(res, 403, "sf_origen_no_permitido");
        if (!fetchSite && looksLikeBrowser && !req.headers.origin) return deny(res, 403, "sf_origen_no_permitido");
        res.writeHead(200, { "Content-Type": "application/json", "Cache-Control": "no-store" });
        res.end(JSON.stringify({ token: actionToken }));
        return;
      }
      const needsToken = path === "/state" || path === "/events" || path === "/action";
      if (needsToken) {
        // /events lo consume EventSource, que no puede enviar cabeceras: acepta ?token=.
        // Riesgo aceptado: solo localhost, Host/Origin validados y el token puede quedar en historial/logs locales.
        const supplied = req.headers[ACTION_TOKEN_HEADER] ?? (path === "/events" ? requestUrl.searchParams.get("token") : undefined);
        if (!tokenOk(supplied)) return deny(res, path === "/action" ? 403 : 401, "sf_csrf_token_invalido");
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
        // Defensa en profundidad (main): un POST cross-site nunca debe actuar, aunque lleve token.
        if (req.headers["sec-fetch-site"] === "cross-site") return deny(res, 403, "sf_origen_no_permitido");
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
      // #88: errores intencionales con .code propio (CanvasError) difunden código y mensaje;
      // los errores crudos (p. ej. ENOENT con rutas internas) siguen reducidos al código genérico
      // para no filtrar paths (bloqueado por el test de seguridad de /action).
      const ownCode = !(error instanceof HttpError) && typeof error?.code === "string";
      const code = error instanceof HttpError || ownCode ? error.code : "sf_solicitud_fallida";
      if (res.headersSent) {
        res.end();
        return;
      }
      res.writeHead(status, { "Content-Type": "application/json" });
      const message = ownCode ? String(error?.message || "").slice(0, 300) : "";
      res.end(JSON.stringify(message && message !== code ? { error: code, message } : { error: code }));
    }
  });
  return server;
}
