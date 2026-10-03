import { describe, it, expect } from "vitest";
import { truncateNormalize, cosineScores, evaluar, renderMarkdown, type Reporte } from "../../src/experimento/metricas";

const norm = (v: ArrayLike<number>) => Math.sqrt(Array.from(v).reduce((s, x) => s + x * x, 0));

describe("truncateNormalize", () => {
  it("recorta a d componentes y deja norma 1", () => {
    const out = truncateNormalize([3, 4, 12, 0], 2);
    expect(out).toHaveLength(2);
    expect(norm(out)).toBeCloseTo(1, 6);
    expect(out[0]).toBeCloseTo(0.6, 6);
  });
  it("sin recorte (d = longitud) solo normaliza", () => {
    const out = truncateNormalize([2, 0], 2);
    expect(Array.from(out)).toEqual([1, 0]);
  });
  it("vector nulo no produce NaN", () => {
    expect(Array.from(truncateNormalize([0, 0, 1], 2))).toEqual([0, 0]);
  });
});

describe("cosineScores", () => {
  it("producto punto de vectores normalizados, en orden de docs", () => {
    const docs = [[1, 0], [0, 1], [0.6, 0.8]].map((v) => Float32Array.from(v));
    const s = cosineScores(Float32Array.from([1, 0]), docs);
    expect(s[0]).toBeCloseTo(1, 6);
    expect(s[1]).toBeCloseTo(0, 6);
    expect(s[2]).toBeCloseTo(0.6, 6);
  });
});

// 3 docs en 2D; consultas apuntan a cada doc.
const ids = ["a", "b", "c"];
const docs = [[1, 0], [0.8, 0.6], [0, 1]].map((v) => Float32Array.from(v));
const cases = [
  { necesidad: "q1", esperado: "a", idioma: "es" as const },
  { necesidad: "q2", esperado: "b", idioma: "en" as const },   // q2 se parece más a a que a b => rank 2
  { necesidad: "q3", esperado: "zzz", idioma: "en" as const }, // no indexado => rank null
  { necesidad: "absurda", esperado: null },
];
const qs = [[1, 0], [0.95, 0.31], [0, 1], [0.6, -0.8]].map((v) => truncateNormalize(v, 2));

const r = evaluar(cases, qs, docs, ids);
describe("evaluar", () => {
  it("rank 1-based del esperado; null si no está indexado", () => {
    expect(r.casos.map((c) => c.rank)).toEqual([1, 2, null]);
  });
  it("mejor score y score del esperado", () => {
    expect(r.casos[0].mejor).toBeCloseTo(1, 5);
    expect(r.casos[0].scoreEsperado).toBeCloseTo(1, 5);
    expect(r.casos[2].scoreEsperado).toBeNull();
  });
  it("hit@5, hit@10, MRR sobre reales (null cuenta 0)", () => {
    expect(r.resumen.reales).toBe(3);
    expect(r.resumen.top5).toBe(2);
    expect(r.resumen.top10).toBe(2);
    expect(r.resumen.mrr).toBeCloseTo((1 + 0.5 + 0) / 3, 6);
  });
  it("desglose por idioma", () => {
    expect(r.resumen.porIdioma).toEqual({ es: { top5: 1, reales: 1 }, en: { top5: 1, reales: 2 } });
  });
  it("las absurdas no cuentan como reales y aportan su mejor score", () => {
    expect(r.absurdas).toHaveLength(1);
    expect(r.resumen.maxMejorAbsurda).toBeCloseTo(0.6, 5); // [0.6,-0.8] vs b=[0.8,0.6] -> 0.12; vs a -> 0.6
  });
  it("separación de umbral", () => {
    expect(r.resumen.minMejorReal).toBeCloseTo(Math.min(...r.casos.map((c) => c.mejor)), 6);
    expect(r.resumen.medianaMejorReal).toBeCloseTo(r.casos.map((c) => c.mejor).sort((a, b) => a - b)[1], 6);
    expect(r.resumen.separable).toBe(r.resumen.minMejorReal > r.resumen.maxMejorAbsurda!);
    expect(r.resumen.separable).toBe(true);
  });
  it("determinista", () => {
    expect(JSON.stringify(evaluar(cases, qs, docs, ids))).toBe(JSON.stringify(evaluar(cases, qs, docs, ids)));
  });
  it("desempate: scores iguales no empeoran el rank del esperado", () => {
    const d = [[1, 0], [1, 0]].map((v) => Float32Array.from(v));
    const e = evaluar([{ necesidad: "q", esperado: "y" }], [Float32Array.from([1, 0])], d, ["x", "y"]);
    expect(e.casos[0].rank).toBe(1);
  });
});

describe("renderMarkdown", () => {
  const rep: Reporte = {
    fecha: "2026-01-01T00:00:00.000Z", documentos: 3, consultas: 4,
    configs: [{ nombre: "gemma-plain", modelo: "m", dimsNativas: 2, neuronas: null,
      resultados: [{ dim: 2, ...r }] }],
  };
  it("tabla, fallos y nota de neuronas ausentes; determinista", () => {
    const md = renderMarkdown(rep);
    expect(md).toContain("| gemma-plain | 2 |");
    expect(md).toContain("q3");
    expect(md).toMatch(/neurons.*no informad/i);
    expect(renderMarkdown(rep)).toBe(md);
  });
});
