import { existsSync } from "node:fs";
import { prisma } from "../../src/lib/db";
import { readCsv } from "./lib/csv";
import { sourceRowId } from "./lib/workbook";

// Personnel cost declared to the funder, extracted from the payment request's
// "Pessoal" table by scripts/import/extract-pp-pessoas.py.
//
// That table has no activity or "Nº ordem" column — the portal aggregates to
// the approved investment lines elsewhere — so these rows import UNMATCHED and
// are linked to their rubrica through the reconciliation screen. Attempting to
// infer the activity from the free-text description was tested against the
// approved table's per-activity totals and did not reconcile, so it is not
// done here: a wrong rubrica is worse than an unassigned one.
export interface PessoalImportSummary {
  processed: number;
  created: number;
  updated: number;
  total: number;
  personResolved: number;
  personUnresolved: string[];
  byPaymentRequest: Record<string, number>;
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

export async function importPessoalFromPp(
  csvPath: string,
  projectId: string,
): Promise<PessoalImportSummary | null> {
  if (!existsSync(csvPath)) return null;

  const rows = readCsv(csvPath);
  const people = await prisma.person.findMany({ select: { id: true, name: true } });
  const personIdByNameKey = new Map<string, string>();
  for (const person of people) {
    const key = nameKey(person.name);
    if (key && !personIdByNameKey.has(key)) personIdByNameKey.set(key, person.id);
  }

  const summary: PessoalImportSummary = {
    processed: 0,
    created: 0,
    updated: 0,
    total: 0,
    personResolved: 0,
    personUnresolved: [],
    byPaymentRequest: {},
  };
  const unresolved = new Set<string>();

  for (const row of rows) {
    const amount = Number(row.amount);
    if (!row.yearMonth || !Number.isFinite(amount)) continue;

    const displayName = cleanPersonName(row.name);
    const personId = personIdByNameKey.get(nameKey(displayName)) ?? null;
    if (personId) summary.personResolved++;
    else unresolved.add(displayName);

    // The portal's own row id is stable across exports of the same request.
    const rowId = sourceRowId("PP_Pessoal", row.ppNumber, row.sourceId);
    const existing = await prisma.personnelAllocation.findUnique({
      where: { projectId_sourceRowId: { projectId, sourceRowId: rowId } },
      select: { id: true, reconciledAt: true },
    });

    const data = {
      personId,
      rawPersonLabel: row.name,
      category: "Pessoal técnico do beneficiário (a)",
      yearMonth: row.yearMonth,
      eligibleBaseSalary: 0,
      allocationPercent: 0,
      socialSecurityRate: 0,
      eligibleValue: amount,
      ppNumber: row.ppNumber || null,
      obs: row.description || null,
      // Keep the funder's technician index; it identifies which approved staff
      // entry the row belongs to when reconciling.
      rawSourceRef: row.technician ? `Técnico ${row.technician}` : null,
    };

    if (existing) {
      // A human's rubrica decision is never overwritten by a re-import.
      await prisma.personnelAllocation.update({ where: { id: existing.id }, data });
      summary.updated++;
    } else {
      await prisma.personnelAllocation.create({
        data: { projectId, sourceSheet: "PP_Pessoal", sourceRowId: rowId, ...data },
      });
      summary.created++;
    }

    summary.processed++;
    summary.total += amount;
    summary.byPaymentRequest[row.ppNumber] =
      (summary.byPaymentRequest[row.ppNumber] ?? 0) + amount;
  }

  summary.total = Math.round(summary.total * 100) / 100;
  for (const pp of Object.keys(summary.byPaymentRequest)) {
    summary.byPaymentRequest[pp] = Math.round(summary.byPaymentRequest[pp] * 100) / 100;
  }
  summary.personUnresolved = [...unresolved].sort();
  return summary;
}
