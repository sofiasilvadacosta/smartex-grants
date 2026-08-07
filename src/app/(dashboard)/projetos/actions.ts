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

// The two fields the funder's forms identify a project by. Kept editable rather
// than seeded, because guessing a programme wrong puts a wrong programme on a
// submitted form — worse than a blank one somebody has to fill in.
export async function updateProjectIdentity(formData: FormData) {
  const user = await requireUser();
  const id = String(formData.get("id") ?? "");
  if (!id) throw new Error("Projeto em falta");

  const fundingProgram = String(formData.get("fundingProgram") ?? "").trim() || null;
  const externalNumber = String(formData.get("externalNumber") ?? "").trim() || null;
  if (externalNumber && !/^[\w./-]{1,32}$/.test(externalNumber)) {
    throw new Error("Número do projeto inválido");
  }

  // Entered as a percentage because that is how the funder writes it, stored as
  // a fraction because that is how it is multiplied.
  const rateInput = String(formData.get("incentiveRate") ?? "").trim().replace(",", ".");
  let incentiveRate: number | null = null;
  if (rateInput) {
    const percent = Number(rateInput);
    if (!Number.isFinite(percent) || percent < 0 || percent > 100) {
      throw new Error("Taxa de incentivo tem de ser uma percentagem entre 0 e 100");
    }
    incentiveRate = percent / 100;
  }

  await prisma.project.update({
    where: { id },
    data: { fundingProgram, externalNumber, incentiveRate, updatedById: user.id },
  });
  revalidatePath(`/projetos/${id}`);
  revalidatePath("/projetos");
}

// Take a project out of the platform's scope, or bring it back. Excluded
// projects keep every row they have — this only stops them being counted and
// shown as if they were being managed here.
export async function setProjectExcluded(formData: FormData) {
  const user = await requireUser();
  const id = String(formData.get("id") ?? "");
  const excluded = String(formData.get("excluded") ?? "") === "true";
  if (!id) throw new Error("Projeto em falta");

  const project = await prisma.project.findUniqueOrThrow({
    where: { id },
    select: { status: true },
  });
  // Reopening restores ACTIVE rather than guessing at CLOSED: a project someone
  // is putting back into scope is one they intend to work on.
  if (excluded && project.status === "CLOSED") {
    throw new Error("Um projeto fechado já não conta para o dashboard");
  }

  await prisma.project.update({
    where: { id },
    data: { status: excluded ? "EXCLUDED" : "ACTIVE", updatedById: user.id },
  });
  revalidatePath("/projetos");
  revalidatePath("/");
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
