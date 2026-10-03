import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { fetchRegistry } from "../src/ingest/registry";
import { rankEntries, MAX_VECTORS } from "../src/ingest/run";
import { runExperimento } from "../src/experimento/pipeline";
import type { Case } from "../eval/evaluate";

function env(name: string): string {
  const v = process.env[name];
  if (!v) throw new Error(`Falta la variable de entorno ${name}`);
  return v;
}

export async function main(): Promise<void> {
  const accountId = env("CF_ACCOUNT_ID"), token = env("CF_API_TOKEN");
  const root = join(dirname(fileURLToPath(import.meta.url)), "..");
  const cases: Case[] = JSON.parse(readFileSync(join(root, "eval", "casos.json"), "utf8"));
  const enc = new TextEncoder();
  // Same selection as production ingest: ids over 64 bytes are excluded, then rank, then cap.
  const all = (await fetchRegistry()).filter((e) => enc.encode(e.id).length <= 64);
  const entries = rankEntries(all).slice(0, MAX_VECTORS);
  console.error(`registro: ${all.length} entradas, ${entries.length} indexadas hoy`);
  const out = await runExperimento({ accountId, token, entries, cases, log: (m) => console.error(m) });
  const dir = join(root, "resultados");
  mkdirSync(dir, { recursive: true });
  const stamp = out.reporte.fecha.replace(/[:.]/g, "-");
  writeFileSync(join(dir, `experimento-${stamp}.json`), out.json);
  writeFileSync(join(dir, `experimento-${stamp}.md`), out.md);
  console.log(out.md);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((e) => { console.error(e instanceof Error ? e.message : e); process.exit(1); });
}
