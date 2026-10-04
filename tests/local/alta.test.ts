import { describe, it, expect } from "vitest";
import { ejecutarAlta, type Deps } from "../../local/alta";
import { SERVICIOS } from "../../src/servicios";

const EMAIL = "secreto@ejemplo.com";
const PW = "PwSecreta-123";

function fake(o: { resp?: string[]; res?: "enviado" | "no_encontrado"; conex?: Map<string, any> | "falla"; codigo?: number; abreFalla?: boolean } = {}) {
  const calls: string[] = [], textos: string[] = [], ejecutadas: [string, string[]][] = [], marcadas: [string, string][] = [];
  const resp = [...(o.resp ?? [])];
  const deps: Deps = {
    preguntar: async (m) => { textos.push(m); calls.push("preguntar"); return resp.shift() ?? ""; },
    abrir: async (u) => { if (o.abreFalla) throw new Error("net"); calls.push("abrir:" + u); return {}; },
    rellenar: async () => { calls.push("rellenar"); return o.res ?? "enviado"; },
    anadirCredencial: async (f) => { calls.push("csv:" + f.nombre); expect(f.password).toBe(PW); expect(f.usuario).toBe(EMAIL); },
    password: () => PW,
    marcar: async (s, e) => { marcadas.push([s, e]); },
    conexiones: async () => { if (o.conex === "falla") throw new Error("x"); return o.conex ?? new Map(); },
    ejecutar: async (c, a) => { ejecutadas.push([c, a]); return o.codigo ?? 0; },
    pausa: async () => {},
    log: (m) => { textos.push(m); },
  };
  return { deps, calls, textos, ejecutadas, marcadas };
}

describe("ejecutarAlta", () => {
  it("escribe la credencial en el CSV antes de rellenar", async () => {
    const f = fake();
    await ejecutarAlta(["github"], EMAIL, f.deps);
    expect(f.calls.indexOf("csv:GitHub")).toBeLessThan(f.calls.indexOf("rellenar"));
  });

  it("Enter marca registrado; s no marca y va a saltados", async () => {
    const f = fake({ resp: ["", "s"] });
    const r = await ejecutarAlta(["github", "vercel"], EMAIL, f.deps);
    expect(f.marcadas).toEqual([["github", "registrado"]]);
    expect(r).toEqual({ registrados: ["github"], saltados: ["vercel"] });
  });

  it("no_encontrado pide completar a mano y Enter sigue marcando", async () => {
    const f = fake({ res: "no_encontrado" });
    await ejecutarAlta(["github"], EMAIL, f.deps);
    expect(f.textos.join("\n")).toMatch(/No encontré el formulario/);
    expect(f.marcadas).toEqual([["github", "registrado"]]);
  });

  it("si no se puede abrir la página, se salta sin marcar", async () => {
    const f = fake({ abreFalla: true });
    const r = await ejecutarAlta(["github"], EMAIL, f.deps);
    expect(r.saltados).toEqual(["github"]);
    expect(f.marcadas).toEqual([]);
  });

  it("id desconocido rechaza antes de abrir nada", async () => {
    const f = fake();
    await expect(ejecutarAlta(["github", "no-existe"], EMAIL, f.deps)).rejects.toThrow(/no-existe/);
    expect(f.calls).toEqual([]);
  });

  it("sin ids recorre todos los servicios", async () => {
    const f = fake();
    const r = await ejecutarAlta([], EMAIL, f.deps);
    expect(r.registrados).toHaveLength(SERVICIOS.length);
  });

  it("conexión remota segura + s → claude mcp add con argumentos separados y marca conectado", async () => {
    const conex = new Map([["com.vercel/vercel-mcp", { tipo_conexion: "remoto", como_conectar: "https://mcp.vercel.com" }]]);
    const f = fake({ resp: ["", "s"], conex });
    await ejecutarAlta(["vercel"], EMAIL, f.deps);
    expect(f.ejecutadas).toEqual([["claude", ["mcp", "add", "--transport", "http", "vercel", "https://mcp.vercel.com"]]]);
    expect(f.marcadas).toEqual([["vercel", "registrado"], ["vercel", "conectado"]]);
  });

  it("código de salida distinto de 0 → no marca conectado", async () => {
    const conex = new Map([["com.vercel/vercel-mcp", { tipo_conexion: "remoto", como_conectar: "https://mcp.vercel.com" }]]);
    const f = fake({ resp: ["", "s"], conex, codigo: 1 });
    await ejecutarAlta(["vercel"], EMAIL, f.deps);
    expect(f.marcadas).toEqual([["vercel", "registrado"]]);
  });

  it.each(["n", ""])("respuesta %j a conectar → no se ejecuta nada", async (r) => {
    const conex = new Map([["com.vercel/vercel-mcp", { tipo_conexion: "remoto", como_conectar: "https://mcp.vercel.com" }]]);
    const f = fake({ resp: ["", r], conex });
    await ejecutarAlta(["vercel"], EMAIL, f.deps);
    expect(f.ejecutadas).toEqual([]);
  });

  it.each(["https://x.example/a;rm -rf", "https://x.example/a b", "npx -y pkg"])("como_conectar %j no se ofrece ni ejecuta", async (url) => {
    const f = fake({ resp: ["", "s"], conex: new Map([["com.vercel/vercel-mcp", { tipo_conexion: "remoto", como_conectar: url }]]) });
    await ejecutarAlta(["vercel"], EMAIL, f.deps);
    expect(f.ejecutadas).toEqual([]);
    expect(f.textos.join("\n")).not.toMatch(/Conectarlo ahora/);
  });

  it("conexión de tipo local no se ofrece", async () => {
    const f = fake({ resp: ["", "s"], conex: new Map([["com.vercel/vercel-mcp", { tipo_conexion: "local", como_conectar: "https://mcp.vercel.com" }]]) });
    await ejecutarAlta(["vercel"], EMAIL, f.deps);
    expect(f.ejecutadas).toEqual([]);
  });

  it("conexiones() que lanza se omite sin fallar", async () => {
    const f = fake({ conex: "falla" });
    await expect(ejecutarAlta(["vercel"], EMAIL, f.deps)).resolves.toMatchObject({ registrados: ["vercel"] });
  });

  it("ni el email ni la contraseña aparecen en mensajes ni preguntas", async () => {
    const f = fake({ resp: ["", "s"], conex: new Map([["com.vercel/vercel-mcp", { tipo_conexion: "remoto", como_conectar: "https://mcp.vercel.com" }]]) });
    await ejecutarAlta(["github", "vercel"], EMAIL, f.deps);
    const todo = f.textos.join("\n");
    expect(todo).not.toContain(PW);
    expect(todo).not.toContain(EMAIL);
  });
});
