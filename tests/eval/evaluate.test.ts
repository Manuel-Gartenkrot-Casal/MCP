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

  it("no umbral satisfies", () => {
    const r = evaluate([real("a"), absurd], [[h("a", 0.5)], [h("z", 0.6)]], [0.3, 0.5, 0.7]);
    expect(r.recomendado).toBeNull();
    expect(formatReport(r)).toContain("Ningún umbral");
  });
});
