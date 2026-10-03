import { GatewayError } from "./types";

const PROHIBIDO = /(^|\.)(localhost|local|internal)$/;

/** Barrera SSRF: solo https público por 443, sin credenciales ni IPs literales. Lanza no_remoto. */
export function validarDestino(url: string, hostPropio: string): URL {
  const no = () => new GatewayError("no_remoto");
  let u: URL;
  try { u = new URL(url); } catch { throw no(); }
  if (u.protocol !== "https:" || (u.port !== "" && u.port !== "443") || u.username || u.password) throw no();
  const h = u.hostname.toLowerCase().replace(/\.+$/, "");
  // hostPropio puede venir como `host` o `host:puerto` (URL.host en dev)
  const propio = String(hostPropio ?? "").trim().toLowerCase().replace(/:\d+$/, "").replace(/\.+$/, "");
  if (!h || h.includes("..") || h.startsWith("[") || h.includes(":") || h === propio || PROHIBIDO.test(h)) throw no();
  // IPv4 en cualquier forma: new URL ya normaliza decimal/hex/octal a dotted-quad; el resto
  // de hosts numéricos (último label sin letras) se rechaza igualmente.
  if (/^\d+(\.\d+){3}$/.test(h) || /(^|\.)(0x[0-9a-f]*|\d+)$/.test(h)) throw no();
  return u;
}
