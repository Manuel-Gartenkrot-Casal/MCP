import { describe, it, expect } from "vitest";
import { validarDestino } from "../../src/gateway/url";
import { GatewayError } from "../../src/gateway/types";

const H = "mcp.propio.dev";
const rechaza = (u: any) => {
  try { validarDestino(u, H); } catch (e) { expect(e).toBeInstanceOf(GatewayError); expect((e as GatewayError).code).toBe("no_remoto"); return; }
  throw new Error("no lanzó: " + String(u).slice(0, 60));
};

describe("validarDestino", () => {
  it("acepta https normal y puerto 443", () => {
    expect(validarDestino("https://mcp.example.com/mcp", H).hostname).toBe("mcp.example.com");
    expect(validarDestino("https://mcp.example.com:443/x", H).href).toBe("https://mcp.example.com/x");
  });
  it.each([
    "http://mcp.example.com/", "https://1.2.3.4/", "https://[::1]/", "https://localhost/", "https://x.local/",
    "https://x.internal/", "https://user:pw@h.com/", "https://user@h.com/", "https://h.com:8443/", "no es url",
    "https://2130706433/", "https://0x7f.1/", "https://0177.0.0.1/", "https://LOCALHOST/", "https://localhost./",
    "https://x.local./", "https://X.Internal/", "https://a.localhost/", "javascript:alert(1)", "file:///etc/passwd", "",
  ])("rechaza %s", rechaza);
  it("rechaza el host propio (case-insensitive, punto final)", () => {
    rechaza("https://MCP.Propio.dev/mcp");
    rechaza("https://mcp.propio.dev./mcp");
  });
  it("entrada enorme: mismas reglas, sin colgarse", () => {
    rechaza("https://" + "a".repeat(10000) + ".local/");
    rechaza("x".repeat(10000));
  });
  it("entrada no string", () => rechaza(undefined));
});

describe("validarDestino: ronda de arreglos", () => {
  it.each(["mcp.propio.dev", "mcp.propio.dev:8787", "MCP.Propio.Dev.", " mcp.propio.dev:8787 "])(
    "hostPropio %j rechaza su dominio", (hp) => {
      expect(() => validarDestino("https://mcp.propio.dev/", hp)).toThrow(GatewayError);
    });
  it("hostPropio localhost:8787 no rompe y localhost sigue prohibido", () => {
    expect(() => validarDestino("https://localhost/", "localhost:8787")).toThrow(GatewayError);
  });
  it("hostPropio vacío/undefined no revienta ni rechaza de más", () => {
    expect(validarDestino("https://mcp.example.com/", "").hostname).toBe("mcp.example.com");
    expect(validarDestino("https://mcp.example.com/", undefined as any).hostname).toBe("mcp.example.com");
    expect(validarDestino("https://undefined/", undefined as any).hostname).toBe("undefined");
  });
  it.each([
    "https://localhost../", "https://a.local../", "https://a..b.com/", "https://1.2.3.4./", "https://1.2.3.4../",
    "https://[::ffff:127.0.0.1]/", "https://127.1/", "https://169.254.169.254/", "https://metadata.google.internal/",
  ])("rechaza %s", rechaza);
  it("acepta host público en mayúsculas o con punto final", () => {
    expect(validarDestino("https://MCP.Example.com./x", H).hostname).toBe("mcp.example.com.");
  });
  it("hostname de 253 caracteres, rápido", () => {
    const host = [..."abcd"].map((c) => c.repeat(60)).join(".").slice(0, 249) + ".com";
    const t = Date.now();
    validarDestino(`https://${host}/`, H);
    expect(Date.now() - t).toBeLessThan(200);
  });
});
