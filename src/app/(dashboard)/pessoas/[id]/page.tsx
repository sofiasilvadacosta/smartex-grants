import Link from "next/link";
import { notFound } from "next/navigation";
import { prisma } from "@/lib/db";
import { eur, monthLabel } from "@/lib/format";
import { hours, percent } from "@/lib/capacity";
import { loadCapacity } from "@/lib/capacity-data";
import { fullMonthlyEligibleCost, payInForce } from "@/lib/personnel-cost";
import {
  deleteAbsence,
  deleteSalaryRecord,
  saveAbsence,
  saveNonProjectHours,
  saveSalaryRecord,
} from "../actions";

const ABSENCE_LABEL: Record<string, string> = {
  VACATION: "Férias",
  SICK: "Doença",
  PARENTAL: "Parental",
  UNPAID: "Sem retribuição",
  OTHER: "Outra",
};

const input = "mt-1 w-full rounded border border-gray-300 px-2 py-1";
const button =
  "rounded-md bg-gray-900 px-4 py-2 text-sm font-medium text-white hover:bg-gray-800";

export default async function PessoaPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;

  const person = await prisma.person.findUnique({
    where: { id },
    include: {
      salaries: { orderBy: { effectiveFrom: "desc" } },
      absences: { orderBy: [{ yearMonth: "desc" }, { createdAt: "desc" }] },
    },
  });
  if (!person) notFound();

  const [capacity, projects] = await Promise.all([
    loadCapacity({ personIds: [person.id] }),
    prisma.project.findMany({
      where: { status: { not: "EXCLUDED" } },
      select: { id: true, code: true, name: true },
      orderBy: { name: "asc" },
    }),
  ]);
  const projectName = new Map(projects.map((p) => [p.id, p.code]));

  const thisMonth = new Date().toISOString().slice(0, 7);
  const pay = payInForce(person.salaries, thisMonth);

  // Newest first: what needs attention is almost always the recent end.
  const monthRows = [...capacity.byPersonMonth.values()].sort((a, b) =>
    b.yearMonth.localeCompare(a.yearMonth),
  );
  const overAllocatedMonths = monthRows.filter((m) => m.overAllocatedBy > 0);

  return (
    <div>
      <p className="text-sm text-gray-500">
        <Link href="/pessoas" className="hover:underline">
          Pessoas
        </Link>{" "}
        / {person.name}
      </p>
      <h1 className="mt-1 text-2xl font-semibold text-gray-900">{person.name}</h1>
      <p className="mt-1 text-sm text-gray-500">
        {person.initials}
        {person.profile ? ` · ${person.profile}` : ""}
        {person.entryDate ? ` · entrada ${person.entryDate.toLocaleDateString("pt-PT")}` : ""}
        {person.exitDate ? ` · saída ${person.exitDate.toLocaleDateString("pt-PT")}` : ""}
        {person.active ? "" : " · inativo"}
      </p>

      <div className="mt-6 grid grid-cols-1 gap-4 sm:grid-cols-3">
        <div className="rounded-lg border border-gray-200 bg-white p-4">
          <p className="text-xs text-gray-500">RBM elegível em {monthLabel(thisMonth)}</p>
          <p className="mt-1 text-lg font-semibold text-gray-900">
            {pay?.monthlyBase != null ? eur(pay.monthlyBase) : "—"}
          </p>
          {pay?.monthlyBase != null && (
            <p className="mt-1 text-xs text-gray-500">
              custo elegível a 100%: {eur(fullMonthlyEligibleCost(pay.monthlyBase, pay.socialSecurityRate ?? undefined))}
              /mês
            </p>
          )}
          {pay?.extrapolated && (
            <p className="mt-1 text-xs text-amber-700">
              Nenhum registo começa antes deste mês — valor do registo mais antigo.
            </p>
          )}
        </div>
        <div className="rounded-lg border border-gray-200 bg-white p-4">
          <p className="text-xs text-gray-500">Salário anual (RH)</p>
          <p className="mt-1 text-lg font-semibold text-gray-900">
            {pay?.grossAnnual != null ? eur(pay.grossAnnual) : "—"}
          </p>
          <p className="mt-1 text-xs text-gray-500">Informativo: não entra no custo elegível.</p>
        </div>
        <div
          className={`rounded-lg border p-4 ${
            overAllocatedMonths.length > 0
              ? "border-red-200 bg-red-50"
              : "border-gray-200 bg-white"
          }`}
        >
          <p className="text-xs text-gray-500">Meses acima de 100%</p>
          <p
            className={`mt-1 text-lg font-semibold ${
              overAllocatedMonths.length > 0 ? "text-red-800" : "text-gray-900"
            }`}
          >
            {overAllocatedMonths.length}
          </p>
          {overAllocatedMonths.length > 0 && (
            <p className="mt-1 text-xs text-red-800">
              {overAllocatedMonths
                .slice(0, 4)
                .map((m) => `${monthLabel(m.yearMonth)} (+${hours(m.overAllocatedBy)})`)
                .join(", ")}
              {overAllocatedMonths.length > 4 ? "…" : ""}
            </p>
          )}
        </div>
      </div>

      <h2 className="mt-8 text-lg font-medium text-gray-900">Remuneração</h2>
      <p className="mt-1 text-sm text-gray-500">
        Cada alteração é um registo novo com o mês em que passou a vigorar. O custo elegível de um
        mês usa o valor em vigor nesse mês, por isso um aumento nunca altera o passado.
      </p>
      <div className="mt-3 overflow-x-auto rounded-lg border border-gray-200 bg-white">
        <table className="min-w-full divide-y divide-gray-200 text-sm">
          <thead className="bg-gray-50">
            <tr>
              <th className="px-4 py-2 text-left font-medium text-gray-500">Desde</th>
              <th className="px-4 py-2 text-right font-medium text-gray-500">RBM elegível</th>
              <th className="px-4 py-2 text-right font-medium text-gray-500">Variação</th>
              <th className="px-4 py-2 text-right font-medium text-gray-500">Salário anual</th>
              <th className="px-4 py-2 text-right font-medium text-gray-500">Taxa SS</th>
              <th className="px-4 py-2 text-left font-medium text-gray-500">Motivo</th>
              <th className="px-4 py-2" />
            </tr>
          </thead>
          <tbody className="divide-y divide-gray-100">
            {person.salaries.length === 0 && (
              <tr>
                <td colSpan={7} className="px-4 py-3 text-gray-500">
                  Sem registos de remuneração.
                </td>
              </tr>
            )}
            {person.salaries.map((record, index) => {
              // The list is newest first, so the previous value is the next row.
              const previous = person.salaries[index + 1];
              const current = record.monthlyBase === null ? null : Number(record.monthlyBase);
              const before =
                previous?.monthlyBase === null || previous?.monthlyBase === undefined
                  ? null
                  : Number(previous.monthlyBase);
              const delta = current !== null && before !== null ? current - before : null;
              return (
                <tr key={record.id} className="hover:bg-gray-50">
                  <td className="px-4 py-2">{monthLabel(record.effectiveFrom)}</td>
                  <td className="px-4 py-2 text-right">
                    {current !== null ? eur(current) : <span className="text-amber-700">—</span>}
                  </td>
                  <td
                    className={`px-4 py-2 text-right text-xs ${
                      delta === null ? "text-gray-400" : delta > 0 ? "text-green-700" : "text-red-700"
                    }`}
                  >
                    {delta === null
                      ? "—"
                      : `${delta > 0 ? "+" : ""}${eur(delta)} (${percent(delta / before!)})`}
                  </td>
                  <td className="px-4 py-2 text-right text-gray-500">
                    {record.grossAnnual != null ? eur(Number(record.grossAnnual)) : "—"}
                  </td>
                  <td className="px-4 py-2 text-right text-gray-500">
                    {record.socialSecurityRate != null
                      ? percent(Number(record.socialSecurityRate))
                      : "—"}
                  </td>
                  <td className="max-w-md px-4 py-2 text-xs text-gray-500">
                    {record.reason ?? "—"}
                  </td>
                  <td className="px-4 py-2 text-right">
                    <form action={deleteSalaryRecord}>
                      <input type="hidden" name="id" value={record.id} />
                      <button
                        type="submit"
                        className="text-xs text-gray-400 underline hover:text-red-700"
                      >
                        apagar
                      </button>
                    </form>
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>

      <details className="mt-3 rounded-lg border border-gray-200 bg-white p-4">
        <summary className="cursor-pointer text-sm font-medium text-gray-700">
          Registar alteração de remuneração
        </summary>
        <form action={saveSalaryRecord} className="mt-4 grid grid-cols-1 gap-3 sm:grid-cols-3">
          <input type="hidden" name="personId" value={person.id} />
          <label className="text-sm text-gray-600">
            Em vigor desde (AAAA-MM)
            <input name="effectiveFrom" required placeholder="2026-09" className={input} />
          </label>
          <label className="text-sm text-gray-600">
            RBM elegível (€/mês)
            <input name="monthlyBase" inputMode="decimal" className={input} />
          </label>
          <label className="text-sm text-gray-600">
            Salário anual (€)
            <input name="grossAnnual" inputMode="decimal" className={input} />
          </label>
          <label className="text-sm text-gray-600">
            Taxa SS (fração, ex. 0,2375)
            <input name="socialSecurityRate" inputMode="decimal" className={input} />
          </label>
          <label className="text-sm text-gray-600 sm:col-span-2">
            Motivo
            <input name="reason" placeholder="revisão anual, promoção…" className={input} />
          </label>
          <div className="sm:col-span-3">
            <button type="submit" className={button}>
              Guardar
            </button>
            <span className="ml-3 text-xs text-gray-500">
              Um registo para um mês que já existe substitui esse registo.
            </span>
          </div>
        </form>
      </details>

      <h2 className="mt-8 text-lg font-medium text-gray-900">Ausências</h2>
      <p className="mt-1 text-sm text-gray-500">
        Dias úteis por mês. Reduzem as horas disponíveis para alocar (a {8} h/dia), mas não o custo
        elegível — a regra dos 14/11 do financiador já inclui as férias no custo de cada mês.
      </p>
      <div className="mt-3 overflow-x-auto rounded-lg border border-gray-200 bg-white">
        <table className="min-w-full divide-y divide-gray-200 text-sm">
          <thead className="bg-gray-50">
            <tr>
              <th className="px-4 py-2 text-left font-medium text-gray-500">Mês</th>
              <th className="px-4 py-2 text-left font-medium text-gray-500">Tipo</th>
              <th className="px-4 py-2 text-right font-medium text-gray-500">Dias</th>
              <th className="px-4 py-2 text-left font-medium text-gray-500">Notas</th>
              <th className="px-4 py-2" />
            </tr>
          </thead>
          <tbody className="divide-y divide-gray-100">
            {person.absences.length === 0 && (
              <tr>
                <td colSpan={5} className="px-4 py-3 text-gray-500">
                  Sem ausências registadas.
                </td>
              </tr>
            )}
            {person.absences.map((absence) => (
              <tr key={absence.id} className="hover:bg-gray-50">
                <td className="px-4 py-2">{monthLabel(absence.yearMonth)}</td>
                <td className="px-4 py-2 text-gray-500">
                  {ABSENCE_LABEL[absence.type] ?? absence.type}
                </td>
                <td className="px-4 py-2 text-right">{Number(absence.days)}</td>
                <td className="max-w-md px-4 py-2 text-xs text-gray-500">
                  {absence.notes ?? "—"}
                </td>
                <td className="px-4 py-2 text-right">
                  <form action={deleteAbsence}>
                    <input type="hidden" name="id" value={absence.id} />
                    <button
                      type="submit"
                      className="text-xs text-gray-400 underline hover:text-red-700"
                    >
                      apagar
                    </button>
                  </form>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      <details className="mt-3 rounded-lg border border-gray-200 bg-white p-4">
        <summary className="cursor-pointer text-sm font-medium text-gray-700">
          Registar ausência
        </summary>
        <form action={saveAbsence} className="mt-4 grid grid-cols-1 gap-3 sm:grid-cols-4">
          <input type="hidden" name="personId" value={person.id} />
          <label className="text-sm text-gray-600">
            Mês (AAAA-MM)
            <input name="yearMonth" required placeholder="2026-08" className={input} />
          </label>
          <label className="text-sm text-gray-600">
            Tipo
            <select name="type" className={input} defaultValue="VACATION">
              {Object.entries(ABSENCE_LABEL).map(([value, label]) => (
                <option key={value} value={value}>
                  {label}
                </option>
              ))}
            </select>
          </label>
          <label className="text-sm text-gray-600">
            Dias úteis
            <input name="days" required inputMode="decimal" className={input} />
          </label>
          <label className="text-sm text-gray-600">
            Notas
            <input name="notes" className={input} />
          </label>
          <div className="sm:col-span-4">
            <button type="submit" className={button}>
              Guardar
            </button>
          </div>
        </form>
      </details>

      <h2 className="mt-8 text-lg font-medium text-gray-900">Capacidade e alocação por mês</h2>
      <p className="mt-1 text-sm text-gray-500">
        Soma de todos os projetos. &quot;Fora de projetos&quot; são horas reservadas para trabalho
        não financiado — sem isso, quem está cheio de produto aparece como disponível.
      </p>
      <div className="mt-3 overflow-x-auto rounded-lg border border-gray-200 bg-white">
        <table className="min-w-full divide-y divide-gray-200 text-sm">
          <thead className="bg-gray-50">
            <tr>
              <th className="px-4 py-2 text-left font-medium text-gray-500">Mês</th>
              <th className="px-4 py-2 text-right font-medium text-gray-500">Horas do mês</th>
              <th className="px-4 py-2 text-right font-medium text-gray-500">Ausências</th>
              <th className="px-4 py-2 text-right font-medium text-gray-500">Fora de projetos</th>
              <th className="px-4 py-2 text-right font-medium text-gray-500">Disponível</th>
              <th className="px-4 py-2 text-right font-medium text-gray-500">Alocado</th>
              <th className="px-4 py-2 text-right font-medium text-gray-500">Livre</th>
              <th className="px-4 py-2 text-right font-medium text-gray-500">Utilização</th>
              <th className="px-4 py-2 text-left font-medium text-gray-500">Projetos</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-gray-100">
            {monthRows.length === 0 && (
              <tr>
                <td colSpan={9} className="px-4 py-3 text-gray-500">
                  Sem capacidade nem alocação registada.
                </td>
              </tr>
            )}
            {monthRows.map((month) => (
              <tr
                key={month.yearMonth}
                className={month.overAllocatedBy > 0 ? "bg-red-50" : "hover:bg-gray-50"}
              >
                <td className="px-4 py-2">{monthLabel(month.yearMonth)}</td>
                <td className="px-4 py-2 text-right text-gray-500">{hours(month.baseHours)}</td>
                <td className="px-4 py-2 text-right text-gray-500">
                  {month.absenceHours > 0 ? hours(month.absenceHours) : "—"}
                </td>
                <td className="px-4 py-2 text-right text-gray-500">
                  <form action={saveNonProjectHours} className="flex justify-end gap-1">
                    <input type="hidden" name="personId" value={person.id} />
                    <input type="hidden" name="yearMonth" value={month.yearMonth} />
                    <input
                      name="nonProjectHours"
                      inputMode="decimal"
                      defaultValue={month.reservedHours > 0 ? String(month.reservedHours) : ""}
                      className="w-16 rounded border border-gray-300 px-1 py-0.5 text-right"
                      aria-label={`Horas fora de projetos em ${month.yearMonth}`}
                    />
                    <button type="submit" className="text-xs text-gray-400 underline">
                      ok
                    </button>
                  </form>
                </td>
                <td className="px-4 py-2 text-right">{hours(month.availableHours)}</td>
                <td className="px-4 py-2 text-right">{hours(month.allocatedHours)}</td>
                <td
                  className={`px-4 py-2 text-right ${
                    month.freeHours < 0 ? "font-medium text-red-700" : "text-gray-500"
                  }`}
                >
                  {hours(month.freeHours)}
                </td>
                <td
                  className={`px-4 py-2 text-right ${
                    month.overAllocatedBy > 0 ? "font-medium text-red-700" : "text-gray-500"
                  }`}
                >
                  {percent(month.utilisation)}
                </td>
                <td className="px-4 py-2 text-xs text-gray-500">
                  {[...month.allocatedByProject.entries()]
                    .map(([id, h]) => `${projectName.get(id) ?? id}: ${hours(h)}`)
                    .join(" · ") || "—"}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}
