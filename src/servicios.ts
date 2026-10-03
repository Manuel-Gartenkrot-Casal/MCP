// Lista curada (a mano) de servicios gratuitos para developers. `oauth` = la página de alta ofrece entrar con
// GitHub o Google, comprobado en su HTML; false significa "no confirmado". `mcp_id` solo si `buscar` devolvió un
// servidor oficial del propio servicio. Añadir entradas a mano: verificar `registro_url` y `mcp_id` antes.
export type Servicio = { id: string; nombre: string; registro_url: string; oauth: boolean; mcp_id?: string };

export const SERVICIOS: Servicio[] = [
  { id: "github", nombre: "GitHub", registro_url: "https://github.com/signup", oauth: false },
  { id: "cloudflare", nombre: "Cloudflare", registro_url: "https://dash.cloudflare.com/sign-up", oauth: false, mcp_id: "com.cloudflare.mcp/mcp" },
  { id: "vercel", nombre: "Vercel", registro_url: "https://vercel.com/signup", oauth: true, mcp_id: "com.vercel/vercel-mcp" },
  { id: "supabase", nombre: "Supabase", registro_url: "https://supabase.com/dashboard/sign-up", oauth: true, mcp_id: "com.supabase/mcp" },
  { id: "netlify", nombre: "Netlify", registro_url: "https://app.netlify.com/signup", oauth: true },
  { id: "render", nombre: "Render", registro_url: "https://dashboard.render.com/register", oauth: false },
  { id: "neon", nombre: "Neon", registro_url: "https://console.neon.tech/signup", oauth: false, mcp_id: "com.neon/mcp" },
  { id: "sentry", nombre: "Sentry", registro_url: "https://sentry.io/signup/", oauth: true, mcp_id: "io.github.getsentry/sentry-mcp" },
  { id: "mongodb-atlas", nombre: "MongoDB Atlas", registro_url: "https://www.mongodb.com/cloud/atlas/register", oauth: true },
  { id: "figma", nombre: "Figma", registro_url: "https://www.figma.com/signup", oauth: true },
  { id: "notion", nombre: "Notion", registro_url: "https://app.notion.com/signup", oauth: false, mcp_id: "com.notion/mcp" },
  { id: "linear", nombre: "Linear", registro_url: "https://linear.app/signup", oauth: false },
];
