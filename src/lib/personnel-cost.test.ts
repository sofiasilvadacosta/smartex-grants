import assert from "node:assert/strict";
import { test } from "node:test";
import {
  DEFAULT_SOCIAL_SECURITY_RATE,
  fteBasedCost,
  fullMonthlyEligibleCost,
  payInForce,
  salaryBasedCost,
} from "./personnel-cost";

// Rows copied verbatim from the Produtech_RH and Texp@ct_RH sheets of
// Grants_Approved_Execution_v3.xlsx. If the formula ever drifts, these fail.
const FULL_MONTH_ROWS = [
  { monthlyBase: 1392.77, eligibleValue: 2193.61 },
  { monthlyBase: 1638.4, eligibleValue: 2580.48 },
  { monthlyBase: 2374.04, eligibleValue: 3739.11 },
];

const PARTIAL_MONTH_ROWS = [
  { monthlyBase: 2814.66, allocationPercent: 0.75, eligibleValue: 3324.81 },
  { monthlyBase: 3613.61, allocationPercent: 0.75, eligibleValue: 4268.57 },
  { monthlyBase: 1840.99, allocationPercent: 0.95, eligibleValue: 2754.58 },
  { monthlyBase: 1564.97, allocationPercent: 0.3864, eligibleValue: 952.16 },
];

test("matches the sheets to the cent where their inputs are exact", () => {
  // At 100% imputation there is no rounded input to blame, so the formula has to
  // land on the funder's own figure precisely — including how it rounds.
  for (const row of FULL_MONTH_ROWS) {
    const cost = salaryBasedCost({ monthlyBase: row.monthlyBase, allocationPercent: 1 });
    assert.equal(cost.eligibleValue, row.eligibleValue, `RBM ${row.monthlyBase}`);
  }
});

test("matches partial months to within the sheets' own rounding of the percentage", () => {
  // The sheets store the imputation percentage rounded to four decimals while
  // the value beside it was computed from the unrounded fraction, so the two
  // disagree slightly at source. The gap is the *input's*, not the formula's:
  // across all 825 salary-based rows the worst case is 0,68 € on a 4 492 € row,
  // and the relative error never reaches 0,05%.
  for (const row of PARTIAL_MONTH_ROWS) {
    const cost = salaryBasedCost({
      monthlyBase: row.monthlyBase,
      allocationPercent: row.allocationPercent,
    });
    const relativeError = Math.abs(cost.eligibleValue - row.eligibleValue) / row.eligibleValue;
    assert.ok(
      relativeError < 0.0005,
      `RBM ${row.monthlyBase} a ${row.allocationPercent}: folha ${row.eligibleValue}, calculado ${cost.eligibleValue} (erro ${(relativeError * 100).toFixed(3)}%)`,
    );
  }
});

test("the whole multiplier at the standard social security rate is exactly 1,575", () => {
  // 14/11 x 1,2375. Every row in both source sheets uses this.
  assert.equal(fullMonthlyEligibleCost(1000, DEFAULT_SOCIAL_SECURITY_RATE), 1575);
});

test("a different social security rate changes the cost", () => {
  const standard = salaryBasedCost({ monthlyBase: 2000, allocationPercent: 1 });
  const lower = salaryBasedCost({
    monthlyBase: 2000,
    allocationPercent: 1,
    socialSecurityRate: 0.2,
  });
  assert.ok(lower.eligibleValue < standard.eligibleValue);
  assert.equal(lower.socialSecurityRate, 0.2);
});

test("a null social security rate falls back to the standard one", () => {
  const explicit = salaryBasedCost({ monthlyBase: 2000, allocationPercent: 1 });
  const nulled = salaryBasedCost({
    monthlyBase: 2000,
    allocationPercent: 1,
    socialSecurityRate: null,
  });
  assert.equal(nulled.eligibleValue, explicit.eligibleValue);
});

test("FTE-based projects ignore real pay entirely", () => {
  // TexQualis: 4432 € per FTE-month.
  assert.equal(fteBasedCost({ fte: 1, fteRate: 4432 }).eligibleValue, 4432);
  assert.equal(fteBasedCost({ fte: 0.5, fteRate: 4432 }).eligibleValue, 2216);
});

const HISTORY = [
  { effectiveFrom: "2024-02", monthlyBase: 1762.5, grossAnnual: null, socialSecurityRate: null },
  { effectiveFrom: "2022-09", monthlyBase: 1392.77, grossAnnual: null, socialSecurityRate: null },
  { effectiveFrom: "2023-01", monthlyBase: 1638.4, grossAnnual: 42500, socialSecurityRate: null },
];

test("picks the record in force, not the most recent one", () => {
  assert.equal(payInForce(HISTORY, "2023-06")?.monthlyBase, 1638.4);
  assert.equal(payInForce(HISTORY, "2024-02")?.monthlyBase, 1762.5);
  assert.equal(payInForce(HISTORY, "2030-01")?.monthlyBase, 1762.5);
});

test("flags a month that precedes the whole history instead of returning nothing", () => {
  const before = payInForce(HISTORY, "2022-01");
  // Falling back to the oldest record keeps a cost computable, but the caller
  // has to be able to say the number is a guess about the past.
  assert.equal(before?.monthlyBase, 1392.77);
  assert.equal(before?.extrapolated, true);
  assert.equal(payInForce(HISTORY, "2022-09")?.extrapolated, false);
});

test("no records means no pay, not zero pay", () => {
  assert.equal(payInForce([], "2025-01"), null);
});
