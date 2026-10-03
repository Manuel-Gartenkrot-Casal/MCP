import { describe, it, expect } from "vitest";
import { SesionDO, TTL_MS } from "../../src/gateway/sesion";
import { fakeDOState } from "../stubs/fake-do-state";

const URL_D = "https://destino.example/mcp";
const rpc = (result: unknown, id: number) => ({ jsonrpc: "2.0", id, result });
const json = (o: unknown, h: Record<string, string> = {}) =>
  new Response(JSON.stringify(o), { status: 200, headers: { "content-type": "application/json", ...h } });

const TOOLS = [
  { name: "leer", annotations: { readOnlyHint: true } },
  { name: "borrar", annotations: { destructiveHint: true } },
  { name: "raro" },
  { name: "nombre malo!" },
];

function montar(extra?: (c: any) => Response | undefined) {
  const calls: any[] = [];
  const fn = (async (url: any, init: any) => {
    const body = JSON.parse(init.body);
    calls.push({ url: String(url), body, headers: init.headers });
    const e = extra?.({ body, headers: init.headers });
    if (e) return e;
    switch (body.method) {
      case "initialize": return json(rpc({}, 1), { "Mcp-Session-Id": "S1" });
      case "notifications/initialized": return new Response(null, { status: 202 });
      case "tools/list": return json(rpc({ tools: TOOLS }, 2));
      default: return json(rpc({ content: [{ type: "text", text: "ok" }], isError: false }, 3));
    }
  }) as unknown as typeof fetch;
  const st = fakeDOState();
  const d = new SesionDO(st, {});
  d.fetchFn = fn;
  return { d, st, calls };
}
const metodos = (calls: any[]) => calls.map((c) => c.body.method);
const llamarD = (d: SesionDO, h: string) => d.llamar("srv", URL_D, h, {}, false);

describe("explorar", () => {
  it("guarda sesión y herramientas, devuelve solo las de nombre válido", async () => {
    const { d, st } = montar();
    const r: any = await d.explorar("srv", URL_D);
    expect(r.ok).toBe(true);
    expect(r.valor.map((t: any) => t.nombre)).toEqual(["leer", "borrar", "raro"]);
    expect(st.data.get("servidor")).toBe("srv");
    expect(st.data.get("mcpSession")).toBe("S1");
    expect((st.data.get("tools") as any[]).map((t) => t.marca)).toEqual(["solo_lectura", "destructiva", "sin_declarar"]);
    expect(typeof st.data.get("ultimoUso")).toBe("number");
    expect(st.alarm()).toBeGreaterThan(Date.now() + TTL_MS - 5000);
  });
  // Cambiado (fix D): una explorar explícita siempre reinicializa y guarda la sesión nueva (recupera sesiones olvidadas por el destino).
  it("segunda explorar del mismo servidor reinicializa y guarda la sesión nueva", async () => {
    let n = 0;
    const { d, st, calls } = montar((c) => c.body.method === "initialize" ? json(rpc({}, 1), { "Mcp-Session-Id": "S" + ++n }) : undefined);
    await d.explorar("srv", URL_D);
    await d.explorar("srv", URL_D);
    expect(metodos(calls)).toEqual(["initialize", "notifications/initialized", "tools/list", "initialize", "notifications/initialized", "tools/list"]);
    expect(calls[5].headers["Mcp-Session-Id"]).toBe("S2");
    expect(st.data.get("mcpSession")).toBe("S2");
  });
  it("reexplorar sin Mcp-Session-Id borra la sesión vieja", async () => {
    let n = 0;
    const { d, st } = montar((c) => c.body.method === "initialize" ? json(rpc({}, 1), n++ ? {} : { "Mcp-Session-Id": "S1" }) : undefined);
    await d.explorar("srv", URL_D);
    await d.explorar("srv", URL_D);
    expect(st.data.has("mcpSession")).toBe(false);
  });
  it("sesión olvidada por el destino: llamar → sesion_expirada; explorar con el mismo token la recupera", async () => {
    let n = 0;
    const { d, calls } = montar((c) => {
      if (c.body.method === "initialize") return json(rpc({}, 1), { "Mcp-Session-Id": "S" + ++n });
      if (c.body.method === "tools/call" && c.headers["Mcp-Session-Id"] === "S1") return new Response("gone", { status: 404 });
      return undefined;
    });
    await d.explorar("srv", URL_D);
    expect(await llamarD(d, "leer")).toEqual({ ok: false, code: "sesion_expirada" });
    expect((await d.explorar("srv", URL_D)).ok).toBe(true);
    expect((await llamarD(d, "leer")).ok).toBe(true);
    expect(calls.at(-1).headers["Mcp-Session-Id"]).toBe("S2");
  });
  it("caché de herramientas acotada a 500", async () => {
    const muchas = Array.from({ length: 600 }, (_, i) => ({ name: "t" + i }));
    const { d, st } = montar((c) => c.body.method === "tools/list" ? json(rpc({ tools: muchas }, 2)) : undefined);
    const r: any = await d.explorar("srv", URL_D);
    expect(r.ok).toBe(true);
    expect((st.data.get("tools") as any[]).length).toBe(500);
  });
  it("put que falla: la alarma ya está puesta, nada guardado, error sin rechazar", async () => {
    const { d, st } = montar();
    st.storage.put = async () => { throw new Error("storage down"); };
    expect(await d.explorar("srv", URL_D)).toEqual({ ok: false, code: "destino_caido" });
    expect(st.data.size).toBe(0);
    expect(st.alarm()).toBeGreaterThan(Date.now() + TTL_MS - 5000);
  });
  it("renovación en llamar: setAlarm antes del put", async () => {
    const { d, st } = montar();
    await d.explorar("srv", URL_D);
    await st.storage.setAlarm(1);
    st.storage.put = async () => { throw new Error("storage down"); };
    const r: any = await llamarD(d, "leer");
    expect(r.ok).toBe(false);
    expect(st.alarm()).toBeGreaterThan(Date.now() + TTL_MS - 5000);
  });
  it("guarda la versión negociada y la usa en llamar", async () => {
    const { d, st, calls } = montar((c) => c.body.method === "initialize" ? json(rpc({ protocolVersion: "2025-03-26" }, 1), { "Mcp-Session-Id": "S1" }) : undefined);
    await d.explorar("srv", URL_D);
    expect(st.data.get("version")).toBe("2025-03-26");
    await llamarD(d, "leer");
    expect(calls.at(-1).headers["MCP-Protocol-Version"]).toBe("2025-03-26");
  });
  it("otro servidor → sesion_otro_servidor sin red", async () => {
    const { d, calls } = montar();
    await d.explorar("srv", URL_D);
    const n = calls.length;
    expect(await d.explorar("otro", URL_D)).toEqual({ ok: false, code: "sesion_otro_servidor" });
    expect(calls).toHaveLength(n);
  });
  it("url no https → no_remoto sin red", async () => {
    const { d, calls } = montar();
    expect(await d.explorar("srv", "http://x.example/")).toEqual({ ok: false, code: "no_remoto" });
    expect(await d.explorar("srv", undefined as any)).toEqual({ ok: false, code: "no_remoto" });
    expect(calls).toHaveLength(0);
  });
  it("GatewayError del cliente → {ok:false, code}", async () => {
    const { d } = montar(() => new Response("no", { status: 401 }));
    expect(await d.explorar("srv", URL_D)).toEqual({ ok: false, code: "requiere_auth" });
  });
  it("error inesperado → destino_caido", async () => {
    const { d } = montar();
    d.fetchFn = (async () => { throw new TypeError("boom"); }) as any;
    expect(await d.explorar("srv", URL_D)).toEqual({ ok: false, code: "destino_caido" });
  });
  it("una explorar fallida no persiste nada y el token puede explorar otro servidor", async () => {
    let fallar = true;
    const { d, st } = montar((c) => (fallar && c.body.method === "tools/list" ? new Response("x", { status: 500 }) : undefined));
    expect(await d.explorar("srv", URL_D)).toEqual({ ok: false, code: "destino_caido" });
    expect(st.data.size).toBe(0);
    expect(st.alarm()).toBeNull();
    fallar = false;
    expect((await d.explorar("otro", URL_D)).ok).toBe(true);
    expect(st.data.get("servidor")).toBe("otro");
  });
});

describe("llamar", () => {
  const llamar = (d: SesionDO, h: string, conf = false, srv = "srv") => d.llamar(srv, URL_D, h, { a: 1 }, conf);
  it("sin explorar → sesion_expirada", async () => {
    const { d, calls } = montar();
    expect(await llamar(d, "leer")).toEqual({ ok: false, code: "sesion_expirada" });
    expect(calls).toHaveLength(0);
  });
  it("otro servidor → sesion_otro_servidor sin red", async () => {
    const { d, calls } = montar();
    await d.explorar("srv", URL_D);
    const n = calls.length;
    expect(await llamar(d, "leer", false, "otro")).toEqual({ ok: false, code: "sesion_otro_servidor" });
    expect(calls).toHaveLength(n);
  });
  it("herramienta fuera de la caché → herramienta_inexistente sin red", async () => {
    const { d, calls } = montar();
    await d.explorar("srv", URL_D);
    const n = calls.length;
    expect(await llamar(d, "nada")).toEqual({ ok: false, code: "herramienta_inexistente" });
    expect(calls).toHaveLength(n);
  });
  it("solo_lectura llama directo con la sesión guardada", async () => {
    const { d, calls } = montar();
    await d.explorar("srv", URL_D);
    const r: any = await llamar(d, "leer");
    expect(r).toEqual({ ok: true, valor: { content: [{ type: "text", text: "ok" }], isError: false, marca: "solo_lectura" } });
    const c = calls.at(-1);
    expect(c.body.params).toEqual({ name: "leer", arguments: { a: 1 } });
    expect(c.headers["Mcp-Session-Id"]).toBe("S1");
  });
  for (const [h, marca] of [["borrar", "destructiva"], ["raro", "sin_declarar"]] as const) {
    it(`${marca} sin confirmar → confirmar sin red; con confirmar:true llama`, async () => {
      const { d, calls } = montar();
      await d.explorar("srv", URL_D);
      const n = calls.length;
      expect(await llamar(d, h)).toEqual({ ok: false, code: "confirmar", marca });
      expect(await llamar(d, h, "true" as any)).toEqual({ ok: false, code: "confirmar", marca });
      expect(calls).toHaveLength(n);
      const r: any = await llamar(d, h, true);
      expect(r.ok).toBe(true);
      expect(r.valor.marca).toBe(marca);
      expect(calls).toHaveLength(n + 1);
    });
  }
  it("renueva ultimoUso y la alarma", async () => {
    const { d, st } = montar();
    await d.explorar("srv", URL_D);
    await st.storage.setAlarm(1);
    await st.storage.put("ultimoUso", 1);
    await llamar(d, "leer");
    expect(st.alarm()).toBeGreaterThan(Date.now() + TTL_MS - 5000);
    expect(st.data.get("ultimoUso")).toBeGreaterThan(1);
  });
  it("GatewayError del cliente → {ok:false, code}", async () => {
    const { d } = montar();
    await d.explorar("srv", URL_D);
    d.fetchFn = (async () => new Response("no", { status: 403 })) as any;
    expect(await llamar(d, "leer")).toEqual({ ok: false, code: "requiere_auth" });
  });
  it("tras alarm() el almacenamiento queda vacío y llamar → sesion_expirada", async () => {
    const { d, st } = montar();
    await d.explorar("srv", URL_D);
    await d.alarm();
    expect(st.data.size).toBe(0);
    expect(await llamar(d, "leer")).toEqual({ ok: false, code: "sesion_expirada" });
  });
});

describe("concurrencia", () => {
  const deferred = () => { let ok!: () => void; const p = new Promise<void>((r) => { ok = r; }); return { p, ok }; };
  // fetch cuyo tools/list de la primera exploración espera a una puerta
  function conPuerta() {
    const gate = deferred();
    const calls: any[] = [];
    let n = 0;
    const fn = (async (url: any, init: any) => {
      const body = JSON.parse(init.body);
      calls.push({ url: String(url), body, headers: init.headers });
      switch (body.method) {
        case "initialize": return json(rpc({}, 1), { "Mcp-Session-Id": "S" + ++n });
        case "notifications/initialized": return new Response(null, { status: 202 });
        case "tools/list": if (calls.filter((c) => c.body.method === "tools/list").length === 1) await gate.p;
          return json(rpc({ tools: [{ name: "t" + n, annotations: { readOnlyHint: true } }] }, 2));
        default: return json(rpc({ content: [], isError: false }, 3));
      }
    }) as unknown as typeof fetch;
    const st = fakeDOState();
    const d = new SesionDO(st, {});
    d.fetchFn = fn;
    return { d, st, calls, gate };
  }
  const tick = () => new Promise((r) => setTimeout(r, 5));

  it("dos explorar concurrentes de servidores distintos: gana el primero, el otro sesion_otro_servidor", async () => {
    const { d, st, calls, gate } = conPuerta();
    const a = d.explorar("X", URL_D), b = d.explorar("Y", URL_D);
    await tick(); gate.ok();
    const [ra, rb]: any[] = await Promise.all([a, b]);
    expect(ra.ok).toBe(true);
    expect(rb).toEqual({ ok: false, code: "sesion_otro_servidor" });
    expect(calls.filter((c) => c.body.method === "initialize")).toHaveLength(1);
    expect(st.data.get("servidor")).toBe("X");
    expect(st.data.get("mcpSession")).toBe("S1");
    expect((st.data.get("tools") as any[]).map((t) => t.nombre)).toEqual(["t1"]);
  });
  // Cambiado (fix D): la segunda explorar ya no reutiliza; se serializa y reinicializa (S2 queda guardada).
  it("dos explorar concurrentes del mismo servidor: serializadas, la segunda reinicializa", async () => {
    const { d, st, calls, gate } = conPuerta();
    const a = d.explorar("X", URL_D), b = d.explorar("X", URL_D);
    await tick();
    expect(calls.filter((c) => c.body.method === "initialize")).toHaveLength(1);
    gate.ok();
    const [ra, rb]: any[] = await Promise.all([a, b]);
    expect(ra.ok && rb.ok).toBe(true);
    expect(calls.filter((c) => c.body.method === "initialize")).toHaveLength(2);
    expect(calls.at(-1).headers["Mcp-Session-Id"]).toBe("S2");
    expect(st.data.get("mcpSession")).toBe("S2");
  });
  it("un fallo de la llamada anterior no envenena la cola", async () => {
    const { d } = montar();
    let primera = true;
    const f0 = d.fetchFn;
    d.fetchFn = (async (u: any, i: any) => { if (primera) { primera = false; throw new TypeError("x"); } return f0(u, i); }) as any;
    const a = d.explorar("X", URL_D), b = d.explorar("X", URL_D);
    expect(await a).toEqual({ ok: false, code: "destino_caido" });
    expect((await b).ok).toBe(true);
  });
  it("llamar concurrente con explorar se serializa", async () => {
    const { d, gate, calls } = conPuerta();
    const a = d.explorar("X", URL_D), b = d.llamar("X", URL_D, "t1", {}, false);
    await tick();
    expect(calls.some((c) => c.body.method === "tools/call")).toBe(false);
    gate.ok();
    const [ra, rb]: any[] = await Promise.all([a, b]);
    expect(ra.ok).toBe(true);
    expect(rb.ok).toBe(true);
  });
  it("alarma durante un llamar en vuelo: el almacenamiento queda vacío tras la llamada", async () => {
    const { d, st } = montar();
    await d.explorar("srv", URL_D);
    const f0 = d.fetchFn;
    d.fetchFn = (async (u: any, i: any) => { await d.alarm(); return f0(u, i); }) as any;
    const r: any = await d.llamar("srv", URL_D, "leer", {}, false);
    expect(r.ok).toBe(true);
    expect(st.data.size).toBe(0);
  });
  it("llamar con url no https → no_remoto sin red", async () => {
    const { d, calls } = montar();
    expect(await d.llamar("srv", "http://x.example/", "leer", {}, false)).toEqual({ ok: false, code: "no_remoto" });
    expect(calls).toHaveLength(0);
  });
});
