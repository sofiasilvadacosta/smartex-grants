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

/** Accent-insensitive, order-insensitive comparison of two ways of writing a name. */
function sameName(a: string, b: string): boolean {
  const words = (text: string) =>
    normalize(text)
      .split(" ")
      .filter((word) => word.length > 1 && !NAME_NOISE.has(word));
  const left = words(a);
  const right = words(b);
  if (left.length === 0 || right.length === 0) return false;
  const [shorter, longer] = left.length <= right.length ? [left, right] : [right, left];
  return shorter.every((word) => longer.includes(word));
}

function normalize(text: string): string {
  return text
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .trim();
}

/**
 * How well two ways of naming a role agree: 3 identical, 2 the same words spelled
 * differently ("Gestor de Projecto" against "Gestor de Projeto"), 1 one contained
 * in the other ("Mechanical Engineering" inside "Especialista em Mechanical
 * Engineering"), 0 unrelated. Only the best level found is used, so a weaker
 * agreement never competes with a stronger one.
 */
function match(label: string, want: string): number {
  const left = normalize(label);
  const right = normalize(want);
  if (!left || !right) return 0;
  if (left === right) return 3;
  if (editDistance(left, right) <= 2) return 2;
  const words = (text: string) => text.split(" ").filter((word) => word.length > 1);
  const wanted = words(right);
  const present = words(left);
  if (wanted.length > 0 && wanted.every((word) => present.includes(word))) return 1;
  return 0;
}

/** Levenshtein distance, bounded: only small edits are of interest here. */
function editDistance(a: string, b: string): number {
  if (Math.abs(a.length - b.length) > 2) return 99;
  let previous = Array.from({ length: b.length + 1 }, (_, i) => i);
  for (let i = 1; i <= a.length; i++) {
    const current = [i];
    for (let j = 1; j <= b.length; j++) {
      current[j] = Math.min(
        previous[j] + 1,
        current[j - 1] + 1,
        previous[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1),
      );
    }
    previous = current;
  }
  return previous[b.length];
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
    // Each approved line, split into the two things that identify it: the role
    // Smartex calls it (the part of the category after the name it is prefixed
    // with) and the funder's own job title.
    //
    // The name in that prefix is who the *application* said would do the work.
    // People change, so it is not what identifies a line — it is only ever used
    // to separate two lines the role has already selected.
    const linesByActivity = new Map<
      number,
      { id: string; role: string; external: string; name: string }[]
    >();
    for (const line of budgetLines) {
      const number = activityNumber(line.activity);
      if (number === null) continue;
      const comma = line.category.indexOf(",");
      const list = linesByActivity.get(number) ?? [];
      list.push({
        id: line.id,
        role: (comma >= 0 ? line.category.slice(comma + 1) : line.category).trim(),
        external: (line.externalProfile ?? "").trim(),
        name: comma >= 0 ? line.category.slice(0, comma).trim() : "",
      });
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
        const candidates = linesByActivity.get(number);
        if (!candidates) return undefined;

        const profiles = profilesByPerson.get(personId);
        const profile =
          profileFor.get(`${personId}|${number}`) ??
          // Someone planned under a single profile throughout can be resolved
          // even on an activity the plan does not list them on.
          (profiles?.size === 1 ? [...profiles][0] : undefined);
        if (profile === undefined) return undefined;

        // The plan writes a profile as "<role> / <funder title>" when it knows
        // both. That pair is what separates two lines sharing a role: TexQualis
        // activity 2 has "Desenvolvimento de hardware" twice, and only the funder
        // title tells the two apart.
        const [rolePart, externalPart] = profile.includes("/")
          ? profile.split("/").map((part) => part.trim())
          : [profile.trim(), undefined];

        const score = (line: (typeof candidates)[number]): number =>
          externalPart === undefined
            ? Math.max(match(line.role, rolePart), match(line.external, rolePart))
            : Math.min(match(line.role, rolePart), match(line.external, externalPart));

        const scored = candidates.map((line) => ({ line, score: score(line) }));
        const best = Math.max(0, ...scored.map((entry) => entry.score));
        if (best === 0) return undefined;
        const winners = scored.filter((entry) => entry.score === best).map((entry) => entry.line);
        const ids = new Set(winners.map((line) => line.id));
        if (ids.size === 1) return [...ids][0];

        // Still tied: the name the category is prefixed with breaks it, but only
        // among lines the role has already selected. A line is never chosen on a
        // name alone — those names are who the application said would do the
        // work, and people change.
        const named = winners.filter((line) => sameName(line.name, entry.name));
        return named.length === 1 ? named[0].id : undefined;
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
          // Equal shares of one month produce equal amounts, and equal amounts
          // are interchangeable: whichever way round they go, each activity ends
          // up with the same euros. The pairing within such a group is arbitrary
          // and the result is not. Only a group whose amounts actually differ is
          // a real ambiguity, and only that is held back.
          const values = group.map((index) => costParts[index].item.value);
          const identical = values.every((value) => Math.abs(value - values[0]) <= 0.01);
          if (!identical) {
            stats.ambiguousTies.push(
              `${label}: ${group.length} partes com proporções iguais ` +
                `(${group.map((i) => (hourParts[i].share * 100).toFixed(1) + "%").join("/")}) ` +
                `mas valores diferentes (${values.map((v) => v.toFixed(2)).join("/")} €) — ` +
                `não se sabe qual é qual`,
            );
            continue;
          }
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
