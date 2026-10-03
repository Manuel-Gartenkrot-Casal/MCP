import { GatewayError } from "./types";
import type { RawTool } from "./formato";

export interface Destino { url: string; sessionId?: string }

export const TIMEOUT_MS = 20000;
export const MAX_BYTES = 256 * 1024;
const PROTOCOL = "2025-06-18";

const isObj = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);

async function leerAcotado(res: Response): Promise<string> {
  if (!res.body) return "";
  const reader = res.body.getReader();
  const partes: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > MAX_BYTES) { await reader.cancel().catch(() => {}); throw new GatewayError("destino_caido"); }
    partes.push(value);
  }
  const buf = new Uint8Array(total);
  let o = 0;
  for (const p of partes) { buf.set(p, o); o += p.byteLength; }
  return new TextDecoder().decode(buf);
}

const esRpc = (v: unknown): v is Record<string, unknown> => isObj(v) && ("result" in v || "error" in v);

function parsear(texto: string, ct: string): Record<string, unknown> | null {
  try {
    if (ct.includes("text/event-stream")) {
      for (const linea of texto.split(/\r?\n/)) {
        if (!linea.startsWith("data:")) continue;
        try { const j = JSON.parse(linea.slice(5).trim()); if (esRpc(j)) return j; } catch { /* otro evento */ }
      }
      return null;
    }
    const j = JSON.parse(texto);
    return esRpc(j) ? j : null;
  } catch { return null; }
}

// Única función que hace HTTP saliente. Devuelve el cuerpo ya leído (acotado) y la cabecera de sesión.
async function enviar(url: string, sessionId: string | undefined, msg: object, fetchFn: typeof fetch) {
  const headers: Record<string, string> = {
    "Content-Type": "application/json",
    "Accept": "application/json, text/event-stream",
    "MCP-Protocol-Version": PROTOCOL,
    "User-Agent": "catalogo-mcp-busqueda/0.1 (+gateway)",
  };
  if (sessionId) headers["Mcp-Session-Id"] = sessionId;
  let res: Response;
  try {
    res = await fetchFn(url, {
      method: "POST", headers, body: JSON.stringify(msg), redirect: "manual", signal: AbortSignal.timeout(TIMEOUT_MS),
    });
  } catch (e: any) {
    throw new GatewayError(e?.name === "TimeoutError" || e?.name === "AbortError" ? "timeout" : "destino_caido");
  }
  if (res.status === 401 || res.status === 403 || res.status < 200 || res.status >= 300) {
    await res.body?.cancel().catch(() => {});
    throw new GatewayError(res.status === 401 || res.status === 403 ? "requiere_auth" : "destino_caido");
  }
  let texto: string;
  try { texto = await leerAcotado(res); } catch (e) {
    if (e instanceof GatewayError) throw e;
    throw new GatewayError(e instanceof Error && (e.name === "TimeoutError" || e.name === "AbortError") ? "timeout" : "destino_caido");
  }
  return { texto, ct: res.headers.get("content-type") ?? "", sid: res.headers.get("mcp-session-id") ?? undefined };
}

async function pedir(d: Destino, id: number, method: string, params: object, fetchFn: typeof fetch) {
  const r = await enviar(d.url, d.sessionId, { jsonrpc: "2.0", id, method, params }, fetchFn);
  const rpc = parsear(r.texto, r.ct);
  if (!rpc || !isObj(rpc.result)) throw new GatewayError("destino_caido");
  return { result: rpc.result, sid: r.sid };
}

export async function inicializar(url: string, fetchFn: typeof fetch = fetch): Promise<{ sessionId?: string }> {
  const { sid } = await pedir({ url }, 1, "initialize", {
    protocolVersion: PROTOCOL, capabilities: {}, clientInfo: { name: "catalogo-mcp-busqueda", version: "0.1.0" },
  }, fetchFn);
  // Best effort: el fallo real (auth, caída) saldrá en la siguiente llamada.
  await enviar(url, sid, { jsonrpc: "2.0", method: "notifications/initialized" }, fetchFn).catch(() => {});
  return sid ? { sessionId: sid } : {};
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
