import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { GatewayError } from "./types";
import type { Marca, GwCode } from "./types";
import type { SesionDO } from "./sesion";
import { validarDestino } from "./url";
import { formatExplorar, formatResultadoLlamada, lineaSesion } from "./formato";
import { logLlamada } from "../log";

export interface GwEnv {
  DB: D1Database; LOGS: R2Bucket; SESIONES: DurableObjectNamespace<SesionDO>;
  LIMITER_EXPLORAR: RateLimit; LIMITER_LLAMAR: RateLimit; GATEWAY_ENABLED?: string; GATEWAY_BLOQUEADOS?: string;
}

const text = (t: string, isError = false) => ({ content: [{ type: "text" as const, text: t }], ...(isError ? { isError } : {}) });
const LIMITE = "Demasiadas peticiones, inténtalo de nuevo en un minuto.";
const TOKEN = /^[0-9a-f]{32}$/;
const isObj = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);

class Limite extends Error {}

export const nuevoToken = () => [...crypto.getRandomValues(new Uint8Array(16))].map((b) => b.toString(16).padStart(2, "0")).join("");

/** Valida herramienta y argumentos de `llamar` (undefined = {}). */
export function validarLlamar(herramienta: string, argumentos: unknown): boolean {
  if (!/^[A-Za-z0-9_.-]{1,128}$/.test(herramienta)) return false;
  if (argumentos === undefined) return true;
  if (!isObj(argumentos)) return false;
  try { return JSON.stringify(argumentos).length <= 16384; } catch { return false; }
}

// conToken: el DO ya quedó ligado al token nuevo (llamar sin sesion), así que el error lo devuelve para reintentar.
type Fallo = { code: GwCode; marca?: Marca; conToken?: boolean };
type Hecho = { out: ReturnType<typeof text>; resultado: string; marca?: Marca };

export function registerGateway(server: McpServer, env: GwEnv, ctx: ExecutionContext, ip: string, host: string) {
  // Puerta común: interruptor, límite, validación y resolución del destino en D1 (todo antes de tocar el DO).
  async function preparar(limiter: RateLimit, a: { servidor: string; sesion?: string }, valida: boolean): Promise<string> {
    if (env.GATEWAY_ENABLED !== "1") throw new GatewayError("desactivada");
    let success = true;
    try { ({ success } = await limiter.limit({ key: ip })); } catch { /* fail open */ }
    if (!success) throw new Limite(LIMITE);
    if (!valida || (a.sesion !== undefined && !TOKEN.test(a.sesion))) throw new GatewayError("entrada_invalida");
    // Freno del operador: ids bloqueados se tratan como desconocidos (exacto, sensible a mayúsculas).
    if ((env.GATEWAY_BLOQUEADOS ?? "").split(",").map((x) => x.trim()).includes(a.servidor)) throw new GatewayError("no_encontrado");
    const r = await env.DB.prepare("SELECT id, tipo_conexion, como_conectar FROM entradas WHERE id = ?").bind(a.servidor).first<any>();
    if (!r) throw new GatewayError("no_encontrado");
    if (r.tipo_conexion !== "remoto") throw new GatewayError("no_remoto");
    return validarDestino(String(r.como_conectar), host).href;
  }

  function handler<A extends { servidor: string; sesion?: string }>(
    limiter: RateLimit, valida: (a: A) => boolean, herramienta: (a: A) => string,
    run: (a: A, url: string, stub: DurableObjectStub<SesionDO>, token: string) => Promise<Hecho | Fallo>,
  ) {
    return async (a: A) => {
      const t0 = Date.now();
      let url: string;
      try { url = await preparar(limiter, a, valida(a)); }
      catch (e) {
        return text(e instanceof GatewayError || e instanceof Limite ? e.message : "error interno", true);
      }
      const token = a.sesion ?? nuevoToken();
      const log = (resultado: string, marca?: Marca) =>
        ctx.waitUntil(logLlamada(env.LOGS, { servidor: a.servidor, herramienta: herramienta(a), resultado, ms: Date.now() - t0, ...(marca && { marca }) }).catch(() => {}));
      try {
        const r = await run(a, url, env.SESIONES.get(env.SESIONES.idFromName(token)), token);
        if ("code" in r) {
          log(r.code, r.marca);
          const msg = new GatewayError(r.code, r.marca).message;
          return text(r.conToken ? `${msg}\n${lineaSesion(token)}` : msg, true);
        }
        log(r.resultado, r.marca);
        return r.out;
      } catch { return text("error interno", true); }
    };
  }

  server.registerTool(
    "explorar",
    {
      description: "Lista las herramientas de un servidor MCP remoto del catálogo (el `id` sale de `buscar`). Solo funcionan servidores remotos sin autenticación. Devuelve un token `sesion` reutilizable en `llamar`.",
      inputSchema: {
        servidor: z.string().min(1).max(128).describe("Id del catálogo (campo `id` de un resultado de `buscar`)"),
        sesion: z.string().max(100).optional().describe("Token de sesión devuelto por `explorar` o `llamar`; si falta se crea uno nuevo."),
      },
    },
    handler<{ servidor: string; sesion?: string }>(env.LIMITER_EXPLORAR, () => true, () => "(explorar)", async (a, url, stub, token) => {
      const r = await stub.explorar(a.servidor, url);
      if (!("valor" in r)) return r;
      return { out: text(formatExplorar(token, r.valor)), resultado: "ok" };
    }),
  );

  type LA = { servidor: string; herramienta: string; argumentos?: unknown; sesion?: string; confirmar?: boolean };
  server.registerTool(
    "llamar",
    {
      description: "Ejecuta una herramienta de un servidor MCP remoto del catálogo (el `id` sale de `buscar`). Solo funcionan servidores remotos sin autenticación. Las herramientas no marcadas como de solo lectura requieren `confirmar: true`.",
      inputSchema: {
        servidor: z.string().min(1).max(128).describe("Id del catálogo (campo `id` de un resultado de `buscar`)"),
        herramienta: z.string().max(200).describe("Nombre de la herramienta, tal como la devuelve `explorar`."),
        argumentos: z.record(z.string(), z.unknown()).optional().describe("Objeto con los argumentos de la herramienta (máximo 16 KB); por defecto {}."),
        sesion: z.string().max(100).optional().describe("Token de sesión devuelto por `explorar` o `llamar`; si falta se explora el servidor y se crea uno."),
        confirmar: z.boolean().optional().describe("Confirmación explícita para herramientas que no están marcadas como de solo lectura (destructivas o sin declarar). Sin ella se rechazan."),
      },
    },
    handler<LA>(env.LIMITER_LLAMAR, (a) => validarLlamar(a.herramienta, a.argumentos), (a) => a.herramienta, async (a, url, stub, token) => {
      if (a.sesion === undefined) {
        const e = await stub.explorar(a.servidor, url);
        if (!e.ok) return e;
      }
      const r = (await stub.llamar(a.servidor, url, a.herramienta, (a.argumentos ?? {}) as Record<string, unknown>, a.confirmar === true)) as Awaited<ReturnType<SesionDO["llamar"]>>;
      if (!("valor" in r)) return { ...r, conToken: a.sesion === undefined };
      const f = formatResultadoLlamada(token, r.valor);
      return { out: text(f.texto, f.isError), resultado: r.valor.isError ? "error_destino" : "ok", marca: r.valor.marca };
    }),
  );
}
