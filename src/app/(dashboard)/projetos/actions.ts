"use server";

import { revalidatePath } from "next/cache";
import { prisma } from "@/lib/db";
import { requireUser } from "@/lib/authz";

function parseDate(value: FormDataEntryValue | null): Date | null {
  const text = String(value ?? "").trim();
  return text ? new Date(text) : null;
}

export async function createProject(formData: FormData) {
  const user = await requireUser();
  const code = String(formData.get("code") ?? "").trim().toUpperCase();
  const name = String(formData.get("name") ?? "").trim();
  const fundingProgram = String(formData.get("fundingProgram") ?? "").trim() || null;
  const startDate = parseDate(formData.get("startDate"));
  const endDate = parseDate(formData.get("endDate"));

  if (!code || !name) throw new Error("Código e nome são obrigatórios");

  await prisma.project.create({
    data: {
      code,
      name,
      fundingProgram,
      startDate,
      endDate,
      createdById: user.id,
      updatedById: user.id,
    },
  });
  revalidatePath("/projetos");
}

export async function createBudgetLine(formData: FormData) {
  const user = await requireUser();
  const projectId = String(formData.get("projectId") ?? "");
  const category = String(formData.get("category") ?? "").trim();
  const trlPhase = String(formData.get("trlPhase") ?? "").trim();
  const activity = String(formData.get("activity") ?? "").trim();
  const financingAmount = Number(formData.get("financingAmount") ?? 0);

  if (!projectId || !category) throw new Error("Projeto e categoria são obrigatórios");

  const project = await prisma.project.findUniqueOrThrow({
    where: { id: projectId },
    select: { fteRate: true },
  });

  // On FTE-based projects the eligible cost is derived from the approved FTE
  // and the project's fixed rate, so it is never typed in by hand.
  const plannedFteInput = String(formData.get("plannedFte") ?? "").trim();
  const plannedFte = plannedFteInput ? Number(plannedFteInput) : null;
  if (plannedFte !== null && (!Number.isFinite(plannedFte) || plannedFte < 0)) {
    throw new Error("FTE aprovado inválido");
  }
  const eligibleCost =
    project.fteRate && plannedFte !== null
      ? Number(project.fteRate) * plannedFte
      : Number(formData.get("eligibleCost") ?? 0);

  const created = await prisma.budgetLine.create({
    data: {
      projectId,
      category,
      trlPhase,
      activity,
      plannedFte,
      eligibleCost,
      financingAmount,
      createdById: user.id,
      updatedById: user.id,
    },
  });
  await prisma.budgetChangeLog.create({
    data: {
      budgetLineId: created.id,
      changeType: "CREATE",
      changedById: user.id,
      newValue: JSON.stringify({ plannedFte, eligibleCost, financingAmount }),
    },
  });
  revalidatePath(`/projetos/${projectId}`);
}

export async function updateBudgetLine(formData: FormData) {
  const user = await requireUser();
  const id = String(formData.get("id") ?? "");
  const eligibleCost = Number(formData.get("eligibleCost") ?? 0);
  const financingAmount = Number(formData.get("financingAmount") ?? 0);
  const reason = String(formData.get("reason") ?? "").trim() || null;

  const existing = await prisma.budgetLine.findUniqueOrThrow({ where: { id } });
  const prevEligible = Number(existing.eligibleCost);
  const prevFinancing = Number(existing.financingAmount);

  if (prevEligible !== eligibleCost || prevFinancing !== financingAmount) {
    await prisma.$transaction([
      prisma.budgetLine.update({
        where: { id },
        data: { eligibleCost, financingAmount, updatedById: user.id },
      }),
      prisma.budgetChangeLog.create({
        data: {
          budgetLineId: id,
          changeType: "UPDATE",
          changedField: "eligibleCost/financingAmount",
          oldValue: JSON.stringify({ eligibleCost: prevEligible, financingAmount: prevFinancing }),
          newValue: JSON.stringify({ eligibleCost, financingAmount }),
          reason,
          changedById: user.id,
        },
      }),
    ]);
  }
  revalidatePath(`/projetos/${existing.projectId}`);
}
