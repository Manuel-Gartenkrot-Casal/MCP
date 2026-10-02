import type { Auth, Conexion, Entry } from "../types";
import { sanitizeText } from "./sanitize";

export interface Filtros { tipo_conexion?: Conexion; auth?: Auth }
export interface Resultado {
  nombre: string; funcion: string; como_conectar: string;
  tipo_conexion: Conexion; auth: Auth; puntaje: number;
}
export interface SearchDeps {
  embed(t: string): Promise<number[]>;
  nearest(v: number[], n: number): Promise<{ id: string; score: number }[]>;
  getEntries(ids: string[]): Promise<Entry[]>;
}
export class InputError extends Error {}

const CONEXIONES = ["remoto", "local"];
const AUTHS = ["ninguna", "clave", "oauth", "desconocida"];
const SIN = { coincidencias: [] as Resultado[], mensaje: "sin coincidencias fiables" };

export async function buscar(
  deps: SearchDeps,
  necesidad: string,
  filtros: Filtros = {},
  opts: { n?: number; max?: number; umbral?: number } = {},
): Promise<{ coincidencias: Resultado[]; mensaje?: string }> {
  const { n = 20, max = 10, umbral = 0.5 } = opts;
  const q = (necesidad ?? "").trim().slice(0, 1000);
  if (!q) throw new InputError("necesidad vacía");
  if (filtros.tipo_conexion !== undefined && !CONEXIONES.includes(filtros.tipo_conexion))
    throw new InputError("tipo_conexion inválido");
  if (filtros.auth !== undefined && !AUTHS.includes(filtros.auth)) throw new InputError("auth inválido");

  const hits = await deps.nearest(await deps.embed(q), n);
  if (!hits.length) return { ...SIN };
  const byId = new Map((await deps.getEntries(hits.map((h) => h.id))).map((e) => [e.id, e]));
  const out: Resultado[] = [];
  for (const h of [...hits].sort((a, b) => b.score - a.score)) {
    const e = byId.get(h.id);
    if (!e) continue; // stale vector
    if (filtros.tipo_conexion && e.tipo_conexion !== filtros.tipo_conexion) continue;
    if (filtros.auth && e.auth !== filtros.auth) continue;
    out.push({
      nombre: sanitizeText(e.nombre), funcion: sanitizeText(e.descripcion),
      como_conectar: sanitizeText(e.como_conectar),
      tipo_conexion: e.tipo_conexion, auth: e.auth, puntaje: h.score,
    });
  }
  if (!out.length || out[0].puntaje < umbral) return { ...SIN };
  return { coincidencias: out.slice(0, max) };
}
