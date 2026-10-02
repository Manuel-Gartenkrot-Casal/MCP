import { describe, it, expect } from "vitest";
import { needsEmbedding, d1RestStore } from "../../src/ingest/cloudflare";
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
    const m = await d1RestStore(cfg, f.fetchFn).getActualizados([]);
    expect(m.size).toBe(0);
    expect(f.calls.length).toBe(0);
  });

  it("getActualizados usa URL, Authorization y parámetros", async () => {
    const f = fake(() => ok([{ id: "a/b", actualizado: "t1" }]));
    const m = await d1RestStore(cfg, f.fetchFn).getActualizados(["a/b", "c/d"]);
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
    const m = await d1RestStore(cfg, f.fetchFn).getActualizados(ids);
    expect(f.calls.map((c) => c.body.params.length)).toEqual([100, 100, 50]);
    expect(m.size).toBe(250);
  });

  it("upsertEntry parametriza y evita inyección", async () => {
    const f = fake(() => ok());
    const evil = "x'); DROP TABLE entradas;--";
    await d1RestStore(cfg, f.fetchFn).upsertEntry(entry({ nombre: evil, incompleta: true, url_info: "https://u" }));
    const { sql, params } = f.calls[0].body;
    expect(sql).toMatch(/INSERT INTO entradas/);
    expect(sql).toMatch(/ON CONFLICT\(id\) DO UPDATE/);
    expect(sql).not.toContain("DROP TABLE");
    expect(sql).not.toContain("https://x");
    expect(params).toContain(evil);
    expect(params.length).toBe(9);
    expect(params).toContain(1);
  });

  it("HTTP no OK lanza sin filtrar el token", async () => {
    const f = fake(() => ({ status: 500, json: { errors: [{ message: "boom" }] } }));
    const err = await d1RestStore(cfg, f.fetchFn).upsertEntry(entry()).catch((e) => e);
    expect(err).toBeInstanceOf(Error);
    expect(err.message).toContain("500");
    expect(err.message).not.toContain(TOKEN);
  });

  it("success:false lanza con el mensaje y sin token", async () => {
    const f = fake(() => ({ json: { success: false, errors: [{ message: "syntax error" }], result: [] } }));
    const err = await d1RestStore(cfg, f.fetchFn).getActualizados(["a"]).catch((e) => e);
    expect(err.message).toContain("syntax error");
    expect(err.message).not.toContain(TOKEN);
  });
});
