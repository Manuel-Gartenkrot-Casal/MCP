# Catálogo MCP con búsqueda por significado — Diseño

Fecha: 2026-10-02

## Objetivo

Un servidor MCP público y gratuito, alojado en Cloudflare, que ayuda a cualquier IA (o persona) a encontrar el servidor MCP adecuado para una necesidad. Busca por función y conectividad, no solo por palabras clave, y dice cómo conectarse. Es la primera fase de una idea mayor: un buscador/orquestador de IAs.

## Alcance de este spec

Dentro:
- Ingesta del registro oficial de MCP (única fuente).
- Herramienta MCP `buscar(necesidad, filtros?)`, solo lectura.
- Búsqueda por embeddings con filtros por conectividad.
- Log append-only de búsquedas (auditoría y mejora del ranking).

Fuera (fases futuras):
- Conectar o ejecutar herramientas de otros servidores (pasarela).
- Otras fuentes: Smithery, Agent Cards de A2A.
- Orquestación entre varias IAs.
- Creación automática de cuentas.
- Clasificación de la función con LLM al ingerir (solo si las pruebas muestran que hace falta).

## Restricciones

- Gratuito: Cloudflare Workers (100.000 peticiones/día, 10 ms de CPU por petición) y D1. Límites a verificar al planificar.
- Sin event sourcing: el catálogo es un dato de referencia de lectura mayoritaria. SQLite basta. Solo se mantiene un log append-only de búsquedas.
- Funciona para cualquier cliente MCP.

## Arquitectura

Dos piezas que comparten D1.

**Ingesta** (script programado fuera de Workers, p. ej. GitHub Action):
lee el registro oficial, y por cada entrada nueva o cambiada guarda sus datos, deriva la conectividad de los campos estructurados (sin LLM), calcula el embedding y escribe en D1. Si el registro falla, D1 conserva el último catálogo bueno.

**Servidor MCP** (Cloudflare Worker): expone `buscar`. Convierte la consulta en embedding, busca los más cercanos y devuelve resultados con cómo conectar y qué requieren. No ejecuta ni conecta nada.

**Almacenamiento:**
- D1 (SQLite): catálogo y metadatos.
- Vectorize o tabla de vectores en D1: embeddings (decidir según límites gratuitos).
- Log JSONL de búsquedas (p. ej. en R2), con retención limitada.

## Entrada del catálogo

| Campo | Contenido | Origen |
|---|---|---|
| `id` | Identificador único | Registro |
| `nombre` | Nombre del servidor | Registro |
| `descripcion` | Qué hace | Registro |
| `url_info` | Repositorio o página | Registro |
| `tipo_conexion` | `remoto` o `local` | Registro |
| `como_conectar` | Endpoint (remoto) o comando y paquete (local) | Registro |
| `auth` | `ninguna`, `clave`, `oauth`, `desconocida` | Registro |
| `embedding` | Vector de nombre + descripción | Ingesta |
| `actualizado` | Fecha de la última versión vista | Ingesta |

Los campos exactos del registro se confirman al implementar. Si un campo no existe, `auth` queda `desconocida` y la entrada se marca incompleta, nunca se inventa el dato. El embedding se recalcula solo cuando `actualizado` cambia.

## Búsqueda: `buscar(necesidad, filtros?)`

1. Embedding de `necesidad` (modelo de Workers AI, límites gratuitos a verificar).
2. Los N más cercanos (p. ej. 20).
3. Filtros duros sobre `tipo_conexion` y `auth`.
4. Devuelve 5–10 con nombre, función, cómo conectar, requisitos y puntaje de similitud.
5. Si el mejor puntaje está bajo un umbral, responde "sin coincidencias fiables".

## Errores

- Registro caído o formato distinto: la ingesta falla sin modificar D1; el fallo va al log.
- Entrada incompleta: se guarda marcada, no se descarta.
- Sin coincidencias fiables: se dice explícitamente.
- Límite diario superado: mensaje claro de Cloudflare, sin evasión.

## Seguridad

- El catálogo es contenido de terceros no confiable (riesgo de inyección de instrucciones en descripciones). `buscar` devuelve los textos como datos delimitados, con longitud recortada, sin mezclarlos con instrucciones del servidor.
- Solo lectura: no maneja credenciales de nadie.
- Límite de peticiones por cliente en el Worker contra abuso de la cuota (mecanismo exacto en el plan).
- El log guarda la consulta sin identidad y con retención limitada.

## Pruebas y criterio de éxito

1. Ingesta: respuestas de ejemplo del registro, incluidos entrada incompleta y formato roto.
2. Búsqueda: unas 20 necesidades en lenguaje natural con respuesta conocida. Criterio de éxito: porcentaje de casos en que la entrada correcta aparece entre los 5 primeros.
3. Seguridad: entrada de prueba con instrucciones maliciosas en la descripción, que debe salir tratada como dato.

## Preguntas abiertas para el plan

- Vectorize frente a tabla de vectores en D1 (límites gratuitos).
- Modelo de embeddings concreto y su límite gratuito.
- Esquema real de la API del registro oficial de MCP.
- Mecanismo de límite de peticiones por cliente.
- Umbral de similitud para "sin coincidencias fiables" (se calibra con el conjunto de pruebas).
