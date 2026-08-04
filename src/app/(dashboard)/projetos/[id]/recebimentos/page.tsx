import Link from "next/link";
import { notFound } from "next/navigation";
import { prisma } from "@/lib/db";
import { outstandingFor, projectReceipts } from "@/lib/receipts";
import { eur } from "@/lib/format";
import {
  createProjection,
  createReceipt,
  linkReceipt,
  realizeProjection,
  setProjectionStatus,
} from "./actions";

const PROJECTION_LABEL: Record<string, string> = {
  FORECAST: "Previsto",
  REALIZED: "Recebido",
  CANCELLED: "Cancelado",
};

function day(date: Date | null) {
  return date ? date.toLocaleDateString("pt-PT") : "—";
}

export default async function ReceiptsPage({ params }: { params: Promise<{ id: string }> }) {
  const { id: projectId } = await params;

  const [project, summary, receipts, projections] = await Promise.all([
    prisma.project.findUnique({ where: { id: projectId }, select: { name: true } }),
    projectReceipts(projectId),
    prisma.receipt.findMany({
      where: { projectId },
      orderBy: { receivedDate: "desc" },
      include: { paymentRequest: { select: { ppNumber: true } } },
    }),
    prisma.receiptProjection.findMany({
      where: { projectId },
      orderBy: { projectedDate: "asc" },
      include: {
        paymentRequest: { select: { ppNumber: true } },
        realizedReceipt: { select: { receivedDate: true, amount: true } },
      },
    }),
  ]);
  if (!project) notFound();

  const requestOptions = summary.requests;

  return (
    <div>
      <h1 className="text-2xl font-semibold text-gray-900">Recebimentos — {project.name}</h1>
      <Link href={`/projetos/${projectId}`} className="text-sm text-gray-500 hover:text-gray-900">
        ← voltar ao projeto
      </Link>

      <dl className="mt-6 grid grid-cols-2 gap-4 sm:grid-cols-4">
        <div className="rounded-lg border border-gray-200 bg-white p-4">
          <dt className="text-xs text-gray-500">Recebido</dt>
          <dd className="mt-1 text-lg font-semibold text-gray-900">{eur(summary.receivedTotal)}</dd>
        </div>
        <div className="rounded-lg border border-gray-200 bg-white p-4">
          <dt className="text-xs text-gray-500">Aprovado por receber</dt>
          <dd
            className={`mt-1 text-lg font-semibold ${
              summary.outstandingTotal > 0 ? "text-amber-700" : "text-gray-900"
            }`}
          >
            {eur(summary.outstandingTotal)}
          </dd>
        </div>
        <div className="rounded-lg border border-gray-200 bg-white p-4">
          <dt className="text-xs text-gray-500">Previsto</dt>
          <dd className="mt-1 text-lg font-semibold text-gray-900">{eur(summary.forecastTotal)}</dd>
        </div>
        <div className="rounded-lg border border-gray-200 bg-white p-4">
          <dt className="text-xs text-gray-500">Sem pedido atribuído</dt>
          <dd
            className={`mt-1 text-lg font-semibold ${
              summary.unlinkedTotal > 0 ? "text-amber-700" : "text-gray-900"
            }`}
          >
            {eur(summary.unlinkedTotal)}
          </dd>
        </div>
      </dl>

      <h2 className="mt-8 text-lg font-medium text-gray-900">Por pedido de pagamento</h2>
      <div className="mt-3 overflow-hidden rounded-lg border border-gray-200 bg-white">
        <table className="min-w-full divide-y divide-gray-200 text-sm">
          <thead className="bg-gray-50">
            <tr>
              <th className="px-4 py-2 text-left font-medium text-gray-500">PP</th>
              <th className="px-4 py-2 text-left font-medium text-gray-500">Decisão</th>
              <th className="px-4 py-2 text-right font-medium text-gray-500">Aprovado</th>
              <th className="px-4 py-2 text-right font-medium text-gray-500">A pagar</th>
              <th className="px-4 py-2 text-right font-medium text-gray-500">Recebido</th>
              <th className="px-4 py-2 text-right font-medium text-gray-500">Por receber</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-gray-100">
            {requestOptions.map((row) => {
              const gap = outstandingFor(row);
              return (
                <tr key={row.paymentRequestId} className="hover:bg-gray-50">
                  <td className="px-4 py-2 font-medium text-gray-900">PP {row.ppNumber}</td>
                  <td className="px-4 py-2 text-gray-500">
                    {row.status ? `${row.status} · ${day(row.decisionDate)}` : "sem decisão"}
                  </td>
                  <td className="px-4 py-2 text-right text-gray-500">
                    {row.approvedAmount === null ? "—" : eur(row.approvedAmount)}
                  </td>
                  <td className="px-4 py-2 text-right text-gray-500">
                    {row.paidAmount === null ? "—" : eur(row.paidAmount)}
                  </td>
                  <td className="px-4 py-2 text-right text-gray-900">{eur(row.receivedAmount)}</td>
                  <td
                    className={`px-4 py-2 text-right ${
                      gap ? "font-medium text-amber-700" : "text-gray-400"
                    }`}
                  >
                    {gap === null ? "—" : eur(gap)}
                  </td>
                </tr>
              );
            })}
            {requestOptions.length === 0 && (
              <tr>
                <td colSpan={6} className="px-4 py-6 text-center text-gray-400">
                  Sem pedidos de pagamento registados.
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>

      <h2 className="mt-8 text-lg font-medium text-gray-900">
        Recebimentos ({receipts.length})
      </h2>
      <div className="mt-3 overflow-hidden rounded-lg border border-gray-200 bg-white">
        <table className="min-w-full divide-y divide-gray-200 text-sm">
          <thead className="bg-gray-50">
            <tr>
              <th className="px-4 py-2 text-left font-medium text-gray-500">Data</th>
              <th className="px-4 py-2 text-right font-medium text-gray-500">Valor</th>
              <th className="px-4 py-2 text-left font-medium text-gray-500">Descrição</th>
              <th className="px-4 py-2 text-left font-medium text-gray-500">Pedido</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-gray-100">
            {receipts.map((receipt) => (
              <tr key={receipt.id} className="hover:bg-gray-50">
                <td className="px-4 py-2 text-gray-900">{day(receipt.receivedDate)}</td>
                <td className="px-4 py-2 text-right font-medium text-gray-900">
                  {eur(Number(receipt.amount))}
                </td>
                <td className="px-4 py-2 text-gray-500">
                  {receipt.description ?? "—"}
                  {receipt.bankDescription && (
                    <span className="block text-xs text-gray-400">{receipt.bankDescription}</span>
                  )}
                </td>
                <td className="px-4 py-2">
                  <form action={linkReceipt} className="flex items-center gap-2">
                    <input type="hidden" name="receiptId" value={receipt.id} />
                    <select
                      name="paymentRequestId"
                      defaultValue={receipt.paymentRequestId ?? ""}
                      className="rounded border border-gray-300 px-2 py-1 text-xs"
                    >
                      <option value="">— sem pedido —</option>
                      {requestOptions.map((r) => (
                        <option key={r.paymentRequestId} value={r.paymentRequestId}>
                          PP {r.ppNumber}
                        </option>
                      ))}
                    </select>
                    <button type="submit" className="text-xs text-gray-400 hover:text-gray-900">
                      guardar
                    </button>
                  </form>
                </td>
              </tr>
            ))}
            {receipts.length === 0 && (
              <tr>
                <td colSpan={4} className="px-4 py-6 text-center text-gray-400">
                  Sem recebimentos registados.
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>

      <details className="mt-4 rounded-lg border border-gray-200 bg-white p-4">
        <summary className="cursor-pointer text-sm font-medium text-gray-700">
          Registar recebimento
        </summary>
        <form action={createReceipt} className="mt-4 grid grid-cols-1 gap-3 sm:grid-cols-2">
          <input type="hidden" name="projectId" value={projectId} />
          <label className="text-sm text-gray-600">
            Data
            <input
              type="date"
              name="receivedDate"
              required
              className="mt-1 w-full rounded border border-gray-300 px-2 py-1"
            />
          </label>
          <label className="text-sm text-gray-600">
            Valor
            <input
              type="number"
              step="0.01"
              name="amount"
              required
              className="mt-1 w-full rounded border border-gray-300 px-2 py-1"
            />
          </label>
          <label className="text-sm text-gray-600">
            Descrição
            <input name="description" className="mt-1 w-full rounded border border-gray-300 px-2 py-1" />
          </label>
          <label className="text-sm text-gray-600">
            Pedido de pagamento (opcional)
            <select
              name="paymentRequestId"
              className="mt-1 w-full rounded border border-gray-300 px-2 py-1"
            >
              <option value="">— sem pedido —</option>
              {requestOptions.map((r) => (
                <option key={r.paymentRequestId} value={r.paymentRequestId}>
                  PP {r.ppNumber}
                </option>
              ))}
            </select>
          </label>
          <div className="sm:col-span-2">
            <button
              type="submit"
              className="rounded-md bg-gray-900 px-4 py-2 text-sm font-medium text-white hover:bg-gray-800"
            >
              Registar
            </button>
          </div>
        </form>
      </details>

      <h2 className="mt-8 text-lg font-medium text-gray-900">
        Projeções ({projections.length})
      </h2>
      <p className="mt-1 text-sm text-gray-500">
        O que se espera receber e quando. O valor previsto fica registado mesmo depois de o
        dinheiro entrar, para se poder comparar com o que veio.
      </p>
      <div className="mt-3 overflow-hidden rounded-lg border border-gray-200 bg-white">
        <table className="min-w-full divide-y divide-gray-200 text-sm">
          <thead className="bg-gray-50">
            <tr>
              <th className="px-4 py-2 text-left font-medium text-gray-500">Data prevista</th>
              <th className="px-4 py-2 text-right font-medium text-gray-500">Valor previsto</th>
              <th className="px-4 py-2 text-left font-medium text-gray-500">Pedido</th>
              <th className="px-4 py-2 text-left font-medium text-gray-500">Estado</th>
              <th className="px-4 py-2 text-left font-medium text-gray-500">Realizado</th>
              <th className="px-4 py-2"></th>
            </tr>
          </thead>
          <tbody className="divide-y divide-gray-100">
            {projections.map((projection) => (
              <tr key={projection.id} className="hover:bg-gray-50">
                <td className="px-4 py-2 text-gray-900">{day(projection.projectedDate)}</td>
                <td className="px-4 py-2 text-right text-gray-900">
                  {eur(Number(projection.projectedAmount))}
                </td>
                <td className="px-4 py-2 text-gray-500">
                  {projection.paymentRequest ? `PP ${projection.paymentRequest.ppNumber}` : "—"}
                </td>
                <td className="px-4 py-2 text-gray-500">
                  {PROJECTION_LABEL[projection.status] ?? projection.status}
                </td>
                <td className="px-4 py-2 text-gray-500">
                  {projection.realizedReceipt
                    ? `${day(projection.realizedReceipt.receivedDate)} · ${eur(Number(projection.realizedReceipt.amount))}`
                    : "—"}
                </td>
                <td className="px-4 py-2 text-right">
                  {projection.status === "FORECAST" ? (
                    <div className="flex items-center justify-end gap-2">
                      <form action={realizeProjection} className="flex items-center gap-1">
                        <input type="hidden" name="projectionId" value={projection.id} />
                        <select
                          name="realizedReceiptId"
                          required
                          className="rounded border border-gray-300 px-2 py-1 text-xs"
                        >
                          <option value="">recebido em…</option>
                          {receipts.map((r) => (
                            <option key={r.id} value={r.id}>
                              {day(r.receivedDate)} · {eur(Number(r.amount))}
                            </option>
                          ))}
                        </select>
                        <button type="submit" className="text-xs text-gray-400 hover:text-gray-900">
                          marcar
                        </button>
                      </form>
                      <form action={setProjectionStatus}>
                        <input type="hidden" name="projectionId" value={projection.id} />
                        <input type="hidden" name="status" value="CANCELLED" />
                        <button type="submit" className="text-xs text-gray-400 hover:text-red-600">
                          cancelar
                        </button>
                      </form>
                    </div>
                  ) : (
                    <form action={setProjectionStatus}>
                      <input type="hidden" name="projectionId" value={projection.id} />
                      <input type="hidden" name="status" value="FORECAST" />
                      <button type="submit" className="text-xs text-gray-400 hover:text-gray-900">
                        reabrir
                      </button>
                    </form>
                  )}
                </td>
              </tr>
            ))}
            {projections.length === 0 && (
              <tr>
                <td colSpan={6} className="px-4 py-6 text-center text-gray-400">
                  Sem projeções registadas.
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>

      <details className="mt-4 rounded-lg border border-gray-200 bg-white p-4">
        <summary className="cursor-pointer text-sm font-medium text-gray-700">Nova projeção</summary>
        <form action={createProjection} className="mt-4 grid grid-cols-1 gap-3 sm:grid-cols-2">
          <input type="hidden" name="projectId" value={projectId} />
          <label className="text-sm text-gray-600">
            Data prevista
            <input
              type="date"
              name="projectedDate"
              required
              className="mt-1 w-full rounded border border-gray-300 px-2 py-1"
            />
          </label>
          <label className="text-sm text-gray-600">
            Valor previsto
            <input
              type="number"
              step="0.01"
              name="projectedAmount"
              required
              className="mt-1 w-full rounded border border-gray-300 px-2 py-1"
            />
          </label>
          <label className="text-sm text-gray-600">
            Pedido de pagamento (opcional)
            <select
              name="paymentRequestId"
              className="mt-1 w-full rounded border border-gray-300 px-2 py-1"
            >
              <option value="">— sem pedido —</option>
              {requestOptions.map((r) => (
                <option key={r.paymentRequestId} value={r.paymentRequestId}>
                  PP {r.ppNumber}
                </option>
              ))}
            </select>
          </label>
          <label className="text-sm text-gray-600">
            Notas
            <input name="notes" className="mt-1 w-full rounded border border-gray-300 px-2 py-1" />
          </label>
          <div className="sm:col-span-2">
            <button
              type="submit"
              className="rounded-md bg-gray-900 px-4 py-2 text-sm font-medium text-white hover:bg-gray-800"
            >
              Adicionar projeção
            </button>
          </div>
        </form>
      </details>
    </div>
  );
}
