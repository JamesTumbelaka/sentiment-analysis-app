import { writeFile, mkdir } from "node:fs/promises";
import { join } from "node:path";

export async function saveJson<T>(rows: T[], filename: string) {
  const dir = "data/out";
  await mkdir(dir, { recursive: true });
  const path = join(dir, filename);
  await writeFile(path, JSON.stringify(rows, null, 2), "utf-8");
  return path;
}

export async function saveCsv<T extends Record<string, any>>(rows: T[], filename: string) {
  const dir = "data/out";
  await mkdir(dir, { recursive: true });
  const path = join(dir, filename);

  if (rows.length === 0) {
    await writeFile(path, "", "utf-8");
    return path;
  }

  const headers = Object.keys(rows[0]);
  const lines = [headers.join(",")].concat(
    rows.map((r) =>
      headers
        .map((h) => csvEscape(r[h]))
        .join(",")
    )
  );

  await writeFile(path, lines.join("\n"), "utf-8");
  return path;
}

function csvEscape(v: any): string {
  const s = String(v ?? "");
  if (/[",\n]/.test(s)) return `"${s.replace(/"/g, '""')}"`;
  return s;
}
