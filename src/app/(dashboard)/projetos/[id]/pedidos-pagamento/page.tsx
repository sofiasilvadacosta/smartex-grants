import Link from "next/link";
import { notFound } from "next/navigation";
import { prisma } from "@/lib/db";
import type { DecisionStatus } from "@/generated/prisma/client";
import { eur } from "@/lib/format";
import {
  createPaymentRequest,
  recordDecision,
  uploadAttachment,
  deleteAttachment,
  linkRowsByPpNumber,
} from "./actions";

export default async function PaymentRequestsPage({ params }: { params: Promise<{ id: string }> }) {
  const { id: projectId } = await params;

  const project = await prisma.project.findUnique({ where: { id: projectId } });
  if (!project) notFound();

  const requests = await prisma.paymentRequest.findMany({
    where: { projectId },
    include: {
      decisions: { orderBy: { createdAt: "desc" } },
      attachments: { orderBy: { uploadedAt: "desc" } },
      _count: { select: { invoices: true, allocations: true } },
    },
  });

  // "PP 11" must not sort between "PP 1" and "PP 3": the funder's number is a
  // number, even though it is stored as text because some projects letter them.
  requests.sort((a, b) => {
    const numA = Number(a.ppNumber);
    const numB = Number(b.ppNumber);
    if (Number.isFinite(numA) && Number.isFinite(numB) && numA !== numB) return numA - numB;
    return a.ppNumber.localeCompare(b.ppNumber, "pt");
  });

  // The "linked total" that a PP actually bundles, computed from execution rows
  // rather than stored, so it can never drift from the underlying data.
  const [invoiceTotals, allocationTotals] = await Promise.all([
    prisma.invoice.groupBy({
      by: ["paymentRequestId"],
      where: { projectId, paymentRequestId: { not: null } },
      _sum: { eligibleAmount: true },
    }),
    prisma.personnelAllocation.groupBy({
      by: ["paymentRequestId"],
      where: { projectId, paymentRequestId: { not: null } },
      _sum: { eligibleValue: true },
    }),
  ]);
  const linkedTotals = new Map<string, number>();
  for (const t of invoiceTotals) {
    if (t.paymentRequestId)
      linkedTotals.set(
        t.paymentRequestId,
        (linkedTotals.get(t.paymentRequestId) ?? 0) + Number(t._sum.eligibleAmount ?? 0),
      );
  }
  for (const t of allocationTotals) {
    if (t.paymentRequestId)
      linkedTotals.set(
        t.paymentRequestId,
        (linkedTotals.get(t.paymentRequestId) ?? 0) + Number(t._sum.eligibleValue ?? 0),
      );
  }

  // PP numbers present in the imported execution rows but with no
  // PaymentRequest record yet — the backlog of PPs still to register.
  const [invoicePps, allocationPps] = await Promise.all([
    prisma.invoice.findMany({
      where: { projectId, ppNumber: { not: null } },
      distinct: ["ppNumber"],
      select: { ppNumber: true },
    }),
    prisma.personnelAllocation.findMany({
      where: { projectId, ppNumber: { not: null } },
      distinct: ["ppNumber"],
      select: { ppNumber: true },
    }),
  ]);
  const known = new Set(requests.map((r) => r.ppNumber));
  const unregisteredPps = [
    ...new Set([...invoicePps, ...allocationPps].map((r) => r.ppNumber!).filter((pp) => !known.has(pp))),
  ].sort();

  return (
    <div>
      <h1 className="text-2xl font-semibold text-gray-900">
        Pedidos de pagamento — {project.name}
      </h1>
      <p className="text-sm text-gray-500">
        <Link href={`/projetos/${project.id}`} className="hover:underline">
          ← voltar ao projeto
        </Link>
      </p>

      {unregisteredPps.length > 0 && (
        <div className="mt-6 rounded-lg border border-amber-200 bg-amber-50 p-4 text-sm">
          <p className="font-medium text-amber-900">
            PPs referidos nos dados importados mas ainda não registados aqui
          </p>
          <p className="mt-1 text-xs text-amber-800">
            Cria o pedido com o mesmo número e usa &quot;Ligar linhas por nº de PP&quot; para
            associar automaticamente as faturas e imputações de RH correspondentes.
          </p>
          <p className="mt-2 font-mono text-xs text-amber-900">{unregisteredPps.join(", ")}</p>
        </div>
      )}

      <div className="mt-6 space-y-4">
        {requests.map((request) => {
          const current = request.decisions.find((d) => d.isCurrent) ?? request.decisions[0];
          const superseded = request.decisions.filter((d) => d.id !== current?.id);
          const linkedTotal = linkedTotals.get(request.id) ?? 0;
          const requested = request.requestedAmount ? Number(request.requestedAmount) : null;

          return (
            <div key={request.id} className="rounded-lg border border-gray-200 bg-white p-5">
              <div className="flex flex-wrap items-start justify-between gap-3">
                <div>
                  <h2 className="font-medium text-gray-900">PP {request.ppNumber}</h2>
                  <p className="text-sm text-gray-500">
                    Submetido em {request.submissionDate?.toLocaleDateString("pt-PT") ?? "—"} ·{" "}
                    {request._count.invoices} faturas, {request._count.allocations} linhas de RH
                  </p>
                  {request.notes && <p className="mt-1 text-sm text-gray-600">{request.notes}</p>}
                </div>
                <div className="text-right text-sm">
                  <p className="text-gray-500">
                    Pedido:{" "}
                    <span className="font-medium text-gray-900">
                      {requested !== null ? eur(requested) : "—"}
                    </span>
                  </p>
                  <p className="text-gray-500">
                    Ligado:{" "}
                    <span className="font-medium text-gray-900">{eur(linkedTotal)}</span>
                  </p>
                  {requested !== null && Math.abs(requested - linkedTotal) > 0.01 && (
                    <p className="text-xs text-amber-600">
                      diferença {eur(requested - linkedTotal)}
                    </p>
                  )}
                </div>
              </div>

              <div className="mt-4 border-t border-gray-100 pt-4">
                <div className="flex flex-wrap items-center gap-3">
                  <span className="text-xs font-medium text-gray-500">Decisão</span>
                  {current ? (
                    <>
                      <DecisionBadge status={current.status} />
                      <span className="text-sm text-gray-500">
                        {current.decisionDate?.toLocaleDateString("pt-PT") ?? "sem data"}
                        {current.approvedAmount !== null &&
                          ` · aprovado ${eur(Number(current.approvedAmount))}`}
                      </span>
                    </>
                  ) : (
                    <span className="text-sm text-gray-400">ainda sem decisão registada</span>
                  )}
                </div>
                {current?.notes && <p className="mt-1 text-sm text-gray-600">{current.notes}</p>}
                {superseded.length > 0 && (
                  <details className="mt-2">
                    <summary className="cursor-pointer text-xs text-gray-400">
                      {superseded.length} decisão(ões) anterior(es)
                    </summary>
                    <ul className="mt-1 space-y-1 text-xs text-gray-500">
                      {superseded.map((d) => (
                        <li key={d.id}>
                          {d.status} · {d.decisionDate?.toLocaleDateString("pt-PT") ?? "sem data"}
                          {d.approvedAmount !== null && ` · ${eur(Number(d.approvedAmount))}`}
                          {d.notes && ` · ${d.notes}`}
                        </li>
                      ))}
                    </ul>
                  </details>
                )}

                <details className="mt-3">
                  <summary className="cursor-pointer text-sm text-gray-600">
                    Registar decisão
                  </summary>
                  <form
                    action={recordDecision}
                    className="mt-3 grid grid-cols-1 gap-3 sm:grid-cols-2"
                  >
                    <input type="hidden" name="paymentRequestId" value={request.id} />
                    <label className="text-sm text-gray-600">
                      Estado
                      <select
                        name="status"
                        required
                        defaultValue="APROVADO"
                        className="mt-1 w-full rounded border border-gray-300 px-2 py-1"
                      >
                        <option value="APROVADO">Aprovado</option>
                        <option value="PARCIAL">Parcial</option>
                        <option value="REJEITADO">Rejeitado</option>
                        <option value="PENDING">Pendente</option>
                      </select>
                    </label>
                    <label className="text-sm text-gray-600">
                      Data da decisão
                      <input
                        type="date"
                        name="decisionDate"
                        className="mt-1 w-full rounded border border-gray-300 px-2 py-1"
                      />
                    </label>
                    <label className="text-sm text-gray-600">
                      Montante aprovado
                      <input
                        type="number"
                        step="0.01"
                        name="approvedAmount"
                        className="mt-1 w-full rounded border border-gray-300 px-2 py-1"
                      />
                    </label>
                    <label className="text-sm text-gray-600">
                      Observações
                      <input
                        name="notes"
                        className="mt-1 w-full rounded border border-gray-300 px-2 py-1"
                      />
                    </label>
                    <div className="sm:col-span-2">
                      <button
                        type="submit"
                        className="rounded-md bg-gray-900 px-4 py-2 text-sm font-medium text-white hover:bg-gray-800"
                      >
                        Guardar decisão
                      </button>
                    </div>
                  </form>
                </details>
              </div>

              <div className="mt-4 border-t border-gray-100 pt-4">
                <p className="text-xs font-medium text-gray-500">Documentos</p>
                {request.attachments.length > 0 ? (
                  <ul className="mt-2 space-y-1 text-sm">
                    {request.attachments.map((a) => (
                      <li key={a.id} className="flex items-center gap-3">
                        <a
                          href={`/api/attachments/${a.id}`}
                          className="text-gray-900 underline hover:no-underline"
                        >
                          {a.filename}
                        </a>
                        <span className="text-xs text-gray-400">
                          {a.kind === "DECISION_DOC" ? "decisão" : "pedido"} ·{" "}
                          {Math.round(a.sizeBytes / 1024)} KB
                        </span>
                        <form action={deleteAttachment}>
                          <input type="hidden" name="attachmentId" value={a.id} />
                          <button type="submit" className="text-xs text-gray-400 hover:text-red-600">
                            remover
                          </button>
                        </form>
                      </li>
                    ))}
                  </ul>
                ) : (
                  <p className="mt-1 text-sm text-gray-400">Sem documentos anexados.</p>
                )}

                <form action={uploadAttachment} className="mt-3 flex flex-wrap items-center gap-2 text-sm">
                  <input type="hidden" name="paymentRequestId" value={request.id} />
                  <select name="kind" className="rounded border border-gray-300 px-2 py-1">
                    <option value="DECISION_DOC">Decisão</option>
                    <option value="REQUEST_DOC">Pedido</option>
                  </select>
                  <input
                    type="file"
                    name="file"
                    required
                    accept=".pdf,.doc,.docx"
                    className="text-sm"
                  />
                  <button
                    type="submit"
                    className="rounded-md border border-gray-300 px-3 py-1 hover:bg-gray-50"
                  >
                    Anexar
                  </button>
                </form>
              </div>

              <form action={linkRowsByPpNumber} className="mt-4 border-t border-gray-100 pt-3">
                <input type="hidden" name="paymentRequestId" value={request.id} />
                <button type="submit" className="text-sm text-gray-500 hover:text-gray-900">
                  Ligar linhas por nº de PP ({request.ppNumber})
                </button>
              </form>
            </div>
          );
        })}

        {requests.length === 0 && (
          <p className="rounded-lg border border-dashed border-gray-300 p-6 text-center text-sm text-gray-400">
            Ainda não há pedidos de pagamento registados.
          </p>
        )}
      </div>

      <details className="mt-6 rounded-lg border border-gray-200 bg-white p-4">
        <summary className="cursor-pointer text-sm font-medium text-gray-700">
          Novo pedido de pagamento
        </summary>
        <form action={createPaymentRequest} className="mt-4 grid grid-cols-1 gap-3 sm:grid-cols-2">
          <input type="hidden" name="projectId" value={project.id} />
          <label className="text-sm text-gray-600">
            Nº de PP
            <input name="ppNumber" required className="mt-1 w-full rounded border border-gray-300 px-2 py-1" />
          </label>
          <label className="text-sm text-gray-600">
            Data de submissão
            <input
              type="date"
              name="submissionDate"
              className="mt-1 w-full rounded border border-gray-300 px-2 py-1"
            />
          </label>
          <label className="text-sm text-gray-600">
            Montante pedido
            <input
              type="number"
              step="0.01"
              name="requestedAmount"
              className="mt-1 w-full rounded border border-gray-300 px-2 py-1"
            />
          </label>
          <label className="text-sm text-gray-600">
            Observações
            <input name="notes" className="mt-1 w-full rounded border border-gray-300 px-2 py-1" />
          </label>
          <div className="sm:col-span-2">
            <button
              type="submit"
              className="rounded-md bg-gray-900 px-4 py-2 text-sm font-medium text-white hover:bg-gray-800"
            >
              Criar pedido
            </button>
          </div>
        </form>
      </details>
    </div>
  );
}

function DecisionBadge({ status }: { status: DecisionStatus }) {
  const styles: Record<DecisionStatus, string> = {
    APROVADO: "bg-green-100 text-green-700",
    PARCIAL: "bg-amber-100 text-amber-700",
    REJEITADO: "bg-red-100 text-red-700",
    PENDING: "bg-gray-100 text-gray-600",
  };
  const labels: Record<DecisionStatus, string> = {
    APROVADO: "Aprovado",
    PARCIAL: "Parcial",
    REJEITADO: "Rejeitado",
    PENDING: "Pendente",
  };
  return (
    <span className={`rounded-full px-2 py-0.5 text-xs font-medium ${styles[status]}`}>
      {labels[status]}
    </span>
  );
}
