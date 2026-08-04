import Link from "next/link";
import { notFound } from "next/navigation";
import { prisma } from "@/lib/db";
import { eur, monthLabel } from "@/lib/format";
import { hours, imputationPercent, percent } from "@/lib/capacity";
import { loadCapacity } from "@/lib/capacity-data";
import { fteBasedCost, payInForce, salaryBasedCost } from "@/lib/personnel-cost";
import { saveProjectAllocation } from "./actions";

function currentYearMonth(): string {
  return new Date().toISOString().slice(0, 7);
}

/** The twelve months around a reference month, so the picker is never empty. */
function monthOptions(reference: string, extra: readonly string[]): string[] {
  const [year, month] = reference.split("-").map(Number);
  const generated: string[] = [];
  for (let offset = -6; offset <= 6; offset++) {
    const date = new Date(Date.UTC(year, month - 1 + offset, 1));
    generated.push(date.toISOString().slice(0, 7));
  }
  return [...new Set([...generated, ...extra])].sort();
}

export default async function AlocacaoPage({
  params,
  searchParams,
}: {
  params: Promise<{ id: string }>;
  searchParams: Promise<{ mes?: string }>;
}) {
  const { id } = await params;
  const { mes } = await searchParams;

  const project = await prisma.project.findUnique({
    where: { id },
    select: { id: true, name: true, code: true, fteRate: true },
  });
  if (!project) notFound();

  const yearMonth = /^\d{4}-(0[1-9]|1[0-2])$/.test(mes ?? "") ? mes! : currentYearMonth();
  const fteRate = project.fteRate === null ? null : Number(project.fteRate);

  const [people, capacity, allMonths] = await Promise.all([
    prisma.person.findMany({
      where: { active: true },
      orderBy: { name: "asc" },
      select: {
        id: true,
        name: true,
        initials: true,
        profile: true,
        salaries: {
          select: {
            effectiveFrom: true,
            monthlyBase: true,
            grossAnnual: true,
            socialSecurityRate: true,
          },
        },
      },
    }),
    loadCapacity({ months: [yearMonth] }),
    prisma.projectHoursAllocation.findMany({
      distinct: ["yearMonth"],
      select: { yearMonth: true },
      orderBy: { yearMonth: "asc" },
    }),
  ]);

  const [otherProjects, splitByActivity] = await Promise.all([
    prisma.project.findMany({
      where: { id: { not: project.id } },
      select: { id: true, code: true },
    }),
    // People whose hours on this project are already broken down by activity, as
    // the funder's timesheet requires. Their total cannot be edited here: this
    // screen holds one number per project and saving it would sit on top of the
    // activity rows rather than replace them.
    prisma.projectHoursAllocation.groupBy({
      by: ["personId"],
      where: { projectId: project.id, yearMonth, activity: { not: "" } },
      _count: { _all: true },
    }),
  ]);
  const otherCode = new Map(otherProjects.map((p) => [p.id, p.code]));
  const activityCount = new Map(splitByActivity.map((r) => [r.personId, r._count._all]));

  const rows = people.map((person) => {
    const month = capacity.get(person.id, yearMonth);
    const onThis = month?.allocatedByProject.get(project.id) ?? 0;
    const elsewhere = month
      ? [...month.allocatedByProject.entries()].filter(([projectId]) => projectId !== project.id)
      : [];
    const elsewhereHours = elsewhere.reduce((sum, [, h]) => sum + h, 0);
    const baseHours = month?.baseHours ?? 0;
    const share = imputationPercent(onThis, baseHours);

    // The two funding rules, side by side: a fixed rate per FTE (Texia,
    // TexQualis) never touches anyone's real pay, while everything else is the
    // 14/11 salary formula. Which one applies is a property of the project.
    const pay = payInForce(person.salaries, yearMonth);
    const cost =
      fteRate !== null
        ? share === null
          ? null
          : fteBasedCost({ fte: share, fteRate })
        : pay?.monthlyBase != null && share !== null
          ? salaryBasedCost({
              monthlyBase: pay.monthlyBase,
              allocationPercent: share,
              socialSecurityRate: pay.socialSecurityRate,
            })
          : null;

    return { person, month, onThis, elsewhere, elsewhereHours, baseHours, share, pay, cost };
  });

  const totalCost = rows.reduce((sum, r) => sum + (r.cost?.eligibleValue ?? 0), 0);
  const totalHours = rows.reduce((sum, r) => sum + r.onThis, 0);
  const allocatedRows = rows.filter((r) => r.onThis > 0);
  const overAllocated = rows.filter((r) => (r.month?.overAllocatedBy ?? 0) > 0);
  const missingPay = allocatedRows.filter((r) => r.cost === null);

  const months = monthOptions(
    yearMonth,
    allMonths.map((m) => m.yearMonth),
  );

  return (
    <div>
      <p className="text-sm text-gray-500">
        <Link href={`/projetos/${project.id}`} className="hover:underline">
          {project.name}
        </Link>{" "}
        / Alocação
      </p>
      <h1 className="mt-1 text-2xl font-semibold text-gray-900">
        Alocação de pessoas — {monthLabel(yearMonth)}
      </h1>
      <p className="mt-1 text-sm text-gray-500">
        {fteRate !== null ? (
          <>
            Este projeto é orçamentado a <strong>{eur(fteRate)} por FTE-mês</strong>: o custo
            elegível vem da fração do mês alocada, não do salário real de cada pessoa.
          </>
        ) : (
          <>
            Custo elegível pela regra do financiador:{" "}
            <strong>RBM × 14/11 × (1 + taxa SS) × % imputação</strong>.
          </>
        )}
      </p>

      <form method="get" className="mt-4 flex items-end gap-3">
        <label className="text-sm text-gray-600">
          Mês
          <select
            name="mes"
            defaultValue={yearMonth}
            className="mt-1 block rounded border border-gray-300 px-2 py-1"
          >
            {months.map((m) => (
              <option key={m} value={m}>
                {monthLabel(m)}
              </option>
            ))}
          </select>
        </label>
        <button
          type="submit"
          className="rounded-md border border-gray-300 px-4 py-2 text-sm font-medium text-gray-700 hover:bg-gray-50"
        >
          Ver
        </button>
      </form>

      <dl className="mt-6 grid grid-cols-2 gap-4 sm:grid-cols-4">
        <div className="rounded-lg border border-gray-200 bg-white p-4">
          <dt className="text-xs text-gray-500">Pessoas alocadas</dt>
          <dd className="mt-1 text-lg font-semibold text-gray-900">{allocatedRows.length}</dd>
        </div>
        <div className="rounded-lg border border-gray-200 bg-white p-4">
          <dt className="text-xs text-gray-500">Horas no projeto</dt>
          <dd className="mt-1 text-lg font-semibold text-gray-900">{hours(totalHours)}</dd>
        </div>
        <div className="rounded-lg border border-gray-200 bg-white p-4">
          <dt className="text-xs text-gray-500">Custo elegível do mês</dt>
          <dd className="mt-1 text-lg font-semibold text-gray-900">{eur(totalCost)}</dd>
        </div>
        <div
          className={`rounded-lg border p-4 ${
            overAllocated.length > 0 ? "border-red-200 bg-red-50" : "border-gray-200 bg-white"
          }`}
        >
          <dt className="text-xs text-gray-500">Acima de 100%</dt>
          <dd
            className={`mt-1 text-lg font-semibold ${
              overAllocated.length > 0 ? "text-red-800" : "text-gray-900"
            }`}
          >
            {overAllocated.length}
          </dd>
        </div>
      </dl>

      {missingPay.length > 0 && (
        <div className="mt-4 rounded-lg border border-amber-200 bg-amber-50 p-4 text-sm text-amber-900">
          <p className="font-medium">
            {missingPay.length} pessoa(s) alocada(s) sem custo calculável
          </p>
          <p className="mt-1 text-xs">
            {fteRate !== null
              ? "Falta o número de horas do mês para converter as horas em FTE."
              : "Falta a RBM elegível em vigor neste mês. Preencher na página da pessoa."}{" "}
            {missingPay.map((r) => r.person.name).join(", ")}.
          </p>
        </div>
      )}

      <div className="mt-6 overflow-x-auto rounded-lg border border-gray-200 bg-white">
        <table className="min-w-full divide-y divide-gray-200 text-sm">
          <thead className="bg-gray-50">
            <tr>
              <th className="px-3 py-2 text-left font-medium text-gray-500">Pessoa</th>
              <th className="px-3 py-2 text-right font-medium text-gray-500">
                {fteRate !== null ? "FTE" : "RBM"}
              </th>
              <th className="px-3 py-2 text-right font-medium text-gray-500">Horas neste</th>
              <th className="px-3 py-2 text-left font-medium text-gray-500">Noutros projetos</th>
              <th className="px-3 py-2 text-right font-medium text-gray-500">Disponível</th>
              <th className="px-3 py-2 text-right font-medium text-gray-500">Livre</th>
              <th className="px-3 py-2 text-right font-medium text-gray-500">Utilização</th>
              <th className="px-3 py-2 text-right font-medium text-gray-500">Custo elegível</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-gray-100">
            {rows.map((row) => {
              const over = (row.month?.overAllocatedBy ?? 0) > 0;
              return (
                <tr key={row.person.id} className={over ? "bg-red-50" : "hover:bg-gray-50"}>
                  <td className="px-3 py-2">
                    <Link href={`/pessoas/${row.person.id}`} className="font-medium hover:underline">
                      {row.person.name}
                    </Link>
                    <span className="ml-2 text-xs text-gray-400">{row.person.initials}</span>
                  </td>
                  <td className="px-3 py-2 text-right text-gray-500">
                    {fteRate !== null
                      ? row.share !== null
                        ? row.share.toFixed(2)
                        : "—"
                      : row.pay?.monthlyBase != null
                        ? eur(row.pay.monthlyBase)
                        : "—"}
                  </td>
                  <td className="px-3 py-2 text-right">
                    {activityCount.has(row.person.id) ? (
                      <span className="inline-flex items-center gap-2">
                        <span className="font-medium">{hours(row.onThis)}</span>
                        <Link
                          href={`/pessoas/${row.person.id}/timesheet?ano=${yearMonth.slice(0, 4)}`}
                          className="text-xs text-gray-500 underline"
                          title={`Repartido por ${activityCount.get(row.person.id)} atividade(s) — editar no mapa de horas`}
                        >
                          timesheet
                        </Link>
                      </span>
                    ) : (
                      <form
                        action={saveProjectAllocation}
                        className="flex items-center justify-end gap-1"
                      >
                        <input type="hidden" name="projectId" value={project.id} />
                        <input type="hidden" name="personId" value={row.person.id} />
                        <input type="hidden" name="yearMonth" value={yearMonth} />
                        <input
                          name="hours"
                          inputMode="decimal"
                          defaultValue={row.onThis > 0 ? String(row.onThis) : ""}
                          className="w-16 rounded border border-gray-300 px-1 py-0.5 text-right"
                          aria-label={`Horas de ${row.person.name} em ${yearMonth}`}
                        />
                        <label
                          className="text-xs text-gray-400"
                          title="Guardar mesmo que fique acima das horas disponíveis"
                        >
                          <input type="checkbox" name="allowOver" value="true" className="mr-0.5" />
                          &gt;100%
                        </label>
                        <button type="submit" className="text-xs text-gray-500 underline">
                          ok
                        </button>
                      </form>
                    )}
                  </td>
                  <td className="px-3 py-2 text-xs text-gray-500">
                    {row.elsewhere.length > 0
                      ? row.elsewhere
                          .map(([pid, h]) => `${otherCode.get(pid) ?? pid}: ${hours(h)}`)
                          .join(" · ")
                      : "—"}
                  </td>
                  <td className="px-3 py-2 text-right text-gray-500">
                    {hours(row.month?.availableHours ?? row.baseHours)}
                  </td>
                  <td
                    className={`px-3 py-2 text-right ${
                      (row.month?.freeHours ?? 0) < 0
                        ? "font-medium text-red-700"
                        : "text-gray-500"
                    }`}
                  >
                    {row.month ? hours(row.month.freeHours) : "—"}
                  </td>
                  <td
                    className={`px-3 py-2 text-right ${
                      over ? "font-medium text-red-700" : "text-gray-500"
                    }`}
                  >
                    {percent(row.month?.utilisation ?? null)}
                  </td>
                  <td className="px-3 py-2 text-right">
                    {row.cost ? (
                      <span title={`${percent(row.share)} do mês`}>
                        {eur(row.cost.eligibleValue)}
                      </span>
                    ) : row.onThis > 0 ? (
                      <span className="text-amber-700">—</span>
                    ) : (
                      <span className="text-gray-400">—</span>
                    )}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>

      <p className="mt-4 text-xs text-gray-500">
        Guardar horas que ultrapassem as disponíveis é recusado, a menos que marques
        <strong> &gt;100%</strong> na linha. O aviso conta todos os projetos, as ausências do mês e
        as horas reservadas para trabalho não financiado.
      </p>
    </div>
  );
}
