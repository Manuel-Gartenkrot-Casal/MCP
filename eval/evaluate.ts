export interface Case { necesidad: string; esperado: string | null; idioma?: "es" | "en" }
export interface Hit { id: string; score: number }
export const UMBRALES = [0.3, 0.4, 0.5, 0.6, 0.7];
export const UMBRALES_RERANK = [0.1, 0.2, 0.3, 0.4, 0.5, 0.6, 0.7, 0.8, 0.9];
const TOP = 5;

export interface Report {
  reales: number;
  aciertos: number;
  porcentaje: number; // over all real cases
  indexadas: number; // real cases whose esperado is in D1
  porcentajeIndexadas: number; // over indexed real cases only
  noIndexados: { necesidad: string; esperado: string }[];
  fallos: { necesidad: string; esperado: string; rank: number | null; score: number | null }[];
  barrido: { umbral: number; reales: number; absurdasRechazadas: number }[];
  absurdas: number;
  porIdioma: Record<string, { aciertos: number; reales: number }>; // real cases per case.idioma
  recomendado: number | null;
}

// results[i] = raw hits (any order) for cases[i]. Mirrors buscar: a query is rejected when its
// best score is below the umbral; otherwise the top 5 are returned.
// indexados = esperado ids present in D1 (default: all). A non-indexed case is reported apart and
// never counts as a hit (buscar drops ids without a D1 row); the umbral sweep uses indexed cases only.
export function evaluate(cases: Case[], results: Hit[][], umbrales = UMBRALES, indexados?: Set<string>): Report {
  const ranked = results.map((r) => [...r].sort((a, b) => b.score - a.score));
  const real: { c: Case; r: Hit[]; rank: number | null; idx: boolean }[] = [];
  const absurd: Hit[][] = [];
  cases.forEach((c, i) => {
    if (c.esperado === null) absurd.push(ranked[i]);
    else {
      const idx = ranked[i].findIndex((h) => h.id === c.esperado);
      real.push({ c, r: ranked[i], rank: idx < 0 ? null : idx + 1, idx: !indexados || indexados.has(c.esperado) });
    }
  });
  const hit = (x: (typeof real)[number]) => x.idx && x.rank !== null && x.rank <= TOP;
  const aciertos = real.filter(hit).length;
  const indexadas = real.filter((x) => x.idx).length;
  const fallos = real.filter((x) => x.idx && !hit(x)).map((x) => ({
    necesidad: x.c.necesidad, esperado: x.c.esperado as string, rank: x.rank,
    score: x.rank === null ? null : x.r[x.rank - 1].score,
  }));
  const barrido = umbrales.map((umbral) => ({
    umbral,
    reales: real.filter((x) => hit(x) && x.r[0].score >= umbral).length,
    absurdasRechazadas: absurd.filter((r) => !r.length || r[0].score < umbral).length,
  }));
  const ok = barrido.filter((b) => b.reales === aciertos && b.absurdasRechazadas === absurd.length);
  const porIdioma: Report["porIdioma"] = {};
  for (const x of real) {
    if (!x.c.idioma) continue;
    const g = (porIdioma[x.c.idioma] ??= { aciertos: 0, reales: 0 });
    g.reales++;
    if (hit(x)) g.aciertos++;
  }
  return {
    reales: real.length, aciertos, porIdioma,
    porcentaje: real.length ? (100 * aciertos) / real.length : 0,
    indexadas,
    porcentajeIndexadas: indexadas ? (100 * aciertos) / indexadas : 0,
    noIndexados: real.filter((x) => !x.idx).map((x) => ({ necesidad: x.c.necesidad, esperado: x.c.esperado as string })),
    fallos, barrido, absurdas: absurd.length,
    recomendado: ok.length ? Math.max(...ok.map((b) => b.umbral)) : null,
  };
}

export function formatReport(r: Report): string {
  const L = [
    `Top-${TOP}: ${r.aciertos}/${r.reales} (${r.porcentaje.toFixed(0)}%) de todos; ` +
      `${r.aciertos}/${r.indexadas} indexados (${r.porcentajeIndexadas.toFixed(0)}%)`,
  ];
  const idiomas = Object.entries(r.porIdioma).sort(([a], [b]) => a.localeCompare(b));
  if (idiomas.length) L.push("Por idioma: " + idiomas.map(([k, g]) => `${k} ${g.aciertos}/${g.reales}`).join(", "));
  for (const n of r.noIndexados) L.push(`  NO INDEXADO "${n.necesidad}" -> ${n.esperado} (no está en D1)`);
  for (const f of r.fallos)
    L.push(`  FALLO "${f.necesidad}" -> ${f.esperado}: ${f.rank === null ? "ausente" : `rank ${f.rank}, score ${f.score!.toFixed(3)}`}`);
  L.push("Barrido de umbral:");
  for (const b of r.barrido)
    L.push(`  ${b.umbral.toFixed(1)}: reales devueltos ${b.reales}/${r.indexadas} indexados, absurdas rechazadas ${b.absurdasRechazadas}/${r.absurdas}`);
  L.push(r.recomendado === null
    ? "Ningún umbral del barrido conserva todos los aciertos y rechaza todas las absurdas; revisar casos o ampliar el barrido."
    : `Umbral recomendado: ${r.recomendado}`);
  return L.join("\n");
}

export interface Modos { vector: Report; reranked: Report }

// vector[i] / reranked[i] = raw hits for cases[i] in each mode. The vector sweep keeps UMBRALES;
// the reranked sweep uses UMBRALES_RERANK (its scores are sigmoid outputs spread over (0,1)).
export function evaluarModos(cases: Case[], vector: Hit[][], reranked: Hit[][], indexados?: Set<string>): Modos {
  return {
    vector: evaluate(cases, vector, UMBRALES, indexados),
    reranked: evaluate(cases, reranked, UMBRALES_RERANK, indexados),
  };
}

export const formatComparacion = (m: Modos): string =>
  ["== SOLO VECTOR ==", formatReport(m.vector), "", "== CON RERANKER ==", formatReport(m.reranked)].join("\n");
