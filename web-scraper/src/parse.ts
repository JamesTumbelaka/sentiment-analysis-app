import { load, CheerioAPI } from "cheerio";
import { PageExtract } from "./types";
import { nowIso, trimTo } from "./utils";

export function parseGeneric(html: string, url: string, via: "axios" | "playwright"): PageExtract {
  const $ = load(html);
  const title =
    $("meta[property='og:title']").attr("content") ||
    $("title").text().trim() ||
    $("h1").first().text().trim() ||
    undefined;

  const description =
    $("meta[name='description']").attr("content") ||
    $("meta[property='og:description']").attr("content") ||
    undefined;

  const h1 = $("h1").first().text().trim() || undefined;
  const firstParagraph = pickFirstParagraph($);

  return {
    url,
    title: title?.trim(),
    description: trimTo(description, 300),
    firstParagraph: trimTo(firstParagraph, 400),
    h1,
    fetchedAt: nowIso(),
    via
  };
}

function pickFirstParagraph($: CheerioAPI): string | undefined {
  const candidates = [
    $("article p").first().text(),
    $("main p").first().text(),
    $("p").first().text()
  ].map((s) => s?.replace(/\s+/g, " ").trim());

  return candidates.find((s) => s && s.length > 30);
}
