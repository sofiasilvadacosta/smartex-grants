-- Alone in its own migration: Postgres refuses to use a new enum value in the
-- same transaction that adds it, and the next migration marks RHAQ EXCLUDED.
-- AlterEnum
ALTER TYPE "ProjectStatus" ADD VALUE 'EXCLUDED';
