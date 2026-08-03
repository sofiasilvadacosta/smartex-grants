import NextAuth from "next-auth";
import Google from "next-auth/providers/google";
import { PrismaAdapter } from "@auth/prisma-adapter";
import { prisma } from "@/lib/db";

const ALLOWED_EMAIL_DOMAIN = "@smartex.ai";

export const { handlers, auth, signIn, signOut } = NextAuth({
  adapter: PrismaAdapter(prisma),
  session: { strategy: "database" },
  providers: [Google],
  pages: {
    signIn: "/login",
  },
  callbacks: {
    // Defense in depth: reject non-Smartex accounts here even if Google
    // Workspace domain restriction is ever misconfigured on the OAuth client.
    async signIn({ user }) {
      if (!user.email?.toLowerCase().endsWith(ALLOWED_EMAIL_DOMAIN)) {
        return false;
      }
      const existing = await prisma.user.findUnique({ where: { email: user.email } });
      if (existing?.disabledAt) return false;
      return true;
    },
    session({ session, user }) {
      session.user.id = user.id;
      session.user.role = user.role;
      return session;
    },
    authorized({ auth: session, request }) {
      const isLoggedIn = !!session?.user;
      const isLoginPage = request.nextUrl.pathname.startsWith("/login");
      if (isLoginPage) return true;
      return isLoggedIn;
    },
  },
  events: {
    // Bootstrap: the very first account ever created becomes Admin so there's
    // always at least one user who can promote others from the users page.
    async createUser({ user }) {
      const count = await prisma.user.count();
      if (count === 1) {
        await prisma.user.update({ where: { id: user.id }, data: { role: "ADMIN" } });
      }
    },
  },
});
