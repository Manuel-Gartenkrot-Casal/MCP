import { describe, it, expect } from "vitest";
import { embedWorkersAI, vectorizeUpsert, EMBEDDING_DIMS } from "../../src/ingest/cloudflare";

const TOKEN = "SECRET-TOKEN-123";
const json = (b: unknown, status = 200) => new Response(JSON.stringify(b), { status });

function spy(resp: () => Response) {
  const calls: { url: string; init: any }[] = [];
  const f = (async (url: any, init: any) => { calls.push({ url: String(url), init }); return resp(); }) as typeof fetch;
  return { f, calls };
}

describe("embedWorkersAI", () => {
  const vec = Array(EMBEDDING_DIMS).fill(0.5);
  it("URL, auth, body y vector", async () => {
    const s = spy(() => json({ success: true, result: { data: [vec] } }));
    const out = await embedWorkersAI({ accountId: "acc", token: TOKEN }, s.f)("hola");
    expect(out).toHaveLength(EMBEDDING_DIMS);
    expect(s.calls[0].url).toBe("https://api.cloudflare.com/client/v4/accounts/acc/ai/run/@cf/baai/bge-m3");
    expect(s.calls[0].init.headers.Authorization).toBe(`Bearer ${TOKEN}`);
    expect(JSON.parse(s.calls[0].init.body)).toEqual({ text: ["hola"] });
  });
  it("dimension distinta => lanza", async () => {
    const s = spy(() => json({ success: true, result: { data: [[1, 2, 3]] } }));
    await expect(embedWorkersAI({ accountId: "a", token: TOKEN }, s.f)("x")).rejects.toThrow(/1024/);
  });
  it("error sin filtrar el token", async () => {
    const s = spy(() => json({ success: false, errors: [{ message: "bad auth" }] }, 403));
    const err: Error = await embedWorkersAI({ accountId: "a", token: TOKEN }, s.f)("x").catch((e) => e);
    expect(err.message).toContain("403");
    expect(err.message).toContain("bad auth");
    expect(err.message).not.toContain(TOKEN);
  });
});

describe("vectorizeUpsert", () => {
  it("URL, auth, NDJSON", async () => {
    const s = spy(() => json({ success: true, result: { mutationId: "m" } }));
    await vectorizeUpsert({ accountId: "acc", index: "idx", token: TOKEN }, s.f)("id1", [1, 2]);
    expect(s.calls[0].url).toBe("https://api.cloudflare.com/client/v4/accounts/acc/vectorize/v2/indexes/idx/upsert");
    expect(s.calls[0].init.headers.Authorization).toBe(`Bearer ${TOKEN}`);
    expect(s.calls[0].init.headers["Content-Type"]).toBe("application/x-ndjson");
    expect(s.calls[0].init.body).toBe('{"id":"id1","values":[1,2]}\n');
  });
  it("success false => lanza sin token", async () => {
    const s = spy(() => json({ success: false, errors: [{ message: "nope" }] }, 400));
    const err: Error = await vectorizeUpsert({ accountId: "a", index: "i", token: TOKEN }, s.f)("i", [1]).catch((e) => e);
    expect(err.message).toMatch(/400.*nope/);
    expect(err.message).not.toContain(TOKEN);
  });
});
