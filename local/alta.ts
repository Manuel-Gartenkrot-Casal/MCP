// Alta guiada y automatizada, solo en tu máquina: abre cada formulario de registro en un navegador visible, lo rellena con una
// contraseña aleatoria por servicio y espera a que resuelvas CAPTCHA o verificaciones. Uso: npm run alta [id ...]
// El email y las contraseñas nunca van a servicios.json, logs ni argumentos; solo al CSV (antes de enviar) y al propio formulario.
import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { spawn } from "node:child_process";
import { createInterface } from "node:readline/promises";
import { SERVICIOS, type Servicio } from "../src/servicios";
import { comando } from "../src/ui";
import { generarPassword, anadirCredencial, type Fila } from "./credenciales";
import { rellenar } from "./formulario";
import { marcar } from "./memoria";

type Conexion = { tipo_conexion: string; como_conectar: string };
export type Deps = {
  preguntar(msg: string): Promise<string>;
  abrir(url: string): Promise<unknown>;
  rellenar(pagina: unknown, c: { email: string; password: string }): Promise<"enviado" | "no_encontrado">;
  anadirCredencial(f: Fila): Promise<void>;
  password(): string;
  marcar(servicio: string, estado: "registrado" | "conectado"): Promise<unknown>;
  conexiones(): Promise<Map<string, Conexion>>;
  ejecutar(cmd: string, args: string[]): Promise<number>;
  pausa(ms: number): Promise<void>;
  log(msg: string): void;
};

// claude es un .cmd en Windows: spawn sin shell da ENOENT. comando() solo deja pasar [A-Za-z0-9._~:/-], sin metacaracteres de cmd.exe.
export function comandoSpawn(cmd: string, args: string[], plataforma: string = process.platform): [string, string[]] {
  return plataforma === "win32" ? ["cmd.exe", ["/d", "/s", "/c", cmd, ...args]] : [cmd, args];
}

export async function ejecutarAlta(ids: string[], email: string, deps: Deps): Promise<{ registrados: string[]; saltados: string[] }> {
  const lista: Servicio[] = ids.length
    ? ids.map((id) => SERVICIOS.find((s) => s.id === id) ?? (() => { throw new Error(`Servicio desconocido: ${id}`); })())
    : SERVICIOS;
  let conex = new Map<string, Conexion>();
  try { conex = await deps.conexiones(); } catch { deps.log("No pude consultar los MCP del catálogo; se omite ese paso."); }
  const registrados: string[] = [], saltados: string[] = [];

  for (const [i, s] of lista.entries()) {
    if (i) await deps.pausa(2000);
    deps.log(`\n[${i + 1}/${lista.length}] ${s.nombre}`);
    const password = deps.password();
    let pagina: unknown;
    try { pagina = await deps.abrir(s.registro_url); } catch { deps.log(`No pude abrir ${s.nombre}; se salta.`); saltados.push(s.id); continue; }
    // Tras abrir (sin filas fantasma) y antes de rellenar/enviar: si algo falla después, la contraseña ya está guardada.
    await deps.anadirCredencial({ nombre: s.nombre, url: s.registro_url, usuario: email, password });
    const res = await deps.rellenar(pagina, { email, password }).catch(() => "no_encontrado" as const);
    const r = (await deps.preguntar(res === "enviado"
      ? "Si hay CAPTCHA o verificación, resuélvelo y pulsa Enter (s = saltar): "
      : `No pude completar el formulario solo (revisa la página: puede haberse enviado ya). Si falta, complétalo tú con la contraseña de la fila de ${s.nombre} del CSV y pulsa Enter (s = saltar): `)).trim().toLowerCase();
    if (r === "s") { saltados.push(s.id); continue; }
    await deps.marcar(s.id, "registrado");
    registrados.push(s.id);

    const c = s.mcp_id ? conex.get(s.mcp_id) : undefined;
    const cmd = c && c.tipo_conexion === "remoto" ? comando(s.nombre, c.como_conectar) : null;
    if (cmd) {
      deps.log(`Tiene MCP: ${cmd}`);
      if ((await deps.preguntar("¿Conectarlo ahora? (s/N): ")).trim().toLowerCase() === "s") {
        // comando() garantiza que no hay espacios ni metacaracteres: el split es seguro y no se usa shell.
        if ((await deps.ejecutar("claude", cmd.split(" ").slice(1))) === 0) await deps.marcar(s.id, "conectado");
        else deps.log("No se pudo conectar; ejecútalo a mano.");
      }
    }
  }
  return { registrados, saltados };
}

const URL_PRODUCCION = "https://catalogo-mcp-busqueda.manuelgartenkrotcasal.workers.dev";

async function main(): Promise<void> {
  const ids = process.argv.slice(2);
  for (const id of ids) if (!SERVICIOS.some((s) => s.id === id)) throw new Error(`Servicio desconocido: ${id}`); // antes de abrir nada
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  const email = (await rl.question("Email para los registros: ")).trim();
  if (!/^[^\s@]+@[^\s@]+$/.test(email)) throw new Error("Email no válido.");
  const descargas = join(homedir(), "Downloads");
  const porDefecto = existsSync(descargas) ? descargas : process.cwd(); // nunca dentro del repo por defecto: el CSV lleva contraseñas en claro
  const carpeta = (await rl.question(`Carpeta del CSV de contraseñas [${porDefecto}]: `)).trim() || porDefecto;
  const ruta = join(carpeta, `cuentas-${new Date().toISOString().slice(0, 19).replace(/[:T]/g, "-")}.csv`);

  const { chromium } = await import("playwright-core");
  let browser;
  for (const channel of ["chrome", "msedge"]) { try { browser = await chromium.launch({ channel, headless: false }); break; } catch { /* siguiente */ } }
  if (!browser) throw new Error("No encontré Chrome ni Edge instalados.");
  const ctx = await browser.newContext();
  const base = process.env.CATALOGO_URL ?? URL_PRODUCCION;

  try {
    const r = await ejecutarAlta(ids, email, {
      preguntar: (m) => rl.question(m),
      abrir: async (url) => { const p = await ctx.newPage(); await p.goto(url, { waitUntil: "domcontentloaded", timeout: 30000 }); return p; },
      rellenar: (p, c) => rellenar(p as import("playwright-core").Page, c),
      anadirCredencial: (f) => anadirCredencial(ruta, f),
      password: generarPassword,
      marcar: (servicio, estado) => marcar(process.env.CATALOGO_MCP_DIR ?? join(homedir(), ".catalogo-mcp"), { servicio, estado }),
      conexiones: async () => {
        const d: any = await (await fetch(`${base}/api/servicios`, { signal: AbortSignal.timeout(10000) })).json();
        return new Map<string, Conexion>(d.servicios.filter((s: any) => s.mcp_id && s.conexion).map((s: any) => [s.mcp_id, s.conexion]));
      },
      ejecutar: (cmd, args) => new Promise((res) => { const [f, a] = comandoSpawn(cmd, args); const p = spawn(f, a, { stdio: "inherit" }); p.on("error", () => res(1)); p.on("close", (c) => res(c ?? 1)); }),
      pausa: (ms) => new Promise((res) => setTimeout(res, ms)),
      log: (m) => console.log(m),
    });
    console.log(`\nDados de alta: ${r.registrados.join(", ") || "ninguno"}\nSaltados: ${r.saltados.join(", ") || "ninguno"}`);
    console.log(`\nContraseñas en ${ruta}: impórtalo en tu gestor de contraseñas y BÓRRALO.`);
    if (process.platform === "win32") console.log("En Windows el archivo no queda restringido (0600 no aplica): bórralo en cuanto lo importes.");
  } finally {
    rl.close();
    await browser.close();
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((e) => { console.error(e instanceof Error ? e.message : e); process.exit(1); });
}
