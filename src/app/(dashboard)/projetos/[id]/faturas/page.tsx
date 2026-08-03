import Link from "next/link";
import { notFound } from "next/navigation";
import { prisma } from "@/lib/db";
import type { MatchStatus } from "@/generated/prisma/client";
import type { MatchCandidate } from "@/lib/reconciliation";
import { resolveInvoiceMatch, markInvoiceNoMatch } from "./actions";

function eur(value: number) {
  return value.toLocaleString("pt-PT", { style: "currency", currency: "EUR" });
}

const STATUS_TABS: { key: MatchStatus | "ALL"; label: string }[] = [
  { key: "ALL", label: "Todas" },
  { key: "UNMATCHED", label: "Por reconciliar" },
  { key: "AMBIGUOUS", label: "Ambíguas" },
  { key: "MATCHED", label: "Reconciliadas" },
  { key: "MANUAL_NO_MATCH", label: "Sem correspondência" },
];

export default async function InvoicesPage({
  params,
  searchParams,
}: {
  params: Promise<{ id: string }>;
  searchParams: Promise<{ status?: string }>;
}) {
  const { id: projectId } = await params;
  const { status } = await searchParams;

  const project = await prisma.project.findUnique({ where: { id: projectId } });
  if (!project) notFound();

  const activeStatus = (status as MatchStatus | undefined) ?? undefined;

  const [invoices, budgetLines] = await Promise.all([
    prisma.invoice.findMany({
      where: { projectId, ...(activeStatus ? { matchStatus: activeStatus } : {}) },
      orderBy: { docDate: "desc" },
      include: { budgetLine: { select: { category: true, trlPhase: true } } },
    }),
    prisma.budgetLine.findMany({ where: { projectId }, orderBy: { category: "asc" } }),
  ]);

  return (
    <div>
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-semibold text-gray-900">Faturas — {project.name}</h1>
          <p className="text-sm text-gray-500">
            <Link href={`/projetos/${project.id}`} className="hover:underline">
              ← voltar ao projeto
            </Link>
          </p>
        </div>
      </div>

      <div className="mt-4 flex gap-2 text-sm">
        {STATUS_TABS.map((tab) => (
          <Link
            key={tab.key}
            href={tab.key === "ALL" ? `/projetos/${projectId}/faturas` : `/projetos/${projectId}/faturas?status=${tab.key}`}
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
        {invoices.map((invoice) => {
          const candidates = (invoice.matchCandidates as unknown as MatchCandidate[] | null) ?? [];
          const needsReview = invoice.matchStatus === "UNMATCHED" || invoice.matchStatus === "AMBIGUOUS";

          return (
            <div key={invoice.id} className="rounded-lg border border-gray-200 bg-white p-4">
              <div className="flex flex-wrap items-start justify-between gap-2">
                <div>
                  <p className="font-medium text-gray-900">
                    {invoice.supplierName ?? "Fornecedor desconhecido"}{" "}
                    <span className="font-normal text-gray-400">· {invoice.docNumber ?? "s/ nº"}</span>
                  </p>
                  <p className="text-sm text-gray-500">
                    {invoice.category} · {invoice.docDate?.toLocaleDateString("pt-PT") ?? "s/ data"}
                  </p>
                </div>
                <div className="text-right">
                  <p className="font-medium text-gray-900">{eur(Number(invoice.eligibleAmount))}</p>
                  <StatusBadge status={invoice.matchStatus} />
                </div>
              </div>

              {invoice.budgetLine && (
                <p className="mt-2 text-sm text-gray-500">
                  Rubrica: <span className="text-gray-900">{invoice.budgetLine.category}</span>
                </p>
              )}

              {needsReview && (
                <div className="mt-3 border-t border-gray-100 pt-3">
                  {candidates.length > 0 && (
                    <div className="space-y-2">
                      <p className="text-xs font-medium text-gray-500">Sugestões</p>
                      {candidates.map((c) => (
                        <form key={c.budgetLineId} action={resolveInvoiceMatch} className="flex items-center gap-2 text-sm">
                          <input type="hidden" name="invoiceId" value={invoice.id} />
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
                    <form action={resolveInvoiceMatch} className="flex items-center gap-2 text-sm">
                      <input type="hidden" name="invoiceId" value={invoice.id} />
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
                    <form action={markInvoiceNoMatch}>
                      <input type="hidden" name="invoiceId" value={invoice.id} />
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

        {invoices.length === 0 && (
          <p className="rounded-lg border border-dashed border-gray-300 p-6 text-center text-sm text-gray-400">
            Sem faturas neste filtro.
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
