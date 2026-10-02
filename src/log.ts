import type { Filtros } from "./search/buscar";

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
