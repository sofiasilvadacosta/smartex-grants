import { auth } from "@/lib/auth";

// Server Actions and Route Handlers must verify auth themselves — proxy.ts
// gates page navigation, but a matcher change or refactor could silently
// remove that coverage for a given route, and this is cheap insurance.
export async function requireUser() {
  const session = await auth();
  if (!session?.user) throw new Error("Não autenticado");
  return session.user;
}
