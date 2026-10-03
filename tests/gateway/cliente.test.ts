import { describe, it, expect } from "vitest";
import { inicializar, listarHerramientas, llamarHerramienta } from "../../src/gateway/cliente";

const URL_D = "https://destino.example/mcp";
const PERMITIDAS = ["content-type", "accept", "mcp-protocol-version", "user-agent", "mcp-session-id"];

interface Call { url: string; init: RequestInit; body: any }
type Handler = (c: Call, n: number) => Response | Promise<Response>;
function fake(h: Handler) {
  const calls: Call[] = [];
  const fn = (async (url: any, init: any) => {
    const c = { url: String(url), init, body: init?.body ? JSON.parse(init.body) : undefined };
    calls.push(c);
    return h(c, calls.length - 1);
  }) as unknown as typeof fetch;
  return { fn, calls };
}
const rpc = (result: unknown, id = 1) => ({ jsonrpc: "2.0", id, result });
const json = (o: unknown, headers: Record<string, string> = {}, status = 200) =>
  new Response(JSON.stringify(o), { status, headers: { "content-type": "application/json", ...headers } });
const sse = (o: unknown, headers: Record<string, string> = {}) =>
  new Response(`: comment\n\nevent: ping\ndata: {"hola":1}\n\nevent: message\ndata: ${JSON.stringify(o)}\n\n`,
    { status: 200, headers: { "content-type": "text/event-stream", ...headers } });
const codigo = async (p: Promise<unknown>) => { try { await p; return "ok"; } catch (e: any) { return e.code; } };

describe("variantes de respuesta", () => {
  for (const [nombre, mk] of [["json", json], ["sse", sse]] as const) {
    it(`${nombre}: initialize, list y call`, async () => {
      const { fn, calls } = fake((c) => {
        if (c.body.method === "initialize") return mk(rpc({ protocolVersion: "x" }), { "Mcp-Session-Id": "S1" });
        if (c.body.method === "notifications/initialized") return new Response(null, { status: 202 });
        if (c.body.method === "tools/list") return mk(rpc({ tools: [{ name: "a" }] }, 2));
        return mk(rpc({ content: [{ type: "text", text: "hi" }], isError: true }, 3));
      });
      const r = await inicializar(URL_D, fn);
      expect(r).toEqual({ sessionId: "S1" });
      expect(await listarHerramientas({ url: URL_D, ...r }, fn)).toEqual([{ name: "a" }]);
      expect(await llamarHerramienta({ url: URL_D, ...r }, "a", { x: 1 }, fn))
        .toEqual({ content: [{ type: "text", text: "hi" }], isError: true });
      expect(calls.map((c) => c.body.method)).toEqual(["initialize", "notifications/initialized", "tools/list", "tools/call"]);
      expect(calls[0].body.params).toEqual({ protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "catalogo-mcp-busqueda", version: "0.1.0" } });
      expect(calls[0].init.headers).not.toHaveProperty("Mcp-Session-Id");
      for (const c of calls.slice(1)) expect((c.init.headers as any)["Mcp-Session-Id"]).toBe("S1");
      expect(calls[3].body).toEqual({ jsonrpc: "2.0", id: 3, method: "tools/call", params: { name: "a", arguments: { x: 1 } } });
      expect(calls[1].body.id).toBeUndefined();
    });
  }

  it("sin session id del servidor no se envía", async () => {
    const { fn, calls } = fake((c) => c.body.method === "initialize" ? json(rpc({})) : new Response(null, { status: 202 }));
    expect(await inicializar(URL_D, fn)).toEqual({});
    expect(calls[1].init.headers).not.toHaveProperty("Mcp-Session-Id");
  });

  it("call sin content válido da content vacío e isError false", async () => {
    const { fn } = fake(() => json(rpc({ content: "x" }, 3)));
    expect(await llamarHerramienta({ url: URL_D }, "a", {}, fn)).toEqual({ content: [], isError: false });
  });

  it("tools no array → destino_caido", async () => {
    const { fn } = fake(() => json(rpc({ tools: "x" }, 2)));
    expect(await codigo(listarHerramientas({ url: URL_D }, fn))).toBe("destino_caido");
  });
});

describe("errores", () => {
  const llamadas: [string, (fn: typeof fetch) => Promise<unknown>][] = [
    ["inicializar", (fn) => inicializar(URL_D, fn)],
    ["listar", (fn) => listarHerramientas({ url: URL_D }, fn)],
    ["llamar", (fn) => llamarHerramienta({ url: URL_D }, "a", {}, fn)],
  ];
  for (const [nombre, run] of llamadas) {
    for (const st of [401, 403]) {
      it(`${nombre} ${st} → requiere_auth`, async () => {
        const { fn } = fake(() => new Response("no", { status: st, headers: { "www-authenticate": "Bearer" } }));
        expect(await codigo(run(fn))).toBe("requiere_auth");
      });
    }
    for (const st of [301, 302, 307]) {
      it(`${nombre} ${st} → destino_caido sin seguir Location`, async () => {
        const { fn, calls } = fake(() => new Response(null, { status: st, headers: { location: "http://127.0.0.1/x" } }));
        expect(await codigo(run(fn))).toBe("destino_caido");
        expect(calls).toHaveLength(1);
        expect(calls[0].init.redirect).toBe("manual");
      });
    }
    for (const n of ["TimeoutError", "AbortError"]) {
      it(`${nombre} ${n} → timeout`, async () => {
        const { fn } = fake(() => { const e = new Error("x"); e.name = n; throw e; });
        expect(await codigo(run(fn))).toBe("timeout");
      });
    }
    it(`${nombre} otro fallo de fetch → destino_caido`, async () => {
      const { fn } = fake(() => { throw new TypeError("boom"); });
      expect(await codigo(run(fn))).toBe("destino_caido");
    });
    const malos: [string, () => Response][] = [
      ["500", () => new Response("x", { status: 500 })],
      ["no JSON", () => new Response("hola", { status: 200, headers: { "content-type": "application/json" } })],
      ["HTML", () => new Response("<html></html>", { status: 200, headers: { "content-type": "text/html" } })],
      ["error JSON-RPC", () => json({ jsonrpc: "2.0", id: 1, error: { code: -1, message: "secreto" } })],
      ["sin result", () => json({ jsonrpc: "2.0", id: 1 })],
      ["vacío", () => new Response("", { status: 200 })],
      ["no es JSON-RPC", () => json([1, 2])],
      ["SSE sin respuesta", () => new Response(": x\n\n", { status: 200, headers: { "content-type": "text/event-stream" } })],
    ];
    for (const [m, mk] of malos) {
      it(`${nombre} ${m} → destino_caido`, async () => {
        const { fn } = fake(mk);
        expect(await codigo(run(fn))).toBe("destino_caido");
      });
    }
  }

  it("el mensaje de error no contiene texto del destino", async () => {
    const { fn } = fake(() => json({ jsonrpc: "2.0", id: 1, error: { message: "secreto" } }));
    try { await inicializar(URL_D, fn); } catch (e: any) { expect(e.message).not.toContain("secreto"); }
  });

  it("cuerpo de 1 MB se corta y el stream se cancela", async () => {
    let cancelado = false, leidos = 0;
    const chunk = new Uint8Array(64 * 1024).fill(97);
    const stream = new ReadableStream<Uint8Array>({
      pull(c) { if (leidos >= 16) return c.close(); leidos++; c.enqueue(chunk); },
      cancel() { cancelado = true; },
    });
    const { fn } = fake(() => new Response(stream, { status: 200, headers: { "content-type": "application/json" } }));
    expect(await codigo(listarHerramientas({ url: URL_D }, fn))).toBe("destino_caido");
    expect(cancelado).toBe(true);
    expect(leidos).toBeLessThan(16);
  });

  it("fallo del notifications/initialized (incluso 401) se ignora", async () => {
    for (const st of [401, 500]) {
      const { fn } = fake((c) => c.body.method === "initialize" ? json(rpc({})) : new Response("x", { status: st }));
      expect(await inicializar(URL_D, fn)).toEqual({});
    }
    const { fn } = fake((c) => { if (c.body.method === "initialize") return json(rpc({})); throw new Error("x"); });
    expect(await inicializar(URL_D, fn)).toEqual({});
  });
});

describe("cabeceras", () => {
  it("solo cabeceras permitidas, POST, redirect manual y signal", async () => {
    const { fn, calls } = fake((c) => {
      if (c.body.method === "initialize") return json(rpc({}), { "Mcp-Session-Id": "S" });
      if (c.body.method === "notifications/initialized") return new Response(null, { status: 202 });
      if (c.body.method === "tools/list") return json(rpc({ tools: [] }, 2));
      return json(rpc({ content: [] }, 3));
    });
    const r = await inicializar(URL_D, fn);
    await listarHerramientas({ url: URL_D, ...r }, fn);
    await llamarHerramienta({ url: URL_D, ...r }, "a", {}, fn);
    expect(calls).toHaveLength(4);
    for (const c of calls) {
      expect(c.url).toBe(URL_D);
      expect(c.init.method).toBe("POST");
      expect(c.init.redirect).toBe("manual");
      expect(c.init.signal).toBeInstanceOf(AbortSignal);
      const h = c.init.headers as Record<string, string>;
      for (const k of Object.keys(h)) expect(PERMITIDAS).toContain(k.toLowerCase());
      expect(h["Accept"]).toBe("application/json, text/event-stream");
      expect(h["MCP-Protocol-Version"]).toBe("2025-06-18");
      expect(h["Content-Type"]).toBe("application/json");
      expect(h["User-Agent"]).toBe("catalogo-mcp-busqueda/0.1 (+gateway)");
    }
  });
});

describe("endurecimiento", () => {
  const largo = "a".repeat(257);
  for (const [n, v] of [["demasiado largo", largo], ["con espacio", "a b"], ["con caracteres no ASCII", "añ"]] as const) {
    it(`Mcp-Session-Id ${n} se trata como sin sesión`, async () => {
      const { fn, calls } = fake((c) => c.body.method === "initialize" ? json(rpc({}), { "Mcp-Session-Id": v }) : new Response(null, { status: 202 }));
      expect(await inicializar(URL_D, fn)).toEqual({});
      expect(calls[1].init.headers).not.toHaveProperty("Mcp-Session-Id");
    });
  }
  it("Mcp-Session-Id de 256 caracteres válidos se acepta", async () => {
    const ok = "a".repeat(256);
    const { fn } = fake((c) => c.body.method === "initialize" ? json(rpc({}), { "Mcp-Session-Id": ok }) : new Response(null, { status: 202 }));
    expect(await inicializar(URL_D, fn)).toEqual({ sessionId: ok });
  });
  it("id JSON distinto del de la petición → destino_caido", async () => {
    const { fn } = fake(() => json(rpc({ tools: [] }, 99)));
    expect(await codigo(listarHerramientas({ url: URL_D }, fn))).toBe("destino_caido");
  });
  it("SSE salta eventos con otro id y usa el correcto", async () => {
    const cuerpo = `data: ${JSON.stringify(rpc({ tools: [{ name: "malo" }] }, 77))}\n\ndata: ${JSON.stringify(rpc({ tools: [{ name: "bueno" }] }, 2))}\n\n`;
    const { fn } = fake(() => new Response(cuerpo, { status: 200, headers: { "content-type": "text/event-stream" } }));
    expect(await listarHerramientas({ url: URL_D }, fn)).toEqual([{ name: "bueno" }]);
  });
  it("SSE con solo ids ajenos → destino_caido", async () => {
    const { fn } = fake(() => new Response(`data: ${JSON.stringify(rpc({ tools: [] }, 77))}\n\n`, { status: 200, headers: { "content-type": "text/event-stream" } }));
    expect(await codigo(listarHerramientas({ url: URL_D }, fn))).toBe("destino_caido");
  });
  it("content-type en mayúsculas", async () => {
    const { fn } = fake(() => new Response(`data: ${JSON.stringify(rpc({ tools: [] }, 2))}\n\n`, { status: 200, headers: { "content-type": "Text/Event-Stream; charset=utf-8" } }));
    expect(await listarHerramientas({ url: URL_D }, fn)).toEqual([]);
  });
  it("data multilínea se une con \n", async () => {
    const j = JSON.stringify(rpc({ tools: [{ name: "m" }] }, 2), null, 1).split("\n");
    const cuerpo = j.map((l) => `data: ${l}`).join("\n") + "\n\n";
    const { fn } = fake(() => new Response(cuerpo, { status: 200, headers: { "content-type": "text/event-stream" } }));
    expect(await listarHerramientas({ url: URL_D }, fn)).toEqual([{ name: "m" }]);
  });
});
