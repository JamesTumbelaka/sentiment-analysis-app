import "dotenv/config";
import express from "express";
import cors from "cors";
import morgan from "morgan";
import path from "path";
import fs from "fs";
import { z } from "zod";
import { crawl } from "../crawl";
import { FOLDER_DESTINATION, FUlL_PATH_FOLDER_DESTINATION } from "../constants";

const app = express();
app.use(cors());
app.use(express.json({ limit: "1mb" }));
app.use(morgan("dev"));

const CrawlBodySchema = z.object({
  token: z.string().min(20, "Invalid Twitter auth token"),
  keyword: z.string().min(1, "keyword is required").optional(),
  threadUrl: z.string().url().optional(),
  from: z.string().optional(), // "DD-MM-YYYY"
  to: z.string().optional(),   // "DD-MM-YYYY"
  limit: z.number().int().positive().max(10000).default(100),
  delayEach: z.number().int().min(0).max(60).default(3),
  delayEvery100: z.number().int().min(0).max(300).default(10),
  outputFilename: z.string().optional(),
  tab: z.enum(["LATEST", "TOP"]).default("LATEST"),
  csvMode: z.enum(["REPLACE", "APPEND"]).default("REPLACE"),
  headless: z.boolean().optional(),
});

app.get("/health", (_req, res) => {
  res.json({ ok: true, service: "tweet-harvest", folder: FOLDER_DESTINATION });
});

app.use("/files", express.static(FUlL_PATH_FOLDER_DESTINATION, {
  setHeaders: (res) => {
    res.setHeader("Cache-Control", "no-store");
  }
}));

app.post("/api/crawl", async (req, res) => {
  const parsed = CrawlBodySchema.safeParse(req.body);
  if (!parsed.success) {
    return res.status(400).json({
      ok: false,
      error: parsed.error.flatten(),
    });
  }

  const {
    token,
    keyword,
    threadUrl,
    from,
    to,
    limit,
    delayEach,
    delayEvery100,
    outputFilename,
    tab,
    csvMode,
    headless,
  } = parsed.data;

  if (!keyword && !threadUrl) {
    return res.status(400).json({
      ok: false,
      error: "Either 'keyword' or 'threadUrl' must be provided",
    });
  }

  try {
    const result = await crawl({
      ACCESS_TOKEN: token,
      SEARCH_KEYWORDS: keyword,
      TWEET_THREAD_URL: threadUrl,
      SEARCH_FROM_DATE: from,
      SEARCH_TO_DATE: to,
      TARGET_TWEET_COUNT: limit,
      DELAY_EACH_TWEET_SECONDS: delayEach,
      DELAY_EVERY_100_TWEETS_SECONDS: delayEvery100,
      OUTPUT_FILENAME: outputFilename,
      SEARCH_TAB: tab,
      CSV_INSERT_MODE: csvMode,
    });

    const absolute = path.resolve(result.filePath);
    const downloadUrl = absolute.startsWith(path.resolve(FUlL_PATH_FOLDER_DESTINATION))
      ? `/files/${path.basename(absolute)}`
      : null;

    return res.json({
      ok: true,
      meta: {
        totalTweets: result.totalTweets,
        usedTabs: result.usedTabs,
      },
      file: {
        path: absolute,
        name: path.basename(absolute),
        downloadUrl,
      },
    });
  } catch (err: any) {
    return res.status(500).json({
      ok: false,
      error: err?.message || "crawl failed",
    });
  }
});

app.use((_req, res) => {
  res.status(404).json({ ok: false, error: "Not found" });
});

const PORT = Number(process.env.PORT || 3333);
app.listen(PORT, () => {
  if (!fs.existsSync(FUlL_PATH_FOLDER_DESTINATION)) {
    fs.mkdirSync(FUlL_PATH_FOLDER_DESTINATION, { recursive: true });
  }
  console.log(`[API] listening on http://localhost:${PORT}`);
  console.log(`[API] files served from: ${FUlL_PATH_FOLDER_DESTINATION}`);
});
