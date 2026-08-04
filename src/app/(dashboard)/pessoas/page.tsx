import Link from "next/link";
import { prisma } from "@/lib/db";
import { eur } from "@/lib/format";
import { hours } from "@/lib/capacity";
import { loadCapacity, overAllocations } from "@/lib/capacity-data";
import { payInForce } from "@/lib/personnel-cost";

function currentYearMonth(): string {
  return new Date().toISOString().slice(0, 7);
}

export default async function PessoasPage() {
  const thisMonth = currentYearMonth();

  const [people, unresolvedAllocations, capacity] = await Promise.all([
    prisma.person.findMany({
      orderBy: [{ active: "desc" }, { name: "asc" }],
      include: {
        _count: { select: { hoursAllocations: true, allocations: true } },
        salaries: {
          orderBy: { effectiveFrom: "desc" },
          select: {
            effectiveFrom: true,
            monthlyBase: true,
            grossAnnual: true,
            socialSecurityRate: true,
          },
        },
      },
    }),
    prisma.personnelAllocation.groupBy({
      by: ["rawPersonLabel"],
      where: { personId: null },
      _count: { _all: true },
      _sum: { eligibleValue: true },
    }),
    loadCapacity(),
  ]);

  const activeCount = people.filter((p) => p.active).length;

  const overAllocatedByPerson = new Map<string, { months: number; worst: number }>();
  for (const row of overAllocations(capacity)) {
    const current = overAllocatedByPerson.get(row.personId) ?? { months: 0, worst: 0 };
    overAllocatedByPerson.set(row.personId, {
      months: current.months + 1,
      worst: Math.max(current.worst, row.overAllocatedBy),
    });
  }

  const missingMonthlyBase = people.filter(
    (p) => p.active && !payInForce(p.salaries, thisMonth)?.monthlyBase,
  );

  return (
    <div>
      <h1 className="text-2xl font-semibold text-gray-900">Pessoas</h1>
      <p className="mt-1 text-sm text-gray-500">
        {people.length} pessoas ({activeCount} ativas). Remuneração em vigor, ausências e alocação
        a projetos.
      </p>

      {overAllocatedByPerson.size > 0 && (
        <div className="mt-6 rounded-lg border border-red-200 bg-red-50 p-4">
          <h2 className="text-sm font-medium text-red-900">
            {overAllocatedByPerson.size} pessoa(s) com meses acima de 100%
          </h2>
          <p className="mt-1 text-xs text-red-800">
            Estão prometidas mais horas do que o mês tem, somando todos os projetos e descontando
            férias e horas fora de projetos. Ver o detalhe de cada pessoa.
          </p>
        </div>
      )}

      {missingMonthlyBase.length > 0 && (
        <div className="mt-4 rounded-lg border border-amber-200 bg-amber-50 p-4">
          <h2 className="text-sm font-medium text-amber-900">
            {missingMonthlyBase.length} pessoa(s) ativa(s) sem RBM elegível em {thisMonth}
          </h2>
          <p className="mt-1 text-xs text-amber-800">
            Sem a remuneração base mensal não se consegue calcular custo elegível de pessoal para
            estas pessoas — só o salário anual, que o financiador não usa. Falta preencher:{" "}
            {missingMonthlyBase.map((p) => p.name).join(", ")}.
          </p>
        </div>
      )}

      {unresolvedAllocations.length > 0 && (
        <div className="mt-4 rounded-lg border border-amber-200 bg-amber-50 p-4">
          <h2 className="text-sm font-medium text-amber-900">
            Imputações de RH sem pessoa correspondente
          </h2>
          <p className="mt-1 text-xs text-amber-800">
            Estas linhas vieram das folhas de RH mas o nome não existe na lista de pessoas
            (tipicamente ex-colaboradores). Os valores contam para a execução do projeto; só a
            ligação à pessoa está em falta.
          </p>
          <ul className="mt-2 space-y-1 text-sm text-amber-900">
            {unresolvedAllocations.map((u) => (
              <li key={u.rawPersonLabel}>
                {u.rawPersonLabel} — {u._count._all} meses,{" "}
                {eur(Number(u._sum.eligibleValue ?? 0))}
              </li>
            ))}
          </ul>
        </div>
      )}

      <div className="mt-6 overflow-x-auto rounded-lg border border-gray-200 bg-white">
        <table className="min-w-full divide-y divide-gray-200 text-sm">
          <thead className="bg-gray-50">
            <tr>
              <th className="px-4 py-2 text-left font-medium text-gray-500">Nome</th>
              <th className="px-4 py-2 text-left font-medium text-gray-500">Iniciais</th>
              <th className="px-4 py-2 text-left font-medium text-gray-500">Perfil</th>
              <th className="px-4 py-2 text-right font-medium text-gray-500">RBM elegível</th>
              <th className="px-4 py-2 text-right font-medium text-gray-500">Salário anual</th>
              <th className="px-4 py-2 text-right font-medium text-gray-500">Alterações</th>
              <th className="px-4 py-2 text-right font-medium text-gray-500">Meses c/ RH</th>
              <th className="px-4 py-2 text-left font-medium text-gray-500">Alerta</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-gray-100">
            {people.map((p) => {
              const pay = payInForce(p.salaries, thisMonth);
              const over = overAllocatedByPerson.get(p.id);
              return (
                <tr
                  key={p.id}
                  className={p.active ? "hover:bg-gray-50" : "bg-gray-50/50 text-gray-400"}
                >
                  <td className="px-4 py-2 font-medium">
                    <Link href={`/pessoas/${p.id}`} className="hover:underline">
                      {p.name}
                    </Link>
                  </td>
                  <td className="px-4 py-2 text-gray-500">{p.initials}</td>
                  <td
                    className="max-w-xs truncate px-4 py-2 text-gray-500"
                    title={p.profile ?? ""}
                  >
                    {p.profile ?? "—"}
                  </td>
                  <td className="px-4 py-2 text-right">
                    {pay?.monthlyBase !== null && pay?.monthlyBase !== undefined ? (
                      <span title={`em vigor desde ${pay.effectiveFrom}`}>
                        {eur(pay.monthlyBase)}
                      </span>
                    ) : (
                      <span className="text-amber-700">—</span>
                    )}
                  </td>
                  <td className="px-4 py-2 text-right text-gray-500">
                    {pay?.grossAnnual != null ? eur(pay.grossAnnual) : "—"}
                  </td>
                  <td className="px-4 py-2 text-right text-gray-500">{p.salaries.length}</td>
                  <td className="px-4 py-2 text-right text-gray-500">{p._count.allocations}</td>
                  <td className="px-4 py-2 text-xs">
                    {over ? (
                      <span className="text-red-700">
                        {over.months} {over.months === 1 ? "mês" : "meses"} acima de 100% (pior{" "}
                        {hours(over.worst)})
                      </span>
                    ) : p.active ? (
                      <span className="text-green-700">ok</span>
                    ) : (
                      <span title={p.obs ?? ""}>saiu</span>
                    )}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
    </div>
  );
}
