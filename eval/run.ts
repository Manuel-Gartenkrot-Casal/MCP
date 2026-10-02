import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { pathToFileURL, fileURLToPath } from "node:url";
import { buscar, type SearchDeps } from "../src/search/buscar";
import { embedWorkersAI } from "../src/ingest/cloudflare";
import { evaluate, formatReport, type Case, type Hit } from "./evaluate";

const API = "https://api.cloudflare.com/client/v4/accounts";

function env(name: string): string {
  const v = process.env[name];
  if (!v) throw new Error(`Falta la variable de entorno ${name}`);
  return v;
}

// Docs: https://developers.cloudflare.com/api/resources/vectorize/subresources/indexes/methods/query/
// POST /accounts/{id}/vectorize/v2/indexes/{name}/query, body {vector, topK}; response result.matches[{id, score}].
export function vectorizeQuery(cfg: { accountId: string; index: string; token: string }, fetchFn: typeof fetch = fetch) {
  return async (vector: number[], topK: number): Promise<Hit[]> => {
    const res = await fetchFn(`${API}/${cfg.accountId}/vectorize/v2/indexes/${encodeURIComponent(cfg.index)}/query`, {
      method: "POST",
      headers: { Authorization: `Bearer ${cfg.token}`, "Content-Type": "application/json" },
      body: JSON.stringify({ vector, topK, returnValues: false, returnMetadata: "none" }),
    });
    const body: any = await res.json().catch(() => ({}));
    if (!res.ok || body.success !== true) throw new Error(`Vectorize query failed (HTTP ${res.status})`);
    return (body.result?.matches ?? []).map((m: any) => ({ id: m.id, score: m.score }));
  };
}

// D1 REST read (same endpoint/shape as d1RestStore; ids chunked under D1's 100-parameter limit).
function d1GetEntries(cfg: { accountId: string; databaseId: string; token: string }): SearchDeps["getEntries"] {
  const url = `${API}/${cfg.accountId}/d1/database/${cfg.databaseId}/query`;
  return async (ids) => {
    const out: any[] = [];
    for (let i = 0; i < ids.length; i += 100) {
      const chunk = ids.slice(i, i + 100);
      const res = await fetch(url, {
        method: "POST",
        headers: { Authorization: `Bearer ${cfg.token}`, "Content-Type": "application/json" },
        body: JSON.stringify({ sql: `SELECT * FROM entradas WHERE id IN (${chunk.map(() => "?").join(",")})`, params: chunk }),
      });
      const body: any = await res.json().catch(() => ({}));
      if (!res.ok || body.success !== true) throw new Error(`D1 query failed (HTTP ${res.status})`);
      for (const r of body.result?.[0]?.results ?? []) out.push({ ...r, incompleta: !!r.incompleta });
    }
    return out;
  };
}

export async function main(): Promise<void> {
  const accountId = env("CF_ACCOUNT_ID"), token = env("CF_API_TOKEN");
  const databaseId = env("CF_D1_DATABASE_ID"), index = env("CF_VECTORIZE_INDEX");
  const query = vectorizeQuery({ accountId, index, token });
  const embedBatch = embedWorkersAI({ accountId, token });
  const embed = async (t: string) => (await embedBatch([t]))[0];
  const getEntries = d1GetEntries({ accountId, databaseId, token });
  const cases: Case[] = JSON.parse(readFileSync(join(dirname(fileURLToPath(import.meta.url)), "casos.json"), "utf8"));
  const results: Hit[][] = [];
  for (const c of cases) {
    let hits: Hit[] = [];
    // buscar drops ids, so capture the raw hits; umbral 0 keeps every score visible.
    await buscar(
      { embed, getEntries, nearest: async (v, n) => (hits = await query(v, n)) },
      c.necesidad, {}, { umbral: 0, n: 20 },
    );
    results.push(hits);
  }
  console.log(formatReport(evaluate(cases, results)));
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((e) => { console.error(e instanceof Error ? e.message : e); process.exit(1); });
}
