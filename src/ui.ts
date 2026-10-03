// Web page served at GET /. Self-contained (one inline <style> and <script>, both nonce'd); the only variable part is
// the nonce. Third-party text is only ever inserted with textContent, never as markup or as a URL.

/** Server name for `claude mcp add`: [a-z0-9-], max 40, fallback "servidor". Embedded verbatim in the page script. */
export function slug(s: string): string {
  const t = String(s).toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 40).replace(/-+$/, "");
  return t || "servidor";
}

/** Shell-safe `claude mcp add` command, or null when the URL has anything a shell could interpret. Embedded verbatim. */
export function comando(nombre: string, url: string): string | null {
  return /^https?:\/\/[A-Za-z0-9._~:\/-]+$/.test(url) ? "claude mcp add --transport http " + slug(nombre) + " " + url : null;
}

const CSS = `
:root {
  color-scheme: light dark;
  --bg: #f6f5f1; --surface: #ffffff; --surface-2: #efede6; --ink: #17191d; --muted: #565b66; --line: #dcd9d0; --control: #7d828c;
  --accent: #0b6e5f; --accent-hover: #095a4e; --accent-ink: #ffffff; --accent-soft: #e0f0eb;
  --danger: #a4262c; --danger-soft: #fbecec; --focus: #1a5fd0;
  --sans: system-ui, -apple-system, "Segoe UI", Roboto, "Helvetica Neue", Arial, sans-serif;
  --mono: ui-monospace, "SF Mono", "Cascadia Mono", Menlo, Consolas, monospace;
  --r: 12px;
}
@media (prefers-color-scheme: dark) {
  :root {
    --bg: #111316; --surface: #181b20; --surface-2: #0d0f12; --ink: #ecebe6; --muted: #a3a8b2; --line: #2b3038; --control: #737a86;
    --accent: #4fc4ac; --accent-hover: #6fd4bf; --accent-ink: #06201a; --accent-soft: #15302a;
    --danger: #ff9b9b; --danger-soft: #2c1818; --focus: #8ab4ff;
  }
}
*, *::before, *::after { box-sizing: border-box; }
html { -webkit-text-size-adjust: 100%; }
body { margin: 0; background: var(--bg); color: var(--ink); font: 16px/1.55 var(--sans); }
.wrap { max-width: 46rem; margin: 0 auto; padding: 0 16px; }
:focus-visible { outline: 3px solid var(--focus); outline-offset: 2px; }
.sr { position: absolute; width: 1px; height: 1px; overflow: hidden; clip: rect(0 0 0 0); white-space: nowrap; }

header { padding: 40px 0 8px; }
.marca { display: flex; align-items: center; gap: 10px; color: var(--accent); font-weight: 650; font-size: .8125rem; letter-spacing: .08em; text-transform: uppercase; }
.marca svg { flex: none; }
h1 { margin: 18px 0 10px; font-size: clamp(1.75rem, 1.1rem + 3vw, 2.6rem); line-height: 1.12; letter-spacing: -.022em; font-weight: 720; text-wrap: balance; }
.lead { margin: 0; color: var(--muted); font-size: 1.0625rem; max-width: 38rem; }

.panel { background: var(--surface); border: 1px solid var(--line); border-radius: var(--r); padding: 18px; }
.ia { margin: 24px 0 0; display: grid; gap: 10px; }
.ia h2 { margin: 0; font-size: .9375rem; font-weight: 650; }
.ia p { margin: 0; color: var(--muted); font-size: .9375rem; }
.fila { display: flex; gap: 8px; align-items: stretch; }
.fila > pre { flex: 1; min-width: 0; }

pre.code { margin: 0; padding: 10px 12px; background: var(--surface-2); border: 1px solid var(--line); border-radius: 8px;
  font: .875rem/1.5 var(--mono); white-space: pre-wrap; overflow-wrap: anywhere; color: var(--ink); }

form { margin: 28px 0 0; }
.campo { display: grid; gap: 6px; }
label { font-weight: 600; font-size: .9375rem; }
.busca { display: flex; gap: 8px; }
input, select { font: inherit; color: var(--ink); background: var(--surface); border: 1px solid var(--control); border-radius: 10px; min-height: 48px; }
input { flex: 1; min-width: 0; padding: 0 14px; }
input::placeholder { color: var(--muted); opacity: 1; }
select { width: 100%; padding: 0 10px; }
input:hover, select:hover { border-color: var(--ink); }
.filtros { display: grid; grid-template-columns: 1fr 1fr; gap: 12px; margin-top: 14px; }
.filtros label { font-size: .8125rem; color: var(--muted); font-weight: 600; }

.btn { font: inherit; font-weight: 600; min-height: 40px; padding: 0 16px; border-radius: 10px; border: 1px solid transparent; cursor: pointer; white-space: nowrap; }
.btn-pri { background: var(--accent); color: var(--accent-ink); min-height: 48px; padding: 0 22px; }
.btn-pri:hover { background: var(--accent-hover); }
.btn-pri:disabled { opacity: .6; cursor: progress; }
.btn-sec { background: transparent; color: var(--ink); border-color: var(--line); font-size: .875rem; }
.btn-sec:hover { border-color: var(--muted); }

.ejemplos { display: flex; flex-wrap: wrap; align-items: center; gap: 8px; margin-top: 16px; }
.ejemplos span { color: var(--muted); font-size: .875rem; margin-right: 2px; }
.chip { font: inherit; font-size: .875rem; min-height: 40px; padding: 0 14px; border-radius: 999px; cursor: pointer;
  background: var(--surface); color: var(--ink); border: 1px solid var(--line); text-align: left; }
.chip:hover { border-color: var(--accent); color: var(--accent); }

#res { margin: 32px 0 0; min-height: 4rem; }
.estado { padding: 18px; border-radius: var(--r); border: 1px dashed var(--line); color: var(--muted); }
.estado p { margin: 0; }
.estado .t { color: var(--ink); font-weight: 650; }
.estado .t + p { margin-top: 4px; }
.estado.error { border: 1px solid var(--danger); background: var(--danger-soft); }
.estado.error .t { color: var(--danger); }
.cargando .t::before { content: ""; display: inline-block; width: 8px; height: 8px; margin-right: 10px; border-radius: 50%;
  background: var(--accent); vertical-align: middle; animation: pulso 1s ease-in-out infinite alternate; }
@keyframes pulso { from { opacity: .25; } to { opacity: 1; } }

.res-t { margin: 0 0 12px; font-size: .875rem; font-weight: 600; color: var(--muted); letter-spacing: .02em; }
.cards { list-style: none; margin: 0; padding: 0; display: grid; gap: 12px; }
.card { background: var(--surface); border: 1px solid var(--line); border-radius: var(--r); padding: 18px; display: grid; gap: 10px; min-width: 0; }
.card-top { display: flex; gap: 12px; justify-content: space-between; align-items: baseline; }
.card h3 { margin: 0; font-size: 1.0625rem; line-height: 1.3; overflow-wrap: anywhere; letter-spacing: -.005em; }
.card-d { margin: 0; color: var(--muted); overflow-wrap: anywhere; }
.score { flex: none; display: inline-flex; align-items: center; gap: 8px; font: 600 .8125rem/1 var(--mono); color: var(--muted); }
.bar { width: 48px; height: 6px; border-radius: 3px; background: var(--surface-2); border: 1px solid var(--line); overflow: hidden; }
.fill { display: block; height: 100%; background: var(--accent); }
.badges { display: flex; flex-wrap: wrap; gap: 6px; }
.badge { font-size: .75rem; font-weight: 600; padding: 3px 9px; border-radius: 999px; background: var(--surface-2); border: 1px solid var(--line); color: var(--ink); }
.badge-acc { background: var(--accent-soft); border-color: transparent; color: var(--accent); }
.nota { margin: -4px 0 0; font-size: .8125rem; color: var(--muted); }
.card-id { margin: 0; font: .75rem/1.4 var(--mono); color: var(--muted); overflow-wrap: anywhere; }

footer { margin: 56px 0 0; padding: 20px 0 40px; border-top: 1px solid var(--line); color: var(--muted); font-size: .875rem; }
footer p { margin: 0 0 6px; }
footer a { color: var(--accent); text-underline-offset: 3px; }

@media (max-width: 30rem) {
  header { padding-top: 28px; }
  .busca, .fila { flex-direction: column; }
  .btn-pri { width: 100%; }
}
@media (prefers-reduced-motion: reduce) {
  *, *::before, *::after { animation: none !important; transition: none !important; }
}
`;

const JS = `"use strict";
${slug}
${comando}
const TIPOS = new Map([["remoto", "Remoto"], ["local", "Local"]]);
const AUTHS = new Map([["ninguna", "Sin autenticación"], ["clave", "Requiere clave"], ["oauth", "OAuth"], ["desconocida", "Autenticación desconocida"]]);
const $ = (id) => document.getElementById(id);
const form = $("f"), q = $("q"), con = $("con"), au = $("auth"), go = $("go"), res = $("res"), aviso = $("aviso");

// Single polite status line: cleared first so a repeated message ("Copiado") is announced again.
function anunciar(msg) {
  aviso.textContent = "";
  setTimeout(() => { aviso.textContent = msg; }, 60);
}
function el(tag, cls, txt) {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  if (txt !== undefined) e.textContent = String(txt);
  return e;
}
function conCopia(btn, get) {
  const label = btn.textContent;
  btn.addEventListener("click", () => {
    const fin = (msg) => { btn.textContent = msg; anunciar(msg); setTimeout(() => { btn.textContent = label; }, 1600); };
    if (!navigator.clipboard) return fin("No se pudo copiar");
    navigator.clipboard.writeText(get()).then(() => fin("Copiado"), () => fin("No se pudo copiar"));
  });
  return btn;
}
function botonCopia(label, texto, nombre) {
  const b = el("button", "btn btn-sec", label);
  b.type = "button";
  b.setAttribute("aria-label", label + ": " + nombre);
  return conCopia(b, () => texto);
}

$("cmd").textContent = "claude mcp add --transport http catalogo " + location.origin + "/mcp";
conCopia($("cmd-copia"), () => $("cmd").textContent);

function estado(clase, titulo, texto) {
  const box = el("div", "estado " + clase);
  box.append(el("p", "t", titulo));
  if (texto) box.append(el("p", "", texto));
  res.replaceChildren(box);
  anunciar(titulo);
}
function puntaje(p) {
  const n = typeof p === "number" && isFinite(p) ? Math.max(0, Math.min(100, Math.round(p * 100))) : 0;
  const s = el("span", "score");
  s.setAttribute("role", "img");
  s.setAttribute("aria-label", "Relevancia " + n + " %");
  const bar = el("span", "bar"), fill = el("span", "fill");
  fill.style.width = n + "%";
  bar.append(fill);
  s.append(bar, el("span", "", n + " %"));
  return s;
}
function tarjeta(r) {
  const nombre = String(r.nombre), conn = String(r.como_conectar);
  const li = el("li", "card");
  const top = el("div", "card-top");
  top.append(el("h3", "", nombre), puntaje(r.puntaje));
  li.append(top);
  if (r.funcion) li.append(el("p", "card-d", r.funcion));
  const badges = el("div", "badges");
  badges.append(
    el("span", r.tipo_conexion === "remoto" ? "badge badge-acc" : "badge", TIPOS.get(r.tipo_conexion) || r.tipo_conexion),
    el("span", "badge", AUTHS.get(r.auth) || r.auth),
  );
  li.append(badges);
  const fila = el("div", "fila"), pre = el("pre", "code");
  pre.append(el("code", "", conn));
  const cmd = r.tipo_conexion === "remoto" ? comando(nombre, conn) : null;
  fila.append(pre, cmd ? botonCopia("Copiar comando", cmd, nombre) : botonCopia("Copiar", conn, nombre));
  li.append(fila);
  if (!cmd) li.append(el("p", "nota", "Revisa el comando antes de ejecutarlo."));
  li.append(el("p", "card-id", "id: " + r.id));
  return li;
}

let turno = 0;
async function buscar() {
  const necesidad = q.value.trim();
  if (!necesidad) { estado("error", "Escribe qué necesitas.", "Por ejemplo: «enviar mensajes a un canal de Slack»."); q.focus(); return; }
  const body = { necesidad };
  if (con.value) body.tipo_conexion = con.value;
  if (au.value) body.auth = au.value;
  const mio = ++turno;
  go.disabled = true;
  estado("cargando", "Buscando…");
  let r = null, data = null;
  try {
    r = await fetch("/api/buscar", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
    try { data = await r.json(); } catch (e) { data = null; }
  } catch (e) { r = null; }
  if (mio !== turno) return;
  go.disabled = false;
  if (!r) return estado("error", "No se pudo conectar.", "Revisa tu conexión e inténtalo de nuevo.");
  if (r.status === 429) return estado("error", "Demasiadas búsquedas, espera un minuto.", "Hay un límite por persona para que el servicio siga siendo gratuito.");
  if (r.status === 400 || r.status === 413) return estado("error", "Revisa la consulta.", data && typeof data.error === "string" ? data.error : "No se pudo procesar.");
  if (!r.ok || !data || !Array.isArray(data.coincidencias)) return estado("error", "Algo falló en el servidor.", "Inténtalo de nuevo en unos segundos.");
  if (!data.coincidencias.length) {
    const m = typeof data.mensaje === "string" ? data.mensaje : "sin coincidencias fiables";
    return estado("vacio", m.charAt(0).toUpperCase() + m.slice(1) + ".", "Prueba a describir la tarea con otras palabras o a quitar los filtros.");
  }
  const n = data.coincidencias.length;
  const ol = el("ol", "cards");
  for (const c of data.coincidencias) ol.append(tarjeta(c));
  res.replaceChildren(el("h2", "res-t", n === 1 ? "1 servidor, por relevancia" : n + " servidores, por relevancia"), ol);
  anunciar(n === 1 ? "1 resultado" : n + " resultados");
}

form.addEventListener("submit", (e) => { e.preventDefault(); buscar(); });
for (const b of document.querySelectorAll("[data-ejemplo]")) b.addEventListener("click", () => { q.value = b.textContent; buscar(); });
`;

const EJEMPLOS = ["gestionar issues y pull requests de GitHub", "dar la hora actual", "leer hojas de cálculo de Google"];

export function renderPagina(nonce: string): string {
  return `<!doctype html>
<html lang="es">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="description" content="Buscador gratuito de servidores MCP por lo que necesitas hacer.">
<title>Catálogo MCP · buscador</title>
<style nonce="${nonce}">${CSS}</style>
</head>
<body>
<div class="wrap">
<header>
  <div class="marca">
    <svg viewBox="0 0 24 24" width="24" height="24" aria-hidden="true" focusable="false" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round">
      <circle cx="6" cy="6" r="2.5"/><circle cx="18" cy="6" r="2.5"/><circle cx="12" cy="18" r="2.5"/>
      <path d="M8 7.5l2.6 8.2M16 7.5l-2.6 8.2M8.5 6h7"/>
    </svg>
    Catálogo MCP
  </div>
  <h1>Encuentra el servidor MCP que hace lo que necesitas</h1>
  <p class="lead">Describe la tarea con tus palabras, en español o inglés. Buscamos por significado en el registro oficial de servidores MCP y te decimos cómo conectarlos.</p>
  <section class="panel ia" aria-labelledby="ia-t">
    <h2 id="ia-t">Usar con tu IA</h2>
    <p>Añádelo a Claude Code (o a cualquier cliente MCP por HTTP) y tu IA tendrá tres herramientas: <strong>buscar</strong> servidores, <strong>explorar</strong> las herramientas de uno y <strong>llamar</strong> a una de ellas.</p>
    <div class="fila">
      <pre class="code"><code id="cmd">claude mcp add --transport http catalogo /mcp</code></pre>
      <button type="button" class="btn btn-sec" id="cmd-copia">Copiar</button>
    </div>
  </section>
</header>

<main>
  <form id="f" role="search" novalidate>
    <div class="campo">
      <label for="q">¿Qué necesitas hacer?</label>
      <div class="busca">
        <input id="q" name="q" type="search" maxlength="2000" autocomplete="off" enterkeyhint="search" placeholder="p. ej. enviar mensajes a Slack" required>
        <button id="go" class="btn btn-pri" type="submit">Buscar</button>
      </div>
    </div>
    <div class="filtros">
      <div class="campo">
        <label for="con">Conexión</label>
        <select id="con" name="con">
          <option value="">Cualquiera</option>
          <option value="remoto">Remoto (por URL)</option>
          <option value="local">Local (en tu máquina)</option>
        </select>
      </div>
      <div class="campo">
        <label for="auth">Autenticación</label>
        <select id="auth" name="auth">
          <option value="">Cualquiera</option>
          <option value="ninguna">Ninguna</option>
          <option value="clave">Clave o token</option>
          <option value="oauth">OAuth</option>
          <option value="desconocida">Desconocida</option>
        </select>
      </div>
    </div>
    <div class="ejemplos"><span>Prueba con:</span>${EJEMPLOS.map((e) => `<button type="button" class="chip" data-ejemplo>${e}</button>`).join("")}</div>
  </form>

  <section id="res" aria-label="Resultados">
    <div class="estado">
      <p class="t">Escribe una necesidad y pulsa Buscar.</p>
      <p>Verás hasta 10 servidores ordenados por relevancia, con cómo conectarlos y su <code>id</code> para usarlo con explorar y llamar.</p>
    </div>
    <noscript><p>La búsqueda necesita JavaScript.</p></noscript>
  </section>
  <p id="aviso" class="sr" role="status" aria-live="polite"></p>
</main>

<footer>
  <p>Los nombres y descripciones vienen del registro oficial de MCP: son textos de terceros, no verificados. El catálogo indexa los servidores remotos y locales del registro oficial MCP.</p>
  <p><a href="https://github.com/Manuel-Gartenkrot-Casal/MCP" rel="noopener noreferrer">Código fuente en GitHub</a></p>
</footer>
</div>
<script nonce="${nonce}">${JS}</script>
</body>
</html>
`;
}
