import { PrismaClient } from "@/generated/prisma/client";
import { PrismaPg } from "@prisma/adapter-pg";

declare global {
  var prismaGlobal: PrismaClient | undefined;
}

function createPrismaClient() {
  const connectionString = process.env.DATABASE_URL;
  // Without this the first query fails deep inside the driver with a message
  // that says nothing about the missing variable — the single most likely
  // mistake when setting the app up somewhere new.
  if (!connectionString) {
    throw new Error(
      "DATABASE_URL não está definida. Em local, copiar .env.example para .env; " +
        "no Vercel, defini-la nas Environment Variables do projeto.",
    );
  }

  const adapter = new PrismaPg({
    connectionString,
    // A serverless instance serves one request at a time, so a large pool per
    // instance buys nothing and multiplies across instances until Postgres
    // refuses connections. Keep it small here and let the database's own
    // connection pooler absorb concurrency (see DEPLOY.md).
    max: process.env.VERCEL ? 2 : 10,
  });
  return new PrismaClient({ adapter });
}

let client: PrismaClient | undefined;

function getClient(): PrismaClient {
  if (client) return client;
  // One client per process in production; in development the module is
  // re-evaluated on every hot reload, so it is cached on globalThis to avoid
  // opening a new pool each time.
  client = globalThis.prismaGlobal ?? createPrismaClient();
  if (process.env.NODE_ENV !== "production") globalThis.prismaGlobal = client;
  return client;
}

// Built on first use rather than at import time. `next build` imports every
// route module to collect page data, and a client built there would make the
// build require database credentials it never actually queries with.
export const prisma = new Proxy({} as PrismaClient, {
  get(_target, property) {
    const instance = getClient() as unknown as Record<string | symbol, unknown>;
    const value = instance[property];
    return typeof value === "function" ? value.bind(instance) : value;
  },
});
