CREATE TABLE IF NOT EXISTS entradas (
  id TEXT PRIMARY KEY,
  nombre TEXT NOT NULL,
  descripcion TEXT NOT NULL,
  url_info TEXT,
  tipo_conexion TEXT NOT NULL,
  como_conectar TEXT NOT NULL,
  auth TEXT NOT NULL,
  incompleta INTEGER NOT NULL DEFAULT 0,
  actualizado TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_entradas_tipo_conexion ON entradas (tipo_conexion);
CREATE INDEX IF NOT EXISTS idx_entradas_auth ON entradas (auth);
