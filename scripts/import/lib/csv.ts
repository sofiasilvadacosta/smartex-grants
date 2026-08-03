import { readFileSync } from "node:fs";

// Minimal RFC4180-style reader: the extracted CSVs contain quoted fields with
// commas and newlines inside descriptions, so splitting on "," is not enough.
export function readCsv(path: string): Record<string, string>[] {
  const text = readFileSync(path, "utf8");
  const rows: string[][] = [];
  let row: string[] = [];
  let field = "";
  let inQuotes = false;

  for (let i = 0; i < text.length; i++) {
    const char = text[i];
    if (inQuotes) {
      if (char === '"') {
        if (text[i + 1] === '"') {
          field += '"';
          i++;
        } else inQuotes = false;
      } else field += char;
      continue;
    }
    if (char === '"') inQuotes = true;
    else if (char === ",") {
      row.push(field);
      field = "";
    } else if (char === "\n") {
      row.push(field);
      rows.push(row);
      row = [];
      field = "";
    } else if (char !== "\r") field += char;
  }
  if (field.length > 0 || row.length > 0) {
    row.push(field);
    rows.push(row);
  }

  const [header, ...body] = rows.filter((r) => r.some((c) => c.trim() !== ""));
  return body.map((cells) =>
    Object.fromEntries(header.map((name, i) => [name, (cells[i] ?? "").trim()])),
  );
}
