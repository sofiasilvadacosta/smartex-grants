import { prisma } from "./db";

// A budget line where the funder's declared execution and the execution the
// platform holds disagree by more than rounding. Either direction matters: less
// means rows are missing here, more means rows were declared that the funder's
// document doesn't carry (or were rejected).
export interface DeclaredVsExecuted {
  orderNumber: string;
  category: string;
  activity: string;
  declared: number;
  executed: number;
  difference: number;
}

// Cent-level noise from Decimal rounding isn't a divergence worth showing.
const TOLERANCE = 0.01;

export async function declaredVsExecuted(projectId: string): Promise<DeclaredVsExecuted[]> {
  const lines = await prisma.budgetLine.findMany({
    where: { projectId, declaredExecuted: { not: null } },
    select: {
      orderNumber: true,
      category: true,
      activity: true,
      declaredExecuted: true,
      executedAmount: true,
    },
    orderBy: [{ activity: "asc" }, { orderNumber: "asc" }],
  });

  return lines
    .map((line) => {
      const declared = Number(line.declaredExecuted);
      const executed = Number(line.executedAmount);
      return {
        orderNumber: line.orderNumber,
        category: line.category,
        activity: line.activity,
        declared,
        executed,
        difference: Math.round((executed - declared) * 100) / 100,
      };
    })
    .filter((row) => Math.abs(row.difference) > TOLERANCE);
}
