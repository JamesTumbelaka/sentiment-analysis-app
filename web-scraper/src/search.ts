import { http } from "./http";
import * as dotenv from "dotenv";
import { load } from "cheerio";
import { SearchResult } from "./types";
import { googleSearch } from "./googleSearch";
import { sleep } from "./utils";
dotenv.config();

async function searchBing(q: string, limit: number): Promise<SearchResult[]> {
  const key = process.env.BING_API_KEY;
  const endpoint = process.env.BING_ENDPOINT || "https://api.bing.microsoft.com/v7.0/search";
  if (!key) return [];

  const perPage = 50;
  const delayMs = Number(process.env.SEARCH_PAGE_DELAY_MS ?? 1000);
  const results: SearchResult[] = [];

  for (let offset = 0; results.length < limit; offset += perPage) {
    const { data } = await http.get(endpoint, {
      params: { q, count: perPage, offset, mkt: "en-US" },
      headers: { "Ocp-Apim-Subscription-Key": key },
    });

    const webPages = data?.webPages?.value ?? [];
    if (!webPages.length) break;

    results.push(
      ...webPages.map((v: any) => ({
        title: v.name,
        url: v.url,
        snippet: v.snippet,
        source: "bing" as const,
      }))
    );

    if (webPages.length < perPage) break;

    if (results.length < limit) {
      await sleep(delayMs);
    }
  }

  return results.slice(0, limit);
}

async function searchDuckDuckGo(q: string, limit: number): Promise<SearchResult[]> {
  const url = "https://duckduckgo.com/html/";
  const { data: html } = await http.get(url, { params: { q } });
  const $ = load(html);
  const results: SearchResult[] = [];

  $("a.result__a, a.result__url").each((_, a) => {
    const href = $(a).attr("href");
    const title = $(a).text().trim();
    if (href && title) {
      results.push({
        title,
        url: href.startsWith("http") ? href : `https:${href}`,
        source: "duckduckgo",
      });
    }
  });

  const uniq = Array.from(new Map(results.map((r) => [r.url, r])).values());
  return uniq.slice(0, limit);
}

export async function searchWeb(q: string, limit = 200): Promise<SearchResult[]> {
  const g = await googleSearch(q, limit);
  if (g.length) return g;

  const b = await searchBing(q, limit);
  if (b.length) return b;

  return await searchDuckDuckGo(q, limit);
}
