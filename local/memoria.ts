// Memoria local de servicios: solo servicio, estado y fecha. No hay campo para secretos y no se hace ninguna petición de red.
import { randomUUID } from "node:crypto";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { z } from "zod";

const Servicio = z.string().regex(/^[a-z0-9-]{1,32}$/);
const Registro = z.strictObject({ servicio: Servicio, estado: z.enum(["registrado", "conectado"]), fecha: z.string() });
const Entrada = z.strictObject({ servicio: Servicio, estado: z.enum(["registrado", "conectado", "quitado"]) });
export type Registro = z.infer<typeof Registro>;
export type Estado = Registro["estado"];

const ruta = (dir: string) => join(dir, "servicios.json");

export async function leer(dir: string): Promise<Registro[]> {
  let txt: string;
  try { txt = await readFile(ruta(dir), "utf8"); } catch (e: any) { if (e?.code === "ENOENT") return []; throw e; }
  try { return z.array(Registro).parse(JSON.parse(txt)); } catch { throw new Error(`Archivo corrupto: ${ruta(dir)}. Revísalo o bórralo; no se sobrescribe.`); }
}

// Las llamadas del mismo proceso se encadenan (leer-modificar-escribir no es atómico y varias herramientas pueden llegar en paralelo).
// ponytail: sin bloqueo entre procesos; si dos clientes escriben a la vez gana el último, añadir lock si importa.
let cola: Promise<unknown> = Promise.resolve();
export function marcar(dir: string, entrada: unknown): Promise<Registro[]> {
  const r = cola.then(() => escribir(dir, entrada));
  cola = r.catch(() => {});
  return r;
}

async function escribir(dir: string, entrada: unknown): Promise<Registro[]> {
  const e = Entrada.parse(entrada); // antes de tocar el disco
  const resto = (await leer(dir)).filter((r) => r.servicio !== e.servicio);
  const lista = e.estado === "quitado" ? resto : [...resto, { servicio: e.servicio, estado: e.estado, fecha: new Date().toISOString() }];
  await mkdir(dir, { recursive: true, mode: 0o700 });
  const tmp = `${ruta(dir)}.${randomUUID()}.tmp`;
  await writeFile(tmp, JSON.stringify(lista, null, 2), { mode: 0o600 });
  await rename(tmp, ruta(dir));
  return lista;
}
