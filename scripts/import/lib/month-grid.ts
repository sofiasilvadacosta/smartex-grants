import type ExcelJS from "exceljs";
import { rowValues } from "./workbook";

const MONTHS = ["Jan", "Fev", "Mar", "Abr", "Mai", "Jun", "Jul", "Ago", "Set", "Out", "Nov", "Dez"];

// The Gestão Projetos sheets lay months out horizontally in repeating Jan..Dez
// blocks, with the year written only in the cell above each "Jan". The other
// cells of the year row hold stale junk (e.g. 2011/2012), so the year must be
// carried forward from each January rather than read per column.
export function buildMonthGrid(
  sheet: ExcelJS.Worksheet,
  yearRowNumber: number,
  monthRowNumber: number,
): Map<number, string> {
  const yearRow = rowValues(sheet.getRow(yearRowNumber));
  const monthRow = rowValues(sheet.getRow(monthRowNumber));

  const grid = new Map<number, string>();
  let currentYear: number | null = null;

  for (let col = 1; col < monthRow.length; col++) {
    const raw = monthRow[col];
    const label = raw == null ? "" : String(raw).trim();
    const monthIndex = MONTHS.indexOf(label);
    if (monthIndex === -1) continue;

    if (monthIndex === 0) {
      const year = Number(yearRow[col]);
      if (Number.isFinite(year) && year > 1990 && year < 2100) currentYear = year;
      else if (currentYear !== null) currentYear += 1;
    }
    if (currentYear === null) continue;

    grid.set(col, `${currentYear}-${String(monthIndex + 1).padStart(2, "0")}`);
  }

  return grid;
}

// "09/2022", "9/2022" -> "2022-09". Returns null for anything unparseable.
export function parseMonthYear(value: unknown): string | null {
  if (value == null) return null;
  if (value instanceof Date) {
    return `${value.getFullYear()}-${String(value.getMonth() + 1).padStart(2, "0")}`;
  }
  const match = /^\s*(\d{1,2})\s*\/\s*(\d{4})\s*$/.exec(String(value));
  if (!match) return null;
  const month = Number(match[1]);
  if (month < 1 || month > 12) return null;
  return `${match[2]}-${String(month).padStart(2, "0")}`;
}
