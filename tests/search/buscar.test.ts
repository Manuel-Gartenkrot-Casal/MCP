import { describe, it, expect, vi } from "vitest";
import { buscar, InputError, type SearchDeps } from "../../src/search/buscar";
import type { Entry } from "../../src/types";

const entry = (id: string, o: Partial<Entry> = {}): Entry => ({
  id, nombre: id, descripcion: "desc " + id, url_info: null, tipo_conexion: "remoto",
  como_conectar: "https://x", auth: "ninguna", incompleta: false, actualizado: "2026-01-01T00:00:00Z", ...o,
});

function deps(hits: { id: string; score: number }[], entries: Entry[]) {
  const d = {
    embed: vi.fn(async (_t: string) => [1]),
    nearest: vi.fn(async () => hits),
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
    expect(d.nearest.mock.calls[1][1]).toBe(20);
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
});
