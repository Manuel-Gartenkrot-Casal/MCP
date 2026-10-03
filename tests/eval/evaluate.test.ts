import { describe, it, expect } from "vitest";
import { evaluate, formatReport, type Case } from "../../eval/evaluate";

const real = (id: string): Case => ({ necesidad: "n " + id, esperado: id });
const absurd: Case = { necesidad: "absurdo", esperado: null };
const h = (id: string, score: number) => ({ id, score });

describe("evaluate", () => {
  it("hit rate, miss with rank and absent", () => {
    const cases = [real("a"), real("b"), real("c"), real("d")];
    const filler = [h("x1", 0.9), h("x2", 0.8), h("x3", 0.7), h("x4", 0.6)];
    const r = evaluate(cases, [
      [h("a", 0.9)],                      // rank 1
      [...filler, h("b", 0.5)],           // rank 5 => hit
      [...filler, h("x5", 0.55), h("c", 0.4)], // rank 6 => miss
      [h("x1", 0.9)],                     // absent
    ]);
    expect(r.aciertos).toBe(2);
    expect(r.porcentaje).toBe(50);
    expect(r.fallos).toEqual([
      { necesidad: "n c", esperado: "c", rank: 6, score: 0.4 },
      { necesidad: "n d", esperado: "d", rank: null, score: null },
    ]);
    expect(formatReport(r)).toContain("ausente");
  });

  it("sweep and recommendation", () => {
    const r = evaluate(
      [real("a"), real("b"), absurd, absurd],
      [[h("a", 0.8)], [h("b", 0.55)], [h("z", 0.45)], []],
      [0.3, 0.5, 0.6],
    );
    expect(r.barrido).toEqual([
      { umbral: 0.3, reales: 2, absurdasRechazadas: 1 },
      { umbral: 0.5, reales: 2, absurdasRechazadas: 2 },
      { umbral: 0.6, reales: 1, absurdasRechazadas: 2 },
    ]);
    expect(r.recomendado).toBe(0.5);
  });

  it("separa 'no indexado' de 'rank bajo' y da ambos porcentajes", () => {
    const r = evaluate(
      [real("a"), real("b"), real("c")],
      [[h("a", 0.8)], [h("x", 0.9)], [h("x", 0.9)]],
      [0.5],
      new Set(["a", "b"]),
    );
    expect(r.porcentaje).toBeCloseTo(100 / 3);
    expect(r.indexadas).toBe(2);
    expect(r.aciertos).toBe(1); // un caso no indexado nunca cuenta como acierto
    expect(r.porcentajeIndexadas).toBe(50);
    expect(r.noIndexados).toEqual([{ necesidad: "n c", esperado: "c" }]);
    expect(r.fallos.map((f) => f.esperado)).toEqual(["b"]);
    const out = formatReport(r);
    expect(out).toContain("NO INDEXADO");
    expect(out).toContain("1/2 indexados (50%)");
  });

  it("la recomendación usa solo los casos indexados", () => {
    // "c" no está en D1 pero un vector huérfano lo devuelve con score bajo: no debe forzar un umbral bajo
    const r = evaluate(
      [real("a"), real("c"), absurd],
      [[h("a", 0.8)], [h("c", 0.35)], [h("z", 0.45)]],
      [0.3, 0.5],
      new Set(["a"]),
    );
    expect(r.barrido).toEqual([
      { umbral: 0.3, reales: 1, absurdasRechazadas: 0 },
      { umbral: 0.5, reales: 1, absurdasRechazadas: 1 },
    ]);
    expect(r.recomendado).toBe(0.5);
  });

  it("no umbral satisfies", () => {
    const r = evaluate([real("a"), absurd], [[h("a", 0.5)], [h("z", 0.6)]], [0.3, 0.5, 0.7]);
    expect(r.recomendado).toBeNull();
    expect(formatReport(r)).toContain("Ningún umbral");
  });
});

import { evaluarModos, formatComparacion, UMBRALES_RERANK } from "../../eval/evaluate";

const idioma = (id: string, i: "es" | "en"): Case => ({ ...real(id), idioma: i });
const filler = [h("x1", 0.9), h("x2", 0.8), h("x3", 0.7), h("x4", 0.6), h("x5", 0.5)];

describe("evaluate por idioma", () => {
  it("aciertos por idioma sobre casos reales indexados", () => {
    const r = evaluate(
      [idioma("a", "es"), idioma("b", "es"), idioma("c", "en"), { ...absurd, idioma: "es" }],
      [[h("a", 0.9)], [...filler, h("b", 0.4)], [h("c", 0.9)], []],
    );
    expect(r.porIdioma).toEqual({ es: { aciertos: 1, reales: 2 }, en: { aciertos: 1, reales: 1 } });
  });
  it("casos sin idioma no crean grupos", () => {
    expect(evaluate([real("a")], [[h("a", 0.9)]]).porIdioma).toEqual({});
  });
});

describe("evaluarModos / formatComparacion", () => {
  const cases = [idioma("a", "es"), idioma("b", "en"), { ...absurd, idioma: "en" as const }];
  const vec = [[...filler, h("a", 0.4)], [h("b", 0.8)], [h("z", 0.6)]];
  const rer = [[h("a", 0.95)], [h("b", 0.7)], [h("z", 0.15)]];
  const m = evaluarModos(cases, vec, rer);
  it("cada modo con su barrido", () => {
    expect(m.vector.aciertos).toBe(1);
    expect(m.reranked.aciertos).toBe(2);
    expect(m.vector.barrido.map((b) => b.umbral)).toEqual([0.3, 0.4, 0.5, 0.6, 0.7]);
    expect(m.reranked.barrido.map((b) => b.umbral)).toEqual(UMBRALES_RERANK);
    expect(UMBRALES_RERANK).toEqual([0.001, 0.005, 0.01, 0.02, 0.05, 0.1, 0.2, 0.3, 0.4, 0.5, 0.6, 0.7, 0.8, 0.9, 0.95, 0.99]);
    expect(m.reranked.recomendado).toBe(0.7); // mejor 0.7 conserva a y b; el absurdo (0.15) se rechaza desde 0.2
  });
  it("el informe muestra ambos modos, idiomas, fallos y recomendación", () => {
    const out = formatComparacion(m);
    expect(out).toContain("SOLO VECTOR");
    expect(out).toContain("CON RERANKER");
    expect(out).toContain("es 0/1");
    expect(out).toContain("en 1/1");
    expect(out).toContain("es 1/1");
    expect(out).toContain('FALLO "n a" -> a: rank 6, score 0.400');
    expect(out).toContain("Umbral recomendado: 0.7");
    expect(out).toContain("  0.95: reales");
    expect(out).toContain("  0.99: reales");
    expect(out).toContain("  0.001: reales");
  });
});
