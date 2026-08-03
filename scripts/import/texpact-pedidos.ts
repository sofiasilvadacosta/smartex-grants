import { existsSync } from "node:fs";
import { prisma } from "../../src/lib/db";
import { loadWorkbook, getSheet, asString, asNumber } from "./lib/workbook";

// TexP@ct's payment-request workbook. The working spreadsheet carries the
// invoices but almost no "Nº PP" (12 of 131 rows), and no record at all of what
// each request submitted, what the funder cut and what was paid. This workbook
// has both: a "Resumo" sheet with the per-request figures, and one sheet per
// request listing the invoices it declared.
const RESUMO_SHEET = "Resumo";
const RESUMO_FIRST_ROW = 6;

// Resumo column positions. The header row labels them but "Despesas Apuradas"
// appears twice (IAPMEI's figure and Smartex's own recalculation), so reading
// by name would silently pick one of the two.
const RESUMO = {
  label: 2,
  submitted: 3,
  cuts: 4,
  approvedByFunder: 5,
  paid: 9,
  notes: 11,
} as const;

// Per-request sheets share one layout; see the header row of any "PP<n>" sheet.
const DETAIL = { tipo: 2, ppNumber: 3, docNumber: 9, eligible: 17 } as const;
const DETAIL_FIRST_ROW = 3;

// Personnel is declared as one aggregate row per TRL phase, not per person, so
// those rows cannot be matched to the monthly allocations held here.
const PERSONNEL_TIPO = /^Custos com Pessoal/i;

export interface TexpactPedidosSummary {
  requestsCreated: number;
  requestsUpdated: number;
  decisionsRecorded: number;
  submittedTotal: number;
  approvedTotal: number;
  paidTotal: number;
  invoicesLinked: number;
  // Document numbers present in the request sheets with no invoice here.
  invoicesNotFound: string[];
  // Personnel declared per request, which stays unlinked (see above).
  personnelByRequest: Record<string, number>;
}

// "5 (4)" means a row first submitted in request 4 (which the funder cut in
// full) and re-submitted in request 5. The current request is the leading one.
function parsePpNumber(raw: string): string | null {
  const match = /^\s*(\d+)/.exec(raw);
  return match ? match[1] : null;
}

// The Resumo lists "PP1".."PP9" plus advance rows; only the numbered requests
// are payment requests.
function parseRequestLabel(raw: string): { ppNumber: string; isAdvance: boolean } | null {
  const match = /^PP\s*(\d+)(.*)$/i.exec(raw.trim());
  if (!match) return null;
  return { ppNumber: match[1], isAdvance: /adiantamento/i.test(match[2]) };
}

export async function importTexpactPedidos(
  workbookPath: string,
  projectId: string,
): Promise<TexpactPedidosSummary | null> {
  if (!existsSync(workbookPath)) return null;

  const workbook = await loadWorkbook(workbookPath);
  const resumo = getSheet(workbook, RESUMO_SHEET);

  const summary: TexpactPedidosSummary = {
    requestsCreated: 0,
    requestsUpdated: 0,
    decisionsRecorded: 0,
    submittedTotal: 0,
    approvedTotal: 0,
    paidTotal: 0,
    invoicesLinked: 0,
    invoicesNotFound: [],
    personnelByRequest: {},
  };

  // An advance row shares its request's number; keep it aside so the request's
  // own row is the one that defines the request.
  const advanceByPp = new Map<string, number>();
  interface ResumoRow {
    ppNumber: string;
    submitted: number;
    cuts: number;
    approved: number | null;
    paid: number | null;
    notes: string | null;
  }
  const requests: ResumoRow[] = [];

  for (let r = RESUMO_FIRST_ROW; r <= resumo.rowCount; r++) {
    const row = resumo.getRow(r);
    const parsed = parseRequestLabel(asString(row.getCell(RESUMO.label).value) ?? "");
    if (!parsed) continue;
    const submitted = asNumber(row.getCell(RESUMO.submitted).value) ?? 0;
    if (parsed.isAdvance) {
      advanceByPp.set(parsed.ppNumber, asNumber(row.getCell(RESUMO.paid).value) ?? 0);
      continue;
    }
    // A request that submitted nothing was never made; recording it would put
    // empty rows on the project's payment-request screen.
    if (submitted === 0) continue;
    requests.push({
      ppNumber: parsed.ppNumber,
      submitted,
      cuts: asNumber(row.getCell(RESUMO.cuts).value) ?? 0,
      approved: asNumber(row.getCell(RESUMO.approvedByFunder).value),
      paid: asNumber(row.getCell(RESUMO.paid).value),
      notes: asString(row.getCell(RESUMO.notes).value),
    });
  }

  // Each request's sheet says which invoices it declared. The document number
  // is the only field both sources carry reliably, and it is unique per
  // project here.
  const invoices = await prisma.invoice.findMany({
    where: { projectId, docNumber: { not: null } },
    select: { id: true, docNumber: true },
  });
  const invoiceIdByDoc = new Map<string, string>();
  const duplicateDocs = new Set<string>();
  for (const invoice of invoices) {
    const key = invoice.docNumber!.trim().toLowerCase();
    if (invoiceIdByDoc.has(key)) duplicateDocs.add(key);
    invoiceIdByDoc.set(key, invoice.id);
  }

  const notFound = new Set<string>();
  // An invoice cut from one request and re-submitted in a later one appears in
  // both sheets. The later request is the one that counts, so resolve the whole
  // workbook first and keep the highest request number per document — relying
  // on worksheet order for that would break if the sheets were ever reordered.
  const ppByDoc = new Map<string, number>();
  for (const sheet of workbook.worksheets) {
    if (!/^PP\d+$/i.test(sheet.name)) continue;
    for (let r = DETAIL_FIRST_ROW; r <= sheet.rowCount; r++) {
      const row = sheet.getRow(r);
      const tipo = asString(row.getCell(DETAIL.tipo).value);
      // Repeated header rows and free-text notes are interleaved in these
      // sheets; a row is only a declaration if it names a request.
      const ppNumber = parsePpNumber(asString(row.getCell(DETAIL.ppNumber).value) ?? "");
      if (!tipo || !ppNumber) continue;

      if (PERSONNEL_TIPO.test(tipo)) {
        const value = asNumber(row.getCell(DETAIL.eligible).value) ?? 0;
        summary.personnelByRequest[ppNumber] =
          (summary.personnelByRequest[ppNumber] ?? 0) + value;
        continue;
      }

      const docNumber = asString(row.getCell(DETAIL.docNumber).value);
      if (!docNumber) continue;
      const key = docNumber.trim().toLowerCase();
      // An ambiguous document number would link the wrong invoice to a request.
      if (duplicateDocs.has(key)) continue;
      if (!invoiceIdByDoc.has(key)) {
        notFound.add(docNumber);
        continue;
      }
      const asNum = Number(ppNumber);
      if (asNum > (ppByDoc.get(key) ?? 0)) ppByDoc.set(key, asNum);
    }
  }

  const requestIdByPp = new Map<string, string>();
  for (const req of requests) {
    const advance = advanceByPp.get(req.ppNumber);
    const personnel = summary.personnelByRequest[req.ppNumber];
    const notes = [
      personnel
        ? `Pessoal declarado neste pedido: ${personnel.toFixed(2)} € (o formulário agrega-o ` +
          `por fase TRL, por isso as linhas mensais de RH não ficam ligadas ao pedido).`
        : null,
      req.notes,
      advance ? `Adiantamento pago: ${advance.toFixed(2)} €.` : null,
      req.paid !== null ? `Pagamento realizado: ${req.paid.toFixed(2)} €.` : null,
      req.cuts > 0 ? `Cortes do financiador: ${req.cuts.toFixed(2)} €.` : null,
    ]
      .filter(Boolean)
      .join(" ");

    const existing = await prisma.paymentRequest.findUnique({
      where: { projectId_ppNumber: { projectId, ppNumber: req.ppNumber } },
      select: { id: true },
    });
    const request = await prisma.paymentRequest.upsert({
      where: { projectId_ppNumber: { projectId, ppNumber: req.ppNumber } },
      update: { requestedAmount: req.submitted, notes: notes || null },
      create: {
        projectId,
        ppNumber: req.ppNumber,
        requestedAmount: req.submitted,
        notes: notes || null,
      },
    });
    requestIdByPp.set(req.ppNumber, request.id);
    if (existing) summary.requestsUpdated++;
    else summary.requestsCreated++;
    summary.submittedTotal += req.submitted;
    if (req.approved !== null) summary.approvedTotal += req.approved;
    if (req.paid !== null) summary.paidTotal += req.paid;

    // A request the funder has not yet ruled on has no approved figure; only
    // record a decision once there is one.
    if (req.approved === null) continue;
    const status = req.approved === 0 ? "REJEITADO" : req.cuts > 0 ? "PARCIAL" : "APROVADO";
    const decision = await prisma.paymentDecision.findFirst({
      where: { paymentRequestId: request.id },
      select: { id: true },
    });
    const decisionData = {
      status,
      approvedAmount: req.approved,
      notes: notes || null,
      isCurrent: true,
    } as const;
    if (decision) {
      await prisma.paymentDecision.update({ where: { id: decision.id }, data: decisionData });
    } else {
      await prisma.paymentDecision.create({
        data: { paymentRequestId: request.id, ...decisionData },
      });
    }
    summary.decisionsRecorded++;
  }

  for (const [key, ppNumber] of ppByDoc) {
    const requestId = requestIdByPp.get(String(ppNumber));
    if (!requestId) continue;
    await prisma.invoice.update({
      where: { id: invoiceIdByDoc.get(key)! },
      data: { ppNumber: String(ppNumber), paymentRequestId: requestId },
    });
    summary.invoicesLinked++;
  }

  summary.invoicesNotFound = [...notFound].sort();
  for (const key of Object.keys(summary.personnelByRequest)) {
    summary.personnelByRequest[key] =
      Math.round(summary.personnelByRequest[key] * 100) / 100;
  }
  summary.submittedTotal = Math.round(summary.submittedTotal * 100) / 100;
  summary.approvedTotal = Math.round(summary.approvedTotal * 100) / 100;
  summary.paidTotal = Math.round(summary.paidTotal * 100) / 100;
  return summary;
}
