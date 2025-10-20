export function trimTo(s: string | undefined, n = 300): string | undefined {
  if (!s) return s;
  const t = s.replace(/\s+/g, " ").trim();
  return t.length > n ? t.slice(0, n - 1) + "…" : t;
}

export function nowIso(): string {
  return new Date().toISOString();
}

export async function sleep(ms: number) {
  return new Promise((r) => setTimeout(r, ms));
}
