import * as dotenv from "dotenv";
dotenv.config();

import { searchWeb } from "./search";
import { fetchManySmart } from "./crawl";
import { parseGeneric } from "./parse";
import { saveCsv, saveJson } from "./save";
import { CompileRecord } from "./types";
import { createInterface } from "node:readline/promises";
import { stdin as input, stdout as output } from "node:process";

async function askKeyword(): Promise<string> {
  const rl = createInterface({ input, output });
  const ans = await rl.question("Masukkan keyword pencarian: ");
  rl.close();
  return ans.trim();
}

function sanitizeKeyword(keyword: string): string {
  return keyword
    .toLowerCase()
    .replace(/[^a-z0-9]+/gi, "_")
    .replace(/^-|-$/g, "")
    .slice(0, 60);
}

function makeFilename(base: string, keyword: string, ext: "json" | "csv"): string {
  const date = new Date().toISOString().slice(0, 10);
  const kw = sanitizeKeyword(keyword);
  return `${date} ${kw}.${ext}`;
}

async function main() {
  const idx = process.argv.findIndex((a) => a === "--keyword");
  let q: string | undefined = undefined;

  if (idx >= 0 && process.argv[idx + 1]) q = process.argv.slice(idx + 1).join(" ");
  if (!q) q = await askKeyword();

  const limit = Number(process.env.RESULTS_LIMIT ?? 50);
  const concurrency = Number(process.env.FETCH_CONCURRENCY ?? 5);

  console.log(`\n[1/4] Mencari link untuk: "${q}" ...`);
  const results = await searchWeb(q, limit);
  if (results.length === 0) {
    console.log("Tidak ada hasil dari provider pencarian.");
    process.exit(0);
  }
  console.log(`[✓] Dapat ${results.length} hasil.\n`);

  const urls = results.map((r) => r.url);

  console.log("[2/4] Mengambil HTML (statis → fallback Chrome jika perlu) ...");
  const fetched = await fetchManySmart(urls, concurrency);

  console.log("[3/4] Parsing halaman ...");
  const extracts = fetched.map((f, i) =>
    f.html ? parseGeneric(f.html, urls[i], f.via || "axios")
           : { url: urls[i], fetchedAt: new Date().toISOString(), via: "axios" as const }
  );

  console.log("[4/4] Kompilasi & simpan ...");

  const compiled: CompileRecord[] = results.map((r, i) => ({
    ...r,
    ...(extracts[i] as any)
  }));

  const jsonFilename = makeFilename("compiled", q, "json");
  const csvFilename = makeFilename("compiled", q, "csv");

  const jsonPath = await saveJson(compiled, jsonFilename);
  const csvPath = await saveCsv(compiled, csvFilename);

  console.log(`\nSelesai ✅
JSON: ${jsonPath}
CSV : ${csvPath}\n`);
}

main().catch((e) => {
  console.error("Error:", e?.message || e);
  process.exit(1);
});
