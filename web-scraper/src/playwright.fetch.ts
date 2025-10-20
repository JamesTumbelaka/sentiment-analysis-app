import { chromium, Browser } from "playwright";
import * as dotenv from "dotenv";
dotenv.config();

async function fetchRenderedHtml(url: string): Promise<string> {
  const browser: Browser = await chromium.launch({ headless: true });
  const page = await browser.newPage({
    userAgent:
      process.env.USER_AGENT ??
      "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120 Safari/537.36"
  });

  try {
    await page.goto(url, { waitUntil: "domcontentloaded", timeout: 60000 });
    const html = await page.content();
    return html;
  } finally {
    await browser.close();
  }
}

if (process.argv[1]?.endsWith("playwright.fetch.ts")) {
  const url = process.env.BASE_URL || "https://example.com/";
  fetchRenderedHtml(url)
    .then((html) => {
      console.log("Length:", html.length);
    })
    .catch((e) => {
      console.error("Playwright error:", e?.message || e);
      process.exit(1);
    });
}

export { fetchRenderedHtml };
