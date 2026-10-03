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

  // Serializa explorar/llamar por instancia (las puertas de entrada del DO se abren durante el fetch al destino).
  // La llamada saliente queda dentro del cerrojo: el cliente la acota a 20 s, así que no se retiene más por llamada.
  private cola: Promise<unknown> = Promise.resolve();
  private serie<T>(fn: () => Promise<T>): Promise<T> {
    const r = this.cola.then(fn, fn);
    this.cola = r.catch(() => {});
    return r;
  }

  private async renovar() {
    await this.ctx.storage.put("ultimoUso", Date.now());
    await this.ctx.storage.setAlarm(Date.now() + TTL_MS);
  }

  explorar(servidorId: string, url: string): Promise<Salida<ToolInfo[]>> {
    return this.serie(() => this.explorar_(servidorId, url));
  }

  private async explorar_(servidorId: string, url: string): Promise<Salida<ToolInfo[]>> {
    if (typeof url !== "string" || !url.startsWith("https://")) return { ok: false, code: "no_remoto" };
    const st = this.ctx.storage;
    const guardado = await st.get<string>("servidor");
    if (guardado !== undefined && guardado !== servidorId) return { ok: false, code: "sesion_otro_servidor" };
    try {
      // Siempre se reinicializa: una explorar explícita recupera una sesión que el destino olvidó (no es renovación silenciosa).
      const { sessionId, version } = await inicializar(url, this.fetchFn);
      const raw = await listarHerramientas({ url, sessionId, version }, this.fetchFn);
      const tools = raw.map(toToolInfo).filter((t): t is ToolInfo => t !== null);
      // Solo ahora se persiste: un fallo previo no deja el token ligado a una sesión a medias.
      const ahora = await st.get<string>("servidor");
      if (ahora !== undefined && ahora !== servidorId) return { ok: false, code: "sesion_otro_servidor" };
      if (sessionId === undefined) await st.delete("mcpSession");
      if (version === undefined) await st.delete("version");
      await st.put({ servidor: servidorId, tools, ultimoUso: Date.now(),
        ...(sessionId !== undefined && { mcpSession: sessionId }), ...(version !== undefined && { version }) });
      await st.setAlarm(Date.now() + TTL_MS);
      return { ok: true, valor: tools };
    } catch (e) { return fallo(e); }
  }

  llamar(servidorId: string, url: string, herramienta: string, args: Record<string, unknown>, confirmar: boolean):
    Promise<Salida<{ content: unknown[]; isError: boolean; marca: Marca }>> {
    return this.serie(() => this.llamar_(servidorId, url, herramienta, args, confirmar));
  }

  private async llamar_(servidorId: string, url: string, herramienta: string, args: Record<string, unknown>, confirmar: boolean):
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
      const d = { url, sessionId: await st.get<string>("mcpSession"), version: await st.get<string>("version") };
      const r = await llamarHerramienta(d, herramienta, args, this.fetchFn);
      if ((await st.get<string>("servidor")) === servidorId) await this.renovar(); // si la alarma borró todo, no dejar ultimoUso huérfano
      return { ok: true, valor: { ...r, marca: t.marca } };
    } catch (e) { return fallo(e); }
  }

  async alarm(): Promise<void> {
    await this.ctx.storage.deleteAll();
  }
}
