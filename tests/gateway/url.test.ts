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
