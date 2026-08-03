import { existsSync } from "node:fs";
import { Prisma } from "../../src/generated/prisma/client";
import { prisma } from "../../src/lib/db";
import { readCsv } from "./lib/csv";
import { sourceRowId } from "./lib/workbook";
import { readMovementActivities } from "./lib/pessoal-atividades";
import { recomputeBudgetLineExecuted, type MatchCandidate } from "../../src/lib/reconciliation";

// Personnel cost declared to the funder, extracted from the payment request's
// "Pessoal" table by scripts/import/extract-pp-pessoas.py.
//
// That table carries no activity, so on its own every row imports UNMATCHED.
// The companion file read by readMovementActivities supplies the activity per
// movement id, which is enough to reach the right rubrica family: an activity
// with a single approved personnel line is linked outright, one the funder
// split across several annual lines is left AMBIGUOUS with those lines as
// candidates. Inferring the line from the free-text description was tried and
// rejected — it does not reconcile per activity, and a wrong rubrica is worse
// than an unassigned one.
export interface PessoalImportSummary {
  processed: number;
  created: number;
  updated: number;
  total: number;
  personResolved: number;
  personUnresolved: string[];
  byPaymentRequest: Record<string, number>;
  // Rows whose activity is known from the companion file.
  withActivity: number;
  // Linked outright because the activity has exactly one approved line.
  linkedToSingleLine: number;
  // Activity known but split across several annual lines — needs a human.
  ambiguousWithinActivity: number;
  byActivity: Record<string, number>;
  // Activities present in the execution rows with no approved personnel line.
  activitiesWithoutBudgetLine: string[];
}

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

// Portal names carry a validity period, e.g.
// "Adriana Vinagre (Outubro 2024 a Junho 2025)" or "Pedro Tavares_v2".
function cleanPersonName(raw: string): string {
  return raw
    .replace(/\s*\(.*$/, "")
    .replace(/_v\d+\s*$/i, "")
    .trim();
}

const PERSONNEL_CATEGORY = "Pessoal técnico do beneficiário (a)";

interface ActivityLine {
  id: string;
  category: string;
  trlPhase: string;
  orderNumber: string;
  eligibleCost: number;
  executedAmount: number;
}

// Mirrors findBudgetLineCandidates' weighting so a score means the same thing
// wherever it is shown. The rubrica family is certain (the activity plus the
// official personnel classification), the annual line is not — hence no order
// bonus, and a ceiling of 80 that says plainly a human still has to choose.
function candidatesFor(lines: ActivityLine[], amount: number): MatchCandidate[] {
  return lines
    .map((line) => {
      const remainingMargin = line.eligibleCost - line.executedAmount;
      const marginScore =
        remainingMargin <= 0
          ? 0
          : remainingMargin >= amount
            ? 100
            : (remainingMargin / amount) * 100;
      return {
        budgetLineId: line.id,
        category: line.category,
        trlPhase: line.trlPhase,
        orderNumber: line.orderNumber,
        remainingMargin,
        score: Math.round((100 * 0.5 + marginScore * 0.3) * 100) / 100,
        breakdown: { categoryScore: 100, marginScore, orderBonus: 0 },
      };
    })
    .sort((a, b) => b.score - a.score);
}

export async function importPessoalFromPp(
  csvPath: string,
  activitiesPath: string,
  projectId: string,
): Promise<PessoalImportSummary | null> {
  if (!existsSync(csvPath)) return null;

  const rows = readCsv(csvPath);
  const activities = readMovementActivities(activitiesPath);

  const people = await prisma.person.findMany({ select: { id: true, name: true } });
  const personIdByNameKey = new Map<string, string>();
  for (const person of people) {
    const key = nameKey(person.name);
    if (key && !personIdByNameKey.has(key)) personIdByNameKey.set(key, person.id);
  }

  // Approved personnel lines grouped by activity; several per activity means
  // the funder split that activity into annual tranches.
  const linesByActivity = new Map<string, ActivityLine[]>();
  if (activities) {
    const budgetLines = await prisma.budgetLine.findMany({
      where: { projectId, category: PERSONNEL_CATEGORY, activity: { not: "" } },
      select: {
        id: true,
        activity: true,
        category: true,
        trlPhase: true,
        orderNumber: true,
        eligibleCost: true,
        executedAmount: true,
      },
      orderBy: { orderNumber: "asc" },
    });
    for (const line of budgetLines) {
      const list = linesByActivity.get(line.activity) ?? [];
      list.push({
        id: line.id,
        category: line.category,
        trlPhase: line.trlPhase,
        orderNumber: line.orderNumber,
        eligibleCost: Number(line.eligibleCost),
        executedAmount: Number(line.executedAmount),
      });
      linesByActivity.set(line.activity, list);
    }
  }

  const summary: PessoalImportSummary = {
    processed: 0,
    created: 0,
    updated: 0,
    total: 0,
    personResolved: 0,
    personUnresolved: [],
    byPaymentRequest: {},
    withActivity: 0,
    linkedToSingleLine: 0,
    ambiguousWithinActivity: 0,
    byActivity: {},
    activitiesWithoutBudgetLine: [],
  };
  const unresolved = new Set<string>();
  const activitiesMissingLine = new Set<string>();
  const touched = new Set<string>();

  for (const row of rows) {
    const amount = Number(row.amount);
    if (!row.yearMonth || !Number.isFinite(amount)) continue;

    const displayName = cleanPersonName(row.name);
    const personId = personIdByNameKey.get(nameKey(displayName)) ?? null;
    if (personId) summary.personResolved++;
    else unresolved.add(displayName);

    const movement = activities?.get(row.sourceId);
    // The activity file is a transcription of the portal screens. If a movement
    // there disagrees with the export on month or amount the two are out of
    // sync, and taking the activity from it would be guesswork.
    if (
      movement &&
      (movement.yearMonth !== row.yearMonth || Math.abs(movement.amount - amount) > 0.005)
    ) {
      throw new Error(
        `Movimento ${row.sourceId}: ${activitiesPath} diz ${movement.yearMonth} / ` +
          `${movement.amount.toFixed(2)} €, o export do portal diz ${row.yearMonth} / ` +
          `${amount.toFixed(2)} €. Ficheiros dessincronizados.`,
      );
    }
    const activity = movement?.activity;
    const activityLines = activity ? (linesByActivity.get(activity) ?? []) : [];
    if (activity) {
      summary.withActivity++;
      summary.byActivity[activity] = (summary.byActivity[activity] ?? 0) + amount;
      if (activityLines.length === 0) activitiesMissingLine.add(activity);
    }

    // The portal's own row id is stable across exports of the same request.
    const rowId = sourceRowId("PP_Pessoal", row.ppNumber, row.sourceId);
    const existing = await prisma.personnelAllocation.findUnique({
      where: { projectId_sourceRowId: { projectId, sourceRowId: rowId } },
      select: { id: true, reconciledAt: true, budgetLineId: true },
    });

    let budgetLineId: string | null = null;
    let matchStatus: "MATCHED" | "AMBIGUOUS" | "UNMATCHED" = "UNMATCHED";
    let matchMethod: "SUGGESTED" | null = null;
    let matchConfidence: number | null = null;
    let matchCandidates: Prisma.InputJsonValue | typeof Prisma.DbNull = Prisma.DbNull;

    if (activityLines.length === 1) {
      budgetLineId = activityLines[0].id;
      matchStatus = "MATCHED";
      matchMethod = "SUGGESTED";
      matchConfidence = 100;
      summary.linkedToSingleLine++;
    } else if (activityLines.length > 1) {
      matchStatus = "AMBIGUOUS";
      matchCandidates = candidatesFor(
        activityLines,
        amount,
      ) as unknown as Prisma.InputJsonValue;
      summary.ambiguousWithinActivity++;
    }

    const data = {
      personId,
      rawPersonLabel: row.name,
      category: PERSONNEL_CATEGORY,
      yearMonth: row.yearMonth,
      eligibleBaseSalary: 0,
      allocationPercent: 0,
      socialSecurityRate: 0,
      eligibleValue: amount,
      ppNumber: row.ppNumber || null,
      obs: row.description || null,
      // Keep the funder's own coordinates for the row: the activity it was
      // imputed to and the technician entry it belongs to.
      rawSourceRef:
        [
          activity ? `Atividade ${activity}` : null,
          row.technician ? `Técnico ${row.technician}` : null,
        ]
          .filter(Boolean)
          .join(" / ") || null,
    };

    // A rubrica a human already confirmed is never overwritten by a re-import.
    const matchFields = existing?.reconciledAt
      ? {}
      : { budgetLineId, matchStatus, matchMethod, matchConfidence, matchCandidates };

    if (existing) {
      await prisma.personnelAllocation.update({
        where: { id: existing.id },
        data: { ...data, ...matchFields },
      });
      if (existing.budgetLineId) touched.add(existing.budgetLineId);
      summary.updated++;
    } else {
      await prisma.personnelAllocation.create({
        data: { projectId, sourceSheet: "PP_Pessoal", sourceRowId: rowId, ...data, ...matchFields },
      });
      summary.created++;
    }
    if (budgetLineId) touched.add(budgetLineId);

    summary.processed++;
    summary.total += amount;
    summary.byPaymentRequest[row.ppNumber] =
      (summary.byPaymentRequest[row.ppNumber] ?? 0) + amount;
  }

  await prisma.$transaction(async (tx) => {
    for (const id of touched) await recomputeBudgetLineExecuted(tx, id);
  });

  summary.total = Math.round(summary.total * 100) / 100;
  for (const pp of Object.keys(summary.byPaymentRequest)) {
    summary.byPaymentRequest[pp] = Math.round(summary.byPaymentRequest[pp] * 100) / 100;
  }
  for (const act of Object.keys(summary.byActivity)) {
    summary.byActivity[act] = Math.round(summary.byActivity[act] * 100) / 100;
  }
  summary.personUnresolved = [...unresolved].sort();
  summary.activitiesWithoutBudgetLine = [...activitiesMissingLine].sort();
  return summary;
}
