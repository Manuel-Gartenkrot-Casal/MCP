# catalogo-mcp-busqueda

Servidor MCP público, gratuito y de solo lectura, en Cloudflare Workers. Expone tres herramientas (`buscar`, `explorar`, `llamar`; las dos últimas son la pasarela, ver "Pasarela: explorar y llamar"):

`buscar(necesidad, tipo_conexion?, auth?)`: busca por significado en un catálogo de servidores MCP y devuelve los más relevantes con su `id` y cómo conectarlos.

- `necesidad`: texto libre (máx. 2000 caracteres), en español o inglés.
- `tipo_conexion`: `remoto` | `local`. `auth`: `ninguna` | `clave` | `oauth` | `desconocida` (`oauth` se acepta como filtro pero el catálogo nunca lo asigna, así que no devuelve resultados).

## Añadirlo a un cliente MCP

**Servicio en producción** (desplegado y probado el 2026-10-03; pasarela encendida):
El Worker no distingue rutas: responde a cualquier ruta, solo con `POST` (Streamable HTTP sin estado, respuestas JSON). Usa `/mcp` por convención:

    https://catalogo-mcp-busqueda.manuelgartenkrotcasal.workers.dev/mcp

Claude Code (verificado: `claude mcp list` lo muestra como Connected; la herramienta aparece en una sesión nueva):

    claude mcp add --transport http catalogo https://catalogo-mcp-busqueda.manuelgartenkrotcasal.workers.dev/mcp

Otros clientes con Streamable HTTP (forma del JSON por verificar según el cliente):

    { "mcpServers": { "catalogo": { "type": "http", "url": "https://catalogo-mcp-busqueda.manuelgartenkrotcasal.workers.dev/mcp" } } }

## Cómo funciona

1. Una GitHub Action diaria (`.github/workflows/ingest.yml`) lee el registro oficial de MCP (`version=latest`).
2. Descarta las entradas sin forma de conexión declarada y las de id de más de 64 bytes (límite de Vectorize); ordena el resto por calidad (remoto, con URL, descripción útil, reciente) y se queda con las mejores 4.500 (`MAX_VECTORS`).
3. Borra de Vectorize y luego de D1 las entradas que han salido de ese top (salvo si el registro devolvió menos de la mitad de lo almacenado o la poda borraría más de la mitad del índice; sin poda, las entradas nuevas no superan `MAX_VECTORS`). Genera embeddings con `@cf/baai/bge-m3` (1024 dimensiones) en lotes de 50, los sube a Vectorize y guarda las fichas en D1 (reintenta 429/5xx). Si alguna entrada falla, la ejecución de la Action termina en error.
4. El Worker embebe la consulta, busca vecinos en Vectorize (50; 100 si hay filtros), lee las fichas en D1 y aplica los filtros. Si el mejor puntaje vectorial queda bajo el umbral (`UMBRAL_VECTOR`, 0.5 provisional) responde "sin coincidencias fiables"; si no, devuelve hasta 10 resultados con su puntaje vectorial.
   Existe un paso de reranker (`@cf/baai/bge-reranker-base`, con fallback al orden vectorial si falla) pero está DESACTIVADO (`RERANK_ENABLED = false` en `src/search/buscar.ts`): ver "Límites conocidos". Mientras esté desactivado no se llama a Workers AI para el reranker.
5. Cada búsqueda se registra en R2 (consulta, filtros, nº de resultados) y se borra a los 30 días.

Limitación honesta: solo se indexan ~4.500 de las ~38.500 entradas del registro (el límite gratuito de Vectorize son 5 M de dimensiones almacenadas, ~4.880 vectores a 1024-d); el resto no aparece en las búsquedas. Los resultados son texto de terceros (nombres y descripciones del registro) y se entregan delimitados como datos, no como instrucciones.

## Pasarela: explorar y llamar

Flujo: `buscar` (devuelve el `id`) → `explorar` (lista las herramientas del servidor remoto) → `llamar` (ejecuta una). El Worker actúa de cliente MCP hacia el destino, sin autenticación, a través de un Durable Object (`SesionDO`) por token de sesión.

- `explorar(servidor, sesion?)`: lista hasta 50 herramientas (salida máx. 16 KB) con nombre, descripción, parámetros y una marca. Devuelve un token `sesion`. Cada `explorar` (también con un `sesion` ya usado) vuelve a inicializar la sesión con el destino y a listar sus herramientas.
- `llamar(servidor, herramienta, argumentos?, sesion?, confirmar?)`: ejecuta la herramienta y devuelve también el token `sesion`. Sin `sesion` explora antes y crea una; si después la llamada falla (por ejemplo, falta `confirmar`), el error termina con la línea `sesion: <token>` para reintentar sobre esa sesión. Si el `explorar` interno falla no hay token.
- Límites: `servidor` ≤ 128 caracteres; `sesion` = token de 32 hex devuelto por las herramientas, caduca a los 10 min sin uso (cada llamada correcta renueva esos 10 min); `herramienta` `[A-Za-z0-9_.-]{1,128}`; `argumentos` objeto JSON ≤ 16 KB (el esquema publicado es `type: object`; un array, texto o `null` lo rechaza la validación del SDK); resultado ≤ 32 KB (se corta con `[truncado]`); respuesta del destino ≤ 256 KB y 20 s de timeout.
- Solo servidores REMOTOS SIN autenticación. Si el destino responde 401/403 se devuelve "Este servidor requiere autenticación; no está soportado.". El catálogo no puede saber de antemano cuáles la exigen (`auth` es `desconocida` en los remotos sin cabeceras declaradas). Medido el 2026-10-03 con un sondeo de solo lectura (handshake) sobre 100 remotos al azar: 57 respondieron `tools/list` sin autenticación, 42 exigían autenticación (401/403) y 1 devolvió 404. En los 57 se listaron 850 herramientas: 643 de solo lectura, 42 destructivas y 165 sin declarar. Muestra pequeña (±10 puntos aprox.).
- Confirmación: `solo_lectura` se ejecuta directamente; `destructiva` y `sin_declarar` exigen `confirmar: true`. La marca sale de las anotaciones del propio destino (son declaraciones, no garantías): `destructiveHint: true` gana siempre (`destructiva`); si no, `readOnlyHint: true` da `solo_lectura`; cualquier otro caso, incluido no declarar anotaciones, es `sin_declarar`.
- Aislamiento: cada token es una sesión; un token no vale para otro servidor ("La sesión pertenece a otro servidor."). Las sesiones no se renuevan en silencio: al caducar, o si el destino olvidó su sesión (responde 404), se devuelve "La sesión ha expirado; vuelve a explorar el servidor." y basta con `explorar` (con el mismo token o sin él).
- Rate limit por IP: `explorar` 20/min, `llamar` 10/min, además del global de 30/min. Los lotes JSON-RPC (un array de peticiones en un solo POST) se rechazan con 400: los límites cuentan peticiones HTTP y un lote multiplicaría el coste.
- Interruptor: la variable `GATEWAY_ENABLED` de `wrangler.toml` (`"1"` activa; cualquier otro valor responde "La pasarela está desactivada." sin tocar D1, el DO ni la red). El valor publicado por defecto es `"0"` (ver Despliegue). Se cambia en `wrangler.toml` y `npx wrangler deploy`; también desde el panel (Settings > Variables), pero el siguiente `wrangler deploy` lo vuelve a dejar con el valor del toml salvo que se use `keep_vars`.
- Bloqueo por servidor: `GATEWAY_BLOQUEADOS` en `wrangler.toml`, ids del catálogo separados por comas (exactos, sensibles a mayúsculas). Un id bloqueado responde igual que uno desconocido ("Servidor no encontrado en el catálogo.").
- Identidad: las peticiones al destino llevan `User-Agent: catalogo-mcp-busqueda/0.1 (+https://github.com/Manuel-Gartenkrot-Casal/MCP)` como contacto. El Worker rechaza (403) las peticiones entrantes con ese prefijo de User-Agent para no llamarse a sí mismo.
- Registro en R2 bajo `llamadas/` (id de servidor, nombre de herramienta, marca, tipo de resultado, duración; nunca argumentos ni resultados), borrado a los 30 días. `explorar` se registra con herramienta `(explorar)`. Solo se registran las peticiones que pasan la puerta: los rechazos por interruptor, rate limit, validación, búsqueda en D1 o validación de la URL no se registran.
- Todo texto que viene del destino se sanitiza y se entrega delimitado como `<dato>…</dato>`: es contenido no confiable, no instrucciones.
- Responsabilidad: una herramienta sin autenticación puede tener efectos en un servicio de terceros, ejecutados desde IPs de Cloudflare. La confirmación existe por eso, y el operador puede apagar la pasarela con `GATEWAY_ENABLED` o un servidor concreto con `GATEWAY_BLOQUEADOS`.

## Despliegue

Una sola vez, con tu cuenta de Cloudflare (`npx wrangler login` antes):

1. Instala dependencias: `npm ci`
2. Crea la base D1: `npx wrangler d1 create catalogo-mcp` y copia el `database_id`.
3. En `wrangler.toml`, reemplaza `database_id = "REPLACE_ME"` por ese id. `wrangler d1 create` sugiere un binding llamado `catalogo_mcp`: no lo uses (ni dejes el bloque duplicado); el código espera el `[[d1_databases]]` existente con `binding = "DB"`.
4. Aplica la migración: `npx wrangler d1 migrations apply catalogo-mcp --remote`
5. Crea el índice Vectorize (las dimensiones deben coincidir con `EMBEDDING_DIMS`, 1024; la métrica cosine es la elegida para bge-m3; en el despliegue real Vectorize guarda 4.500 vectores de 1024 dimensiones):
   `npx wrangler vectorize create catalogo-mcp --dimensions=1024 --metric=cosine`
6. Crea el bucket R2: `npx wrangler r2 bucket create catalogo-mcp-logs`. Hay que activar R2 antes en el panel de Cloudflare (si no, error 10042); puede pedir un método de pago aunque se quede en el plan gratuito.
7. En `wrangler.toml`: los `namespace_id` de los tres rate limits (48291-48293) son enteros elegidos para esta cuenta; cámbialos si tu cuenta ya los usa.
8. Regla de ciclo de vida de R2 (borra los logs de búsqueda a los 30 días; opciones `--name/--prefix/--expire-days` verificadas con `--help`; `--force` omite la confirmación):

       npx wrangler r2 bucket lifecycle add catalogo-mcp-logs --name expire-busquedas --prefix busquedas/ --expire-days 30

9. Publica: `npx wrangler deploy` (anota la URL `*.workers.dev`). Puede tardar un poco en propagarse: las primeras peticiones pueden llegar a la versión anterior.
10. En GitHub, Settings > Secrets and variables > Actions, añade los 4 secretos:
   `CF_ACCOUNT_ID`, `CF_API_TOKEN` (con permisos D1 y Vectorize edit y Workers AI read; alcance exacto por verificar), `CF_D1_DATABASE_ID`, `CF_VECTORIZE_INDEX` (`catalogo-mcp`).
11. Lanza la ingesta una vez: pestaña Actions > `ingest` > Run workflow. Revisa en el log `nuevas / omitidas / fallidas / fuera_de_cupo / podadas`.
12. Con la ingesta hecha, define las 4 variables de entorno del paso 10 en tu shell y ejecuta `npm run eval`. El informe compara solo vector y con reranker. Pon el umbral recomendado del modo vectorial en `UMBRAL_VECTOR` de `src/search/buscar.ts` (ahora `0.5`), vuelve a desplegar.
13. Prueba de humo: añade la URL a un cliente MCP (ver arriba) y llama a `buscar` con una necesidad real; comprueba que devuelve resultados y que una consulta absurda devuelve "sin coincidencias".

Pasarela (instrucciones para el usuario, después de lo anterior):

14. Vuelve a desplegar con la pasarela APAGADA (`GATEWAY_ENABLED = "0"`, el valor publicado): `npx wrangler deploy`. Al volver a desplegar se aplican la migración del Durable Object (`v1`, `SesionDO`), los dos rate limits nuevos y las variables.
15. Prueba de humo con la pasarela apagada: `buscar` sigue funcionando (y ahora devuelve `id`); `explorar` responde "La pasarela está desactivada." (interruptor comprobado).
16. Segunda regla de ciclo de vida de R2 (logs de la pasarela):

        npx wrangler r2 bucket lifecycle add catalogo-mcp-logs --name expire-llamadas --prefix llamadas/ --expire-days 30 --force

17. Pon `GATEWAY_ENABLED = "1"` en `wrangler.toml` y vuelve a desplegar: `npx wrangler deploy`.
18. Prueba de humo de la pasarela: con `buscar` obtén un `id`; `explorar` ese `id`; `llamar` a una herramienta `solo_lectura` con el `sesion` devuelto. Comprueba que un servidor que pide clave devuelve el mensaje de autenticación, que una herramienta sin marca pide `confirmar` y que una sesión caducada (espera más de 10 min, o usa una que el destino ya olvidó) devuelve "La sesión ha expirado; vuelve a explorar el servidor." y se recupera con `explorar`.

## Desarrollo

    npm test                  # vitest
    npx tsc --noEmit -p .     # tipos
    npm run eval              # evalúa vector vs reranker contra el índice real (requiere las 4 variables CF_*)
    npm run dev               # wrangler dev

## Límites conocidos

- Plan gratuito de Workers: 100.000 peticiones/día y 10 ms de CPU por petición.
- Rate limit: 30 peticiones por 60 s por cliente (IP), contadores por ubicación; si el limitador falla, el servicio sigue abierto.
- Peticiones: solo `POST`, cuerpo máx. 16 KB, sin lotes JSON-RPC (400).
- Poda: las entradas que salen del top 4.500 se borran en cada ingesta; si el registro devuelve vacío o menos de la mitad de lo almacenado, o si la poda borraría más de la mitad del índice, se omite (aviso en el log) para no vaciarlo; en ese caso las entradas nuevas que no quepan en `MAX_VECTORS` cuentan como `fuera_de_cupo`. Se ignoran las entradas con estado `deleted` del registro.
- Riesgo de bloqueo: si más de la mitad de lo almacenado queda obsoleta de golpe (cambio de ranking, reorganización del registro) la poda se omite en cada ejecución y, con el índice lleno, no entra ninguna entrada nueva; solo queda el aviso en el log. Recuperación manual: Actions > `ingest` > Run workflow > `force_prune` = true (no salta la guarda de registro vacío/diminuto).
- GitHub desactiva los workflows programados tras 60 días sin actividad en el repositorio; si la ingesta deja de ejecutarse, reactívala en la pestaña Actions.
- Workers AI gratis: 10.000 neuronas/día; la ingesta es incremental para caber.
- El catálogo depende del registro oficial; las entradas sin conexión declarada (ni remota ni paquete) se omiten, y la autenticación `oauth` no es detectable, así que nunca se emite (los remotos sin cabeceras declaradas quedan como `desconocida`).
- Las 4.500 entradas indexadas son todas remotas (el ranking de calidad llena el cupo con remotos primero), así que el filtro `tipo_conexion: "local"` de `buscar` hoy no devuelve resultados.
- Límites diarios de Durable Objects en Workers Free (peticiones, duración y filas escritas): no verificados (por verificar). La duración se factura mientras el DO espera al destino (hasta 20 s por llamada) y cada `explorar` escribe varias filas; un usuario intensivo podría agotar la cuota gratuita y la pasarela respondería "error interno" hasta el reinicio.
- R2 (por verificar): cada `buscar` y cada llamada de la pasarela que pasa la puerta hace un `put` (operación de clase A); con abuso intenso podría superarse el millón gratuito al mes.
- Cliente MCP saliente mínimo y propio: solo la primera página de `tools/list`, sin streaming hacia el cliente, sin recursos ni prompts.
- Un destino colgado retiene el cerrojo de esa sesión como máximo 20 s (el timeout).
- Reranker implementado pero DESACTIVADO (2026-10-02). Eval real sobre el índice desplegado: solo vector, top-5 12/20 (en 6/12, es 6/8); con reranker 13/20 (en 8/12, es 5/8): +1 caso en total y el español empeora. Los puntajes de `bge-reranker-base` (probabilidades en [0,1], respuesta ordenada por puntaje y alineada por `id`) son diminutos para consultas en lenguaje natural (0.000-0.003), así que ningún umbral absoluto sirve y las consultas legítimas en español se rechazaban. Reactivar: `RERANK_ENABLED = true`, repetir `npm run eval` (el barrido del reranker incluye umbrales 0.001-0.99) y recalibrar `UMBRAL_RERANK` (0.5, sin calibrar). Lo siguiente a probar sería un reranker multilingüe (tipo `bge-reranker-v2-m3`, solo si existe en Workers AI; por verificar). Sin verificar: que el binding `env.AI` del Worker devuelva la misma forma que la REST y el límite de contextos con 100 candidatos.
