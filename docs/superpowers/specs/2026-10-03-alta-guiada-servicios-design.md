# Alta guiada de servicios gratuitos — Diseño

Fecha: 2026-10-03. Amplía `2026-10-03-pasarela-conectar-ejecutar-design.md` (catálogo, `buscar`, `explorar` y `llamar` ya existen).

## Objetivo

Que un developer vea los servicios gratuitos útiles para desarrollo, llegue a su registro con un clic y, si el servicio tiene MCP, pueda conectarlo. Que la IA recuerde qué servicios ya tiene dados de alta el usuario.

## Decisiones del usuario (vinculantes)

1. **Alta guiada, no automatizada.** El usuario se registra él mismo en cada servicio (enlace directo u OAuth del propio servicio). Nada rellena formularios.
2. **Ninguna credencial pasa por nosotros.** Ni el Worker ni el MCP local reciben, leen o guardan emails de registro, contraseñas, claves o tokens.
3. **Memoria en la máquina del usuario**, mediante un MCP local (stdio) con un archivo JSON. Sin cuentas ni backend de usuarios.
4. **Enfoque B:** el Worker aporta el catálogo curado; el MCP local solo la memoria.

## Por qué no se automatiza el registro

Verificación de email, CAPTCHA, antifraude y términos de servicio impiden hacerlo de forma general y fiable; hacerlo desde el servidor implicaría leer contraseñas. Queda fuera de alcance de forma explícita.

## Alcance

Dentro:
- `src/servicios.ts`: lista curada (inicialmente ~15-20 servicios) y su validación.
- Herramienta MCP `servicios` y `GET /api/servicios` en el Worker.
- Pestaña "Servicios" en la UI web.
- Paquete `local/` con el MCP stdio `memoria` (`mis_servicios`, `marcar`).

Fuera: registro automático, almacenamiento de credenciales, sincronización entre dispositivos, rastreo de la web para descubrir servicios, soporte de MCP con autenticación en la pasarela (sigue sin existir).

## Arquitectura

### Datos: `src/servicios.ts`

```ts
type Servicio = {
  id: string;            // slug [a-z0-9-]{1,32}
  nombre: string;
  registro_url: string;  // https obligatorio
  oauth: boolean;        // el registro admite iniciar sesión con GitHub/Google
  mcp_id?: string;       // id del catálogo si el servicio tiene MCP
};
```

Lista escrita a mano y en el repositorio, versionada con git. Una prueba comprueba: ids únicos y con forma válida, `registro_url` en `https`, y `mcp_id` con forma válida (≤ 64 bytes). Que el `mcp_id` exista en el catálogo se verifica a mano al añadir la entrada (`buscar`); el catálogo cambia a diario y una prueba contra él sería frágil.

### Worker

- Herramienta `servicios()` sin parámetros: devuelve la lista. Los textos se sanean (`<`/`>` por ‹ ›) y se entregan delimitados como dato, igual que `buscar`.
- `GET /api/servicios`: misma lista en JSON, solo mismo origen, sin cabeceras CORS, mismo límite de uso por IP que el resto. Respuestas con `Cache-Control: no-store`.
- Sin estado nuevo: sin D1, sin R2, sin Durable Object.
- `servicios` y `/api/servicios` añaden a cada servicio con `mcp_id` un campo `conexion` (`tipo_conexion`, `como_conectar`, `auth`) leído de D1 (solo lectura, sin estado nuevo); si el `mcp_id` ya no está en el catálogo, se lista sin `conexion`. La conexión de un `mcp_id` reutiliza lo que ya hay: `explorar`/`llamar` si el destino es remoto sin autenticación; si no, se ofrece el comando `claude mcp add` (como en `buscar`). La pasarela sigue sin soportar autenticación: los servicios con OAuth o clave se conectan con el comando local, no desde el Worker.

### MCP local `memoria` (`local/`)

Proceso stdio con dos herramientas. Archivo: `~/.catalogo-mcp/servicios.json`, creado con permisos solo para el usuario (`0600`, directorio `0700`).

- `mis_servicios()`: devuelve `[{ servicio, estado, fecha }]`.
- `marcar(servicio, estado)`: `servicio` `[a-z0-9-]{1,32}`; `estado` ∈ `registrado` | `conectado` | `quitado`. `quitado` borra la entrada. Cualquier otro campo se rechaza. Escritura atómica (archivo temporal + renombrado). Archivo corrupto: se devuelve error claro y no se sobrescribe.
- Nunca se guardan secretos: el esquema no tiene campo donde ponerlos.

### Flujo de la IA

1. Llama a `servicios` y a `mis_servicios`; cruza ambos para ver qué falta.
2. Da al usuario el `registro_url` del servicio elegido.
3. Cuando el usuario confirma que se registró, llama a `marcar(servicio, "registrado")`.
4. Si hay `mcp_id`, ofrece conectarlo y, al hacerlo, `marcar(servicio, "conectado")`.

### UI web

Desplegable nativo `<details>` "Servicios gratuitos para developers": tarjetas con nombre, botón "Crear cuenta" (enlace `https` con `rel="noopener noreferrer"`, texto insertado con `textContent`) y, si hay `mcp_id`, "Copiar comando MCP" con la misma regla de caracteres seguros que ya existe. La página no lee ni escribe el estado local. Mantiene la CSP actual sin recursos externos.

## Seguridad

- El Worker no recibe credenciales de nadie por diseño: ninguna herramienta ni ruta nueva acepta email, contraseña o token.
- Datos curados por nosotros, no del registro de terceros; aun así se sanean y se entregan como datos.
- `registro_url` fijado en la lista, nunca construido a partir de entrada del usuario.
- La memoria local no sale de la máquina: el MCP `memoria` no hace peticiones de red.

## Pruebas (Vitest, un archivo por unidad, sin framework nuevo)

- `tests/servicios.test.ts`: forma de la lista, unicidad, `https`, `mcp_id` con forma válida.
- `tests/servicios-worker.test.ts`: herramienta `servicios` y `GET /api/servicios` (200, 405 en otros métodos, sin CORS, `no-store`, saneado).
- `tests/local/memoria.test.ts`: lectura/escritura en un directorio temporal, estados válidos e inválidos, campos extra rechazados, `quitado`, archivo corrupto no sobrescrito, permisos.

## Riesgos y límites conocidos

- "Todos los servicios útiles" es una lista curada que crece a mano.
- Mucho de estos servicios exigen OAuth o clave para su MCP: la pasarela no puede ejecutarlos; solo se ofrece el comando de conexión local.
- La memoria es por máquina: no se comparte entre dispositivos.
- La IA debe llamar a `marcar` tras la confirmación del usuario; si no lo hace, el registro queda desfasado. No se puede verificar que el usuario realmente se registró.
