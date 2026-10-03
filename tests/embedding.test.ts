import { describe, it, expect } from "vitest";
import { EMBED_MODEL, EMBED_NATIVE_DIMS, EMBED_DIMS, QUOTA_DIMS, MAX_VECTORS, reducir } from "../src/embedding";

const norm = (v: number[]) => Math.sqrt(v.reduce((s, x) => s + x * x, 0));

describe("embedding", () => {
  it("constantes: EmbeddingGemma 768 nativas, 128 indexadas, cupo con 2% de margen", () => {
    expect(EMBED_MODEL).toBe("@cf/google/embeddinggemma-300m");
    expect(EMBED_NATIVE_DIMS).toBe(768);
    expect(EMBED_DIMS).toBe(128);
    expect(QUOTA_DIMS).toBe(5_000_000);
    expect(MAX_VECTORS).toBe(Math.floor((QUOTA_DIMS * 0.98) / EMBED_DIMS));
    expect(MAX_VECTORS).toBe(38_281);
    expect(MAX_VECTORS * EMBED_DIMS).toBeLessThanOrEqual(QUOTA_DIMS);
  });
  it("reducir: primeras EMBED_DIMS componentes, norma 1, array plano", () => {
    const v = Array.from({ length: EMBED_NATIVE_DIMS }, (_, i) => (i < EMBED_DIMS ? i + 1 : 1000));
    const out = reducir(v);
    expect(Array.isArray(out)).toBe(true);
    expect(out).toHaveLength(EMBED_DIMS);
    expect(norm(out)).toBeCloseTo(1, 6);
    // proportional to the first components only (the 1000s are dropped)
    expect(out[1] / out[0]).toBeCloseTo(2, 5);
  });
  it("reducir: longitud distinta, no array, no finitos o norma cero => lanza mensaje fijo sin datos", () => {
    const ok = Array(EMBED_NATIVE_DIMS).fill(0.5);
    const malos: unknown[] = [
      null, "x", { length: EMBED_NATIVE_DIMS }, Array(EMBED_DIMS).fill(0.5), Array(1024).fill(0.5),
      [...ok.slice(1), NaN], [...ok.slice(1), Infinity], [...ok.slice(1), "0.5"],
      Array(EMBED_NATIVE_DIMS).fill(0), [...Array(EMBED_DIMS).fill(0), ...Array(EMBED_NATIVE_DIMS - EMBED_DIMS).fill(1)],
    ];
    for (const m of malos) {
      let e: unknown;
      try { reducir(m); } catch (x) { e = x; }
      expect(e, String(m).slice(0, 20)).toBeInstanceOf(Error);
      expect((e as Error).message).not.toMatch(/0\.5|NaN|Infinity/);
    }
  });
});
