import type { Entry } from "../types";
import type { Case } from "../../eval/evaluate";
import { fetchRetry } from "../ingest/cloudflare";
import { rankEntries, MAX_VECTORS } from "../ingest/run";
import { truncateNormalize, evaluar, renderMarkdown, type Reporte } from "./metricas";

type Sleep = (ms: number) => Promise<void>;
const API = "https://api.cloudflare.com/client/v4/accounts";

export interface Config {
  nombre: string; modelo: string; dimsNativas: number; batch: number;
  dims: number[]; // truncation sizes to evaluate
  doc(e: Entry): string; query(necesidad: string): string;
}

// gemma prompt format recommended by Google for retrieval (model card).
export const CONFIGS: Config[] = [
  { nombre: "bge-m3", modelo: "@cf/baai/bge-m3", dimsNativas: 1024, batch: 50, dims: [1024],
    doc: (e) => `${e.nombre}\n${e.descripcion}`, query: (q) => q },
  { nombre: "gemma-plain", modelo: "@cf/google/embeddinggemma-300m", dimsNativas: 768, batch: 25, dims: [768, 512, 256, 192, 128],
    doc: (e) => `${e.nombre}\n${e.descripcion}`, query: (q) => q },
  { nombre: "gemma-prompt", modelo: "@cf/google/embeddinggemma-300m", dimsNativas: 768, batch: 25, dims: [768, 512, 256, 192, 128],
    doc: (e) => `title: ${e.nombre} | text: ${e.descripcion}`, query: (q) => `task: search result | query: ${q}` },
];

export type Modo = "top" | "todos";

// Same eligibility as the ingest (ids over 64 bytes dropped); "top" keeps what production indexes.
export function seleccionarDocs(all: Entry[], modo: Modo, max = MAX_VECTORS): Entry[] {
  const enc = new TextEncoder();
  const ok = all.filter((e) => enc.encode(e.id).length <= 64);
  return modo === "todos" ? ok : rankEntries(ok).slice(0, max);
}

// Full mode: only gemma-plain (bge-m3 baseline comes from the 4,500-doc run); docs are embedded once and truncated per dim.
export const configsPara = (modo: Modo): Config[] =>
  modo === "todos" ? [{ ...CONFIGS[1], dims: [768, 256, 192, 128, 96] }] : CONFIGS;

// POST /accounts/{id}/ai/run/{model}, body {text: string[]}; result.data = vectors, result.usage.neurons (optional).
// Concurrency 1. A 4xx on a multi-text batch (limits undocumented) splits it in halves once.
export async function embedModelo(
  cfg: { accountId: string; token: string }, modelo: string, dims: number, texts: string[], batch: number,
  fetchFn: typeof fetch, sleep: Sleep, log: (m: string) => void, cada = 10,
): Promise<{ vecs: number[][]; neuronas: number | null }> {
  let neuronas: number | null = null;
  async function one(chunk: string[], canSplit: boolean): Promise<number[][]> {
    const res = await fetchRetry(fetchFn, `${API}/${cfg.accountId}/ai/run/${modelo}`, {
      method: "POST",
      headers: { Authorization: `Bearer ${cfg.token}`, "Content-Type": "application/json" },
      body: JSON.stringify({ text: chunk }),
    }, sleep);
    const body: any = await res.json().catch(() => ({}));
    if (!res.ok || body.success !== true) {
      if (canSplit && chunk.length > 1 && res.status >= 400 && res.status < 500) {
        const h = chunk.length >> 1;
        return [...(await one(chunk.slice(0, h), false)), ...(await one(chunk.slice(h), false))];
      }
      const msg = (body.errors ?? []).map((e: any) => e.message).join("; ");
      throw new Error(`Workers AI ${modelo} failed (HTTP ${res.status})${msg ? `: ${msg}` : ""}`);
    }
    const data = body.result?.data;
    if (!Array.isArray(data) || data.length !== chunk.length)
      throw new Error(`Workers AI ${modelo}: expected ${chunk.length} vectors, got ${Array.isArray(data) ? data.length : "no vectors"}`);
    for (const v of data)
      if (!Array.isArray(v) || v.length !== dims) throw new Error(`Workers AI ${modelo}: expected ${dims} dims, got ${Array.isArray(v) ? v.length : "no vector"}`);
    const n = body.result?.usage?.neurons;
    if (typeof n === "number") neuronas = (neuronas ?? 0) + n;
    return data;
  }
  const vecs: number[][] = [];
  const total = Math.ceil(texts.length / batch);
  for (let i = 0, b = 1; i < texts.length; i += batch, b++) {
    try {
      vecs.push(...(await one(texts.slice(i, i + batch), true)));
    } catch (e) {
      throw new Error(`lote ${b}/${total}: ${e instanceof Error ? e.message : String(e)}`);
    }
    if (b % cada === 0 || b === total) log(`${modelo}: lote ${b}/${total}`);
  }
  return { vecs, neuronas };
}

export async function runExperimento(a: {
  accountId: string; token: string; fetchFn?: typeof fetch; sleep?: Sleep;
  entries: Entry[]; cases: Case[]; configs?: Config[]; modo?: Modo; log?: (m: string) => void; ahora?: () => Date;
}): Promise<{ reporte: Reporte; json: string; md: string }> {
  const fetchFn = a.fetchFn ?? fetch;
  const sleep = a.sleep ?? ((ms) => new Promise((r) => setTimeout(r, ms)));
  const log = a.log ?? (() => {});
  const cfg = { accountId: a.accountId, token: a.token };
  const cada = a.modo === "todos" ? 20 : 10;
  const ids = a.entries.map((e) => e.id);
  const reporte: Reporte = { modo: a.modo === "todos" ? "completo" : "experimento", fecha: (a.ahora ?? (() => new Date()))().toISOString(), documentos: a.entries.length, consultas: a.cases.length, configs: [] };
  for (const c of a.configs ?? configsPara(a.modo ?? "top")) {
    log(`config ${c.nombre}: embebiendo ${a.entries.length} documentos`);
    const d = await embedModelo(cfg, c.modelo, c.dimsNativas, a.entries.map(c.doc), c.batch, fetchFn, sleep, log, cada);
    const q = await embedModelo(cfg, c.modelo, c.dimsNativas, a.cases.map((k) => c.query(k.necesidad)), c.batch, fetchFn, sleep, log, cada);
    const resultados = c.dims.map((dim) => ({
      dim,
      ...evaluar(a.cases, q.vecs.map((v) => truncateNormalize(v, dim)), d.vecs.map((v) => truncateNormalize(v, dim)), ids),
    }));
    const n = d.neuronas === null && q.neuronas === null ? null : (d.neuronas ?? 0) + (q.neuronas ?? 0);
    reporte.configs.push({ nombre: c.nombre, modelo: c.modelo, dimsNativas: c.dimsNativas, neuronas: n, resultados });
  }
  return { reporte, json: JSON.stringify(reporte, null, 2), md: renderMarkdown(reporte) };
}
