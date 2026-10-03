import type { Entry } from "../types";
import { EMBED_MODEL, reducir } from "../embedding";

export function needsEmbedding(existingActualizado: string | undefined, entry: Entry): boolean {
  return existingActualizado === undefined || existingActualizado !== entry.actualizado;
}

export interface CatalogStore {
  getActualizados(ids: string[]): Promise<Map<string, string>>;
  upsertEntries(entries: Entry[]): Promise<void>;
  listIds(): Promise<string[]>;
  deleteIds(ids: string[]): Promise<void>;
}

type Sleep = (ms: number) => Promise<void>;
const wait: Sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const RETRIES = 3;
const MAX_RETRY_AFTER_S = 300;
const RATE_LIMIT_WAIT_S = 60; // 429 without a usable Retry-After: the 1,200 / 5 min window needs more than seconds

// Retries 429 and 5xx up to RETRIES times: Retry-After (seconds, capped) when present; else 60 s for a 429
// and 1s, 2s, 4s for a 5xx.
// Cloudflare API limit: 1,200 requests / 5 min per user; a 429 carries retry-after
// (https://developers.cloudflare.com/fundamentals/api/reference/limits/).
export async function fetchRetry(fetchFn: typeof fetch, url: string, init: RequestInit, sleep: Sleep): Promise<Response> {
  for (let i = 0; ; i++) {
    const res = await fetchFn(url, init);
    if (i >= RETRIES || (res.status !== 429 && res.status < 500)) return res;
    await res.body?.cancel().catch(() => {});
    const ra = Number(res.headers.get("retry-after"));
    await sleep(ra > 0 ? Math.min(ra, MAX_RETRY_AFTER_S) * 1000 : res.status === 429 ? RATE_LIMIT_WAIT_S * 1000 : 1000 * 2 ** i);
  }
}

// D1 limit: "Maximum bound parameters per query: 100"
// (https://developers.cloudflare.com/d1/platform/limits/)
const MAX_PARAMS = 100;
const ROWS_PER_INSERT = Math.floor(MAX_PARAMS / 9); // 9 columns => 11 rows, 99 params

export function d1RestStore(
  cfg: { accountId: string; databaseId: string; token: string },
  fetchFn: typeof fetch = fetch,
  sleep: Sleep = wait,
): CatalogStore {
  const url = `https://api.cloudflare.com/client/v4/accounts/${cfg.accountId}/d1/database/${cfg.databaseId}/query`;

  async function query(sql: string, params: unknown[]): Promise<any[]> {
    const res = await fetchRetry(fetchFn, url, {
      method: "POST",
      headers: { Authorization: `Bearer ${cfg.token}`, "Content-Type": "application/json" },
      body: JSON.stringify({ sql, params }),
    }, sleep);
    const body: any = await res.json().catch(() => ({}));
    if (!res.ok || body.success !== true || body.result?.[0]?.success === false) {
      const msg = (body.errors ?? []).map((e: any) => e.message).join("; ");
      throw new Error(`D1 query failed (HTTP ${res.status})${msg ? `: ${msg}` : ""}`);
    }
    return body.result?.[0]?.results ?? [];
  }

  return {
    async getActualizados(ids) {
      const out = new Map<string, string>();
      for (let i = 0; i < ids.length; i += MAX_PARAMS) {
        const chunk = ids.slice(i, i + MAX_PARAMS);
        const rows = await query(
          `SELECT id, actualizado FROM entradas WHERE id IN (${chunk.map(() => "?").join(",")})`,
          chunk,
        );
        for (const r of rows) out.set(r.id, r.actualizado);
      }
      return out;
    },
    async upsertEntries(es) {
      for (let i = 0; i < es.length; i += ROWS_PER_INSERT) {
        const chunk = es.slice(i, i + ROWS_PER_INSERT);
        await query(
          `INSERT INTO entradas (id, nombre, descripcion, url_info, tipo_conexion, como_conectar, auth, incompleta, actualizado)
VALUES ${chunk.map(() => "(?, ?, ?, ?, ?, ?, ?, ?, ?)").join(", ")}
ON CONFLICT(id) DO UPDATE SET nombre = excluded.nombre, descripcion = excluded.descripcion,
  url_info = excluded.url_info, tipo_conexion = excluded.tipo_conexion, como_conectar = excluded.como_conectar,
  auth = excluded.auth, incompleta = excluded.incompleta, actualizado = excluded.actualizado`,
          chunk.flatMap((e) => [e.id, e.nombre, e.descripcion, e.url_info, e.tipo_conexion, e.como_conectar, e.auth, e.incompleta ? 1 : 0, e.actualizado]),
        );
      }
    },
    async listIds() {
      return (await query("SELECT id FROM entradas", [])).map((r) => r.id);
    },
    async deleteIds(ids) {
      for (let i = 0; i < ids.length; i += MAX_PARAMS) {
        const chunk = ids.slice(i, i + MAX_PARAMS);
        await query(`DELETE FROM entradas WHERE id IN (${chunk.map(() => "?").join(",")})`, chunk);
      }
    },
  };
}

// ---- Workers AI + Vectorize REST clients ----
// Docs: https://developers.cloudflare.com/workers-ai/models/embeddinggemma-300m/ (POST /accounts/{id}/ai/run/{EMBED_MODEL},
//       body {"text": [...]}, result.data = one 768-dim vector per input; shape proven by the embedding experiment)
//       https://developers.cloudflare.com/api/resources/vectorize/subresources/indexes/methods/upsert/
//       (POST /accounts/{id}/vectorize/v2/indexes/{name}/upsert, application/x-ndjson, one {id, values} per line)
// The Vectorize index must be created with EMBED_DIMS dimensions.
const API = "https://api.cloudflare.com/client/v4/accounts";

async function cfCall(res: Response, what: string): Promise<any> {
  const body: any = await res.json().catch(() => ({}));
  if (!res.ok || body.success !== true) {
    const msg = [...(body.errors ?? []), ...(body.messages ?? [])].map((e: any) => e.message).join("; ");
    throw new Error(`${what} failed (HTTP ${res.status})${msg ? `: ${msg}` : ""}`);
  }
  return body;
}

// One call embeds every text; result.data must hold one vector per input, each reduced to EMBED_DIMS (else throw).
export function embedWorkersAI(
  cfg: { accountId: string; token: string },
  fetchFn: typeof fetch = fetch,
  sleep: Sleep = wait,
): (texts: string[]) => Promise<number[][]> {
  return async (texts) => {
    const res = await fetchRetry(fetchFn, `${API}/${cfg.accountId}/ai/run/${EMBED_MODEL}`, {
      method: "POST",
      headers: { Authorization: `Bearer ${cfg.token}`, "Content-Type": "application/json" },
      body: JSON.stringify({ text: texts }),
    }, sleep);
    const body = await cfCall(res, "Workers AI embed");
    const data = body.result?.data;
    if (!Array.isArray(data) || data.length !== texts.length) {
      throw new Error(`Workers AI embed: expected ${texts.length} vectors, got ${Array.isArray(data) ? data.length : "no vectors"}`);
    }
    return data.map(reducir);
  };
}

// One request, one NDJSON line per vector (HTTP API batch limit 5,000 vectors / 100 MB,
// https://developers.cloudflare.com/vectorize/platform/limits/); runIngest sends <= 25.
export function vectorizeUpsert(
  cfg: { accountId: string; index: string; token: string },
  fetchFn: typeof fetch = fetch,
  sleep: Sleep = wait,
): (items: { id: string; values: number[] }[]) => Promise<void> {
  return async (items) => {
    const res = await fetchRetry(fetchFn, `${API}/${cfg.accountId}/vectorize/v2/indexes/${encodeURIComponent(cfg.index)}/upsert`, {
      method: "POST",
      headers: { Authorization: `Bearer ${cfg.token}`, "Content-Type": "application/x-ndjson" },
      body: items.map(({ id, values }) => JSON.stringify({ id, values }) + "\n").join(""),
    }, sleep);
    await cfCall(res, "Vectorize upsert");
  };
}

// POST /accounts/{id}/vectorize/v2/indexes/{name}/delete_by_ids, JSON body {"ids": [...]}
// (https://developers.cloudflare.com/api/resources/vectorize/subresources/indexes/methods/delete_by_ids/).
// No per-request id limit is documented; 100 per request is a conservative choice.
const DELETE_BATCH = 100;

export function vectorizeDelete(
  cfg: { accountId: string; index: string; token: string },
  fetchFn: typeof fetch = fetch,
  sleep: Sleep = wait,
): (ids: string[]) => Promise<void> {
  return async (ids) => {
    for (let i = 0; i < ids.length; i += DELETE_BATCH) {
      const res = await fetchRetry(fetchFn, `${API}/${cfg.accountId}/vectorize/v2/indexes/${encodeURIComponent(cfg.index)}/delete_by_ids`, {
        method: "POST",
        headers: { Authorization: `Bearer ${cfg.token}`, "Content-Type": "application/json" },
        body: JSON.stringify({ ids: ids.slice(i, i + DELETE_BATCH) }),
      }, sleep);
      await cfCall(res, "Vectorize delete");
    }
  };
}
