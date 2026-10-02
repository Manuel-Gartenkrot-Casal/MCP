export type Auth = "ninguna" | "clave" | "oauth" | "desconocida";
export type Conexion = "remoto" | "local";
export interface Entry {
  id: string;
  nombre: string;
  descripcion: string;
  url_info: string | null;
  tipo_conexion: Conexion;
  como_conectar: string;
  auth: Auth;
  incompleta: boolean;
  actualizado: string;
}
