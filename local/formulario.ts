// Heurística genérica de registro: localiza email, contraseña(s) y botón de envío; solo si están los tres rellena y envía.
// No cubre formularios de varios pasos: devuelve "no_encontrado" y el script pasa al modo manual.
import type { Locator, Page } from "playwright-core";

const EMAIL = 'input[type=email], input[autocomplete=email], input[autocomplete=username], input[name*=email i]';
const SUBMIT = 'button[type=submit], input[type=submit]';
const SIN_TIPO = "button:not([type])";

const visibles = async (l: Locator): Promise<Locator[]> => {
  const out: Locator[] = [];
  for (const e of await l.all()) if ((await e.isVisible()) && (await e.isEnabled())) out.push(e);
  return out;
};

export async function rellenar(page: Page, c: { email: string; password: string }, esperaMs = 3000): Promise<"enviado" | "no_encontrado"> {
  // Páginas que montan el formulario con JavaScript: espera un poco al campo de contraseña antes de rendirse.
  await page.waitForSelector("input[type=password]", { state: "visible", timeout: esperaMs }).catch(() => {});
  const [primero] = await visibles(page.locator("input[type=password]"));
  if (!primero) return "no_encontrado";
  const form = primero.locator("xpath=ancestor::form[1]");
  if (!(await form.count())) return "no_encontrado";
  const pass = await visibles(form.locator("input[type=password]")); // solo las del mismo formulario
  const [email] = await visibles(form.locator(EMAIL));
  // Submit explícito; si no hay, un único botón sin type (es el submit por defecto). Con varios no se adivina (ojo de "mostrar contraseña", "Continuar con Google"...).
  const submits = await visibles(form.locator(SUBMIT));
  const enviar = submits[0] ?? (await (async () => { const b = await visibles(form.locator(SIN_TIPO)); return b.length === 1 ? b[0] : undefined; })());
  if (!email || !enviar) return "no_encontrado";
  await email.fill(c.email);
  for (const p of pass) await p.fill(c.password);
  await enviar.click();
  return "enviado";
}
