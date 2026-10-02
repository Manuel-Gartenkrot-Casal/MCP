import type { Entry } from "../types";

export function needsEmbedding(existingActualizado: string | undefined, entry: Entry): boolean {
  return existingActualizado === undefined || existingActualizado !== entry.actualizado;
}

export interface CatalogStore {
  getActualizados(ids: string[]): Promise<Map<string, string>>;
  upsertEntry(entry: Entry): Promise<void>;
}

// D1 limit: "Maximum bound parameters per query: 100"
// (https://developers.cloudflare.com/d1/platform/limits/)
const MAX_PARAMS = 100;

export function d1RestStore(
  cfg: { accountId: string; databaseId: string; token: string },
  fetchFn: typeof fetch = fetch,
): CatalogStore {
  const url = `https://api.cloudflare.com/client/v4/accounts/${cfg.accountId}/d1/database/${cfg.databaseId}/query`;

  async function query(sql: string, params: unknown[]): Promise<any[]> {
    const res = await fetchFn(url, {
      method: "POST",
      headers: { Authorization: `Bearer ${cfg.token}`, "Content-Type": "application/json" },
      body: JSON.stringify({ sql, params }),
    });
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
    async upsertEntry(e) {
      await query(
        `INSERT INTO entradas (id, nombre, descripcion, url_info, tipo_conexion, como_conectar, auth, incompleta, actualizado)
VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
ON CONFLICT(id) DO UPDATE SET nombre = excluded.nombre, descripcion = excluded.descripcion,
  url_info = excluded.url_info, tipo_conexion = excluded.tipo_conexion, como_conectar = excluded.como_conectar,
  auth = excluded.auth, incompleta = excluded.incompleta, actualizado = excluded.actualizado`,
        [e.id, e.nombre, e.descripcion, e.url_info, e.tipo_conexion, e.como_conectar, e.auth, e.incompleta ? 1 : 0, e.actualizado],
      );
    },
  };
}

// ---- Workers AI + Vectorize REST clients ----
// Docs: https://developers.cloudflare.com/workers-ai/models/bge-m3/ (POST /accounts/{id}/ai/run/@cf/baai/bge-m3, body {"text": [...]})
//       https://developers.cloudflare.com/api/resources/vectorize/subresources/indexes/methods/upsert/
//       (POST /accounts/{id}/vectorize/v2/indexes/{name}/upsert, application/x-ndjson, one {id, values} per line)
// 1024 is the BAAI model-card figure; NOT verified in Cloudflare docs. The first real run confirms it
// (embed throws on mismatch). The Vectorize index must be created with the same dimension.
export const EMBEDDING_DIMS = 1024;

const API = "https://api.cloudflare.com/client/v4/accounts";

async function cfCall(res: Response, what: string): Promise<any> {
  const body: any = await res.json().catch(() => ({}));
  if (!res.ok || body.success !== true) {
    const msg = [...(body.errors ?? []), ...(body.messages ?? [])].map((e: any) => e.message).join("; ");
    throw new Error(`${what} failed (HTTP ${res.status})${msg ? `: ${msg}` : ""}`);
  }
  return body;
}

export function embedWorkersAI(
  cfg: { accountId: string; token: string },
  fetchFn: typeof fetch = fetch,
): (text: string) => Promise<number[]> {
  return async (text) => {
    const res = await fetchFn(`${API}/${cfg.accountId}/ai/run/@cf/baai/bge-m3`, {
      method: "POST",
      headers: { Authorization: `Bearer ${cfg.token}`, "Content-Type": "application/json" },
      body: JSON.stringify({ text: [text] }),
    });
    const body = await cfCall(res, "Workers AI embed");
    const vec = body.result?.data?.[0];
    if (!Array.isArray(vec) || vec.length !== EMBEDDING_DIMS) {
      throw new Error(`Workers AI embed: expected ${EMBEDDING_DIMS} dims, got ${Array.isArray(vec) ? vec.length : "no vector"}`);
    }
    return vec;
  };
}

export function vectorizeUpsert(
  cfg: { accountId: string; index: string; token: string },
  fetchFn: typeof fetch = fetch,
): (id: string, vec: number[]) => Promise<void> {
  return async (id, vec) => {
    const res = await fetchFn(`${API}/${cfg.accountId}/vectorize/v2/indexes/${encodeURIComponent(cfg.index)}/upsert`, {
      method: "POST",
      headers: { Authorization: `Bearer ${cfg.token}`, "Content-Type": "application/x-ndjson" },
      body: JSON.stringify({ id, values: vec }) + "\n",
    });
    await cfCall(res, "Vectorize upsert");
  };
}
