import ExcelJS from "exceljs";
import { createHash } from "node:crypto";

export async function loadWorkbook(path: string): Promise<ExcelJS.Workbook> {
  const workbook = new ExcelJS.Workbook();
  await workbook.xlsx.readFile(path);
  return workbook;
}

export function getSheet(workbook: ExcelJS.Workbook, name: string): ExcelJS.Worksheet {
  const sheet = workbook.getWorksheet(name);
  if (!sheet) throw new Error(`Sheet "${name}" not found in workbook`);
  return sheet;
}

// Row.values is 1-indexed (index 0 is unused); this returns the same
// 1-indexed shape so callers can use header column numbers directly.
export function rowValues(row: ExcelJS.Row): unknown[] {
  const values = row.values;
  return Array.isArray(values) ? values : [];
}

// exceljs returns cell values as plain scalars, or as objects for hyperlinks
// ({text}), formulas ({result}), rich text ({richText:[{text}]}) and errors
// ({error}). Without unwrapping all of them, String() yields "[object Object]"
// and that string ends up stored as real data.
export function cellText(value: unknown): string {
  if (value == null) return "";
  if (typeof value !== "object") return String(value).trim();
  // These sheets contain formula cells that evaluate to an invalid Date, so
  // guard before formatting — toISOString() throws on those.
  if (value instanceof Date) {
    return Number.isNaN(value.getTime()) ? "" : value.toISOString();
  }

  const obj = value as Record<string, unknown>;
  if (Array.isArray(obj.richText)) {
    return (obj.richText as { text?: unknown }[])
      .map((part) => String(part?.text ?? ""))
      .join("")
      .trim();
  }
  if ("text" in obj) return String(obj.text ?? "").trim();
  if ("result" in obj) return cellText(obj.result);
  if ("error" in obj) return "";
  return "";
}

// The header row in these source sheets is rarely row 1 — titles and blank
// spacer rows usually come first — so it has to be found rather than assumed.
// Counts only cells that look like a *label*: non-empty and not a number or a
// date. Counting filled cells instead loses data — a budget row carrying more
// computed columns than the header has labels then wins, is treated as the
// header, and every row above the first data row is silently skipped.
function labelCellCount(row: ExcelJS.Row): number {
  return rowValues(row).filter((value) => {
    if (value instanceof Date) return false;
    if (typeof value === "number") return false;
    const text = cellText(value);
    if (text.length === 0) return false;
    return !Number.isFinite(Number(text.replace(",", ".")));
  }).length;
}

// Ties go to the earliest row: a header sits above its data, so when two rows
// look equally label-like the first one is the header.
export function findHeaderRow(sheet: ExcelJS.Worksheet, maxScan = 6): number {
  let bestRow = 1;
  let bestCount = -1;
  for (let r = 1; r <= Math.min(maxScan, sheet.rowCount); r++) {
    const count = labelCellCount(sheet.getRow(r));
    if (count > bestCount) {
      bestCount = count;
      bestRow = r;
    }
  }
  return bestRow;
}

// Source headers vary in case and embedded newlines across near-identical
// sheets (e.g. "Tipo" vs "TIPO", "Nº ordem\n(mapa investim)" vs "Nº ordem
// (mapa investim)") — normalize before comparing so lookups aren't brittle.
export function normalizeHeader(text: string): string {
  return text.toLowerCase().replace(/\s+/g, " ").trim();
}

// Name -> first-occurrence 1-indexed column number. Only safe for sheets
// where duplicate header names are redundant repeats, not distinct groups
// (see scripts/import/family-b.ts for sheets where that assumption breaks).
export function buildHeaderIndex(sheet: ExcelJS.Worksheet, headerRow: number): Map<string, number> {
  const values = rowValues(sheet.getRow(headerRow));
  const index = new Map<string, number>();
  values.forEach((value, col) => {
    const text = normalizeHeader(cellText(value));
    if (text && !index.has(text)) {
      index.set(text, col);
    }
  });
  return index;
}

// True only when every cell in the row is empty. Used to detect the boundary
// between stacked tables in one sheet — a partially-filled row (e.g. a section
// label in the first columns) is NOT a boundary and must not stop the read.
export function isRowEmpty(row: ExcelJS.Row): boolean {
  return rowValues(row).every((value) => cellText(value).length === 0);
}

export function cellAt(row: ExcelJS.Row, col: number | undefined): unknown {
  if (!col) return undefined;
  return row.getCell(col).value;
}

export function asString(value: unknown): string | null {
  const text = cellText(value);
  return text.length > 0 ? text : null;
}

export function asNumber(value: unknown): number | null {
  if (value == null || value === "") return null;
  // Number(new Date()) is a valid timestamp, which would silently turn a date
  // cell into a nonsense amount — reject dates explicitly.
  if (value instanceof Date) return null;
  if (typeof value === "object" && "result" in (value as Record<string, unknown>)) {
    return asNumber((value as { result: unknown }).result);
  }
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

export function asDate(value: unknown): Date | null {
  if (value == null || value === "") return null;
  // An Invalid Date reaching Prisma fails the write, so filter it out here.
  if (value instanceof Date) return Number.isNaN(value.getTime()) ? null : value;
  if (typeof value === "object" && "result" in (value as Record<string, unknown>)) {
    return asDate((value as { result: unknown }).result);
  }
  const parsed = new Date(String(value));
  return Number.isNaN(parsed.getTime()) ? null : parsed;
}

export function asBoolFromSN(value: unknown): boolean | null {
  const text = asString(value)?.toLowerCase();
  if (!text) return null;
  if (text === "sim" || text === "s" || text === "yes" || text === "y") return true;
  if (text === "não" || text === "nao" || text === "n" || text === "no") return false;
  return null;
}

// Stable per-row id for idempotent re-import: a short hash of the row's
// natural-key fields (sheet + whatever combination of source columns is
// stable across re-exports of that sheet).
export function sourceRowId(...parts: (string | number | null | undefined)[]): string {
  const key = parts.map((p) => (p == null ? "" : String(p))).join("|");
  return createHash("sha1").update(key).digest("hex").slice(0, 24);
}
