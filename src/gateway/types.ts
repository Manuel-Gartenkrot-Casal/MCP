export type Marca = "solo_lectura" | "destructiva" | "sin_declarar";
export interface ToolInfo { nombre: string; descripcion: string; parametros: string; marca: Marca }
export type GwCode = "no_encontrado" | "no_remoto" | "requiere_auth" | "timeout" | "destino_caido"
  | "herramienta_inexistente" | "sesion_expirada" | "sesion_otro_servidor" | "desactivada" | "confirmar" | "entrada_invalida";
export type Salida<T> = { ok: true; valor: T } | { ok: false; code: GwCode; marca?: Marca };

// Frases fijas: nunca texto de terceros. Solo `confirmar` añade la marca (enum propio).
const MENSAJES: Record<GwCode, string> = {
  no_encontrado: "Servidor no encontrado en el catálogo.",
  no_remoto: "El servidor no tiene un destino remoto válido.",
  requiere_auth: "Este servidor requiere autenticación; no está soportado.",
  timeout: "El servidor remoto no respondió a tiempo.",
  destino_caido: "El servidor remoto no está disponible.",
  herramienta_inexistente: "La herramienta no existe en ese servidor.",
  sesion_expirada: "La sesión ha expirado; vuelve a explorar el servidor.",
  sesion_otro_servidor: "La sesión pertenece a otro servidor.",
  desactivada: "La pasarela está desactivada.",
  confirmar: "",
  entrada_invalida: "Entrada inválida.",
};

export class GatewayError extends Error {
  constructor(public code: GwCode, marca?: Marca) {
    super(code === "confirmar"
      ? `La herramienta no está marcada como de solo lectura (marca: ${marca ?? "sin_declarar"}). Repite la llamada con confirmar: true si quieres ejecutarla.`
      : MENSAJES[code]);
    this.name = "GatewayError";
  }
}
