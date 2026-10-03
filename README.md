# catalogo-mcp-busqueda

Servidor MCP público, gratuito y de solo lectura, en Cloudflare Workers. Expone una única herramienta:

`buscar(necesidad, tipo_conexion?, auth?)`: busca por significado en un catálogo de servidores MCP y devuelve los más relevantes con cómo conectarlos.

- `necesidad`: texto libre (máx. 2000 caracteres), en español o inglés.
- `tipo_conexion`: `remoto` | `local`. `auth`: `ninguna` | `clave` | `oauth` | `desconocida`.

## Añadirlo a un cliente MCP

El Worker no distingue rutas: responde a cualquier ruta, solo con `POST` (Streamable HTTP sin estado, respuestas JSON). Usa `/mcp` por convención:

    https://<tu-worker>.workers.dev/mcp

Claude Code (sintaxis por verificar con tu versión):

    claude mcp add --transport http catalogo https://<tu-worker>.workers.dev/mcp

Otros clientes con Streamable HTTP (forma del JSON por verificar según el cliente):

    { "mcpServers": { "catalogo": { "type": "http", "url": "https://<tu-worker>.workers.dev/mcp" } } }

## Cómo funciona

1. Una GitHub Action diaria (`.github/workflows/ingest.yml`) lee el registro oficial de MCP (`version=latest`).
2. Descarta las entradas sin forma de conexión declarada y las de id de más de 64 bytes (límite de Vectorize); ordena el resto por calidad (remoto, con URL, descripción útil, reciente) y se queda con las mejores 4.500 (`MAX_VECTORS`).
3. Borra de Vectorize y luego de D1 las entradas que han salido de ese top (salvo si el registro devolvió menos de la mitad de lo almacenado). Genera embeddings con `@cf/baai/bge-m3` (1024 dimensiones) en lotes de 50, los sube a Vectorize y guarda las fichas en D1 (reintenta 429/5xx). Si alguna entrada falla, la ejecución de la Action termina en error.
4. El Worker embebe la consulta, busca vecinos en Vectorize (50; 100 si hay filtros), lee las fichas en D1 y aplica los filtros. Si el mejor puntaje vectorial queda bajo el umbral (`UMBRAL_VECTOR`, 0.5 provisional) responde "sin coincidencias fiables"; si no, devuelve hasta 10 resultados con su puntaje vectorial.
   Existe un paso de reranker (`@cf/baai/bge-reranker-base`, con fallback al orden vectorial si falla) pero está DESACTIVADO (`RERANK_ENABLED = false` en `src/search/buscar.ts`): ver "Límites conocidos". Mientras esté desactivado no se llama a Workers AI para el reranker.
5. Cada búsqueda se registra en R2 (consulta, filtros, nº de resultados) y se borra a los 30 días.

Limitación honesta: solo se indexan ~4.500 de las ~38.500 entradas del registro (el límite gratuito de Vectorize son 5 M de dimensiones almacenadas, ~4.880 vectores a 1024-d); el resto no aparece en las búsquedas. Los resultados son texto de terceros (nombres y descripciones del registro) y se entregan delimitados como datos, no como instrucciones.

## Despliegue

Una sola vez, con tu cuenta de Cloudflare (`npx wrangler login` antes):

1. Instala dependencias: `npm ci`
2. Crea la base D1: `npx wrangler d1 create catalogo-mcp` y copia el `database_id`.
3. En `wrangler.toml`, reemplaza `database_id = "REPLACE_ME"` por ese id. Si `wrangler d1 create` ofrece escribir el binding en `wrangler.toml`, di que no (o borra el bloque que añada): ya existe un `[[d1_databases]]` con `binding = "DB"` y no debe quedar duplicado.
4. Aplica la migración: `npx wrangler d1 migrations apply catalogo-mcp --remote`
5. Crea el índice Vectorize (las dimensiones deben coincidir con `EMBEDDING_DIMS`, 1024; la métrica cosine es la elegida para bge-m3, por verificar):
   `npx wrangler vectorize create catalogo-mcp --dimensions=1024 --metric=cosine`
6. Crea el bucket R2: `npx wrangler r2 bucket create catalogo-mcp-logs`. Activar R2 en la cuenta puede pedir un método de pago aunque se quede en el plan gratuito.
7. En `wrangler.toml`: reemplaza el `namespace_id = "1001"` del rate limit por un id propio (es un valor de ejemplo, no uno real).
8. Regla de ciclo de vida de R2 (borra los logs de búsqueda a los 30 días; nombres de las opciones `--name/--prefix/--expire-days` por verificar con `npx wrangler r2 bucket lifecycle add --help`):

       npx wrangler r2 bucket lifecycle add catalogo-mcp-logs --name expire-busquedas --prefix busquedas/ --expire-days 30

9. Publica: `npx wrangler deploy` (anota la URL `*.workers.dev`).
10. En GitHub, Settings > Secrets and variables > Actions, añade los 4 secretos:
   `CF_ACCOUNT_ID`, `CF_API_TOKEN` (con permisos D1 y Vectorize edit y Workers AI read; alcance exacto por verificar), `CF_D1_DATABASE_ID`, `CF_VECTORIZE_INDEX` (`catalogo-mcp`).
11. Lanza la ingesta una vez: pestaña Actions > `ingest` > Run workflow. Revisa en el log `nuevas / omitidas / fallidas / fuera_de_cupo / podadas`.
12. Con la ingesta hecha, define las 4 variables de entorno del paso 10 en tu shell y ejecuta `npm run eval`. El informe compara solo vector y con reranker. Pon el umbral recomendado del modo vectorial en `UMBRAL_VECTOR` de `src/search/buscar.ts` (ahora `0.5`), vuelve a desplegar.
13. Prueba de humo: añade la URL a un cliente MCP (ver arriba) y llama a `buscar` con una necesidad real; comprueba que devuelve resultados y que una consulta absurda devuelve "sin coincidencias".

## Desarrollo

    npm test                  # vitest
    npx tsc --noEmit -p .     # tipos
    npm run eval              # evalúa vector vs reranker contra el índice real (requiere las 4 variables CF_*)
    npm run dev               # wrangler dev

## Límites conocidos

- Plan gratuito de Workers: 100.000 peticiones/día y 10 ms de CPU por petición.
- Rate limit: 30 peticiones por 60 s por cliente (IP), contadores por ubicación; si el limitador falla, el servicio sigue abierto.
- Peticiones: solo `POST`, cuerpo máx. 16 KB.
- Poda: las entradas que salen del top 4.500 se borran en cada ingesta; si el registro devuelve vacío o menos de la mitad de lo almacenado, la poda se omite (aviso en el log) para no vaciar el índice.
- GitHub desactiva los workflows programados tras 60 días sin actividad en el repositorio; si la ingesta deja de ejecutarse, reactívala en la pestaña Actions.
- Que `bge-m3` devuelva 1024 dimensiones y la forma de la respuesta de Workers AI en lote (`data`: un vector por texto) solo se confirmarán en la primera ejecución real (por verificar).
- Workers AI gratis: 10.000 neuronas/día; la ingesta es incremental para caber.
- El catálogo depende del registro oficial; las entradas sin conexión declarada (ni remota ni paquete) se omiten, y la autenticación `oauth` no es detectable, así que nunca se emite (los remotos sin cabeceras declaradas quedan como `desconocida`).
- Reranker implementado pero DESACTIVADO (2026-10-02). Eval real sobre el índice desplegado: solo vector, top-5 12/20 (en 6/12, es 6/8); con reranker 13/20 (en 8/12, es 5/8): +1 caso en total y el español empeora. Los puntajes de `bge-reranker-base` (probabilidades en [0,1], respuesta ordenada por puntaje y alineada por `id`) son diminutos para consultas en lenguaje natural (0.000-0.003), así que ningún umbral absoluto sirve y las consultas legítimas en español se rechazaban. Reactivar: `RERANK_ENABLED = true`, repetir `npm run eval` (el barrido del reranker incluye umbrales 0.001-0.99) y recalibrar `UMBRAL_RERANK` (0.5, sin calibrar). Lo siguiente a probar sería un reranker multilingüe (tipo `bge-reranker-v2-m3`, solo si existe en Workers AI; por verificar). Sin verificar: que el binding `env.AI` del Worker devuelva la misma forma que la REST y el límite de contextos con 100 candidatos.
