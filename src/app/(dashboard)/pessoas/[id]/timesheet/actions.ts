"use server";

import { revalidatePath } from "next/cache";
import { prisma } from "@/lib/db";
import { requireUser } from "@/lib/authz";

const YEAR_MONTH = /^\d{4}-(0[1-9]|1[0-2])$/;

function parseHours(value: FormDataEntryValue | null): number {
  const text = String(value ?? "").trim().replace(",", ".");
  if (!text) return 0;
  const hours = Number(text);
  if (!Number.isFinite(hours) || hours < 0) throw new Error("Horas inválidas");
  return hours;
}

/**
 * Saves one row of the timesheet — a person's hours on one project activity
 * across the twelve months of a year.
 *
 * A whole row at a time, not a cell at a time, because the funder's form is read
 * and corrected by row and a save per cell would mean twelve round trips to fix
 * one activity.
 *
 * No balance check here: the form's rule is that each *month* adds up, which
 * cannot be judged from one row, and blocking a save halfway through filling a
 * year would make the screen unusable. The page reports every unbalanced month
 * instead, and says the form cannot be submitted until they are all zero.
 */
export async function saveTimesheetRow(formData: FormData) {
  await requireUser();

  const personId = String(formData.get("personId") ?? "");
  const projectId = String(formData.get("projectId") ?? "");
  const activity = String(formData.get("activity") ?? "").trim();
  const year = Number(String(formData.get("year") ?? ""));
  if (!personId || !projectId) throw new Error("Pessoa e projeto são obrigatórios");
  if (!Number.isInteger(year) || year < 2000 || year > 2100) throw new Error("Ano inválido");

  // One transaction for the whole row: a partly-saved year would leave the
  // month totals wrong with nothing on screen to say so.
  await prisma.$transaction(async (tx) => {
    for (let month = 1; month <= 12; month++) {
      const yearMonth = `${year}-${String(month).padStart(2, "0")}`;
      if (!YEAR_MONTH.test(yearMonth)) throw new Error("Mês inválido");
      const hours = parseHours(formData.get(`hours-${month}`));
      const key = { personId, projectId, yearMonth, activity };

      if (hours === 0) {
        // A cleared cell removes the row rather than storing a zero, so the
        // timesheet shows only activities actually worked — as the form does.
        await tx.projectHoursAllocation.deleteMany({ where: key });
      } else {
        await tx.projectHoursAllocation.upsert({
          where: { personId_projectId_yearMonth_activity: key },
          create: { ...key, hours },
          update: { hours },
        });
      }
    }
  });

  revalidatePath(`/pessoas/${personId}/timesheet`);
  revalidatePath(`/pessoas/${personId}`);
  revalidatePath(`/projetos/${projectId}/alocacao`);
  revalidatePath("/pessoas");
}

/**
 * "Outras atividades" and absences for one month — the two lines of the form that
 * belong to the person rather than to a project.
 */
export async function saveTimesheetMonthContext(formData: FormData) {
  await requireUser();

  const personId = String(formData.get("personId") ?? "");
  const yearMonth = String(formData.get("yearMonth") ?? "").trim();
  if (!personId) throw new Error("Pessoa em falta");
  if (!YEAR_MONTH.test(yearMonth)) throw new Error("Mês tem de estar no formato AAAA-MM");

  const otherHours = parseHours(formData.get("otherHours"));

  const calendar = await prisma.workCalendar.findUnique({ where: { yearMonth } });
  await prisma.personMonthCapacity.upsert({
    where: { personId_yearMonth: { personId, yearMonth } },
    create: {
      personId,
      yearMonth,
      productiveHours: calendar?.availableHours ?? 0,
      nonProjectHours: otherHours === 0 ? null : otherHours,
    },
    update: { nonProjectHours: otherHours === 0 ? null : otherHours },
  });

  revalidatePath(`/pessoas/${personId}/timesheet`);
  revalidatePath(`/pessoas/${personId}`);
  revalidatePath("/pessoas");
}

/**
 * Adds an activity row to a project block so hours can be typed into it. Creating
 * it with no hours would leave nothing to store, so the row is created for the
 * month the user names, with the hours they give.
 */
export async function addTimesheetActivity(formData: FormData) {
  await requireUser();

  const personId = String(formData.get("personId") ?? "");
  const projectId = String(formData.get("projectId") ?? "");
  const activity = String(formData.get("activity") ?? "").trim();
  const yearMonth = String(formData.get("yearMonth") ?? "").trim();
  const hours = parseHours(formData.get("hours"));

  if (!personId || !projectId) throw new Error("Pessoa e projeto são obrigatórios");
  if (!activity) throw new Error("Indica a atividade");
  if (!YEAR_MONTH.test(yearMonth)) throw new Error("Mês tem de estar no formato AAAA-MM");
  if (hours <= 0) throw new Error("Indica quantas horas");

  const key = { personId, projectId, yearMonth, activity };
  await prisma.projectHoursAllocation.upsert({
    where: { personId_projectId_yearMonth_activity: key },
    create: { ...key, hours },
    update: { hours },
  });

  revalidatePath(`/pessoas/${personId}/timesheet`);
  revalidatePath(`/pessoas/${personId}`);
  revalidatePath(`/projetos/${projectId}/alocacao`);
}
