import { describe, it, expect } from "vitest";
import fx from "../fixtures/registro-muestra.json";
import { normalizeEntry, dedupeLatest, fetchRegistry } from "../../src/ingest/registry";

const latest = fx.pagina_latest.servers as any[];
const by = (name: string) => latest.find((e) => e.server.name === name);

describe("normalizeEntry", () => {
  it("remota con cabecera secreta => remoto + clave", () => {
    const e = normalizeEntry(by("ae.propick/propick"))!;
    expect(e.id).toBe("ae.propick/propick");
    expect(e.nombre).toBe("Propick Integration MCP");
    expect(e.tipo_conexion).toBe("remoto");
    expect(e.como_conectar).toBe("https://propick.ae/mcp");
    expect(e.auth).toBe("clave");
    expect(e.incompleta).toBe(false);
    expect(e.url_info).toBe("https://propick.ae");
    expect(e.actualizado).toBe("2026-08-25T11:16:56.879334Z");
  });
  it("local npm con variable secreta => local + clave", () => {
    const e = normalizeEntry(by("ai.adtest/adtest-mcp"))!;
    expect(e.tipo_conexion).toBe("local");
    expect(e.como_conectar).toContain("adtest-mcp");
    expect(e.auth).toBe("clave");
    expect(e.url_info).toBe("https://adtest.ai/");
  });
  it("local sin variables => ninguna", () => {
    const e = normalizeEntry(by("agency.kesey/pretrip"))!;
    expect(e.auth).toBe("ninguna");
    expect(e.incompleta).toBe(false);
  });
  it("remota sin cabeceras declaradas => desconocida e incompleta; nombre cae a name", () => {
    const e = normalizeEntry(by("ac.snag/snag"))!;
    expect(e.auth).toBe("desconocida");
    expect(e.incompleta).toBe(true);
    expect(e.nombre).toBe("ac.snag/snag");
    expect(e.url_info).toBeNull();
  });
  it("remota + local => remoto", () => {
    const e = normalizeEntry(by("ai.agent-bev/bev-door"))!;
    expect(e.tipo_conexion).toBe("remoto");
    expect(e.como_conectar).toBe("https://mcp.bev-buyer.ai/mcp");
  });
  it("url_info cae a repository.url", () => {
    const raw = structuredClone(by("ai.adtest/adtest-mcp"));
    delete raw.server.websiteUrl;
    expect(normalizeEntry(raw)!.url_info).toBe("https://github.com/menaker/adtest-mcp");
  });
  it("prefiere streamable-http sobre sse", () => {
    const raw = structuredClone(by("ac.snag/snag"));
    raw.server.remotes = [{ type: "sse", url: "https://a/sse" }, { type: "streamable-http", url: "https://a/mcp" }];
    expect(normalizeEntry(raw)!.como_conectar).toBe("https://a/mcp");
  });
  it("identifier/version con metacaracteres de shell => sin comando (y sin conexión => null)", () => {
    const evil = ["a;rm -rf /", "$(curl x)", "`id`", "a b", "a\nb", "a&&b", "a|b"];
    for (const bad of evil) {
      for (const field of ["identifier", "version"] as const) {
        const raw = structuredClone(by("agency.kesey/pretrip"));
        raw.server.packages = [{ ...raw.server.packages[0], [field]: bad }];
        expect(normalizeEntry(raw), `${field}=${JSON.stringify(bad)}`).toBeNull();
      }
    }
  });
  it("identifier/version que empiezan por - (inyección de opciones) => null; normales se aceptan", () => {
    for (const bad of ["--privileged", "-p", "-x/y"]) {
      for (const field of ["identifier", "version"] as const) {
        const raw = structuredClone(by("agency.kesey/pretrip"));
        raw.server.packages = [{ registryType: "npm", identifier: "pkg", version: "1.0.0", [field]: bad }];
        expect(normalizeEntry(raw), `${field}=${bad}`).toBeNull();
      }
    }
    const raw = structuredClone(by("agency.kesey/pretrip"));
    raw.server.packages = [{ registryType: "npm", identifier: "@scope/pkg", version: "1.2.3" }, ];
    expect(normalizeEntry(raw)!.como_conectar).toBe("npx -y @scope/pkg@1.2.3");
    raw.server.packages = [{ registryType: "oci", identifier: "ghcr.io/org/img:1.0" }];
    expect(normalizeEntry(raw)!.como_conectar).toBe("docker run -i --rm ghcr.io/org/img:1.0");
  });
  it("paquete inválido se salta y se usa el siguiente válido", () => {
    const raw = structuredClone(by("agency.kesey/pretrip"));
    raw.server.packages = [
      { registryType: "npm", identifier: "x;id", version: "1.0.0" },
      { registryType: "pypi", identifier: "ok-pkg", version: "1.2.3" },
    ];
    expect(normalizeEntry(raw)!.como_conectar).toBe("uvx ok-pkg==1.2.3");
  });
  it("identificadores válidos con @, /, :, +, ~", () => {
    const raw = structuredClone(by("agency.kesey/pretrip"));
    raw.server.packages = [{ registryType: "npm", identifier: "@scope/pkg", version: "1.0.0+b~1" }];
    expect(normalizeEntry(raw)!.como_conectar).toBe("npx -y @scope/pkg@1.0.0+b~1");
    raw.server.packages = [{ registryType: "oci", identifier: "ghcr.io/o/img:1.2" }];
    expect(normalizeEntry(raw)!.como_conectar).toBe("docker run -i --rm ghcr.io/o/img:1.2");
  });
  it("sin conexión => null", () => {
    expect(normalizeEntry(by("ai.agentxray/amazon-seller-mcp"))).toBeNull();
  });
  it("sin id/nombre o basura => null", () => {
    expect(normalizeEntry({ server: { description: "x", remotes: [{ type: "sse", url: "u" }] } })).toBeNull();
    expect(normalizeEntry(null)).toBeNull();
    expect(normalizeEntry("x")).toBeNull();
  });
});

describe("dedupeLatest", () => {
  it("misma id => la más reciente", () => {
    const es = (fx.pagina_versiones.servers as any[]).map((r) => normalizeEntry(r)!);
    expect(es).toHaveLength(3);
    const out = dedupeLatest(es);
    expect(out).toHaveLength(1);
    expect(out[0].actualizado).toBe("2026-07-20T18:02:33.295284Z");
    expect(out[0].descripcion).toMatch(/^run any ai model/);
  });
});

describe("fetchRegistry", () => {
  const page = (servers: any[], nextCursor?: string) =>
    new Response(JSON.stringify({ servers, metadata: nextCursor ? { nextCursor, count: servers.length } : { count: servers.length } }));
  it("recorre todas las páginas con cursor codificado", async () => {
    const urls: string[] = [];
    const f = (async (u: any) => {
      urls.push(String(u));
      return urls.length === 1 ? page([latest[0]], "a/b:1.0.0") : page([latest[1]]);
    }) as typeof fetch;
    const out = await fetchRegistry(f);
    expect(out.map((e) => e.id)).toEqual(["ae.propick/propick", "ac.inference.sh/mcp"]);
    expect(urls[0]).toBe("https://registry.modelcontextprotocol.io/v0.1/servers?version=latest&limit=100");
    expect(urls[1]).toContain("&cursor=" + encodeURIComponent("a/b:1.0.0"));
  });
  it("cursor repetido => lanza", async () => {
    const f = (async () => page([latest[0]], "same:1")) as typeof fetch;
    await expect(fetchRegistry(f)).rejects.toThrow(/repeated cursor/);
  });
  it("más de 1000 páginas => lanza", async () => {
    let n = 0;
    const f = (async () => page([], `c${n++}`)) as typeof fetch;
    await expect(fetchRegistry(f)).rejects.toThrow(/1000 pages/);
  });
  it("HTTP 500 => lanza", async () => {
    const f = (async () => new Response("x", { status: 500 })) as typeof fetch;
    await expect(fetchRegistry(f)).rejects.toThrow();
  });
});
