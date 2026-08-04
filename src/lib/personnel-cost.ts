// How a month of someone's time becomes an amount the funder will accept.
//
// The formula was not invented here: it was recovered from the "Valor Elegível"
// column of the Produtech and TexP@ct RH sheets, which store it as a number with
// no formula attached. It reproduces 794 of those 825 rows to the cent; the 31
// that differ are off by at most 0,68 € because the sheet stores the imputation
// percentage rounded to four decimals, not because the rule differs.
//
//   valor elegível = RBM x (14 / 11) x (1 + taxa SS) x % imputação
//
// 14/11 is the funder's convention: fourteen months of pay (twelve salaries plus
// the holiday and Christmas subsidies) charged over the eleven months a person
// actually works. Applied to a rate of 23,75% the whole multiplier is exactly
// 1,575, which is what every row in both sheets uses.

/** Months of pay in a year: 12 salaries + holiday and Christmas subsidies. */
export const MONTHS_PAID = 14;
/** Months worked in a year — one month is holiday. */
export const PRODUCTIVE_MONTHS = 11;
/** Employer social security rate used by every row in the source sheets. */
export const DEFAULT_SOCIAL_SECURITY_RATE = 0.2375;

/**
 * Full monthly cost of one person at 100% imputation. This is the ceiling any
 * single month of their time can be charged at, across all projects together.
 */
export function fullMonthlyEligibleCost(
  monthlyBase: number,
  socialSecurityRate = DEFAULT_SOCIAL_SECURITY_RATE,
): number {
  return (monthlyBase * MONTHS_PAID * (1 + socialSecurityRate)) / PRODUCTIVE_MONTHS;
}

export interface SalaryBasedCost {
  kind: "SALARY";
  /** Rounded to cents, as the funder's own sheets record it. */
  eligibleValue: number;
  fullMonthlyCost: number;
  monthlyBase: number;
  socialSecurityRate: number;
  allocationPercent: number;
}

export interface FteBasedCost {
  kind: "FTE";
  eligibleValue: number;
  fte: number;
  fteRate: number;
}

export type EligibleCost = SalaryBasedCost | FteBasedCost;

function round2(value: number): number {
  return Math.round(value * 100) / 100;
}

/**
 * Cost of a salary-based month. `allocationPercent` is a fraction (0.75, not 75).
 */
export function salaryBasedCost(params: {
  monthlyBase: number;
  allocationPercent: number;
  socialSecurityRate?: number | null;
}): SalaryBasedCost {
  const socialSecurityRate = params.socialSecurityRate ?? DEFAULT_SOCIAL_SECURITY_RATE;
  const fullMonthlyCost = fullMonthlyEligibleCost(params.monthlyBase, socialSecurityRate);
  return {
    kind: "SALARY",
    eligibleValue: round2(fullMonthlyCost * params.allocationPercent),
    fullMonthlyCost: round2(fullMonthlyCost),
    monthlyBase: params.monthlyBase,
    socialSecurityRate,
    allocationPercent: params.allocationPercent,
  };
}

/**
 * Cost on a project the funder budgets per FTE at a fixed rate (Texia, TexQualis)
 * rather than from real salaries. Nobody's actual pay enters this figure.
 */
export function fteBasedCost(params: { fte: number; fteRate: number }): FteBasedCost {
  return {
    kind: "FTE",
    eligibleValue: round2(params.fte * params.fteRate),
    fte: params.fte,
    fteRate: params.fteRate,
  };
}

export interface SalaryRecordLike {
  effectiveFrom: string;
  monthlyBase: unknown;
  grossAnnual: unknown;
  socialSecurityRate: unknown;
}

export interface PayInForce {
  effectiveFrom: string;
  monthlyBase: number | null;
  grossAnnual: number | null;
  socialSecurityRate: number | null;
  /**
   * True when the month asked about precedes every record we hold, so the oldest
   * record was used instead. The number is then a guess about the past and is
   * labelled as such wherever it is shown.
   */
  extrapolated: boolean;
}

function toNumber(value: unknown): number | null {
  if (value === null || value === undefined) return null;
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

/**
 * The pay record in force in `yearMonth`: the latest one starting on or before
 * it. `records` may be in any order.
 */
export function payInForce(
  records: readonly SalaryRecordLike[],
  yearMonth: string,
): PayInForce | null {
  if (records.length === 0) return null;
  const sorted = [...records].sort((a, b) => a.effectiveFrom.localeCompare(b.effectiveFrom));
  let chosen: SalaryRecordLike | undefined;
  for (const record of sorted) {
    if (record.effectiveFrom <= yearMonth) chosen = record;
    else break;
  }
  const extrapolated = chosen === undefined;
  const used = chosen ?? sorted[0];
  return {
    effectiveFrom: used.effectiveFrom,
    monthlyBase: toNumber(used.monthlyBase),
    grossAnnual: toNumber(used.grossAnnual),
    socialSecurityRate: toNumber(used.socialSecurityRate),
    extrapolated,
  };
}
