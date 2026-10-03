// MCP local (stdio) con la memoria de servicios. Solo guarda servicio, estado y fecha; nunca contraseñas ni claves.
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { homedir } from "node:os";
import { join } from "node:path";
import { z } from "zod";
import { leer, marcar } from "./memoria";

const dir = process.env.CATALOGO_MCP_DIR ?? join(homedir(), ".catalogo-mcp");
const ok = (o: unknown) => ({ content: [{ type: "text" as const, text: JSON.stringify(o) }] });
const fallo = (e: unknown) => ({ content: [{ type: "text" as const, text: e instanceof Error ? e.message : "error" }], isError: true });

const server = new McpServer({ name: "memoria-servicios", version: "0.1.0" });
server.registerTool("mis_servicios", {
  description: "Devuelve los servicios en los que el usuario ya se ha dado de alta o que ya conectó: [{servicio, estado, fecha}]. Es un registro local, sin contraseñas.",
}, async () => { try { return ok(await leer(dir)); } catch (e) { return fallo(e); } });
server.registerTool("marcar", {
  description: "Anota que el usuario se registró en un servicio ('registrado'), lo conectó ('conectado') o quiere olvidarlo ('quitado'). Llámala solo cuando el usuario lo confirme. Solo se guarda servicio, estado y fecha: NUNCA pidas ni guardes contraseñas, emails ni claves.",
  inputSchema: {
    servicio: z.string().describe("id del servicio tal como lo devuelve la herramienta `servicios` ([a-z0-9-], máx. 32)."),
    estado: z.enum(["registrado", "conectado", "quitado"]),
  },
}, async ({ servicio, estado }) => { try { return ok(await marcar(dir, { servicio, estado })); } catch (e) { return fallo(e); } });

await server.connect(new StdioServerTransport());
