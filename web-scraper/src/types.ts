export type SearchResult = {
  title: string;
  url: string;
  snippet?: string;
  source: "google" | "bing" | "duckduckgo";
};

export type PageExtract = {
  url: string;
  title?: string;
  description?: string;
  firstParagraph?: string;
  h1?: string;
  fetchedAt: string; // ISO
  via: "axios" | "playwright";
};

export type CompileRecord = SearchResult & PageExtract;
