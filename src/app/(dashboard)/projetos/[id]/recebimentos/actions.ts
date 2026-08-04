"use server";

import { revalidatePath } from "next/cache";
import { prisma } from "@/lib/db";
import { requireUser } from "@/lib/authz";
import type { ProjectionStatus } from "@/generated/prisma/client";

function parseDate(value: FormDataEntryValue | null): Date | null {
  const text = String(value ?? "").trim();
  if (!text) return null;
  const date = new Date(text);
  if (Number.isNaN(date.getTime())) throw new Error("Data inválida");
  return date;
}

function parseAmount(value: FormDataEntryValue | null): number {
  const amount = Number(String(value ?? "").trim());
  if (!Number.isFinite(amount)) throw new Error("Montante inválido");
  return amount;
}

export async function createReceipt(formData: FormData) {
  const user = await requireUser();
  const projectId = String(formData.get("projectId") ?? "");
  const receivedDate = parseDate(formData.get("receivedDate"));
  if (!projectId || !receivedDate) throw new Error("Projeto e data são obrigatórios");

  await prisma.receipt.create({
    data: {
      projectId,
      receivedDate,
      amount: parseAmount(formData.get("amount")),
      description: String(formData.get("description") ?? "").trim() || null,
      paymentRequestId: String(formData.get("paymentRequestId") ?? "") || null,
      notes: String(formData.get("notes") ?? "").trim() || null,
      createdById: user.id,
    },
  });

  revalidatePath(`/projetos/${projectId}/recebimentos`);
}

// Attaching a receipt to a request is the reconciliation step for money in: the
// bank statement names only the project, so the request is chosen here.
export async function linkReceipt(formData: FormData) {
  await requireUser();
  const receiptId = String(formData.get("receiptId") ?? "");
  if (!receiptId) throw new Error("Recebimento é obrigatório");
  const paymentRequestId = String(formData.get("paymentRequestId") ?? "") || null;

  const receipt = await prisma.receipt.update({
    where: { id: receiptId },
    data: { paymentRequestId },
    select: { projectId: true },
  });

  revalidatePath(`/projetos/${receipt.projectId}/recebimentos`);
}

export async function createProjection(formData: FormData) {
  const user = await requireUser();
  const projectId = String(formData.get("projectId") ?? "");
  const projectedDate = parseDate(formData.get("projectedDate"));
  if (!projectId || !projectedDate) throw new Error("Projeto e data são obrigatórios");

  await prisma.receiptProjection.create({
    data: {
      projectId,
      projectedDate,
      projectedAmount: parseAmount(formData.get("projectedAmount")),
      paymentRequestId: String(formData.get("paymentRequestId") ?? "") || null,
      notes: String(formData.get("notes") ?? "").trim() || null,
      createdById: user.id,
    },
  });

  revalidatePath(`/projetos/${projectId}/recebimentos`);
}

// Marking a forecast as met keeps both sides: the forecast is not deleted, it
// points at the receipt that fulfilled it, so expected and actual stay
// comparable after the fact.
export async function realizeProjection(formData: FormData) {
  await requireUser();
  const projectionId = String(formData.get("projectionId") ?? "");
  const receiptId = String(formData.get("realizedReceiptId") ?? "");
  if (!projectionId || !receiptId) {
    throw new Error("Projeção e recebimento são obrigatórios");
  }

  const projection = await prisma.receiptProjection.update({
    where: { id: projectionId },
    data: { realizedReceiptId: receiptId, status: "REALIZED" },
    select: { projectId: true },
  });

  revalidatePath(`/projetos/${projection.projectId}/recebimentos`);
}

const PROJECTION_STATUSES: ProjectionStatus[] = ["FORECAST", "REALIZED", "CANCELLED"];

export async function setProjectionStatus(formData: FormData) {
  await requireUser();
  const projectionId = String(formData.get("projectionId") ?? "");
  const status = String(formData.get("status") ?? "") as ProjectionStatus;
  if (!projectionId) throw new Error("Projeção é obrigatória");
  if (!PROJECTION_STATUSES.includes(status)) throw new Error("Estado inválido");

  const projection = await prisma.receiptProjection.update({
    where: { id: projectionId },
    // Clearing the link when a forecast goes back to pending keeps the two
    // fields from contradicting each other.
    data: { status, ...(status === "REALIZED" ? {} : { realizedReceiptId: null }) },
    select: { projectId: true },
  });

  revalidatePath(`/projetos/${projection.projectId}/recebimentos`);
}
