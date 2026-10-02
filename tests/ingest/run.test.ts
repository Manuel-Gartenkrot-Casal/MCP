import { describe, it, expect } from "vitest";
import { runIngest, rankEntries, type IngestDeps } from "../../src/ingest/run";
import type { Entry } from "../../src/types";

const mk = (id: string, o: Partial<Entry> = {}): Entry => ({
  id, nombre: "N" + id, descripcion: "D" + id, url_info: null, tipo_conexion: "remoto",
  como_conectar: "https://x", auth: "ninguna", incompleta: false, actualizado: "2026-01-01", ...o,
});

function fake(entries: Entry[], over: Partial<IngestDeps> = {}) {
  const rows = new Map<string, string>();
  const embedded: string[] = [];
  const vectors: string[] = [];
  const deps: IngestDeps = {
    fetchEntries: async () => entries,
    store: {
      getActualizados: async (ids) => new Map(ids.filter((i) => rows.has(i)).map((i) => [i, rows.get(i)!])),
      upsertEntry: async (e) => { rows.set(e.id, e.actualizado); },
    },
    embed: async (t) => { embedded.push(t); return [1]; },
    upsertVector: async (id) => { vectors.push(id); },
    log: () => {},
    ...over,
  };
  return { deps, rows, embedded, vectors };
}

describe("runIngest", () => {
  const three = [mk("a"), mk("b"), mk("c")];
  it("primera corrida: 3 embeddings y 3 upserts; texto = nombre + salto + descripcion", async () => {
    const f = fake(three);
    const r = await runIngest(f.deps);
    expect(r).toEqual({ nuevas: 3, omitidas: 0, fallidas: 0, fuera_de_cupo: 0 });
    expect(f.embedded.sort()).toEqual(["Na\nDa", "Nb\nDb", "Nc\nDc"]);
    expect(f.vectors).toHaveLength(3);
  });
  it("segunda corrida: omite todo", async () => {
    const f = fake(three);
    await runIngest(f.deps);
    f.embedded.length = 0;
    const r = await runIngest(f.deps);
    expect(f.embedded).toHaveLength(0);
    expect(r.omitidas).toBe(3);
  });
  it("actualizado nuevo => solo esa se re-embebe", async () => {
    const f = fake(three);
    await runIngest(f.deps);
    f.embedded.length = 0;
    f.deps.fetchEntries = async () => [mk("a"), mk("b", { actualizado: "2026-02-01" }), mk("c")];
    const r = await runIngest(f.deps);
    expect(f.embedded).toEqual(["Nb\nDb"]);
    expect(r.nuevas).toBe(1);
  });
  it("fetchEntries lanza => lanza y no escribe", async () => {
    const f = fake(three, { fetchEntries: async () => { throw new Error("boom"); } });
    await expect(runIngest(f.deps)).rejects.toThrow("boom");
    expect(f.rows.size).toBe(0);
    expect(f.vectors).toHaveLength(0);
  });
  it("embed falla en la 2a => fallida, resto sigue, rerun reintenta", async () => {
    let fail = true;
    const f = fake(three);
    const ok = f.deps.embed;
    f.deps.embed = async (t) => { if (fail && t.startsWith("Nb")) throw new Error("x"); return ok(t); };
    const r = await runIngest(f.deps);
    expect(r).toMatchObject({ nuevas: 2, fallidas: 1 });
    expect([...f.rows.keys()].sort()).toEqual(["a", "c"]);
    fail = false;
    const r2 = await runIngest(f.deps);
    expect(r2).toMatchObject({ nuevas: 1, omitidas: 2, fallidas: 0 });
    expect(f.rows.has("b")).toBe(true);
  });
  it("upsertVector falla => no se guarda la fila", async () => {
    const f = fake([mk("a")], { upsertVector: async () => { throw new Error("v"); } });
    const r = await runIngest(f.deps);
    expect(r.fallidas).toBe(1);
    expect(f.rows.size).toBe(0);
  });
  it("excluye ids de más de 64 bytes UTF-8 (cuenta bytes, no caracteres) y lo registra", async () => {
    const logs: string[] = [];
    const ok64 = "a".repeat(64);
    const multi = "ñ".repeat(33); // 33 chars, 66 bytes
    const f = fake([mk(ok64), mk("a".repeat(65)), mk(multi)], { log: (m) => logs.push(m) });
    const r = await runIngest(f.deps);
    expect(r.nuevas).toBe(1);
    expect(r.fallidas).toBe(0);
    expect([...f.rows.keys()]).toEqual([ok64]);
    expect(logs.some((l) => /2 .*64 bytes/.test(l))).toBe(true);
  });
  it("maxVectors=2 con 5 entradas: solo las 2 mejores", async () => {
    const es = [
      mk("loc", { tipo_conexion: "local", url_info: "u", descripcion: "x".repeat(50) }),
      mk("r-best", { url_info: "u", descripcion: "x".repeat(50) }),
      mk("r-info", { url_info: "u" }),
      mk("r-plain"),
      mk("r-long", { descripcion: "x".repeat(50) }),
    ];
    const f = fake(es, { maxVectors: 2 });
    const r = await runIngest(f.deps);
    expect(r.fuera_de_cupo).toBe(3);
    expect(r.nuevas).toBe(2);
    expect([...f.rows.keys()].sort()).toEqual(["r-best", "r-info"]);
    expect(f.vectors.sort()).toEqual(["r-best", "r-info"]);
  });
});

describe("rankEntries", () => {
  it("remoto > url_info > descripcion larga > mas nuevo > id", () => {
    const es = [
      mk("z", { actualizado: "2026-03-01" }),
      mk("b", { actualizado: "2026-01-01" }),
      mk("a", { actualizado: "2026-01-01" }),
      mk("long", { descripcion: "x".repeat(40) }),
      mk("info", { url_info: "u" }),
      mk("local", { tipo_conexion: "local", url_info: "u", descripcion: "x".repeat(40) }),
    ];
    expect(rankEntries(es).map((e) => e.id)).toEqual(["info", "long", "z", "a", "b", "local"]);
  });
});
