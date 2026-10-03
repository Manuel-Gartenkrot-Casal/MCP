import type { Entry, Auth } from "../types";

const BASE = "https://registry.modelcontextprotocol.io/v0.1/servers?version=latest&limit=100";

const MAX_PAGES = 1000;
const str = (v: unknown): string | undefined => (typeof v === "string" && v.trim() ? v : undefined);
const arr = (v: unknown): any[] => (Array.isArray(v) ? v : []);

// identifier/version are untrusted and end up in a copy-pasted shell command: allow-list only.
// Must not start with "-" (would be parsed as an option by npx/uvx/docker).
const SAFE = /^[@\w][@\w.\/:+~-]*$/;

function localCommand(p: any): string | undefined {
  const id = str(p?.identifier);
  if (!id || !SAFE.test(id)) return undefined;
  const v = str(p.version);
  if (v && !SAFE.test(v)) return undefined;
  switch (p.registryType) {
    case "npm": return `npx -y ${id}${v ? "@" + v : ""}`;
    case "pypi": return `uvx ${id}${v ? "==" + v : ""}`;
    case "oci": return `docker run -i --rm ${id}`;
    default: return `${str(p.registryType) ?? "paquete"}: ${id}${v ? " " + v : ""}`;
  }
}

// Devuelve null si falta id/nombre o si no hay forma de conectarse.
export function normalizeEntry(raw: unknown): Entry | null {
  const s = (raw as any)?.server;
  const id = str(s?.name);
  if (!id) return null;
  const meta = (raw as any)._meta?.["io.modelcontextprotocol.registry/official"];

  const remotes = arr(s.remotes).filter((r) => str(r?.url));
  const remote = remotes.find((r) => r.type === "streamable-http") ?? remotes[0];
  const pkg = arr(s.packages).find((p) => localCommand(p));

  let tipo_conexion: Entry["tipo_conexion"];
  let como_conectar: string;
  let auth: Auth;
  if (remote) {
    tipo_conexion = "remoto";
    como_conectar = remote.url;
    auth = arr(remote.headers).some((h) => h?.isRequired && h?.isSecret) ? "clave" : "desconocida";
  } else if (pkg) {
    tipo_conexion = "local";
    como_conectar = localCommand(pkg)!;
    auth = arr(pkg.environmentVariables).some((e) => e?.isRequired && e?.isSecret) ? "clave" : "ninguna";
  } else return null;

  return {
    id,
    nombre: str(s.title) ?? id,
    descripcion: str(s.description) ?? "",
    url_info: str(s.websiteUrl) ?? str(s.repository?.url) ?? null,
    tipo_conexion,
    como_conectar,
    auth,
    incompleta: auth === "desconocida",
    actualizado: str(meta?.updatedAt) ?? "",
  };
}

export function dedupeLatest(entries: Entry[]): Entry[] {
  const m = new Map<string, Entry>();
  for (const e of entries) {
    const cur = m.get(e.id);
    if (!cur || e.actualizado > cur.actualizado) m.set(e.id, e);
  }
  return [...m.values()];
}

export async function fetchRegistry(fetchFn: typeof fetch = fetch): Promise<Entry[]> {
  const out: Entry[] = [];
  let cursor: string | undefined;
  const seen = new Set<string>();
  do {
    if (seen.size >= MAX_PAGES) throw new Error(`Registry: more than ${MAX_PAGES} pages`);
    const res = await fetchFn(BASE + (cursor ? `&cursor=${encodeURIComponent(cursor)}` : ""));
    if (!res.ok) throw new Error(`Registry HTTP ${res.status}`);
    const body: any = await res.json();
    for (const raw of arr(body.servers)) {
      const e = normalizeEntry(raw);
      if (e) out.push(e);
    }
    cursor = str(body.metadata?.nextCursor);
    if (cursor) {
      if (seen.has(cursor)) throw new Error(`Registry: repeated cursor ${cursor}`);
      seen.add(cursor);
    }
  } while (cursor);
  return dedupeLatest(out);
}
