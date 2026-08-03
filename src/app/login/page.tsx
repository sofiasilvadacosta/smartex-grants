import { signIn } from "@/lib/auth";

export default function LoginPage() {
  return (
    <div className="flex min-h-screen items-center justify-center bg-gray-50 px-4">
      <div className="w-full max-w-sm rounded-lg border border-gray-200 bg-white p-8 shadow-sm">
        <h1 className="text-xl font-semibold text-gray-900">Smartex Grants</h1>
        <p className="mt-2 text-sm text-gray-600">
          Gestão de projetos financiados. Entra com a tua conta Smartex.
        </p>
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
        <p className="mt-4 text-xs text-gray-400">
          Apenas contas @smartex.ai têm acesso.
        </p>
      </div>
    </div>
  );
}
