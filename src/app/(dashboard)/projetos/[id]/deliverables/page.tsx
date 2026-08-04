import Link from "next/link";
import { notFound } from "next/navigation";
import { prisma } from "@/lib/db";
import { createDeliverable, deleteDeliverable, updateDeliverableStatus } from "./actions";

const TYPE_LABEL: Record<string, string> = {
  DELIVERABLE: "Deliverable",
  MILESTONE: "Milestone",
};

const STATUS_LABEL: Record<string, string> = {
  PLANNED: "Planeado",
  IN_PROGRESS: "Em curso",
  DONE: "Concluído",
  CANCELLED: "Cancelado",
};

const STATUS_STYLE: Record<string, string> = {
  PLANNED: "bg-gray-100 text-gray-600",
  IN_PROGRESS: "bg-blue-100 text-blue-700",
  DONE: "bg-green-100 text-green-700",
  CANCELLED: "bg-gray-100 text-gray-400",
};

function day(date: Date | null) {
  return date ? date.toLocaleDateString("pt-PT") : "—";
}

export default async function DeliverablesPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id: projectId } = await params;

  const [project, deliverables, people] = await Promise.all([
    prisma.project.findUnique({ where: { id: projectId }, select: { name: true } }),
    prisma.deliverable.findMany({
      where: { projectId },
      // Undated entries last: a due date is what makes the list actionable.
      orderBy: [{ dueDate: { sort: "asc", nulls: "last" } }, { name: "asc" }],
      include: { responsiblePerson: { select: { name: true } } },
    }),
    prisma.person.findMany({
      where: { active: true },
      select: { id: true, name: true },
      orderBy: { name: "asc" },
    }),
  ]);
  if (!project) notFound();

  const today = new Date();
  const late = deliverables.filter(
    (d) => d.dueDate && d.dueDate < today && d.status !== "DONE" && d.status !== "CANCELLED",
  );

  return (
    <div>
      <h1 className="text-2xl font-semibold text-gray-900">
        Deliverables e milestones — {project.name}
      </h1>
      <Link href={`/projetos/${projectId}`} className="text-sm text-gray-500 hover:text-gray-900">
        ← voltar ao projeto
      </Link>

      {late.length > 0 && (
        <p className="mt-6 rounded-lg border border-amber-200 bg-amber-50 p-4 text-sm text-amber-800">
          {late.length} entrada(s) com prazo passado e ainda não concluídas:{" "}
          {late.map((d) => d.name).join(", ")}.
        </p>
      )}

      <div className="mt-6 overflow-hidden rounded-lg border border-gray-200 bg-white">
        <table className="min-w-full divide-y divide-gray-200 text-sm">
          <thead className="bg-gray-50">
            <tr>
              <th className="px-4 py-2 text-left font-medium text-gray-500">Nome</th>
              <th className="px-4 py-2 text-left font-medium text-gray-500">Tipo</th>
              <th className="px-4 py-2 text-left font-medium text-gray-500">Atividade</th>
              <th className="px-4 py-2 text-left font-medium text-gray-500">Prazo</th>
              <th className="px-4 py-2 text-left font-medium text-gray-500">Responsável</th>
              <th className="px-4 py-2 text-left font-medium text-gray-500">Estado</th>
              <th className="px-4 py-2"></th>
            </tr>
          </thead>
          <tbody className="divide-y divide-gray-100">
            {deliverables.map((deliverable) => {
              const isLate =
                deliverable.dueDate &&
                deliverable.dueDate < today &&
                deliverable.status !== "DONE" &&
                deliverable.status !== "CANCELLED";
              return (
                <tr key={deliverable.id} className="hover:bg-gray-50">
                  <td className="px-4 py-2 text-gray-900">
                    {deliverable.name}
                    {deliverable.notes && (
                      <span className="block text-xs text-gray-400">{deliverable.notes}</span>
                    )}
                  </td>
                  <td className="px-4 py-2 text-gray-500">
                    {TYPE_LABEL[deliverable.type] ?? deliverable.type}
                  </td>
                  <td className="px-4 py-2 text-gray-500">{deliverable.activity || "—"}</td>
                  <td className={`px-4 py-2 ${isLate ? "font-medium text-amber-700" : "text-gray-500"}`}>
                    {day(deliverable.dueDate)}
                  </td>
                  <td className="px-4 py-2 text-gray-500">
                    {deliverable.responsiblePerson?.name ?? "—"}
                  </td>
                  <td className="px-4 py-2">
                    <span
                      className={`rounded-full px-2 py-0.5 text-xs font-medium ${
                        STATUS_STYLE[deliverable.status] ?? "bg-gray-100 text-gray-600"
                      }`}
                    >
                      {STATUS_LABEL[deliverable.status] ?? deliverable.status}
                    </span>
                    {deliverable.status === "DONE" && (
                      <span className="ml-2 text-xs text-gray-400">
                        {day(deliverable.completionDate)}
                      </span>
                    )}
                  </td>
                  <td className="px-4 py-2 text-right">
                    <div className="flex items-center justify-end gap-2">
                      <form action={updateDeliverableStatus} className="flex items-center gap-1">
                        <input type="hidden" name="deliverableId" value={deliverable.id} />
                        <select
                          name="status"
                          defaultValue={deliverable.status}
                          className="rounded border border-gray-300 px-2 py-1 text-xs"
                        >
                          {Object.entries(STATUS_LABEL).map(([value, label]) => (
                            <option key={value} value={value}>
                              {label}
                            </option>
                          ))}
                        </select>
                        <button type="submit" className="text-xs text-gray-400 hover:text-gray-900">
                          guardar
                        </button>
                      </form>
                      <form action={deleteDeliverable}>
                        <input type="hidden" name="deliverableId" value={deliverable.id} />
                        <button type="submit" className="text-xs text-gray-400 hover:text-red-600">
                          remover
                        </button>
                      </form>
                    </div>
                  </td>
                </tr>
              );
            })}
            {deliverables.length === 0 && (
              <tr>
                <td colSpan={7} className="px-4 py-6 text-center text-gray-400">
                  Sem deliverables ou milestones registados.
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>

      <details className="mt-4 rounded-lg border border-gray-200 bg-white p-4">
        <summary className="cursor-pointer text-sm font-medium text-gray-700">
          Novo deliverable ou milestone
        </summary>
        <form action={createDeliverable} className="mt-4 grid grid-cols-1 gap-3 sm:grid-cols-2">
          <input type="hidden" name="projectId" value={projectId} />
          <label className="text-sm text-gray-600 sm:col-span-2">
            Nome
            <input
              name="name"
              required
              className="mt-1 w-full rounded border border-gray-300 px-2 py-1"
            />
          </label>
          <label className="text-sm text-gray-600">
            Tipo
            <select name="type" className="mt-1 w-full rounded border border-gray-300 px-2 py-1">
              <option value="DELIVERABLE">Deliverable</option>
              <option value="MILESTONE">Milestone</option>
            </select>
          </label>
          <label className="text-sm text-gray-600">
            Atividade (opcional)
            <input
              name="activity"
              placeholder="ex: 3"
              className="mt-1 w-full rounded border border-gray-300 px-2 py-1"
            />
          </label>
          <label className="text-sm text-gray-600">
            Prazo
            <input
              type="date"
              name="dueDate"
              className="mt-1 w-full rounded border border-gray-300 px-2 py-1"
            />
          </label>
          <label className="text-sm text-gray-600">
            Responsável
            <select
              name="responsiblePersonId"
              className="mt-1 w-full rounded border border-gray-300 px-2 py-1"
            >
              <option value="">— sem responsável —</option>
              {people.map((person) => (
                <option key={person.id} value={person.id}>
                  {person.name}
                </option>
              ))}
            </select>
          </label>
          <label className="text-sm text-gray-600 sm:col-span-2">
            Notas
            <input name="notes" className="mt-1 w-full rounded border border-gray-300 px-2 py-1" />
          </label>
          <div className="sm:col-span-2">
            <button
              type="submit"
              className="rounded-md bg-gray-900 px-4 py-2 text-sm font-medium text-white hover:bg-gray-800"
            >
              Adicionar
            </button>
          </div>
        </form>
      </details>
    </div>
  );
}
