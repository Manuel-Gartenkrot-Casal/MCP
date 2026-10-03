import { describe, it, expect } from "vitest";
import { runExperimento, embedModelo, type Config } from "../../src/experimento/pipeline";
import type { Entry } from "../../src/types";

const TOKEN = "SECRET-TOKEN-XYZ";
const DIMS = 6;
const json = (b: unknown, status = 200) => new Response(JSON.stringify(b), { status });
const noSleep = async () => {};

// deterministic pseudo-embedding from text
const vec = (t: string) => Array.from({ length: DIMS }, (_, i) => Math.sin(i + 1 + [...t].reduce((s, c) => s + c.charCodeAt(0) * (i + 1), 0) % 97));

function fakeFetch(opts: { neurons?: number; reject4xxOver?: number } = {}) {
  const calls: { url: string; body: any; auth: string }[] = [];
  const f = (async (url: any, init: any) => {
    const body = JSON.parse(init.body);
    calls.push({ url: String(url), body, auth: init.headers.Authorization });
    if (opts.reject4xxOver && body.text.length > opts.reject4xxOver) return json({ success: false, errors: [{ message: "too many" }] }, 400);
    return json({ success: true, result: { data: body.text.map(vec), ...(opts.neurons ? { usage: { neurons: opts.neurons } } : {}) } });
  }) as typeof fetch;
  return { f, calls };
}

const entry = (id: string, nombre: string, descripcion: string): Entry => ({
  id, nombre, descripcion, url_info: null, tipo_conexion: "remoto", como_conectar: "https://x", auth: "ninguna", incompleta: false, actualizado: "2026",
});
const entries = [entry("a", "Alpha", "scan docker files"), entry("b", "Beta", "send postal mail"), entry("c", "Gamma", "translate ebooks")];
const cases = [
  { necesidad: "scan docker files", esperado: "a", idioma: "en" as const },
  { necesidad: "send postal mail", esperado: "b", idioma: "es" as const },
  { necesidad: "cocinar", esperado: null },
];
const configs: Config[] = [
  { nombre: "base", modelo: "@cf/baai/bge-m3", dimsNativas: DIMS, batch: 2, dims: [DIMS], doc: (e) => `${e.nombre}\n${e.descripcion}`, query: (q) => q },
  { nombre: "prompt", modelo: "@cf/google/embeddinggemma-300m", dimsNativas: DIMS, batch: 2, dims: [DIMS, 3], doc: (e) => `title: ${e.nombre} | text: ${e.descripcion}`, query: (q) => `task: search result | query: ${q}` },
];

describe("embedModelo", () => {
  const cfg = { accountId: "acc", token: TOKEN };
  it("lotes, orden y suma de neuronas", async () => {
    const s = fakeFetch({ neurons: 5 });
    const r = await embedModelo(cfg, "@cf/m", DIMS, ["a", "b", "c"], 2, s.f, noSleep, () => {});
    expect(r.vecs).toHaveLength(3);
    expect(r.vecs[2]).toEqual(vec("c"));
    expect(r.neuronas).toBe(10);
    expect(s.calls).toHaveLength(2);
    expect(s.calls[0].url).toBe("https://api.cloudflare.com/client/v4/accounts/acc/ai/run/@cf/m");
  });
  it("neuronas ausentes => null", async () => {
    expect((await embedModelo(cfg, "m", DIMS, ["a"], 2, fakeFetch().f, noSleep, () => {})).neuronas).toBeNull();
  });
  it("4xx en un lote: se parte en mitades una vez", async () => {
    const s = fakeFetch({ reject4xxOver: 2 });
    const r = await embedModelo(cfg, "m", DIMS, ["a", "b", "c", "d"], 4, s.f, noSleep, () => {});
    expect(r.vecs).toHaveLength(4);
    expect(s.calls.map((c) => c.body.text.length)).toEqual([4, 2, 2]);
  });
  it("si las mitades tambien fallan => lanza sin el token", async () => {
    const s = fakeFetch({ reject4xxOver: 1 });
    const p = embedModelo(cfg, "m", DIMS, ["a", "b", "c", "d"], 4, s.f, noSleep, () => {});
    await expect(p).rejects.toThrow(/too many/);
    await p.catch((e) => expect(String(e.message)).not.toContain(TOKEN));
  });
  it("dimension o numero de vectores incorrectos => lanza", async () => {
    await expect(embedModelo(cfg, "m", DIMS + 1, ["a"], 2, fakeFetch().f, noSleep, () => {})).rejects.toThrow(/dims/);
    const bad = (async () => json({ success: true, result: { data: [] } })) as typeof fetch;
    await expect(embedModelo(cfg, "m", DIMS, ["a"], 2, bad, noSleep, () => {})).rejects.toThrow(/vectors/);
  });
});

describe("runExperimento", () => {
  it("pipeline completo: estructura, consultas con prompt y sin token", async () => {
    const s = fakeFetch({ neurons: 1 });
    const logs: string[] = [];
    const out = await runExperimento({ accountId: "acc", token: TOKEN, fetchFn: s.f, sleep: noSleep, entries, cases, configs, log: (m) => logs.push(m), ahora: () => new Date("2026-01-02T03:04:05Z") });
    const rep = JSON.parse(out.json);
    expect(rep.fecha).toBe("2026-01-02T03:04:05.000Z");
    expect(rep.documentos).toBe(3);
    expect(rep.configs.map((c: any) => [c.nombre, c.resultados.map((r: any) => r.dim)])).toEqual([["base", [DIMS]], ["prompt", [DIMS, 3]]]);
    expect(rep.configs[0].neuronas).toBeGreaterThan(0);

    expect(rep.configs[0].resultados[0].casos[0].rank).toBeLessThanOrEqual(3);
    expect(s.calls.some((c) => c.body.text.includes("task: search result | query: cocinar"))).toBe(true);
    expect(s.calls.some((c) => c.body.text.includes("title: Alpha | text: scan docker files"))).toBe(true);
    expect(out.md).toContain("| prompt | 3 |");
    for (const str of [out.json, out.md, ...logs]) expect(str).not.toContain(TOKEN);
    expect(s.calls.every((c) => c.auth === `Bearer ${TOKEN}`)).toBe(true);
  });
});
