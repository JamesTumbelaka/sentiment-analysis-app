import axios from "axios";
import * as dotenv from "dotenv";
dotenv.config();

export const http = axios.create({
  headers: {
    "User-Agent":
      process.env.USER_AGENT ??
      "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120 Safari/537.36",
    Accept: "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8"
  },
  timeout: 30000,
});

export async function getHtml(url: string, attempt = 1): Promise<string> {
  try {
    const res = await http.get<string>(url, { responseType: "text" });
    return res.data;
  } catch (err: any) {
    const status = err?.response?.status;
    if (attempt < 3 && (!status || status >= 500)) {
      const delay = 500 * 2 ** (attempt - 1);
      await new Promise((r) => setTimeout(r, delay));
      return getHtml(url, attempt + 1);
    }
    throw err;
  }
}
