import { prisma } from "../../src/lib/db";
import { loadWorkbook, getSheet, asString, asNumber, asDate } from "./lib/workbook";
import { buildMonthGrid } from "./lib/month-grid";

// Project names as written in the Gestão Projetos workbook -> Project.code.
// The workbook spells TexQualis as "TexQuality" and has a trailing space on
// "Texia ", so match on a normalized key.
const PROJECT_NAME_TO_CODE: Record<string, string> = {
  "texp@ct": "TEXPACT",
  produtech: "PRODUTECH",
  "defect free": "DEFECT_FREE",
  texia: "TEXIA",
  texquality: "TEXQUALIS",
  texqualis: "TEXQUALIS",
};

// Rows inside a person's block in "Recursos" whose col-2 label is a summary or
// derived line rather than a project allocation.
const NON_PROJECT_ROW_LABELS = new Set([
  "férias/ausências",
  "total",
  "horas disponíveis por mês",
  "percentagem de dedicação",
  "projeto",
]);

const PERSON_BLOCK_MARKER = "Horas Produtivas";

export interface PeopleImportSummary {
  people: number;
  workCalendarMonths: number;
  capacities: number;
  hoursAllocations: number;
  unmatchedProjectLabels: string[];
  duplicateInitials: string[];
}

// DADOS sheet: the people block sits in columns J..Q alongside the project
// block, with its own header row.
async function importPeople(workbook: Awaited<ReturnType<typeof loadWorkbook>>) {
  const sheet = getSheet(workbook, "DADOS");
  let count = 0;
  const seenInitials = new Map<string, string>();
  const duplicateInitials: string[] = [];

  for (let r = 4; r <= sheet.rowCount; r++) {
    const row = sheet.getRow(r);
    const name = asString(row.getCell(10).value);
    const initials = asString(row.getCell(11).value);
    if (!name || !initials) continue;

    // Initials are the key the Recursos sheet uses to attribute hours, so two
    // people sharing them is a source-data conflict that must be fixed by a
    // human. Keep the first row and report the clash rather than silently
    // overwriting one person with the other.
    const previous = seenInitials.get(initials);
    if (previous) {
      if (previous !== name) duplicateInitials.push(`${initials}: ${previous} / ${name}`);
      continue;
    }
    seenInitials.set(initials, name);

    const obs = asString(row.getCell(15).value);
    // The "Salário" column is not read here: pay is effective-dated and lives in
    // SalaryRecord, built by scripts/import/salary-history.ts once the RH sheets
    // have been read (they are what carries the dated monthly base).
    const fields = {
      name,
      entryDate: asDate(row.getCell(13).value),
      exitDate: asDate(row.getCell(14).value),
      obs,
      profile: asString(row.getCell(16).value),
      // The source has no boolean; a filled "Obs." saying the person left is
      // the only signal available.
      active: !/sa[ií]u/i.test(obs ?? ""),
    };

    await prisma.person.upsert({
      where: { initials },
      update: fields,
      create: { initials, ...fields },
    });
    count++;
  }

  return { count, duplicateInitials };
}

// HorasProdutivas: row 4 holds the company-wide available hours per month.
async function importWorkCalendar(workbook: Awaited<ReturnType<typeof loadWorkbook>>) {
  const sheet = getSheet(workbook, "HorasProdutivas");
  const grid = buildMonthGrid(sheet, 2, 3);
  const hoursRow = sheet.getRow(4);
  let count = 0;

  for (const [col, yearMonth] of grid) {
    const hours = asNumber(hoursRow.getCell(col).value);
    if (hours == null) continue;
    await prisma.workCalendar.upsert({
      where: { yearMonth },
      update: { availableHours: Math.round(hours) },
      create: { yearMonth, availableHours: Math.round(hours) },
    });
    count++;
  }

  return count;
}

// Recursos: one block per person. The block starts on the row whose column 3
// reads "Horas Produtivas" (column 1 = person's full name, monthly cells =
// productive hours). Subsequent rows carry the person's initials in column 1
// and a project name in column 2, with that project's monthly hours.
async function importCapacityAndHours(
  workbook: Awaited<ReturnType<typeof loadWorkbook>>,
  projectIdByCode: Record<string, string>,
) {
  const sheet = getSheet(workbook, "Recursos");
  const grid = buildMonthGrid(sheet, 2, 3);

  const peopleByInitials = new Map(
    (await prisma.person.findMany({ select: { id: true, initials: true } })).map((p) => [
      p.initials,
      p.id,
    ]),
  );
  const peopleByName = new Map(
    (await prisma.person.findMany({ select: { id: true, name: true } })).map((p) => [
      p.name.trim().toLowerCase(),
      p.id,
    ]),
  );

  let capacities = 0;
  let hoursAllocations = 0;
  const unmatchedProjectLabels = new Set<string>();
  let currentPersonId: string | null = null;

  for (let r = 4; r <= sheet.rowCount; r++) {
    const row = sheet.getRow(r);
    const col1 = asString(row.getCell(1).value);
    const col2 = asString(row.getCell(2).value);
    const col3 = asString(row.getCell(3).value);

    if (col3 === PERSON_BLOCK_MARKER) {
      currentPersonId = col1 ? (peopleByName.get(col1.trim().toLowerCase()) ?? null) : null;
      if (currentPersonId) {
        for (const [col, yearMonth] of grid) {
          const hours = asNumber(row.getCell(col).value);
          if (hours == null) continue;
          await prisma.personMonthCapacity.upsert({
            where: { personId_yearMonth: { personId: currentPersonId, yearMonth } },
            update: { productiveHours: hours },
            create: { personId: currentPersonId, yearMonth, productiveHours: hours },
          });
          capacities++;
        }
      }
      continue;
    }

    if (!col2) continue;
    const label = col2.trim().toLowerCase();
    if (NON_PROJECT_ROW_LABELS.has(label) || label === "0") continue;

    const code = PROJECT_NAME_TO_CODE[label];
    if (!code) {
      unmatchedProjectLabels.add(col2.trim());
      continue;
    }
    const projectId = projectIdByCode[code];
    // A block's rows carry initials in column 1; fall back to the person the
    // current block belongs to when that cell is blank.
    const personId = (col1 ? peopleByInitials.get(col1) : null) ?? currentPersonId;
    if (!projectId || !personId) continue;

    for (const [col, yearMonth] of grid) {
      const hours = asNumber(row.getCell(col).value);
      if (hours == null || hours === 0) continue;
      // The planning sheet has no activity column, so these land at project
      // level (activity ""). The funder's timesheet needs the split by activity;
      // it comes from the timesheet workbooks (scripts/import/timesheets.ts).
      await prisma.projectHoursAllocation.upsert({
        where: {
          personId_projectId_yearMonth_activity: {
            personId,
            projectId,
            yearMonth,
            activity: "",
          },
        },
        update: { hours },
        create: { personId, projectId, yearMonth, activity: "", hours },
      });
      hoursAllocations++;
    }
  }

  return { capacities, hoursAllocations, unmatchedProjectLabels: [...unmatchedProjectLabels] };
}

export async function importPeopleAndCapacity(
  workbookPath: string,
  projectIdByCode: Record<string, string>,
): Promise<PeopleImportSummary> {
  const workbook = await loadWorkbook(workbookPath);
  const { count: people, duplicateInitials } = await importPeople(workbook);
  const workCalendarMonths = await importWorkCalendar(workbook);
  const { capacities, hoursAllocations, unmatchedProjectLabels } = await importCapacityAndHours(
    workbook,
    projectIdByCode,
  );
  return {
    people,
    workCalendarMonths,
    capacities,
    hoursAllocations,
    unmatchedProjectLabels,
    duplicateInitials,
  };
}
