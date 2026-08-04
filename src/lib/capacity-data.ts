import { prisma } from "@/lib/db";
import { monthCapacity, type MonthCapacity } from "@/lib/capacity";

/**
 * Loading the inputs the pure functions in capacity.ts need, in a fixed number
 * of queries no matter how many people or months are asked about.
 *
 * The over-allocation question is inherently cross-project — "is this person
 * already promised elsewhere?" — so every screen that asks it needs the same
 * whole-organisation picture. Hence one loader rather than a query per screen.
 */

export function capacityKey(personId: string, yearMonth: string): string {
  return `${personId}|${yearMonth}`;
}

export interface PersonMonth extends MonthCapacity {
  personId: string;
  /** Hours promised, per project id. Empty when the month is unallocated. */
  allocatedByProject: ReadonlyMap<string, number>;
  absenceDays: number;
}

export interface CapacityView {
  /** Keyed by capacityKey(personId, yearMonth). */
  byPersonMonth: Map<string, PersonMonth>;
  /** Months that carry any allocation, absence or capacity row, ascending. */
  months: string[];
  get(personId: string, yearMonth: string): PersonMonth | undefined;
}

export async function loadCapacity(params: {
  personIds?: readonly string[];
  /** Restrict to these months. Omit for every month with any data. */
  months?: readonly string[];
} = {}): Promise<CapacityView> {
  const personFilter =
    params.personIds && params.personIds.length > 0
      ? { personId: { in: [...params.personIds] } }
      : {};
  const monthFilter =
    params.months && params.months.length > 0 ? { yearMonth: { in: [...params.months] } } : {};

  const [calendar, capacities, absences, allocations] = await Promise.all([
    prisma.workCalendar.findMany(),
    prisma.personMonthCapacity.findMany({ where: { ...personFilter, ...monthFilter } }),
    prisma.absence.groupBy({
      by: ["personId", "yearMonth"],
      where: { ...personFilter, ...monthFilter },
      _sum: { days: true },
    }),
    // Never filtered by project: the whole point is to see the hours other
    // projects already hold.
    prisma.projectHoursAllocation.findMany({
      where: { ...personFilter, ...monthFilter },
      select: { personId: true, projectId: true, yearMonth: true, hours: true },
    }),
  ]);

  const calendarHours = new Map(calendar.map((c) => [c.yearMonth, c.availableHours]));
  const capacityRows = new Map(
    capacities.map((c) => [
      capacityKey(c.personId, c.yearMonth),
      {
        productiveHours: Number(c.productiveHours),
        nonProjectHours: c.nonProjectHours === null ? null : Number(c.nonProjectHours),
      },
    ]),
  );
  const absenceDays = new Map(
    absences.map((a) => [capacityKey(a.personId, a.yearMonth), Number(a._sum.days ?? 0)]),
  );

  const allocatedByPersonMonth = new Map<string, Map<string, number>>();
  for (const row of allocations) {
    const key = capacityKey(row.personId, row.yearMonth);
    let byProject = allocatedByPersonMonth.get(key);
    if (!byProject) {
      byProject = new Map();
      allocatedByPersonMonth.set(key, byProject);
    }
    // Additive: the unique key is (person, project, month), so a second row for
    // the same project would be a data error rather than something to overwrite.
    byProject.set(row.projectId, (byProject.get(row.projectId) ?? 0) + Number(row.hours));
  }

  // Every person-month mentioned by any of the three sources, so a month with an
  // absence but no allocation is still visible.
  const keys = new Set<string>([
    ...capacityRows.keys(),
    ...absenceDays.keys(),
    ...allocatedByPersonMonth.keys(),
  ]);

  const byPersonMonth = new Map<string, PersonMonth>();
  const monthSet = new Set<string>();
  for (const key of keys) {
    const [personId, yearMonth] = key.split("|");
    const row = capacityRows.get(key);
    const days = absenceDays.get(key) ?? 0;
    const allocatedByProject = allocatedByPersonMonth.get(key) ?? new Map<string, number>();
    byPersonMonth.set(key, {
      personId,
      absenceDays: days,
      allocatedByProject,
      ...monthCapacity({
        yearMonth,
        calendarHours: calendarHours.get(yearMonth) ?? null,
        productiveHours: row?.productiveHours ?? null,
        nonProjectHours: row?.nonProjectHours ?? null,
        absenceDays: days,
        allocatedByProject,
      }),
    });
    monthSet.add(yearMonth);
  }

  return {
    byPersonMonth,
    months: [...monthSet].sort(),
    get: (personId, yearMonth) => byPersonMonth.get(capacityKey(personId, yearMonth)),
  };
}

/**
 * Months where someone is promised more hours than they have. Sorted by how bad
 * it is, so the worst appears first.
 */
export function overAllocations(view: CapacityView): PersonMonth[] {
  return [...view.byPersonMonth.values()]
    .filter((row) => row.overAllocatedBy > 0)
    .sort((a, b) => b.overAllocatedBy - a.overAllocatedBy);
}
