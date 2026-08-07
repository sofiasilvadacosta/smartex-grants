import { prisma } from "../../src/lib/db";
import { asNumber, asString, loadWorkbook } from "./lib/workbook";
import { resolvePersonByName } from "../../src/lib/people-match";

/**
 * The per-project sheets of the planning workbook: one row per
 * (Perfil, Colaborador, Atividade), with FTE and hours per year.
 *
 * These are the only source that says *which activities* a person is expected to
 * work on, and under which of the funder's profiles. Neither is in the monthly
 * sheets: "Recursos" gives hours per person, project and month with no activity,
 * and "ExecuçãoMês" gives cost the same way. So this is the piece that turns "any
 * of this project's forty budget lines" into "one of these four".
 *
 * What it deliberately does not do is decide anything. It carries no months, so
 * it cannot say which activity a particular month of work went to — only which
 * ones are possible.
 */

const SHEET_BY_CODE: Record<string, string> = {
  PRODUTECH: "Produtech",
  TEXPACT: "Texp@ct",
  DEFECT_FREE: "Defect Free",
  TEXIA: "TEXIA (ML)",
  TEXQUALIS: "TexQualis",
};

// Fixed by the sheets, which all share one layout.
const HEADER_ROW = 4;
const COL_PROFILE = 2;
const COL_COLLABORATOR = 3;
const COL_ACTIVITY = 4;
const COL_FTE_TOTAL = 11;
const COL_HOURS_TOTAL = 19;
const COL_ALLOCATED_TOTAL = 21;

export interface PlannedAssignmentsSummary {
  byProject: Record<
    string,
    {
      rows: number;
      people: number;
      activities: number;
      unresolvedNames: string[];
      /** People with execution on the project that the plan does not mention. */
      missingFromPlan: string[];
    }
  >;
}

/**
 * Resolves a collaborator cell to people. The cell often names two ("Joana Anjo /
 * Seven"), meaning either of them may do the work, so it becomes one row each.
 * A name that matches nobody is reported, never guessed at.
 */
async function resolveNames(
  cell: string,
  people: { id: string; name: string }[],
): Promise<{ parts: { raw: string; personId: string | null }[] }> {
  // A collaborator cell often names two people ("Joana Anjo / Seven"), meaning
  // either of them may do the work, so it becomes one row each.
  const parts = cell
    .split("/")
    .map((part) => part.trim())
    .filter(Boolean);
  return {
    parts: parts.map((raw) => ({ raw, personId: resolvePersonByName(raw, people).personId })),
  };
}

export async function importPlannedAssignments(
  workbookPath: string,
  projectIdByCode: Record<string, string>,
): Promise<PlannedAssignmentsSummary> {
  const workbook = await loadWorkbook(workbookPath);
  const people = await prisma.person.findMany({ select: { id: true, name: true } });
  const summary: PlannedAssignmentsSummary = { byProject: {} };

  for (const [code, sheetName] of Object.entries(SHEET_BY_CODE)) {
    const projectId = projectIdByCode[code];
    const sheet = workbook.getWorksheet(sheetName);
    if (!projectId || !sheet) continue;

    // Verify the layout before writing anything: these sheets are hand-kept and
    // a shifted column would otherwise import profiles as activities.
    const header = sheet.getRow(HEADER_ROW);
    const expected: [number, RegExp][] = [
      [COL_PROFILE, /perfil/i],
      [COL_COLLABORATOR, /colaborador/i],
      [COL_ACTIVITY, /atividade/i],
    ];
    const wrong = expected.filter(
      ([col, pattern]) => !pattern.test(asString(header.getCell(col).value) ?? ""),
    );
    if (wrong.length > 0) {
      summary.byProject[code] = {
        rows: 0,
        people: 0,
        activities: 0,
        unresolvedNames: [
          `cabeçalho inesperado na linha ${HEADER_ROW} da folha "${sheetName}" — colunas ` +
            `${wrong.map(([col]) => col).join(", ")} não são Perfil/Colaborador/Atividades`,
        ],
        missingFromPlan: [],
      };
      continue;
    }

    const seen = new Set<string>();
    const unresolved = new Set<string>();
    const activities = new Set<string>();
    const personIds = new Set<string>();
    let rows = 0;

    for (let r = HEADER_ROW + 1; r <= sheet.rowCount; r++) {
      const row = sheet.getRow(r);
      const profile = asString(row.getCell(COL_PROFILE).value)?.trim();
      const collaborator = asString(row.getCell(COL_COLLABORATOR).value)?.trim();
      const activity = asString(row.getCell(COL_ACTIVITY).value)?.trim();
      if (!profile || !collaborator || !activity) continue;

      const plannedFte = asNumber(row.getCell(COL_FTE_TOTAL).value);
      const plannedHours = asNumber(row.getCell(COL_HOURS_TOTAL).value);
      const allocatedHours = asNumber(row.getCell(COL_ALLOCATED_TOTAL).value);

      const { parts } = await resolveNames(collaborator, people);
      for (const part of parts) {
        if (part.personId === null) unresolved.add(part.raw);
        else personIds.add(part.personId);

        const key = `${part.raw}|${activity}|${profile}`;
        // The same trio can repeat down a sheet; the first row wins rather than
        // the last, matching how duplicate initials are handled elsewhere.
        if (seen.has(key)) continue;
        seen.add(key);

        await prisma.plannedAssignment.upsert({
          where: {
            projectId_rawCollaborator_activity_profile: {
              projectId,
              rawCollaborator: part.raw,
              activity,
              profile,
            },
          },
          create: {
            projectId,
            personId: part.personId,
            rawCollaborator: part.raw,
            activity,
            profile,
            plannedFte,
            plannedHours,
            allocatedHours,
            sourceSheet: sheetName,
          },
          update: { personId: part.personId, plannedFte, plannedHours, allocatedHours },
        });
        rows++;
      }
      activities.add(activity);
    }

    // Anyone with cost on the project whom the plan never mentions: their months
    // cannot be narrowed at all, so they need naming explicitly.
    const executing = await prisma.personnelAllocation.groupBy({
      by: ["personId"],
      where: { projectId, personId: { not: null } },
    });
    const planned = new Set(
      (
        await prisma.plannedAssignment.findMany({
          where: { projectId, personId: { not: null } },
          select: { personId: true },
          distinct: ["personId"],
        })
      ).map((p) => p.personId),
    );
    const nameById = new Map(people.map((p) => [p.id, p.name]));
    const missingFromPlan = executing
      .filter((e) => !planned.has(e.personId))
      .map((e) => nameById.get(e.personId!) ?? e.personId!)
      .sort();

    summary.byProject[code] = {
      rows,
      people: personIds.size,
      activities: activities.size,
      unresolvedNames: [...unresolved].sort(),
      missingFromPlan,
    };
  }

  return summary;
}
