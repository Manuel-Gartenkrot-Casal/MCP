import type { Filtros } from "./search/buscar";
import type { Marca } from "./gateway/types";

// Solo metadatos de la llamada: nunca argumentos, resultados ni identidad del cliente.
export async function logLlamada(
  bucket: R2Bucket,
  q: { servidor: string; herramienta: string; marca?: Marca; resultado: string; ms: number },
  now: Date = new Date(),
): Promise<void> {
  const rnd = [...crypto.getRandomValues(new Uint8Array(4))].map((b) => b.toString(16).padStart(2, "0")).join("");
  const key = `llamadas/${now.toISOString().slice(0, 10)}/${now.getTime()}-${rnd}.json`;
  await bucket.put(
    key,
    JSON.stringify({
      ts: now.toISOString(), servidor: q.servidor.slice(0, 200), herramienta: q.herramienta.slice(0, 200),
      ...(q.marca && { marca: q.marca }), resultado: q.resultado, ms: q.ms,
    }),
  );
}

// R2 cannot append: one object per search is the append-only equivalent. Nothing identifying is stored.
export async function logBusqueda(
  bucket: R2Bucket,
  q: { consulta: string; filtros?: Filtros; n_resultados: number },
  now: Date = new Date(),
): Promise<void> {
  const rnd = [...crypto.getRandomValues(new Uint8Array(4))].map((b) => b.toString(16).padStart(2, "0")).join("");
  const key = `busquedas/${now.toISOString().slice(0, 10)}/${now.getTime()}-${rnd}.json`;
  await bucket.put(
    key,
    JSON.stringify({ ts: now.toISOString(), consulta: q.consulta.slice(0, 500), filtros: q.filtros ?? {}, n_resultados: q.n_resultados }),
  );
}
