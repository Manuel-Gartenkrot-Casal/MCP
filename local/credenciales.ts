// Contraseñas aleatorias por servicio y filas CSV (name,url,username,password: lo que importan Chrome, Bitwarden y 1Password).
import { randomInt } from "node:crypto";
import { appendFile, mkdir, writeFile } from "node:fs/promises";
import { dirname } from "node:path";

export const CSV_CABECERA = "name,url,username,password";
export type Fila = { nombre: string; url: string; usuario: string; password: string };

const MIN = "abcdefghijklmnopqrstuvwxyz", MAY = "ABCDEFGHIJKLMNOPQRSTUVWXYZ", NUM = "0123456789", SIM = "!@#$%^&*-_";
const elegir = (s: string) => s[randomInt(s.length)];

export function generarPassword(): string {
  const todos = MIN + MAY + NUM + SIM;
  const c = [elegir(MIN), elegir(MAY), elegir(NUM), elegir(SIM), ...Array.from({ length: 16 }, () => elegir(todos))];
  for (let i = c.length - 1; i > 0; i--) { const j = randomInt(i + 1); [c[i], c[j]] = [c[j], c[i]]; } // Fisher-Yates
  // Nunca empieza por símbolo: filaCsv antepone ' a =+-@ y la contraseña importada ya no sería la real.
  const k = c.findIndex((x) => !SIM.includes(x));
  [c[0], c[k]] = [c[k], c[0]];
  return c.join("");
}

// Celda: neutraliza fórmulas (=,+,-,@,tab,CR) y entrecomilla si hace falta (RFC 4180).
function celda(v: string): string {
  const t = /^[=+\-@\t\r]/.test(v) ? "'" + v : v;
  return /[",\n\r]/.test(t) ? '"' + t.replace(/"/g, '""') + '"' : t;
}

export const filaCsv = (f: Fila): string => [f.nombre, f.url, f.usuario, f.password].map(celda).join(",");

export async function anadirCredencial(ruta: string, f: Fila): Promise<void> {
  await mkdir(dirname(ruta), { recursive: true });
  // `wx` falla si ya existe; así la cabecera se escribe una sola vez y el modo 0600 solo al crear.
  try { await writeFile(ruta, CSV_CABECERA + "\n", { flag: "wx", mode: 0o600 }); } catch (e: any) { if (e?.code !== "EEXIST") throw e; }
  await appendFile(ruta, filaCsv(f) + "\n");
}
