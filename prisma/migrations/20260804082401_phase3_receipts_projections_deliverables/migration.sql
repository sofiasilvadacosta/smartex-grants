-- CreateEnum
CREATE TYPE "ProjectionStatus" AS ENUM ('FORECAST', 'REALIZED', 'CANCELLED');

-- CreateEnum
CREATE TYPE "DeliverableType" AS ENUM ('DELIVERABLE', 'MILESTONE');

-- CreateEnum
CREATE TYPE "DeliverableStatus" AS ENUM ('PLANNED', 'IN_PROGRESS', 'DONE', 'CANCELLED');

-- CreateTable
CREATE TABLE "Receipt" (
    "id" TEXT NOT NULL,
    "projectId" TEXT NOT NULL,
    "paymentRequestId" TEXT,
    "receivedDate" TIMESTAMP(3) NOT NULL,
    "amount" DECIMAL(14,2) NOT NULL,
    "description" TEXT,
    "bankDescription" TEXT,
    "currency" TEXT NOT NULL DEFAULT 'EUR',
    "notes" TEXT,
    "sourceSheet" TEXT,
    "sourceRowId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "createdById" TEXT,

    CONSTRAINT "Receipt_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ReceiptProjection" (
    "id" TEXT NOT NULL,
    "projectId" TEXT NOT NULL,
    "paymentRequestId" TEXT,
    "projectedDate" TIMESTAMP(3) NOT NULL,
    "projectedAmount" DECIMAL(14,2) NOT NULL,
    "status" "ProjectionStatus" NOT NULL DEFAULT 'FORECAST',
    "notes" TEXT,
    "realizedReceiptId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "createdById" TEXT,

    CONSTRAINT "ReceiptProjection_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Deliverable" (
    "id" TEXT NOT NULL,
    "projectId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "type" "DeliverableType" NOT NULL DEFAULT 'DELIVERABLE',
    "status" "DeliverableStatus" NOT NULL DEFAULT 'PLANNED',
    "activity" TEXT NOT NULL DEFAULT '',
    "dueDate" TIMESTAMP(3),
    "completionDate" TIMESTAMP(3),
    "notes" TEXT,
    "responsiblePersonId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "createdById" TEXT,

    CONSTRAINT "Deliverable_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "Receipt_projectId_receivedDate_idx" ON "Receipt"("projectId", "receivedDate");

-- CreateIndex
CREATE INDEX "Receipt_paymentRequestId_idx" ON "Receipt"("paymentRequestId");

-- CreateIndex
CREATE UNIQUE INDEX "Receipt_projectId_sourceRowId_key" ON "Receipt"("projectId", "sourceRowId");

-- CreateIndex
CREATE UNIQUE INDEX "ReceiptProjection_realizedReceiptId_key" ON "ReceiptProjection"("realizedReceiptId");

-- CreateIndex
CREATE INDEX "ReceiptProjection_projectId_projectedDate_idx" ON "ReceiptProjection"("projectId", "projectedDate");

-- CreateIndex
CREATE INDEX "Deliverable_projectId_dueDate_idx" ON "Deliverable"("projectId", "dueDate");

-- AddForeignKey
ALTER TABLE "Receipt" ADD CONSTRAINT "Receipt_projectId_fkey" FOREIGN KEY ("projectId") REFERENCES "Project"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Receipt" ADD CONSTRAINT "Receipt_paymentRequestId_fkey" FOREIGN KEY ("paymentRequestId") REFERENCES "PaymentRequest"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Receipt" ADD CONSTRAINT "Receipt_createdById_fkey" FOREIGN KEY ("createdById") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ReceiptProjection" ADD CONSTRAINT "ReceiptProjection_projectId_fkey" FOREIGN KEY ("projectId") REFERENCES "Project"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ReceiptProjection" ADD CONSTRAINT "ReceiptProjection_paymentRequestId_fkey" FOREIGN KEY ("paymentRequestId") REFERENCES "PaymentRequest"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ReceiptProjection" ADD CONSTRAINT "ReceiptProjection_realizedReceiptId_fkey" FOREIGN KEY ("realizedReceiptId") REFERENCES "Receipt"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ReceiptProjection" ADD CONSTRAINT "ReceiptProjection_createdById_fkey" FOREIGN KEY ("createdById") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Deliverable" ADD CONSTRAINT "Deliverable_projectId_fkey" FOREIGN KEY ("projectId") REFERENCES "Project"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Deliverable" ADD CONSTRAINT "Deliverable_responsiblePersonId_fkey" FOREIGN KEY ("responsiblePersonId") REFERENCES "Person"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Deliverable" ADD CONSTRAINT "Deliverable_createdById_fkey" FOREIGN KEY ("createdById") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;
