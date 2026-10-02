import { describe, it, expect } from "vitest";
import { needsEmbedding, d1RestStore, vectorizeDelete } from "../../src/ingest/cloudflare";
import type { Entry } from "../../src/types";

const entry = (o: Partial<Entry> = {}): Entry => ({
  id: "a/b", nombre: "N", descripcion: "D", url_info: null, tipo_conexion: "remoto",
  como_conectar: "https://x", auth: "ninguna", incompleta: false, actualizado: "2026-01-01T00:00:00Z", ...o,
});

describe("needsEmbedding", () => {
  it("sin registro previo => true", () => expect(needsEmbedding(undefined, entry())).toBe(true));
  it("mismo actualizado => false", () => expect(needsEmbedding("2026-01-01T00:00:00Z", entry())).toBe(false));
  it("actualizado distinto => true", () => expect(needsEmbedding("2025-01-01T00:00:00Z", entry())).toBe(true));
});

const TOKEN = "SECRET-TOKEN-123";
const cfg = { accountId: "acc", databaseId: "db", token: TOKEN };
const noSleep = async () => {};
function fake(respond: (body: any) => { status?: number; json: any }) {
  const calls: { url: string; init: any; body: any }[] = [];
  const fetchFn = (async (url: string, init: any) => {
    const body = JSON.parse(init.body);
    calls.push({ url, init, body });
    const r = respond(body);
    return new Response(JSON.stringify(r.json), { status: r.status ?? 200 });
  }) as unknown as typeof fetch;
  return { calls, fetchFn };
}
const ok = (results: any[] = []) => ({ json: { success: true, errors: [], result: [{ success: true, results }] } });

describe("d1RestStore", () => {
  it("getActualizados([]) no hace petición", async () => {
    const f = fake(() => ok());
    const m = await d1RestStore(cfg, f.fetchFn, noSleep).getActualizados([]);
    expect(m.size).toBe(0);
    expect(f.calls.length).toBe(0);
  });

  it("getActualizados usa URL, Authorization y parámetros", async () => {
    const f = fake(() => ok([{ id: "a/b", actualizado: "t1" }]));
    const m = await d1RestStore(cfg, f.fetchFn, noSleep).getActualizados(["a/b", "c/d"]);
    expect(m.get("a/b")).toBe("t1");
    const c = f.calls[0];
    expect(c.url).toBe("https://api.cloudflare.com/client/v4/accounts/acc/d1/database/db/query");
    expect(c.init.method).toBe("POST");
    expect(c.init.headers.Authorization).toBe(`Bearer ${TOKEN}`);
    expect(c.body.sql).toContain("?");
    expect(c.body.sql).not.toContain("a/b");
    expect(c.body.params).toEqual(["a/b", "c/d"]);
  });

  it("agrupa en lotes de 100 parámetros", async () => {
    const f = fake((b) => ok(b.params.map((id: string) => ({ id, actualizado: "t" }))));
    const ids = Array.from({ length: 250 }, (_, i) => `id${i}`);
    const m = await d1RestStore(cfg, f.fetchFn, noSleep).getActualizados(ids);
    expect(f.calls.map((c) => c.body.params.length)).toEqual([100, 100, 50]);
    expect(m.size).toBe(250);
  });

  it("upsertEntries parametriza y evita inyección", async () => {
    const f = fake(() => ok());
    const evil = "x'); DROP TABLE entradas;--";
    await d1RestStore(cfg, f.fetchFn, noSleep).upsertEntries([entry({ nombre: evil, incompleta: true, url_info: "https://u" })]);
    const { sql, params } = f.calls[0].body;
    expect(sql).toMatch(/INSERT INTO entradas/);
    expect(sql).toMatch(/ON CONFLICT\(id\) DO UPDATE/);
    expect(sql).not.toContain("DROP TABLE");
    expect(sql).not.toContain("https://x");
    expect(params).toContain(evil);
    expect(params.length).toBe(9);
    expect(params).toContain(1);
  });

  it("upsertEntries: INSERT multi-fila en trozos de 11 filas (<= 100 parámetros)", async () => {
    const f = fake(() => ok());
    const es = Array.from({ length: 25 }, (_, i) => entry({ id: "id" + i }));
    await d1RestStore(cfg, f.fetchFn, noSleep).upsertEntries(es);
    expect(f.calls.map((c) => c.body.params.length)).toEqual([99, 99, 27]);
    expect(f.calls[0].body.sql.match(/\(\?, \?, \?, \?, \?, \?, \?, \?, \?\)/g)).toHaveLength(11);
    expect(f.calls[0].body.sql).toMatch(/ON CONFLICT\(id\) DO UPDATE/);
    expect(f.calls.flatMap((c) => c.body.params.filter((_: unknown, i: number) => i % 9 === 0))).toEqual(es.map((e) => e.id));
  });

  it("upsertEntries([]) no hace petición", async () => {
    const f = fake(() => ok());
    await d1RestStore(cfg, f.fetchFn, noSleep).upsertEntries([]);
    expect(f.calls.length).toBe(0);
  });

  it("reintenta 503 y luego responde", async () => {
    let n = 0;
    const f = fake(() => (n++ === 0 ? { status: 503, json: {} } : ok([{ id: "a", actualizado: "t" }])));
    const m = await d1RestStore(cfg, f.fetchFn, noSleep).getActualizados(["a"]);
    expect(f.calls.length).toBe(2);
    expect(m.get("a")).toBe("t");
  });

  it("listIds lee todos los ids", async () => {
    const f = fake(() => ok([{ id: "a" }, { id: "b" }]));
    expect(await d1RestStore(cfg, f.fetchFn, noSleep).listIds()).toEqual(["a", "b"]);
    expect(f.calls[0].body.sql).toBe("SELECT id FROM entradas");
    expect(f.calls[0].body.params).toEqual([]);
  });

  it("deleteIds parametriza en lotes de 100 y [] no hace peticion", async () => {
    const f = fake(() => ok());
    const s = d1RestStore(cfg, f.fetchFn, noSleep);
    await s.deleteIds([]);
    expect(f.calls.length).toBe(0);
    const ids = Array.from({ length: 250 }, (_, i) => `id${i}`);
    await s.deleteIds(ids);
    expect(f.calls.map((c) => c.body.params.length)).toEqual([100, 100, 50]);
    expect(f.calls[0].body.sql).toMatch(/^DELETE FROM entradas WHERE id IN \(\?(,\?)*\)$/);
    expect(f.calls.flatMap((c) => c.body.params)).toEqual(ids);
  });

  it("HTTP no OK lanza sin filtrar el token", async () => {
    const f = fake(() => ({ status: 500, json: { errors: [{ message: "boom" }] } }));
    const err = await d1RestStore(cfg, f.fetchFn, noSleep).upsertEntries([entry()]).catch((e) => e);
    expect(err).toBeInstanceOf(Error);
    expect(err.message).toContain("500");
    expect(err.message).not.toContain(TOKEN);
  });

  it("success:false lanza con el mensaje y sin token", async () => {
    const f = fake(() => ({ json: { success: false, errors: [{ message: "syntax error" }], result: [] } }));
    const err = await d1RestStore(cfg, f.fetchFn, noSleep).getActualizados(["a"]).catch((e) => e);
    expect(err.message).toContain("syntax error");
    expect(err.message).not.toContain(TOKEN);
  });

  const raw = (text: string, status = 200) =>
    (async () => new Response(text, { status })) as unknown as typeof fetch;

  it("200 con cuerpo no JSON rechaza (upsert y get)", async () => {
    const s = d1RestStore(cfg, raw("<html>oops</html>"));
    await expect(s.upsertEntries([entry()])).rejects.toThrow(/D1/);
    await expect(s.getActualizados(["a"])).rejects.toThrow(/D1/);
  });

  it("200 JSON sin success:true rechaza", async () => {
    const s = d1RestStore(cfg, raw("{}"));
    await expect(s.upsertEntries([entry()])).rejects.toThrow(/D1/);
  });

  it("result[0].success:false rechaza", async () => {
    const s = d1RestStore(cfg, raw(JSON.stringify({ success: true, result: [{ success: false, results: [] }] })));
    await expect(s.upsertEntries([entry()])).rejects.toThrow(/D1/);
  });
});

describe("vectorizeDelete", () => {
  it("POST delete_by_ids con {ids} en lotes de 100; [] no hace peticion; error sin token", async () => {
    const f = fake(() => ({ json: { success: true, result: { mutationId: "m" } } }));
    const del = vectorizeDelete({ accountId: "acc", index: "idx", token: TOKEN }, f.fetchFn, noSleep);
    await del([]);
    expect(f.calls.length).toBe(0);
    const ids = Array.from({ length: 150 }, (_, i) => `v${i}`);
    await del(ids);
    expect(f.calls.map((c) => c.body.ids.length)).toEqual([100, 50]);
    expect(f.calls[0].url).toBe("https://api.cloudflare.com/client/v4/accounts/acc/vectorize/v2/indexes/idx/delete_by_ids");
    expect(f.calls[0].init.headers.Authorization).toBe(`Bearer ${TOKEN}`);
    expect(f.calls[0].init.headers["Content-Type"]).toBe("application/json");
    const bad = fake(() => ({ status: 400, json: { success: false, errors: [{ message: "nope" }] } }));
    const err: Error = await vectorizeDelete({ accountId: "a", index: "i", token: TOKEN }, bad.fetchFn, noSleep)(["x"]).catch((e) => e);
    expect(err.message).toMatch(/400.*nope/);
    expect(err.message).not.toContain(TOKEN);
  });
});
