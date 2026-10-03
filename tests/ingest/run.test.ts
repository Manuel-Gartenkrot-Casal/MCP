import { describe, it, expect } from "vitest";
import { runIngest, rankEntries, exitCodeFor, type IngestDeps } from "../../src/ingest/run";
import { embedWorkersAI } from "../../src/ingest/cloudflare";
import type { Entry } from "../../src/types";

const mk = (id: string, o: Partial<Entry> = {}): Entry => ({
  id, nombre: "N" + id, descripcion: "D" + id, url_info: null, tipo_conexion: "remoto",
  como_conectar: "https://x", auth: "ninguna", incompleta: false, actualizado: "2026-01-01", ...o,
});
const many = (n: number) => Array.from({ length: n }, (_, i) => mk("e" + String(i).padStart(3, "0")));

function fake(entries: Entry[], over: Partial<IngestDeps> = {}) {
  const rows = new Map<string, string>();
  const embedded: string[] = [];
  const embedCalls: number[] = [];
  const upsertCalls: number[] = [];
  const vectors: string[] = [];
  const ops: string[] = [];
  const deps: IngestDeps = {
    fetchEntries: async () => entries,
    store: {
      getActualizados: async (ids) => new Map(ids.filter((i) => rows.has(i)).map((i) => [i, rows.get(i)!])),
      upsertEntries: async (es) => { for (const e of es) rows.set(e.id, e.actualizado); },
      listIds: async () => [...rows.keys()],
      deleteIds: async (ids) => { ops.push("rows:" + [...ids].sort().join(",")); for (const i of ids) rows.delete(i); },
    },
    embedBatch: async (ts) => { embedCalls.push(ts.length); embedded.push(...ts); return ts.map(() => [1]); },
    upsertVectors: async (items) => {
      upsertCalls.push(items.length);
      for (const { id } of items) if (!vectors.includes(id)) vectors.push(id);
    },
    deleteVectors: async (ids) => {
      ops.push("vec:" + [...ids].sort().join(","));
      for (const i of ids) vectors.splice(vectors.indexOf(i), 1);
    },
    log: () => {},
    ...over,
  };
  return { deps, rows, embedded, embedCalls, upsertCalls, vectors, ops };
}

describe("runIngest", () => {
  const three = [mk("a"), mk("b"), mk("c")];
  it("primera corrida: 3 embeddings y 3 upserts; texto = nombre + salto + descripcion", async () => {
    const f = fake(three);
    const r = await runIngest(f.deps);
    expect(r).toEqual({ nuevas: 3, omitidas: 0, fallidas: 0, fuera_de_cupo: 0, podadas: 0 });
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
  it("lotes de 25: 60 entradas => embed y upsert en 25, 25, 10", async () => {
    const f = fake(many(60));
    const r = await runIngest(f.deps);
    expect(r.nuevas).toBe(60);
    expect(f.embedCalls).toEqual([25, 25, 10]);
    expect(f.upsertCalls).toEqual([25, 25, 10]);
  });
  it("lote que falla => sus 25 son fallidas, los demás lotes siguen, rerun reintenta", async () => {
    let fail = true;
    const f = fake(many(120));
    const ok = f.deps.embedBatch;
    f.deps.embedBatch = async (ts) => { if (fail && ts.includes("Ne060\nDe060")) throw new Error("x"); return ok(ts); };
    const r = await runIngest(f.deps);
    expect(r).toMatchObject({ nuevas: 95, fallidas: 25 });
    expect(f.rows.has("e060")).toBe(false);
    expect(f.rows.has("e050")).toBe(false);
    expect(f.rows.has("e074")).toBe(false);
    expect(f.rows.has("e049")).toBe(true);
    expect(f.rows.has("e075")).toBe(true);
    fail = false;
    const r2 = await runIngest(f.deps);
    expect(r2).toMatchObject({ nuevas: 25, omitidas: 95, fallidas: 0 });
    expect(f.rows.size).toBe(120);
  });
  it("upsertVectors falla => no se guardan las filas", async () => {
    const f = fake([mk("a")], { upsertVectors: async () => { throw new Error("v"); } });
    const r = await runIngest(f.deps);
    expect(r.fallidas).toBe(1);
    expect(f.rows.size).toBe(0);
  });
  it("upsertEntries falla en un lote => ese lote fallido, el siguiente sigue", async () => {
    const f = fake(many(35));
    const up = f.deps.store.upsertEntries;
    f.deps.store.upsertEntries = async (es) => { if (es.length === 25) throw new Error("d1"); return up(es); };
    const r = await runIngest(f.deps);
    expect(r).toMatchObject({ nuevas: 10, fallidas: 25 });
  });
  it("reintentos agotados (429 siempre) => el lote cuenta como fallidas sin filtrar el token", async () => {
    const logs: string[] = [];
    const always429 = (async () => new Response("{}", { status: 429 })) as unknown as typeof fetch;
    const f = fake(three, {
      embedBatch: embedWorkersAI({ accountId: "a", token: "SECRET-TOKEN-123" }, always429, async () => {}),
      log: (m) => logs.push(m),
    });
    const r = await runIngest(f.deps);
    expect(r).toMatchObject({ nuevas: 0, fallidas: 3 });
    expect(f.rows.size).toBe(0);
    expect(logs.join("\n")).toContain("429");
    expect(logs.join("\n")).not.toContain("SECRET-TOKEN-123");
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

describe("poda de entradas que salen del cupo", () => {
  const five = ["a", "b", "c", "d", "e"].map((id) => mk(id));
  // two newer entries push the two lowest-ranked ("d", "e") out of a cap of 5
  const seven = [...five, mk("n1", { actualizado: "2026-05-01" }), mk("n2", { actualizado: "2026-05-01" })];

  it("borra exactamente almacenadas - conservadas: primero Vectorize, luego D1", async () => {
    const f = fake(five, { maxVectors: 5 });
    await runIngest(f.deps);
    f.deps.fetchEntries = async () => seven;
    const r = await runIngest(f.deps);
    expect(r.podadas).toBe(2);
    expect(f.ops).toEqual(["vec:d,e", "rows:d,e"]);
    expect([...f.rows.keys()].sort()).toEqual(["a", "b", "c", "n1", "n2"]);
    expect([...f.vectors].sort()).toEqual(["a", "b", "c", "n1", "n2"]);
    expect(f.rows.size).toBeLessThanOrEqual(5);
  });
  it("fallo al borrar vectores => lanza y deja las filas de D1 para reintentar", async () => {
    const f = fake(five, { maxVectors: 5 });
    await runIngest(f.deps);
    f.deps.fetchEntries = async () => seven;
    f.deps.deleteVectors = async () => { throw new Error("vectorize down"); };
    await expect(runIngest(f.deps)).rejects.toThrow("vectorize down");
    expect(f.rows.has("d")).toBe(true);
    expect(f.rows.has("e")).toBe(true);
    expect(f.ops).toEqual([]);
  });
  it("registro vacio o diminuto (< 50% de lo almacenado) => no poda y avisa", async () => {
    const ten = Array.from({ length: 10 }, (_, i) => mk("s" + i));
    for (const fetched of [[], ten.slice(0, 4)]) {
      const logs: string[] = [];
      const f = fake(ten, { log: (m) => logs.push(m) });
      await runIngest(f.deps);
      f.deps.fetchEntries = async () => fetched;
      const r = await runIngest(f.deps);
      expect(r.podadas).toBe(0);
      expect(f.ops).toEqual([]);
      expect(f.rows.size).toBe(10);
      expect(logs.some((l) => /aviso.*poda/i.test(l))).toBe(true);
    }
  });
  it("registro con exactamente 50% de lo almacenado => poda", async () => {
    const ten = Array.from({ length: 10 }, (_, i) => mk("s" + i));
    const f = fake(ten);
    await runIngest(f.deps);
    f.deps.fetchEntries = async () => ten.slice(0, 5);
    const r = await runIngest(f.deps);
    expect(r.podadas).toBe(5);
    expect(f.rows.size).toBe(5);
  });
  describe("guarda de poda por obsoletas (> 50% de lo almacenado)", () => {
    const ten = Array.from({ length: 10 }, (_, i) => mk("s" + i));
    const fresh = (n: number) => Array.from({ length: n }, (_, i) => mk("n" + i, { actualizado: "2026-05-01" }));
    it("exactamente 50% obsoletas => poda", async () => {
      const f = fake(ten, { maxVectors: 10 });
      await runIngest(f.deps);
      f.deps.fetchEntries = async () => [...ten.slice(0, 5), ...fresh(5)];
      const r = await runIngest(f.deps);
      expect(r.podadas).toBe(5);
      expect(f.rows.size).toBe(10);
    });
    it("un poco más del 50% obsoletas => no poda y avisa", async () => {
      const logs: string[] = [];
      const f = fake(ten, { maxVectors: 20, log: (m) => logs.push(m) });
      await runIngest(f.deps);
      f.deps.fetchEntries = async () => [...ten.slice(0, 4), ...fresh(4)];
      const r = await runIngest(f.deps);
      expect(r.podadas).toBe(0);
      expect(f.ops).toEqual([]);
      expect(logs.some((l) => /aviso.*poda/i.test(l))).toBe(true);
    });
    it("forcePrune: >50% obsoletas => poda, avisa y mete las nuevas dentro de maxVectors", async () => {
      const logs: string[] = [];
      const f = fake(ten, { maxVectors: 10, log: (m) => logs.push(m) });
      await runIngest(f.deps);
      f.deps.fetchEntries = async () => [...ten.slice(0, 4), ...fresh(6)];
      f.deps.forcePrune = true;
      const r = await runIngest(f.deps);
      expect(r.podadas).toBe(6);
      expect(r.nuevas).toBe(6);
      expect(f.rows.size).toBe(10);
      expect(f.vectors).toHaveLength(10);
      expect(logs.some((l) => /forz/i.test(l))).toBe(true);
    });
    it("forcePrune no salta la guarda de registro vacío/diminuto", async () => {
      for (const fetched of [[], ten.slice(0, 4)]) {
        const f = fake(ten, { maxVectors: 10 });
        await runIngest(f.deps);
        f.deps.fetchEntries = async () => fetched;
        f.deps.forcePrune = true;
        const r = await runIngest(f.deps);
        expect(r.podadas).toBe(0);
        expect(f.rows.size).toBe(10);
      }
    });
    it("con la guarda activa nunca se supera maxVectors: el exceso va a fuera_de_cupo", async () => {
      const logs: string[] = [];
      const f = fake(ten, { maxVectors: 12, log: (m) => logs.push(m) });
      await runIngest(f.deps);
      f.deps.fetchEntries = async () => [...ten.slice(0, 4), ...fresh(6)];
      const r = await runIngest(f.deps);
      expect(r.podadas).toBe(0);
      expect(r.nuevas).toBe(2);
      expect(r.fuera_de_cupo).toBe(4);
      expect(f.rows.size).toBe(12);
      expect(f.vectors).toHaveLength(12);
      expect(logs.some((l) => /cupo/i.test(l))).toBe(true);
    });
  });
  it("corrida repetida es idempotente", async () => {
    const f = fake(five, { maxVectors: 5 });
    await runIngest(f.deps);
    f.deps.fetchEntries = async () => seven;
    await runIngest(f.deps);
    f.ops.length = 0;
    f.embedded.length = 0;
    const r = await runIngest(f.deps);
    expect(r).toEqual({ nuevas: 0, omitidas: 5, fallidas: 0, fuera_de_cupo: 2, podadas: 0 });
    expect(f.ops).toEqual([]);
    expect(f.embedded).toEqual([]);
  });
});

describe("reindex", () => {
  const three = [mk("a"), mk("b"), mk("c")];
  it("reindex: re-embebe y re-sube (vector + fila) aunque actualizado no cambie; cuentan como nuevas", async () => {
    const f = fake(three);
    await runIngest(f.deps);
    f.embedded.length = 0; f.upsertCalls.length = 0;
    const filas: string[] = [];
    const up = f.deps.store.upsertEntries;
    f.deps.store.upsertEntries = async (es) => { filas.push(...es.map((e) => e.id)); return up(es); };
    f.deps.reindex = true;
    const r = await runIngest(f.deps);
    expect(r).toEqual({ nuevas: 3, omitidas: 0, fallidas: 0, fuera_de_cupo: 0, podadas: 0 });
    expect(f.embedded.sort()).toEqual(["Na\nDa", "Nb\nDb", "Nc\nDc"]);
    expect(f.upsertCalls).toEqual([3]);
    expect(filas.sort()).toEqual(["a", "b", "c"]);
  });
  it("sin reindex (por defecto) se siguen omitiendo", async () => {
    const f = fake(three);
    await runIngest(f.deps);
    f.embedded.length = 0;
    f.deps.reindex = false;
    expect(await runIngest(f.deps)).toMatchObject({ nuevas: 0, omitidas: 3 });
    expect(f.embedded).toEqual([]);
  });
  const ten = Array.from({ length: 10 }, (_, i) => mk("s" + i));
  const fresh = (n: number) => Array.from({ length: n }, (_, i) => mk("n" + i, { actualizado: "2026-05-01" }));
  it("reindex no salta la guarda de >50% obsoletas: no poda, re-embebe dentro del cupo", async () => {
    const logs: string[] = [];
    const f = fake(ten, { maxVectors: 12, log: (m) => logs.push(m) });
    await runIngest(f.deps);
    f.deps.fetchEntries = async () => [...ten.slice(0, 4), ...fresh(6)];
    f.deps.reindex = true;
    const r = await runIngest(f.deps);
    expect(r).toMatchObject({ podadas: 0, nuevas: 6, fuera_de_cupo: 4, omitidas: 0 });
    expect(f.ops).toEqual([]);
    expect(f.rows.size).toBe(12);
    expect(logs.some((l) => /aviso.*poda/i.test(l))).toBe(true);
  });
  it("reindex no salta la guarda de registro vacío/diminuto", async () => {
    for (const fetched of [[], ten.slice(0, 4)]) {
      const f = fake(ten, { maxVectors: 10 });
      await runIngest(f.deps);
      f.deps.fetchEntries = async () => fetched;
      f.deps.reindex = true;
      const r = await runIngest(f.deps);
      expect(r.podadas).toBe(0);
      expect(f.ops).toEqual([]);
      expect(f.rows.size).toBe(10);
    }
  });
});

describe("exitCodeFor", () => {
  it("1 si hubo fallidas, 0 si no", () => {
    expect(exitCodeFor({ fallidas: 0 })).toBe(0);
    expect(exitCodeFor({ fallidas: 3 })).toBe(1);
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
