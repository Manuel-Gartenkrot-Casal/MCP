# Alta automatizada local Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans (elegido por el usuario: ejecución nativa). Steps use checkbox (`- [ ]`) syntax.

**Goal:** Script local que abre cada formulario de registro de `SERVICIOS` en un navegador visible, lo rellena con una contraseña aleatoria por servicio y espera al usuario ante CAPTCHA o verificaciones.

**Architecture:** Tres módulos en `local/`: `credenciales.ts` (puro), `formulario.ts` (heurística sobre una página de Playwright) y `alta.ts` (orquestación con dependencias inyectadas, probada sin navegador). El Worker no cambia.

**Tech Stack:** TypeScript, `playwright-core` (única dependencia nueva, usa el Chrome/Edge instalado), Vitest, `tsx`.

**Spec:** `docs/superpowers/specs/2026-10-03-alta-automatizada-local-design.md`

## Global Constraints

- Email y contraseñas nunca van a `servicios.json`, logs, argumentos de línea de comandos ni portapapeles; el único sitio en claro es el CSV (`0600`).
- La fila del CSV se escribe **antes** de enviar el formulario.
- Sin CAPTCHA-solving ni evasión de antifraude. `headless: false`.
- `claude mcp add` solo si `comando()` (`src/ui.ts`) devuelve un comando, el usuario confirma con `s`, y se lanza con argumentos separados (nunca por shell).
- Ninguna prueba crea cuentas reales ni hace peticiones a servicios reales.
- Commits terminan con `Co-Authored-By: Claude Sonnet 5.5 <noreply@anthropic.com>`.

## Review Focus

- Contraseña o email en el CSV con comas, comillas, saltos de línea o prefijo `=`/`+`/`-`/`@`: celdas escapadas y neutralizadas (Task 1).
- Formulario de dos pasos o sin botón de envío: `no_encontrado` y no se rellena nada (Task 2).
- El usuario cierra a mitad / `s` en un servicio: no se marca `registrado` (Task 3).
- Ids desconocidos en `argv`: error antes de abrir el navegador (Task 3).
- URL de conexión con metacaracteres de shell: no se ofrece ni ejecuta el comando (Task 3).

---

### Task 1: Credenciales y CSV

**Files:** Create `local/credenciales.ts`; Test `tests/local/credenciales.test.ts`.

**Interfaces — Produces:**
```ts
export const CSV_CABECERA = "name,url,username,password";
export function generarPassword(): string;
export type Fila = { nombre: string; url: string; usuario: string; password: string };
export function filaCsv(f: Fila): string;
export async function anadirCredencial(ruta: string, f: Fila): Promise<void>;
```

- [ ] **Step 1: Tests.** `generarPassword`: 20 caracteres, al menos una minúscula, mayúscula, dígito y símbolo de `!@#$%^&*-_`, solo caracteres de `[A-Za-z0-9!@#$%^&*\-_]`, 1000 llamadas todas distintas. `filaCsv`: fila simple → `name,url,username,password` en ese orden separado por comas; campo con coma/comilla/salto de línea entre comillas con `"` duplicada; campo que empieza por `=`, `+`, `-`, `@` se prefija con `'`. `anadirCredencial`: en dir temporal crea el archivo con la cabecera una sola vez y añade dos filas; fuera de win32, modo `0o600`.
- [ ] **Step 2:** `npx vitest run tests/local/credenciales.test.ts` → FAIL.
- [ ] **Step 3:** Implementar con `crypto.randomInt` (sin sesgo de módulo; barajar con Fisher-Yates `randomInt`), `appendFile`/`writeFile` con `mode: 0o600`, directorio con `mkdir -p`.
- [ ] **Step 4:** tests → PASS; `npx tsc --noEmit`.
- [ ] **Step 5: Commit** `feat: generador de contraseñas y CSV`.

### Task 2: Heurística de formulario

**Files:** Modify `package.json` (`npm install playwright-core`); Create `local/formulario.ts`; Test `tests/local/formulario.test.ts`.

**Interfaces — Produces:**
```ts
import type { Page } from "playwright-core";
export async function rellenar(page: Page, c: { email: string; password: string }): Promise<"enviado" | "no_encontrado">;
```

- [ ] **Step 1: Tests** con `chromium.launch({ channel: "chrome" })` (fallback `msedge`) en headless solo dentro de la prueba, `describe.skipIf` si no abre ninguno, y `page.setContent`: formulario normal (email + password + submit dentro de `<form>`) → `enviado` y el `submit` ocurrió (listener que registra el envío con `preventDefault`) con los valores escritos; dos campos password → ambos con la misma contraseña; sin campo password (paso 1 de 2) → `no_encontrado` y el campo email sigue vacío; sin botón de envío → `no_encontrado` y nada relleno; campo email por `autocomplete=username` también se encuentra.
- [ ] **Step 2:** → FAIL.
- [ ] **Step 3:** Implementar: localizar primero (email, password, botón dentro del mismo `form` del password) y solo si están los tres rellenar y pulsar. Email: `input[type=email]`, `input[autocomplete=email]`, `input[autocomplete=username]`, `input[name*=email i]`, visible y habilitado, primero que coincida. Password: todos los `input[type=password]` visibles.
- [ ] **Step 4:** → PASS.
- [ ] **Step 5: Commit** `feat: heurística de rellenado de formularios`.

### Task 3: Orquestación, script y README

**Files:** Create `local/alta.ts`; Modify `README.md`; Test `tests/local/alta.test.ts`.

**Interfaces — Consumes:** `Servicio`, `SERVICIOS` (`src/servicios.ts`); `Fila`, `generarPassword`, `anadirCredencial` (Task 1); `rellenar` (Task 2); `marcar` (`local/memoria.ts`); `comando` (`src/ui.ts`).

**Produces:**
```ts
export type Deps = {
  preguntar(msg: string): Promise<string>;
  abrir(url: string): Promise<unknown>;                       // devuelve la página
  rellenar(pagina: unknown, c: { email: string; password: string }): Promise<"enviado" | "no_encontrado">;
  anadirCredencial(f: Fila): Promise<void>;
  password(): string;
  marcar(servicio: string, estado: "registrado" | "conectado"): Promise<unknown>;
  conexiones(): Promise<Map<string, { tipo_conexion: string; como_conectar: string }>>;
  ejecutar(cmd: string, args: string[]): Promise<number>;     // código de salida
  pausa(ms: number): Promise<void>;
  log(msg: string): void;
};
export async function ejecutarAlta(ids: string[], email: string, deps: Deps): Promise<{ registrados: string[]; saltados: string[] }>;
```
`main()` (solo se ejecuta si el archivo es el punto de entrada) pide email y carpeta, valida ids antes de abrir nada, lanza el navegador, construye `Deps` reales y cierra el navegador al final.

- [ ] **Step 1: Tests de `ejecutarAlta` con `Deps` falsas** que registran el orden de llamadas: `anadirCredencial` ocurre antes de `rellenar`; respuesta vacía (Enter) → `marcar(servicio, "registrado")` y entra en `registrados`; `s` → no se llama a `marcar` y entra en `saltados`; `no_encontrado` → el mensaje pide completar a mano y Enter sigue marcando; id desconocido → rechaza con error antes de llamar a `abrir`; con `conexion` remota segura y respuesta `s` → `ejecutar("claude", ["mcp","add","--transport","http",<slug>,<url>])` y `marcar(..., "conectado")` solo si el código es 0; con respuesta `n`/vacía → no se ejecuta; con `como_conectar` con `;` o espacios → no se pregunta ni se ejecuta; `conexiones()` que lanza → se omite el paso MCP sin fallar; ninguna cadena pasada a `log` contiene la contraseña ni el email.
- [ ] **Step 2:** → FAIL.
- [ ] **Step 3:** Implementar `ejecutarAlta`, `main` (readline, `chromium.launch({ channel: "chrome" })` con fallback `msedge`, `headless: false`; `conexiones` con `fetch(`${CATALOGO_URL ?? URL de producción}/api/servicios`)`; `ejecutar` con `spawn(cmd, args, { stdio: "inherit" })` sin shell), pausa de 2000 ms entre servicios; resumen final con la ruta del CSV y el aviso de importarlo y borrarlo (menciona que en Windows `0600` no aplica). Añadir script `"alta": "tsx local/alta.ts"` a `package.json`.
- [ ] **Step 4:** README: sustituir "no se automatiza ningún registro" por la descripción del script (`npm run alta [ids]`), qué hace, qué nunca hace y los límites (heurística, términos de servicio, CSV en claro).
- [ ] **Step 5:** `npx vitest run` → todo PASS; `npx tsc --noEmit` limpio.
- [ ] **Step 6: Commit** `feat: script de alta automatizada local`.
