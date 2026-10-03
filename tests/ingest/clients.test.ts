import { describe, it, expect } from "vitest";
import { embedWorkersAI, vectorizeUpsert } from "../../src/ingest/cloudflare";
import { EMBED_DIMS, EMBED_NATIVE_DIMS } from "../../src/embedding";

const TOKEN = "SECRET-TOKEN-123";
const json = (b: unknown, status = 200, headers?: HeadersInit) => new Response(JSON.stringify(b), { status, headers });
const noSleep = async () => {};

function spy(resp: () => Response) {
  const calls: { url: string; init: any }[] = [];
  const f = (async (url: any, init: any) => { calls.push({ url: String(url), init }); return resp(); }) as typeof fetch;
  return { f, calls };
}
function seq(...rs: (() => Response)[]) {
  let i = 0;
  return spy(() => rs[Math.min(i++, rs.length - 1)]());
}

describe("embedWorkersAI", () => {
  const vec = Array(EMBED_NATIVE_DIMS).fill(0.5);
  it("URL, auth, body en lote y un vector reducido (EMBED_DIMS, norma 1) por texto", async () => {
    const s = spy(() => json({ success: true, result: { shape: [2, EMBED_NATIVE_DIMS], data: [vec, vec] } }));
    const out = await embedWorkersAI({ accountId: "acc", token: TOKEN }, s.f, noSleep)(["hola", "adiós"]);
    expect(out).toHaveLength(2);
    expect(out[1]).toHaveLength(EMBED_DIMS);
    expect(Math.hypot(...out[1])).toBeCloseTo(1, 6);
    expect(s.calls).toHaveLength(1);
    expect(s.calls[0].url).toBe("https://api.cloudflare.com/client/v4/accounts/acc/ai/run/@cf/google/embeddinggemma-300m");
    expect(s.calls[0].init.headers.Authorization).toBe(`Bearer ${TOKEN}`);
    expect(JSON.parse(s.calls[0].init.body)).toEqual({ text: ["hola", "adiós"] });
  });
  it("dimension distinta en cualquier vector (p. ej. 1024 de bge-m3) => lanza", async () => {
    const s = spy(() => json({ success: true, result: { data: [vec, [1, 2, 3]] } }));
    await expect(embedWorkersAI({ accountId: "a", token: TOKEN }, s.f, noSleep)(["x", "y"])).rejects.toThrow(/768/);
    const s2 = spy(() => json({ success: true, result: { data: [Array(1024).fill(0.5)] } }));
    await expect(embedWorkersAI({ accountId: "a", token: TOKEN }, s2.f, noSleep)(["x"])).rejects.toThrow(/768/);
  });
  it("número de vectores distinto al de textos => lanza", async () => {
    const s = spy(() => json({ success: true, result: { data: [vec] } }));
    await expect(embedWorkersAI({ accountId: "a", token: TOKEN }, s.f, noSleep)(["x", "y"])).rejects.toThrow(/2 vectors/);
    const s2 = spy(() => json({ success: true, result: { data: "nope" } }));
    await expect(embedWorkersAI({ accountId: "a", token: TOKEN }, s2.f, noSleep)(["x"])).rejects.toThrow(/vectors/);
  });
  it("error sin filtrar el token", async () => {
    const s = spy(() => json({ success: false, errors: [{ message: "bad auth" }] }, 403));
    const err: Error = await embedWorkersAI({ accountId: "a", token: TOKEN }, s.f, noSleep)(["x"]).catch((e) => e);
    expect(err.message).toContain("403");
    expect(err.message).toContain("bad auth");
    expect(err.message).not.toContain(TOKEN);
    expect(s.calls).toHaveLength(1); // 4xx distinto de 429: sin reintento
  });
});

describe("reintentos (429 / 5xx)", () => {
  const vec = Array(EMBED_NATIVE_DIMS).fill(0.5);
  const okEmbed = () => json({ success: true, result: { data: [vec] } });
  it("429 y luego éxito: reintenta con backoff exponencial", async () => {
    const sleeps: number[] = [];
    const s = seq(() => json({}, 429), () => json({}, 503), okEmbed);
    const out = await embedWorkersAI({ accountId: "a", token: TOKEN }, s.f, async (ms) => { sleeps.push(ms); })(["x"]);
    expect(out).toHaveLength(1);
    expect(s.calls).toHaveLength(3);
    expect(sleeps).toEqual([1000, 2000]);
  });
  it("respeta Retry-After (segundos)", async () => {
    const sleeps: number[] = [];
    const s = seq(() => json({}, 429, { "Retry-After": "7" }), okEmbed);
    await embedWorkersAI({ accountId: "a", token: TOKEN }, s.f, async (ms) => { sleeps.push(ms); })(["x"]);
    expect(sleeps).toEqual([7000]);
  });
  it("Retry-After enorme se limita a 300 s; HTTP-date/NaN cae al backoff", async () => {
    const sleeps: number[] = [];
    const s = seq(() => json({}, 429, { "Retry-After": "99999" }), () => json({}, 429, { "Retry-After": "Wed, 21 Oct 2026 07:28:00 GMT" }), okEmbed);
    await embedWorkersAI({ accountId: "a", token: TOKEN }, s.f, async (ms) => { sleeps.push(ms); })(["x"]);
    expect(sleeps).toEqual([300000, 2000]);
  });
  it("agota 3 reintentos => lanza con el estado y sin token", async () => {
    const s = spy(() => json({ success: false, errors: [{ message: "busy" }] }, 500));
    const err: Error = await vectorizeUpsert({ accountId: "a", index: "i", token: TOKEN }, s.f, noSleep)([{ id: "i", values: [1] }]).catch((e) => e);
    expect(s.calls).toHaveLength(4);
    expect(err.message).toMatch(/500/);
    expect(err.message).not.toContain(TOKEN);
  });
});

describe("vectorizeUpsert", () => {
  it("URL, auth, NDJSON con una línea por vector en una sola petición", async () => {
    const s = spy(() => json({ success: true, result: { mutationId: "m" } }));
    await vectorizeUpsert({ accountId: "acc", index: "idx", token: TOKEN }, s.f, noSleep)([
      { id: "id1", values: [1, 2] }, { id: "id2", values: [3, 4] },
    ]);
    expect(s.calls).toHaveLength(1);
    expect(s.calls[0].url).toBe("https://api.cloudflare.com/client/v4/accounts/acc/vectorize/v2/indexes/idx/upsert");
    expect(s.calls[0].init.headers.Authorization).toBe(`Bearer ${TOKEN}`);
    expect(s.calls[0].init.headers["Content-Type"]).toBe("application/x-ndjson");
    expect(s.calls[0].init.body).toBe('{"id":"id1","values":[1,2]}\n{"id":"id2","values":[3,4]}\n');
  });
  it("success false => lanza sin token", async () => {
    const s = spy(() => json({ success: false, errors: [{ message: "nope" }] }, 400));
    const err: Error = await vectorizeUpsert({ accountId: "a", index: "i", token: TOKEN }, s.f, noSleep)([{ id: "i", values: [1] }]).catch((e) => e);
    expect(err.message).toMatch(/400.*nope/);
    expect(err.message).not.toContain(TOKEN);
  });
});
