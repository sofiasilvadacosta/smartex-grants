import { prisma } from "../../src/lib/db";
import { recomputeBudgetLineExecuted } from "../../src/lib/reconciliation";
import { activityNumber } from "../../src/lib/timesheet";

/**
 * Attaches the personnel rows of an FTE-priced project to their budget lines,
 * using the funder's own timesheet to say which activity each row is.
 *
 * The payment-request form already splits a person's month into one row per
 * activity — it simply does not name the activity. The Mapa de horas/ETI splits
 * the same month into hours per activity. Both are the same division of the same
 * month, so the rows can be paired by size:
 *
 *   António Rocha, 2025-11
 *     form:      831,00   277,00   1108,00      (three rows, no activity)
 *     timesheet:  30 h     10 h      40 h       (three activities, 80 h)
 *     shares:      0,375    0,125     0,5   ->  identical on both sides
 *
 * Pairing on proportion rather than on an absolute euro figure is deliberate: the
 * two sides disagree about how many working hours a month holds (the planning
 * workbook's calendar and the timesheets' own row of working days differ in
 * several months), and every such disagreement cancels out of a ratio. The
 * reconciliation therefore does not depend on which of them is right.
 *
 * Nothing is paired unless the whole month agrees: same number of parts, and
 * every part in the same proportion. A month where the two sides disagree is
 * left pending and reported, because a mis-paired row puts real money on the
 * wrong approved line.
 */

/** Two shares count as the same when they differ by less than this. */
const SHARE_TOLERANCE = 0.005;
/** Below this share a part is too small for proportions to separate reliably. */
const MIN_SHARE = 0.001;

export interface TimesheetReconciliationSummary {
  byProject: Record<
    string,
    {
      monthsPaired: number;
      rowsMatched: number;
      valueMatched: number;
      /** Person-months the timesheet says nothing about. */
      monthsWithoutTimesheet: number;
      /** Pairs the two sides split into a different number of parts. */
      partCountMismatch: string[];
      /** Pairs whose parts are not in the same proportion. */
      shapeMismatch: string[];
      /** Pairs with two equal parts, where which is which cannot be told. */
      ambiguousTies: string[];
      /** Activities with no approved line for that person's profile. */
      noBudgetLine: string[];
    }
  >;
}

interface Part<T> {
  item: T;
  share: number;
}

const NAME_NOISE = new Set(["de", "da", "do", "dos", "das", "e"]);

/** Accent- and order-insensitive comparison of two ways of writing a name. */
function sameName(a: string, b: string): boolean {
  const words = (text: string) =>
    text
      .normalize("NFD")
      .replace(/[̀-ͯ]/g, "")
      .toLowerCase()
      .split(/[^a-z0-9]+/)
      .filter((word) => word.length > 1 && !NAME_NOISE.has(word));
  const left = words(a);
  const right = words(b);
  if (left.length === 0 || right.length === 0) return false;
  // Every word of the shorter name has to appear in the longer one, so
  // "Antonio Rocha" reaches "António Rocha" but not "Ana Rocha".
  const [shorter, longer] = left.length <= right.length ? [left, right] : [right, left];
  return shorter.every((word) => longer.includes(word));
}

function shares<T>(items: T[], size: (item: T) => number): Part<T>[] | null {
  const total = items.reduce((sum, item) => sum + size(item), 0);
  if (total <= 0) return null;
  return items
    .map((item) => ({ item, share: size(item) / total }))
    .sort((a, b) => b.share - a.share);
}

export async function reconcileFromTimesheets(): Promise<TimesheetReconciliationSummary> {
  const projects = await prisma.project.findMany({
    where: { fteRate: { not: null }, status: { not: "EXCLUDED" } },
    select: { id: true, code: true },
  });

  const summary: TimesheetReconciliationSummary = { byProject: {} };

  for (const project of projects) {
    const stats = {
      monthsPaired: 0,
      rowsMatched: 0,
      valueMatched: 0,
      monthsWithoutTimesheet: 0,
      partCountMismatch: [] as string[],
      shapeMismatch: [] as string[],
      ambiguousTies: [] as string[],
      noBudgetLine: [] as string[],
    };

    // A row somebody reconciled by hand is never re-decided here.
    const allocations = await prisma.personnelAllocation.findMany({
      where: { projectId: project.id, personId: { not: null }, reconciledAt: null },
      select: {
        id: true,
        personId: true,
        yearMonth: true,
        eligibleValue: true,
        person: { select: { name: true } },
      },
    });
    const timesheet = await prisma.projectHoursAllocation.findMany({
      where: { projectId: project.id, activity: { not: "" } },
      select: { personId: true, yearMonth: true, activity: true, hours: true },
    });

    const byKey = new Map<
      string,
      { name: string; rows: { id: string; value: number }[]; hours: { activity: string; hours: number }[] }
    >();
    for (const row of allocations) {
      const key = `${row.personId}|${row.yearMonth}`;
      const entry = byKey.get(key) ?? { name: row.person!.name, rows: [], hours: [] };
      entry.rows.push({ id: row.id, value: Number(row.eligibleValue) });
      byKey.set(key, entry);
    }
    for (const row of timesheet) {
      const key = `${row.personId}|${row.yearMonth}`;
      const entry = byKey.get(key);
      // Timesheet hours with no cost row are not an error: the form is filled in
      // for months the payment request has not reached yet.
      if (!entry) continue;
      entry.hours.push({ activity: row.activity, hours: Number(row.hours) });
    }

    // Approved lines by activity number and profile — the two things that
    // identify a line on an FTE-priced project.
    //
    // Keyed on externalProfile, the funder's job title ("Coordenador(a) I&D"),
    // because that is what the staffing plan carries. BudgetLine.category holds
    // Smartex's own name for the same profile ("Project Manager"), which the plan
    // never uses; it is indexed too so a project that only has the internal name
    // still resolves.
    const budgetLines = await prisma.budgetLine.findMany({
      where: { projectId: project.id },
      select: { id: true, activity: true, category: true, externalProfile: true },
    });
    const lineByActivityProfile = new Map<string, string>();
    // Some projects name the person in the line itself ("Antonio Rocha,
    // Desenvolvimento de hardware"), which identifies it more precisely than any
    // profile does. Indexed separately and tried first.
    const linesByActivity = new Map<number, { id: string; namePart: string }[]>();
    for (const line of budgetLines) {
      const number = activityNumber(line.activity);
      if (number === null) continue;
      for (const name of [line.externalProfile, line.category]) {
        if (!name) continue;
        const key = `${number}|${name.trim().toLowerCase()}`;
        if (!lineByActivityProfile.has(key)) lineByActivityProfile.set(key, line.id);
      }
      const list = linesByActivity.get(number) ?? [];
      list.push({ id: line.id, namePart: line.category.split(",")[0] });
      linesByActivity.set(number, list);
    }

    // Each person's profile per activity, from the approved staffing plan.
    const plan = await prisma.plannedAssignment.findMany({
      where: { projectId: project.id, personId: { not: null } },
      select: { personId: true, activity: true, profile: true },
    });
    const profileFor = new Map<string, string>();
    for (const entry of plan) {
      const number = activityNumber(entry.activity);
      if (number === null) continue;
      profileFor.set(`${entry.personId}|${number}`, entry.profile);
    }
    // A person planned under one profile throughout can be resolved even for an
    // activity the plan does not list them on.
    const profilesByPerson = new Map<string, Set<string>>();
    for (const entry of plan) {
      const set = profilesByPerson.get(entry.personId!) ?? new Set<string>();
      set.add(entry.profile);
      profilesByPerson.set(entry.personId!, set);
    }

    const touched = new Set<string>();

    for (const [key, entry] of byKey) {
      const [personId, yearMonth] = key.split("|");
      const label = `${entry.name} ${yearMonth}`;

      if (entry.hours.length === 0) {
        stats.monthsWithoutTimesheet++;
        continue;
      }
      if (entry.hours.length !== entry.rows.length) {
        stats.partCountMismatch.push(
          `${label}: ${entry.rows.length} linha(s) no pedido de pagamento vs ` +
            `${entry.hours.length} atividade(s) no mapa de horas`,
        );
        continue;
      }

      const costParts = shares(entry.rows, (r) => r.value);
      const hourParts = shares(entry.hours, (h) => h.hours);
      if (!costParts || !hourParts) {
        stats.shapeMismatch.push(`${label}: um dos lados soma zero`);
        continue;
      }

      const off = costParts.findIndex(
        (part, index) => Math.abs(part.share - hourParts[index].share) > SHARE_TOLERANCE,
      );
      if (off >= 0) {
        stats.shapeMismatch.push(
          `${label}: proporções diferentes — pedido ${costParts
            .map((p) => (p.share * 100).toFixed(1) + "%")
            .join("/")} vs mapa ${hourParts.map((p) => (p.share * 100).toFixed(1) + "%").join("/")}`,
        );
        continue;
      }

      const lineFor = (activity: string): string | undefined => {
        const number = activityNumber(activity);
        if (number === null) return undefined;

        // The person's own line, where the project names people in its budget.
        // Preferred over any profile: it is the funder approving this person for
        // this activity, not a category they happen to fall into.
        const named = (linesByActivity.get(number) ?? []).filter((line) =>
          sameName(line.namePart, entry.name),
        );
        if (named.length === 1) return named[0].id;

        const profiles = profilesByPerson.get(personId);
        const profile =
          profileFor.get(`${personId}|${number}`) ??
          // Someone planned under a single profile throughout can be resolved
          // even on an activity the plan does not list them on.
          (profiles?.size === 1 ? [...profiles][0] : undefined);
        if (profile === undefined) return undefined;
        return lineByActivityProfile.get(`${number}|${profile.trim().toLowerCase()}`);
      };

      // Parts of equal size cannot be told apart by proportion. Rather than drop
      // the whole month, only the tied ones are held back — and not even those
      // when every activity in the tie leads to the same approved line, since the
      // amounts are equal and the outcome is then identical either way.
      const groups: number[][] = [];
      for (let index = 0; index < hourParts.length; index++) {
        const previous = groups.at(-1);
        const tiedWithPrevious =
          previous !== undefined &&
          (Math.abs(hourParts[index].share - hourParts[previous.at(-1)!].share) <=
            SHARE_TOLERANCE ||
            hourParts[index].share < MIN_SHARE);
        if (tiedWithPrevious) previous.push(index);
        else groups.push([index]);
      }

      const pairs: { allocationId: string; budgetLineId: string; value: number }[] = [];
      for (const group of groups) {
        const lines = group.map((index) => lineFor(hourParts[index].item.activity));
        const missing = group.findIndex((_, i) => lines[i] === undefined);
        if (missing >= 0) {
          const activity = hourParts[group[missing]].item.activity;
          const number = activityNumber(activity);
          const profile = number === null ? undefined : profileFor.get(`${personId}|${number}`);
          stats.noBudgetLine.push(
            `${label}: atividade "${activity}"` +
              `${profile ? ` / perfil "${profile}"` : " sem perfil no plano"} sem rubrica aprovada`,
          );
          continue;
        }
        if (group.length > 1 && new Set(lines).size > 1) {
          stats.ambiguousTies.push(
            `${label}: ${group.length} partes iguais ` +
              `(${group.map((i) => (hourParts[i].share * 100).toFixed(1) + "%").join("/")}) ` +
              `em atividades diferentes — não se sabe qual é qual`,
          );
          continue;
        }
        for (const index of group) {
          pairs.push({
            allocationId: costParts[index].item.id,
            budgetLineId: lines[group.indexOf(index)]!,
            value: costParts[index].item.value,
          });
        }
      }
      if (pairs.length === 0) continue;

      for (const pair of pairs) {
        await prisma.personnelAllocation.update({
          where: { id: pair.allocationId },
          data: {
            budgetLineId: pair.budgetLineId,
            matchStatus: "MATCHED",
            matchMethod: "SUGGESTED",
            matchConfidence: 95,
            matchCandidates: undefined,
          },
        });
        touched.add(pair.budgetLineId);
        stats.rowsMatched++;
        stats.valueMatched += pair.value;
      }
      stats.monthsPaired++;
    }

    if (touched.size > 0) {
      await prisma.$transaction(async (tx) => {
        for (const id of touched) await recomputeBudgetLineExecuted(tx, id);
      });
    }

    stats.valueMatched = Math.round(stats.valueMatched * 100) / 100;
    summary.byProject[project.code] = stats;
  }

  return summary;
}
