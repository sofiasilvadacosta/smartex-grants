// Whether a person still has room for more project work in a given month.
//
// Everything here is monthly, matching how capacity is imported, how allocation
// is recorded and how the funder wants it declared.
//
// Absences deliberately affect availability only, never the cost formula in
// personnel-cost.ts. The funder's 14/11 rule already prices a year's holiday
// into every month's cost, so subtracting holiday from the cost as well would
// charge for it twice. What holiday does change is how many hours are genuinely
// left to promise a project — which is the over-allocation this module exists to
// catch.

/** A full working day, used to turn absence days into hours. */
export const HOURS_PER_WORKING_DAY = 8;

export interface MonthCapacityInput {
  yearMonth: string;
  /** Hours in the month from the global work calendar. */
  calendarHours?: number | null;
  /** This person's own productive hours for the month, when tracked. */
  productiveHours?: number | null;
  /** Hours reserved for work outside the funded projects. */
  nonProjectHours?: number | null;
  /** Working days absent in the month, from all absence entries together. */
  absenceDays?: number | null;
  /** Hours already promised, per project id. */
  allocatedByProject?: ReadonlyMap<string, number>;
}

export interface MonthCapacity {
  yearMonth: string;
  /** Hours the month would hold with no absence and nothing reserved. */
  baseHours: number;
  absenceHours: number;
  reservedHours: number;
  /** What is left to spread across projects. Never negative. */
  availableHours: number;
  allocatedHours: number;
  /** Negative when over-allocated. */
  freeHours: number;
  /** allocated / available. Null when there is no availability to divide by. */
  utilisation: number | null;
  /** Hours promised beyond what exists. 0 when within capacity. */
  overAllocatedBy: number;
}

export function monthCapacity(input: MonthCapacityInput): MonthCapacity {
  // The person's own tracked hours win over the global calendar: someone
  // part-time or mid-onboarding does not have the standard month.
  const baseHours = input.productiveHours ?? input.calendarHours ?? 0;
  const absenceHours = (input.absenceDays ?? 0) * HOURS_PER_WORKING_DAY;
  const reservedHours = input.nonProjectHours ?? 0;
  const availableHours = Math.max(0, baseHours - absenceHours - reservedHours);

  let allocatedHours = 0;
  if (input.allocatedByProject) {
    for (const hours of input.allocatedByProject.values()) allocatedHours += hours;
  }

  return {
    yearMonth: input.yearMonth,
    baseHours,
    absenceHours,
    reservedHours,
    availableHours,
    allocatedHours,
    freeHours: availableHours - allocatedHours,
    utilisation: availableHours > 0 ? allocatedHours / availableHours : null,
    overAllocatedBy: Math.max(0, allocatedHours - availableHours),
  };
}

/**
 * The month's capacity as it would be if `hours` were promised to `projectId`,
 * replacing whatever that project holds now. Lets a screen show the consequence
 * of an edit before it is saved.
 */
export function capacityWith(
  input: MonthCapacityInput,
  projectId: string,
  hours: number,
): MonthCapacity {
  const next = new Map(input.allocatedByProject ?? []);
  if (hours > 0) next.set(projectId, hours);
  else next.delete(projectId);
  return monthCapacity({ ...input, allocatedByProject: next });
}

/**
 * The imputation percentage a given number of hours represents — the fraction the
 * funder is told, and the fraction personnel cost is multiplied by.
 *
 * The denominator is the month's base hours, not its hours net of absence, for
 * the reason given at the top of this file: holiday is already priced into the
 * monthly cost, so dividing by a holiday-shortened month would inflate the
 * percentage and charge for the same time twice.
 */
export function imputationPercent(hours: number, baseHours: number): number | null {
  if (baseHours <= 0) return null;
  return hours / baseHours;
}

export function percent(value: number | null): string {
  if (value === null) return "—";
  return `${(value * 100).toLocaleString("pt-PT", { maximumFractionDigits: 1 })}%`;
}

export function hours(value: number): string {
  return `${value.toLocaleString("pt-PT", { maximumFractionDigits: 1 })} h`;
}
