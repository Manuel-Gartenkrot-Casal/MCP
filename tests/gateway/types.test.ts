import { describe, it, expect } from "vitest";
import { GatewayError, type GwCode } from "../../src/gateway/types";

const CODES: GwCode[] = ["no_encontrado", "no_remoto", "requiere_auth", "timeout", "destino_caido",
  "herramienta_inexistente", "sesion_expirada", "sesion_otro_servidor", "desactivada", "confirmar", "entrada_invalida"];

describe("GatewayError", () => {
  it("confirmar incluye la instrucción y la marca", () => {
    const e = new GatewayError("confirmar", "destructiva");
    expect(e.message).toContain("confirmar: true");
    expect(e.message).toContain("destructiva");
    expect(e.code).toBe("confirmar");
  });
  it("mensajes fijos, de una línea y distintos por código", () => {
    const msgs = CODES.map((c) => new GatewayError(c, "sin_declarar").message);
    for (const m of msgs) { expect(m).not.toMatch(/[\r\n]/); expect(m.length).toBeGreaterThan(5); }
    expect(new Set(msgs).size).toBe(CODES.length);
    expect(new GatewayError("desactivada").message).toBe("La pasarela está desactivada.");
  });
  it("solo confirmar usa la marca", () => {
    expect(new GatewayError("timeout", "destructiva").message).toBe(new GatewayError("timeout").message);
  });
});
