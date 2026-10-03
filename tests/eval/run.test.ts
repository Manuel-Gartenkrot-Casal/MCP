import { describe, it, expect, vi } from "vitest";
import { rerankWorkersAI, collect } from "../../eval/run";

describe("rerankWorkersAI", () => {
  const cfg = { accountId: "ACC", token: "SECRET-TOKEN" };
  it("POST al endpoint, desenvuelve result y aplica sigmoide", async () => {
    const f = vi.fn(async () => Response.json({ success: true, result: [{ id: 1, score: 0 }, { id: 0, score: 0 }] }));
    const r = await rerankWorkersAI(cfg, f as any)("q", ["a", "b"]);
    expect(r).toEqual([0.5, 0.5]);
    const [url, init] = f.mock.calls[0] as any;
    expect(url).toBe("https://api.cloudflare.com/client/v4/accounts/ACC/ai/run/@cf/baai/bge-reranker-base");
    expect(init.headers.Authorization).toBe("Bearer SECRET-TOKEN");
    expect(JSON.parse(init.body)).toEqual({ query: "q", contexts: [{ text: "a" }, { text: "b" }] });
  });
  it("errores sin token", async () => {
    const f = async () => Response.json({ success: false }, { status: 500 });
    await expect(rerankWorkersAI(cfg, f as any)("q", ["a"])).rejects.toThrow(/HTTP 500/);
    await rerankWorkersAI(cfg, f as any)("q", ["a"]).catch((e) => expect(String(e.message)).not.toContain("SECRET"));
    const bad = async () => Response.json({ success: true, result: { x: 1 } });
    await expect(rerankWorkersAI(cfg, bad as any)("q", ["a"])).rejects.toThrow();
  });
});

describe("collect", () => {
  const e = (id: string) => ({ id, nombre: id, descripcion: "d", url_info: null, tipo_conexion: "remoto", como_conectar: "c", auth: "ninguna", incompleta: false, actualizado: "" } as const);
  const mk = (rerank: (q: string, t: string[]) => Promise<number[]>) => ({
    embed: async () => [1],
    getEntries: async (ids: string[]) => ids.filter((i) => i !== "huerfano").map(e),
    query: async () => [{ id: "a", score: 0.9 }, { id: "huerfano", score: 0.8 }, { id: "b", score: 0.7 }],
    rerank,
  });
  it("devuelve hits vectoriales y reordenados (ids alineados con puntajes) compartiendo la consulta", async () => {
    const d = mk(async () => [0.1, 0.9]);
    const spy = vi.spyOn(d, "query");
    const r = await collect(d, "x");
    expect(r.vector.map((h) => h.id)).toEqual(["a", "huerfano", "b"]);
    expect(r.reranked).toEqual([{ id: "b", score: 0.9 }, { id: "a", score: 0.1 }]);
    expect(spy).toHaveBeenCalledTimes(1);
  });
  it("si el reranker falla, lanza en vez de medir el orden vectorial como reranked", async () => {
    await expect(collect(mk(async () => { throw new Error("x"); }), "x")).rejects.toThrow(/rerank/);
  });
});
