// Heurística genérica de registro: localiza email, contraseña(s) y botón de envío; solo si están los tres rellena y envía.
// No cubre formularios de varios pasos: devuelve "no_encontrado" y el script pasa al modo manual.
import type { Locator, Page } from "playwright-core";

const EMAIL = 'input[type=email], input[autocomplete=email], input[autocomplete=username], input[name*=email i]';
const ENVIAR = 'button[type=submit], input[type=submit], button:not([type])';

const visibles = async (l: Locator): Promise<Locator[]> => {
  const out: Locator[] = [];
  for (const e of await l.all()) if ((await e.isVisible()) && (await e.isEnabled())) out.push(e);
  return out;
};

export async function rellenar(page: Page, c: { email: string; password: string }): Promise<"enviado" | "no_encontrado"> {
  const [primero] = await visibles(page.locator("input[type=password]"));
  if (!primero) return "no_encontrado";
  const form = primero.locator("xpath=ancestor::form[1]");
  if (!(await form.count())) return "no_encontrado";
  const pass = await visibles(form.locator("input[type=password]")); // solo las del mismo formulario
  const [email] = await visibles(form.locator(EMAIL));
  const [enviar] = await visibles(form.locator(ENVIAR));
  if (!email || !enviar) return "no_encontrado";
  await email.fill(c.email);
  for (const p of pass) await p.fill(c.password);
  await enviar.click();
  return "enviado";
}
