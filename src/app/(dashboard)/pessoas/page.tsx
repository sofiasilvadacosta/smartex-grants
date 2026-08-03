import { prisma } from "@/lib/db";
import { eur } from "@/lib/format";

export default async function PessoasPage() {
  const [people, unresolvedAllocations] = await Promise.all([
    prisma.person.findMany({
      orderBy: [{ active: "desc" }, { name: "asc" }],
      include: {
        _count: { select: { hoursAllocations: true, allocations: true } },
      },
    }),
    prisma.personnelAllocation.groupBy({
      by: ["rawPersonLabel"],
      where: { personId: null },
      _count: { _all: true },
      _sum: { eligibleValue: true },
    }),
  ]);

  const activeCount = people.filter((p) => p.active).length;

  return (
    <div>
      <h1 className="text-2xl font-semibold text-gray-900">Pessoas</h1>
      <p className="mt-1 text-sm text-gray-500">
        {people.length} pessoas ({activeCount} ativas). Horas alocadas e imputações de RH por
        pessoa.
      </p>

      {unresolvedAllocations.length > 0 && (
        <div className="mt-6 rounded-lg border border-amber-200 bg-amber-50 p-4">
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
              <th className="px-4 py-2 text-right font-medium text-gray-500">Salário bruto</th>
              <th className="px-4 py-2 text-right font-medium text-gray-500">Meses c/ horas</th>
              <th className="px-4 py-2 text-right font-medium text-gray-500">Meses c/ RH</th>
              <th className="px-4 py-2 text-left font-medium text-gray-500">Estado</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-gray-100">
            {people.map((p) => (
              <tr key={p.id} className={p.active ? "hover:bg-gray-50" : "bg-gray-50/50 text-gray-400"}>
                <td className="px-4 py-2 font-medium">{p.name}</td>
                <td className="px-4 py-2 text-gray-500">{p.initials}</td>
                <td className="max-w-xs truncate px-4 py-2 text-gray-500" title={p.profile ?? ""}>
                  {p.profile ?? "—"}
                </td>
                <td className="px-4 py-2 text-right">
                  {p.grossSalary ? eur(Number(p.grossSalary)) : "—"}
                </td>
                <td className="px-4 py-2 text-right text-gray-500">{p._count.hoursAllocations}</td>
                <td className="px-4 py-2 text-right text-gray-500">{p._count.allocations}</td>
                <td className="px-4 py-2 text-xs">
                  {p.active ? (
                    <span className="text-green-700">ativo</span>
                  ) : (
                    <span title={p.obs ?? ""}>saiu</span>
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}
