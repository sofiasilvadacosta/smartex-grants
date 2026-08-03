import type { Role } from "@/generated/prisma/client";

declare module "next-auth" {
  interface Session {
    user: {
      id: string;
      role: Role;
    } & import("next-auth").DefaultSession["user"];
  }

  interface User {
    role: Role;
  }
}
