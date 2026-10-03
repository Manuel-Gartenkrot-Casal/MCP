import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { pathToFileURL, fileURLToPath } from "node:url";
import { buscar, type SearchDeps } from "../src/search/buscar";
import type { Entry } from "../src/types";
import { embedWorkersAI } from "../src/ingest/cloudflare";
import { parseRerankResponse } from "../src/search/rerank";
import { evaluarModos, formatComparacion, type Case, type Hit } from "./evaluate";

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

// Docs: https://developers.cloudflare.com/workers-ai/models/bge-reranker-base/
// POST /accounts/{id}/ai/run/@cf/baai/bge-reranker-base, body {query, contexts:[{text}]}; REST wraps the model output in `result`.
// Same sigmoid/shape handling as the Worker (parseRerankResponse); the raw-vs-[0,1] shape is UNVERIFIED until the first real run.
export function rerankWorkersAI(cfg: { accountId: string; token: string }, fetchFn: typeof fetch = fetch): NonNullable<SearchDeps["rerank"]> {
  return async (query, textos) => {
    const res = await fetchFn(`${API}/${cfg.accountId}/ai/run/@cf/baai/bge-reranker-base`, {
      method: "POST",
      headers: { Authorization: `Bearer ${cfg.token}`, "Content-Type": "application/json" },
      body: JSON.stringify({ query, contexts: textos.map((text) => ({ text })) }),
    });
    const body: any = await res.json().catch(() => ({}));
    if (!res.ok || body.success !== true) throw new Error(`Rerank failed (HTTP ${res.status})`);
    return parseRerankResponse(body.result, textos.length);
  };
}

interface CollectDeps {
  embed: SearchDeps["embed"];
  getEntries: SearchDeps["getEntries"];
  query: (v: number[], n: number) => Promise<Hit[]>;
  rerank: NonNullable<SearchDeps["rerank"]>;
}

// Runs buscar twice for one case sharing the same raw hits and D1 reads: once without rerank (vector hits),
// once with it. Reranked hits = the surviving candidates (same order buscar builds) with their rerank scores.
// A failed rerank throws: buscar would silently fall back and the "reranked" column would be vector order.
export async function collect(d: CollectDeps, necesidad: string): Promise<{ vector: Hit[]; reranked: Hit[] }> {
  let vector: Hit[] = [];
  let entries: Entry[] = [];
  const base: SearchDeps = {
    embed: d.embed,
    nearest: async (v, n) => (vector = await d.query(v, n)),
    getEntries: async (ids) => (entries = await d.getEntries(ids)),
  };
  const opts = { umbral: 0, n: 50 };
  await buscar(base, necesidad, {}, opts);
  let scores: number[] | null = null;
  await buscar(
    { ...base, nearest: async () => vector, getEntries: async () => entries,
      rerank: async (q, t) => (scores = await d.rerank(q, t)) },
    necesidad, {}, opts,
  );
  const have = new Set(entries.map((e) => e.id));
  const ids = [...vector].sort((a, b) => b.score - a.score).filter((h) => have.has(h.id)).map((h) => h.id);
  if (ids.length && (!scores || (scores as number[]).length !== ids.length)) throw new Error("rerank falló para una consulta del eval");
  return { vector, reranked: ids.map((id, i) => ({ id, score: (scores as unknown as number[])[i] })).sort((a, b) => b.score - a.score) };
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
  const rerank = rerankWorkersAI({ accountId, token });
  const vector: Hit[][] = [], reranked: Hit[][] = [];
  for (const c of cases) {
    const r = await collect({ embed, getEntries, query, rerank }, c.necesidad);
    vector.push(r.vector);
    reranked.push(r.reranked);
  }
  // Which esperado ids are in D1 at all (parametrized, chunked <= 100 ids): tells "not indexed" from "ranked low".
  const esperados = [...new Set(cases.flatMap((c) => (c.esperado ? [c.esperado] : [])))];
  const indexados = new Set((await getEntries(esperados)).map((e) => e.id));
  console.log(formatComparacion(evaluarModos(cases, vector, reranked, indexados)));
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((e) => { console.error(e instanceof Error ? e.message : e); process.exit(1); });
}
