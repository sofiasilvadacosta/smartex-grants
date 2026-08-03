import Link from "next/link";
import { prisma } from "@/lib/db";
import { eur } from "@/lib/format";

export default async function DashboardPage() {
  const projects = await prisma.project.findMany({
    include: { budgetLines: true },
    orderBy: { name: "asc" },
  });

  const [invoiceCounts, allocationCounts] = await Promise.all([
    prisma.invoice.groupBy({
      by: ["projectId"],
      where: { matchStatus: { in: ["UNMATCHED", "AMBIGUOUS"] } },
      _count: { _all: true },
    }),
    prisma.personnelAllocation.groupBy({
      by: ["projectId"],
      where: { matchStatus: { in: ["UNMATCHED", "AMBIGUOUS"] } },
      _count: { _all: true },
    }),
  ]);
  const unmatchedByProject = new Map<string, number>();
  for (const row of [...invoiceCounts, ...allocationCounts]) {
    unmatchedByProject.set(
      row.projectId,
      (unmatchedByProject.get(row.projectId) ?? 0) + row._count._all,
    );
  }

  return (
    <div>
      <h1 className="text-2xl font-semibold text-gray-900">Dashboard</h1>
      <p className="mt-1 text-sm text-gray-500">
        Orçamento vs. execução por projeto.
      </p>

      {projects.length === 0 ? (
        <p className="mt-8 text-sm text-gray-500">
          Ainda não há projetos importados.{" "}
          <Link href="/projetos" className="underline">
            Criar o primeiro projeto
          </Link>
          .
        </p>
      ) : (
        <div className="mt-6 grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-3">
          {projects.map((project) => {
            const eligibleCost = project.budgetLines.reduce(
              (sum, b) => sum + Number(b.eligibleCost),
              0,
            );
            const executed = project.budgetLines.reduce(
              (sum, b) => sum + Number(b.executedAmount),
              0,
            );
            const pct = eligibleCost > 0 ? Math.round((executed / eligibleCost) * 100) : 0;
            const unmatched = unmatchedByProject.get(project.id) ?? 0;

            return (
              <Link
                key={project.id}
                href={`/projetos/${project.id}`}
                className="rounded-lg border border-gray-200 bg-white p-5 hover:border-gray-300"
              >
                <div className="flex items-center justify-between">
                  <h2 className="font-medium text-gray-900">{project.name}</h2>
                  <span className="text-xs text-gray-400">{project.status}</span>
                </div>
                <dl className="mt-3 space-y-1 text-sm">
                  <div className="flex justify-between">
                    <dt className="text-gray-500">Orçamento elegível</dt>
                    <dd className="font-medium text-gray-900">
                      {eur(eligibleCost)}
                    </dd>
                  </div>
                  <div className="flex justify-between">
                    <dt className="text-gray-500">Executado</dt>
                    <dd className="font-medium text-gray-900">
                      {eur(executed)}{" "}
                      <span className="text-gray-400">({pct}%)</span>
                    </dd>
                  </div>
                  <div className="flex justify-between">
                    <dt className="text-gray-500">Linhas por reconciliar</dt>
                    <dd className={unmatched > 0 ? "font-medium text-amber-600" : "text-gray-400"}>
                      {unmatched}
                    </dd>
                  </div>
                </dl>
              </Link>
            );
          })}
        </div>
      )}
    </div>
  );
}
