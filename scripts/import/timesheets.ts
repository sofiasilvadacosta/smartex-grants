import { existsSync, readdirSync } from "node:fs";
import path from "node:path";
import type ExcelJS from "exceljs";
import { prisma } from "../../src/lib/db";
import { asNumber, asString, loadWorkbook } from "./lib/workbook";
import { activityNumber } from "../../src/lib/timesheet";

/**
 * Reads the funder's "Mapa de horas/ETI" workbooks (COMPETE2030 layout).
 *
 * The layout is fixed by the funder, so it is addressed by position rather than by
 * searching for headers — and every position is checked before anything is
 * written, so a workbook that is not this form is reported instead of half-read:
 *
 *   row 5  col 3   "Projeto <number>"
 *   row 6  col 3   "Técnico: <name>"
 *   row 7  cols 7-18  the twelve months, as dates
 *   row 8            J — daily hours
 *   row 9            N — working days
 *   row 12           absence hours
 *   rows 14..19      hours per project activity, labelled in col 6
 *   row 28           "Outras atividades" hours
 *
 * One worksheet per year. Hours land on ProjectHoursAllocation with the activity
 * label; absences and other-activity hours on Absence and PersonMonthCapacity.
 */

const COL_LABEL = 3;
const COL_ACTIVITY = 6;
const FIRST_MONTH_COL = 7;
const LAST_MONTH_COL = 18;

const ROW_PROJECT = 5;
const ROW_TECHNICIAN = 6;
const ROW_MONTHS = 7;
const ROW_DAILY_HOURS = 8;
const ROW_WORKING_DAYS = 9;
const ROW_ABSENCE = 12;
const FIRST_ACTIVITY_ROW = 14;
const LAST_ACTIVITY_ROW = 19;
const ROW_OTHER_ACTIVITIES = 28;

/** Working days a day of absence removes, matching src/lib/capacity.ts. */
const HOURS_PER_WORKING_DAY = 8;

export interface TimesheetImportSummary {
  files: string[];
  technician: string | null;
  projectNumber: string | null;
  projectCode: string | null;
  activityRows: number;
  monthsWithHours: number;
  absenceMonths: number;
  otherActivityMonths: number;
  /** Months whose split does not equal the potential hours, as the funder needs. */
  unbalancedMonths: string[];
  /**
   * Months where the workbook's own J x N disagrees with the company work
   * calendar. Reported, never applied: a stale row of working days makes every
   * ETI on that sheet wrong, and it is the sheet that has to be fixed.
   */
  calendarMismatches: string[];
  /**
   * Rows whose activity text does not match the project's own approved activity
   * carrying the same number — the sign of a form copied from another project.
   * The hours still reach the right budget line, because the link goes through the
   * number; it is the label that would be wrong on a submitted form.
   */
  activityLabelMismatches: string[];
  problems: string[];
}

function monthKey(value: unknown): string | null {
  if (value instanceof Date) return value.toISOString().slice(0, 7);
  const text = asString(value);
  if (!text) return null;
  // Some copies hold the month as text rather than a date.
  const match = /^(\d{4})-(\d{2})/.exec(text.trim());
  return match ? `${match[1]}-${match[2]}` : null;
}

function technicianName(sheet: ExcelJS.Worksheet): string | null {
  const raw = asString(sheet.getRow(ROW_TECHNICIAN).getCell(COL_LABEL).value);
  if (!raw) return null;
  const match = /t[eé]cnico\s*:\s*(.+)$/i.exec(raw.trim());
  return (match ? match[1] : raw).trim() || null;
}

function projectNumber(sheet: ExcelJS.Worksheet): string | null {
  const raw = asString(sheet.getRow(ROW_PROJECT).getCell(COL_LABEL).value);
  if (!raw) return null;
  const match = /(\d{3,})/.exec(raw);
  return match ? match[1] : null;
}

/**
 * Resolves "Seven" or "Seven Shurygin" to a person. The form holds a first name
 * or a nickname, so an exact match is tried first and a unique prefix second —
 * an ambiguous name is reported rather than guessed, because attributing hours to
 * the wrong technician is worse than not importing them.
 */
async function resolvePerson(name: string): Promise<{ id: string } | { error: string }> {
  const exact = await prisma.person.findMany({
    where: { name: { equals: name, mode: "insensitive" } },
    select: { id: true },
  });
  if (exact.length === 1) return exact[0];

  const prefix = await prisma.person.findMany({
    where: { name: { startsWith: name, mode: "insensitive" } },
    select: { id: true, name: true },
  });
  if (prefix.length === 1) return { id: prefix[0].id };
  if (prefix.length > 1) {
    return {
      error: `"${name}" corresponde a ${prefix.length} pessoas (${prefix
        .map((p) => p.name)
        .join(", ")}) — nome demasiado curto para atribuir horas`,
    };
  }
  return { error: `"${name}" não corresponde a nenhuma pessoa` };
}

/**
 * Checks the filename against what the sheet's own header says.
 *
 * These workbooks are made by copying someone else's and editing it, and the
 * header is the part people forget. A file named for one person and one project
 * whose header names another is not a naming quirk — one of the two is wrong, and
 * importing it would put a technician's hours on a project neither of them
 * agreed on. Reported and skipped rather than resolved by preferring one side.
 */
function filenameDisagreement(
  filePath: string,
  headerProjectCode: string,
  headerTechnician: string,
  projectCodeByName: Map<string, string>,
): string | null {
  const base = path.basename(filePath).replace(/\.xlsx$/i, "");
  const match = /^Timesheet_([^_]+)_(.+)$/i.exec(base);
  if (!match) return null;
  const [, projectPart, technicianPart] = match;

  const fromName = projectCodeByName.get(normalize(projectPart));
  if (fromName && fromName !== headerProjectCode) {
    return (
      `o nome do ficheiro diz projeto "${projectPart}" mas o cabeçalho diz ${headerProjectCode} ` +
      `— um dos dois está errado`
    );
  }

  // Names are compared on words rather than exactly: files carry "WilsonSeabra"
  // and headers "Wilson Seabra", and a first name alone is a normal shorthand.
  const nameWords = normalize(technicianPart).split(" ").filter(Boolean);
  const headerWords = normalize(headerTechnician).split(" ").filter(Boolean);
  const glued = nameWords.join("");
  const headerGlued = headerWords.join("");
  const shares =
    nameWords.some((word) => headerWords.includes(word)) ||
    glued === headerGlued ||
    headerGlued.includes(glued) ||
    glued.includes(headerGlued);
  if (!shares) {
    return (
      `o nome do ficheiro diz técnico "${technicianPart}" mas o cabeçalho diz ` +
      `"${headerTechnician}" — um dos dois está errado`
    );
  }
  return null;
}

function normalize(text: string): string {
  return text
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .trim();
}

export async function importTimesheet(
  filePath: string,
  projectCodeByNumber: Record<string, string>,
  projectIdByCode: Record<string, string>,
): Promise<TimesheetImportSummary | null> {
  if (!existsSync(filePath)) return null;

  const summary: TimesheetImportSummary = {
    files: [path.basename(filePath)],
    technician: null,
    projectNumber: null,
    projectCode: null,
    activityRows: 0,
    monthsWithHours: 0,
    absenceMonths: 0,
    otherActivityMonths: 0,
    unbalancedMonths: [],
    calendarMismatches: [],
    activityLabelMismatches: [],
    problems: [],
  };

  // The company calendar is the authority on potential hours: it is per month for
  // the whole company, and it already accounts for the municipal holiday the
  // funder's generic form does not know about.
  const calendar = new Map(
    (await prisma.workCalendar.findMany()).map((c) => [c.yearMonth, c.availableHours]),
  );

  const workbook = await loadWorkbook(filePath);
  const sheets = workbook.worksheets.filter((sheet) => /^\d{4}$/.test(sheet.name.trim()));
  if (sheets.length === 0) {
    summary.problems.push(
      "Nenhuma folha com nome de ano (2025, 2026…) — não parece um mapa de horas.",
    );
    return summary;
  }

  const first = sheets[0];
  summary.technician = technicianName(first);
  summary.projectNumber = projectNumber(first);
  if (!summary.technician) {
    summary.problems.push('Falta "Técnico:" na linha 6.');
    return summary;
  }
  if (!summary.projectNumber) {
    summary.problems.push('Falta o número do projeto na linha 5 ("Projeto 20783").');
    return summary;
  }

  const code = projectCodeByNumber[summary.projectNumber];
  if (!code) {
    summary.problems.push(
      `Projeto ${summary.projectNumber} não está mapeado — acrescentar a PROJECT_CODE_BY_NUMBER.`,
    );
    return summary;
  }
  summary.projectCode = code;
  const projectId = projectIdByCode[code];
  if (!projectId) {
    summary.problems.push(`Projeto ${code} não existe na base de dados.`);
    return summary;
  }

  const projects = await prisma.project.findMany({ select: { code: true, name: true } });
  const projectCodeByName = new Map<string, string>();
  for (const project of projects) {
    projectCodeByName.set(normalize(project.code), project.code);
    projectCodeByName.set(normalize(project.name), project.code);
  }
  const disagreement = filenameDisagreement(
    filePath,
    code,
    summary.technician,
    projectCodeByName,
  );
  if (disagreement) {
    summary.problems.push(disagreement);
    return summary;
  }

  const person = await resolvePerson(summary.technician);
  if ("error" in person) {
    summary.problems.push(person.error);
    return summary;
  }

  // The project's own approved activities, by the funder's activity number, so a
  // label copied from another project's form can be spotted.
  const approvedByNumber = new Map<number, string>();
  for (const line of await prisma.budgetLine.findMany({
    where: { projectId, activity: { not: "" } },
    select: { activity: true },
    distinct: ["activity"],
  })) {
    const number = activityNumber(line.activity);
    if (number !== null) approvedByNumber.set(number, line.activity);
  }
  const seenMismatch = new Set<string>();
  // Activity number -> label -> the sheets that used it. Two labels for one
  // number is a contradiction inside the workbook itself, which needs no list of
  // approved names to detect — and is what catches a year copied from another
  // project's form when the approved activities are stored as bare numbers.
  const labelsByNumber = new Map<number, Map<string, string[]>>();

  for (const sheet of sheets) {
    const months = new Map<number, string>();
    for (let col = FIRST_MONTH_COL; col <= LAST_MONTH_COL; col++) {
      const key = monthKey(sheet.getRow(ROW_MONTHS).getCell(col).value);
      if (key) months.set(col, key);
    }
    if (months.size === 0) {
      summary.problems.push(`Folha ${sheet.name}: sem meses na linha ${ROW_MONTHS}.`);
      continue;
    }

    // Potential hours per month. The workbook's own J x N is computed (rather than
    // read from row 10, which holds formulas a file that was never opened leaves
    // stale) only to compare it against the calendar — the calendar is what the
    // balance check and every ETI use.
    for (const [col, yearMonth] of months) {
      const daily = asNumber(sheet.getRow(ROW_DAILY_HOURS).getCell(col).value);
      const days = asNumber(sheet.getRow(ROW_WORKING_DAYS).getCell(col).value);
      if (daily === null || days === null) continue;
      const fromSheet = daily * days;
      const fromCalendar = calendar.get(yearMonth);
      if (fromCalendar !== undefined && Math.abs(fromSheet - fromCalendar) > 0.01) {
        summary.calendarMismatches.push(
          `${yearMonth}: folha diz ${days} dias úteis (${fromSheet} h), calendário diz ` +
            `${fromCalendar / daily} dias (${fromCalendar} h)`,
        );
      }
    }

    const declared = new Map<string, number>();

    for (let row = FIRST_ACTIVITY_ROW; row <= LAST_ACTIVITY_ROW; row++) {
      const activity = asString(sheet.getRow(row).getCell(COL_ACTIVITY).value)?.trim();
      if (!activity || /^sub-?total/i.test(activity)) continue;

      // Compare the label against the approved activity of the same number. Only
      // reported where the approved name is a real name rather than the bare
      // number some projects store, which carries nothing to compare against.
      const number = activityNumber(activity);
      if (number !== null) {
        const byLabel = labelsByNumber.get(number) ?? new Map<string, string[]>();
        const sheets = byLabel.get(activity) ?? [];
        if (!sheets.includes(sheet.name)) sheets.push(sheet.name);
        byLabel.set(activity, sheets);
        labelsByNumber.set(number, byLabel);
      }

      const approved = number === null ? undefined : approvedByNumber.get(number);
      if (
        approved !== undefined &&
        activityNumber(approved) !== null &&
        approved.replace(/^\s*\d+\s*[-–]?\s*/, "").trim().length > 0 &&
        approved.trim() !== activity &&
        !seenMismatch.has(`${sheet.name}|${activity}`)
      ) {
        seenMismatch.add(`${sheet.name}|${activity}`);
        summary.activityLabelMismatches.push(
          `${sheet.name}, atividade ${number}: folha diz "${activity}" — o aprovado é "${approved}"`,
        );
      }

      let rowHadHours = false;
      for (const [col, yearMonth] of months) {
        const hours = asNumber(sheet.getRow(row).getCell(col).value);
        if (hours === null || hours === 0) continue;

        const key = { personId: person.id, projectId, yearMonth, activity };
        await prisma.projectHoursAllocation.upsert({
          where: { personId_projectId_yearMonth_activity: key },
          create: { ...key, hours },
          update: { hours },
        });
        declared.set(yearMonth, (declared.get(yearMonth) ?? 0) + hours);
        summary.monthsWithHours++;
        rowHadHours = true;
      }
      if (rowHadHours) summary.activityRows++;
    }

    // The planning sheet may have left a project-level row for the same month.
    // Now that the activities are known it would double the month, so it goes.
    for (const yearMonth of declared.keys()) {
      await prisma.projectHoursAllocation.deleteMany({
        where: { personId: person.id, projectId, yearMonth, activity: "" },
      });
    }

    for (const [col, yearMonth] of months) {
      const absenceHours = asNumber(sheet.getRow(ROW_ABSENCE).getCell(col).value);
      if (absenceHours !== null && absenceHours > 0) {
        const days = absenceHours / HOURS_PER_WORKING_DAY;
        // Replace what a previous run of this importer wrote, and only that: an
        // absence somebody entered in the app carries a createdById and stays.
        await prisma.absence.deleteMany({
          where: { personId: person.id, yearMonth, createdById: null },
        });
        await prisma.absence.create({
          data: {
            personId: person.id,
            yearMonth,
            type: "OTHER",
            days,
            notes: `Importado do mapa de horas (${absenceHours} h de férias/baixas/licenças/faltas)`,
          },
        });
        summary.absenceMonths++;
      }

      const otherHours = asNumber(sheet.getRow(ROW_OTHER_ACTIVITIES).getCell(col).value);
      if (otherHours !== null && otherHours > 0) {
        await prisma.personMonthCapacity.upsert({
          where: { personId_yearMonth: { personId: person.id, yearMonth } },
          create: {
            personId: person.id,
            yearMonth,
            // Only needed because the column is required; the calendar is the
            // authority and the planning sheet fills this in for real.
            productiveHours: calendar.get(yearMonth) ?? 0,
            nonProjectHours: otherHours,
          },
          // productiveHours is deliberately left alone: the planning sheet tracks
          // it per person (a part month after joining, for instance) and the
          // funder's form is not a source for it.
          update: { nonProjectHours: otherHours },
        });
        summary.otherActivityMonths++;
      }

      // Report, never correct: an unbalanced month is a real problem with the
      // form, and silently padding it would hide it. Measured against the
      // calendar, not the sheet's own row of working days, which may be stale.
      const monthPotential = calendar.get(yearMonth);
      const totalDeclared =
        (declared.get(yearMonth) ?? 0) +
        (otherHours ?? 0) +
        (asNumber(sheet.getRow(ROW_ABSENCE).getCell(col).value) ?? 0);
      if (
        totalDeclared > 0 &&
        monthPotential !== undefined &&
        Math.abs(totalDeclared - monthPotential) > 0.01
      ) {
        summary.unbalancedMonths.push(
          `${yearMonth}: ${totalDeclared} h repartidas de ${monthPotential} h potenciais`,
        );
      }
    }
  }

  for (const [number, byLabel] of [...labelsByNumber.entries()].sort((a, b) => a[0] - b[0])) {
    if (byLabel.size < 2) continue;
    summary.activityLabelMismatches.push(
      `atividade ${number} tem nomes diferentes entre folhas do mesmo ficheiro: ` +
        [...byLabel.entries()]
          .map(([label, sheets]) => `${sheets.join("/")} diz "${label}"`)
          .join("; "),
    );
  }

  return summary;
}

/** Every Timesheet_*.xlsx in the imports directory. */
export function findTimesheetFiles(importsDir: string): string[] {
  if (!existsSync(importsDir)) return [];
  return readdirSync(importsDir)
    .filter((name) => /^Timesheet_.+\.xlsx$/i.test(name) && !name.startsWith("~$"))
    .sort()
    .map((name) => path.join(importsDir, name));
}
