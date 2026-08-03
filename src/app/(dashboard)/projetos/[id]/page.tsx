import Link from "next/link";
import { notFound } from "next/navigation";
import { prisma } from "@/lib/db";
import { createBudgetLine, updateBudgetLine } from "../actions";

function eur(value: number) {
  return value.toLocaleString("pt-PT", { style: "currency", currency: "EUR" });
}

export default async function ProjectDetailPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const project = await prisma.project.findUnique({
    where: { id },
    include: {
      budgetLines: { orderBy: { category: "asc" } },
      _count: { select: { invoices: true } },
    },
  });
  if (!project) notFound();

  const unmatchedCount = await prisma.invoice.count({
    where: { projectId: id, matchStatus: { in: ["UNMATCHED", "AMBIGUOUS"] } },
  });

  const totalEligible = project.budgetLines.reduce((s, b) => s + Number(b.eligibleCost), 0);
  const totalExecuted = project.budgetLines.reduce((s, b) => s + Number(b.executedAmount), 0);

  return (
    <div>
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-semibold text-gray-900">{project.name}</h1>
          <p className="text-sm text-gray-500">
            {project.code} · {project.startDate?.toLocaleDateString("pt-PT")} –{" "}
            {project.endDate?.toLocaleDateString("pt-PT")}
          </p>
        </div>
        <Link
          href={`/projetos/${project.id}/faturas`}
          className="rounded-md border border-gray-300 px-4 py-2 text-sm font-medium text-gray-700 hover:bg-gray-50"
        >
          Faturas ({project._count.invoices})
          {unmatchedCount > 0 && (
            <span className="ml-2 rounded-full bg-amber-100 px-2 py-0.5 text-xs font-medium text-amber-700">
              {unmatchedCount} por reconciliar
            </span>
          )}
        </Link>
      </div>

      <dl className="mt-6 grid grid-cols-2 gap-4 sm:grid-cols-3">
        <div className="rounded-lg border border-gray-200 bg-white p-4">
          <dt className="text-xs text-gray-500">Orçamento elegível</dt>
          <dd className="mt-1 text-lg font-semibold text-gray-900">{eur(totalEligible)}</dd>
        </div>
        <div className="rounded-lg border border-gray-200 bg-white p-4">
          <dt className="text-xs text-gray-500">Executado</dt>
          <dd className="mt-1 text-lg font-semibold text-gray-900">{eur(totalExecuted)}</dd>
        </div>
        <div className="rounded-lg border border-gray-200 bg-white p-4">
          <dt className="text-xs text-gray-500">Por executar</dt>
          <dd className="mt-1 text-lg font-semibold text-gray-900">{eur(totalEligible - totalExecuted)}</dd>
        </div>
      </dl>

      <h2 className="mt-8 text-lg font-medium text-gray-900">Rubricas orçamentais</h2>
      <div className="mt-3 overflow-hidden rounded-lg border border-gray-200 bg-white">
        <table className="min-w-full divide-y divide-gray-200 text-sm">
          <thead className="bg-gray-50">
            <tr>
              <th className="px-4 py-2 text-left font-medium text-gray-500">Categoria</th>
              <th className="px-4 py-2 text-left font-medium text-gray-500">Fase TRL</th>
              <th className="px-4 py-2 text-right font-medium text-gray-500">Custo elegível</th>
              <th className="px-4 py-2 text-right font-medium text-gray-500">Financiamento</th>
              <th className="px-4 py-2 text-right font-medium text-gray-500">Executado</th>
              <th className="px-4 py-2 text-right font-medium text-gray-500">Por executar</th>
              <th className="px-4 py-2"></th>
            </tr>
          </thead>
          <tbody className="divide-y divide-gray-100">
            {project.budgetLines.map((line) => {
              const eligibleCost = Number(line.eligibleCost);
              const executedAmount = Number(line.executedAmount);
              const remaining = eligibleCost - executedAmount;
              return (
                <tr key={line.id} className="hover:bg-gray-50">
                  <td className="px-4 py-2 text-gray-900">{line.category}</td>
                  <td className="px-4 py-2 text-gray-500">{line.trlPhase || "—"}</td>
                  <td className="px-4 py-2 text-right text-gray-900">{eur(eligibleCost)}</td>
                  <td className="px-4 py-2 text-right text-gray-500">{eur(Number(line.financingAmount))}</td>
                  <td className="px-4 py-2 text-right text-gray-900">{eur(executedAmount)}</td>
                  <td className={`px-4 py-2 text-right ${remaining < 0 ? "text-red-600" : "text-gray-500"}`}>
                    {eur(remaining)}
                  </td>
                  <td className="px-4 py-2 text-right">
                    <details className="inline-block text-left">
                      <summary className="cursor-pointer text-xs text-gray-400 hover:text-gray-700">editar</summary>
                      <form
                        action={updateBudgetLine}
                        className="absolute z-10 mt-2 w-72 space-y-2 rounded-lg border border-gray-200 bg-white p-3 shadow-lg"
                      >
                        <input type="hidden" name="id" value={line.id} />
                        <label className="block text-xs text-gray-600">
                          Custo elegível
                          <input
                            type="number"
                            step="0.01"
                            name="eligibleCost"
                            defaultValue={eligibleCost}
                            className="mt-1 w-full rounded border border-gray-300 px-2 py-1 text-sm"
                          />
                        </label>
                        <label className="block text-xs text-gray-600">
                          Financiamento
                          <input
                            type="number"
                            step="0.01"
                            name="financingAmount"
                            defaultValue={Number(line.financingAmount)}
                            className="mt-1 w-full rounded border border-gray-300 px-2 py-1 text-sm"
                          />
                        </label>
                        <label className="block text-xs text-gray-600">
                          Motivo da alteração
                          <input
                            name="reason"
                            placeholder="ex: aditamento aprovado em..."
                            className="mt-1 w-full rounded border border-gray-300 px-2 py-1 text-sm"
                          />
                        </label>
                        <button
                          type="submit"
                          className="w-full rounded-md bg-gray-900 px-3 py-1.5 text-xs font-medium text-white hover:bg-gray-800"
                        >
                          Guardar
                        </button>
                      </form>
                    </details>
                  </td>
                </tr>
              );
            })}
            {project.budgetLines.length === 0 && (
              <tr>
                <td colSpan={7} className="px-4 py-6 text-center text-gray-400">
                  Sem rubricas ainda.
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>

      <details className="mt-4 rounded-lg border border-gray-200 bg-white p-4">
        <summary className="cursor-pointer text-sm font-medium text-gray-700">Nova rubrica</summary>
        <form action={createBudgetLine} className="mt-4 grid grid-cols-1 gap-3 sm:grid-cols-2">
          <input type="hidden" name="projectId" value={project.id} />
          <label className="text-sm text-gray-600">
            Categoria
            <input name="category" required className="mt-1 w-full rounded border border-gray-300 px-2 py-1" />
          </label>
          <label className="text-sm text-gray-600">
            Fase TRL (opcional)
            <input name="trlPhase" placeholder="ex: 3-4" className="mt-1 w-full rounded border border-gray-300 px-2 py-1" />
          </label>
          <label className="text-sm text-gray-600">
            Custo elegível
            <input
              type="number"
              step="0.01"
              name="eligibleCost"
              required
              className="mt-1 w-full rounded border border-gray-300 px-2 py-1"
            />
          </label>
          <label className="text-sm text-gray-600">
            Financiamento
            <input
              type="number"
              step="0.01"
              name="financingAmount"
              className="mt-1 w-full rounded border border-gray-300 px-2 py-1"
            />
          </label>
          <div className="sm:col-span-2">
            <button
              type="submit"
              className="rounded-md bg-gray-900 px-4 py-2 text-sm font-medium text-white hover:bg-gray-800"
            >
              Adicionar rubrica
            </button>
          </div>
        </form>
      </details>
    </div>
  );
}
