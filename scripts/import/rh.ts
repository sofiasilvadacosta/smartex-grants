import { prisma } from "../../src/lib/db";
import {
  loadWorkbook,
  getSheet,
  findHeaderRow,
  asString,
  asNumber,
  asBoolFromSN,
  sourceRowId,
} from "./lib/workbook";
import { parseMonthYear } from "./lib/month-grid";
import {
  findBudgetLineCandidates,
  resolveMatchStatus,
  recomputeBudgetLineExecuted,
} from "../../src/lib/reconciliation";
import { Prisma } from "../../src/generated/prisma/client";

// The *_RH sheets are positionally identical across projects even though the
// first three header names differ ("Nº ordem (mapa investim)"/"Técnico" in
// Produtech vs "TIPO"/"Vencimento" in TexP@ct), so read by column position:
// 1 category, 2 source ref, 3 person, 4 month/year, 5 base salary,
// 6 % imputation, 7 social-security rate, 8 eligible value, 9 PP, 10 S/N,
// 11 obs, 12 certified eligible.
const COL = {
  category: 1,
  rawSourceRef: 2,
  person: 3,
  monthYear: 4,
  baseSalary: 5,
  allocationPercent: 6,
  socialSecurityRate: 7,
  eligibleValue: 8,
  ppNumber: 9,
  certified: 10,
  obs: 11,
} as const;

const SHEETS = [
  { sheetName: "Produtech_RH", projectCode: "PRODUTECH" },
  { sheetName: "Texp@ct_RH", projectCode: "TEXPACT" },
];

export interface RhCounters {
  processed: number;
  matched: number;
  unmatched: number;
  ambiguous: number;
  personResolved: number;
  personUnresolved: number;
}

// Source person labels are prefixed with an ordinal, e.g.
// "1 - Diogo Afonso Correia Remião".
function stripPersonPrefix(label: string): string {
  return label.replace(/^\s*\d+\s*-\s*/, "").trim();
}

// Person names in the RH sheets are full legal names while DADOS often holds a
// shortened form ("Ana M. Marques" vs "Ana Carolina Barbosa Martins Marques"),
// so match on first + last name token rather than the whole string.
function nameKey(name: string): string {
  const parts = name
    .toLowerCase()
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .split(/\s+/)
    .filter(Boolean);
  if (parts.length === 0) return "";
  return `${parts[0]}|${parts[parts.length - 1]}`;
}

export async function importRhSheets(
  workbookPath: string,
  projectIdByCode: Record<string, string>,
): Promise<Record<string, RhCounters>> {
  const workbook = await loadWorkbook(workbookPath);

  const people = await prisma.person.findMany({ select: { id: true, name: true } });
  const personIdByNameKey = new Map<string, string>();
  for (const p of people) {
    const key = nameKey(p.name);
    // First writer wins; ambiguous keys (two people sharing first+last name)
    // stay pointed at one of them rather than silently flip-flopping per row.
    if (key && !personIdByNameKey.has(key)) personIdByNameKey.set(key, p.id);
  }

  const summary: Record<string, RhCounters> = {};

  for (const { sheetName, projectCode } of SHEETS) {
    const projectId = projectIdByCode[projectCode];
    if (!projectId) continue;

    const sheet = getSheet(workbook, sheetName);
    const headerRow = findHeaderRow(sheet, 3);
    const counters: RhCounters = {
      processed: 0,
      matched: 0,
      unmatched: 0,
      ambiguous: 0,
      personResolved: 0,
      personUnresolved: 0,
    };

    for (let r = headerRow + 1; r <= sheet.rowCount; r++) {
      const row = sheet.getRow(r);
      const rawPersonLabel = asString(row.getCell(COL.person).value);
      const eligibleValue = asNumber(row.getCell(COL.eligibleValue).value);
      const yearMonth = parseMonthYear(row.getCell(COL.monthYear).value);
      if (!rawPersonLabel || eligibleValue == null || !yearMonth) continue;

      const category = asString(row.getCell(COL.category).value) ?? "RH";
      const rawSourceRef = asString(row.getCell(COL.rawSourceRef).value);
      const personName = stripPersonPrefix(rawPersonLabel);
      const personId = personIdByNameKey.get(nameKey(personName)) ?? null;
      if (personId) counters.personResolved++;
      else counters.personUnresolved++;

      const rowId = sourceRowId(sheetName, rawPersonLabel, yearMonth, category, eligibleValue);
      counters.processed++;

      const existing = await prisma.personnelAllocation.findUnique({
        where: { projectId_sourceRowId: { projectId, sourceRowId: rowId } },
        select: { id: true, reconciledAt: true, budgetLineId: true },
      });

      const rawFields = {
        rawPersonLabel,
        personId,
        category,
        yearMonth,
        eligibleBaseSalary: asNumber(row.getCell(COL.baseSalary).value) ?? 0,
        allocationPercent: asNumber(row.getCell(COL.allocationPercent).value) ?? 0,
        socialSecurityRate: asNumber(row.getCell(COL.socialSecurityRate).value) ?? 0,
        eligibleValue,
        ppNumber: asString(row.getCell(COL.ppNumber).value),
        certifiedEligible: asBoolFromSN(row.getCell(COL.certified).value),
        obs: asString(row.getCell(COL.obs).value),
        rawSourceRef,
      };

      if (existing?.reconciledAt) {
        await prisma.personnelAllocation.update({ where: { id: existing.id }, data: rawFields });
        if (existing.budgetLineId) {
          counters.matched++;
          await prisma.$transaction(async (tx) => {
            await recomputeBudgetLineExecuted(tx, existing.budgetLineId!);
          });
        }
        continue;
      }

      const candidates = await findBudgetLineCandidates({
        projectId,
        rawCategory: category,
        rawSourceRef,
        amount: eligibleValue,
      });
      const resolution = resolveMatchStatus(candidates);

      const matchFields =
        resolution.status === "MATCHED"
          ? {
              budgetLineId: resolution.best.budgetLineId,
              matchStatus: "MATCHED" as const,
              matchMethod: "SUGGESTED" as const,
              matchConfidence: resolution.best.score,
              matchCandidates: candidates as unknown as Prisma.InputJsonValue,
            }
          : resolution.status === "AMBIGUOUS"
            ? {
                budgetLineId: null,
                matchStatus: "AMBIGUOUS" as const,
                matchMethod: null,
                matchConfidence: null,
                matchCandidates: candidates as unknown as Prisma.InputJsonValue,
              }
            : {
                budgetLineId: null,
                matchStatus: "UNMATCHED" as const,
                matchMethod: null,
                matchConfidence: null,
                matchCandidates: Prisma.JsonNull,
              };

      if (resolution.status === "MATCHED") counters.matched++;
      else if (resolution.status === "AMBIGUOUS") counters.ambiguous++;
      else counters.unmatched++;

      const previousBudgetLineId = existing?.budgetLineId ?? null;
      const nextBudgetLineId = resolution.status === "MATCHED" ? resolution.best.budgetLineId : null;

      await prisma.$transaction(async (tx) => {
        if (existing) {
          await tx.personnelAllocation.update({
            where: { id: existing.id },
            data: { ...rawFields, ...matchFields, sourceSheet: sheetName },
          });
        } else {
          await tx.personnelAllocation.create({
            data: {
              projectId,
              sourceSheet: sheetName,
              sourceRowId: rowId,
              ...rawFields,
              ...matchFields,
            },
          });
        }
        for (const id of new Set(
          [previousBudgetLineId, nextBudgetLineId].filter(Boolean) as string[],
        )) {
          await recomputeBudgetLineExecuted(tx, id);
        }
      });
    }

    summary[projectCode] = counters;
  }

  return summary;
}
