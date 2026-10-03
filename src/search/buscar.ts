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
  // One score in [0,1] per text, same order. Optional: without it (or if it fails) the vector order is used.
  rerank?(query: string, textos: string[]): Promise<number[]>;
}
export class InputError extends Error {}

const CONEXIONES = ["remoto", "local"];
const AUTHS = ["ninguna", "clave", "oauth", "desconocida"];
export const UMBRAL_VECTOR = 0.5;
export const UMBRAL_RERANK = 0.5; // provisional: calibrate with `npm run eval`
// Set to false to disable the reranker (e.g. if the eval shows Spanish regressing); rerank is then never called.
const RERANK_ENABLED = true;
const SIN = { coincidencias: [] as Resultado[], mensaje: "sin coincidencias fiables" };

export async function buscar(
  deps: SearchDeps,
  necesidad: string,
  filtros: Filtros = {},
  opts: { n?: number; max?: number; umbral?: number } = {},
): Promise<{ coincidencias: Resultado[]; mensaje?: string }> {
  // Filters run after the vector query; with a filter, fetch Vectorize's max topK (100 without
  // values/metadata) so filtered-out neighbours don't starve the results. 100 ids = D1's 100-param cap.
  const { n = filtros.tipo_conexion || filtros.auth ? 100 : 50, max = 10 } = opts;
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
  let umbral = opts.umbral ?? UMBRAL_VECTOR;
  let lista = out;
  const scores = out.length ? await rerankear(deps, q, out) : null;
  if (scores) {
    umbral = opts.umbral ?? UMBRAL_RERANK;
    lista = out.map((r, i) => ({ ...r, puntaje: scores[i] })).sort((a, b) => b.puntaje - a.puntaje);
  }
  if (!lista.length || lista[0].puntaje < umbral) return { ...SIN };
  return { coincidencias: lista.slice(0, max) };
}

// Scores for `out` (already sanitized, same text the user sees), or null => fall back to vector order. Never throws.
async function rerankear(deps: SearchDeps, q: string, out: Resultado[]): Promise<number[] | null> {
  if (!RERANK_ENABLED || !deps.rerank) return null;
  try {
    const s = await deps.rerank(q, out.map((r) => r.nombre + "\n" + r.funcion));
    return puntajesValidos(s, out.length) ? s : null;
  } catch {
    return null;
  }
}

// n finite scores in [0,1]. Plain loop so sparse-array holes (undefined) are rejected too.
export function puntajesValidos(s: unknown, n: number): s is number[] {
  if (!Array.isArray(s) || s.length !== n) return false;
  for (let i = 0; i < n; i++) if (typeof s[i] !== "number" || !(s[i] >= 0 && s[i] <= 1)) return false;
  return true;
}
