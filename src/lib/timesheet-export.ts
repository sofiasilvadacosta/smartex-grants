import ExcelJS from "exceljs";
import { prisma } from "@/lib/db";
import { HOURS_PER_WORKING_DAY } from "@/lib/capacity";
import { loadTimesheet, MONTHS_IN_YEAR } from "@/lib/timesheet";

// Writes the funder's "Mapa de horas/ETI" as a workbook, one sheet per year, in
// the layout of the form itself: same rows, same labels, same live formulas for
// every computed line. Reproducing the formulas rather than pasting values means
// the file behaves like the funder's own template when someone opens it — change
// an hours cell and the ETI and the totals follow.
//
// It is a faithful reproduction, not the funder's file. If the portal insists on
// its own template, the numbers still transfer column for column.
//
// One difference from the sheets Sofia keeps today, and it is deliberate: the
// person's *other funded projects* get a named line each in the second block
// rather than disappearing into "Outras atividades". The form's header requires
// the split between projects, and hours hidden in an unnamed line cannot be
// checked against anything.

const COL_PROGRAM = 3;
const COL_PROJECT = 4;
const COL_KIND = 5;
const COL_ACTIVITY = 6;
const FIRST_MONTH_COL = 7;

const HEADER_NOTE =
  "É obrigatória a repartição das horas entre projetos e outras atividades desenvolvidas na " +
  "entidade beneficiária, assim como as ausências. O total da repartição terá de ser sempre igual " +
  "às horas trabalháveis potenciais (coincidentes com o n.º de dias úteis de cada mês).";

const FOOTNOTE_J =
  "(*) Na aplicação do racional do custo unitário por ETI, ou seja, na metodologia de custos " +
  "simplificados, para a jornada diária de trabalho dos trabalhadores a tempo parcial é " +
  "considerada uma jornada a full-time.";
const FOOTNOTE_N = "(**) exclui fins de semana e feriados";

function colLetter(index: number): string {
  let letter = "";
  let n = index;
  while (n > 0) {
    const remainder = (n - 1) % 26;
    letter = String.fromCharCode(65 + remainder) + letter;
    n = Math.floor((n - 1) / 26);
  }
  return letter;
}

const MONTH_LETTERS = Array.from({ length: MONTHS_IN_YEAR }, (_, i) =>
  colLetter(FIRST_MONTH_COL + i),
);

export interface TimesheetExportResult {
  workbook: ExcelJS.Workbook;
  filename: string;
  /** Years that had nothing to write, so the caller can say so. */
  emptyYears: number[];
  /**
   * Other projects that did not fit the form's four spare lines. Reported rather
   * than dropped silently: hours left out of the form are hours not claimed.
   */
  overflowProjects: string[];
}

export async function buildTimesheetWorkbook(
  personId: string,
  projectId: string,
  years: readonly number[],
): Promise<TimesheetExportResult | null> {
  const project = await prisma.project.findUnique({
    where: { id: projectId },
    select: { id: true, code: true, name: true, fundingProgram: true, externalNumber: true },
  });
  if (!project) return null;

  const workbook = new ExcelJS.Workbook();
  workbook.creator = "Smartex Grants";
  const emptyYears: number[] = [];
  const overflowProjects = new Set<string>();
  let personName = "";

  for (const year of [...years].sort()) {
    const timesheet = await loadTimesheet(personId, year);
    if (!timesheet) return null;
    personName = timesheet.personName;

    const thisProject = timesheet.projects.find((block) => block.projectId === project.id);
    const otherProjects = timesheet.projects.filter((block) => block.projectId !== project.id);
    const hasAnything =
      thisProject !== undefined ||
      otherProjects.length > 0 ||
      timesheet.months.some((m) => m.otherHours > 0 || m.absenceHours > 0);
    if (!hasAnything) {
      emptyYears.push(year);
      continue;
    }

    const sheet = workbook.addWorksheet(String(year));
    sheet.getColumn(COL_PROGRAM).width = 18;
    sheet.getColumn(COL_PROJECT).width = 10;
    sheet.getColumn(COL_KIND).width = 16;
    sheet.getColumn(COL_ACTIVITY).width = 52;
    for (let i = 0; i < MONTHS_IN_YEAR; i++) sheet.getColumn(FIRST_MONTH_COL + i).width = 10;

    const bold = { bold: true };
    const italic = { italic: true, size: 9 };

    sheet.getCell(3, COL_PROGRAM).value = HEADER_NOTE;
    sheet.getCell(3, COL_PROGRAM).font = italic;
    sheet.getCell(3, COL_PROGRAM).alignment = { wrapText: true, vertical: "top" };
    sheet.getRow(3).height = 42;

    sheet.getCell(5, COL_PROGRAM).value = project.externalNumber
      ? `Projeto ${project.externalNumber}`
      : `Projeto ${project.code}`;
    sheet.getCell(5, COL_PROGRAM).font = bold;
    sheet.getCell(6, COL_PROGRAM).value = `Técnico: ${timesheet.personName}`;
    sheet.getCell(6, COL_PROGRAM).font = bold;

    // Row 7: the months, as the first day of each, matching the form.
    timesheet.months.forEach((month, index) => {
      const cell = sheet.getCell(7, FIRST_MONTH_COL + index);
      const [y, m] = month.yearMonth.split("-").map(Number);
      cell.value = new Date(Date.UTC(y, m - 1, 1));
      cell.numFmt = "mmm/yyyy";
      cell.font = bold;
      cell.alignment = { horizontal: "center" };
    });

    const writeLabel = (row: number, label: string, strong = false) => {
      const cell = sheet.getCell(row, COL_PROGRAM);
      cell.value = label;
      if (strong) cell.font = bold;
      sheet.mergeCells(row, COL_PROGRAM, row, COL_ACTIVITY);
    };

    const ROW_J = 8;
    const ROW_N = 9;
    const ROW_POTENTIAL = 10;
    const ROW_FULL_TIME = 11;
    const ROW_ABSENCE = 12;
    const ROW_TABLE_HEADER = 13;

    writeLabel(ROW_J, "J - Jornada diária (*)");
    writeLabel(ROW_N, "N - Nº de dias úteis trabalháveis (**)");
    writeLabel(ROW_POTENTIAL, "Horas trabalháveis potenciais (J x N)", true);
    writeLabel(ROW_FULL_TIME, "ETI (full-time)");
    writeLabel(ROW_ABSENCE, "Férias/Baixas/Licenças/Faltas (Horas)");

    timesheet.months.forEach((month, index) => {
      const letter = MONTH_LETTERS[index];
      const col = FIRST_MONTH_COL + index;
      sheet.getCell(ROW_J, col).value = HOURS_PER_WORKING_DAY;
      sheet.getCell(ROW_N, col).value = month.workingDays;
      sheet.getCell(ROW_POTENTIAL, col).value = {
        formula: `${letter}${ROW_J}*${letter}${ROW_N}`,
      };
      sheet.getCell(ROW_POTENTIAL, col).font = bold;
      sheet.getCell(ROW_FULL_TIME, col).value = {
        formula: `IFERROR(${letter}${ROW_POTENTIAL}/${letter}${ROW_POTENTIAL},0)`,
      };
      sheet.getCell(ROW_ABSENCE, col).value = month.absenceHours || null;
    });

    sheet.getCell(ROW_TABLE_HEADER, COL_PROGRAM).value = "PROGRAMA";
    sheet.getCell(ROW_TABLE_HEADER, COL_PROJECT).value = "Projeto";
    sheet.getCell(ROW_TABLE_HEADER, COL_KIND).value = "Afetação de horas/ETI";
    for (const col of [COL_PROGRAM, COL_PROJECT, COL_KIND]) {
      sheet.getCell(ROW_TABLE_HEADER, col).font = bold;
    }

    /**
     * Writes one block: the hours lines, their subtotal, the matching ETI lines
     * and their subtotal. Returns the two subtotal rows so the grand totals can
     * point at them.
     */
    const writeBlock = (
      startRow: number,
      lines: { label: string; hours: number[] }[],
      programme: string | null,
      projectLabel: string | null,
    ): { next: number; hoursSubtotal: number; etiSubtotal: number } => {
      const firstHoursRow = startRow;
      lines.forEach((line, i) => {
        const row = firstHoursRow + i;
        if (programme) sheet.getCell(row, COL_PROGRAM).value = programme;
        if (projectLabel) sheet.getCell(row, COL_PROJECT).value = projectLabel;
        sheet.getCell(row, COL_KIND).value = "Horas";
        sheet.getCell(row, COL_ACTIVITY).value = line.label;
        line.hours.forEach((hours, index) => {
          sheet.getCell(row, FIRST_MONTH_COL + index).value = hours || null;
        });
      });
      const lastHoursRow = firstHoursRow + lines.length - 1;
      const hoursSubtotal = lastHoursRow + 1;

      if (programme) sheet.getCell(hoursSubtotal, COL_PROGRAM).value = programme;
      if (projectLabel) sheet.getCell(hoursSubtotal, COL_PROJECT).value = projectLabel;
      sheet.getCell(hoursSubtotal, COL_KIND).value = "Horas";
      sheet.getCell(hoursSubtotal, COL_ACTIVITY).value = "Sub-Total Horas";
      sheet.getCell(hoursSubtotal, COL_ACTIVITY).font = bold;
      MONTH_LETTERS.forEach((letter, index) => {
        const cell = sheet.getCell(hoursSubtotal, FIRST_MONTH_COL + index);
        cell.value = { formula: `SUM(${letter}${firstHoursRow}:${letter}${lastHoursRow})` };
        cell.font = bold;
      });

      const firstEtiRow = hoursSubtotal + 1;
      lines.forEach((line, i) => {
        const row = firstEtiRow + i;
        if (programme) sheet.getCell(row, COL_PROGRAM).value = programme;
        if (projectLabel) sheet.getCell(row, COL_PROJECT).value = projectLabel;
        sheet.getCell(row, COL_KIND).value = "ETI imputado";
        sheet.getCell(row, COL_ACTIVITY).value = line.label;
        MONTH_LETTERS.forEach((letter, index) => {
          const cell = sheet.getCell(row, FIRST_MONTH_COL + index);
          cell.value = {
            formula: `IFERROR(${letter}${firstHoursRow + i}/${letter}$${ROW_POTENTIAL},0)`,
          };
          cell.numFmt = "0.00000";
        });
      });
      const etiSubtotal = firstEtiRow + lines.length;
      if (programme) sheet.getCell(etiSubtotal, COL_PROGRAM).value = programme;
      if (projectLabel) sheet.getCell(etiSubtotal, COL_PROJECT).value = projectLabel;
      sheet.getCell(etiSubtotal, COL_KIND).value = "ETI imputado";
      sheet.getCell(etiSubtotal, COL_ACTIVITY).value = "Sub-Total ETI";
      sheet.getCell(etiSubtotal, COL_ACTIVITY).font = bold;
      MONTH_LETTERS.forEach((letter, index) => {
        const cell = sheet.getCell(etiSubtotal, FIRST_MONTH_COL + index);
        cell.value = { formula: `SUM(${letter}${firstEtiRow}:${letter}${etiSubtotal - 1})` };
        cell.numFmt = "0.00000";
        cell.font = bold;
      });

      return { next: etiSubtotal + 1, hoursSubtotal, etiSubtotal };
    };

    // Block 1 — the project this form is about. Its approved activities that the
    // year has no hours on are written as empty lines, as the funder's own
    // template does: the form shows the whole activity list.
    const mainLines = [
      ...(thisProject?.rows.map((row) => ({
        label: row.activity || project.name,
        hours: row.hours,
      })) ?? []),
      ...(thisProject?.unusedActivities.map((activity) => ({
        label: activity,
        hours: new Array<number>(MONTHS_IN_YEAR).fill(0),
      })) ?? []),
    ];
    if (mainLines.length === 0) {
      mainLines.push({ label: project.name, hours: new Array(MONTHS_IN_YEAR).fill(0) });
    }
    const main = writeBlock(
      ROW_TABLE_HEADER + 1,
      mainLines,
      project.fundingProgram,
      project.externalNumber ?? project.code,
    );

    // Block 2 — the person's other funded projects, one named line each.
    const OTHER_PROJECT_LINES = 4;
    const shown = otherProjects.slice(0, OTHER_PROJECT_LINES);
    for (const extra of otherProjects.slice(OTHER_PROJECT_LINES)) {
      overflowProjects.add(extra.name);
    }
    const otherLines =
      shown.length > 0
        ? shown.map((block) => ({
            label: block.name,
            hours: block.totals,
          }))
        : [{ label: "Outros projetos", hours: new Array<number>(MONTHS_IN_YEAR).fill(0) }];
    const others = writeBlock(main.next, otherLines, null, null);

    // Block 3 — everything that is not a funded project.
    const ROW_NON_PROJECT_HOURS = others.next;
    const ROW_NON_PROJECT_ETI = ROW_NON_PROJECT_HOURS + 1;
    sheet.getCell(ROW_NON_PROJECT_HOURS, COL_PROGRAM).value = "Outras atividades";
    sheet.getCell(ROW_NON_PROJECT_HOURS, COL_KIND).value = "Horas";
    sheet.getCell(ROW_NON_PROJECT_ETI, COL_PROGRAM).value = "Outras atividades";
    sheet.getCell(ROW_NON_PROJECT_ETI, COL_KIND).value = "ETI";
    sheet.getCell(ROW_NON_PROJECT_ETI, COL_ACTIVITY).value = "Sub-Total ETI";
    timesheet.months.forEach((month, index) => {
      const letter = MONTH_LETTERS[index];
      sheet.getCell(ROW_NON_PROJECT_HOURS, FIRST_MONTH_COL + index).value =
        month.otherHours || null;
      const cell = sheet.getCell(ROW_NON_PROJECT_ETI, FIRST_MONTH_COL + index);
      cell.value = {
        formula: `IFERROR(${letter}${ROW_NON_PROJECT_HOURS}/${letter}$${ROW_POTENTIAL},0)`,
      };
      cell.numFmt = "0.00000";
    });

    const ROW_WORK_HOURS = ROW_NON_PROJECT_ETI + 1;
    const ROW_WORK_ETI = ROW_WORK_HOURS + 1;
    const ROW_WORK_ABSENCE_HOURS = ROW_WORK_ETI + 1;
    const ROW_WORK_ABSENCE_ETI = ROW_WORK_ABSENCE_HOURS + 1;

    writeLabel(ROW_WORK_HOURS, "Tempo Trabalho (em horas)", true);
    writeLabel(ROW_WORK_ETI, "Tempo Trabalho (em ETI)");
    writeLabel(ROW_WORK_ABSENCE_HOURS, "Tempo Trabalho + Ausências (em horas)", true);
    writeLabel(ROW_WORK_ABSENCE_ETI, "Tempo Trabalho + Ausências (em ETI)");

    MONTH_LETTERS.forEach((letter, index) => {
      const col = FIRST_MONTH_COL + index;
      const work = sheet.getCell(ROW_WORK_HOURS, col);
      work.value = {
        formula: `${letter}${main.hoursSubtotal}+${letter}${others.hoursSubtotal}+${letter}${ROW_NON_PROJECT_HOURS}`,
      };
      work.font = bold;
      sheet.getCell(ROW_WORK_ETI, col).value = {
        formula: `IFERROR(${letter}${ROW_WORK_HOURS}/${letter}${ROW_POTENTIAL},0)`,
      };
      sheet.getCell(ROW_WORK_ETI, col).numFmt = "0.00000";

      const total = sheet.getCell(ROW_WORK_ABSENCE_HOURS, col);
      total.value = {
        formula: `${letter}${ROW_WORK_HOURS}+${letter}${ROW_ABSENCE}`,
      };
      total.font = bold;
      sheet.getCell(ROW_WORK_ABSENCE_ETI, col).value = {
        formula: `IFERROR(${letter}${ROW_WORK_ABSENCE_HOURS}/${letter}${ROW_POTENTIAL},0)`,
      };
      sheet.getCell(ROW_WORK_ABSENCE_ETI, col).numFmt = "0.00000";
    });

    const ROW_FOOTNOTE_J = ROW_WORK_ABSENCE_ETI + 2;
    sheet.getCell(ROW_FOOTNOTE_J, COL_PROGRAM).value = FOOTNOTE_J;
    sheet.getCell(ROW_FOOTNOTE_J, COL_PROGRAM).font = italic;
    sheet.getCell(ROW_FOOTNOTE_J + 1, COL_PROGRAM).value = FOOTNOTE_N;
    sheet.getCell(ROW_FOOTNOTE_J + 1, COL_PROGRAM).font = italic;
  }

  if (workbook.worksheets.length === 0) {
    return { workbook, filename: "", emptyYears, overflowProjects: [...overflowProjects] };
  }

  const safeName = personName.normalize("NFD").replace(/[^\w]+/g, "_").replace(/^_|_$/g, "");
  return {
    workbook,
    filename: `Mapa_horas_${project.code}_${safeName}.xlsx`,
    emptyYears,
    overflowProjects: [...overflowProjects],
  };
}
