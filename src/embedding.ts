// Worker-safe (no Node imports): shared by the Worker, the ingestion, the eval and the experiment.
// Model: https://developers.cloudflare.com/workers-ai/models/embeddinggemma-300m/ — native 768 dims,
// trained for truncation (Matryoshka). Plain text for documents and queries (no task prefixes).
export const EMBED_MODEL = "@cf/google/embeddinggemma-300m";
export const EMBED_NATIVE_DIMS = 768;
// Dimension stored in Vectorize. The index MUST be created with exactly this many dimensions;
// changing it means recreating the index and reindexing (README, "Reindexar").
export const EMBED_DIMS = 128;
// Vectorize Free: 5,000,000 stored dimensions. 2% safety margin.
export const QUOTA_DIMS = 5_000_000;
export const MAX_VECTORS = Math.floor((QUOTA_DIMS * 0.98) / EMBED_DIMS);

// First d components, then L2-normalise (zero vector stays zero, never NaN).
export function truncateNormalize(v: ArrayLike<number>, d: number): Float32Array {
  const out = new Float32Array(d);
  let n = 0;
  for (let i = 0; i < d; i++) { out[i] = v[i]; n += out[i] * out[i]; }
  n = Math.sqrt(n);
  if (n > 0) for (let i = 0; i < d; i++) out[i] /= n;
  return out;
}

// One model vector -> the stored/queried vector. Fixed messages: never echo the data.
export function reducir(v: unknown): number[] {
  const malo = () => new Error(`embedding inválido: se esperaban ${EMBED_NATIVE_DIMS} números finitos`);
  if (!Array.isArray(v) || v.length !== EMBED_NATIVE_DIMS) throw malo();
  for (let i = 0; i < EMBED_NATIVE_DIMS; i++) if (typeof v[i] !== "number" || !Number.isFinite(v[i])) throw malo(); // holes read as undefined
  let n = 0;
  for (let i = 0; i < EMBED_DIMS; i++) n += v[i] * v[i];
  n = Math.sqrt(n);
  if (!(n > 0 && Number.isFinite(n))) throw new Error("embedding inválido: norma cero o no finita");
  return v.slice(0, EMBED_DIMS).map((x) => x / n);
}
