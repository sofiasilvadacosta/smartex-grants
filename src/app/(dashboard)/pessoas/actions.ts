"use server";

import { revalidatePath } from "next/cache";
import { prisma } from "@/lib/db";
import { requireUser } from "@/lib/authz";
import type { AbsenceType } from "@/generated/prisma/client";

const YEAR_MONTH = /^\d{4}-(0[1-9]|1[0-2])$/;

function requireYearMonth(value: FormDataEntryValue | null, field: string): string {
  const text = String(value ?? "").trim();
  if (!YEAR_MONTH.test(text)) throw new Error(`${field} tem de ser um mês no formato AAAA-MM`);
  return text;
}

/**
 * Reads a money/number field. Empty means "not given" (null); anything present
 * has to be a non-negative number, because a negative salary or a negative
 * number of hours is a typo, not a value.
 */
function optionalAmount(value: FormDataEntryValue | null, field: string): number | null {
  const text = String(value ?? "").trim().replace(",", ".");
  if (!text) return null;
  const amount = Number(text);
  if (!Number.isFinite(amount) || amount < 0) throw new Error(`${field} inválido`);
  return amount;
}

const ABSENCE_TYPES = new Set<AbsenceType>(["VACATION", "SICK", "PARENTAL", "UNPAID", "OTHER"]);

export async function saveSalaryRecord(formData: FormData) {
  const user = await requireUser();
  const personId = String(formData.get("personId") ?? "");
  if (!personId) throw new Error("Pessoa em falta");
  const effectiveFrom = requireYearMonth(formData.get("effectiveFrom"), "Mês de início");

  const monthlyBase = optionalAmount(formData.get("monthlyBase"), "RBM elegível");
  const grossAnnual = optionalAmount(formData.get("grossAnnual"), "Salário anual");
  const socialSecurityRate = optionalAmount(formData.get("socialSecurityRate"), "Taxa SS");

  if (monthlyBase === null && grossAnnual === null) {
    throw new Error("Indica pelo menos a RBM elegível ou o salário anual");
  }
  if (socialSecurityRate !== null && socialSecurityRate >= 1) {
    // The sheets store 0,2375 rather than 23,75, and the cost formula multiplies
    // by (1 + rate) — a value of 23.75 would inflate every cost 25-fold.
    throw new Error("A taxa de SS é uma fração (0,2375 para 23,75%)");
  }

  // Upsert, not create: correcting a month replaces its record rather than
  // leaving two rows claiming to be in force at the same time.
  await prisma.salaryRecord.upsert({
    where: { personId_effectiveFrom: { personId, effectiveFrom } },
    create: {
      personId,
      effectiveFrom,
      monthlyBase,
      grossAnnual,
      socialSecurityRate,
      reason: String(formData.get("reason") ?? "").trim() || null,
      createdById: user.id,
    },
    update: {
      monthlyBase,
      grossAnnual,
      socialSecurityRate,
      reason: String(formData.get("reason") ?? "").trim() || null,
      createdById: user.id,
    },
  });
  revalidatePath(`/pessoas/${personId}`);
  revalidatePath("/pessoas");
}

export async function deleteSalaryRecord(formData: FormData) {
  await requireUser();
  const id = String(formData.get("id") ?? "");
  if (!id) throw new Error("Registo em falta");
  const record = await prisma.salaryRecord.delete({ where: { id } });
  revalidatePath(`/pessoas/${record.personId}`);
  revalidatePath("/pessoas");
}

export async function saveAbsence(formData: FormData) {
  const user = await requireUser();
  const personId = String(formData.get("personId") ?? "");
  if (!personId) throw new Error("Pessoa em falta");
  const yearMonth = requireYearMonth(formData.get("yearMonth"), "Mês");

  const type = String(formData.get("type") ?? "") as AbsenceType;
  if (!ABSENCE_TYPES.has(type)) throw new Error("Tipo de ausência inválido");

  const days = optionalAmount(formData.get("days"), "Dias");
  if (days === null || days <= 0) throw new Error("Indica quantos dias úteis de ausência");
  if (days > 31) throw new Error("Um mês não tem mais de 31 dias úteis de ausência");

  await prisma.absence.create({
    data: {
      personId,
      yearMonth,
      type,
      days,
      notes: String(formData.get("notes") ?? "").trim() || null,
      createdById: user.id,
    },
  });
  revalidatePath(`/pessoas/${personId}`);
}

export async function deleteAbsence(formData: FormData) {
  await requireUser();
  const id = String(formData.get("id") ?? "");
  if (!id) throw new Error("Ausência em falta");
  const absence = await prisma.absence.delete({ where: { id } });
  revalidatePath(`/pessoas/${absence.personId}`);
}

/**
 * Hours in a month this person owes to work outside the funded projects. Stored
 * on the capacity row, which is created if the month has none yet.
 */
export async function saveNonProjectHours(formData: FormData) {
  await requireUser();
  const personId = String(formData.get("personId") ?? "");
  if (!personId) throw new Error("Pessoa em falta");
  const yearMonth = requireYearMonth(formData.get("yearMonth"), "Mês");
  const nonProjectHours = optionalAmount(formData.get("nonProjectHours"), "Horas fora de projetos");

  // A capacity row may not exist for the month yet (the import only created rows
  // the planning sheet had), so fall back to the global calendar for the
  // productive hours this row requires.
  const calendar = await prisma.workCalendar.findUnique({ where: { yearMonth } });

  await prisma.personMonthCapacity.upsert({
    where: { personId_yearMonth: { personId, yearMonth } },
    create: {
      personId,
      yearMonth,
      productiveHours: calendar?.availableHours ?? 0,
      nonProjectHours,
    },
    update: { nonProjectHours },
  });
  revalidatePath(`/pessoas/${personId}`);
}
