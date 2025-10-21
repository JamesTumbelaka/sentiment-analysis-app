import * as fs from "fs";
import path from "path";
import chalk from "chalk";
import Papa from "papaparse";
import _ from "lodash";
import { pick } from "lodash";

import { chromium } from "playwright-extra";
import stealth from "puppeteer-extra-plugin-stealth";

import { inputKeywords } from "./features/input-keywords";
import { listenNetworkRequests } from "./features/listen-network-requests";
import { calculateForRateLimit } from "./features/exponential-backoff";

import { HEADLESS_MODE } from "./env";
import {
  FILTERED_FIELDS,
  FOLDER_DESTINATION,
  FUlL_PATH_FOLDER_DESTINATION,
  NOW,
  TWITTER_SEARCH_ADVANCED_URL,
} from "./constants";

import { CACHE_KEYS, cache } from "./cache";
import { logError, scrollDown, scrollUp } from "./helpers/page.helper";
import type { Entry } from "./types/tweets.types";

chromium.use(stealth());

let headerWritten = false;
function resetCsvHeaderFlag() {
  headerWritten = false;
}

function appendCsv(pathStr: string, jsonData: Record<string, any>[]) {
  const fileName = path.resolve(pathStr);

  const csv = Papa.unparse(jsonData, {
    quotes: true,
    header: !headerWritten,
    skipEmptyLines: true,
  });

  headerWritten = true;

  fs.appendFileSync(fileName, csv);
  fs.appendFileSync(fileName, "\r\n");

  return fileName;
}

type StartCrawlTwitterParams = {
  twitterSearchUrl?: string;
};

export type CrawlParams = {
  ACCESS_TOKEN: string;
  SEARCH_KEYWORDS?: string;
  SEARCH_FROM_DATE?: string;
  SEARCH_TO_DATE?: string;
  TARGET_TWEET_COUNT?: number;
  DELAY_EACH_TWEET_SECONDS?: number;
  DELAY_EVERY_100_TWEETS_SECONDS?: number;
  DEBUG_MODE?: boolean;
  OUTPUT_FILENAME?: string;
  TWEET_THREAD_URL?: string;
  SEARCH_TAB?: "LATEST" | "TOP";
  CSV_INSERT_MODE?: "REPLACE" | "APPEND";
};

export type CrawlResult = {
  filePath: string;
  totalTweets: number;
  usedTabs: string[];
};

let lastSavedFile: string | null = null;
let totalCountForThisRun = 0;

export async function crawl({
  ACCESS_TOKEN,
  SEARCH_KEYWORDS,
  TWEET_THREAD_URL,
  SEARCH_FROM_DATE,
  SEARCH_TO_DATE,
  TARGET_TWEET_COUNT = 10,
  DELAY_EACH_TWEET_SECONDS = 3,
  DELAY_EVERY_100_TWEETS_SECONDS = 10,
  DEBUG_MODE,
  OUTPUT_FILENAME,
  SEARCH_TAB = "LATEST",
  CSV_INSERT_MODE = "REPLACE",
}: CrawlParams): Promise<CrawlResult> {
  resetCsvHeaderFlag();
  lastSavedFile = null;
  totalCountForThisRun = 0;

  const CRAWL_MODE = TWEET_THREAD_URL ? "DETAIL" : "SEARCH";
  const SWITCHED_SEARCH_TAB = SEARCH_TAB === "TOP" ? "LATEST" : "TOP";

  const IS_DETAIL_MODE = CRAWL_MODE === "DETAIL";
  const IS_SEARCH_MODE = CRAWL_MODE === "SEARCH";
  const REACH_TIMEOUT_MAX = 3;
  const TIMEOUT_LIMIT = 20;

  let MODIFIED_SEARCH_KEYWORDS = SEARCH_KEYWORDS;
  const CURRENT_PACKAGE_VERSION = require("../package.json").version;

  const filename = (OUTPUT_FILENAME || `${SEARCH_KEYWORDS} ${NOW}`).trim().replace(".csv", "");
  const FILE_NAME = `${FOLDER_DESTINATION}/${filename}.csv`.replace(/ /g, "_").replace(/:/g, "-");

  console.info(chalk.blue("\nOpening twitter search page...\n"));

  if (CSV_INSERT_MODE === "REPLACE" && fs.existsSync(FILE_NAME)) {
    console.info(
      chalk.blue(`\nFound existing file ${FILE_NAME}, renaming to ${FILE_NAME.replace(".csv", ".old.csv")}`)
    );
    fs.renameSync(FILE_NAME, FILE_NAME.replace(".csv", ".old.csv"));
  }

  let TWEETS_NOT_FOUND_ON_CURRENT_TAB = false;
  let triedSwitchTab = false;

  const browser = await chromium.launch({ headless: HEADLESS_MODE });
  const context = await browser.newContext({
    screen: { width: 1240, height: 1080 },
    storageState: {
      cookies: [
        {
          name: "auth_token",
          value: ACCESS_TOKEN,
          domain: "x.com",
          path: "/",
          expires: -1,
          httpOnly: true,
          secure: true,
          sameSite: "Strict",
        },
      ],
      origins: [],
    },
  });

  const page = await context.newPage();
  page.setDefaultTimeout(60 * 1000);

  listenNetworkRequests(page);

  async function startCrawlTwitter({
    twitterSearchUrl = TWITTER_SEARCH_ADVANCED_URL[SEARCH_TAB],
  }: StartCrawlTwitterParams = {}) {
    if (IS_DETAIL_MODE) {
      await page.goto(TWEET_THREAD_URL!);
    } else {
      await page.goto(twitterSearchUrl);
    }

    const isLoggedIn = !page.url().includes("/login");
    if (!isLoggedIn) {
      logError("Invalid twitter auth token. Please check your auth token");
      return browser.close();
    }

    if (IS_SEARCH_MODE) {
      await inputKeywords(page, {
        SEARCH_FROM_DATE,
        SEARCH_TO_DATE,
        SEARCH_KEYWORDS,
        MODIFIED_SEARCH_KEYWORDS,
      });
    }

    let timeoutCount = 0;
    let additionalTweetsCount = 0;
    let reachTimeout = 0;
    let rateLimitCount = 0;

    const allData = { tweets: [] as any[] };

    async function scrollAndSave(): Promise<void> {
      while (
        allData.tweets.length < TARGET_TWEET_COUNT &&
        (timeoutCount < TIMEOUT_LIMIT || reachTimeout < REACH_TIMEOUT_MAX)
      ) {
        if (timeoutCount > TIMEOUT_LIMIT && reachTimeout < REACH_TIMEOUT_MAX) {
          reachTimeout++;
          console.info(chalk.yellow(`Timeout reached ${reachTimeout} times, making sure again...`));
          timeoutCount = 0;

          await scrollUp(page);
          await page.waitForTimeout(2000);
          await scrollDown(page);
        }

        const response = await Promise.race([
          page.waitForResponse(
            (res) => res.url().includes("SearchTimeline") || res.url().includes("TweetDetail")
          ),
          page.waitForTimeout(1500),
        ]);

        if (response) {
          timeoutCount = 0;
          let tweets: Entry[] = [];
          let responseJson: any;

          try {
            responseJson = await (response as any).json();
          } catch (error) {
            cache.set(CACHE_KEYS.GOT_TWEETS, false);

            const body = (await (response as any).text?.()?.catch?.(() => "")) || "";
            if (body.toLowerCase().includes("rate limit")) {
              logError(`Error parsing response json: ${JSON.stringify(response)}`);
              logError(
                `Most likely, you have already exceeded the Twitter rate limit. Read more on https://x.com/elonmusk/status/1675187969420828672.`
              );

              await page.waitForTimeout(calculateForRateLimit(rateLimitCount++));

              await page.click("text=Retry").catch(() => {});
              return await scrollAndSave();
            }

            break;
          }

          rateLimitCount = 0;

          const isTweetDetail = responseJson?.data?.threaded_conversation_with_injections_v2;
          if (isTweetDetail) {
            tweets = responseJson.data?.threaded_conversation_with_injections_v2?.instructions?.[0]?.entries || [];
          } else {
            tweets =
              responseJson.data?.search_by_raw_query?.search_timeline?.timeline?.instructions?.[0]?.entries || [];
          }

          if (!tweets) {
            logError("No more tweets found, please check your search criteria and csv file result");
            return;
          }

          if (!tweets.length) {
            if (await page.getByText("No results for").count()) {
              TWEETS_NOT_FOUND_ON_CURRENT_TAB = true;
              console.info("No tweets found for the search criteria");
              break;
            }
          }

          cache.set(CACHE_KEYS.GOT_TWEETS, true);

          const tweetContents = tweets
            .map((tweet) => {
              const isPromotedTweet = tweet.entryId?.includes?.("promoted");

              if (IS_SEARCH_MODE && !tweet?.content?.itemContent?.tweet_results?.result) return null;

              if (IS_DETAIL_MODE) {
                if (!tweet?.content?.items?.[0]?.item?.itemContent) return null;
                const isMentionThreadCreator =
                  tweet?.content?.items?.[0]?.item?.itemContent?.tweet_results?.result?.legacy?.entities
                    ?.user_mentions?.[0];
                if (!isMentionThreadCreator) return null;
              }

              if (isPromotedTweet) return null;

              const result = IS_SEARCH_MODE
                ? tweet.content.itemContent.tweet_results.result
                : tweet.content.items[0].item.itemContent.tweet_results.result;

              if (!result?.tweet?.core?.user_results && !result?.core?.user_results) return null;

              const tweetContent = result.legacy || result.tweet.legacy;
              const userContent = result.core?.user_results?.result?.legacy || result.tweet.core.user_results.result.legacy;

              return { tweet: tweetContent, user: userContent };
            })
            .filter(Boolean) as Array<{ tweet: any; user: any }>;

          allData.tweets.push(...tweetContents);

          if (!fs.existsSync(FOLDER_DESTINATION)) {
            const dir = fs.mkdirSync(FOLDER_DESTINATION, { recursive: true });
            const dirFullPath = path.resolve(dir);
            console.info(chalk.green(`Created new directory: ${dirFullPath}`));
          }

          const rows = tweetContents.map((current) => {
            const tweet = pick(current.tweet, FILTERED_FIELDS) as Record<string, any>;

            const charsToReplace = ["\n", ",", '"', "⁦", "⁩", "’", "‘", "“", "”", "…", "—", "–", "•"];
            let cleanTweetText = (tweet.full_text || "").replace(new RegExp(charsToReplace.join("|"), "g"), " ");

            const emojiPattern =
              /[\u{1F600}-\u{1F64F}\u{1F300}-\u{1F5FF}\u{1F680}-\u{1F6FF}\u{1F700}-\u{1F77F}\u{1F780}-\u{1F7FF}\u{1F800}-\u{1F8FF}\u{1F900}-\u{1F9FF}\u{1FA00}-\u{1FA6F}\u{1FA70}-\u{1FAFF}\u{2600}-\u{26FF}\u{2700}-\u{27BF}]/gu;
            cleanTweetText = cleanTweetText.replace(emojiPattern, "");

            cleanTweetText = cleanTweetText.replace(/\s\s+/g, " ");

            if (IS_DETAIL_MODE) {
              const firstWord = cleanTweetText.split(" ")[0];
              const replyToUsername = current.tweet.entities?.user_mentions?.[0]?.screen_name;
              if (firstWord && firstWord[1] === "@" && replyToUsername) {
                cleanTweetText = cleanTweetText.replace(`@${replyToUsername} `, "");
              }
            }

            tweet["full_text"] = cleanTweetText;
            tweet["username"] = current.user.screen_name;
            tweet["tweet_url"] = `https://x.com/${current.user.screen_name}/status/${tweet.id_str}`;
            tweet["image_url"] = current.tweet.entities?.media?.[0]?.media_url_https || "";
            tweet["location"] = current.user.location || "";
            tweet["in_reply_to_screen_name"] = current.tweet.in_reply_to_screen_name || "";

            return tweet;
          });

          const sortedArrayOfObjects = _.map(rows, (obj) => _.fromPairs(_.sortBy(Object.entries(obj), 0)));

          const fullPathFilename = appendCsv(FILE_NAME, sortedArrayOfObjects);
          lastSavedFile = fullPathFilename;

          console.info(chalk.blue(`\n\nYour tweets saved to: ${fullPathFilename}`));

          console.info(chalk.yellow(`Total tweets saved: ${allData.tweets.length}`));
          totalCountForThisRun = allData.tweets.length;

          if (rows.length) {
            if (totalCountForThisRun % 100 === 0 && DELAY_EVERY_100_TWEETS_SECONDS) {
              console.info(chalk.gray(`\n--Taking a break, waiting for ${DELAY_EVERY_100_TWEETS_SECONDS} seconds...`));
              await page.waitForTimeout(DELAY_EVERY_100_TWEETS_SECONDS * 1000);
            } else if (rows.length > 20) {
              await page.waitForTimeout(DELAY_EACH_TWEET_SECONDS * 1000);
            }
          }

          cache.set(CACHE_KEYS.GOT_TWEETS, false);
        } else {
          if (cache.get(CACHE_KEYS.GOT_TWEETS) === false) {
            timeoutCount++;

            if (timeoutCount === 1) {
              process.stdout.write(chalk.gray(`\n-- Scrolling... (${timeoutCount})`));
            } else {
              process.stdout.write(chalk.gray(` (${timeoutCount})`));
            }

            if (timeoutCount > TIMEOUT_LIMIT) {
              console.info(chalk.yellow("No more tweets found, please check your search criteria and csv file result"));
              break;
            }
          }

          await scrollDown(page);
          await scrollAndSave();
        }

        await scrollDown(page);
      }
    }

    await scrollAndSave();

    if (totalCountForThisRun) {
      console.info(`Got ${totalCountForThisRun} tweets, done scrolling...`);
    } else {
      console.info("No tweets found for the search criteria");
    }
  }

  try {
    await startCrawlTwitter();

    if (cache.get(CACHE_KEYS.GOT_TWEETS) === false && !totalCountForThisRun) {
      console.info(`No tweets found on "${SEARCH_TAB}" tab, trying "${SWITCHED_SEARCH_TAB}" tab...`);
      triedSwitchTab = true;
      await startCrawlTwitter({
        twitterSearchUrl: TWITTER_SEARCH_ADVANCED_URL[SWITCHED_SEARCH_TAB],
      });
    }
  } catch (error: any) {
    logError(error?.message || String(error));
    console.info(chalk.blue(`Keywords: ${MODIFIED_SEARCH_KEYWORDS}`));
    console.info(chalk.yellowBright("Twitter Harvest v", CURRENT_PACKAGE_VERSION));

    try {
      if (!fs.existsSync(FUlL_PATH_FOLDER_DESTINATION)) {
        fs.mkdirSync(FUlL_PATH_FOLDER_DESTINATION, { recursive: true });
      }
      const errorFilename = FUlL_PATH_FOLDER_DESTINATION + `/Error-${NOW}.png`.replace(/ /g, "_");
      await page.screenshot({ path: path.resolve(errorFilename) });
      console.log(
        chalk.red(
          `\nIf you need help, please send this error screenshot to the maintainer, it was saved to "${path.resolve(
            errorFilename
          )}"`
        )
      );
    } catch {
    }
  } finally {
    if (!DEBUG_MODE) {
      await browser.close();
    }
  }

  return {
    filePath: lastSavedFile || path.resolve(FILE_NAME),
    totalTweets: totalCountForThisRun,
    usedTabs: (totalCountForThisRun && cache.get(CACHE_KEYS.GOT_TWEETS) === false)
      ? [SEARCH_TAB]
      : [SEARCH_TAB],
  };
}
