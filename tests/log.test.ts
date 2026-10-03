import { describe, it, expect, vi } from "vitest";
import { logBusqueda, logLlamada } from "../src/log";

describe("logLlamada", () => {
  it("clave llamadas/fecha/epoch-hex, campos exactos, truncado, sin identidad", async () => {
    const put = vi.fn(async () => null);
    const now = new Date("2026-10-02T12:00:00.123Z");
    await logLlamada({ put } as any, { servidor: "s".repeat(300), herramienta: "h".repeat(300), marca: "solo_lectura", resultado: "ok", ms: 12 }, now);
    await logLlamada({ put } as any, { servidor: "a", herramienta: "b", resultado: "timeout", ms: 1 }, now);
    const [k, body] = put.mock.calls[0] as unknown as [string, string];
    expect(k).toMatch(/^llamadas\/2026-10-02\/1790942400123-[0-9a-f]{8}\.json$/);
    const o = JSON.parse(body);
    expect(Object.keys(o).sort()).toEqual(["herramienta", "marca", "ms", "resultado", "servidor", "ts"]);
    expect(o.servidor).toHaveLength(200);
    expect(o.herramienta).toHaveLength(200);
    expect(Object.keys(JSON.parse((put.mock.calls[1] as unknown as [string, string])[1])).sort()).toEqual(["herramienta", "ms", "resultado", "servidor", "ts"]);
  });
});

describe("logBusqueda", () => {
  it("escribe un objeto nuevo por búsqueda, sin datos identificativos", async () => {
    const put = vi.fn(async () => null);
    const now = new Date("2026-10-02T12:00:00.123Z");
    await logBusqueda({ put } as any, { consulta: "x".repeat(900), filtros: { auth: "clave" }, n_resultados: 3 }, now);
    await logBusqueda({ put } as any, { consulta: "y", n_resultados: 0 }, now);
    const [k1, body] = put.mock.calls[0] as unknown as [string, string];
    const k2 = (put.mock.calls[1] as unknown as [string])[0];
    expect(k1).toMatch(/^busquedas\/2026-10-02\/1790942400123-[0-9a-f]{8}\.json$/);
    expect(k1).not.toBe(k2);
    const o = JSON.parse(body);
    expect(Object.keys(o).sort()).toEqual(["consulta", "filtros", "n_resultados", "ts"]);
    expect(o.consulta).toHaveLength(500);
    expect(o.ts).toBe("2026-10-02T12:00:00.123Z");
  });
});
