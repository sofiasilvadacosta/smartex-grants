import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import path from "node:path";
import { prisma } from "../../src/lib/db";
import { seedProjects } from "./seed-projects";
import { importFamilyA } from "./family-a";
import { importFamilyB, PENDING_RECONCILIATION_PROJECTS } from "./family-b";
import { importPeopleAndCapacity } from "./people";
import { importRhSheets } from "./rh";
import { importSalaryHistory } from "./salary-history";
import { importFteProjects } from "./fte-projects";
import { importQuadroInvestimentos } from "./pp-quadro";
import { importPessoalFromPp } from "./pp-pessoal";
import { importMovimentos } from "./pp-movimentos";
import { importDeslocacoes } from "./pp-deslocacoes";
import { importDecisoes } from "./pp-decisoes";
import { importTexpactPedidos } from "./texpact-pedidos";
import { importReceipts } from "./receipts";
import { findTimesheetFiles, importTimesheet } from "./timesheets";
import { syncPaymentRequestsFromExecution } from "./lib/sync-payment-requests";

const IMPORTS_DIR = path.resolve(__dirname, "../../imports");
const GRANTS_WORKBOOK = path.join(IMPORTS_DIR, "Grants_Approved_Execution_v3.xlsx");
const GESTAO_WORKBOOK = path.join(IMPORTS_DIR, "Smartex_Gestao_Projetos_V4.xlsx");

function fileHash(filePath: string): string {
  return createHash("sha256").update(readFileSync(filePath)).digest("hex").slice(0, 16);
}

async function recordImportRun(sourceFileName: string, sheetName: string, counters: {
  processed: number;
  matched: number;
  unmatched: number;
  ambiguous: number;
}, sourceFileHash: string, startedAt: Date) {
  await prisma.importRun.create({
    data: {
      sourceFileName,
      sourceFileHash,
      sheetName,
      rowsProcessed: counters.processed,
      rowsMatched: counters.matched,
      rowsUnmatched: counters.unmatched,
      rowsAmbiguous: counters.ambiguous,
      startedAt,
      finishedAt: new Date(),
    },
  });
}

async function main() {
  console.log("Seeding projects...");
  const projectIds = await seedProjects();
  console.log(`Projects ready: ${Object.keys(projectIds).join(", ")}`);

  const grantsHash = fileHash(GRANTS_WORKBOOK);

  console.log("\nImporting Family A (Produtech, TexP@ct)...");
  const startA = new Date();
  const summaryA = await importFamilyA(GRANTS_WORKBOOK, projectIds);
  for (const [code, data] of Object.entries(summaryA)) {
    const { invoices } = data as { invoices: { processed: number; matched: number; unmatched: number; ambiguous: number } };
    await recordImportRun(
      path.basename(GRANTS_WORKBOOK),
      `${code}_Investments`,
      invoices,
      grantsHash,
      startA,
    );
  }
  console.log(JSON.stringify(summaryA, null, 2));
  for (const [code, data] of Object.entries(summaryA)) {
    const { budgetLines } = data as {
      budgetLines: { declaredTotal: number; sheetTotal: number | null };
    };
    const { declaredTotal, sheetTotal } = budgetLines;
    if (sheetTotal !== null && Math.abs(declaredTotal - sheetTotal) > 0.01) {
      console.warn(
        `\n⚠ ${code}: a coluna "Executado" lida por rubrica soma ${declaredTotal.toFixed(2)} €,\n` +
          `  mas a linha TOTAL da folha diz ${sheetTotal.toFixed(2)} €. Foi lida a coluna errada\n` +
          `  ou há linhas fora do intervalo — o painel de divergências não é fiável até resolver.`,
      );
    }
  }

  console.log("\nImporting Family B (Internacionalização, Defect Free)...");
  const startB = new Date();
  const summaryB = await importFamilyB(GRANTS_WORKBOOK, projectIds);
  for (const [code, data] of Object.entries(summaryB)) {
    const { invoices } = data as { invoices: { processed: number; matched: number; unmatched: number; ambiguous: number } };
    await recordImportRun(path.basename(GRANTS_WORKBOOK), `PP_${code}`, invoices, grantsHash, startB);
  }
  console.log(JSON.stringify(summaryB, null, 2));

  console.log("\nImporting people, work calendar and hours allocation...");
  const startPeople = new Date();
  const peopleSummary = await importPeopleAndCapacity(GESTAO_WORKBOOK, projectIds);
  await recordImportRun(
    path.basename(GESTAO_WORKBOOK),
    "DADOS+Recursos+HorasProdutivas",
    {
      processed:
        peopleSummary.people + peopleSummary.capacities + peopleSummary.hoursAllocations,
      matched: peopleSummary.hoursAllocations,
      unmatched: peopleSummary.unmatchedProjectLabels.length,
      ambiguous: 0,
    },
    fileHash(GESTAO_WORKBOOK),
    startPeople,
  );
  console.log(JSON.stringify(peopleSummary, null, 2));
  if (peopleSummary.duplicateInitials.length > 0) {
    console.warn(
      `\n⚠ Iniciais duplicadas em DADOS — só a primeira pessoa de cada par foi importada.\n` +
        `  As iniciais são a chave usada para atribuir horas na folha Recursos, por isso\n` +
        `  isto precisa de ser corrigido na origem:\n` +
        peopleSummary.duplicateInitials.map((d) => `    - ${d}`).join("\n"),
    );
  }

  console.log("\nImporting RH cost imputation (Produtech, TexP@ct)...");
  const startRh = new Date();
  const summaryRh = await importRhSheets(GRANTS_WORKBOOK, projectIds);
  for (const [code, counters] of Object.entries(summaryRh)) {
    await recordImportRun(path.basename(GRANTS_WORKBOOK), `${code}_RH`, counters, grantsHash, startRh);
  }
  console.log(JSON.stringify(summaryRh, null, 2));

  // After the RH sheets: those are what carry the dated monthly base the pay
  // history is reconstructed from.
  console.log("\nBuilding pay history (RBM per month + annual gross)...");
  const salaryHistory = await importSalaryHistory(GESTAO_WORKBOOK);
  console.log(
    JSON.stringify(
      { ...salaryHistory, peopleWithoutMonthlyBase: salaryHistory.peopleWithoutMonthlyBase.length },
      null,
      2,
    ),
  );
  if (salaryHistory.peopleWithoutMonthlyBase.length > 0) {
    console.warn(
      `\n⚠ ${salaryHistory.peopleWithoutMonthlyBase.length} pessoa(s) sem RBM Elegível — não\n` +
        `  constam de nenhuma folha de RH, por isso só se conhece o salário anual e não se\n` +
        `  consegue calcular custo elegível de pessoal para elas. Preencher a RBM na página\n` +
        `  da pessoa quando forem alocadas a um projeto.`,
    );
  }

  console.log("\nImporting FTE-based budgets (Texia, TexQualis)...");
  const startFte = new Date();
  const summaryFte = await importFteProjects(GRANTS_WORKBOOK, projectIds);
  for (const [code, s] of Object.entries(summaryFte)) {
    await recordImportRun(
      path.basename(GRANTS_WORKBOOK),
      `${code}_orcamento_FTE`,
      {
        processed: s.budgetLinesCreated + s.budgetLinesUpdated,
        matched: s.budgetLinesCreated + s.budgetLinesUpdated,
        unmatched: s.skippedRows.length,
        ambiguous: 0,
      },
      grantsHash,
      startFte,
    );
  }
  console.log(JSON.stringify(summaryFte, null, 2));
  for (const [code, s] of Object.entries(summaryFte)) {
    if (s.moneyTotalMismatchCount > 0) {
      console.warn(
        `\n⚠ ${code}: a coluna "Investimento Total" da folha não soma todos os anos em ` +
          `${s.moneyTotalMismatchCount} linha(s),\n` +
          `  ficando ${s.moneyTotalMismatchAmount.toFixed(2)} € abaixo da soma anual. Foi usada a soma\n` +
          `  anual, que é o que a própria linha Total da folha usa. A corrigir na origem.`,
      );
    }
    if (s.fteTotalMismatches.length > 0) {
      console.warn(
        `\n⚠ ${code}: ${s.fteTotalMismatches.length} linha(s) com FTE anual preenchido mas coluna Total a zero\n` +
          `  — podem ser trabalho cancelado ou fórmula em falta. Foram importadas com o valor anual:\n` +
          s.fteTotalMismatches.map((m) => `    - ${m}`).join("\n"),
      );
    }
  }

  console.log("\nImporting Quadro de Investimentos from payment-request PDFs...");
  // Every project whose approved budget only exists in the funder's own form.
  // Texia and TexQualis are absent on purpose: their budget comes from the
  // planning spreadsheet broken down by profile, which is finer than the
  // funder's one-line-per-activity form and adds up to the same total.
  const QUADRO_PROJECTS: [string, string][] = [
    ["DEFECT_FREE", "DefectFree_Quadro_Investimentos.csv"],
    ["INTERNACIONALIZACAO", "Internacionalizacao_Quadro_Investimentos.csv"],
  ];
  for (const [code, file] of QUADRO_PROJECTS) {
    const summary = await importQuadroInvestimentos(
      path.join(IMPORTS_DIR, file),
      projectIds[code],
    );
    if (summary) {
      console.log(`${code}:`, JSON.stringify(summary, null, 2));
    } else {
      console.log(`  (sem ${file} em imports/ — ver scripts/import/README.md)`);
    }
  }

  const movimentosSummary = await importMovimentos(
    path.join(IMPORTS_DIR, "FPP012270004_Movimentos.xlsx"),
    projectIds.DEFECT_FREE,
    "PP Defect Free",
  );
  if (movimentosSummary) {
    console.log("\nDEFECT_FREE movimentos:", JSON.stringify(movimentosSummary, null, 2));
  }

  const deslocacoesSummary = await importDeslocacoes(
    path.join(IMPORTS_DIR, "DefectFree_Deslocacoes.csv"),
    projectIds.DEFECT_FREE,
  );
  if (deslocacoesSummary) {
    console.log("\nDEFECT_FREE deslocações:", JSON.stringify(deslocacoesSummary, null, 2));
  }

  const pessoalSummary = await importPessoalFromPp(
    path.join(IMPORTS_DIR, "DefectFree_Pessoal.csv"),
    path.join(IMPORTS_DIR, "DefectFree_Pessoal_Atividades.txt"),
    projectIds.DEFECT_FREE,
  );
  if (pessoalSummary) {
    console.log("\nDEFECT_FREE pessoal:", JSON.stringify(pessoalSummary, null, 2));
    if (pessoalSummary.withActivity === 0) {
      console.warn(
        `\n⚠ As ${pessoalSummary.processed} linhas de pessoal do Defect Free ficam por reconciliar:\n` +
          `  sem DefectFree_Pessoal_Atividades.txt não se sabe a atividade de cada movimento, e\n` +
          `  inferi-la pela descrição não reconcilia com os totais por atividade do quadro\n` +
          `  aprovado. Ver scripts/import/README.md.`,
      );
    } else if (pessoalSummary.ambiguousWithinActivity > 0) {
      console.warn(
        `\n⚠ ${pessoalSummary.ambiguousWithinActivity} linhas de pessoal do Defect Free ficam ` +
          `ambíguas:\n  a atividade é conhecida, mas o financiador dividiu-a em várias rubricas ` +
          `anuais e o\n  formulário não diz a qual pertence cada movimento. Escolher no ecrã de ` +
          `reconciliação.`,
      );
    }
  }

  // Runs after every execution import: the payment requests and the amount each
  // one submitted are derived from the rows that declare them, never assumed.
  const ppSync = await syncPaymentRequestsFromExecution(projectIds.DEFECT_FREE);
  console.log("\nDEFECT_FREE pedidos de pagamento:", JSON.stringify(ppSync, null, 2));

  // From "Fundamentação da análise 12270_3_3" (see imports/DefectFree_Decisao_PP3.pdf).
  const decisoes = await importDecisoes(IMPORTS_DIR, projectIds.DEFECT_FREE, [
    {
      ppNumber: "3",
      decisionDate: "2026-02-11",
      status: "PARCIAL",
      approvedAmount: 287621.14,
      notes:
        "Despesa elegível apresentada 330 754,66 € (inclui 7% de custos indiretos); validada " +
        "287 621,14 €, incentivo 222 063,08 €. Reduções: ETI de setembro/2025 na atividade 1 " +
        "(-6 642,59 €, atividade concluída em agosto), janeiro/2025 na atividade 3 " +
        "(-2 814,59 €, início em fevereiro) e julho/2025 na atividade 4 (-9 079,28 €, início " +
        "em agosto); IDs de investimento 4, 8, 15, 16, 17, 18 e 21 limitados ao valor aprovado " +
        "em candidatura (-24 596,89 €). Já pago 58 970,29 € de adiantamento, pelo que o " +
        "remanescente proposto é 163 092,79 €.",
      // The analysis states an advance of 58 970,29 € was already paid.
      paidAmount: 58970.29,
      documentFile: "DefectFree_Decisao_PP3.pdf",
    },
  ]);
  console.log("\nDEFECT_FREE decisões:", JSON.stringify(decisoes, null, 2));

  // Texia and TexQualis have no invoices; their whole execution so far is the
  // personnel declared in the portal's payment-request form.
  for (const [code, file] of [
    ["TEXIA", "Texia_Pessoal.csv"],
    ["TEXQUALIS", "TexQualis_Pessoal.csv"],
  ] as const) {
    const summary = await importPessoalFromPp(
      path.join(IMPORTS_DIR, file),
      // No per-technician activity export for these two yet, so every row
      // imports unreconciled; see scripts/import/README.md.
      path.join(IMPORTS_DIR, file.replace("_Pessoal.csv", "_Pessoal_Atividades.txt")),
      projectIds[code],
    );
    if (!summary) continue;
    console.log(`\n${code} pessoal:`, JSON.stringify(summary, null, 2));
    const sync = await syncPaymentRequestsFromExecution(projectIds[code]);
    console.log(`${code} pedidos de pagamento:`, JSON.stringify(sync));
  }

  // From "DECISÃO DE CERTIFICAÇÃO DE DESPESA/PAGAMENTO/ENCERRAMENTO", PRR
  // projeto 61 / formalização 21 (imports/TexPact_Decisao_PP11.pdf). It rules
  // on the whole Agenda Texp@ct consortium; only Smartex's own section is
  // recorded here.
  const texpactDecisoes = await importDecisoes(IMPORTS_DIR, projectIds.TEXPACT, [
    {
      ppNumber: "11",
      decisionDate: "2026-08-02",
      // Favourable overall, but two of Smartex's items were not validated.
      status: "PARCIAL",
      requestedAmount: 166607.26,
      approvedAmount: 185245.91,
      notes:
        "11º Pedido de Reembolso Intercalar da Agenda 61 - Texp@ct, submetido pelo líder do " +
        "consórcio em 2026-05-15 (despesas até março de 2026). A Smartex reportou 166 607,26 € " +
        "— Pessoal 87 568,62 €, investigação contratual 40 371,93 €, instrumentos e equipamento " +
        "37 408,71 €, matérias-primas 1 188,00 €, promoção e divulgação 70,00 €. Despesa apurada " +
        "185 245,91 € (inclui custos indiretos do Aviso 02/C05-i01/2022). Não validados: " +
        "comprovante 129 (cartões de visita, sem enquadramento no nº de ordem 590) e comprovante " +
        "115 (descrição não permite concluir sobre o enquadramento). O financiador assinala que " +
        "os instrumentos e equipamento excedem o aprovado na rubrica: foram validados por caberem " +
        "no total da tipologia IDT, mas pedidos futuros podem ser limitados. Exige ainda " +
        "fundamentação por comprovante da utilização dos equipamentos do nº de ordem 221. " +
        "Consórcio: elegível 3 201 276,98 €, incentivo 2 409 314,75 €, pagamento 762 645,51 €.",
      documentFile: "TexPact_Decisao_PP11.pdf",
    },
  ]);
  console.log("\nTEXPACT decisões:", JSON.stringify(texpactDecisoes, null, 2));

  const texpactPedidos = await importTexpactPedidos(
    path.join(IMPORTS_DIR, "TexPact_Pedidos_Pagamento.xlsx"),
    projectIds.TEXPACT,
  );
  if (texpactPedidos) {
    console.log("\nTEXPACT pedidos de pagamento:", JSON.stringify(texpactPedidos, null, 2));
  }

  // The funder identifies a project by its own number on the timesheet form.
  const PROJECT_CODE_BY_NUMBER: Record<string, string> = {
    "20783": "TEXQUALIS",
  };
  const timesheetFiles = findTimesheetFiles(IMPORTS_DIR);
  if (timesheetFiles.length > 0) {
    console.log(`\nImporting ${timesheetFiles.length} mapa(s) de horas/ETI...`);
    for (const file of timesheetFiles) {
      const summary = await importTimesheet(file, PROJECT_CODE_BY_NUMBER, projectIds);
      if (!summary) continue;
      console.log(`${path.basename(file)}:`, JSON.stringify(summary, null, 2));
      if (summary.problems.length > 0) {
        console.warn(
          `\n⚠ ${path.basename(file)} não foi importado:\n` +
            summary.problems.map((p) => `    - ${p}`).join("\n"),
        );
      }
      if (summary.calendarMismatches.length > 0) {
        console.warn(
          `\n⚠ ${path.basename(file)}: ${summary.calendarMismatches.length} mês(es) em que a\n` +
            `  linha "Nº de dias úteis trabalháveis" do ficheiro não coincide com o calendário da\n` +
            `  empresa. Enquanto não for corrigida no ficheiro, todos os ETI dessa folha ficam\n` +
            `  errados — e o ETI é o que multiplica pelo custo unitário:\n` +
            summary.calendarMismatches.map((m) => `    - ${m}`).join("\n"),
        );
      }
      if (summary.unbalancedMonths.length > 0) {
        console.warn(
          `\n⚠ ${path.basename(file)}: ${summary.unbalancedMonths.length} mês(es) em que a\n` +
            `  repartição não iguala as horas trabalháveis potenciais — o financiador exige que\n` +
            `  iguale. Foram importados como estão, para se ver o problema na app:\n` +
            summary.unbalancedMonths.map((m) => `    - ${m}`).join("\n"),
        );
      }
    }
  }

  // Receipts run last: linking a transfer to a request needs every request and
  // its paid amount already in place.
  const receipts = await importReceipts(GRANTS_WORKBOOK, projectIds);
  console.log("\nRecebimentos:", JSON.stringify(receipts, null, 2));
  if (Object.keys(receipts.outOfScope).length > 0) {
    console.warn(
      `\n⚠ ${Object.keys(receipts.outOfScope).length} descrição(ões) de recebimento não ` +
        `correspondem a nenhum projeto desta plataforma — são apoios a outras\n` +
        `  operações e ficam de fora:\n` +
        Object.entries(receipts.outOfScope)
          .map(([d, v]) => `    - ${d}: ${v.toFixed(2)} €`)
          .join("\n"),
    );
  }

  console.log(
    `\nNão importados (excluídos por decisão): ${PENDING_RECONCILIATION_PROJECTS.join(", ")}`,
  );

  console.log("\nDone.");
}

main()
  .catch((err) => {
    console.error(err);
    process.exitCode = 1;
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
