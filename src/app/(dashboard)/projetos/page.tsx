import Link from "next/link";
import { prisma } from "@/lib/db";
import { createProject, setProjectExcluded } from "./actions";

const STATUS_LABEL: Record<string, string> = {
  ACTIVE: "ativo",
  CLOSED: "fechado",
  EXCLUDED: "fora do âmbito",
};

export default async function ProjetosPage() {
  const projects = await prisma.project.findMany({
    include: { _count: { select: { budgetLines: true, invoices: true } } },
    orderBy: { name: "asc" },
  });

  return (
    <div>
      <div className="flex items-center justify-between">
        <h1 className="text-2xl font-semibold text-gray-900">Projetos</h1>
      </div>

      <div className="mt-6 overflow-hidden rounded-lg border border-gray-200 bg-white">
        <table className="min-w-full divide-y divide-gray-200 text-sm">
          <thead className="bg-gray-50">
            <tr>
              <th className="px-4 py-2 text-left font-medium text-gray-500">Projeto</th>
              <th className="px-4 py-2 text-left font-medium text-gray-500">Código</th>
              <th className="px-4 py-2 text-left font-medium text-gray-500">Período</th>
              <th className="px-4 py-2 text-left font-medium text-gray-500">Estado</th>
              <th className="px-4 py-2 text-right font-medium text-gray-500">Rubricas</th>
              <th className="px-4 py-2 text-right font-medium text-gray-500">Faturas</th>
              <th className="px-4 py-2 text-right font-medium text-gray-500">Âmbito</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-gray-100">
            {projects.map((p) => {
              const excluded = p.status === "EXCLUDED";
              return (
                <tr
                  key={p.id}
                  className={excluded ? "bg-gray-50/50 text-gray-400" : "hover:bg-gray-50"}
                >
                  <td className="px-4 py-2">
                    <Link
                      href={`/projetos/${p.id}`}
                      className={`font-medium hover:underline ${excluded ? "" : "text-gray-900"}`}
                    >
                      {p.name}
                    </Link>
                  </td>
                  <td className="px-4 py-2 text-gray-500">{p.code}</td>
                  <td className="px-4 py-2 text-gray-500">
                    {p.startDate?.toLocaleDateString("pt-PT")} –{" "}
                    {p.endDate?.toLocaleDateString("pt-PT")}
                  </td>
                  <td className="px-4 py-2 text-xs text-gray-500">
                    {STATUS_LABEL[p.status] ?? p.status}
                  </td>
                  <td className="px-4 py-2 text-right text-gray-500">{p._count.budgetLines}</td>
                  <td className="px-4 py-2 text-right text-gray-500">{p._count.invoices}</td>
                  <td className="px-4 py-2 text-right">
                    {p.status === "CLOSED" ? (
                      <span className="text-xs text-gray-400">—</span>
                    ) : (
                      <form action={setProjectExcluded}>
                        <input type="hidden" name="id" value={p.id} />
                        <input type="hidden" name="excluded" value={excluded ? "false" : "true"} />
                        <button
                          type="submit"
                          className="text-xs text-gray-500 underline hover:text-gray-900"
                        >
                          {excluded ? "incluir no dashboard" : "excluir do dashboard"}
                        </button>
                      </form>
                    )}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>

      <details className="mt-6 rounded-lg border border-gray-200 bg-white p-4">
        <summary className="cursor-pointer text-sm font-medium text-gray-700">Novo projeto</summary>
        <form action={createProject} className="mt-4 grid grid-cols-1 gap-3 sm:grid-cols-2">
          <label className="text-sm text-gray-600">
            Código
            <input name="code" required className="mt-1 w-full rounded border border-gray-300 px-2 py-1" />
          </label>
          <label className="text-sm text-gray-600">
            Nome
            <input name="name" required className="mt-1 w-full rounded border border-gray-300 px-2 py-1" />
          </label>
          <label className="text-sm text-gray-600">
            Programa de financiamento
            <input name="fundingProgram" className="mt-1 w-full rounded border border-gray-300 px-2 py-1" />
          </label>
          <div />
          <label className="text-sm text-gray-600">
            Data de início
            <input type="date" name="startDate" className="mt-1 w-full rounded border border-gray-300 px-2 py-1" />
          </label>
          <label className="text-sm text-gray-600">
            Data de fim
            <input type="date" name="endDate" className="mt-1 w-full rounded border border-gray-300 px-2 py-1" />
          </label>
          <div className="sm:col-span-2">
            <button
              type="submit"
              className="rounded-md bg-gray-900 px-4 py-2 text-sm font-medium text-white hover:bg-gray-800"
            >
              Criar projeto
            </button>
          </div>
        </form>
      </details>
    </div>
  );
}
