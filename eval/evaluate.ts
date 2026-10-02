export interface Case { necesidad: string; esperado: string | null }
export interface Hit { id: string; score: number }
export const UMBRALES = [0.3, 0.4, 0.5, 0.6, 0.7];
const TOP = 5;

export interface Report {
  reales: number;
  aciertos: number;
  porcentaje: number;
  fallos: { necesidad: string; esperado: string; rank: number | null; score: number | null }[];
  barrido: { umbral: number; reales: number; absurdasRechazadas: number }[];
  absurdas: number;
  recomendado: number | null;
}

// results[i] = raw hits (any order) for cases[i]. Mirrors buscar: a query is rejected when its
// best score is below the umbral; otherwise the top 5 are returned.
export function evaluate(cases: Case[], results: Hit[][], umbrales = UMBRALES): Report {
  const ranked = results.map((r) => [...r].sort((a, b) => b.score - a.score));
  const real: { c: Case; r: Hit[]; rank: number | null }[] = [];
  const absurd: Hit[][] = [];
  cases.forEach((c, i) => {
    if (c.esperado === null) absurd.push(ranked[i]);
    else {
      const idx = ranked[i].findIndex((h) => h.id === c.esperado);
      real.push({ c, r: ranked[i], rank: idx < 0 ? null : idx + 1 });
    }
  });
  const hit = (x: (typeof real)[number]) => x.rank !== null && x.rank <= TOP;
  const aciertos = real.filter(hit).length;
  const fallos = real.filter((x) => !hit(x)).map((x) => ({
    necesidad: x.c.necesidad, esperado: x.c.esperado as string, rank: x.rank,
    score: x.rank === null ? null : x.r[x.rank - 1].score,
  }));
  const barrido = umbrales.map((umbral) => ({
    umbral,
    reales: real.filter((x) => hit(x) && x.r[0].score >= umbral).length,
    absurdasRechazadas: absurd.filter((r) => !r.length || r[0].score < umbral).length,
  }));
  const ok = barrido.filter((b) => b.reales === aciertos && b.absurdasRechazadas === absurd.length);
  return {
    reales: real.length, aciertos,
    porcentaje: real.length ? (100 * aciertos) / real.length : 0,
    fallos, barrido, absurdas: absurd.length,
    recomendado: ok.length ? Math.max(...ok.map((b) => b.umbral)) : null,
  };
}

export function formatReport(r: Report): string {
  const L = [`Top-${TOP}: ${r.aciertos}/${r.reales} (${r.porcentaje.toFixed(0)}%)`];
  for (const f of r.fallos)
    L.push(`  FALLO "${f.necesidad}" -> ${f.esperado}: ${f.rank === null ? "ausente" : `rank ${f.rank}, score ${f.score!.toFixed(3)}`}`);
  L.push("Barrido de umbral:");
  for (const b of r.barrido)
    L.push(`  ${b.umbral.toFixed(1)}: reales devueltos ${b.reales}/${r.reales}, absurdas rechazadas ${b.absurdasRechazadas}/${r.absurdas}`);
  L.push(r.recomendado === null
    ? "Ningún umbral del barrido conserva todos los aciertos y rechaza todas las absurdas; revisar casos o ampliar el barrido."
    : `Umbral recomendado: ${r.recomendado}`);
  return L.join("\n");
}
