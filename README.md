# catalogo-mcp-busqueda

Servidor MCP público, gratuito y de solo lectura, en Cloudflare Workers. Expone cuatro herramientas (`buscar`, `servicios`, `explorar`, `llamar`; las dos últimas son la pasarela, ver "Pasarela: explorar y llamar"; `servicios`, ver "Servicios gratuitos y memoria local"):

`buscar(necesidad, tipo_conexion?, auth?)`: busca por significado en un catálogo de servidores MCP y devuelve los más relevantes con su `id` y cómo conectarlos.

- `necesidad`: texto libre (máx. 2000 caracteres), en español o inglés.
- `tipo_conexion`: `remoto` | `local`. `auth`: `ninguna` | `clave` | `oauth` | `desconocida` (`oauth` se acepta como filtro pero el catálogo nunca lo asigna, así que no devuelve resultados).

Incluye una página web de búsqueda, disponible en `/` del mismo Worker (ver "Interfaz web").

## Añadirlo a un cliente MCP

**Servicio en producción** (desplegado y probado el 2026-10-04, con skills de skills.sh en `buscar`; pasarela encendida):
El transporte MCP responde a `POST` en cualquier ruta salvo `/api/buscar` (Streamable HTTP sin estado, respuestas JSON); `GET /` sirve la página web y cualquier otro método o ruta responde 405. Usa `/mcp` por convención:

    https://catalogo-mcp-busqueda.manuelgartenkrotcasal.workers.dev/mcp

Claude Code (verificado: `claude mcp list` lo muestra como Connected; la herramienta aparece en una sesión nueva):

    claude mcp add --transport http catalogo https://catalogo-mcp-busqueda.manuelgartenkrotcasal.workers.dev/mcp

Otros clientes con Streamable HTTP (forma del JSON por verificar según el cliente):

    { "mcpServers": { "catalogo": { "type": "http", "url": "https://catalogo-mcp-busqueda.manuelgartenkrotcasal.workers.dev/mcp" } } }

## Skills de terceros en `buscar`

La herramienta MCP `buscar` (no `/api/buscar` ni la web) consulta además `https://skills.sh/api/search` en paralelo y añade, tras los MCP, hasta 3 skills con su comando `npx skills add <fuente> --skill <id>`. No se almacenan ni se indexan. Es un tercero sin verificar: timeout de 3 s, y ante cualquier fallo (red, 5xx, JSON inesperado) se omite sin afectar al resto. Solo se aceptan `source`/`skillId` con caracteres seguros porque el comando lo construimos nosotros. Medido el 2026-10-04: bueno con consultas cortas ("pdf", "leer hojas de calculo"), ruidoso con frases largas, y la API no devuelve descripción.

## Interfaz web

- Disponible en `/`: `GET /` (solo esa ruta) devuelve una página autocontenida en español: caja de búsqueda, filtros de conexión y autenticación, ejemplos, resultados en tarjetas (nombre, función, tipo, autenticación, puntaje, conexión, `id`) con botón para copiar el comando `claude mcp add`, y el comando para añadir el servidor MCP a tu IA. Sin recursos externos; cabeceras `Content-Security-Policy: default-src 'none'; script-src 'nonce-…'; style-src 'nonce-…'; connect-src 'self'; img-src 'none'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'` (nonce aleatorio por petición), `nosniff`, `Referrer-Policy: no-referrer`, `Cache-Control: no-store`. El texto del catálogo se inserta solo como texto (`textContent`), nunca como HTML ni como enlace. El botón "Copiar comando" solo aparece si la URL remota no contiene caracteres que una shell interprete (si no, solo se ofrece copiar la conexión, con el aviso "Revisa el comando antes de ejecutarlo."). La página no pasa por el rate limit (es estática); las búsquedas sí.
- `POST /api/buscar` (la usa la página; misma búsqueda, saneado y registro en R2 que la herramienta `buscar`):
  - Petición: `{ "necesidad": string (1..2000, no solo espacios), "tipo_conexion"?: "remoto"|"local", "auth"?: "ninguna"|"clave"|"oauth"|"desconocida" }`.
  - 200: `{ "coincidencias": [ { "id", "nombre", "funcion", "como_conectar", "tipo_conexion", "auth", "puntaje" } ], "mensaje"?: "sin coincidencias fiables" }`. Los textos ya vienen saneados (`<` y `>` sustituidos por ‹ ›), sin delimitadores `<dato>`.
  - Requiere `Content-Type: application/json` (con o sin `charset`); si falta o es otro, 415 sin leer el cuerpo. Así una web ajena no puede enviar la búsqueda con un formulario simple: necesitaría preflight CORS, que falla.
  - Errores `{ "error": "..." }`: 400 (JSON inválido, cuerpo que no es un objeto, incluidos los arrays/lotes, campos inválidos), 413 (cuerpo > 16 KB), 405 (método distinto de `POST`, con `Allow: POST`), 429 (límite global de 30/min por IP, compartido con MCP), 500 (`"Error interno."`, sin detalles).
  - Solo mismo origen: no envía cabeceras CORS (`Access-Control-*`), así que otras webs no pueden leer las respuestas desde el navegador.

## Cómo funciona

1. Una GitHub Action diaria (`.github/workflows/ingest.yml`) lee el registro oficial de MCP (`version=latest`).
2. Descarta las entradas sin forma de conexión declarada y las de id de más de 64 bytes (límite de Vectorize); ordena el resto por calidad (remoto, con URL, descripción útil, reciente) y se queda con las mejores `MAX_VECTORS` (38.281 con 128 dimensiones: todas o casi todas las elegibles).
3. Borra de Vectorize y luego de D1 las entradas que han salido de ese top (salvo si el registro devolvió menos de la mitad de lo almacenado o la poda borraría más de la mitad del índice; sin poda, las entradas nuevas no superan `MAX_VECTORS`). Genera embeddings (ver "Modelo de embeddings") en lotes de 25, los sube a Vectorize y guarda las fichas en D1 (reintenta 429/5xx). Si alguna entrada falla, la ejecución de la Action termina en error.
4. El Worker embebe la consulta con el mismo modelo y la misma reducción, busca vecinos en Vectorize (50; 100 si hay filtros), lee las fichas en D1 y aplica los filtros. Si el mejor puntaje vectorial queda bajo el umbral (`UMBRAL_VECTOR`, 0.5 provisional y hoy en la práctica inactivo: ver "Reindexar") responde "sin coincidencias fiables"; si no, devuelve hasta 10 resultados con su puntaje vectorial.
   Existe un paso de reranker (`@cf/baai/bge-reranker-base`, con fallback al orden vectorial si falla) pero está DESACTIVADO (`RERANK_ENABLED = false` en `src/search/buscar.ts`): ver "Límites conocidos". Mientras esté desactivado no se llama a Workers AI para el reranker.
5. Cada búsqueda se registra en R2 (consulta, filtros, nº de resultados) y se borra a los 30 días.

### Modelo de embeddings

`src/embedding.ts` es la única fuente: `@cf/google/embeddinggemma-300m` (multilingüe, 768 dimensiones nativas, entrenado para poder recortarse). Cada vector se recorta a sus primeras `EMBED_DIMS` = 128 componentes y se renormaliza (L2); documentos (`nombre` + salto + `descripcion`) y consultas van en texto plano, sin prefijos de tarea. El plan gratuito de Vectorize almacena 5.000.000 de dimensiones: con 1024 (bge-m3, el modelo anterior) cabían ~4.500 entradas; con 128 caben `MAX_VECTORS` = ⌊5.000.000 × 0,98 / 128⌋ = 38.281 (2 % de margen): todas o casi todas las entradas elegibles del registro. Medido sobre los 20 casos del eval y las 4.500 entradas de entonces (rama `resultados`, `experimento-*.md`): bge-m3 1024 → top-5 12/20, MRR 0,498; EmbeddingGemma 128 → 14/20, MRR 0,567 (768 → 15/20, 0,709). La dimensión final la fija el experimento sobre el corpus completo (`completo-*.md`); cambiarla exige reindexar (ver "Reindexar").

Cobertura (estado tras el reindexado; ver "Reindexar"): se indexan todas o casi todas las entradas elegibles del registro (~38.000), remotas y locales. Hasta que el reindexado termine, el índice desplegado puede seguir siendo el anterior (~4.500 remotas, bge-m3) o estar a medio llenar. Los resultados son texto de terceros (nombres y descripciones del registro) y se entregan delimitados como datos, no como instrucciones.

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

## Servicios gratuitos y memoria local

El Worker nunca recibe contraseñas, emails ni claves: la lista es solo lectura. El registro automático (más abajo) corre únicamente en tu máquina.

- `servicios` (herramienta MCP) y `GET /api/servicios` (solo mismo origen, `no-store`, mismo límite por IP) devuelven una lista curada a mano (`src/servicios.ts`) de servicios gratuitos para developers: enlace de registro, si la página ofrece entrar con GitHub/Google (`oauth`; "no confirmado" si no se comprobó) y, si tienen MCP oficial en el catálogo, su conexión (leída de D1, solo lectura). La web la muestra en el desplegable "Servicios gratuitos para developers".
- `local/server.ts` es un MCP stdio aparte que recuerda qué servicios tiene el usuario en `~/.catalogo-mcp/servicios.json` (`CATALOGO_MCP_DIR` lo cambia): solo servicio, estado (`registrado` o `conectado`) y fecha. Herramientas `mis_servicios` y `marcar(servicio, estado)` (`quitado` borra). No hace peticiones de red. Desde un clon del repositorio:

      claude mcp add memoria -- npx tsx <ruta-al-repo>/local/server.ts

  La IA debe llamar a `marcar` cuando el usuario confirme; no se puede verificar que de verdad se registró. Sin bloqueo entre procesos (gana la última escritura). Publicarlo en npm queda pendiente.
- `npm run alta [id ...]` (`local/alta.ts`) automatiza el alta en tu máquina: te pide el email y la carpeta del CSV, abre cada formulario de `src/servicios.ts` en tu Chrome o Edge visible (`playwright-core`, sin descargar navegadores), lo rellena con una contraseña aleatoria distinta por servicio y pulsa enviar. Si hay CAPTCHA, verificación de email o teléfono, se detiene y espera: lo resuelves tú y pulsas Enter (`s` = saltar). Al pulsar Enter llama a `marcar(servicio, "registrado")`; si el servicio tiene MCP remoto con comando seguro, ofrece conectarlo con `claude mcp add` (solo si respondes `s`).
  - Las contraseñas van a un CSV (`name,url,username,password`, importable en Chrome, Bitwarden o 1Password) que se escribe **antes** de enviar cada formulario. Es el único sitio donde quedan en claro: impórtalo y bórralo. En Windows no se aplica el modo `0600`.
  - Nunca guarda email ni contraseñas en la memoria local ni en logs, no usa el portapapeles y no intenta resolver CAPTCHAs.
  - Límites: la heurística (email, contraseña y botón dentro del mismo formulario) falla con formularios de varios pasos y entonces pasa al modo manual; no hay adaptadores por servicio. Automatizar altas puede ir contra los términos de algún servicio o activar su antifraude; por eso va con tu navegador, tú presente y 2 s de pausa entre servicios.

## Despliegue

Una sola vez, con tu cuenta de Cloudflare (`npx wrangler login` antes):

1. Instala dependencias: `npm ci`
2. Crea la base D1: `npx wrangler d1 create catalogo-mcp` y copia el `database_id`.
3. En `wrangler.toml`, reemplaza `database_id = "REPLACE_ME"` por ese id. `wrangler d1 create` sugiere un binding llamado `catalogo_mcp`: no lo uses (ni dejes el bloque duplicado); el código espera el `[[d1_databases]]` existente con `binding = "DB"`.
4. Aplica la migración: `npx wrangler d1 migrations apply catalogo-mcp --remote`
5. Crea el índice Vectorize (las dimensiones deben coincidir con `EMBED_DIMS` de `src/embedding.ts`, hoy 128; métrica cosine):
   `npx wrangler vectorize create catalogo-mcp --dimensions=128 --metric=cosine`
6. Crea el bucket R2: `npx wrangler r2 bucket create catalogo-mcp-logs`. Hay que activar R2 antes en el panel de Cloudflare (si no, error 10042); puede pedir un método de pago aunque se quede en el plan gratuito.
7. En `wrangler.toml`: los `namespace_id` de los tres rate limits (48291-48293) son enteros elegidos para esta cuenta; cámbialos si tu cuenta ya los usa.
8. Regla de ciclo de vida de R2 (borra los logs de búsqueda a los 30 días; opciones `--name/--prefix/--expire-days` verificadas con `--help`; `--force` omite la confirmación):

       npx wrangler r2 bucket lifecycle add catalogo-mcp-logs --name expire-busquedas --prefix busquedas/ --expire-days 30

9. Publica: `npx wrangler deploy` (anota la URL `*.workers.dev`). Puede tardar un poco en propagarse: las primeras peticiones pueden llegar a la versión anterior.
10. En GitHub, Settings > Secrets and variables > Actions, añade los 4 secretos:
   `CF_ACCOUNT_ID`, `CF_API_TOKEN` (con permisos D1 y Vectorize edit y Workers AI read; alcance exacto por verificar), `CF_D1_DATABASE_ID`, `CF_VECTORIZE_INDEX` (`catalogo-mcp`).
11. Lanza la ingesta una vez: pestaña Actions > `ingest` > Run workflow. Revisa en el log `nuevas / omitidas / fallidas / fuera_de_cupo / podadas`.
12. Con la ingesta hecha, ejecuta el eval: empuja un tag `eval-N` (workflow `eval`, publica el informe en la rama `resultados`) o define las 4 variables de entorno del paso 10 en tu shell y ejecuta `npm run eval`. El informe compara solo vector y con reranker. Pon el umbral recomendado del modo vectorial en `UMBRAL_VECTOR` de `src/search/buscar.ts` (ahora `0.5`), vuelve a desplegar.
13. Prueba de humo: añade la URL a un cliente MCP (ver arriba) y llama a `buscar` con una necesidad real; comprueba que devuelve resultados. Una consulta absurda debería devolver "sin coincidencias", pero hasta recalibrar `UMBRAL_VECTOR` para el modelo actual devuelve resultados (es lo esperado; ver "Reindexar", umbral provisional).

Pasarela (instrucciones para el usuario, después de lo anterior):

14. Vuelve a desplegar con la pasarela APAGADA (`GATEWAY_ENABLED = "0"`, el valor publicado): `npx wrangler deploy`. Al volver a desplegar se aplican la migración del Durable Object (`v1`, `SesionDO`), los dos rate limits nuevos y las variables.
15. Prueba de humo con la pasarela apagada: `buscar` sigue funcionando (y ahora devuelve `id`); `explorar` responde "La pasarela está desactivada." (interruptor comprobado).
16. Segunda regla de ciclo de vida de R2 (logs de la pasarela):

        npx wrangler r2 bucket lifecycle add catalogo-mcp-logs --name expire-llamadas --prefix llamadas/ --expire-days 30 --force

17. Pon `GATEWAY_ENABLED = "1"` en `wrangler.toml` y vuelve a desplegar: `npx wrangler deploy`.
18. Prueba de humo de la pasarela: con `buscar` obtén un `id`; `explorar` ese `id`; `llamar` a una herramienta `solo_lectura` con el `sesion` devuelto. Comprueba que un servidor que pide clave devuelve el mensaje de autenticación, que una herramienta sin marca pide `confirmar` y que una sesión caducada (espera más de 10 min, o usa una que el destino ya olvidó) devuelve "La sesión ha expirado; vuelve a explorar el servidor." y se recupera con `explorar`.

## Reindexar

Las dimensiones de un índice Vectorize son fijas: al cambiar `EMBED_MODEL` o `EMBED_DIMS` hay que recrear el índice y volver a embeber todo. D1 no se toca (sus filas dicen "ya embebida", por eso el modo `REINDEX` ignora esa marca). Procedimiento de corte (es el que lleva del índice bge-m3/1024 al actual):

0. Antes: no hagas el corte el mismo día UTC que un experimento o un eval (las 10.000 neuronas gratuitas/día de Workers AI se comparten con el Worker público; si se agotan, `buscar` falla hasta las 00:00 UTC). Y no subas el cambio de modelo a `main` mucho antes del corte sin desplegarlo: la ingesta de las 03:17 UTC intentaría embeber ~33.000 entradas nuevas contra el índice viejo de 1024 dimensiones, fallarían todas las subidas y el workflow quedaría en rojo (inofensivo, pero gasta neuronas).
1. Seguidos, sin pausa (entre el borrado y el despliegue toda búsqueda responde "error interno"):
   `npx wrangler vectorize delete catalogo-mcp`, luego `npx wrangler vectorize create catalogo-mcp --dimensions=128 --metric=cosine` (`--dimensions` = `EMBED_DIMS` de `src/embedding.ts`; un test comprueba que este README coincide) y luego `npx wrangler deploy`.
2. Empuja un tag `reindex-N` (`git tag reindex-1 && git push origin reindex-1`; o Actions > `ingest` > Run workflow con `reindex` = true): la ingesta corre con `REINDEX=1` y re-embebe y re-sube cada entrada (cuentan como `nuevas`), con una pausa de 1,5 s entre lotes para no pasar del límite de la API. Tarda ≈35–45 min (~1.530 lotes × ~1,5 s más el tiempo de la API); mientras tanto las búsquedas devuelven resultados parciales. Si un lote falla se borran sus filas de D1, así que la ingesta diaria completa esas entradas como nuevas: no hace falta otro reindexado completo.
3. Empuja un tag `eval-N` para medir. El workflow `eval` publica el informe en la rama `resultados` (`git fetch origin resultados` y mira `resultados/eval-<fecha UTC>.md`, o el resumen del job en Actions). Ese primer eval posterior al corte es el que se usa para recalibrar `UMBRAL_VECTOR` (ver más abajo).

Umbral provisional: `UMBRAL_VECTOR` sigue en 0.5, calibrado para bge-m3. Con EmbeddingGemma a 128 dimensiones el mejor puntaje de las consultas reales (mínimo 0,606) se solapa con el de las absurdas (máximo 0,666) y todos superan 0.5, así que "sin coincidencias fiables" queda en la práctica desactivado hasta recalibrarlo con el eval del paso 3.

## Desarrollo

    npm test                  # vitest
    npx tsc --noEmit -p .     # tipos
    npm run eval              # evalúa vector vs reranker contra el índice real (requiere las 4 variables CF_*; o tag eval-N)
    npm run dev               # wrangler dev

## Límites conocidos

- Plan gratuito de Workers: 100.000 peticiones/día y 10 ms de CPU por petición.
- Rate limit: 30 peticiones por 60 s por cliente (IP), contadores por ubicación; si el limitador falla, el servicio sigue abierto.
- Peticiones: solo `POST` (salvo `GET /`, la página web), cuerpo máx. 16 KB, sin lotes JSON-RPC (400).
- Poda: las entradas que salen del top `MAX_VECTORS` se borran en cada ingesta; si el registro devuelve vacío o menos de la mitad de lo almacenado, o si la poda borraría más de la mitad del índice, se omite (aviso en el log) para no vaciarlo; en ese caso las entradas nuevas que no quepan en `MAX_VECTORS` cuentan como `fuera_de_cupo`. Se ignoran las entradas con estado `deleted` del registro.
- Riesgo de bloqueo: si más de la mitad de lo almacenado queda obsoleta de golpe (cambio de ranking, reorganización del registro) la poda se omite en cada ejecución y, con el índice lleno, no entra ninguna entrada nueva; solo queda el aviso en el log. Recuperación manual: Actions > `ingest` > Run workflow > `force_prune` = true (no salta la guarda de registro vacío/diminuto).
- GitHub desactiva los workflows programados tras 60 días sin actividad en el repositorio; si la ingesta deja de ejecutarse, reactívala en la pestaña Actions.
- Workers AI gratis: 10.000 neuronas/día; la ingesta diaria es incremental. Un reindexado embebe ~38.000 documentos de una vez (coste en neuronas por verificar en el primer reindexado). Cloudflare limita la API REST a 1.200 peticiones / 5 min y un reindexado hace ~7.700: se espacian los lotes 1,5 s y un 429 espera `Retry-After` (máx. 300 s) o 60 s si no lo trae.
- El catálogo depende del registro oficial; las entradas sin conexión declarada (ni remota ni paquete) se omiten, y la autenticación `oauth` no es detectable, así que nunca se emite (los remotos sin cabeceras declaradas quedan como `desconocida`).
- Hasta completar el reindexado, el índice anterior solo tiene ~4.500 entradas remotas y el filtro `tipo_conexion: "local"` no devuelve resultados; después del reindexado entran también las locales.
- Límites diarios de Durable Objects en Workers Free (peticiones, duración y filas escritas): no verificados (por verificar). La duración se factura mientras el DO espera al destino (hasta 20 s por llamada) y cada `explorar` escribe varias filas; un usuario intensivo podría agotar la cuota gratuita y la pasarela respondería "error interno" hasta el reinicio.
- R2 (por verificar): cada `buscar` y cada llamada de la pasarela que pasa la puerta hace un `put` (operación de clase A); con abuso intenso podría superarse el millón gratuito al mes.
- Cliente MCP saliente mínimo y propio: solo la primera página de `tools/list`, sin streaming hacia el cliente, sin recursos ni prompts.
- Un destino colgado retiene el cerrojo de esa sesión como máximo 20 s (el timeout).
- Reranker implementado pero DESACTIVADO (2026-10-02). Eval real sobre el índice desplegado entonces (bge-m3): solo vector, top-5 12/20 (en 6/12, es 6/8); con reranker 13/20 (en 8/12, es 5/8): +1 caso en total y el español empeora. Los puntajes de `bge-reranker-base` (probabilidades en [0,1], respuesta ordenada por puntaje y alineada por `id`) son diminutos para consultas en lenguaje natural (0.000-0.003), así que ningún umbral absoluto sirve y las consultas legítimas en español se rechazaban. Reactivar: `RERANK_ENABLED = true`, repetir `npm run eval` (el barrido del reranker incluye umbrales 0.001-0.99) y recalibrar `UMBRAL_RERANK` (0.5, sin calibrar). Lo siguiente a probar sería un reranker multilingüe (tipo `bge-reranker-v2-m3`, solo si existe en Workers AI; por verificar). Sin verificar: que el binding `env.AI` del Worker devuelva la misma forma que la REST y el límite de contextos con 100 candidatos.
