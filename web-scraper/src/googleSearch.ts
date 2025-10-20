import { google } from "googleapis";
import * as dotenv from "dotenv";
import { SearchResult } from "./types";
import { sleep } from "./utils";
dotenv.config();

export async function googleSearch(q: string, limit = 200): Promise<SearchResult[]> {
  const key = process.env.GOOGLE_API_KEY;
  const cx = process.env.Google_CX || process.env.GOOGLE_CX; // tolerate both
  if (!key || !cx) return [];

  const perPage = 10; // Google caps at 10
  const delayMs = Number(process.env.SEARCH_PAGE_DELAY_MS ?? 1000);
  const customsearch = google.customsearch("v1");
  const results: SearchResult[] = [];

  for (let start = 1; start <= limit && results.length < limit; start += perPage) {
    const res = await customsearch.cse.list({
      q,
      cx,
      key,
      num: perPage,
      start,
    });

    const items = res.data.items || [];
    results.push(
      ...items.map((i) => ({
        title: i.title ?? "",
        url: i.link ?? "",
        snippet: i.snippet ?? undefined,
        source: "google" as const,
      }))
    );

    if (items.length < perPage) break;

    if (results.length < limit) {
      await sleep(delayMs);
    }
  }

  return results.slice(0, limit);
}
