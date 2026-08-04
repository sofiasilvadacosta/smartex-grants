import assert from "node:assert/strict";
import { test } from "node:test";
import { activityNumber, eti, sameActivity } from "./timesheet";

test("reads the funder's activity number out of either spelling", () => {
  // Texia's approved lines and the timesheet's own labels.
  assert.equal(activityNumber("1 - Gestão e Planeamento do projeto"), 1);
  assert.equal(activityNumber("2- Análise tecnológica, levantamento de requisitos"), 2);
  // TexQualis's approved lines carry the bare number.
  assert.equal(activityNumber("6"), 6);
  assert.equal(activityNumber(" 3 "), 3);
  assert.equal(activityNumber("Outras atividades"), null);
  assert.equal(activityNumber(""), null);
});

test("matches a timesheet label to a budget line that stores only the number", () => {
  // The case that matters: TexQualis's line "2" and the timesheet's full label.
  assert.ok(sameActivity("2", "2- Análise tecnológica, levantamento de requisitos"));
  assert.ok(sameActivity("1 - Gestão e Planeamento do projeto", "1"));
  assert.ok(!sameActivity("2", "3- Desenvolvimento de Hardware"));
});

test("falls back to exact text when neither label is numbered", () => {
  assert.ok(sameActivity("Outras atividades", " Outras atividades "));
  assert.ok(!sameActivity("Outras atividades", "Gestão"));
});

test("ETI is the fraction of the month's potential hours", () => {
  // Seven's November 2025 on TexQualis: 29 h of a 160 h month.
  assert.equal(eti(29, 160), 0.18125);
  // And the rest of that month, which the form requires to be declared too.
  assert.equal(eti(131, 160), 0.81875);
  assert.equal(eti(29, 160)! + eti(131, 160)!, 1);
  assert.equal(eti(10, 0), null);
});
