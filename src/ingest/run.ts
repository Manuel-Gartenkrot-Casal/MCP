import type { Entry } from "../types";
import { fetchRegistry } from "./registry";
import {
  needsEmbedding, d1RestStore, embedWorkersAI, vectorizeUpsert, vectorizeDelete, type CatalogStore,
} from "./cloudflare";

// Vectorize Free holds ~4,880 vectors at 1024 dims; leave headroom.
export const MAX_VECTORS = 4500;
const MAX_ID_BYTES = 64;
// Entries per batch: one Workers AI call, one Vectorize upsert, ceil(50/11) D1 inserts.
// ~4,500 entries => ~630 REST calls on a first run, under Cloudflare's 1,200 / 5 min.
const BATCH = 50;

export interface IngestDeps {
  fetchEntries(): Promise<Entry[]>;
  store: CatalogStore;
  embedBatch(texts: string[]): Promise<number[][]>;
  upsertVectors(items: { id: string; values: number[] }[]): Promise<void>;
  deleteVectors(ids: string[]): Promise<void>;
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
): Promise<{ nuevas: number; omitidas: number; fallidas: number; fuera_de_cupo: number; podadas: number }> {
  const all = await deps.fetchEntries(); // throws => nothing written
  const max = deps.maxVectors ?? MAX_VECTORS;
  // Vectorize ids are capped at 64 bytes (https://developers.cloudflare.com/vectorize/platform/limits/).
  const enc = new TextEncoder();
  const valid = all.filter((e) => enc.encode(e.id).length <= MAX_ID_BYTES);
  if (valid.length < all.length) deps.log(`excluidas ${all.length - valid.length} entradas con id de más de ${MAX_ID_BYTES} bytes`);
  const ranked = rankEntries(valid);
  const kept = ranked.slice(0, max);
  let fuera_de_cupo = ranked.length - kept.length;

  // Prune what dropped out of the cap (stored - kept) before upserting, so Vectorize never holds
  // more than `max`. Vectors first, then rows: a failure throws and leaves rows to retry next run.
  // Guard: a tiny/empty registry response (garbled fetch) must not wipe the index.
  const stored = await deps.store.listIds();
  let podadas = 0;
  const keptIds = new Set(kept.map((e) => e.id));
  const stale = stored.filter((id) => !keptIds.has(id));
  // Second guard: a partial fetch that passed the raw-count guard must not delete most of the index.
  const pruneSkipped = all.length === 0 || all.length < stored.length * 0.5 || stale.length > stored.length * 0.5;
  if (pruneSkipped) {
    deps.log(`aviso: registro con ${all.length} entradas, ${stale.length} de ${stored.length} almacenadas quedarían obsoletas; se omite la poda`);
  } else if (stale.length) {
    await deps.deleteVectors(stale);
    await deps.store.deleteIds(stale);
    podadas = stale.length;
  }

  const existing = await deps.store.getActualizados(kept.map((e) => e.id));
  let todo = kept.filter((e) => needsEmbedding(existing.get(e.id), e));
  const omitidas = kept.length - todo.length;
  if (pruneSkipped) {
    // Nothing was pruned, so stored + new entries must still fit in the index.
    let room = Math.max(0, max - stored.length);
    const fit = todo.filter((e) => existing.has(e.id) || room-- > 0);
    if (fit.length < todo.length) {
      deps.log(`aviso: ${todo.length - fit.length} entradas nuevas fuera de cupo (sin poda, máximo ${max})`);
      fuera_de_cupo += todo.length - fit.length;
      todo = fit;
    }
  }
  let nuevas = 0, fallidas = 0;
  for (let i = 0; i < todo.length; i += BATCH) {
    const batch = todo.slice(i, i + BATCH);
    try {
      const vecs = await deps.embedBatch(batch.map((e) => `${e.nombre}\n${e.descripcion}`));
      await deps.upsertVectors(batch.map((e, j) => ({ id: e.id, values: vecs[j] })));
      await deps.store.upsertEntries(batch); // rows only after their vectors are stored
      nuevas += batch.length;
    } catch (err) {
      fallidas += batch.length; // whole batch retried next run
      deps.log(`fallo lote de ${batch.length} (desde ${batch[0].id}): ${err instanceof Error ? err.message : String(err)}`);
    }
  }
  deps.log(`ingesta: nuevas=${nuevas} omitidas=${omitidas} fallidas=${fallidas} fuera_de_cupo=${fuera_de_cupo} podadas=${podadas}`);
  return { nuevas, omitidas, fallidas, fuera_de_cupo, podadas };
}

// Scheduled runs must show up as failed when any entry could not be stored.
export const exitCodeFor = (r: { fallidas: number }): number => (r.fallidas > 0 ? 1 : 0);

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
  const r = await runIngest({
    fetchEntries: () => fetchRegistry(),
    store: d1RestStore({ accountId, databaseId, token }),
    embedBatch: embedWorkersAI({ accountId, token }),
    upsertVectors: vectorizeUpsert({ accountId, index, token }),
    deleteVectors: vectorizeDelete({ accountId, index, token }),
    log: (m) => console.log(m),
  });
  process.exitCode = exitCodeFor(r); // counts already logged by runIngest
}

import { pathToFileURL } from "node:url";
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((e) => { console.error(e instanceof Error ? e.message : e); process.exit(1); });
}
