import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { WebStandardStreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js";
import { z } from "zod";
import { buscar, InputError, type Filtros, type SearchDeps } from "./search/buscar";
import { parseRerankResponse } from "./search/rerank";
import { formatResultados } from "./search/sanitize";
import { logBusqueda } from "./log";
import { registerGateway, type GwEnv } from "./gateway/tools";
import { UA_PREFIJO } from "./gateway/cliente";
import { renderPagina } from "./ui";
import type { Entry } from "./types";

export { SesionDO } from "./gateway/sesion";

interface Env extends GwEnv { VECTORS: VectorizeIndex; AI: Ai; LIMITER: RateLimit }

// Duplicated from src/ingest/cloudflare.ts (EMBEDDING_DIMS) to keep that Node-oriented module out of the Worker bundle.
const DIMS = 1024;

function realDeps(env: Env): SearchDeps {
  return {
    async embed(t) {
      const r: any = await env.AI.run("@cf/baai/bge-m3" as any, { text: [t] });
      const v = r?.data?.[0];
      if (!Array.isArray(v) || v.length !== DIMS) throw new Error("embedding dims");
      return v;
    },
    async nearest(v, topK) {
      const r = await env.VECTORS.query(v, { topK });
      return r.matches.map((m) => ({ id: m.id, score: m.score }));
    },
    // No documented limit on contexts/tokens per request for bge-reranker-base (checked
    // developers.cloudflare.com/workers-ai/models/bge-reranker-base/ and .../platform/limits/): one request.
    async rerank(query, textos) {
      const r = await env.AI.run("@cf/baai/bge-reranker-base" as any, { query, contexts: textos.map((text) => ({ text })) });
      return parseRerankResponse(r, textos.length);
    },
    async getEntries(ids) {
      if (!ids.length) return [];
      const sql = `SELECT id, nombre, descripcion, url_info, tipo_conexion, como_conectar, auth, incompleta, actualizado FROM entradas WHERE id IN (${ids.map(() => "?").join(",")})`;
      const { results } = await env.DB.prepare(sql).bind(...ids).all<any>();
      return results.map((r): Entry => ({ ...r, incompleta: !!r.incompleta }));
    },
  };
}

// Same search + log for the MCP tool and /api/buscar.
async function buscarYRegistrar(env: Env, ctx: ExecutionContext, necesidad: string, filtros: Filtros) {
  const r = await buscar(realDeps(env), necesidad, filtros);
  ctx.waitUntil(logBusqueda(env.LOGS, { consulta: necesidad, filtros, n_resultados: r.coincidencias.length }).catch(() => {}));
  return r;
}

const text = (t: string, isError = false) => ({ content: [{ type: "text" as const, text: t }], ...(isError ? { isError } : {}) });

function buildServer(env: Env, ctx: ExecutionContext, ip: string, host: string) {
  const server = new McpServer({ name: "catalogo-mcp-busqueda", version: "0.1.0" });
  server.registerTool(
    "buscar",
    {
      description:
        "Busca en el catálogo de servidores MCP según una necesidad descrita en lenguaje natural (por ejemplo: 'leer hojas de cálculo'). Devuelve los servidores más relevantes y cómo conectarlos. Para usar uno remoto sin autenticación, pasa su `id` a `explorar` y `llamar`.",
      inputSchema: {
        necesidad: z.string().max(2000).describe("Qué necesitas hacer, en lenguaje natural (español o inglés), máximo 2000 caracteres."),
        tipo_conexion: z.enum(["remoto", "local"]).optional().describe("Filtro opcional: 'remoto' (se conecta por URL) o 'local' (se ejecuta en tu máquina con npx/uvx/docker)."),
        auth: z.enum(["ninguna", "clave", "oauth", "desconocida"]).optional().describe("Filtro opcional de autenticación: 'ninguna', 'clave' (clave o token secreto), 'desconocida' (remoto sin cabeceras declaradas) u 'oauth'. Nota: 'oauth' se acepta pero el catálogo no lo asigna todavía a ninguna entrada, así que devuelve sin resultados."),
      },
    },
    async ({ necesidad, tipo_conexion, auth }) => {
      const filtros: Filtros = { ...(tipo_conexion && { tipo_conexion }), ...(auth && { auth }) };
      try {
        const r = await buscarYRegistrar(env, ctx, necesidad, filtros);
        return text(r.coincidencias.length ? formatResultados(r.coincidencias) : (r.mensaje ?? "sin coincidencias fiables"));
      } catch (e) {
        return e instanceof InputError ? text(e.message, true) : text("error interno", true);
      }
    },
  );
  registerGateway(server, env, ctx, ip, host);
  return server;
}

const MAX_BODY = 16 * 1024;
const err = (status: number, message: string, headers?: HeadersInit, code = -32000) =>
  Response.json({ jsonrpc: "2.0", id: null, error: { code, message } }, { status, headers });

// Lotes JSON-RPC: una petición HTTP (un token del limitador) podría llevar cientos de llamadas. Se parsea de verdad
// (un prefijo no basta: espacios/BOM delante). JSON inválido u objeto suelto siguen al transporte tal cual.
function esLote(body: Uint8Array): boolean {
  try { return Array.isArray(JSON.parse(new TextDecoder().decode(body))); } catch { return false; }
}

// Reads at most MAX_BODY bytes (enforced while streaming, so it holds without content-length); null if exceeded.
async function readCapped(req: Request): Promise<Uint8Array | null> {
  const cl = Number(req.headers.get("content-length"));
  if (cl > MAX_BODY) return null;
  const chunks: Uint8Array[] = [];
  let n = 0;
  if (req.body) {
    const reader = req.body.getReader();
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      n += value.length;
      if (n > MAX_BODY) { await reader.cancel(); return null; }
      chunks.push(value);
    }
  }
  const out = new Uint8Array(n);
  let o = 0;
  for (const c of chunks) { out.set(c, o); o += c.length; }
  return out;
}

const LIMITE = "Demasiadas peticiones, inténtalo de nuevo en un minuto.";
const NO_POST = "Método no permitido; usa POST.";
const GRANDE = "Petición demasiado grande (máximo 16 KB).";

// /api/buscar: same-origin JSON for the web page. No CORS headers on purpose.
const apiRes = (status: number, o: unknown, headers?: Record<string, string>) =>
  Response.json(o, { status, headers: { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store", "X-Content-Type-Options": "nosniff", ...headers } });
const apiErr = (status: number, error: string, headers?: Record<string, string>) => apiRes(status, { error }, headers);

const CONEXIONES = ["remoto", "local"];
const AUTHS = ["ninguna", "clave", "oauth", "desconocida"];

async function apiBuscar(req: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
  if (req.method !== "POST") return apiErr(405, NO_POST, { Allow: "POST" });
  // Forces a CORS preflight for cross-site callers (which then fails: no CORS headers), so forms can't spend tokens.
  if (!/^application\/json\s*(;|$)/i.test(req.headers.get("content-type") ?? "")) return apiErr(415, "Se requiere Content-Type: application/json.");
  const body = await readCapped(req);
  if (!body) return apiErr(413, GRANDE);
  let d: any;
  try { d = JSON.parse(new TextDecoder().decode(body)); } catch { return apiErr(400, "JSON inválido."); }
  if (typeof d !== "object" || d === null || Array.isArray(d)) return apiErr(400, "El cuerpo debe ser un objeto JSON.");
  const { necesidad, tipo_conexion, auth } = d;
  if (typeof necesidad !== "string" || !necesidad.trim() || necesidad.length > 2000)
    return apiErr(400, "necesidad debe ser un texto de 1 a 2000 caracteres.");
  if (tipo_conexion !== undefined && !CONEXIONES.includes(tipo_conexion)) return apiErr(400, "tipo_conexion debe ser 'remoto' o 'local'.");
  if (auth !== undefined && !AUTHS.includes(auth)) return apiErr(400, "auth debe ser 'ninguna', 'clave', 'oauth' o 'desconocida'.");
  const filtros: Filtros = { ...(tipo_conexion && { tipo_conexion }), ...(auth && { auth }) };
  try {
    const r = await buscarYRegistrar(env, ctx, necesidad, filtros);
    return apiRes(200, r.coincidencias.length ? { coincidencias: r.coincidencias } : { coincidencias: [], mensaje: r.mensaje ?? "sin coincidencias fiables" });
  } catch (e) {
    return e instanceof InputError ? apiErr(400, e.message) : apiErr(500, "Error interno.");
  }
}

function pagina(): Response {
  const nonce = btoa(String.fromCharCode(...crypto.getRandomValues(new Uint8Array(16)))).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
  return new Response(renderPagina(nonce), {
    headers: {
      "Content-Type": "text/html; charset=utf-8",
      "Content-Security-Policy": `default-src 'none'; script-src 'nonce-${nonce}'; style-src 'nonce-${nonce}'; connect-src 'self'; img-src 'none'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'`,
      "X-Content-Type-Options": "nosniff",
      "Referrer-Policy": "no-referrer",
      "Cache-Control": "no-store",
    },
  });
}

export default {
  async fetch(req: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    if (req.headers.get("user-agent")?.startsWith(UA_PREFIJO)) return err(403, "Petición recursiva rechazada.");
    const path = new URL(req.url).pathname;
    // Static page, no backend: served before the limiter so a limited visitor still sees it (the API then says 429).
    if (req.method === "GET" && path === "/") return pagina();
    let success = true;
    const ip = req.headers.get("CF-Connecting-IP") ?? "anon";
    try {
      ({ success } = await env.LIMITER.limit({ key: ip }));
    } catch {
      // fail open: a limiter outage must not take the service down
    }
    const esApi = path === "/api/buscar";
    if (!success) return esApi ? apiErr(429, LIMITE) : err(429, LIMITE);
    if (esApi) return apiBuscar(req, env, ctx);
    if (req.method !== "POST") return err(405, NO_POST, { Allow: "POST" });
    const body = await readCapped(req);
    if (!body) return err(413, GRANDE);
    if (esLote(body)) return err(400, "No se admiten lotes de peticiones.", undefined, -32600);
    // Stateless: fresh server + transport per request, JSON responses (no SSE/session).
    const transport = new WebStandardStreamableHTTPServerTransport({ enableJsonResponse: true });
    await buildServer(env, ctx, ip, new URL(req.url).host).connect(transport);
    return transport.handleRequest(new Request(req.url, { method: "POST", headers: req.headers, body }));
  },
};
