"use server";

import { revalidatePath } from "next/cache";
import { prisma } from "@/lib/db";
import { requireUser } from "@/lib/authz";
import type { AttachmentKind, DecisionStatus } from "@/generated/prisma/client";

// Serverless request bodies are capped well below this, but validate anyway so
// an oversized upload fails with a clear message instead of a platform error.
const MAX_UPLOAD_BYTES = 4 * 1024 * 1024;

const ALLOWED_MIME_TYPES = new Set([
  "application/pdf",
  "application/msword",
  "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
]);

const DECISION_STATUSES: DecisionStatus[] = ["PENDING", "APROVADO", "PARCIAL", "REJEITADO"];
const ATTACHMENT_KINDS: AttachmentKind[] = ["REQUEST_DOC", "DECISION_DOC"];

function parseDate(value: FormDataEntryValue | null): Date | null {
  const text = String(value ?? "").trim();
  return text ? new Date(text) : null;
}

function parseAmount(value: FormDataEntryValue | null): number | null {
  const text = String(value ?? "").trim();
  if (!text) return null;
  const n = Number(text);
  if (!Number.isFinite(n)) throw new Error("Montante inválido");
  return n;
}

export async function createPaymentRequest(formData: FormData) {
  const user = await requireUser();
  const projectId = String(formData.get("projectId") ?? "");
  const ppNumber = String(formData.get("ppNumber") ?? "").trim();
  if (!projectId || !ppNumber) throw new Error("Projeto e número de PP são obrigatórios");

  await prisma.paymentRequest.create({
    data: {
      projectId,
      ppNumber,
      submissionDate: parseDate(formData.get("submissionDate")),
      requestedAmount: parseAmount(formData.get("requestedAmount")),
      notes: String(formData.get("notes") ?? "").trim() || null,
      createdById: user.id,
    },
  });

  revalidatePath(`/projetos/${projectId}/pedidos-pagamento`);
}

export async function recordDecision(formData: FormData) {
  const user = await requireUser();
  const paymentRequestId = String(formData.get("paymentRequestId") ?? "");
  const status = String(formData.get("status") ?? "") as DecisionStatus;
  if (!paymentRequestId) throw new Error("Pedido de pagamento é obrigatório");
  if (!DECISION_STATUSES.includes(status)) throw new Error("Estado da decisão inválido");

  const request = await prisma.paymentRequest.findUniqueOrThrow({
    where: { id: paymentRequestId },
    select: { projectId: true },
  });

  // A new decision supersedes the previous one but the old row is kept, so an
  // appealed or revised decision keeps its history.
  await prisma.$transaction([
    prisma.paymentDecision.updateMany({
      where: { paymentRequestId, isCurrent: true },
      data: { isCurrent: false },
    }),
    prisma.paymentDecision.create({
      data: {
        paymentRequestId,
        status,
        decisionDate: parseDate(formData.get("decisionDate")),
        approvedAmount: parseAmount(formData.get("approvedAmount")),
        notes: String(formData.get("notes") ?? "").trim() || null,
        isCurrent: true,
        createdById: user.id,
      },
    }),
  ]);

  revalidatePath(`/projetos/${request.projectId}/pedidos-pagamento`);
}

export async function uploadAttachment(formData: FormData) {
  const user = await requireUser();
  const paymentRequestId = String(formData.get("paymentRequestId") ?? "");
  const kind = String(formData.get("kind") ?? "") as AttachmentKind;
  const file = formData.get("file");

  if (!paymentRequestId) throw new Error("Pedido de pagamento é obrigatório");
  if (!ATTACHMENT_KINDS.includes(kind)) throw new Error("Tipo de documento inválido");
  if (!(file instanceof File) || file.size === 0) throw new Error("Escolhe um ficheiro");
  if (file.size > MAX_UPLOAD_BYTES) {
    throw new Error(`Ficheiro demasiado grande (máximo ${MAX_UPLOAD_BYTES / 1024 / 1024} MB)`);
  }
  if (!ALLOWED_MIME_TYPES.has(file.type)) {
    throw new Error("Só são aceites ficheiros PDF ou Word");
  }

  const request = await prisma.paymentRequest.findUniqueOrThrow({
    where: { id: paymentRequestId },
    select: { projectId: true },
  });

  await prisma.attachment.create({
    data: {
      paymentRequestId,
      kind,
      // Strip any directory component a browser might send so the stored name
      // can never be interpreted as a path.
      filename: file.name.replace(/^.*[\\/]/, "").slice(0, 255),
      mimeType: file.type,
      sizeBytes: file.size,
      content: Buffer.from(await file.arrayBuffer()),
      uploadedById: user.id,
    },
  });

  revalidatePath(`/projetos/${request.projectId}/pedidos-pagamento`);
}

export async function deleteAttachment(formData: FormData) {
  await requireUser();
  const attachmentId = String(formData.get("attachmentId") ?? "");
  if (!attachmentId) throw new Error("Documento é obrigatório");

  const attachment = await prisma.attachment.findUniqueOrThrow({
    where: { id: attachmentId },
    select: { paymentRequest: { select: { projectId: true } } },
  });

  await prisma.attachment.delete({ where: { id: attachmentId } });
  revalidatePath(`/projetos/${attachment.paymentRequest.projectId}/pedidos-pagamento`);
}

// Links every invoice and RH row already tagged with this PP number in the
// source data to the PaymentRequest record, so the PP rolls up against real
// execution instead of a hand-typed total.
export async function linkRowsByPpNumber(formData: FormData) {
  await requireUser();
  const paymentRequestId = String(formData.get("paymentRequestId") ?? "");
  if (!paymentRequestId) throw new Error("Pedido de pagamento é obrigatório");

  const request = await prisma.paymentRequest.findUniqueOrThrow({
    where: { id: paymentRequestId },
    select: { projectId: true, ppNumber: true },
  });

  await prisma.$transaction([
    prisma.invoice.updateMany({
      where: { projectId: request.projectId, ppNumber: request.ppNumber },
      data: { paymentRequestId },
    }),
    prisma.personnelAllocation.updateMany({
      where: { projectId: request.projectId, ppNumber: request.ppNumber },
      data: { paymentRequestId },
    }),
  ]);

  revalidatePath(`/projetos/${request.projectId}/pedidos-pagamento`);
}
