# Verificaciones previas (2026-10-02)

Solo investigación (docs y API pública); no se creó ningún recurso en la nube. Ids en `wrangler.toml` son `REPLACE_ME`.

## 1. Registro oficial de MCP

- URL base: `https://registry.modelcontextprotocol.io` (docs: `/docs`). Lista: `GET /v0.1/servers`.
- Parámetros: `limit` (probado hasta 100), `cursor`, `version=latest` (solo la última versión de cada servidor).
- Paginación por cursor: la respuesta trae `metadata: { nextCursor, count }`. `nextCursor` tiene forma `<nombre>:<version>` (p. ej. `ac.inference.sh/mcp:2.0.0`); sin `nextCursor` = última página. Pasar el cursor tal cual (codificado en URL).
- Forma de cada elemento: `{ server: {...}, _meta: { "io.modelcontextprotocol.registry/official": { status, statusChangedAt, publishedAt, updatedAt, isLatest } } }`.
- Campos de `server`: `name` (id único, estilo DNS inverso `ac.snag/snag`), `description` (siempre presente en 100/100 de la muestra), `title` (opcional, 82/100), `version`, `repository {url, source}` (opcional, 49/100), `websiteUrl` (opcional, 84/100), `icons` (opcional), `remotes[]`, `packages[]`, `$schema`.
- No hay un campo `id` separado: usar `name` (+ `version` para distinguir versiones).
- Versiones: sin `version=latest` cada versión aparece como elemento aparte con el mismo `name` y distinta `server.version`; `_meta...isLatest` indica la última. Con `version=latest` solo llegan las vigentes (`isLatest: true`). La ingesta debe usar `version=latest`; `actualizado` = `_meta...updatedAt`.
- Remoto vs local (el spec se cumple, SI se distinguen):
  - Remoto: `remotes[]` con `{ type: "streamable-http" | "sse", url, headers?[] }`.
  - Local: `packages[]` con `{ registryType: "npm"|"oci"|"pypi"|..., identifier, version, transport: { type: "stdio" }, environmentVariables?[] , packageArguments?... }`. Comando se deriva de `registryType` + `identifier`.
  - Puede haber ambos (entrada con remotes y packages) o ninguno (1/100 en la muestra: sin conexión; marcar incompleta; ej. `ai.agentxray/amazon-seller-mcp`).
- Autenticación: no existe un campo `auth`. Se deriva: remoto con `headers[]` con `isRequired`/`isSecret` (p. ej. `Authorization`) => `clave`; local con `environmentVariables[]` con `isRequired: true` e `isSecret: true` => `clave`; sin ellos => `ninguna` solo si hay conexión declarada sin requisitos (el registro no puede afirmar OAuth; `oauth` no es detectable de forma estructurada, queda `desconocida`/`ninguna` según regla del plan). Campos sin dato => `desconocida`, nunca inventar.
- Tamaño real del catálogo (con `version=latest`, 386 páginas de 100): **38.549 entradas**. Muchas son de calidad baja/spam; implica filtrar o muestrear (ver sección 3).
- Fixture: `tests/fixtures/registro-muestra.json` (`pagina_latest`: 7 entradas reales con remota con cabecera de clave, remota sin auth, local npm con variables secretas, local sin variables, remota+local, sin conexión, mínima; `pagina_versiones`: 3 versiones del mismo servidor). El `nextCursor` de `pagina_latest` se conservó de la consulta real original (limit=100), no corresponde a las 7 entradas recortadas.

## 2. Límites gratuitos

| Tema | Valor | Fuente |
|---|---|---|
| Vectorize: dimensiones máx. | 1536 (32 bits) | https://developers.cloudflare.com/vectorize/platform/limits/ |
| Vectorize: vectores por índice | 20.000.000 | idem |
| Vectorize: topK máx. | 50 con valores/metadatos, 100 sin ellos | idem |
| Vectorize plan Free | 5 M dimensiones almacenadas, 30 M consultadas / mes | https://developers.cloudflare.com/vectorize/platform/pricing/ |
| Embeddings multilingüe | `@cf/baai/bge-m3`, ventana 60.000 tokens; 1075 neuronas por M tokens de entrada | https://developers.cloudflare.com/workers-ai/models/bge-m3/ , https://developers.cloudflare.com/workers-ai/platform/pricing/ |
| Dimensiones de bge-m3 | 1024 según la ficha del modelo BAAI; **NO verificado en la doc de Cloudflare** (la página no lo indica). Comprobar con una llamada real en Task 4 | - |
| Workers AI gratis | 10.000 neuronas/día (reinicia 00:00 UTC) | https://developers.cloudflare.com/workers-ai/platform/pricing/ |
| Workers Free | 100.000 peticiones/día, 10 ms CPU, 50 subpeticiones/petición | https://developers.cloudflare.com/workers/platform/limits/ |
| Rate limiting binding | `[[ratelimits]] name, namespace_id; [ratelimits.simple] limit, period` con `period` solo 10 o 60 s; contadores por ubicación; wrangler >= 4.36.0. Sin cargo extra aparte de las peticiones (según búsqueda web; la doc oficial no lista restricción de plan, no confirmado explícitamente para Free) | https://developers.cloudflare.com/workers/runtime-apis/bindings/rate-limit/ |
| R2 gratis | 10 GB-mes, 1 M operaciones clase A, 10 M clase B / mes, salida gratis (solo Standard) | https://developers.cloudflare.com/r2/pricing/ |
| R2 ciclo de vida | Regla por prefijo con `Expiration: { Days: N }`; `npx wrangler r2 bucket lifecycle add <bucket>`; máx. 1000 reglas; borrado en ~24 h | https://developers.cloudflare.com/r2/buckets/object-lifecycles/ |
| Helper MCP remoto sin estado | `createMcpHandler` del paquete `agents` (`agents/mcp`; la doc lo cita como `agents/mcp/server`... verificar import exacto al instalar). `McpAgent` está obsoleto/congelado; SSE superado por Streamable HTTP | https://developers.cloudflare.com/agents/model-context-protocol/transport/ |

## 3. Decisiones

- **Vectorize no cabe tal cual con el catálogo completo**: 38.549 x 1024 = ~39,5 M dimensiones frente a 5 M gratis (cabrían ~4.880 vectores a 1024-d, ~13.000 a 384-d). Los 20 M de vectores por índice no son el límite real; lo es la cuota de dimensiones almacenadas. Dos salidas, decisión del controlador:
  1. Mantener Vectorize e ingerir solo un subconjunto (p. ej. filtrar por calidad: con descripción útil, conexión válida, `repository` o `websiteUrl`, dedup por organización) hasta ~4.800 entradas.
  2. Tabla de vectores en D1 con búsqueda por fuerza bruta: inviable con 10 ms CPU y 38 k x 1024 floats, salvo preselección previa (p. ej. filtrar candidatos con FTS5 y reordenar).
  Mientras no se decida, el andamiaje asume Vectorize (`VECTORS`) y modelo `@cf/baai/bge-m3` (único multilingüe de Workers AI verificado).
- Coste de embeddings: 38,5 k entradas x ~60 tokens = ~2,3 M tokens ~ 2.500 neuronas, cabe en los 10.000/día; la ingesta debe ser incremental.
- Helper MCP: `createMcpHandler` (paquete `agents`) por defecto; si da problemas, SDK `@modelcontextprotocol/sdk` con transporte Streamable HTTP web-standard. `agents` no se instaló aún (se añade en la tarea del Worker).
- Límite de peticiones: binding `LIMITER` (30 por 60 s por cliente, valor inicial).
