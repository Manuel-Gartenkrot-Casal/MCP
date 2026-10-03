// Shared by the Worker and eval/run.ts. Model: @cf/baai/bge-reranker-base.

// raw = the model output: a bare array, { response: [...] } or the REST body's { result: { response: [...] } },
// of { id, score } where id is the INDEX of the context in the request and score is already a probability in [0,1].
// Shape verified by probing the REST endpoint live on 2026-10-02: { result: { response: [{id, score}, ...] } },
// sorted by score descending (not input order), relevant ~0.95-0.999, irrelevant ~0.00004. Whether the Worker's
// env.AI binding returns the same bare/{response} shape without `result` is still unverified (por verificar);
// the three forms are accepted. Returns n scores aligned with the request order; throws on anything malformed
// (missing/duplicate/out-of-range ids, non-finite or outside [0,1] scores) so callers fall back to vector order.
export function parseRerankResponse(raw: unknown, n: number): number[] {
  const r: any = raw;
  const arr = Array.isArray(r) ? r : Array.isArray(r?.response) ? r.response : r?.result?.response;
  if (!Array.isArray(arr) || arr.length !== n) throw new Error("rerank: forma inválida");
  const out: (number | undefined)[] = new Array(n).fill(undefined);
  for (let i = 0; i < n; i++) { // plain loop: sparse-array holes arrive as undefined and are rejected
    const it: any = arr[i], id = it?.id, score = it?.score;
    if (!Number.isInteger(id) || id < 0 || id >= n || out[id] !== undefined) throw new Error("rerank: id inválido");
    if (typeof score !== "number" || !(score >= 0 && score <= 1)) throw new Error("rerank: score inválido");
    out[id] = score;
  }
  return out as number[];
}
