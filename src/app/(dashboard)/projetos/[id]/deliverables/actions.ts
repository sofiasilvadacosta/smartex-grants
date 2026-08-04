"use server";

import { revalidatePath } from "next/cache";
import { prisma } from "@/lib/db";
import { requireUser } from "@/lib/authz";
import type { DeliverableStatus, DeliverableType } from "@/generated/prisma/client";

const TYPES: DeliverableType[] = ["DELIVERABLE", "MILESTONE"];
const STATUSES: DeliverableStatus[] = ["PLANNED", "IN_PROGRESS", "DONE", "CANCELLED"];

function parseDate(value: FormDataEntryValue | null): Date | null {
  const text = String(value ?? "").trim();
  if (!text) return null;
  const date = new Date(text);
  if (Number.isNaN(date.getTime())) throw new Error("Data inválida");
  return date;
}

export async function createDeliverable(formData: FormData) {
  const user = await requireUser();
  const projectId = String(formData.get("projectId") ?? "");
  const name = String(formData.get("name") ?? "").trim();
  const type = String(formData.get("type") ?? "DELIVERABLE") as DeliverableType;
  if (!projectId || !name) throw new Error("Projeto e nome são obrigatórios");
  if (!TYPES.includes(type)) throw new Error("Tipo inválido");

  await prisma.deliverable.create({
    data: {
      projectId,
      name,
      type,
      activity: String(formData.get("activity") ?? "").trim(),
      dueDate: parseDate(formData.get("dueDate")),
      responsiblePersonId: String(formData.get("responsiblePersonId") ?? "") || null,
      notes: String(formData.get("notes") ?? "").trim() || null,
      createdById: user.id,
    },
  });

  revalidatePath(`/projetos/${projectId}/deliverables`);
}

export async function updateDeliverableStatus(formData: FormData) {
  await requireUser();
  const deliverableId = String(formData.get("deliverableId") ?? "");
  const status = String(formData.get("status") ?? "") as DeliverableStatus;
  if (!deliverableId) throw new Error("Deliverable é obrigatório");
  if (!STATUSES.includes(status)) throw new Error("Estado inválido");

  const deliverable = await prisma.deliverable.update({
    where: { id: deliverableId },
    data: {
      status,
      // Completion date follows the status rather than being entered twice:
      // set on the day it is marked done, cleared if it is reopened.
      completionDate: status === "DONE" ? new Date() : null,
    },
    select: { projectId: true },
  });

  revalidatePath(`/projetos/${deliverable.projectId}/deliverables`);
}

export async function deleteDeliverable(formData: FormData) {
  await requireUser();
  const deliverableId = String(formData.get("deliverableId") ?? "");
  if (!deliverableId) throw new Error("Deliverable é obrigatório");

  const deliverable = await prisma.deliverable.delete({
    where: { id: deliverableId },
    select: { projectId: true },
  });

  revalidatePath(`/projetos/${deliverable.projectId}/deliverables`);
}
