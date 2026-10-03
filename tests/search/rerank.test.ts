import { describe, it, expect } from "vitest";
import { parseRerankResponse } from "../../src/search/rerank";

// Real response probed live against the REST endpoint on 2026-10-02 (sorted by score, ids = request indices).
const real = {
  response: [
    { id: 0, score: 0.9994639754295349 }, { id: 1, score: 0.9507158398628235 },
    { id: 3, score: 0.00003741279579116963 }, { id: 2, score: 0.000037339974369388074 },
  ],
  usage: { prompt_tokens: 124, completion_tokens: 0, total_tokens: 124, neurons: 0.035 },
};

describe("parseRerankResponse", () => {
  it("respuesta real (ordenada por score) -> puntajes en el orden de entrada, sin transformar", () => {
    expect(parseRerankResponse(real, 4)).toEqual([0.9994639754295349, 0.9507158398628235, 0.000037339974369388074, 0.00003741279579116963]);
  });
  it("array desnudo, { response } y { result: { response } }", () => {
    const a = [{ id: 1, score: 0.2 }, { id: 0, score: 0.8 }];
    expect(parseRerankResponse(a, 2)).toEqual([0.8, 0.2]);
    expect(parseRerankResponse({ response: a }, 2)).toEqual([0.8, 0.2]);
    expect(parseRerankResponse({ result: { response: a } }, 2)).toEqual([0.8, 0.2]);
  });
  it("acepta los extremos 0 y 1", () => {
    expect(parseRerankResponse([{ id: 0, score: 0 }, { id: 1, score: 1 }], 2)).toEqual([0, 1]);
  });
  it.each([
    ["id duplicado", [{ id: 0, score: 0.1 }, { id: 0, score: 0.2 }]],
    ["id ausente", [{ id: 0, score: 0.1 }]],
    ["id fuera de rango", [{ id: 0, score: 0.1 }, { id: 2, score: 0.1 }]],
    ["id negativo", [{ id: -1, score: 0.1 }, { id: 0, score: 0.1 }]],
    ["id no entero", [{ id: 0.5, score: 0.1 }, { id: 1, score: 0.1 }]],
    ["score no numérico", [{ id: 0, score: "0.1" }, { id: 1, score: 0.1 }]],
    ["score NaN", [{ id: 0, score: NaN }, { id: 1, score: 0.1 }]],
    ["score Infinity", [{ id: 0, score: Infinity }, { id: 1, score: 0.1 }]],
    ["score > 1", [{ id: 0, score: 1.5 }, { id: 1, score: 0.1 }]],
    ["score < 0", [{ id: 0, score: -0.2 }, { id: 1, score: 0.1 }]],
    ["elemento null", [null, { id: 1, score: 0.1 }]],
    ["hueco en el array", [{ id: 0, score: 0.1 }, , { id: 1, score: 0.1 }].slice(0, 2)],
    ["no array", { foo: 1 }],
    ["null", null],
    ["response no array", { response: "x" }],
    ["longitud de más", [{ id: 0, score: 0.1 }, { id: 1, score: 0.1 }, { id: 2, score: 0.1 }]],
  ])("lanza ante %s", (_n, raw) => {
    expect(() => parseRerankResponse(raw, 2)).toThrow();
  });
});
