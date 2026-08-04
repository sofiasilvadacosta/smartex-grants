import { prisma } from "@/lib/db";
import { HOURS_PER_WORKING_DAY, imputationPercent } from "@/lib/capacity";
import { loadCapacity } from "@/lib/capacity-data";

// The funder's "Mapa de horas/ETI" (COMPETE2030), rebuilt from what the platform
// already holds rather than kept as a second copy of it.
//
// Its structure, and the rules that come with it:
//
//   J  jornada diária — 8 h. Under the unit-cost-per-ETI method a part-timer
//      still counts a full-time day; only the real-cost method adjusts J to the
//      contract, which no one here is on yet.
//   N  working days in the month, excluding weekends and public holidays.
//   Horas trabalháveis potenciais = J x N.
//   ETI imputado = hours / potential hours.
//
// And the constraint the form states in its own header: "O total da repartição
// terá de ser sempre igual às horas trabalháveis potenciais" — projects plus
// other activities plus absences must equal the month exactly. An under-filled
// month is a rejected form, which is why timesheetBalance reports both
// directions.

export const MONTHS_IN_YEAR = 12;

/**
 * The activity's number in the funder's numbering ("2- Análise tecnológica..."
 * -> 2), or null when the label has none.
 *
 * This is how a timesheet line finds its budget line: TexQualis's approved lines
 * carry the bare number and Texia's the full name, so neither text matches the
 * other and only the number is common to both.
 */
export function activityNumber(label: string): number | null {
  const match = /^\s*(\d+)/.exec(label);
  if (!match) return null;
  const value = Number(match[1]);
  return Number.isInteger(value) ? value : null;
}

/** True when two activity labels refer to the same activity. */
export function sameActivity(a: string, b: string): boolean {
  if (a.trim() === b.trim()) return true;
  const left = activityNumber(a);
  const right = activityNumber(b);
  return left !== null && left === right;
}

export interface TimesheetMonth {
  yearMonth: string;
  /** N — working days, derived from the month's hours at J h/day. */
  workingDays: number | null;
  /**
   * J x N, from the company work calendar.
   *
   * Deliberately the calendar's full month rather than the person's own tracked
   * hours. The form declares absences on their own line, so a denominator already
   * net of them would subtract the same time twice; and the calendar is the figure
   * the funder checks the ETI against.
   */
  baseHours: number;
  /**
   * The person's own productive hours for the month when the planning sheet
   * tracks something different from the calendar — a part month after joining,
   * for instance. Not used as the ETI denominator; surfaced because a real
   * difference means the form's N may need to be reduced for this technician.
   */
  ownCapacityHours: number | null;
  absenceHours: number;
  /** Hours on all funded projects together. */
  projectHours: number;
  /** "Outras atividades" — work outside the funded projects. */
  otherHours: number;
  /** Projects + other, without absence: the form's "Tempo Trabalho". */
  workedHours: number;
  /** Projects + other + absence: the form's "Tempo Trabalho + Ausências". */
  accountedHours: number;
  /** Must be 0 for the form to be accepted. */
  unaccountedHours: number;
  /** Hours beyond the month. Also must be 0. */
  excessHours: number;
}

export interface TimesheetActivityRow {
  activity: string;
  /** One entry per month, in the same order as `months`. */
  hours: number[];
}

export interface TimesheetProjectBlock {
  projectId: string;
  code: string;
  name: string;
  /** The funding programme, as the form's PROGRAMA column. */
  fundingProgram: string | null;
  rows: TimesheetActivityRow[];
  /** Activities approved for the project that the year has no hours on yet. */
  unusedActivities: string[];
  totals: number[];
}

export interface Timesheet {
  personId: string;
  personName: string;
  year: number;
  months: TimesheetMonth[];
  projects: TimesheetProjectBlock[];
  /** True when every month adds up exactly, so the form can be submitted. */
  balanced: boolean;
}

export function eti(hours: number, baseHours: number): number | null {
  return imputationPercent(hours, baseHours);
}

function monthsOf(year: number): string[] {
  return Array.from({ length: MONTHS_IN_YEAR }, (_, index) =>
    `${year}-${String(index + 1).padStart(2, "0")}`,
  );
}

export async function loadTimesheet(personId: string, year: number): Promise<Timesheet | null> {
  const months = monthsOf(year);

  const person = await prisma.person.findUnique({
    where: { id: personId },
    select: { id: true, name: true },
  });
  if (!person) return null;

  const [capacity, allocations, projects] = await Promise.all([
    loadCapacity({ personIds: [personId], months }),
    prisma.projectHoursAllocation.findMany({
      where: { personId, yearMonth: { in: months } },
      select: { projectId: true, yearMonth: true, activity: true, hours: true },
    }),
    prisma.project.findMany({
      where: { status: { not: "EXCLUDED" } },
      select: {
        id: true,
        code: true,
        name: true,
        fundingProgram: true,
        budgetLines: { select: { activity: true } },
      },
      orderBy: { name: "asc" },
    }),
  ]);

  // A month with no capacity row still has the global calendar behind it, and
  // the form needs all twelve columns whether or not anything was booked.
  const calendar = new Map(
    (await prisma.workCalendar.findMany({ where: { yearMonth: { in: months } } })).map((c) => [
      c.yearMonth,
      c.availableHours,
    ]),
  );

  const monthIndex = new Map(months.map((m, index) => [m, index]));

  // projectId -> activity label -> hours per month
  const byProject = new Map<string, Map<string, number[]>>();
  for (const row of allocations) {
    const index = monthIndex.get(row.yearMonth);
    if (index === undefined) continue;
    let activities = byProject.get(row.projectId);
    if (!activities) {
      activities = new Map();
      byProject.set(row.projectId, activities);
    }
    let hours = activities.get(row.activity);
    if (!hours) {
      hours = new Array<number>(MONTHS_IN_YEAR).fill(0);
      activities.set(row.activity, hours);
    }
    hours[index] += Number(row.hours);
  }

  const monthRows: TimesheetMonth[] = months.map((yearMonth, index) => {
    const loaded = capacity.get(personId, yearMonth);
    const calendarHours = calendar.get(yearMonth) ?? 0;
    const baseHours = calendarHours || loaded?.baseHours || 0;
    const ownCapacityHours =
      loaded && calendarHours > 0 && loaded.baseHours !== calendarHours ? loaded.baseHours : null;
    const absenceHours = loaded?.absenceHours ?? 0;
    const otherHours = loaded?.reservedHours ?? 0;
    let projectHours = 0;
    for (const activities of byProject.values()) {
      for (const hours of activities.values()) projectHours += hours[index];
    }
    const workedHours = projectHours + otherHours;
    const accountedHours = workedHours + absenceHours;
    return {
      yearMonth,
      workingDays: baseHours > 0 ? baseHours / HOURS_PER_WORKING_DAY : null,
      baseHours,
      ownCapacityHours,
      absenceHours,
      projectHours,
      otherHours,
      workedHours,
      accountedHours,
      unaccountedHours: Math.max(0, baseHours - accountedHours),
      excessHours: Math.max(0, accountedHours - baseHours),
    };
  });

  const projectBlocks: TimesheetProjectBlock[] = [];
  for (const project of projects) {
    const activities = byProject.get(project.id);
    const approved = [
      ...new Set(project.budgetLines.map((line) => line.activity).filter((a) => a !== "")),
    ].sort((a, b) => (activityNumber(a) ?? 0) - (activityNumber(b) ?? 0) || a.localeCompare(b));

    // Only projects this person actually worked on appear, as on the form.
    if (!activities || activities.size === 0) continue;

    const rows: TimesheetActivityRow[] = [...activities.entries()]
      .map(([activity, hours]) => ({ activity, hours }))
      .sort(
        (a, b) =>
          (activityNumber(a.activity) ?? 0) - (activityNumber(b.activity) ?? 0) ||
          a.activity.localeCompare(b.activity),
      );

    projectBlocks.push({
      projectId: project.id,
      code: project.code,
      name: project.name,
      fundingProgram: project.fundingProgram,
      rows,
      unusedActivities: approved.filter(
        (candidate) => !rows.some((row) => sameActivity(row.activity, candidate)),
      ),
      totals: months.map((_, index) =>
        rows.reduce((sum, row) => sum + row.hours[index], 0),
      ),
    });
  }

  return {
    personId: person.id,
    personName: person.name,
    year,
    months: monthRows,
    projects: projectBlocks,
    // Months with no hours at all are not a problem to solve: the form is only
    // wrong once someone has started filling a month in.
    balanced: monthRows.every(
      (month) =>
        (month.accountedHours === 0 && month.projectHours === 0) ||
        (month.unaccountedHours === 0 && month.excessHours === 0),
    ),
  };
}
