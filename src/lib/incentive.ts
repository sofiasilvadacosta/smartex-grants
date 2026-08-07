// What the funder pays, as opposed to what may be spent.
//
// Eligible cost is only half of a payment request: the money that arrives is
// eligible cost times the incentive rate. Most projects have one rate; Produtech
// and TexP@ct pay a different share by TRL phase, so a line may carry its own and
// it wins over the project's.

export interface RatedLine {
  eligibleCost: unknown;
  executedAmount: unknown;
  incentiveRate: unknown;
}

function toNumber(value: unknown): number {
  const n = Number(value ?? 0);
  return Number.isFinite(n) ? n : 0;
}

function optionalNumber(value: unknown): number | null {
  if (value === null || value === undefined) return null;
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

/** The rate in force for a line: its own, else the project's, else none. */
export function rateFor(line: { incentiveRate: unknown }, projectRate: unknown): number | null {
  return optionalNumber(line.incentiveRate) ?? optionalNumber(projectRate);
}

export interface IncentiveTotals {
  /** Incentive on the whole approved budget. */
  approvedIncentive: number;
  /** Incentive on what has been executed so far — what is claimable today. */
  executedIncentive: number;
  /** Approved eligible cost on lines that have a rate at all. */
  ratedEligible: number;
  /** Lines with no rate anywhere: their incentive cannot be computed. */
  linesWithoutRate: number;
  /** Approved eligible cost sitting on those lines. */
  eligibleWithoutRate: number;
}

export function incentiveTotals(
  lines: readonly RatedLine[],
  projectRate: unknown,
): IncentiveTotals {
  const totals: IncentiveTotals = {
    approvedIncentive: 0,
    executedIncentive: 0,
    ratedEligible: 0,
    linesWithoutRate: 0,
    eligibleWithoutRate: 0,
  };

  for (const line of lines) {
    const rate = rateFor(line, projectRate);
    const eligible = toNumber(line.eligibleCost);
    if (rate === null) {
      totals.linesWithoutRate++;
      totals.eligibleWithoutRate += eligible;
      continue;
    }
    totals.ratedEligible += eligible;
    totals.approvedIncentive += eligible * rate;
    totals.executedIncentive += toNumber(line.executedAmount) * rate;
  }

  const round = (value: number) => Math.round(value * 100) / 100;
  totals.approvedIncentive = round(totals.approvedIncentive);
  totals.executedIncentive = round(totals.executedIncentive);
  totals.ratedEligible = round(totals.ratedEligible);
  totals.eligibleWithoutRate = round(totals.eligibleWithoutRate);
  return totals;
}

export function ratePercent(rate: number | null): string {
  if (rate === null) return "—";
  return `${(rate * 100).toLocaleString("pt-PT", { maximumFractionDigits: 2 })}%`;
}
