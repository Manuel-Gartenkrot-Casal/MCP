import { GatewayError } from "./types";
import type { RawTool } from "./formato";

export interface Destino { url: string; sessionId?: string; version?: string }

export const TIMEOUT_MS = 20000;
export const MAX_BYTES = 256 * 1024;
const PROTOCOL = "2025-06-18";
// El Worker rechaza peticiones entrantes con este prefijo (evita bucles hacia sí mismo por otro dominio).
export const UA_PREFIJO = "catalogo-mcp-busqueda/";
const UA = `${UA_PREFIJO}0.1 (+https://github.com/Manuel-Gartenkrot-Casal/MCP)`;
const VERSIONES = [PROTOCOL, "2025-03-26", "2024-11-05"];

const isObj = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);

const SID_OK = /^[\x21-\x7e]{1,256}$/;
type Rpc = Record<string, unknown>;
const ok = (j: unknown, id: number): j is Rpc => isObj(j) && ("result" in j || "error" in j) && j.id === id;

function evento(ev: string, id: number): Rpc | null {
  const datos = ev.split(/\r?\n/).filter((l) => l.startsWith("data:")).map((l) => l.slice(5).replace(/^ /, ""));
  if (datos.length === 0) return null;
  try { const j = JSON.parse(datos.join("\n")); return ok(j, id) ? j : null; } catch { return null; }
}

// Lee como máximo MAX_BYTES. En SSE se detiene en cuanto llega el evento con el id esperado (el stream puede seguir abierto).
async function leerRespuesta(res: Response, id: number): Promise<Rpc | null> {
  if (!res.body) return null;
  const sse = (res.headers.get("content-type") ?? "").toLowerCase().includes("text/event-stream");
  const reader = res.body.getReader();
  const dec = new TextDecoder();
  let texto = "", total = 0, desde = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > MAX_BYTES) { await reader.cancel().catch(() => {}); throw new GatewayError("destino_caido"); }
    texto += dec.decode(value, { stream: true });
    if (!sse) continue;
    const re = /\r?\n\r?\n/g;
    re.lastIndex = desde;
    for (let m; (m = re.exec(texto)); desde = re.lastIndex) {
      const j = evento(texto.slice(desde, m.index), id);
      if (j) { await reader.cancel().catch(() => {}); return j; }
    }
  }
  texto += dec.decode();
  if (sse) return evento(texto.slice(desde), id);
  try { const j = JSON.parse(texto); return ok(j, id) ? j : null; } catch { return null; }
}

// Única función que hace HTTP saliente. Sin `id` (notificación) no se lee el cuerpo.
async function enviar(d: Destino, msg: { id?: number; [k: string]: unknown }, fetchFn: typeof fetch) {
  const headers: Record<string, string> = {
    "Content-Type": "application/json",
    "Accept": "application/json, text/event-stream",
    "MCP-Protocol-Version": VERSIONES.includes(d.version ?? "") ? d.version! : PROTOCOL,
    "User-Agent": UA,
  };
  if (d.sessionId) headers["Mcp-Session-Id"] = d.sessionId;
  let res: Response;
  try {
    res = await fetchFn(d.url, {
      method: "POST", headers, body: JSON.stringify(msg), redirect: "manual", signal: AbortSignal.timeout(TIMEOUT_MS),
    });
  } catch (e: any) {
    throw new GatewayError(e?.name === "TimeoutError" || e?.name === "AbortError" ? "timeout" : "destino_caido");
  }
  if (res.status < 200 || res.status >= 300 || msg.id === undefined) {
    await res.body?.cancel().catch(() => {});
    if (res.status >= 200 && res.status < 300) return { rpc: null, sid: undefined };
    // 404 a una sesión enviada = el destino la olvidó (spec MCP): el cliente debe volver a explorar.
    throw new GatewayError(res.status === 401 || res.status === 403 ? "requiere_auth"
      : res.status === 404 && d.sessionId ? "sesion_expirada" : "destino_caido");
  }
  let rpc: Rpc | null;
  try { rpc = await leerRespuesta(res, msg.id); } catch (e) {
    if (e instanceof GatewayError) throw e;
    throw new GatewayError(e instanceof Error && (e.name === "TimeoutError" || e.name === "AbortError") ? "timeout" : "destino_caido");
  }
  const sid = res.headers.get("mcp-session-id");
  return { rpc, sid: SID_OK.test(sid ?? "") ? sid! : undefined };
}

async function pedir(d: Destino, id: number, method: string, params: object, fetchFn: typeof fetch) {
  const { rpc, sid } = await enviar(d, { jsonrpc: "2.0", id, method, params }, fetchFn);
  if (!rpc || !isObj(rpc.result)) throw new GatewayError("destino_caido");
  return { result: rpc.result, sid };
}

export async function inicializar(url: string, fetchFn: typeof fetch = fetch): Promise<{ sessionId?: string; version?: string }> {
  const { result, sid } = await pedir({ url }, 1, "initialize", {
    protocolVersion: PROTOCOL, capabilities: {}, clientInfo: { name: "catalogo-mcp-busqueda", version: "0.1.0" },
  }, fetchFn);
  // Solo versiones conocidas: el valor acaba en una cabecera saliente.
  const v = result.protocolVersion;
  const version = typeof v === "string" && VERSIONES.includes(v) ? v : undefined;
  // Best effort: el fallo real (auth, caída) saldrá en la siguiente llamada.
  await enviar({ url, sessionId: sid, version }, { jsonrpc: "2.0", method: "notifications/initialized" }, fetchFn).catch(() => {});
  return { ...(sid && { sessionId: sid }), ...(version && { version }) };
}

export async function listarHerramientas(d: Destino, fetchFn: typeof fetch = fetch): Promise<RawTool[]> {
  const { result } = await pedir(d, 2, "tools/list", {}, fetchFn);
  if (!Array.isArray(result.tools)) throw new GatewayError("destino_caido");
  return result.tools as RawTool[];
}

export async function llamarHerramienta(
  d: Destino, nombre: string, args: Record<string, unknown>, fetchFn: typeof fetch = fetch,
): Promise<{ content: unknown[]; isError: boolean }> {
  const { result } = await pedir(d, 3, "tools/call", { name: nombre, arguments: args }, fetchFn);
  return { content: Array.isArray(result.content) ? result.content : [], isError: result.isError === true };
}
