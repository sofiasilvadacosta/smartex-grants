import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import path from "node:path";
import { prisma } from "../../src/lib/db";
import { seedProjects } from "./seed-projects";
import { importFamilyA } from "./family-a";
import { importFamilyB, PENDING_RECONCILIATION_PROJECTS } from "./family-b";
import { importPeopleAndCapacity } from "./people";
import { importRhSheets } from "./rh";
import { importFteProjects } from "./fte-projects";
import { importQuadroInvestimentos } from "./pp-quadro";
import { importPessoalFromPp } from "./pp-pessoal";
import { importMovimentos } from "./pp-movimentos";
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
  const quadroSummary = await importQuadroInvestimentos(
    path.join(IMPORTS_DIR, "DefectFree_Quadro_Investimentos.csv"),
    projectIds.DEFECT_FREE,
  );
  if (quadroSummary) {
    console.log("DEFECT_FREE:", JSON.stringify(quadroSummary, null, 2));
  } else {
    console.log(
      "  (sem DefectFree_Quadro_Investimentos.csv em imports/ — ver scripts/import/README.md)",
    );
  }

  const movimentosSummary = await importMovimentos(
    path.join(IMPORTS_DIR, "FPP012270004_Movimentos.xlsx"),
    projectIds.DEFECT_FREE,
    "PP Defect Free",
  );
  if (movimentosSummary) {
    console.log("\nDEFECT_FREE movimentos:", JSON.stringify(movimentosSummary, null, 2));
  }

  const pessoalSummary = await importPessoalFromPp(
    path.join(IMPORTS_DIR, "DefectFree_Pessoal.csv"),
    projectIds.DEFECT_FREE,
  );
  if (pessoalSummary) {
    console.log("\nDEFECT_FREE pessoal:", JSON.stringify(pessoalSummary, null, 2));
    console.warn(
      `\n⚠ As ${pessoalSummary.processed} linhas de pessoal do Defect Free ficam por reconciliar:\n` +
        `  o formulário do portal não indica a atividade nem o Nº de ordem de cada linha, e\n` +
        `  inferi-la pela descrição não reconcilia com os totais por atividade do quadro\n` +
        `  aprovado. Atribuir a rubrica no ecrã de reconciliação.`,
    );
  }

  // Runs after every execution import: the payment requests and the amount each
  // one submitted are derived from the rows that declare them, never assumed.
  const ppSync = await syncPaymentRequestsFromExecution(projectIds.DEFECT_FREE);
  console.log("\nDEFECT_FREE pedidos de pagamento:", JSON.stringify(ppSync, null, 2));

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
