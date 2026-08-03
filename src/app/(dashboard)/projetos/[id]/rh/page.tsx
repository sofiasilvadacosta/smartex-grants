import Link from "next/link";
import { notFound } from "next/navigation";
import { prisma } from "@/lib/db";
import type { MatchStatus } from "@/generated/prisma/client";
import type { MatchCandidate } from "@/lib/reconciliation";
import { eur, monthLabel } from "@/lib/format";
import { resolveAllocationMatch, markAllocationNoMatch } from "./actions";

const STATUS_TABS: { key: MatchStatus | "ALL"; label: string }[] = [
  { key: "ALL", label: "Todas" },
  { key: "AMBIGUOUS", label: "Ambíguas" },
  { key: "UNMATCHED", label: "Por reconciliar" },
  { key: "MATCHED", label: "Reconciliadas" },
  { key: "MANUAL_NO_MATCH", label: "Sem correspondência" },
];

export default async function RhPage({
  params,
  searchParams,
}: {
  params: Promise<{ id: string }>;
  searchParams: Promise<{ status?: string }>;
}) {
  const { id: projectId } = await params;
  const { status } = await searchParams;
  const activeStatus = (status as MatchStatus | undefined) ?? undefined;

  const project = await prisma.project.findUnique({ where: { id: projectId } });
  if (!project) notFound();

  const [needsReview, byPerson, budgetLines, totals] = await Promise.all([
    prisma.personnelAllocation.findMany({
      where: { projectId, ...(activeStatus ? { matchStatus: activeStatus } : {}) },
      orderBy: [{ matchStatus: "asc" }, { yearMonth: "desc" }],
      include: { person: { select: { name: true } }, budgetLine: { select: { category: true } } },
      take: 100,
    }),
    prisma.personnelAllocation.groupBy({
      by: ["rawPersonLabel"],
      where: { projectId },
      _sum: { eligibleValue: true },
      _count: { _all: true },
      orderBy: { _sum: { eligibleValue: "desc" } },
    }),
    prisma.budgetLine.findMany({ where: { projectId }, orderBy: { category: "asc" } }),
    prisma.personnelAllocation.aggregate({
      where: { projectId },
      _sum: { eligibleValue: true },
      _count: { _all: true },
    }),
  ]);

  const pendingCount = await prisma.personnelAllocation.count({
    where: { projectId, matchStatus: { in: ["UNMATCHED", "AMBIGUOUS"] } },
  });

  return (
    <div>
      <h1 className="text-2xl font-semibold text-gray-900">Imputação de RH — {project.name}</h1>
      <p className="text-sm text-gray-500">
        <Link href={`/projetos/${project.id}`} className="hover:underline">
          ← voltar ao projeto
        </Link>
      </p>

      <dl className="mt-6 grid grid-cols-2 gap-4 sm:grid-cols-3">
        <div className="rounded-lg border border-gray-200 bg-white p-4">
          <dt className="text-xs text-gray-500">Custo elegível de RH</dt>
          <dd className="mt-1 text-lg font-semibold text-gray-900">
            {eur(Number(totals._sum.eligibleValue ?? 0))}
          </dd>
        </div>
        <div className="rounded-lg border border-gray-200 bg-white p-4">
          <dt className="text-xs text-gray-500">Linhas pessoa/mês</dt>
          <dd className="mt-1 text-lg font-semibold text-gray-900">{totals._count._all}</dd>
        </div>
        <div className="rounded-lg border border-gray-200 bg-white p-4">
          <dt className="text-xs text-gray-500">Por reconciliar</dt>
          <dd
            className={`mt-1 text-lg font-semibold ${pendingCount > 0 ? "text-amber-600" : "text-gray-900"}`}
          >
            {pendingCount}
          </dd>
        </div>
      </dl>

      <h2 className="mt-8 text-lg font-medium text-gray-900">Total por pessoa</h2>
      <div className="mt-3 overflow-hidden rounded-lg border border-gray-200 bg-white">
        <table className="min-w-full divide-y divide-gray-200 text-sm">
          <thead className="bg-gray-50">
            <tr>
              <th className="px-4 py-2 text-left font-medium text-gray-500">Pessoa</th>
              <th className="px-4 py-2 text-right font-medium text-gray-500">Meses</th>
              <th className="px-4 py-2 text-right font-medium text-gray-500">Custo elegível</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-gray-100">
            {byPerson.map((p) => (
              <tr key={p.rawPersonLabel} className="hover:bg-gray-50">
                <td className="px-4 py-2 text-gray-900">{p.rawPersonLabel}</td>
                <td className="px-4 py-2 text-right text-gray-500">{p._count._all}</td>
                <td className="px-4 py-2 text-right text-gray-900">
                  {eur(Number(p._sum.eligibleValue ?? 0))}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      <h2 className="mt-8 text-lg font-medium text-gray-900">Linhas de imputação</h2>
      <div className="mt-3 flex flex-wrap gap-2 text-sm">
        {STATUS_TABS.map((tab) => (
          <Link
            key={tab.key}
            href={tab.key === "ALL" ? `/projetos/${projectId}/rh` : `/projetos/${projectId}/rh?status=${tab.key}`}
            className={`rounded-full px-3 py-1 ${
              (activeStatus ?? "ALL") === tab.key
                ? "bg-gray-900 text-white"
                : "border border-gray-300 text-gray-600 hover:bg-gray-50"
            }`}
          >
            {tab.label}
          </Link>
        ))}
      </div>

      <div className="mt-4 space-y-3">
        {needsReview.map((row) => {
          const candidates = (row.matchCandidates as unknown as MatchCandidate[] | null) ?? [];
          const pending = row.matchStatus === "UNMATCHED" || row.matchStatus === "AMBIGUOUS";

          return (
            <div key={row.id} className="rounded-lg border border-gray-200 bg-white p-4">
              <div className="flex flex-wrap items-start justify-between gap-2">
                <div>
                  <p className="font-medium text-gray-900">
                    {row.person?.name ?? row.rawPersonLabel}
                    {!row.person && (
                      <span className="ml-2 text-xs font-normal text-amber-600">
                        pessoa não ligada
                      </span>
                    )}
                  </p>
                  <p className="text-sm text-gray-500">
                    {row.category} · {monthLabel(row.yearMonth)} ·{" "}
                    {(Number(row.allocationPercent) * 100).toFixed(0)}% imputação
                  </p>
                </div>
                <div className="text-right">
                  <p className="font-medium text-gray-900">{eur(Number(row.eligibleValue))}</p>
                  <StatusBadge status={row.matchStatus} />
                </div>
              </div>

              {row.budgetLine && (
                <p className="mt-2 text-sm text-gray-500">
                  Rubrica: <span className="text-gray-900">{row.budgetLine.category}</span>
                </p>
              )}

              {pending && (
                <div className="mt-3 border-t border-gray-100 pt-3">
                  {candidates.length > 0 && (
                    <div className="space-y-2">
                      <p className="text-xs font-medium text-gray-500">Sugestões</p>
                      {candidates.map((c) => (
                        <form
                          key={c.budgetLineId}
                          action={resolveAllocationMatch}
                          className="flex items-center gap-2 text-sm"
                        >
                          <input type="hidden" name="allocationId" value={row.id} />
                          <input type="hidden" name="budgetLineId" value={c.budgetLineId} />
                          <input type="hidden" name="suggestedScore" value={c.score} />
                          <button
                            type="submit"
                            className="rounded-md border border-gray-300 px-2 py-1 text-left hover:bg-gray-50"
                          >
                            {c.category} {c.trlPhase && <span className="text-gray-400">({c.trlPhase})</span>}
                          </button>
                          <span className="text-gray-400">
                            score {c.score.toFixed(0)} · margem {eur(c.remainingMargin)}
                          </span>
                        </form>
                      ))}
                    </div>
                  )}

                  <div className="mt-3 flex flex-wrap items-center gap-2">
                    <form action={resolveAllocationMatch} className="flex items-center gap-2 text-sm">
                      <input type="hidden" name="allocationId" value={row.id} />
                      <select name="budgetLineId" required className="rounded border border-gray-300 px-2 py-1">
                        <option value="">Escolher rubrica manualmente…</option>
                        {budgetLines.map((b) => (
                          <option key={b.id} value={b.id}>
                            {b.category} {b.trlPhase ? `(${b.trlPhase})` : ""}
                          </option>
                        ))}
                      </select>
                      <button type="submit" className="rounded-md bg-gray-900 px-3 py-1 text-white hover:bg-gray-800">
                        Confirmar
                      </button>
                    </form>
                    <form action={markAllocationNoMatch}>
                      <input type="hidden" name="allocationId" value={row.id} />
                      <button type="submit" className="text-sm text-gray-400 hover:text-gray-700">
                        Marcar como sem correspondência
                      </button>
                    </form>
                  </div>
                </div>
              )}
            </div>
          );
        })}

        {needsReview.length === 0 && (
          <p className="rounded-lg border border-dashed border-gray-300 p-6 text-center text-sm text-gray-400">
            Sem imputações neste filtro.
          </p>
        )}
        {needsReview.length === 100 && (
          <p className="text-center text-xs text-gray-400">
            A mostrar as primeiras 100 linhas. Usa os filtros para ver o resto.
          </p>
        )}
      </div>
    </div>
  );
}

function StatusBadge({ status }: { status: MatchStatus }) {
  const styles: Record<MatchStatus, string> = {
    MATCHED: "bg-green-100 text-green-700",
    AMBIGUOUS: "bg-amber-100 text-amber-700",
    UNMATCHED: "bg-red-100 text-red-700",
    MANUAL_NO_MATCH: "bg-gray-100 text-gray-500",
  };
  const labels: Record<MatchStatus, string> = {
    MATCHED: "Reconciliada",
    AMBIGUOUS: "Ambígua",
    UNMATCHED: "Por reconciliar",
    MANUAL_NO_MATCH: "Sem correspondência",
  };
  return <span className={`rounded-full px-2 py-0.5 text-xs font-medium ${styles[status]}`}>{labels[status]}</span>;
}
