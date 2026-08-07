-- Stable keys for matching a person to the HR system. Names are written half a
-- dozen ways across the source files; an email and the HR system's own id are not.
-- AlterTable
ALTER TABLE "Person" ADD COLUMN "email" TEXT;
ALTER TABLE "Person" ADD COLUMN "hibobId" TEXT;

-- CreateIndex
CREATE UNIQUE INDEX "Person_email_key" ON "Person"("email");
CREATE UNIQUE INDEX "Person_hibobId_key" ON "Person"("hibobId");
