import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { chromium, type Browser, type Page } from "playwright-core";
import { rellenar } from "../../local/formulario";

let browser: Browser | null = null;
beforeAll(async () => {
  for (const channel of ["chrome", "msedge"]) {
    try { browser = await chromium.launch({ channel, headless: true }); return; } catch { /* siguiente */ }
  }
});
afterAll(async () => { await browser?.close(); });

const C = { email: "yo@ejemplo.com", password: "Pw-12345" };
async function pagina(html: string): Promise<Page> {
  const p = await browser!.newPage();
  // Registra el envío sin navegar: el test no sale a ninguna red.
  await p.setContent(`<body>${html}<script>window.__enviado=0;document.addEventListener("submit",e=>{e.preventDefault();window.__enviado++;});</script></body>`);
  return p;
}
const enviado = (p: Page) => p.evaluate(() => (globalThis as any).__enviado as number);

describe("rellenar", () => {

  it("formulario normal → enviado, valores escritos y submit ejecutado", async (ctx) => {
    if (!browser) return ctx.skip();
    const p = await pagina('<form><input type="email" name="e"><input type="password" name="p"><button type="submit">Ok</button></form>');
    expect(await rellenar(p, C)).toBe("enviado");
    expect(await p.inputValue('input[name=e]')).toBe(C.email);
    expect(await p.inputValue('input[name=p]')).toBe(C.password);
    expect(await enviado(p)).toBe(1);
  });

  it("dos campos password (confirmación) → ambos con la misma contraseña", async (ctx) => {
    if (!browser) return ctx.skip();
    const p = await pagina('<form><input type="email"><input type="password" id="a"><input type="password" id="b"><button type="submit">Ok</button></form>');
    expect(await rellenar(p, C)).toBe("enviado");
    expect(await p.inputValue("#a")).toBe(C.password);
    expect(await p.inputValue("#b")).toBe(C.password);
  });

  it("email por autocomplete=username también se encuentra", async (ctx) => {
    if (!browser) return ctx.skip();
    const p = await pagina('<form><input type="text" autocomplete="username" id="u"><input type="password"><button type="submit">Ok</button></form>');
    expect(await rellenar(p, C)).toBe("enviado");
    expect(await p.inputValue("#u")).toBe(C.email);
  });

  it("sin campo password (paso 1 de 2) → no_encontrado y no se rellena nada", async (ctx) => {
    if (!browser) return ctx.skip();
    const p = await pagina('<form><input type="email" id="e"><button>Siguiente</button></form>');
    expect(await rellenar(p, C, 150)).toBe("no_encontrado");
    expect(await p.inputValue("#e")).toBe("");
    expect(await enviado(p)).toBe(0);
  });

  it("sin botón de envío → no_encontrado y no se rellena nada", async (ctx) => {
    if (!browser) return ctx.skip();
    const p = await pagina('<form><input type="email" id="e"><input type="password" id="p"></form>');
    expect(await rellenar(p, C, 150)).toBe("no_encontrado");
    expect(await p.inputValue("#e")).toBe("");
    expect(await p.inputValue("#p")).toBe("");
  });

  it("campos ocultos no cuentan", async (ctx) => {
    if (!browser) return ctx.skip();
    const p = await pagina('<form><input type="email" style="display:none"><input type="password" style="display:none"><button>Ok</button></form>');
    expect(await rellenar(p, C, 150)).toBe("no_encontrado");
  });

  it("con un botón type=submit y otro sin type (ojo de mostrar contraseña), pulsa el submit", async (ctx) => {
    if (!browser) return ctx.skip();
    const p = await pagina('<form><input type="email"><input type="password"><button id="ojo">👁</button><button type="submit">Crear</button></form>');
    await p.evaluate(() => { (globalThis as any).document.getElementById("ojo").addEventListener("click", (e: any) => { e.preventDefault(); e.stopImmediatePropagation(); (globalThis as any).__ojo = 1; }); });
    expect(await rellenar(p, C)).toBe("enviado");
    expect(await p.evaluate(() => (globalThis as any).__ojo)).toBeUndefined();
    expect(await enviado(p)).toBe(1);
  });

  it("varios botones sin type y ninguno submit → no_encontrado (no se adivina)", async (ctx) => {
    if (!browser) return ctx.skip();
    const p = await pagina('<form><input type="email"><input type="password"><button>A</button><button>B</button></form>');
    expect(await rellenar(p, C, 150)).toBe("no_encontrado");
    expect(await enviado(p)).toBe(0);
  });

  it("un único botón sin type sí cuenta como envío", async (ctx) => {
    if (!browser) return ctx.skip();
    const p = await pagina('<form><input type="email"><input type="password"><button>Crear</button></form>');
    expect(await rellenar(p, C)).toBe("enviado");
  });

  it("espera a que un formulario montado con JavaScript aparezca", async (ctx) => {
    if (!browser) return ctx.skip();
    const p = await pagina("");
    await p.evaluate(() => { setTimeout(() => { (globalThis as any).document.body.insertAdjacentHTML("afterbegin", '<form><input type="email"><input type="password"><button type="submit">Ok</button></form>'); }, 400); });
    expect(await rellenar(p, C)).toBe("enviado");
  });
});
