import { describe, it, expect } from "vitest";
import { sigmoid, parseRerankResponse } from "../../src/search/rerank";

describe("sigmoid", () => {
  it("0 -> 0.5, monótona y en (0,1)", () => {
    expect(sigmoid(0)).toBe(0.5);
    expect(sigmoid(2)).toBeGreaterThan(sigmoid(-2));
    for (const x of [-20, -1, 1, 20]) expect(sigmoid(x)).toBeGreaterThan(0), expect(sigmoid(x)).toBeLessThan(1);
  });
});

describe("parseRerankResponse", () => {
  const s = (x: number) => sigmoid(x);
  it("array desnudo, ids desordenados -> orden de entrada", () => {
    const r = parseRerankResponse([{ id: 2, score: 3 }, { id: 0, score: -1 }, { id: 1, score: 0 }], 3);
    expect(r).toEqual([s(-1), s(0), s(3)]);
  });
  it("envuelto en { response }", () => {
    expect(parseRerankResponse({ response: [{ id: 1, score: 1 }, { id: 0, score: 2 }] }, 2)).toEqual([s(2), s(1)]);
  });
  it("valores en (0,1)", () => {
    for (const v of parseRerankResponse([{ id: 0, score: -9 }, { id: 1, score: 9 }], 2)) {
      expect(v).toBeGreaterThan(0); expect(v).toBeLessThan(1);
    }
  });
  it.each([
    ["id duplicado", [{ id: 0, score: 1 }, { id: 0, score: 2 }]],
    ["id ausente", [{ id: 0, score: 1 }]],
    ["id fuera de rango", [{ id: 0, score: 1 }, { id: 2, score: 1 }]],
    ["id negativo", [{ id: -1, score: 1 }, { id: 0, score: 1 }]],
    ["id no entero", [{ id: 0.5, score: 1 }, { id: 1, score: 1 }]],
    ["score no numérico", [{ id: 0, score: "1" }, { id: 1, score: 1 }]],
    ["score NaN", [{ id: 0, score: NaN }, { id: 1, score: 1 }]],
    ["score Infinity", [{ id: 0, score: Infinity }, { id: 1, score: 1 }]],
    ["elemento null", [null, { id: 1, score: 1 }]],
    ["no array", { foo: 1 }],
    ["null", null],
    ["response no array", { response: "x" }],
    ["longitud de más", [{ id: 0, score: 1 }, { id: 1, score: 1 }, { id: 2, score: 1 }]],
  ])("lanza ante %s", (_n, raw) => {
    expect(() => parseRerankResponse(raw, 2)).toThrow();
  });
});
