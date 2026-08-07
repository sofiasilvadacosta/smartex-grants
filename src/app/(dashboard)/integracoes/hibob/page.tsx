import Link from "next/link";
import { auth } from "@/lib/auth";
import { prisma } from "@/lib/db";
import { fetchPeople, HibobError, isConfigured } from "@/lib/hibob";
import { resolvePersonByName } from "@/lib/people-match";

// Reading before writing. A first sync against a system whose exact response
// shape is unknown should show what it found and what it would change, and only
// then be allowed to change it — so this page never writes.
//
// It also serves as the discovery step: the raw field names of the first record
// are printed, which is what the mapping in src/lib/hibob.ts has to be finished
// against.

export const dynamic = "force-dynamic";

interface Report {
  ok: boolean;
  message: string;
  total?: number;
  sampleKeys?: string[];
  sample?: string;
  matched?: { name: string; how: string; hibob: string }[];
  unmatched?: { hibob: string; email: string | null }[];
  missingInHibob?: string[];
}

async function runPreview(): Promise<Report> {
  try {
    const probe = await fetchPeople();
    const people = await prisma.person.findMany({
      select: { id: true, name: true, email: true, hibobId: true, active: true },
    });
    const byHibobId = new Map(people.filter((p) => p.hibobId).map((p) => [p.hibobId!, p]));
    const byEmail = new Map(
      people.filter((p) => p.email).map((p) => [p.email!.toLowerCase(), p]),
    );

    const matched: { name: string; how: string; hibob: string }[] = [];
    const unmatched: { hibob: string; email: string | null }[] = [];
    const seen = new Set<string>();

    for (const person of probe.rows) {
      const label = person.fullName ?? person.email ?? person.hibobId;
      const byId = byHibobId.get(person.hibobId);
      const byMail = person.email ? byEmail.get(person.email.toLowerCase()) : undefined;
      const byName = person.fullName
        ? resolvePersonByName(person.fullName, people).personId
        : null;
      const hit = byId ?? byMail ?? people.find((p) => p.id === byName);

      if (hit) {
        seen.add(hit.id);
        matched.push({
          name: hit.name,
          how: byId ? "id HiBob" : byMail ? "email" : "nome",
          hibob: label,
        });
      } else {
        unmatched.push({ hibob: label, email: person.email });
      }
    }

    return {
      ok: true,
      message: `Ligação estabelecida. ${probe.total} registo(s) devolvidos pelo HiBob.`,
      total: probe.total,
      sampleKeys: probe.sampleKeys,
      sample: probe.sample ? JSON.stringify(probe.sample, null, 2).slice(0, 4000) : undefined,
      matched,
      unmatched,
      missingInHibob: people
        .filter((p) => p.active && !seen.has(p.id))
        .map((p) => p.name)
        .sort(),
    };
  } catch (error) {
    if (error instanceof HibobError) {
      return {
        ok: false,
        message: error.message + (error.body ? `\n\nResposta: ${error.body}` : ""),
      };
    }
    return { ok: false, message: error instanceof Error ? error.message : String(error) };
  }
}

export default async function HibobPage({
  searchParams,
}: {
  searchParams: Promise<{ testar?: string }>;
}) {
  const session = await auth();
  if (session?.user?.role !== "ADMIN") {
    return (
      <div className="rounded-lg border border-gray-200 bg-white p-6 text-sm text-gray-600">
        Esta página é só para administradores — mostra dados de RH e remunerações.
      </div>
    );
  }

  const { testar } = await searchParams;
  const configured = isConfigured();
  const report = testar === "1" && configured ? await runPreview() : null;

  return (
    <div>
      <p className="text-sm text-gray-500">
        <Link href="/" className="hover:underline">
          Dashboard
        </Link>{" "}
        / Integrações / HiBob
      </p>
      <h1 className="mt-1 text-2xl font-semibold text-gray-900">HiBob</h1>
      <p className="mt-1 text-sm text-gray-500">
        Pessoas, remunerações e ausências vindas do sistema de RH, em vez da folha DADOS. Esta
        página <strong>não grava nada</strong> — mostra o que o HiBob devolve e o que casaria com
        as pessoas já registadas.
      </p>

      {!configured ? (
        <div className="mt-6 rounded-lg border border-amber-200 bg-amber-50 p-4 text-sm text-amber-900">
          <p className="font-medium">Falta configurar o acesso.</p>
          <ol className="mt-2 list-decimal space-y-1 pl-5 text-xs">
            <li>
              No HiBob: <strong>Settings → Integrations → Service users</strong>, criar um service
              user com permissão de leitura em <em>Employees</em>, <em>Employment</em>,{" "}
              <em>Salaries</em> e <em>Time off</em>.
            </li>
            <li>
              No Vercel, em Environment Variables, criar <code>HIBOB_API_TOKEN</code> com o token e{" "}
              <code>HIBOB_SERVICE_USER_ID</code> com o id do service user. Marcar as duas como{" "}
              <strong>Sensitive</strong>.
            </li>
            <li>Fazer Redeploy — variáveis novas só entram num deploy novo.</li>
          </ol>
          <p className="mt-2 text-xs">
            O token dá acesso a salários de toda a empresa. Não o passes por email nem por chat.
          </p>
        </div>
      ) : (
        <div className="mt-6">
          <Link
            href="/integracoes/hibob?testar=1"
            className="rounded-md bg-gray-900 px-4 py-2 text-sm font-medium text-white hover:bg-gray-800"
          >
            Testar ligação e pré-visualizar
          </Link>
        </div>
      )}

      {report && (
        <div className="mt-6 space-y-4">
          <div
            className={`rounded-lg border p-4 text-sm ${
              report.ok
                ? "border-green-200 bg-green-50 text-green-900"
                : "border-red-200 bg-red-50 text-red-900"
            }`}
          >
            <p className="font-medium">{report.ok ? "Ligação OK" : "Falhou"}</p>
            <pre className="mt-1 whitespace-pre-wrap text-xs">{report.message}</pre>
          </div>

          {report.ok && (
            <>
              <div className="grid grid-cols-1 gap-4 sm:grid-cols-3">
                <div className="rounded-lg border border-gray-200 bg-white p-4">
                  <p className="text-xs text-gray-500">Casam com pessoas já registadas</p>
                  <p className="mt-1 text-lg font-semibold text-gray-900">
                    {report.matched?.length ?? 0}
                  </p>
                </div>
                <div className="rounded-lg border border-gray-200 bg-white p-4">
                  <p className="text-xs text-gray-500">No HiBob, sem correspondência aqui</p>
                  <p className="mt-1 text-lg font-semibold text-gray-900">
                    {report.unmatched?.length ?? 0}
                  </p>
                </div>
                <div className="rounded-lg border border-gray-200 bg-white p-4">
                  <p className="text-xs text-gray-500">Ativos aqui, ausentes do HiBob</p>
                  <p className="mt-1 text-lg font-semibold text-gray-900">
                    {report.missingInHibob?.length ?? 0}
                  </p>
                </div>
              </div>

              {report.unmatched && report.unmatched.length > 0 && (
                <div className="rounded-lg border border-amber-200 bg-amber-50 p-4 text-sm text-amber-900">
                  <p className="font-medium">Sem correspondência</p>
                  <ul className="mt-2 space-y-0.5 text-xs">
                    {report.unmatched.slice(0, 40).map((row) => (
                      <li key={row.hibob}>
                        {row.hibob}
                        {row.email ? ` · ${row.email}` : " · sem email"}
                      </li>
                    ))}
                  </ul>
                </div>
              )}

              {report.missingInHibob && report.missingInHibob.length > 0 && (
                <div className="rounded-lg border border-gray-200 bg-white p-4 text-sm text-gray-700">
                  <p className="font-medium">Ativos aqui mas não devolvidos pelo HiBob</p>
                  <p className="mt-1 text-xs text-gray-500">
                    Podem ter saído, ou o pedido não trouxe inativos.
                  </p>
                  <p className="mt-2 text-xs">{report.missingInHibob.join(", ")}</p>
                </div>
              )}

              <details className="rounded-lg border border-gray-200 bg-white p-4">
                <summary className="cursor-pointer text-sm font-medium text-gray-700">
                  Campos devolvidos pelo HiBob ({report.sampleKeys?.length ?? 0})
                </summary>
                <p className="mt-2 text-xs text-gray-500">
                  É isto que decide o mapeamento final. Copia e manda-me.
                </p>
                <p className="mt-2 font-mono text-xs text-gray-700">
                  {report.sampleKeys?.join(", ")}
                </p>
                {report.sample && (
                  <pre className="mt-3 max-h-96 overflow-auto rounded bg-gray-50 p-3 text-[11px] text-gray-700">
                    {report.sample}
                  </pre>
                )}
              </details>
            </>
          )}
        </div>
      )}
    </div>
  );
}
