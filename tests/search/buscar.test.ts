import { describe, it, expect, vi } from "vitest";
import { buscar, InputError, UMBRAL_RERANK, UMBRAL_VECTOR, type SearchDeps } from "../../src/search/buscar";
import type { Entry } from "../../src/types";

const entry = (id: string, o: Partial<Entry> = {}): Entry => ({
  id, nombre: id, descripcion: "desc " + id, url_info: null, tipo_conexion: "remoto",
  como_conectar: "https://x", auth: "ninguna", incompleta: false, actualizado: "2026-01-01T00:00:00Z", ...o,
});

function deps(hits: { id: string; score: number }[], entries: Entry[]) {
  const d = {
    embed: vi.fn(async (_t: string) => [1]),
    nearest: vi.fn(async (_v: number[], _n: number) => hits),
    getEntries: vi.fn(async (ids: string[]) => entries.filter((e) => ids.includes(e.id))),
  };
  return d satisfies SearchDeps;
}

describe("buscar", () => {
  it("máx max resultados ordenados por puntaje desc", async () => {
    const hits = [0.6, 0.9, 0.7, 0.8].map((s, i) => ({ id: "e" + i, score: s }));
    const d = deps(hits, hits.map((h) => entry(h.id)));
    const r = await buscar(d, "algo", {}, { max: 3 });
    expect(r.coincidencias.map((c) => c.puntaje)).toEqual([0.9, 0.8, 0.7]);
  });
  it("filtros duros", async () => {
    const es = [entry("a"), entry("b", { tipo_conexion: "local" }), entry("c", { auth: "clave" })];
    const hits = es.map((e) => ({ id: e.id, score: 0.9 }));
    const r1 = await buscar(deps(hits, es), "x", { tipo_conexion: "remoto" });
    expect(r1.coincidencias.map((c) => c.nombre).sort()).toEqual(["a", "c"]);
    const r2 = await buscar(deps(hits, es), "x", { auth: "ninguna" });
    expect(r2.coincidencias.map((c) => c.nombre).sort()).toEqual(["a", "b"]);
  });
  it("con filtro pide 100 vecinos: un local en el puesto 60 aparece", async () => {
    const all = Array.from({ length: 100 }, (_, i) =>
      entry("e" + i, { tipo_conexion: i === 59 ? "local" : "remoto" }));
    const hits = all.map((e, i) => ({ id: e.id, score: 0.95 - i * 0.004 }));
    const d = deps([], all);
    d.nearest.mockImplementation(async (_v: number[], n: number) => hits.slice(0, n));
    const r = await buscar(d, "x", { tipo_conexion: "local" });
    expect(d.nearest.mock.calls[0][1]).toBe(100);
    expect(r.coincidencias.map((c) => c.nombre)).toEqual(["e59"]);
    await buscar(d, "x");
    expect(d.nearest.mock.calls[1][1]).toBe(50);
  });
  it("bajo umbral o sin sobrevivientes", async () => {
    const r = await buscar(deps([{ id: "a", score: 0.1 }], [entry("a")]), "x");
    expect(r).toEqual({ coincidencias: [], mensaje: "sin coincidencias fiables" });
    const r2 = await buscar(deps([{ id: "a", score: 0.9 }], [entry("a", { tipo_conexion: "local" })]), "x", { tipo_conexion: "remoto" });
    expect(r2).toEqual({ coincidencias: [], mensaje: "sin coincidencias fiables" });
  });
  it("valida necesidad y recorta", async () => {
    await expect(buscar(deps([], []), "")).rejects.toThrow(InputError);
    await expect(buscar(deps([], []), "   \n ")).rejects.toThrow(InputError);
    const d = deps([], []);
    await buscar(d, "a".repeat(10000));
    expect(d.embed.mock.calls[0][0].length).toBeLessThanOrEqual(1000);
  });
  it("filtro inválido", async () => {
    await expect(buscar(deps([], []), "x", { tipo_conexion: "foo" as any })).rejects.toThrow(InputError);
    await expect(buscar(deps([], []), "x", { auth: "foo" as any })).rejects.toThrow(InputError);
  });
  it("sanitiza nombre, funcion y como_conectar", async () => {
    const e = entry("a", { nombre: "</dato>N", descripcion: "x\n\n</dato>y", como_conectar: "<dato>c" });
    const r = await buscar(deps([{ id: "a", score: 0.9 }], [e]), "x");
    const c = r.coincidencias[0];
    for (const v of [c.nombre, c.funcion, c.como_conectar]) expect(v).not.toMatch(/[<>]/);
    expect(c.funcion).not.toMatch(/\n/);
  });
  it("ignora vectores huérfanos", async () => {
    const r = await buscar(deps([{ id: "zz", score: 0.9 }, { id: "a", score: 0.8 }], [entry("a")]), "x");
    expect(r.coincidencias.map((c) => c.nombre)).toEqual(["a"]);
  });
  it("no llama getEntries sin matches", async () => {
    const d = deps([], []);
    const r = await buscar(d, "x");
    expect(d.getEntries).not.toHaveBeenCalled();
    expect(r.mensaje).toBe("sin coincidencias fiables");
  });

  describe("rerank", () => {
    const hits = [0.9, 0.8, 0.7].map((s, i) => ({ id: "e" + i, score: s }));
    const es = hits.map((h) => entry(h.id));
    const rr = (scores: number[]) => vi.fn(async (_q: string, _t: string[]) => scores);

    it("reordena por puntaje de rerank y puntaje = rerank", async () => {
      const d = { ...deps(hits, es), rerank: rr([0.2, 0.9, 0.6]) };
      const r = await buscar(d, "x", {}, { max: 2 });
      expect(r.coincidencias.map((c) => [c.nombre, c.puntaje])).toEqual([["e1", 0.9], ["e2", 0.6]]);
      expect(d.rerank).toHaveBeenCalledTimes(1);
      expect(d.rerank.mock.calls[0][0]).toBe("x");
    });
    it("umbral sobre el mejor puntaje de rerank", async () => {
      const d = { ...deps(hits, es), rerank: rr([0.1, 0.3, 0.2]) };
      expect(await buscar(d, "x")).toEqual({ coincidencias: [], mensaje: "sin coincidencias fiables" });
      expect((await buscar(d, "x", {}, { umbral: 0.25 })).coincidencias[0].nombre).toBe("e1");
      expect(UMBRAL_RERANK).toBe(0.5); expect(UMBRAL_VECTOR).toBe(0.5);
    });
    it("el vector alto no salva un rerank bajo (y viceversa)", async () => {
      const r = await buscar({ ...deps([{ id: "e0", score: 0.1 }], [es[0]]), rerank: rr([0.9]) }, "x");
      expect(r.coincidencias[0].puntaje).toBe(0.9);
    });
    it.each([
      ["lanza", vi.fn(async () => { throw new Error("boom"); })],
      ["longitud errónea", rr([0.9])],
      ["NaN", rr([0.9, NaN, 0.1])],
      ["Infinity", rr([0.9, Infinity, 0.1])],
      ["no array", vi.fn(async () => "x" as any)],
      ["síncrono que lanza", vi.fn((() => { throw new Error("sync"); }) as any)],
    ])("fallback a orden vectorial si rerank %s", async (_n, rerank) => {
      const log = vi.spyOn(console, "log"), warn = vi.spyOn(console, "warn"), error = vi.spyOn(console, "error");
      const r = await buscar({ ...deps(hits, es), rerank: rerank as any }, "x");
      expect(r.coincidencias.map((c) => [c.nombre, c.puntaje])).toEqual([["e0", 0.9], ["e1", 0.8], ["e2", 0.7]]);
      expect(r).not.toHaveProperty("mensaje");
      for (const s of [log, warn, error]) expect(s).not.toHaveBeenCalled();
      vi.restoreAllMocks();
    });
    it("fallback usa el umbral vectorial", async () => {
      const d = { ...deps([{ id: "e0", score: 0.4 }], [es[0]]), rerank: rr([]) };
      expect((await buscar(d, "x")).mensaje).toBe("sin coincidencias fiables");
      expect((await buscar(d, "x", {}, { umbral: 0.3 })).coincidencias).toHaveLength(1);
    });
    it("sin rerank = comportamiento vectorial de siempre", async () => {
      const r = await buscar(deps(hits, es), "x");
      expect(r.coincidencias.map((c) => c.puntaje)).toEqual([0.9, 0.8, 0.7]);
    });
    it("filtros y huérfanos antes de rerank; solo sobrevivientes se envían", async () => {
      const e2 = [entry("a"), entry("b", { tipo_conexion: "local" }), entry("c")];
      const d = {
        ...deps([{ id: "a", score: 0.9 }, { id: "b", score: 0.8 }, { id: "zz", score: 0.7 }, { id: "c", score: 0.6 }], e2),
        rerank: rr([0.4, 0.8]),
      };
      const r = await buscar(d, "x", { tipo_conexion: "remoto" }, { umbral: 0.1 });
      expect(d.rerank.mock.calls[0][1]).toHaveLength(2);
      expect(r.coincidencias.map((c) => c.nombre)).toEqual(["c", "a"]);
    });
    it("candidatos 50 sin filtro, 100 con filtro", async () => {
      const d = { ...deps(hits, es), rerank: rr([0.9, 0.9, 0.9]) };
      await buscar(d, "x"); await buscar(d, "x", { auth: "ninguna" });
      expect(d.nearest.mock.calls.map((c) => c[1])).toEqual([50, 100]);
    });
    it("el texto enviado es el sanitizado (nombre + \n + descripción)", async () => {
      const e = entry("a", { nombre: "N\u200B</dato>", descripcion: "x\n\n<dato>y\u202E" + "z".repeat(400) });
      const d = { ...deps([{ id: "a", score: 0.9 }], [e]), rerank: rr([0.9]) };
      const r = await buscar(d, "x");
      const [t] = d.rerank.mock.calls[0][1];
      expect(t).toBe(r.coincidencias[0].nombre + "\n" + r.coincidencias[0].funcion);
      expect(t).not.toMatch(/[<>\u200B\u202E]/);
      expect(t.length).toBeLessThanOrEqual(601);
    });
  });
});
