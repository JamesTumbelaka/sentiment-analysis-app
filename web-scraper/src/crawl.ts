import { getHtml } from "./http";
import pLimit from "p-limit";
import * as dotenv from "dotenv";
import { chromium } from "playwright";
dotenv.config();

const USE_BROWSER_FALLBACK = process.env.USE_BROWSER_FALLBACK === "1";
const MAX_STATIC_BYTES = Number(process.env.MAX_STATIC_BYTES ?? 8000);

async function fetchWithBrowser(url: string): Promise<string> {
  const browser = await chromium.launch({ headless: true });
  const page = await browser.newPage({
    userAgent: process.env.USER_AGENT
  });
  try {
    await page.goto(url, { waitUntil: "networkidle", timeout: 60000 });
    const html = await page.content();
    return html;
  } finally {
    await browser.close();
  }
}

export async function fetchSmart(url: string): Promise<{ html: string | null; via: "axios" | "playwright" | null }> {
  try {
    const html = await getHtml(url);
    if (USE_BROWSER_FALLBACK && (!html || html.length < MAX_STATIC_BYTES)) {
      const rendered = await fetchWithBrowser(url);
      return { html: rendered, via: "playwright" };
    }
    return { html, via: "axios" };
  } catch {
    if (USE_BROWSER_FALLBACK) {
      try {
        const rendered = await fetchWithBrowser(url);
        return { html: rendered, via: "playwright" };
      } catch {
        return { html: null, via: null };
      }
    }
    return { html: null, via: null };
  }
}

export async function fetchManySmart(urls: string[], concurrency = 5) {
  const limit = pLimit(concurrency);
  const tasks = urls.map((u) =>
    limit(async () => fetchSmart(u))
  );
  return Promise.all(tasks);
}
