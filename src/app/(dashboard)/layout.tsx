import Link from "next/link";
import { auth, signOut } from "@/lib/auth";

export default async function DashboardLayout({
  children,
}: Readonly<{ children: React.ReactNode }>) {
  const session = await auth();

  return (
    <div className="flex min-h-screen flex-col">
      <header className="border-b border-gray-200 bg-white">
        <div className="mx-auto flex max-w-6xl items-center justify-between px-6 py-3">
          <nav className="flex items-center gap-6 text-sm font-medium text-gray-700">
            <Link href="/" className="font-semibold text-gray-900">
              Smartex Grants
            </Link>
            <Link href="/projetos" className="hover:text-gray-900">
              Projetos
            </Link>
            <Link href="/pessoas" className="hover:text-gray-900">
              Pessoas
            </Link>
            {session?.user?.role === "ADMIN" && (
              <Link href="/integracoes/hibob" className="hover:text-gray-900">
                Integrações
              </Link>
            )}
          </nav>
          <div className="flex items-center gap-4 text-sm text-gray-500">
            <span>{session?.user?.email}</span>
            <form
              action={async () => {
                "use server";
                await signOut({ redirectTo: "/login" });
              }}
            >
              <button type="submit" className="hover:text-gray-900">
                Sair
              </button>
            </form>
          </div>
        </div>
      </header>
      <main className="mx-auto w-full max-w-6xl flex-1 px-6 py-8">{children}</main>
    </div>
  );
}
