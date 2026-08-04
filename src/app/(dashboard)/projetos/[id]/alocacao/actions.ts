"use server";

import { revalidatePath } from "next/cache";
import { prisma } from "@/lib/db";
import { requireUser } from "@/lib/authz";
import { capacityWith } from "@/lib/capacity";
import { loadCapacity } from "@/lib/capacity-data";

const YEAR_MONTH = /^\d{4}-(0[1-9]|1[0-2])$/;

/**
 * Promise a person a number of hours on this project in a month, or take the
 * promise back with 0.
 *
 * Going over the person's available hours is refused unless the caller ticked
 * "allowOver". The check is the reason this screen exists, so it cannot be a
 * message that appears after the fact — but it also cannot be absolute: real
 * months do get over-committed on purpose, and the platform should record that
 * rather than force it into a spreadsheet on the side.
 */
export async function saveProjectAllocation(formData: FormData) {
  await requireUser();

  const projectId = String(formData.get("projectId") ?? "");
  const personId = String(formData.get("personId") ?? "");
  const yearMonth = String(formData.get("yearMonth") ?? "").trim();
  if (!projectId || !personId) throw new Error("Projeto e pessoa são obrigatórios");
  if (!YEAR_MONTH.test(yearMonth)) throw new Error("Mês tem de estar no formato AAAA-MM");

  const raw = String(formData.get("hours") ?? "").trim().replace(",", ".");
  const requested = raw === "" ? 0 : Number(raw);
  if (!Number.isFinite(requested) || requested < 0) throw new Error("Horas inválidas");

  const allowOver = String(formData.get("allowOver") ?? "") === "true";

  const [person, view, byActivity] = await Promise.all([
    prisma.person.findUniqueOrThrow({ where: { id: personId }, select: { name: true } }),
    loadCapacity({ personIds: [personId], months: [yearMonth] }),
    prisma.projectHoursAllocation.findMany({
      where: { personId, projectId, yearMonth, activity: { not: "" } },
      select: { activity: true },
    }),
  ]);

  // This screen holds one number per project, which the timesheet splits by
  // activity. Writing that single number here while activity rows exist would
  // add a second, project-level row on top of them and double the month.
  if (byActivity.length > 0) {
    throw new Error(
      `As horas de ${person.name} em ${yearMonth} neste projeto estão repartidas por ` +
        `${byActivity.length} atividade(s), como o mapa de horas exige. Edita-as na timesheet ` +
        `da pessoa — aqui só se conseguiria gravar um total, que ficaria a somar por cima.`,
    );
  }

  const existing = view.get(personId, yearMonth);
  // A month with no capacity row and no allocation yet still has the global
  // calendar behind it, so fall back to it rather than treating it as zero hours.
  const calendar = existing
    ? null
    : await prisma.workCalendar.findUnique({ where: { yearMonth } });

  const next = capacityWith(
    {
      yearMonth,
      calendarHours: calendar?.availableHours ?? null,
      productiveHours: existing?.baseHours ?? null,
      nonProjectHours: existing?.reservedHours ?? null,
      absenceDays: existing?.absenceDays ?? 0,
      allocatedByProject: existing?.allocatedByProject,
    },
    projectId,
    requested,
  );

  if (next.overAllocatedBy > 0 && !allowOver) {
    const otherProjects = next.allocatedHours - requested;
    throw new Error(
      `${person.name} ficaria com ${next.allocatedHours.toFixed(1)} h em ${yearMonth} para ` +
        `${next.availableHours.toFixed(1)} h disponíveis ` +
        `(${otherProjects.toFixed(1)} h noutros projetos, ${next.absenceHours.toFixed(1)} h de ` +
        `ausências, ${next.reservedHours.toFixed(1)} h fora de projetos). ` +
        `Reduz as horas ou marca "permitir acima de 100%".`,
    );
  }

  const key = { personId, projectId, yearMonth, activity: "" };
  if (requested === 0) {
    // deleteMany, not delete: removing a promise that was never made must not be
    // an error, so the "clear this cell" path stays idempotent.
    await prisma.projectHoursAllocation.deleteMany({ where: key });
  } else {
    await prisma.projectHoursAllocation.upsert({
      where: { personId_projectId_yearMonth_activity: key },
      create: { ...key, hours: requested },
      update: { hours: requested },
    });
  }

  revalidatePath(`/projetos/${projectId}/alocacao`);
  revalidatePath(`/pessoas/${personId}`);
  revalidatePath("/pessoas");
}
