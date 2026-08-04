import { prisma } from "./db";

// What a project is still owed, per payment request. Derived rather than stored:
// a request's approved amount comes from the funder's decision and what came in
// comes from the bank, so the difference is always a computation over those two
// and can never drift out of step with them.
export interface OutstandingRequest {
  paymentRequestId: string;
  ppNumber: string;
  // The current decision's approved amount, null while the funder has not ruled.
  approvedAmount: number | null;
  // What the funder says it paid, when the document states it.
  paidAmount: number | null;
  // Sum of the receipts actually linked to this request.
  receivedAmount: number;
  status: string | null;
  decisionDate: Date | null;
}

export interface ProjectReceiptsSummary {
  receivedTotal: number;
  // Receipts whose payment request could not be established.
  unlinkedTotal: number;
  requests: OutstandingRequest[];
  // Approved but not yet in the bank, across requests with a decision.
  outstandingTotal: number;
  forecastTotal: number;
}

// What is still to come in on a request, or null when the question does not
// apply. The funder's stated paid amount is the better measure than the approved
// one when it exists, because the approved figure includes indirect costs and
// offsets that the payment itself resolves. A *negative* paid amount is one of
// those offsets — the funder recovering part of an advance — and is not an
// amount receivable, so it yields null rather than a negative "still to come".
export function outstandingFor(row: OutstandingRequest): number | null {
  const due = row.paidAmount ?? row.approvedAmount;
  if (due === null || due < 0) return null;
  const gap = due - row.receivedAmount;
  return gap > 0.01 ? Math.round(gap * 100) / 100 : 0;
}

export async function projectReceipts(projectId: string): Promise<ProjectReceiptsSummary> {
  const [requests, receiptTotals, unlinked, forecasts] = await Promise.all([
    prisma.paymentRequest.findMany({
      where: { projectId },
      select: {
        id: true,
        ppNumber: true,
        paidAmount: true,
        // Revisions and appeals are kept as extra rows, so only the current
        // decision defines what was approved.
        decisions: {
          where: { isCurrent: true },
          orderBy: { decisionDate: "desc" },
          take: 1,
          select: { status: true, approvedAmount: true, decisionDate: true },
        },
      },
    }),
    prisma.receipt.groupBy({
      by: ["paymentRequestId"],
      where: { projectId, paymentRequestId: { not: null } },
      _sum: { amount: true },
    }),
    prisma.receipt.aggregate({
      where: { projectId, paymentRequestId: null },
      _sum: { amount: true },
    }),
    prisma.receiptProjection.aggregate({
      where: { projectId, status: "FORECAST" },
      _sum: { projectedAmount: true },
    }),
  ]);

  const receivedByRequest = new Map(
    receiptTotals.map((row) => [row.paymentRequestId!, Number(row._sum.amount ?? 0)]),
  );

  const rows: OutstandingRequest[] = requests
    .map((request) => {
      const decision = request.decisions[0];
      return {
        paymentRequestId: request.id,
        ppNumber: request.ppNumber,
        approvedAmount: decision?.approvedAmount === undefined ? null : Number(decision.approvedAmount),
        paidAmount: request.paidAmount === null ? null : Number(request.paidAmount),
        receivedAmount: receivedByRequest.get(request.id) ?? 0,
        status: decision?.status ?? null,
        decisionDate: decision?.decisionDate ?? null,
      };
    })
    .sort((a, b) => {
      const numA = Number(a.ppNumber);
      const numB = Number(b.ppNumber);
      if (Number.isFinite(numA) && Number.isFinite(numB) && numA !== numB) return numA - numB;
      return a.ppNumber.localeCompare(b.ppNumber, "pt");
    });

  const outstandingTotal = rows.reduce(
    (sum, row) => sum + (outstandingFor(row) ?? 0),
    0,
  );

  const receivedTotal =
    [...receivedByRequest.values()].reduce((s, v) => s + v, 0) + Number(unlinked._sum.amount ?? 0);

  return {
    receivedTotal: Math.round(receivedTotal * 100) / 100,
    unlinkedTotal: Math.round(Number(unlinked._sum.amount ?? 0) * 100) / 100,
    requests: rows,
    outstandingTotal: Math.round(outstandingTotal * 100) / 100,
    forecastTotal: Math.round(Number(forecasts._sum.projectedAmount ?? 0) * 100) / 100,
  };
}
