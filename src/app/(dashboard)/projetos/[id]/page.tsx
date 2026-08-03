import Link from "next/link";
import { notFound } from "next/navigation";
import { prisma } from "@/lib/db";
import { declaredVsExecuted } from "@/lib/declared-vs-executed";
import { budgetLineLabel, eur } from "@/lib/format";
import { createBudgetLine, updateBudgetLine } from "../actions";

export default async function ProjectDetailPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const project = await prisma.project.findUnique({
    where: { id },
    include: {
      budgetLines: {
        orderBy: [{ activity: "asc" }, { orderNumber: "asc" }, { category: "asc" }],
      },
      _count: { select: { invoices: true, allocations: true, paymentRequests: true } },
    },
  });
  if (!project) notFound();

  const [unmatchedCount, unmatchedRhCount, divergences] = await Promise.all([
    prisma.invoice.count({
      where: { projectId: id, matchStatus: { in: ["UNMATCHED", "AMBIGUOUS"] } },
    }),
    prisma.personnelAllocation.count({
      where: { projectId: id, matchStatus: { in: ["UNMATCHED", "AMBIGUOUS"] } },
    }),
    declaredVsExecuted(id),
  ]);

  const isFteBased = project.fteRate !== null;
  const totalEligible = project.budgetLines.reduce((s, b) => s + Number(b.eligibleCost), 0);
  const totalExecuted = project.budgetLines.reduce((s, b) => s + Number(b.executedAmount), 0);
  // Only projects whose payment-request document has been imported have an
  // official figure to compare against.
  const hasDeclared = project.budgetLines.some((b) => b.declaredExecuted !== null);
  // The funder's line number, where the budget is numbered at all. It is how
  // these rubricas are referred to in the payment request, so it leads.
  const hasOrderNumbers = project.budgetLines.some((b) => b.orderNumber !== "");
  const columnCount =
    7 + (isFteBased ? 1 : 0) + (hasDeclared ? 1 : 0) + (hasOrderNumbers ? 1 : 0);
  const divergenceTotal = divergences.reduce((s, d) => s + d.difference, 0);
  // Execution beyond what the funder approved on that line. Shown rather than
  // absorbed elsewhere: the cost is real and the overrun is the decision the
  // funder will make, so it has to be visible before the next request.
  const overBudget = project.budgetLines
    .map((line) => ({ line, excess: Number(line.executedAmount) - Number(line.eligibleCost) }))
    .filter((row) => row.excess > 0.01)
    .sort((a, b) => b.excess - a.excess);
  const overBudgetTotal = overBudget.reduce((s, r) => s + r.excess, 0);

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
        <div className="flex flex-wrap gap-2">
          <Link
            href={`/projetos/${project.id}/faturas`}
            className="rounded-md border border-gray-300 px-4 py-2 text-sm font-medium text-gray-700 hover:bg-gray-50"
          >
            Faturas ({project._count.invoices})
            {unmatchedCount > 0 && (
              <span className="ml-2 rounded-full bg-amber-100 px-2 py-0.5 text-xs font-medium text-amber-700">
                {unmatchedCount}
              </span>
            )}
          </Link>
          <Link
            href={`/projetos/${project.id}/rh`}
            className="rounded-md border border-gray-300 px-4 py-2 text-sm font-medium text-gray-700 hover:bg-gray-50"
          >
            RH ({project._count.allocations})
            {unmatchedRhCount > 0 && (
              <span className="ml-2 rounded-full bg-amber-100 px-2 py-0.5 text-xs font-medium text-amber-700">
                {unmatchedRhCount}
              </span>
            )}
          </Link>
          <Link
            href={`/projetos/${project.id}/pedidos-pagamento`}
            className="rounded-md border border-gray-300 px-4 py-2 text-sm font-medium text-gray-700 hover:bg-gray-50"
          >
            Pedidos de pagamento ({project._count.paymentRequests})
          </Link>
        </div>
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

      {divergences.length > 0 && (
        <section className="mt-6 rounded-lg border border-amber-200 bg-amber-50 p-4">
          <h2 className="text-sm font-medium text-amber-900">
            Divergências face ao pedido de pagamento
          </h2>
          <p className="mt-1 text-xs text-amber-800">
            {divergences.length} rubrica(s) em que a execução registada aqui não coincide com o
            que foi declarado ao financiador — diferença total de {eur(divergenceTotal)}. Rever
            antes do próximo pedido.
          </p>
          <table className="mt-3 min-w-full text-xs">
            <thead>
              <tr className="text-left text-amber-900">
                <th className="py-1 pr-4 font-medium">Nº ordem</th>
                <th className="py-1 pr-4 font-medium">Rubrica</th>
                <th className="py-1 pr-4 text-right font-medium">Declarado</th>
                <th className="py-1 pr-4 text-right font-medium">Na plataforma</th>
                <th className="py-1 text-right font-medium">Diferença</th>
              </tr>
            </thead>
            <tbody className="text-amber-900">
              {divergences.map((d) => (
                <tr key={`${d.activity}-${d.orderNumber}-${d.category}`}>
                  <td className="py-1 pr-4">{d.orderNumber || "—"}</td>
                  <td className="py-1 pr-4">{d.category}</td>
                  <td className="py-1 pr-4 text-right">{eur(d.declared)}</td>
                  <td className="py-1 pr-4 text-right">{eur(d.executed)}</td>
                  <td className="py-1 text-right font-medium">{eur(d.difference)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </section>
      )}

      {overBudget.length > 0 && (
        <section className="mt-6 rounded-lg border border-red-200 bg-red-50 p-4">
          <h2 className="text-sm font-medium text-red-900">Rubricas acima do aprovado</h2>
          <p className="mt-1 text-xs text-red-800">
            {overBudget.length} rubrica(s) com execução acima do custo elegível aprovado —
            excesso total de {eur(overBudgetTotal)}. Precisa de realocação ou de um aditamento.
          </p>
          <table className="mt-3 min-w-full text-xs">
            <thead>
              <tr className="text-left text-red-900">
                <th className="py-1 pr-4 font-medium">Rubrica</th>
                <th className="py-1 pr-4 text-right font-medium">Aprovado</th>
                <th className="py-1 pr-4 text-right font-medium">Executado</th>
                <th className="py-1 text-right font-medium">Excesso</th>
              </tr>
            </thead>
            <tbody className="text-red-900">
              {overBudget.map(({ line, excess }) => (
                <tr key={line.id}>
                  <td className="py-1 pr-4">
                    {line.activity ? `Atividade ${line.activity} · ` : ""}
                    {budgetLineLabel(line)}
                  </td>
                  <td className="py-1 pr-4 text-right">{eur(Number(line.eligibleCost))}</td>
                  <td className="py-1 pr-4 text-right">{eur(Number(line.executedAmount))}</td>
                  <td className="py-1 text-right font-medium">{eur(excess)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </section>
      )}

      <h2 className="mt-8 text-lg font-medium text-gray-900">Rubricas orçamentais</h2>
      <div className="mt-3 overflow-hidden rounded-lg border border-gray-200 bg-white">
        <table className="min-w-full divide-y divide-gray-200 text-sm">
          <thead className="bg-gray-50">
            <tr>
              {hasOrderNumbers && (
                <th className="px-4 py-2 text-left font-medium text-gray-500">Nº ordem</th>
              )}
              {(isFteBased || hasOrderNumbers) && (
                <th className="px-4 py-2 text-left font-medium text-gray-500">Atividade</th>
              )}
              <th className="px-4 py-2 text-left font-medium text-gray-500">
                {isFteBased ? "Perfil" : "Categoria"}
              </th>
              {isFteBased ? (
                <th className="px-4 py-2 text-right font-medium text-gray-500">FTE aprovado</th>
              ) : (
                <th className="px-4 py-2 text-left font-medium text-gray-500">Fase TRL</th>
              )}
              <th className="px-4 py-2 text-right font-medium text-gray-500">Custo elegível</th>
              <th className="px-4 py-2 text-right font-medium text-gray-500">Financiamento</th>
              <th className="px-4 py-2 text-right font-medium text-gray-500">Executado</th>
              {hasDeclared && (
                <th className="px-4 py-2 text-right font-medium text-gray-500">Declarado</th>
              )}
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
                  {hasOrderNumbers && (
                    <td className="px-4 py-2 font-medium text-gray-900">{line.orderNumber || "—"}</td>
                  )}
                  {(isFteBased || hasOrderNumbers) && (
                    <td className="px-4 py-2 text-gray-500">{line.activity || "—"}</td>
                  )}
                  <td className="px-4 py-2 text-gray-900">{line.category}</td>
                  {isFteBased ? (
                    <td className="px-4 py-2 text-right text-gray-500">
                      {line.plannedFte ? Number(line.plannedFte).toFixed(2) : "—"}
                    </td>
                  ) : (
                    <td className="px-4 py-2 text-gray-500">{line.trlPhase || "—"}</td>
                  )}
                  <td className="px-4 py-2 text-right text-gray-900">{eur(eligibleCost)}</td>
                  <td className="px-4 py-2 text-right text-gray-500">{eur(Number(line.financingAmount))}</td>
                  <td className="px-4 py-2 text-right text-gray-900">{eur(executedAmount)}</td>
                  {hasDeclared && (
                    <td
                      className={`px-4 py-2 text-right ${
                        line.declaredExecuted !== null &&
                        Math.abs(Number(line.declaredExecuted) - executedAmount) > 0.01
                          ? "text-amber-700"
                          : "text-gray-500"
                      }`}
                    >
                      {line.declaredExecuted === null ? "—" : eur(Number(line.declaredExecuted))}
                    </td>
                  )}
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
                <td colSpan={columnCount} className="px-4 py-6 text-center text-gray-400">
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
          {isFteBased && (
            <label className="text-sm text-gray-600">
              Atividade
              <input
                name="activity"
                placeholder="ex: 3"
                className="mt-1 w-full rounded border border-gray-300 px-2 py-1"
              />
            </label>
          )}
          <label className="text-sm text-gray-600">
            {isFteBased ? "Perfil" : "Categoria"}
            <input name="category" required className="mt-1 w-full rounded border border-gray-300 px-2 py-1" />
          </label>
          {isFteBased ? (
            <label className="text-sm text-gray-600">
              FTE aprovado
              <input
                type="number"
                step="0.01"
                min="0"
                name="plannedFte"
                required
                className="mt-1 w-full rounded border border-gray-300 px-2 py-1"
              />
              <span className="mt-1 block text-xs text-gray-400">
                Custo elegível = FTE × {eur(Number(project.fteRate))}
              </span>
            </label>
          ) : (
            <>
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
            </>
          )}
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
