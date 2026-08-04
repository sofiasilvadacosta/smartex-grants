import assert from "node:assert/strict";
import { test } from "node:test";
import { capacityWith, imputationPercent, monthCapacity } from "./capacity";

const AUGUST = {
  yearMonth: "2026-08",
  calendarHours: 168,
  allocatedByProject: new Map([
    ["produtech", 80],
    ["texpact", 40],
  ]),
};

test("sums allocation across every project, not just the one being looked at", () => {
  const result = monthCapacity(AUGUST);
  assert.equal(result.allocatedHours, 120);
  assert.equal(result.availableHours, 168);
  assert.equal(result.freeHours, 48);
  assert.equal(result.overAllocatedBy, 0);
});

test("holiday removes hours from what can be promised", () => {
  const result = monthCapacity({ ...AUGUST, absenceDays: 10 });
  assert.equal(result.absenceHours, 80);
  assert.equal(result.availableHours, 88);
  // 120 h were already promised for a month that now holds 88.
  assert.equal(result.freeHours, -32);
  assert.equal(result.overAllocatedBy, 32);
});

test("hours reserved for non-project work are not free either", () => {
  const result = monthCapacity({ ...AUGUST, nonProjectHours: 60 });
  assert.equal(result.availableHours, 108);
  assert.equal(result.overAllocatedBy, 12);
});

test("a person's own tracked hours beat the global calendar", () => {
  const partTime = monthCapacity({ ...AUGUST, productiveHours: 84 });
  assert.equal(partTime.baseHours, 84);
  assert.equal(partTime.overAllocatedBy, 36);
});

test("availability never goes negative even when absence exceeds the month", () => {
  const result = monthCapacity({ ...AUGUST, absenceDays: 30 });
  assert.equal(result.availableHours, 0);
  assert.equal(result.utilisation, null, "no availability means no percentage to report");
});

test("utilisation is the fraction of available hours promised", () => {
  assert.equal(monthCapacity(AUGUST).utilisation, 120 / 168);
});

test("capacityWith replaces one project's hours without touching the others", () => {
  const raised = capacityWith(AUGUST, "produtech", 130);
  assert.equal(raised.allocatedHours, 170);
  assert.equal(raised.overAllocatedBy, 2);

  const removed = capacityWith(AUGUST, "produtech", 0);
  assert.equal(removed.allocatedHours, 40);
  assert.equal(removed.overAllocatedBy, 0);
});

test("capacityWith leaves the caller's map alone", () => {
  const original = new Map([["produtech", 80]]);
  capacityWith({ yearMonth: "2026-08", calendarHours: 168, allocatedByProject: original }, "texpact", 40);
  assert.equal(original.size, 1);
});

test("imputation divides by the month's base hours, not by hours net of holiday", () => {
  // Someone on holiday half the month who still charged 84 h is at 50%, not 100%:
  // the 14/11 rule already prices holiday into the monthly cost.
  assert.equal(imputationPercent(84, 168), 0.5);
  assert.equal(imputationPercent(84, 0), null);
});
