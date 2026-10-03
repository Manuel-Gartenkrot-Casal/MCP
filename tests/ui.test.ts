import { describe, it, expect } from "vitest";
import { Script } from "node:vm";
import { renderPagina, slug, comando } from "../src/ui";

const html = renderPagina("NONCE_abc-123");
const script = html.match(/<script nonce="NONCE_abc-123">([\s\S]*?)<\/script>/)![1];

describe("renderPagina", () => {
  it("un único <script> y <style>, ambos con el nonce", () => {
    expect(html.match(/<script/g)!.length).toBe(1);
    expect(html.match(/<style/g)!.length).toBe(1);
    expect(html).toContain('<style nonce="NONCE_abc-123">');
    expect(html.startsWith("<!doctype html>")).toBe(true);
    expect(html).toContain('<html lang="es">');
  });
  it("sin recursos externos ni elementos que carguen", () => {
    expect(html).not.toMatch(/<script[^>]*\ssrc=/i);
    expect(html).not.toMatch(/<link/i);
    expect(html).not.toMatch(/<img/i);
    expect(html).not.toMatch(/<iframe|<object|<embed/i);
    expect(html.match(/https?:\/\/[^\s"'<)]+/g)).toEqual(["https://github.com/Manuel-Gartenkrot-Casal/MCP"]);
  });
  it("el enlace de GitHub es el único <a href> y lleva rel noopener noreferrer", () => {
    const as = html.match(/<a\s[^>]*>/g)!;
    expect(as).toEqual(['<a href="https://github.com/Manuel-Gartenkrot-Casal/MCP" rel="noopener noreferrer">']);
  });
  it("no usa sinks de HTML ni eval; usa textContent", () => {
    for (const bad of ["innerHTML", "outerHTML", "insertAdjacentHTML", "document.write", "eval(", "new Function", "Function("])
      expect(html, bad).not.toContain(bad);
    expect(script).toContain("textContent");
    expect(script).not.toMatch(/\.href\s*=|\.src\s*=|setAttribute\(\s*["'](href|src|on)/);
  });
  it("llama a /api/buscar con URL relativa y POST JSON", () => {
    expect(script).toContain('fetch("/api/buscar"');
    expect(script).toContain('method: "POST"');
    expect(script).toContain('"content-type": "application/json"');
  });
  it("controles etiquetados, región aria-live, ejemplos y sección 'Usar con tu IA'", () => {
    for (const id of ["q", "con", "auth"]) expect(html).toContain(`<label for="${id}"`);
    expect(html).toMatch(/maxlength="2000"/);
    expect(html).toContain('<p id="aviso" class="sr" role="status" aria-live="polite"></p>');
    expect(html.match(/aria-live/g)!.length).toBe(1); // solo el estado, no la lista de resultados
    expect(html).toMatch(/<section id="res" aria-label="Resultados">/);
    expect(html).toContain("gestionar issues y pull requests de GitHub");
    expect(html).toContain("dar la hora actual");
    expect(html).toContain("leer hojas de cálculo de Google");
    expect(html).toContain("Usar con tu IA");
    expect(html).toMatch(/prefers-color-scheme: dark/);
    expect(html).toMatch(/prefers-reduced-motion/);
    expect(html).toContain("Demasiadas búsquedas, espera un minuto");
  });
  it("el script incrusta exactamente las funciones puras exportadas", () => {
    expect(script).toContain(slug.toString());
    expect(script).toContain(comando.toString());
  });
  it("aviso de revisar el comando junto a cada botón de copia de tarjeta", () => {
    expect(script).toContain("Revisa el comando antes de ejecutarlo.");
  });
  it("los controles usan un borde propio más contrastado (claro y oscuro)", () => {
    expect(html.match(/--control:\s*#[0-9a-f]{6}/g)!.length).toBe(2);
    expect(html).toMatch(/input, select \{[^}]*border: 1px solid var\(--control\)/);
  });
  it("el script compila", () => {
    expect(() => new Script(script)).not.toThrow();
  });
  it("el nonce es lo único variable", () => {
    expect(renderPagina("OTRO").replaceAll("OTRO", "NONCE_abc-123")).toBe(html);
  });
});

describe("slug", () => {
  it.each([
    ["io.github.org/My Server!", "io-github-org-my-server"],
    ["", "servidor"],
    ["!!!", "servidor"],
    ["  --Ñandú  Weather--  ", "and-weather"],
    ["a".repeat(60), "a".repeat(40)],
    ["a".repeat(39) + " b", "a".repeat(39)],
  ])("%j -> %j", (i, o) => expect(slug(i)).toBe(o));
});

describe("comando", () => {
  it("URL segura -> comando claude mcp add", () =>
    expect(comando("My Server", "https://x.example/mcp")).toBe("claude mcp add --transport http my-server https://x.example/mcp"));
  it.each(["https://x.example/mcp?a=1&b=2", "https://x.example/$(rm -rf ~)", "https://x.example/;ls", "ftp://x.example", "https://x.example/a b", "npx -y algo", "https://x.example/`id`", "https://x.example/'a'"])(
    "%s -> null (nada que pegar en una shell)", (u) => expect(comando("x", u)).toBeNull());
});
