import type { Entry } from "../types";
import { fetchRegistry } from "./registry";
import {
  needsEmbedding, d1RestStore, embedWorkersAI, vectorizeUpsert, type CatalogStore,
} from "./cloudflare";

// Vectorize Free holds ~4,880 vectors at 1024 dims; leave headroom.
export const MAX_VECTORS = 4500;

export interface IngestDeps {
  fetchEntries(): Promise<Entry[]>;
  store: CatalogStore;
  embed(text: string): Promise<number[]>;
  upsertVector(id: string, vec: number[]): Promise<void>;
  log(msg: string): void;
  maxVectors?: number;
}

// Best first: remote, has url_info, description >= 40 chars, newest, then id.
export function rankEntries(entries: Entry[]): Entry[] {
  const score = (e: Entry) =>
    (e.tipo_conexion === "remoto" ? 4 : 0) + (e.url_info ? 2 : 0) + (e.descripcion.length >= 40 ? 1 : 0);
  return [...entries].sort(
    (a, b) =>
      score(b) - score(a) ||
      (a.actualizado === b.actualizado ? 0 : a.actualizado < b.actualizado ? 1 : -1) ||
      (a.id < b.id ? -1 : a.id > b.id ? 1 : 0),
  );
}

export async function runIngest(
  deps: IngestDeps,
): Promise<{ nuevas: number; omitidas: number; fallidas: number; fuera_de_cupo: number }> {
  const all = await deps.fetchEntries(); // throws => nothing written
  const max = deps.maxVectors ?? MAX_VECTORS;
  const ranked = rankEntries(all);
  const kept = ranked.slice(0, max);
  const fuera_de_cupo = ranked.length - kept.length;
  const existing = await deps.store.getActualizados(kept.map((e) => e.id));
  let nuevas = 0, omitidas = 0, fallidas = 0;
  for (const e of kept) {
    if (!needsEmbedding(existing.get(e.id), e)) { omitidas++; continue; }
    try {
      const vec = await deps.embed(`${e.nombre}\n${e.descripcion}`);
      await deps.upsertVector(e.id, vec);
      await deps.store.upsertEntry(e);
      nuevas++;
    } catch (err) {
      fallidas++;
      deps.log(`fallo ${e.id}: ${err instanceof Error ? err.message : String(err)}`);
    }
  }
  deps.log(`ingesta: nuevas=${nuevas} omitidas=${omitidas} fallidas=${fallidas} fuera_de_cupo=${fuera_de_cupo}`);
  return { nuevas, omitidas, fallidas, fuera_de_cupo };
}

function env(name: string): string {
  const v = process.env[name];
  if (!v) throw new Error(`Falta la variable de entorno ${name}`);
  return v;
}

export async function main(): Promise<void> {
  const accountId = env("CF_ACCOUNT_ID");
  const token = env("CF_API_TOKEN");
  const databaseId = env("CF_D1_DATABASE_ID");
  const index = env("CF_VECTORIZE_INDEX");
  await runIngest({
    fetchEntries: () => fetchRegistry(),
    store: d1RestStore({ accountId, databaseId, token }),
    embed: embedWorkersAI({ accountId, token }),
    upsertVector: vectorizeUpsert({ accountId, index, token }),
    log: (m) => console.log(m),
  });
}

import { pathToFileURL } from "node:url";
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((e) => { console.error(e instanceof Error ? e.message : e); process.exit(1); });
}
