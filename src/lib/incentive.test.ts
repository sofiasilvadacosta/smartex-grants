import assert from "node:assert/strict";
import { test } from "node:test";
import { incentiveTotals, ratePercent, rateFor } from "./incentive";

test("a line's own rate wins over the project's", () => {
  // Produtech and TexP@ct pay by TRL phase, so the line decides.
  assert.equal(rateFor({ incentiveRate: 0.5 }, 0.75), 0.5);
  assert.equal(rateFor({ incentiveRate: null }, 0.75), 0.75);
  assert.equal(rateFor({ incentiveRate: null }, null), null);
  // A rate of zero is a rate, not a missing value.
  assert.equal(rateFor({ incentiveRate: 0 }, 0.75), 0);
});

test("computes incentive on both the approved budget and what is executed", () => {
  // TexQualis at 70%.
  const totals = incentiveTotals(
    [
      { eligibleCost: 100000, executedAmount: 40000, incentiveRate: null },
      { eligibleCost: 50000, executedAmount: 0, incentiveRate: null },
    ],
    0.7,
  );
  assert.equal(totals.approvedIncentive, 105000);
  assert.equal(totals.executedIncentive, 28000);
  assert.equal(totals.linesWithoutRate, 0);
});

test("mixes per-line rates with the project's", () => {
  // Produtech's TRL split: 75% on 3-4, 50% on 5-9.
  const totals = incentiveTotals(
    [
      { eligibleCost: 971371.29, executedAmount: 0, incentiveRate: 0.75 },
      { eligibleCost: 306589.59, executedAmount: 0, incentiveRate: 0.5 },
    ],
    null,
  );
  assert.equal(totals.approvedIncentive, 881823.26);
});

test("lines with no rate anywhere are counted, never assumed to be zero", () => {
  // Silently treating them as 0% would understate the claim; as 100% would
  // overstate it. Both are wrong, so the caller has to be told.
  const totals = incentiveTotals(
    [
      { eligibleCost: 1000, executedAmount: 500, incentiveRate: 0.5 },
      { eligibleCost: 4000, executedAmount: 2000, incentiveRate: null },
    ],
    null,
  );
  assert.equal(totals.approvedIncentive, 500);
  assert.equal(totals.linesWithoutRate, 1);
  assert.equal(totals.eligibleWithoutRate, 4000);
  assert.equal(totals.ratedEligible, 1000);
});

test("formats a rate the way the funder writes it", () => {
  assert.equal(ratePercent(0.7), "70%");
  assert.equal(ratePercent(0.6425), "64,25%");
  assert.equal(ratePercent(null), "—");
});
