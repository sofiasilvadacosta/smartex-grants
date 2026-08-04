import { prisma } from "../../src/lib/db";

// Projects known from the DADOS sheet (Smartex_Gestao_Projetos_V4.xlsx) plus
// RHAQ and Internacionalização, which have real financial data in
// Grants_Approved_Execution_v3.xlsx but aren't listed in DADOS (older/
// differently-tracked grants). Dates for those two are read directly off
// their own sheets ("Data de Início"/"Data de Fim").
const PROJECTS = [
  { code: "TEXPACT", name: "TexP@ct", startDate: "2023-01-01", endDate: "2026-06-30" },
  { code: "PRODUTECH", name: "Produtech", startDate: "2023-01-01", endDate: "2026-06-30" },
  { code: "DEFECT_FREE", name: "Defect Free", startDate: "2024-10-01", endDate: "2026-08-31" },
  { code: "TEXIA", name: "Texia", startDate: "2025-01-01", endDate: "2026-12-31" },
  { code: "TEXQUALIS", name: "TexQualis", startDate: "2025-11-01", endDate: "2027-10-30" },
  { code: "RHAQ", name: "RHAQ", startDate: "2024-06-01", endDate: "2027-05-31" },
  {
    code: "INTERNACIONALIZACAO",
    name: "Internacionalização",
    startDate: "2025-09-23",
    endDate: "2027-09-22",
  },
] as const;

// Approved and running, but deliberately not managed in this platform, so it
// starts out of scope on a fresh database instead of showing as a card of zeros.
// The status is only set on create: taking it back into scope is a decision made
// in the app, and a re-import must not undo it.
const EXCLUDED_CODES = new Set(["RHAQ"]);

export async function seedProjects(): Promise<Record<string, string>> {
  const idByCode: Record<string, string> = {};
  for (const p of PROJECTS) {
    const project = await prisma.project.upsert({
      where: { code: p.code },
      update: { name: p.name, startDate: new Date(p.startDate), endDate: new Date(p.endDate) },
      create: {
        code: p.code,
        name: p.name,
        startDate: new Date(p.startDate),
        endDate: new Date(p.endDate),
        status: EXCLUDED_CODES.has(p.code) ? "EXCLUDED" : "ACTIVE",
      },
    });
    idByCode[p.code] = project.id;
  }
  return idByCode;
}
