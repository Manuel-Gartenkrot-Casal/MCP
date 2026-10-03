// Shared by the Worker and eval/run.ts. Model: @cf/baai/bge-reranker-base.
export const sigmoid = (x: number) => 1 / (1 + Math.exp(-x));

// raw = the model output: a bare array or { response: [...] } of { id, score }, where id is the INDEX
// of the context in the request. Returns n scores in (0,1) aligned with the request order; throws on
// anything malformed (callers fall back to vector order). The docs say the raw score "can be mapped to
// [0,1] by a sigmoid", so we always apply it. UNVERIFIED: whether the real response is raw logits or
// already in [0,1] (a sigmoid over [0,1] would squash to [0.5,0.73]) until the first real call.
export function parseRerankResponse(raw: unknown, n: number): number[] {
  const arr = Array.isArray(raw) ? raw : (raw as any)?.response;
  if (!Array.isArray(arr) || arr.length !== n) throw new Error("rerank: forma inválida");
  const out: (number | undefined)[] = new Array(n).fill(undefined);
  for (const it of arr) {
    const id = it?.id, score = it?.score;
    if (!Number.isInteger(id) || id < 0 || id >= n || out[id] !== undefined) throw new Error("rerank: id inválido");
    if (typeof score !== "number" || !Number.isFinite(score)) throw new Error("rerank: score inválido");
    out[id] = sigmoid(score);
  }
  return out as number[];
}
