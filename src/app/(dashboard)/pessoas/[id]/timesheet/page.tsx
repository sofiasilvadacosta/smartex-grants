import Link from "next/link";
import { notFound } from "next/navigation";
import { prisma } from "@/lib/db";
import { monthLabel } from "@/lib/format";
import { HOURS_PER_WORKING_DAY, hours as hoursLabel } from "@/lib/capacity";
import { eti, loadTimesheet, MONTHS_IN_YEAR } from "@/lib/timesheet";
import {
  addTimesheetActivity,
  saveTimesheetMonthContext,
  saveTimesheetRow,
} from "./actions";

const cell = "w-14 rounded border border-gray-300 px-1 py-0.5 text-right text-xs";
const num = "px-2 py-1 text-right text-xs tabular-nums";

function etiLabel(value: number | null): string {
  if (value === null) return "—";
  return value.toLocaleString("pt-PT", { minimumFractionDigits: 4, maximumFractionDigits: 5 });
}

export default async function TimesheetPage({
  params,
  searchParams,
}: {
  params: Promise<{ id: string }>;
  searchParams: Promise<{ ano?: string }>;
}) {
  const { id } = await params;
  const { ano } = await searchParams;

  const parsedYear = Number(ano);
  const year =
    Number.isInteger(parsedYear) && parsedYear >= 2000 && parsedYear <= 2100
      ? parsedYear
      : new Date().getUTCFullYear();

  const [timesheet, projects] = await Promise.all([
    loadTimesheet(id, year),
    prisma.project.findMany({
      where: { status: { not: "EXCLUDED" } },
      select: { id: true, code: true, name: true, budgetLines: { select: { activity: true } } },
      orderBy: { name: "asc" },
    }),
  ]);
  if (!timesheet) notFound();

  const unbalanced = timesheet.months.filter(
    (m) => m.accountedHours > 0 && (m.unaccountedHours > 0 || m.excessHours > 0),
  );

  const years = [year - 2, year - 1, year, year + 1, year + 2];

  return (
    <div>
      <p className="text-sm text-gray-500">
        <Link href="/pessoas" className="hover:underline">
          Pessoas
        </Link>{" "}
        /{" "}
        <Link href={`/pessoas/${timesheet.personId}`} className="hover:underline">
          {timesheet.personName}
        </Link>{" "}
        / Timesheet
      </p>
      <h1 className="mt-1 text-2xl font-semibold text-gray-900">
        Mapa de horas/ETI — {timesheet.personName}, {year}
      </h1>
      <p className="mt-1 text-sm text-gray-500">
        Jornada diária de {HOURS_PER_WORKING_DAY} h. Horas trabalháveis potenciais = jornada × dias
        úteis (exclui fins de semana e feriados). ETI imputado = horas ÷ horas potenciais.
      </p>

      <form method="get" className="mt-4 flex items-end gap-3">
        <label className="text-sm text-gray-600">
          Ano
          <select
            name="ano"
            defaultValue={String(year)}
            className="mt-1 block rounded border border-gray-300 px-2 py-1"
          >
            {years.map((y) => (
              <option key={y} value={y}>
                {y}
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

      <div
        className={`mt-6 rounded-lg border p-4 text-sm ${
          unbalanced.length === 0
            ? "border-green-200 bg-green-50 text-green-900"
            : "border-red-200 bg-red-50 text-red-900"
        }`}
      >
        {unbalanced.length === 0 ? (
          <p className="font-medium">
            Todos os meses fecham nas horas potenciais — o mapa pode ser submetido.
          </p>
        ) : (
          <>
            <p className="font-medium">
              {unbalanced.length} {unbalanced.length === 1 ? "mês não fecha" : "meses não fecham"}{" "}
              nas horas potenciais
            </p>
            <p className="mt-1 text-xs">
              O financiador exige que projetos + outras atividades + ausências igualem exatamente as
              horas trabalháveis potenciais de cada mês. Enquanto isto não fechar, o mapa é
              recusado.
            </p>
            <ul className="mt-2 space-y-0.5 text-xs">
              {unbalanced.map((m) => (
                <li key={m.yearMonth}>
                  {monthLabel(m.yearMonth)}: {hoursLabel(m.accountedHours)} repartidas de{" "}
                  {hoursLabel(m.baseHours)} —{" "}
                  {m.unaccountedHours > 0
                    ? `faltam ${hoursLabel(m.unaccountedHours)}`
                    : `${hoursLabel(m.excessHours)} a mais`}
                </li>
              ))}
            </ul>
          </>
        )}
      </div>

      <div className="mt-6 overflow-x-auto rounded-lg border border-gray-200 bg-white">
        <table className="min-w-full text-xs">
          <thead className="bg-gray-50">
            <tr>
              <th className="sticky left-0 z-10 bg-gray-50 px-2 py-2 text-left font-medium text-gray-500">
                Projeto / atividade
              </th>
              {timesheet.months.map((m) => (
                <th key={m.yearMonth} className="px-2 py-2 text-right font-medium text-gray-500">
                  {monthLabel(m.yearMonth)}
                </th>
              ))}
              <th className="px-2 py-2 text-right font-medium text-gray-500">Total</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-gray-100">
            <tr className="bg-gray-50/60">
              <td className="sticky left-0 z-10 bg-gray-50/60 px-2 py-1 font-medium text-gray-700">
                N — dias úteis trabalháveis
              </td>
              {timesheet.months.map((m) => (
                <td key={m.yearMonth} className={`${num} text-gray-500`}>
                  {m.workingDays ?? "—"}
                </td>
              ))}
              <td className={num} />
            </tr>
            <tr className="bg-gray-50/60">
              <td className="sticky left-0 z-10 bg-gray-50/60 px-2 py-1 font-medium text-gray-700">
                Horas trabalháveis potenciais
              </td>
              {timesheet.months.map((m) => (
                <td
                  key={m.yearMonth}
                  className={`${num} font-medium ${m.ownCapacityHours !== null ? "text-amber-700" : ""}`}
                  title={
                    m.ownCapacityHours !== null
                      ? `A folha de planeamento tem ${m.ownCapacityHours} h para esta pessoa neste mês. O ETI usa as ${m.baseHours} h do calendário, porque as ausências declaram-se na linha própria — mas confirma se o N deste técnico devia ser menor.`
                      : undefined
                  }
                >
                  {m.baseHours || "—"}
                  {m.ownCapacityHours !== null && "*"}
                </td>
              ))}
              <td className={`${num} font-medium`}>
                {timesheet.months.reduce((s, m) => s + m.baseHours, 0)}
              </td>
            </tr>

            {timesheet.projects.map((block) => (
              <>
                <tr key={`${block.projectId}-head`} className="bg-white">
                  <td
                    colSpan={MONTHS_IN_YEAR + 2}
                    className="sticky left-0 px-2 pt-3 pb-1 font-semibold text-gray-900"
                  >
                    {block.fundingProgram ? `${block.fundingProgram} · ` : ""}
                    <Link href={`/projetos/${block.projectId}`} className="hover:underline">
                      {block.name}
                    </Link>
                  </td>
                </tr>
                {block.rows.map((row) => (
                  <tr key={`${block.projectId}-${row.activity}`} className="hover:bg-gray-50">
                    <td className="sticky left-0 z-10 bg-white px-2 py-1">
                      <form
                        action={saveTimesheetRow}
                        id={`row-${block.projectId}-${row.activity}`}
                        className="contents"
                      >
                        <input type="hidden" name="personId" value={timesheet.personId} />
                        <input type="hidden" name="projectId" value={block.projectId} />
                        <input type="hidden" name="activity" value={row.activity} />
                        <input type="hidden" name="year" value={year} />
                      </form>
                      <span
                        className="block max-w-xs truncate text-gray-700"
                        title={row.activity || "(sem atividade)"}
                      >
                        {row.activity || "(sem atividade)"}
                      </span>
                    </td>
                    {row.hours.map((value, index) => (
                      <td key={index} className="px-1 py-1 text-right">
                        <input
                          form={`row-${block.projectId}-${row.activity}`}
                          name={`hours-${index + 1}`}
                          inputMode="decimal"
                          defaultValue={value > 0 ? String(value) : ""}
                          className={cell}
                          aria-label={`${row.activity} em ${timesheet.months[index].yearMonth}`}
                        />
                      </td>
                    ))}
                    <td className={num}>
                      <div className="flex items-center justify-end gap-2">
                        <span className="font-medium">
                          {row.hours.reduce((s, h) => s + h, 0)}
                        </span>
                        <button
                          form={`row-${block.projectId}-${row.activity}`}
                          type="submit"
                          className="text-xs text-gray-500 underline"
                        >
                          guardar
                        </button>
                      </div>
                    </td>
                  </tr>
                ))}
                <tr key={`${block.projectId}-eti`} className="text-gray-500">
                  <td className="sticky left-0 z-10 bg-white px-2 py-1 pl-4 italic">
                    Sub-Total ETI imputado
                  </td>
                  {block.totals.map((total, index) => (
                    <td key={index} className={num}>
                      {etiLabel(eti(total, timesheet.months[index].baseHours))}
                    </td>
                  ))}
                  <td className={num} />
                </tr>
                {block.unusedActivities.length > 0 && (
                  <tr key={`${block.projectId}-add`}>
                    <td colSpan={MONTHS_IN_YEAR + 2} className="px-2 py-2">
                      <form
                        action={addTimesheetActivity}
                        className="flex flex-wrap items-end gap-2 text-xs text-gray-600"
                      >
                        <input type="hidden" name="personId" value={timesheet.personId} />
                        <input type="hidden" name="projectId" value={block.projectId} />
                        <label>
                          Acrescentar atividade
                          <select
                            name="activity"
                            className="ml-1 rounded border border-gray-300 px-1 py-0.5"
                          >
                            {block.unusedActivities.map((activity) => (
                              <option key={activity} value={activity}>
                                {activity}
                              </option>
                            ))}
                          </select>
                        </label>
                        <label>
                          no mês
                          <select
                            name="yearMonth"
                            className="ml-1 rounded border border-gray-300 px-1 py-0.5"
                          >
                            {timesheet.months.map((m) => (
                              <option key={m.yearMonth} value={m.yearMonth}>
                                {monthLabel(m.yearMonth)}
                              </option>
                            ))}
                          </select>
                        </label>
                        <label>
                          com
                          <input
                            name="hours"
                            inputMode="decimal"
                            className="ml-1 w-14 rounded border border-gray-300 px-1 py-0.5 text-right"
                          />{" "}
                          h
                        </label>
                        <button type="submit" className="underline">
                          acrescentar
                        </button>
                      </form>
                    </td>
                  </tr>
                )}
              </>
            ))}

            <tr className="bg-gray-50/60">
              <td className="sticky left-0 z-10 bg-gray-50/60 px-2 py-1 font-medium text-gray-700">
                Outras atividades (horas)
              </td>
              {timesheet.months.map((m) => (
                <td key={m.yearMonth} className="px-1 py-1 text-right">
                  <form action={saveTimesheetMonthContext} className="flex justify-end gap-1">
                    <input type="hidden" name="personId" value={timesheet.personId} />
                    <input type="hidden" name="yearMonth" value={m.yearMonth} />
                    <input
                      name="otherHours"
                      inputMode="decimal"
                      defaultValue={m.otherHours > 0 ? String(m.otherHours) : ""}
                      className={cell}
                      aria-label={`Outras atividades em ${m.yearMonth}`}
                    />
                    <button type="submit" className="text-xs text-gray-400 underline">
                      ok
                    </button>
                  </form>
                </td>
              ))}
              <td className={num}>{timesheet.months.reduce((s, m) => s + m.otherHours, 0)}</td>
            </tr>
            <tr className="bg-gray-50/60 text-gray-500">
              <td className="sticky left-0 z-10 bg-gray-50/60 px-2 py-1 pl-4 italic">
                Férias/Baixas/Licenças/Faltas (horas)
              </td>
              {timesheet.months.map((m) => (
                <td key={m.yearMonth} className={num}>
                  {m.absenceHours || "—"}
                </td>
              ))}
              <td className={num}>{timesheet.months.reduce((s, m) => s + m.absenceHours, 0)}</td>
            </tr>

            <tr className="border-t-2 border-gray-300">
              <td className="sticky left-0 z-10 bg-white px-2 py-1 font-medium text-gray-900">
                Tempo Trabalho (horas)
              </td>
              {timesheet.months.map((m) => (
                <td key={m.yearMonth} className={`${num} font-medium`}>
                  {m.workedHours || "—"}
                </td>
              ))}
              <td className={`${num} font-medium`}>
                {timesheet.months.reduce((s, m) => s + m.workedHours, 0)}
              </td>
            </tr>
            <tr>
              <td className="sticky left-0 z-10 bg-white px-2 py-1 font-medium text-gray-900">
                Tempo Trabalho + Ausências (horas)
              </td>
              {timesheet.months.map((m) => {
                const bad = m.accountedHours > 0 && m.accountedHours !== m.baseHours;
                return (
                  <td
                    key={m.yearMonth}
                    className={`${num} font-medium ${bad ? "bg-red-50 text-red-700" : ""}`}
                    title={bad ? `Devia ser ${m.baseHours} h` : undefined}
                  >
                    {m.accountedHours || "—"}
                  </td>
                );
              })}
              <td className={`${num} font-medium`}>
                {timesheet.months.reduce((s, m) => s + m.accountedHours, 0)}
              </td>
            </tr>
            <tr className="text-gray-500">
              <td className="sticky left-0 z-10 bg-white px-2 py-1 italic">
                Tempo Trabalho + Ausências (ETI)
              </td>
              {timesheet.months.map((m) => (
                <td key={m.yearMonth} className={num}>
                  {etiLabel(eti(m.accountedHours, m.baseHours))}
                </td>
              ))}
              <td className={num} />
            </tr>
          </tbody>
        </table>
      </div>

      {timesheet.projects.length === 0 && (
        <div className="mt-4 rounded-lg border border-gray-200 bg-white p-4 text-sm text-gray-600">
          <p>
            Esta pessoa não tem horas registadas em {year}. Aloca-lhe horas no ecrã de Alocação de
            um projeto, ou acrescenta aqui:
          </p>
          <form
            action={addTimesheetActivity}
            className="mt-3 flex flex-wrap items-end gap-2 text-xs text-gray-600"
          >
            <input type="hidden" name="personId" value={timesheet.personId} />
            <label>
              Projeto
              <select name="projectId" className="ml-1 rounded border border-gray-300 px-1 py-0.5">
                {projects.map((p) => (
                  <option key={p.id} value={p.id}>
                    {p.name}
                  </option>
                ))}
              </select>
            </label>
            <label>
              Atividade
              <input
                name="activity"
                required
                placeholder="1 - Gestão e Planeamento"
                className="ml-1 w-56 rounded border border-gray-300 px-1 py-0.5"
              />
            </label>
            <label>
              Mês
              <select name="yearMonth" className="ml-1 rounded border border-gray-300 px-1 py-0.5">
                {timesheet.months.map((m) => (
                  <option key={m.yearMonth} value={m.yearMonth}>
                    {monthLabel(m.yearMonth)}
                  </option>
                ))}
              </select>
            </label>
            <label>
              Horas
              <input
                name="hours"
                inputMode="decimal"
                className="ml-1 w-14 rounded border border-gray-300 px-1 py-0.5 text-right"
              />
            </label>
            <button type="submit" className="underline">
              acrescentar
            </button>
          </form>
        </div>
      )}
    </div>
  );
}
