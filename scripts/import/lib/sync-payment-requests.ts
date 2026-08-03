import { prisma } from "../../../src/lib/db";

// Execution rows carry the funder's payment-request number ("Nº PP"). Derive
// the PaymentRequest records from them rather than assuming a number: the
// request's submitted amount is exactly the sum of the rows it declares.
export async function syncPaymentRequestsFromExecution(projectId: string) {
  const [invoiceGroups, allocationGroups] = await Promise.all([
    prisma.invoice.groupBy({
      by: ["ppNumber"],
      where: { projectId, ppNumber: { not: null } },
      _sum: { eligibleAmount: true },
      _count: { _all: true },
    }),
    prisma.personnelAllocation.groupBy({
      by: ["ppNumber"],
      where: { projectId, ppNumber: { not: null } },
      _sum: { eligibleValue: true },
      _count: { _all: true },
    }),
  ]);

  const totals = new Map<string, { amount: number; rows: number }>();
  for (const g of invoiceGroups) {
    const pp = g.ppNumber!;
    const entry = totals.get(pp) ?? { amount: 0, rows: 0 };
    entry.amount += Number(g._sum.eligibleAmount ?? 0);
    entry.rows += g._count._all;
    totals.set(pp, entry);
  }
  for (const g of allocationGroups) {
    const pp = g.ppNumber!;
    const entry = totals.get(pp) ?? { amount: 0, rows: 0 };
    entry.amount += Number(g._sum.eligibleValue ?? 0);
    entry.rows += g._count._all;
    totals.set(pp, entry);
  }

  const synced: Record<string, number> = {};
  for (const [ppNumber, { amount }] of totals) {
    const request = await prisma.paymentRequest.upsert({
      where: { projectId_ppNumber: { projectId, ppNumber } },
      update: { requestedAmount: amount },
      create: {
        projectId,
        ppNumber,
        requestedAmount: amount,
        notes: "Criado a partir das linhas de execução que declaram este nº de PP.",
      },
    });
    await Promise.all([
      prisma.invoice.updateMany({
        where: { projectId, ppNumber },
        data: { paymentRequestId: request.id },
      }),
      prisma.personnelAllocation.updateMany({
        where: { projectId, ppNumber },
        data: { paymentRequestId: request.id },
      }),
    ]);
    synced[ppNumber] = Math.round(amount * 100) / 100;
  }

  // A request that no longer has any execution row was built on a wrong
  // assumption or a superseded source; report it instead of leaving a stray.
  const orphans = await prisma.paymentRequest.findMany({
    where: {
      projectId,
      ppNumber: { notIn: [...totals.keys()] },
      invoices: { none: {} },
      allocations: { none: {} },
      decisions: { none: {} },
      attachments: { none: {} },
    },
    select: { id: true, ppNumber: true },
  });
  if (orphans.length > 0) {
    await prisma.paymentRequest.deleteMany({ where: { id: { in: orphans.map((o) => o.id) } } });
  }

  return { synced, removedEmpty: orphans.map((o) => o.ppNumber) };
}
