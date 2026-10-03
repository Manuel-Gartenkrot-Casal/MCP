import { DurableObject } from "cloudflare:workers";
import { GatewayError } from "./types";
import type { GwCode, Marca, Salida, ToolInfo } from "./types";
import { toToolInfo } from "./formato";
import { inicializar, listarHerramientas, llamarHerramienta } from "./cliente";

export const TTL_MS = 10 * 60 * 1000;

const fallo = (e: unknown): { ok: false; code: GwCode } =>
  ({ ok: false, code: e instanceof GatewayError ? e.code : "destino_caido" });

// Un DO por token de sesión opaco. Guarda el Mcp-Session-Id del destino y la caché de herramientas.
export class SesionDO extends DurableObject {
  fetchFn: typeof fetch = fetch;

  private async tocar() {
    await this.ctx.storage.put("ultimoUso", Date.now());
    await this.ctx.storage.setAlarm(Date.now() + TTL_MS);
  }

  async explorar(servidorId: string, url: string): Promise<Salida<ToolInfo[]>> {
    if (typeof url !== "string" || !url.startsWith("https://")) return { ok: false, code: "no_remoto" };
    const st = this.ctx.storage;
    const guardado = await st.get<string>("servidor");
    if (guardado !== undefined && guardado !== servidorId) return { ok: false, code: "sesion_otro_servidor" };
    try {
      const sessionId = guardado === undefined
        ? (await inicializar(url, this.fetchFn)).sessionId
        : await st.get<string>("mcpSession");
      const raw = await listarHerramientas({ url, sessionId }, this.fetchFn);
      const tools = raw.map(toToolInfo).filter((t): t is ToolInfo => t !== null);
      // Solo ahora se persiste: un fallo previo no deja el token ligado a una sesión a medias.
      await st.put("servidor", servidorId);
      if (sessionId !== undefined) await st.put("mcpSession", sessionId); else await st.delete("mcpSession");
      await st.put("tools", tools);
      await this.tocar();
      return { ok: true, valor: tools };
    } catch (e) { return fallo(e); }
  }

  async llamar(servidorId: string, url: string, herramienta: string, args: Record<string, unknown>, confirmar: boolean):
    Promise<Salida<{ content: unknown[]; isError: boolean; marca: Marca }>> {
    if (typeof url !== "string" || !url.startsWith("https://")) return { ok: false, code: "no_remoto" };
    const st = this.ctx.storage;
    const guardado = await st.get<string>("servidor");
    if (guardado === undefined) return { ok: false, code: "sesion_expirada" };
    if (guardado !== servidorId) return { ok: false, code: "sesion_otro_servidor" };
    const tools = (await st.get<ToolInfo[]>("tools")) ?? [];
    const t = tools.find((x) => x.nombre === herramienta);
    if (!t) return { ok: false, code: "herramienta_inexistente" };
    if (t.marca !== "solo_lectura" && confirmar !== true) return { ok: false, code: "confirmar", marca: t.marca };
    try {
      const sessionId = await st.get<string>("mcpSession");
      const r = await llamarHerramienta({ url, sessionId }, herramienta, args, this.fetchFn);
      await this.tocar();
      return { ok: true, valor: { ...r, marca: t.marca } };
    } catch (e) { return fallo(e); }
  }

  async alarm(): Promise<void> {
    await this.ctx.storage.deleteAll();
  }
}
