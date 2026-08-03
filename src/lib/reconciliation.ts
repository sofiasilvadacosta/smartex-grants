import { prisma } from "@/lib/db";
import { Prisma } from "@/generated/prisma/client";

// Score weights for the allocation-suggestion algorithm (see plan §"Motor de
// sugestão de alocação"). Kept as named constants so the breakdown returned
// to callers/UI stays explainable.
const WEIGHT_CATEGORY = 0.5;
const WEIGHT_MARGIN = 0.3;
const WEIGHT_ORDER_BONUS = 0.2;
const MIN_SCORE = 30;
const MAX_CANDIDATES = 5;
// Two candidates are only "ambiguous" if they're this close — otherwise the
// top-scoring one is treated as a confident single match.
const AMBIGUITY_GAP = 15;

export interface ParsedSourceRef {
  orderNumber?: string;
  fundingType?: string;
  trlPhase?: string;
  category?: string;
}

// Two source formats carry the funder's line reference:
//   "304 / IDT / Investigação industrial (TRL 3-4) / Custos com matérias primas"
//     — the "/"-joined compound key used by the Produtech/TexP@ct sheets
//   "11 - Créditos AWS"
//     — the "Nº ordem - Designação" pair used by the newer PP sheets
// Both start with the order number, which is the part that matters most.
export function parseSourceRef(raw: string | null | undefined): ParsedSourceRef {
  if (!raw) return {};
  const leadingNumber = /^\s*(\d+)\s*[-/]/.exec(raw)?.[1];

  const parts = raw
    .split("/")
    .map((s) => s.trim())
    .filter(Boolean);
  // Only a "/"-joined string carries the funding-type / TRL / category parts.
  if (parts.length > 1) {
    const [orderNumber, fundingType, trlPhase, category] = parts;
    return { orderNumber: leadingNumber ?? orderNumber, fundingType, trlPhase, category };
  }
  return { orderNumber: leadingNumber };
}

export interface MatchCandidate {
  budgetLineId: string;
  category: string;
  trlPhase: string;
  // The funder's "Nº ordem", "" when the project's budget isn't numbered.
  // Several lines of a project can share a category and year, so this is often
  // the only thing that tells two candidates apart on screen.
  orderNumber: string;
  remainingMargin: number;
  score: number;
  breakdown: { categoryScore: number; marginScore: number; orderBonus: number };
}

interface CandidateRow {
  id: string;
  category: string;
  trlPhase: string;
  orderNumber: string;
  eligibleCost: string;
  executedAmount: string;
  sim: number;
}

export async function findBudgetLineCandidates(params: {
  projectId: string;
  rawCategory: string;
  rawSourceRef?: string | null;
  amount: number;
}): Promise<MatchCandidate[]> {
  const { projectId, rawCategory, rawSourceRef, amount } = params;
  const parsed = parseSourceRef(rawSourceRef);

  // When both sides carry the funder's "Nº ordem" the link is known exactly,
  // so skip the scoring entirely — text similarity can only make it worse.
  const orderNumber = parsed.orderNumber;
  if (orderNumber && /^\d+$/.test(orderNumber)) {
    const exact = await prisma.budgetLine.findFirst({
      where: { projectId, orderNumber },
      select: {
        id: true,
        category: true,
        trlPhase: true,
        orderNumber: true,
        eligibleCost: true,
        executedAmount: true,
      },
    });
    if (exact) {
      return [
        {
          budgetLineId: exact.id,
          category: exact.category,
          trlPhase: exact.trlPhase,
          orderNumber: exact.orderNumber,
          remainingMargin: Number(exact.eligibleCost) - Number(exact.executedAmount),
          score: 100,
          breakdown: { categoryScore: 100, marginScore: 100, orderBonus: 100 },
        },
      ];
    }
  }
  // rawCategory (the invoice's own "Tipo" field) uses the same short rubrica
  // vocabulary as BudgetLine.category. The parsed source-ref's trailing
  // segment is a longer free-text description from a *different* column in
  // the source sheet (the _Approved sheet's "Investimento" description) and
  // matches poorly against it — only fall back to it when rawCategory is
  // missing entirely.
  const searchText = rawCategory || parsed.category || "";

  // A "Tipo" that *is* the name of exactly one rubrica is the source stating
  // the rubrica, not a hint to be weighed. Scoring it against the others lets
  // remaining margin overrule it: once the right rubrica is full, a
  // near-identical name that still has room outscores it (e.g. "Subcontratação
  // 3-4" full, so its invoices land on "Subcontratação 5-9"). Exceeding an
  // approved rubrica is a real fact the project page already flags in red —
  // hiding it by filing the cost elsewhere is worse than showing it.
  const exactByName = await prisma.budgetLine.findMany({
    where: { projectId, category: { equals: searchText.trim(), mode: "insensitive" } },
    select: {
      id: true,
      category: true,
      trlPhase: true,
      orderNumber: true,
      eligibleCost: true,
      executedAmount: true,
    },
  });
  // Two rubricas sharing a name (same category, different TRL phase) are
  // genuinely ambiguous on the name alone — fall through to scoring.
  if (searchText.trim() && exactByName.length === 1) {
    const line = exactByName[0];
    const remainingMargin = Number(line.eligibleCost) - Number(line.executedAmount);
    return [
      {
        budgetLineId: line.id,
        category: line.category,
        trlPhase: line.trlPhase,
        orderNumber: line.orderNumber,
        remainingMargin,
        score: 100,
        breakdown: { categoryScore: 100, marginScore: remainingMargin >= amount ? 100 : 0, orderBonus: 0 },
      },
    ];
  }

  const rows = await prisma.$queryRaw<CandidateRow[]>`
    SELECT id, category, "trlPhase", "orderNumber", "eligibleCost"::text, "executedAmount"::text,
           similarity(category, ${searchText}) as sim
    FROM "BudgetLine"
    WHERE "projectId" = ${projectId}
  `;

  const candidates: MatchCandidate[] = rows.map((row) => {
    const eligibleCost = Number(row.eligibleCost);
    const executedAmount = Number(row.executedAmount);
    const remainingMargin = eligibleCost - executedAmount;

    // An exact (case/whitespace-insensitive) match always wins outright.
    // Trigram similarity alone conflates near-duplicate rubrica names that
    // differ only by a TRL-phase suffix (e.g. "Subcontratação 3-4" vs
    // "Subcontratação 5-9" score ~0.7 against each other) — dampening the
    // fuzzy ceiling keeps a real exact match clear of the ambiguity gap.
    const isExactMatch = row.category.trim().toLowerCase() === searchText.trim().toLowerCase();
    const categoryScore = isExactMatch ? 100 : row.sim * 100 * 0.8;
    const marginScore =
      remainingMargin <= 0 ? 0 : remainingMargin >= amount ? 100 : (remainingMargin / amount) * 100;
    const orderBonus = parsed.trlPhase && row.trlPhase && parsed.trlPhase === row.trlPhase ? 100 : 0;

    const score =
      categoryScore * WEIGHT_CATEGORY + marginScore * WEIGHT_MARGIN + orderBonus * WEIGHT_ORDER_BONUS;

    return {
      budgetLineId: row.id,
      category: row.category,
      trlPhase: row.trlPhase,
      orderNumber: row.orderNumber,
      remainingMargin,
      score: Math.round(score * 100) / 100,
      breakdown: { categoryScore, marginScore, orderBonus },
    };
  });

  return candidates
    .filter((c) => c.score >= MIN_SCORE)
    .sort((a, b) => b.score - a.score)
    .slice(0, MAX_CANDIDATES);
}

export type MatchResolution =
  | { status: "MATCHED"; best: MatchCandidate }
  | { status: "AMBIGUOUS"; candidates: MatchCandidate[] }
  | { status: "UNMATCHED" };

export function resolveMatchStatus(candidates: MatchCandidate[]): MatchResolution {
  if (candidates.length === 0) return { status: "UNMATCHED" };
  const [best, second] = candidates;
  if (candidates.length === 1 || best.score - (second?.score ?? 0) >= AMBIGUITY_GAP) {
    return { status: "MATCHED", best };
  }
  return { status: "AMBIGUOUS", candidates };
}

// Recomputes and persists BudgetLine.executedAmount from every kind of linked
// execution row — invoices AND personnel-cost imputations. Call inside the same
// transaction as any change to a row's budgetLineId or amount so the cache
// never drifts from reality.
export async function recomputeBudgetLineExecuted(
  tx: Parameters<Parameters<typeof prisma.$transaction>[0]>[0] | typeof prisma,
  budgetLineId: string,
) {
  const [invoices, allocations] = await Promise.all([
    tx.invoice.aggregate({ where: { budgetLineId }, _sum: { eligibleAmount: true } }),
    tx.personnelAllocation.aggregate({ where: { budgetLineId }, _sum: { eligibleValue: true } }),
  ]);
  const total = new Prisma.Decimal(invoices._sum.eligibleAmount ?? 0).plus(
    allocations._sum.eligibleValue ?? 0,
  );
  await tx.budgetLine.update({
    where: { id: budgetLineId },
    data: { executedAmount: total },
  });
}
