import type { Case } from "../../eval/evaluate";

// First d components, then L2-normalise (zero vector stays zero, never NaN).
export function truncateNormalize(v: ArrayLike<number>, d: number): Float32Array {
  const out = new Float32Array(d);
  let n = 0;
  for (let i = 0; i < d; i++) { out[i] = v[i]; n += out[i] * out[i]; }
  n = Math.sqrt(n);
  if (n > 0) for (let i = 0; i < d; i++) out[i] /= n;
  return out;
}

// Inputs are unit vectors, so cosine == dot product.
export function cosineScores(q: Float32Array, docs: Float32Array[]): Float32Array {
  const out = new Float32Array(docs.length);
  for (let i = 0; i < docs.length; i++) {
    const d = docs[i];
    let s = 0;
    for (let j = 0; j < q.length; j++) s += q[j] * d[j];
    out[i] = s;
  }
  return out;
}

export interface CasoResultado {
  necesidad: string; esperado: string; idioma: string | null;
  rank: number | null; // 1-based among all docs; null = esperado not among the indexed docs
  mejor: number; scoreEsperado: number | null;
}
export interface Resumen {
  reales: number; top5: number; top10: number; mrr: number;
  porIdioma: Record<string, { top5: number; reales: number }>;
  medianaMejorReal: number; minMejorReal: number;
  p10MejorReal: number; p50MejorReal: number; p90MejorReal: number; mejoresAbsurdas: number[];
  maxMejorAbsurda: number | null; separable: boolean | null; // minMejorReal > maxMejorAbsurda
}
export interface Evaluacion {
  casos: CasoResultado[];
  absurdas: { necesidad: string; mejor: number }[];
  resumen: Resumen;
}

const max = (a: ArrayLike<number>) => { let m = -Infinity; for (let i = 0; i < a.length; i++) if (a[i] > m) m = a[i]; return m; };
// Linear-interpolated quantile, p in [0,1].
export function cuantil(xs: number[], p: number): number {
  if (!xs.length) return NaN;
  const s = [...xs].sort((a, b) => a - b), pos = p * (s.length - 1), lo = Math.floor(pos);
  return lo + 1 < s.length ? s[lo] + (s[lo + 1] - s[lo]) * (pos - lo) : s[lo];
}

// Free Vectorize quota: 5,000,000 stored dimensions.
export function capacidad(dim: number, elegibles: number): { vectores: number; cobertura: number } {
  const vectores = Math.floor(5_000_000 / dim);
  return { vectores, cobertura: elegibles ? Math.min(1, vectores / elegibles) : 0 };
}

const median = (xs: number[]) => {
  if (!xs.length) return NaN;
  const s = [...xs].sort((a, b) => a - b), h = s.length >> 1;
  return s.length % 2 ? s[h] : (s[h - 1] + s[h]) / 2;
};

// queries[i] belongs to cases[i]. Ties favour the expected entry (rank = 1 + docs strictly better).
export function evaluar(cases: Case[], queries: Float32Array[], docs: Float32Array[], ids: string[]): Evaluacion {
  const casos: CasoResultado[] = [];
  const absurdas: Evaluacion["absurdas"] = [];
  cases.forEach((c, i) => {
    const s = cosineScores(queries[i], docs);
    const mejor = max(s);
    if (c.esperado === null) { absurdas.push({ necesidad: c.necesidad, mejor }); return; }
    const k = ids.indexOf(c.esperado);
    let rank: number | null = null;
    if (k >= 0) { rank = 1; for (let j = 0; j < s.length; j++) if (s[j] > s[k]) rank++; }
    casos.push({ necesidad: c.necesidad, esperado: c.esperado, idioma: c.idioma ?? null, rank, mejor, scoreEsperado: k >= 0 ? s[k] : null });
  });
  const porIdioma: Resumen["porIdioma"] = {};
  for (const c of casos) {
    if (!c.idioma) continue;
    const g = (porIdioma[c.idioma] ??= { top5: 0, reales: 0 });
    g.reales++;
    if (c.rank !== null && c.rank <= 5) g.top5++;
  }
  const mejores = casos.map((c) => c.mejor);
  const minMejorReal = mejores.length ? Math.min(...mejores) : NaN;
  const maxMejorAbsurda = absurdas.length ? Math.max(...absurdas.map((a) => a.mejor)) : null;
  return {
    casos, absurdas,
    resumen: {
      reales: casos.length,
      top5: casos.filter((c) => c.rank !== null && c.rank <= 5).length,
      top10: casos.filter((c) => c.rank !== null && c.rank <= 10).length,
      mrr: casos.length ? casos.reduce((s, c) => s + (c.rank ? 1 / c.rank : 0), 0) / casos.length : 0,
      porIdioma, medianaMejorReal: median(mejores), minMejorReal,
      p10MejorReal: cuantil(mejores, 0.1), p50MejorReal: cuantil(mejores, 0.5), p90MejorReal: cuantil(mejores, 0.9),
      mejoresAbsurdas: absurdas.map((a) => a.mejor), maxMejorAbsurda,
      separable: maxMejorAbsurda === null || !casos.length ? null : minMejorReal > maxMejorAbsurda,
    },
  };
}

export interface Reporte {
  fecha: string; modo?: "experimento" | "completo"; documentos: number; consultas: number;
  configs: {
    nombre: string; modelo: string; dimsNativas: number;
    neuronas: number | null; // null = response had no usage.neurons
    resultados: ({ dim: number } & Evaluacion)[];
  }[];
}

const f = (x: number | null) => (x === null || Number.isNaN(x) ? "-" : x.toFixed(3));

export function renderMarkdown(r: Reporte): string {
  const completo = r.modo === "completo";
  const L = [
    `# Experimento ${completo ? "completo" : "de embeddings"} (${r.fecha})`, "",
    `${r.documentos} documentos, ${r.consultas} consultas. Score = coseno. "Sep." = mínimo del mejor score de las reales > máximo del mejor score de las absurdas (un umbral las separa).`, "",
    "| config | dims | top5 | es | en | top10 | MRR | mediana mejor | mín mejor | máx absurda | sep. |",
    "|---|---|---|---|---|---|---|---|---|---|---|",
  ];
  const g = (s: Resumen, l: string) => (s.porIdioma[l] ? `${s.porIdioma[l].top5}/${s.porIdioma[l].reales}` : "-");
  for (const c of r.configs)
    for (const x of c.resultados) {
      const s = x.resumen;
      L.push(`| ${c.nombre} | ${x.dim} | ${s.top5}/${s.reales} | ${g(s, "es")} | ${g(s, "en")} | ${s.top10}/${s.reales} | ${f(s.mrr)} | ${f(s.medianaMejorReal)} | ${f(s.minMejorReal)} | ${f(s.maxMejorAbsurda)} | ${s.separable === null ? "-" : s.separable ? "sí" : "no"} |`);
    }
  if (completo) {
    L.push("", "## Capacidad en 5.000.000 dimensiones y distribución del mejor score",
      "bge-m3 no se re-embebió en este modo: su línea base está en el experimento de 4.500 documentos.", "",
      "| dim | vectores que caben | documentos elegibles | cobertura | p10 real | p50 real | p90 real | mejor score absurdas |",
      "|---|---|---|---|---|---|---|---|");
    for (const c of r.configs)
      for (const x of c.resultados) {
        const k = capacidad(x.dim, r.documentos), s = x.resumen;
        L.push(`| ${x.dim} | ${k.vectores} | ${r.documentos} | ${Math.round(100 * k.cobertura)}% | ${f(s.p10MejorReal)} | ${f(s.p50MejorReal)} | ${f(s.p90MejorReal)} | ${s.mejoresAbsurdas.map(f).join(", ") || "-"} |`);
      }
  }
  L.push("", "## Neuronas");
  for (const c of r.configs)
    L.push(`- ${c.nombre} (${c.modelo}): ${c.neuronas === null ? "usage.neurons no informado por la API" : c.neuronas}`);
  L.push("", "## Fallos (fuera del top 5)");
  for (const c of r.configs)
    for (const x of c.resultados) {
      const miss = x.casos.filter((k) => k.rank === null || k.rank > 5);
      if (!miss.length) continue;
      L.push(`### ${c.nombre} @ ${x.dim}`);
      for (const k of miss) L.push(`- rank ${k.rank ?? "no indexado"}: "${k.necesidad}" -> ${k.esperado} (score esperado ${f(k.scoreEsperado)}, mejor ${f(k.mejor)})`);
    }
  L.push("", "## Notas",
    "- Comparar cada fila gemma contra bge-m3 1024: la pérdida aceptable es decisión humana; 128 dims permitiría ~39.000 vectores en 5 M dimensiones.",
    "- 20 casos reales: una diferencia de 1 acierto es ruido; mirar también MRR y los rank de los fallos.",
    completo ? `- Se rankea entre los ${r.documentos} documentos elegibles (corpus completo).`
      : "- Solo se rankea entre las 4.500 entradas indexadas hoy; con ~39.000 habrá más distractores y el rank real empeorará.",
    "- Sin 'sep.' = sí, el umbral actual de rechazo de consultas absurdas habría que recalibrarlo para ese modelo/dim.");
  return L.join("\n");
}
