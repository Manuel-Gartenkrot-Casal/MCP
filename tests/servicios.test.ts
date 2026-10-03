import { describe, it, expect } from "vitest";
import { SERVICIOS } from "../src/servicios";

describe("SERVICIOS", () => {
  it("hay al menos 10 servicios", () => expect(SERVICIOS.length).toBeGreaterThanOrEqual(10));
  it("ids únicos y con forma [a-z0-9-]{1,32}", () => {
    const ids = SERVICIOS.map((s) => s.id);
    expect(new Set(ids).size).toBe(ids.length);
    for (const id of ids) expect(id).toMatch(/^[a-z0-9-]{1,32}$/);
  });
  it("registro_url es https y parsea con new URL", () => {
    for (const s of SERVICIOS) expect(new URL(s.registro_url).protocol).toBe("https:");
  });
  it("mcp_id, si existe, mide ≤ 64 bytes y no está vacío", () => {
    for (const s of SERVICIOS) if (s.mcp_id !== undefined) {
      const n = new TextEncoder().encode(s.mcp_id).length;
      expect(n).toBeGreaterThan(0);
      expect(n).toBeLessThanOrEqual(64);
    }
  });
});
