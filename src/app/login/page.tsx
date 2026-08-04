import { signIn } from "@/lib/auth";

// Auth.js needs these before it can start a Google sign-in. Without them it
// throws a generic "Configuration" error and lands on its own error page, which
// says only that something is wrong with the server — no help at all for what is
// the most likely thing to be missing on a fresh deployment. Naming the variable
// here turns that dead end into an instruction.
const REQUIRED_ENV = ["AUTH_SECRET", "AUTH_GOOGLE_ID", "AUTH_GOOGLE_SECRET"] as const;

export default async function LoginPage() {
  const missing = REQUIRED_ENV.filter((name) => !process.env[name]);

  return (
    <div className="flex min-h-screen items-center justify-center bg-gray-50 px-4">
      <div className="w-full max-w-sm rounded-lg border border-gray-200 bg-white p-8 shadow-sm">
        <h1 className="text-xl font-semibold text-gray-900">Smartex Grants</h1>
        <p className="mt-2 text-sm text-gray-600">
          Gestão de projetos financiados. Entra com a tua conta Smartex.
        </p>

        {missing.length > 0 ? (
          <div className="mt-6 rounded-md border border-amber-200 bg-amber-50 p-4 text-sm text-amber-900">
            <p className="font-medium">Falta configurar o login.</p>
            <p className="mt-2">
              {missing.length === 1 ? "A variável " : "As variáveis "}
              {missing.map((name) => (
                <code key={name} className="mr-1 rounded bg-amber-100 px-1 font-mono text-xs">
                  {name}
                </code>
              ))}
              {missing.length === 1 ? "não está definida" : "não estão definidas"} neste
              deployment.
            </p>
            <p className="mt-2">
              Define-{missing.length === 1 ? "a" : "as"} nas Environment Variables do projeto e faz
              um <strong>Redeploy</strong> — variáveis novas só entram num deploy novo. Ver
              DEPLOY.md.
            </p>
          </div>
        ) : (
          <form
            className="mt-6"
            action={async () => {
              "use server";
              await signIn("google", { redirectTo: "/" });
            }}
          >
            <button
              type="submit"
              className="w-full rounded-md bg-gray-900 px-4 py-2 text-sm font-medium text-white hover:bg-gray-800"
            >
              Entrar com Google
            </button>
          </form>
        )}

        <p className="mt-4 text-xs text-gray-400">Apenas contas @smartex.ai têm acesso.</p>
      </div>
    </div>
  );
}
