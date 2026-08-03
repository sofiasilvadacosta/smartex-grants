import { prisma } from "./db";

// Checks that should hold for every project once its data is complete. They are
// computed rather than stored so they can never go stale, and they exist
// because each one caught a real problem in the imported data: a whole budget
// line lost to a mis-detected header row, invoices filed on a neighbouring
// rubrica because the right one was full, execution sitting in the database
// with no rubrica at all.
export interface ProjectDataQuality {
  projectId: string;
  // Execution rows still waiting for a rubrica, and how much they carry.
  pendingRows: number;
  pendingAmount: number;
  // Rubricas whose execution exceeds the approved amount.
  overBudgetLines: number;
  overBudgetAmount: number;
  // Rubricas where the execution here differs from the figure declared to the
  // funder (only projects with an imported official figure).
  divergentLines: number;
  // A project with execution but no budget can't be reconciled at all.
  hasBudget: boolean;
  hasExecution: boolean;
  // Invoices that repeat another row exactly (same document, supplier, date and
  // amount). The working spreadsheets re-enter a row when a request is cut and
  // re-submitted, which counts the cost twice.
  duplicateInvoices: number;
  duplicateAmount: number;
}

export async function projectDataQuality(): Promise<Map<string, ProjectDataQuality>> {
  const [lines, invoices, allocations] = await Promise.all([
    prisma.budgetLine.groupBy({
      by: ["projectId"],
      _count: { _all: true },
      _sum: { eligibleCost: true },
    }),
    prisma.invoice.groupBy({
      by: ["projectId", "matchStatus"],
      _count: { _all: true },
      _sum: { eligibleAmount: true },
    }),
    prisma.personnelAllocation.groupBy({
      by: ["projectId", "matchStatus"],
      _count: { _all: true },
      _sum: { eligibleValue: true },
    }),
  ]);

  // Per-line comparisons can't be expressed as a groupBy, so count them in SQL
  // rather than pulling every budget line into memory.
  const perLine = await prisma.$queryRaw<
    { projectId: string; overCount: bigint; overAmount: string; divergentCount: bigint }[]
  >`
    SELECT "projectId",
           COUNT(*) FILTER (WHERE "executedAmount" > "eligibleCost" + 0.01) AS "overCount",
           COALESCE(SUM("executedAmount" - "eligibleCost")
                    FILTER (WHERE "executedAmount" > "eligibleCost" + 0.01), 0)::text AS "overAmount",
           COUNT(*) FILTER (
             WHERE "declaredExecuted" IS NOT NULL
               AND ABS("executedAmount" - "declaredExecuted") > 0.01
           ) AS "divergentCount"
    FROM "BudgetLine"
    GROUP BY "projectId"
  `;

  // Same document, supplier, date and amount is a repeat of the same cost.
  // Matching on the document number alone would flag genuinely different
  // invoices that happen to share a number, which does occur here.
  const duplicates = await prisma.$queryRaw<
    { projectId: string; extraRows: bigint; extraAmount: string }[]
  >`
    SELECT "projectId",
           SUM(n - 1) AS "extraRows",
           SUM((n - 1) * "eligibleAmount")::text AS "extraAmount"
    FROM (
      SELECT "projectId", "eligibleAmount", COUNT(*) AS n
      FROM "Invoice"
      WHERE "docNumber" IS NOT NULL
      GROUP BY "projectId", "docNumber", "supplierName", "docDate", "eligibleAmount"
      HAVING COUNT(*) > 1
    ) repeated
    GROUP BY "projectId"
  `;

  const result = new Map<string, ProjectDataQuality>();
  const ensure = (projectId: string): ProjectDataQuality => {
    let entry = result.get(projectId);
    if (!entry) {
      entry = {
        projectId,
        pendingRows: 0,
        pendingAmount: 0,
        overBudgetLines: 0,
        overBudgetAmount: 0,
        divergentLines: 0,
        hasBudget: false,
        hasExecution: false,
        duplicateInvoices: 0,
        duplicateAmount: 0,
      };
      result.set(projectId, entry);
    }
    return entry;
  };

  for (const row of lines) {
    ensure(row.projectId).hasBudget = row._count._all > 0 && Number(row._sum.eligibleCost ?? 0) > 0;
  }
  for (const row of invoices) {
    const entry = ensure(row.projectId);
    entry.hasExecution = true;
    if (row.matchStatus === "UNMATCHED" || row.matchStatus === "AMBIGUOUS") {
      entry.pendingRows += row._count._all;
      entry.pendingAmount += Number(row._sum.eligibleAmount ?? 0);
    }
  }
  for (const row of allocations) {
    const entry = ensure(row.projectId);
    entry.hasExecution = true;
    if (row.matchStatus === "UNMATCHED" || row.matchStatus === "AMBIGUOUS") {
      entry.pendingRows += row._count._all;
      entry.pendingAmount += Number(row._sum.eligibleValue ?? 0);
    }
  }
  for (const row of perLine) {
    const entry = ensure(row.projectId);
    entry.overBudgetLines = Number(row.overCount);
    entry.overBudgetAmount = Number(row.overAmount);
    entry.divergentLines = Number(row.divergentCount);
  }

  for (const row of duplicates) {
    const entry = ensure(row.projectId);
    entry.duplicateInvoices = Number(row.extraRows);
    entry.duplicateAmount = Number(row.extraAmount);
  }

  return result;
}
