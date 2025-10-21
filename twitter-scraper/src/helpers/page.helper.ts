import { Page } from "@playwright/test";
import chalk from "chalk";

export const scrollUp = async (page: Page): Promise<void> => {
  await page.evaluate(() =>
    window.scrollTo({
      behavior: "smooth",
      top: 0,
    })
  );
};

export const scrollDown = async (page: Page): Promise<void> => {
  await page.evaluate(() =>
    window.scrollTo({
      behavior: "smooth",
      top: document.body.scrollHeight,
    })
  );

  await page.evaluate(() => document.querySelectorAll("a div[data-testid='tweetPhoto']").forEach((el) => el.remove()));

  await page.evaluate(() => document.querySelectorAll("a div[aria-label='Image']").forEach((el) => el.remove()));
  
  await page.evaluate(() => document.querySelectorAll("div[data-testid='tweetPhoto']").forEach((el) => el.remove()));
};

export const logError = (message: string): void => {
  const appVersion = require("../../package.json").version;
  const messageWithVersion = `${chalk.gray(`[v${appVersion}]`)} ${message}`;
  console.error(messageWithVersion);
};
