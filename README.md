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
2. Ordena por calidad (remoto, con URL, descripción útil, reciente) y se queda con las mejores 4.500 (`MAX_VECTORS`).
3. Genera embeddings con `@cf/baai/bge-m3` (1024 dimensiones), los sube a Vectorize y guarda las fichas en D1.
4. El Worker embebe la consulta, busca vecinos en Vectorize, lee las fichas en D1 y descarta resultados bajo el umbral (0.5 provisional).
5. Cada búsqueda se registra en R2 (consulta, filtros, nº de resultados) y se borra a los 30 días.

Limitación honesta: solo se indexan ~4.500 de las ~38.500 entradas del registro (el límite gratuito de Vectorize son 5 M de dimensiones almacenadas, ~4.880 vectores a 1024-d); el resto no aparece en las búsquedas. Los resultados son texto de terceros (nombres y descripciones del registro) y se entregan delimitados como datos, no como instrucciones.

## Despliegue

Una sola vez, con tu cuenta de Cloudflare (`npx wrangler login` antes):

1. Instala dependencias: `npm ci`
2. Crea la base D1: `npx wrangler d1 create catalogo-mcp` y copia el `database_id`.
3. Aplica la migración: `npx wrangler d1 migrations apply catalogo-mcp --remote`
4. Crea el índice Vectorize (las dimensiones deben coincidir con `EMBEDDING_DIMS`, 1024; la métrica cosine es la elegida para bge-m3, por verificar):
   `npx wrangler vectorize create catalogo-mcp --dimensions=1024 --metric=cosine`
5. Crea el bucket R2: `npx wrangler r2 bucket create catalogo-mcp-logs`
6. En `wrangler.toml`: reemplaza `REPLACE_ME` por el `database_id` real y el `namespace_id = "1001"` del rate limit por un id propio (es un valor de ejemplo, no uno real).
7. Regla de ciclo de vida de R2 (borra los logs de búsqueda a los 30 días):

       npx wrangler r2 bucket lifecycle add catalogo-mcp-logs --name expire-busquedas --prefix busquedas/ --expire-days 30

8. Publica: `npx wrangler deploy` (anota la URL `*.workers.dev`).
9. En GitHub, Settings > Secrets and variables > Actions, añade los 4 secretos:
   `CF_ACCOUNT_ID`, `CF_API_TOKEN` (con permisos D1 y Vectorize edit y Workers AI read; alcance exacto por verificar), `CF_D1_DATABASE_ID`, `CF_VECTORIZE_INDEX` (`catalogo-mcp`).
10. Lanza la ingesta una vez: pestaña Actions > `ingest` > Run workflow. Revisa en el log `nuevas / omitidas / fallidas / fuera_de_cupo`.
11. Con la ingesta hecha, define las 4 variables de entorno del paso 9 en tu shell y ejecuta `npm run eval`. Pon el umbral recomendado como valor por defecto de `umbral` en `src/search/buscar.ts` (ahora `0.5`), vuelve a desplegar.
12. Prueba de humo: añade la URL a un cliente MCP (ver arriba) y llama a `buscar` con una necesidad real; comprueba que devuelve resultados y que una consulta absurda devuelve "sin coincidencias".

## Desarrollo

    npm test                  # vitest
    npx tsc --noEmit -p .     # tipos
    npm run eval              # evalúa contra el índice real (requiere las 4 variables CF_*)
    npm run dev               # wrangler dev

## Límites conocidos

- Plan gratuito de Workers: 100.000 peticiones/día y 10 ms de CPU por petición.
- Rate limit: 30 peticiones por 60 s por cliente (IP), contadores por ubicación; si el limitador falla, el servicio sigue abierto.
- Peticiones: solo `POST`, cuerpo máx. 16 KB.
- Vectores obsoletos: si una entrada sale del top 4.500 no se elimina de Vectorize ni de D1 (no hay poda).
- Que `bge-m3` devuelva 1024 dimensiones y la forma de la respuesta de Workers AI (`data[0]`) solo se confirmarán en la primera ejecución real (por verificar).
- Workers AI gratis: 10.000 neuronas/día; la ingesta es incremental para caber.
- El catálogo depende del registro oficial; entradas sin conexión declarada se marcan incompletas y la autenticación `oauth` no es detectable (por verificar).
