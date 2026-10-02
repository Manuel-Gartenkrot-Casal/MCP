import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { WebStandardStreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js";
import { z } from "zod";
import { buscar, InputError, type Filtros, type SearchDeps } from "./search/buscar";
import { formatResultados } from "./search/sanitize";
import { logBusqueda } from "./log";
import type { Entry } from "./types";

interface Env { DB: D1Database; VECTORS: VectorizeIndex; AI: Ai; LOGS: R2Bucket; LIMITER: RateLimit }

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
    async getEntries(ids) {
      if (!ids.length) return [];
      const sql = `SELECT id, nombre, descripcion, url_info, tipo_conexion, como_conectar, auth, incompleta, actualizado FROM entradas WHERE id IN (${ids.map(() => "?").join(",")})`;
      const { results } = await env.DB.prepare(sql).bind(...ids).all<any>();
      return results.map((r): Entry => ({ ...r, incompleta: !!r.incompleta }));
    },
  };
}

const text = (t: string, isError = false) => ({ content: [{ type: "text" as const, text: t }], ...(isError ? { isError } : {}) });

function buildServer(env: Env, ctx: ExecutionContext) {
  const server = new McpServer({ name: "catalogo-mcp-busqueda", version: "0.1.0" });
  server.registerTool(
    "buscar",
    {
      description:
        "Busca en el catálogo de servidores MCP según una necesidad descrita en lenguaje natural (por ejemplo: 'leer hojas de cálculo'). Devuelve los servidores más relevantes y cómo conectarlos.",
      inputSchema: {
        necesidad: z.string(),
        tipo_conexion: z.enum(["remoto", "local"]).optional(),
        auth: z.enum(["ninguna", "clave", "oauth", "desconocida"]).optional(),
      },
    },
    async ({ necesidad, tipo_conexion, auth }) => {
      const filtros: Filtros = { ...(tipo_conexion && { tipo_conexion }), ...(auth && { auth }) };
      try {
        const r = await buscar(realDeps(env), necesidad, filtros);
        ctx.waitUntil(
          logBusqueda(env.LOGS, { consulta: necesidad, filtros, n_resultados: r.coincidencias.length }).catch(() => {}),
        );
        return text(r.coincidencias.length ? formatResultados(r.coincidencias) : (r.mensaje ?? "sin coincidencias fiables"));
      } catch (e) {
        return e instanceof InputError ? text(e.message, true) : text("error interno", true);
      }
    },
  );
  return server;
}

export default {
  async fetch(req: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    const { success } = await env.LIMITER.limit({ key: req.headers.get("CF-Connecting-IP") ?? "anon" });
    if (!success)
      return Response.json(
        { jsonrpc: "2.0", id: null, error: { code: -32029, message: "Demasiadas peticiones, inténtalo de nuevo en un minuto." } },
        { status: 429 },
      );
    // Stateless: fresh server + transport per request, JSON responses (no SSE/session).
    const transport = new WebStandardStreamableHTTPServerTransport({ enableJsonResponse: true });
    await buildServer(env, ctx).connect(transport);
    return transport.handleRequest(req);
  },
};
