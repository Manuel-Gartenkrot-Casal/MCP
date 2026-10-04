# Alta automatizada local — Diseño

Fecha: 2026-10-03. Amplía `2026-10-03-alta-guiada-servicios-design.md` (lista curada `src/servicios.ts`, `GET /api/servicios`, memoria local `local/memoria.ts`).

## Objetivo

Que el usuario dé de alta cuentas en los servicios de la lista con el mínimo esfuerzo: un script local abre cada formulario de registro en un navegador visible y lo rellena; el usuario solo interviene cuando el servicio lo exige (CAPTCHA, verificación de email o teléfono).

## Decisiones del usuario (vinculantes)

1. **Se automatiza lo más posible**, con el usuario delante por si hay CAPTCHA u otra verificación. Revierte el "fuera de alcance" de la spec anterior para el registro automático (sigue fuera de alcance hacerlo desde el servidor).
2. **Una contraseña distinta por servicio**, generada al azar por el script.
3. **Entrega por CSV** importable por gestores de contraseñas, en una carpeta que elige el usuario.

## Alcance

Dentro: `local/alta.ts` (script interactivo), `local/credenciales.ts` (generador y CSV), `local/formulario.ts` (heurística de rellenado), dependencia `playwright-core`, actualización del README.

Fuera: ejecutar nada desde el Worker; resolver o saltarse CAPTCHAs; leer la bandeja de correo; adaptadores por servicio (se añaden solo si la heurística falla de forma repetida); instalar navegadores; guardar email o contraseñas en la memoria local o en logs.

## Arquitectura

Todo corre en la máquina del usuario. El Worker no cambia.

### `local/credenciales.ts` (lógica pura)

- `generarPassword(): string`: 20 caracteres con `crypto.randomInt`, con al menos una minúscula, una mayúscula, un dígito y un símbolo de `!@#$%^&*-_`; sin caracteres ambiguos que rompan formularios (sin espacios, comillas ni `\`).
- `filaCsv(f: { nombre: string; url: string; usuario: string; password: string }): string` y `CSV_CABECERA = "name,url,username,password"`: formato que importan Chrome, Bitwarden y 1Password. Escapado RFC 4180 (comillas dobles duplicadas, campos con coma, comillas o salto de línea entre comillas) y neutralización de inyección de fórmulas: un campo que empiece por `=`, `+`, `-`, `@`, tab o retorno de carro se prefija con `'`.
- `anadirCredencial(ruta: string, fila): Promise<void>`: crea el archivo con la cabecera y permisos `0600` si no existe y añade la fila (`appendFile`). Se llama **antes** de enviar el formulario.

### `local/formulario.ts` (heurística)

`rellenar(page, { email, password }): Promise<"enviado" | "no_encontrado">`:
- Campo de email: `input[type=email]`, si no, `input[name*=email i]`, `input[autocomplete=email]` o `input[autocomplete=username]`; visible y habilitado.
- Campo de contraseña: `input[type=password]` visible; si hay varios (confirmación), se rellenan todos con la misma contraseña.
- Envío: `button[type=submit]` o `input[type=submit]` dentro del mismo `<form>`; si no existe, no se pulsa nada y se devuelve `no_encontrado`.
- Si falta el campo de email o el de contraseña, devuelve `no_encontrado` sin tocar nada y el script pasa al modo manual. No rellena formularios de varios pasos.

### `local/alta.ts` (orquestación)

`npx tsx local/alta.ts [id ...]`:
1. Pide por terminal el email y la carpeta del CSV (por defecto `~/Descargas` o el directorio actual). Sin ids, recorre todos los de `SERVICIOS`; con ids, solo los indicados (id desconocido → error antes de abrir nada).
2. Abre Chrome o Edge instalado (`playwright-core`, `channel: "chrome"`, fallback `"msedge"`, `headless: false`). Si no hay ninguno, error claro y salida sin hacer nada.
3. Por servicio: abre `registro_url`; genera la contraseña; **escribe la fila en el CSV**; llama a `rellenar`; si devolvió `enviado`, avisa "Si hay CAPTCHA o verificación, resuélvelo y pulsa Enter (s = saltar)"; si devolvió `no_encontrado`, avisa "No encontré el formulario; complétalo tú y pulsa Enter (s = saltar)". Con Enter llama a `marcar(dir, { servicio, estado: "registrado" })` de `local/memoria.ts`; con `s` no marca nada. Pausa de 2 s entre servicios.
4. Si el servicio tiene `mcp_id`: obtiene `conexion` de `GET {URL_WORKER}/api/servicios` (por defecto el Worker de producción; `CATALOGO_URL` lo cambia; si falla, se omite este paso) y, si el tipo es `remoto` y `comando()` de `src/ui.ts` da un comando, lo muestra y pregunta `¿Conectarlo ahora? (s/N)`; con `s` ejecuta `claude mcp add ...` y, si termina bien, `marcar(..., "conectado")`.
5. Al final imprime un resumen (dados de alta, saltados, pendientes), la ruta del CSV y el recordatorio: "Impórtalo en tu gestor de contraseñas y bórralo".

## Seguridad

- El email y las contraseñas nunca salen de la máquina salvo hacia el propio servicio en su formulario; no hay peticiones de red del script aparte de las del navegador y `GET /api/servicios`.
- No se guardan en la memoria local (`servicios.json`), ni en logs, ni en argumentos de línea de comandos, ni en el portapapeles.
- El CSV es el único sitio con contraseñas en claro: `0600` donde el sistema lo respete, ruta elegida por el usuario, aviso de borrarlo. En Windows el modo POSIX no se aplica: el aviso lo dice.
- El comando `claude mcp add` solo se ejecuta si `comando()` lo considera seguro (URL `https` sin metacaracteres) y el usuario confirma; se lanza con `spawn` y argumentos separados, nunca por una shell.
- Sin CAPTCHA-solving, sin evasión de antifraude: el script se detiene y espera al usuario.

## Pruebas (Vitest)

- `tests/local/credenciales.test.ts`: longitud y clases de caracteres de `generarPassword`; sin caracteres prohibidos; 1.000 contraseñas únicas; escapado RFC 4180 (coma, comillas, salto de línea); neutralización de `=`, `+`, `-`, `@`; `anadirCredencial` crea cabecera una sola vez, añade filas y respeta `0600` fuera de Windows.
- `tests/local/formulario.test.ts`: contra páginas HTML locales (`page.setContent`) con Chrome o Edge si hay uno instalado, `skipIf` si no: formulario normal → `enviado` y valores escritos; con confirmación de contraseña → ambos rellenos; sin campo de contraseña (paso 1 de 2) → `no_encontrado` y nada rellenado; sin botón de envío → `no_encontrado`.
- `tests/local/alta.test.ts`: la lógica de orquestación sin navegador (se inyecta un navegador falso): el CSV se escribe antes de `rellenar`; `s` no llama a `marcar`; Enter sí; id desconocido falla antes de abrir nada; con `conexion` remota segura y `s` se llama a `spawn` con argumentos separados; sin `s` (Enter o `n`) no se ejecuta nada.
- No se crean cuentas reales en ninguna prueba.

## Riesgos y límites conocidos

- La heurística fallará con formularios de varios pasos o campos atípicos: cae al modo manual. No hay adaptadores por servicio en la v1.
- Automatizar altas puede ir contra los términos de algún servicio o activar su antifraude; mitigación: navegador del usuario, usuario presente y pausa entre servicios.
- Si el usuario cierra la terminal a mitad, queda en el CSV la contraseña de un servicio que quizá no llegó a completarse: se ve en el resumen y en el propio CSV.
- Las verificaciones por email o teléfono las completa siempre el usuario.
- La memoria local dice `registrado` cuando el usuario pulsó Enter; el script no puede comprobar que la cuenta exista de verdad.
- Sustituye la frase del README "no se automatiza ningún registro" y la sección de alcance de la spec anterior.
