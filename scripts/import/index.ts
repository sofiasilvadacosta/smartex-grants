import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import path from "node:path";
import { prisma } from "../../src/lib/db";
import { seedProjects } from "./seed-projects";
import { importFamilyA } from "./family-a";
import { importFamilyB, PENDING_RECONCILIATION_PROJECTS } from "./family-b";
import { importPeopleAndCapacity } from "./people";
import { importRhSheets } from "./rh";

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

  console.log(
    `\nNão importados automaticamente (estrutura de sheet distinta, precisam de mapeamento dedicado): ${PENDING_RECONCILIATION_PROJECTS.join(", ")}`,
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
