import { existsSync, readFileSync, statSync } from "node:fs";
import path from "node:path";
import { prisma } from "../../src/lib/db";

// A funder decision on a payment request, transcribed from the analysis
// document ("Fundamentação da análise") together with the document itself.
//
// The figures are typed in rather than parsed: these are prose documents with
// no fixed layout, one per request a few times a year, and a wrong number read
// from a mis-parsed sentence would be worse than a wrong number nobody typed.
// The document is attached so the source of every figure stays one click away.
export interface DecisionInput {
  ppNumber: string;
  decisionDate: string;
  status: "APROVADO" | "PARCIAL" | "REJEITADO" | "PENDING";
  // Eligible expense the funder validated, before the incentive rate.
  approvedAmount: number;
  notes: string;
  // Relative to the imports directory; skipped when absent.
  documentFile?: string;
}

export interface DecisionImportSummary {
  created: number;
  updated: number;
  attached: string[];
  // Requests named by a decision that do not exist for this project.
  unknownPaymentRequests: string[];
}

export async function importDecisoes(
  importsDir: string,
  projectId: string,
  decisions: DecisionInput[],
): Promise<DecisionImportSummary> {
  const summary: DecisionImportSummary = {
    created: 0,
    updated: 0,
    attached: [],
    unknownPaymentRequests: [],
  };

  for (const decision of decisions) {
    const request = await prisma.paymentRequest.findUnique({
      where: { projectId_ppNumber: { projectId, ppNumber: decision.ppNumber } },
      select: { id: true },
    });
    if (!request) {
      summary.unknownPaymentRequests.push(decision.ppNumber);
      continue;
    }

    const data = {
      decisionDate: new Date(`${decision.decisionDate}T00:00:00Z`),
      status: decision.status,
      approvedAmount: decision.approvedAmount,
      notes: decision.notes,
      isCurrent: true,
    };

    // One decision per request per date; a re-run updates it in place rather
    // than stacking duplicates. A later revision is a different date and so
    // becomes a second row, which is why isCurrent exists.
    const existing = await prisma.paymentDecision.findFirst({
      where: { paymentRequestId: request.id, decisionDate: data.decisionDate },
      select: { id: true },
    });
    if (existing) {
      await prisma.paymentDecision.update({ where: { id: existing.id }, data });
      summary.updated++;
    } else {
      await prisma.paymentDecision.create({ data: { paymentRequestId: request.id, ...data } });
      summary.created++;
    }

    if (!decision.documentFile) continue;
    const filePath = path.join(importsDir, decision.documentFile);
    if (!existsSync(filePath)) continue;

    const content = readFileSync(filePath);
    const filename = path.basename(filePath);
    const attachment = await prisma.attachment.findFirst({
      where: { paymentRequestId: request.id, kind: "DECISION_DOC", filename },
      select: { id: true },
    });
    const attachmentData = {
      filename,
      mimeType: "application/pdf",
      sizeBytes: statSync(filePath).size,
      content,
    };
    if (attachment) {
      await prisma.attachment.update({ where: { id: attachment.id }, data: attachmentData });
    } else {
      await prisma.attachment.create({
        data: { paymentRequestId: request.id, kind: "DECISION_DOC", ...attachmentData },
      });
    }
    summary.attached.push(`PP ${decision.ppNumber}: ${filename}`);
  }

  return summary;
}
