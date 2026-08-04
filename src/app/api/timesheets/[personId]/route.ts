import { auth } from "@/lib/auth";
import { buildTimesheetWorkbook } from "@/lib/timesheet-export";

const XLSX_MIME = "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet";

function parseYears(raw: string | null): number[] | null {
  if (!raw) return null;
  const years = raw
    .split(",")
    .map((part) => Number(part.trim()))
    .filter((year) => Number.isInteger(year) && year >= 2000 && year <= 2100);
  // Bounded so a crafted query cannot ask for a thousand sheets.
  return years.length > 0 && years.length <= 10 ? [...new Set(years)].sort() : null;
}

export async function GET(
  request: Request,
  { params }: { params: Promise<{ personId: string }> },
) {
  // Route Handlers are reachable directly, so authorize here rather than
  // relying on proxy.ts coverage alone.
  const session = await auth();
  if (!session?.user) return new Response(null, { status: 401 });

  const { personId } = await params;
  const url = new URL(request.url);
  const projectId = url.searchParams.get("projeto");
  const years = parseYears(url.searchParams.get("anos"));

  if (!projectId) {
    return new Response("Falta o parâmetro 'projeto'.", { status: 400 });
  }
  if (!years) {
    return new Response("Falta o parâmetro 'anos' (ex. anos=2025,2026).", { status: 400 });
  }

  const result = await buildTimesheetWorkbook(personId, projectId, years);
  if (!result) return new Response(null, { status: 404 });
  if (!result.filename) {
    return new Response(
      `Sem horas, ausências ou outras atividades em ${years.join(", ")} para exportar.`,
      { status: 404 },
    );
  }

  const buffer = await result.workbook.xlsx.writeBuffer();

  return new Response(new Uint8Array(buffer), {
    headers: {
      "Content-Type": XLSX_MIME,
      "Content-Length": String(buffer.byteLength),
      // Quote-escape the filename so a name containing a quote can't break out
      // of the header value.
      "Content-Disposition": `attachment; filename="${result.filename.replace(/"/g, "")}"`,
      "Cache-Control": "private, no-store",
      // Surfaced as headers so the page can report them without rebuilding the
      // workbook: hours left out of a form are hours not claimed.
      ...(result.overflowProjects.length > 0
        ? { "X-Timesheet-Overflow": result.overflowProjects.join("; ") }
        : {}),
    },
  });
}
