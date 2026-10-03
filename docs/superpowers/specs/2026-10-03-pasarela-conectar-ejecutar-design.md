# Pasarela "conectar y ejecutar" — Diseño

Fecha: 2026-10-03. Amplía `2026-10-02-catalogo-mcp-busqueda-design.md` (el catálogo y `buscar` ya existen y están desplegados).

## Objetivo

Que una IA pueda, desde el mismo servidor MCP, **explorar y llamar herramientas de servidores MCP remotos del catálogo** sin que el usuario los instale ni configure. El servidor pasa de "lista" a "pasarela": `buscar` → `explorar` → `llamar`.

## Decisiones del usuario (vinculantes)

1. **Solo servidores sin autenticación.** Sin claves de usuario, sin OAuth, sin guardar credenciales de nadie.
2. **Enfoques 1 y 2 combinados:** herramientas proxy en el Worker actual (`explorar`, `llamar`) respaldadas por un **Durable Object** que conserva la sesión con el destino.
3. **Sesión por token opaco** (128 bits aleatorios) devuelto al cliente, que lo reenvía. Aislada por persona; expira a los 10 minutos sin uso.
4. **Política de efectos secundarios (B):** las herramientas marcadas `solo_lectura` corren directo; las demás exigen `confirmar: true`.

## Alcance

Dentro: tools `explorar` y `llamar`; `SesionDO`; `src/gateway.ts` (lógica pura); límites de uso propios; log sin argumentos ni resultados; campo `id` en los resultados de `buscar`; interruptor `GATEWAY_ENABLED`.

Fuera: servidores **locales** (un Worker no puede ejecutarlos), claves de usuario u OAuth, recursos y prompts de MCP, streaming hacia el cliente, caché de resultados, caché negativa de "requiere autenticación".

## Restricción que condiciona el diseño

El catálogo no puede saber qué remotos exigen autenticación: por la regla de no inventar datos, un remoto sin cabeceras declaradas es `auth: desconocida` (podría ser OAuth) y `ninguna` solo se asigna a locales. Por eso la autenticación se **detecta al llamar**: un 401/403 del destino devuelve "requiere autenticación, no soportado" y no se reintenta.

## Arquitectura

- **Cambio previo en `buscar`:** cada resultado incluye `id` (id del catálogo, delimitado como dato como `nombre`), necesario para las otras herramientas.
- **`explorar(servidor, sesion?)`** y **`llamar(servidor, herramienta, argumentos, sesion?, confirmar?)`** en `src/worker.ts`, junto a `buscar`.
- **`SesionDO`** (un Durable Object por token): guarda en su SQLite el id del servidor, el `Mcp-Session-Id` del destino, la caché de herramientas con sus marcas y la hora del último uso. **No mantiene conexión viva**: cada llamada reutiliza el `Mcp-Session-Id` guardado, así que descargarse de memoria entre llamadas es inocuo. Una alarma borra sus datos a los 10 minutos de inactividad.
- **`src/gateway.ts`** (lógica pura, probable con `fetch` falso): resolución y validación del destino, política de confirmación, mapeo de anotaciones a marca, formateo y saneado de resultados, topes de tamaño.
- **Límites de uso** propios por IP: `explorar` 20/min, `llamar` 10/min (bindings de rate limit adicionales, ajustables).

### Flujo

1. `explorar` recibe un id del catálogo. El Worker lo busca en D1 y solo acepta entradas **remotas** con URL `https://`.
2. Sin `sesion`, genera un token aleatorio de 128 bits y crea el Durable Object, que inicializa la conexión con el destino, pide `tools/list`, guarda la caché y devuelve token y lista.
3. `llamar` valida id y token, comprueba que el `servidor` coincida con el que la sesión tiene guardado (un token no sirve para otro servidor: error "sesión de otro servidor"), que la herramienta exista en la caché y aplica la política de confirmación.
4. El resultado se sanea y se entrega delimitado como dato, con tope de tamaño.

## Contrato

**`explorar`**: `servidor` (string ≤128), `sesion?` (32 hex). Devuelve el aviso fijo, `sesion: <token>` fuera de delimitadores (valor propio) y hasta 50 herramientas, cada una con `nombre`, `descripcion` y `parametros` (nombres y tipos, truncados), sanitizados y delimitados con `<dato>`, más `marca` propia: `solo_lectura` | `destructiva` | `sin_declarar`. La marca sale de las anotaciones del destino (`readOnlyHint`, `destructiveHint`); si declara ambas, gana `destructiva`. Tope de 16 KB de texto; avisa de cuántas herramientas se omitieron.

**`llamar`**: `servidor`, `herramienta` (regex de nombre, ≤128), `argumentos` (objeto JSON ≤16 KB serializado), `sesion?` (si falta, crea una y la devuelve), `confirmar?` (boolean). Si la marca no es `solo_lectura` y falta `confirmar: true`, error claro que explica la marca y cómo repetir. Resultado: texto del destino concatenado, sanitizado y delimitado, tope 32 KB con `[truncado]`; contenido no textual como `[contenido omitido: tipo, tamaño]`; un error del destino se devuelve como error, con su texto también delimitado.

**Errores** (frases fijas en español, sin detalles internos): servidor inexistente o no remoto, requiere autenticación, tiempo agotado, destino no responde, herramienta inexistente, sesión expirada (el cliente vuelve a llamar a `explorar`; no se renueva en silencio, porque un servidor con estado podría comportarse distinto), pasarela desactivada.

## Seguridad

- **Destinos:** la URL sale solo de D1, nunca del cliente. Solo `https` y puerto estándar; sin credenciales en la URL; sin IP literales, `localhost`, `.local` ni `.internal`; nunca el propio dominio del Worker (evita bucles). Redirecciones rechazadas.
- **Cabeceras salientes:** solo `User-Agent`, `Accept`, `Content-Type`, `Mcp-Session-Id`, `MCP-Protocol-Version`; ninguna del cliente.
- **Límites:** timeout de 20 s; lectura con tope de 256 KB crudos recortados a 32 KB ya saneados.
- **Entradas validadas antes de tocar un Durable Object:** formato del token, regex del nombre de herramienta, argumentos como objeto JSON ≤16 KB. Un token mal formado no crea nada.
- **Texto de terceros no confiable:** todo lo que viene del destino (nombres, descripciones, resultados) pasa por `sanitizeText` y se delimita con `<dato>`, con el aviso fijo al inicio, igual que el catálogo.
- **Interruptor:** `GATEWAY_ENABLED=0` apaga `explorar` y `llamar` con un mensaje fijo, sin redesplegar código.
- **Log en R2:** id del servidor, nombre de herramienta, marca, tipo de resultado y duración. Nunca argumentos ni resultados. Retención de 30 días.
- **Responsabilidad:** el README avisa de que una herramienta sin autenticación puede tener efectos en un servicio ajeno, ejecutados desde IPs de Cloudflare; por eso existe la confirmación.

## Pruebas

- `gateway.ts` con `fetch` falso: matriz de validación de URLs, redirecciones, 401/403, timeout, topes de tamaño, mapeo de anotaciones a marca, política de confirmación, saneado de nombres y resultados hostiles (`</dato>`, caracteres invisibles, contenido no textual).
- `SesionDO` con almacenamiento falso: caducidad, token mal formado, sesión expirada, borrado por alarma.
- Integración vía `worker.fetch` con un Durable Object y un servidor de destino simulados (incluye `GATEWAY_ENABLED=0` y los límites de uso).
- Prueba de humo real contra un servidor MCP público sin autenticación, ejecutada con el usuario presente.

## Riesgos y criterio de éxito

- **Antes de construir, sondeo de solo lectura:** un script que haga `tools/list` a una muestra de ~100 remotos del catálogo y cuente cuántos responden sin autenticación. **Criterio:** si menos de ~10% responde, la pasarela aporta poco y se replantea antes de invertir más.
- **Sin verificar:** que el cliente del SDK de MCP funcione dentro de un Durable Object en Workers; los topes diarios de cómputo de los Durable Objects en el plan gratuito (la documentación confirma disponibilidad con SQLite en Free, no el tope diario exacto); el tiempo de pared de las llamadas salientes.
- **Experiencia esperada:** la mayoría de los remotos pueden resultar con autenticación OAuth y devolver el error de "requiere autenticación"; la utilidad real dependerá de la cifra del sondeo.
