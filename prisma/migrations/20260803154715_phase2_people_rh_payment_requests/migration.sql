-- CreateEnum
CREATE TYPE "DecisionStatus" AS ENUM ('PENDING', 'APROVADO', 'PARCIAL', 'REJEITADO');

-- CreateEnum
CREATE TYPE "AttachmentKind" AS ENUM ('REQUEST_DOC', 'DECISION_DOC');

-- AlterTable
ALTER TABLE "Invoice" ADD COLUMN     "paymentRequestId" TEXT;

-- CreateTable
CREATE TABLE "Person" (
    "id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "initials" TEXT NOT NULL,
    "grossSalary" DECIMAL(12,2),
    "profile" TEXT,
    "entryDate" TIMESTAMP(3),
    "exitDate" TIMESTAMP(3),
    "obs" TEXT,
    "active" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Person_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "WorkCalendar" (
    "yearMonth" TEXT NOT NULL,
    "availableHours" INTEGER NOT NULL,

    CONSTRAINT "WorkCalendar_pkey" PRIMARY KEY ("yearMonth")
);

-- CreateTable
CREATE TABLE "PersonMonthCapacity" (
    "id" TEXT NOT NULL,
    "personId" TEXT NOT NULL,
    "yearMonth" TEXT NOT NULL,
    "productiveHours" DECIMAL(8,2) NOT NULL,

    CONSTRAINT "PersonMonthCapacity_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ProjectHoursAllocation" (
    "id" TEXT NOT NULL,
    "personId" TEXT NOT NULL,
    "projectId" TEXT NOT NULL,
    "yearMonth" TEXT NOT NULL,
    "hours" DECIMAL(8,2) NOT NULL,

    CONSTRAINT "ProjectHoursAllocation_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "PersonnelAllocation" (
    "id" TEXT NOT NULL,
    "projectId" TEXT NOT NULL,
    "budgetLineId" TEXT,
    "personId" TEXT,
    "paymentRequestId" TEXT,
    "rawPersonLabel" TEXT NOT NULL,
    "category" TEXT NOT NULL,
    "yearMonth" TEXT NOT NULL,
    "eligibleBaseSalary" DECIMAL(12,2) NOT NULL,
    "allocationPercent" DECIMAL(6,4) NOT NULL,
    "socialSecurityRate" DECIMAL(6,4) NOT NULL,
    "eligibleValue" DECIMAL(14,2) NOT NULL,
    "ppNumber" TEXT,
    "certifiedEligible" BOOLEAN,
    "obs" TEXT,
    "rawSourceRef" TEXT,
    "matchStatus" "MatchStatus" NOT NULL DEFAULT 'UNMATCHED',
    "matchConfidence" DECIMAL(5,2),
    "matchMethod" "MatchMethod",
    "matchCandidates" JSONB,
    "reconciledById" TEXT,
    "reconciledAt" TIMESTAMP(3),
    "sourceSheet" TEXT NOT NULL,
    "sourceRowId" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "PersonnelAllocation_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "PaymentRequest" (
    "id" TEXT NOT NULL,
    "projectId" TEXT NOT NULL,
    "ppNumber" TEXT NOT NULL,
    "submissionDate" TIMESTAMP(3),
    "requestedAmount" DECIMAL(14,2),
    "notes" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "createdById" TEXT,

    CONSTRAINT "PaymentRequest_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "PaymentDecision" (
    "id" TEXT NOT NULL,
    "paymentRequestId" TEXT NOT NULL,
    "decisionDate" TIMESTAMP(3),
    "status" "DecisionStatus" NOT NULL DEFAULT 'PENDING',
    "approvedAmount" DECIMAL(14,2),
    "notes" TEXT,
    "isCurrent" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "createdById" TEXT,

    CONSTRAINT "PaymentDecision_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Attachment" (
    "id" TEXT NOT NULL,
    "paymentRequestId" TEXT NOT NULL,
    "kind" "AttachmentKind" NOT NULL,
    "filename" TEXT NOT NULL,
    "mimeType" TEXT NOT NULL,
    "sizeBytes" INTEGER NOT NULL,
    "content" BYTEA NOT NULL,
    "uploadedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "uploadedById" TEXT,

    CONSTRAINT "Attachment_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "Person_initials_key" ON "Person"("initials");

-- CreateIndex
CREATE UNIQUE INDEX "PersonMonthCapacity_personId_yearMonth_key" ON "PersonMonthCapacity"("personId", "yearMonth");

-- CreateIndex
CREATE INDEX "ProjectHoursAllocation_projectId_yearMonth_idx" ON "ProjectHoursAllocation"("projectId", "yearMonth");

-- CreateIndex
CREATE UNIQUE INDEX "ProjectHoursAllocation_personId_projectId_yearMonth_key" ON "ProjectHoursAllocation"("personId", "projectId", "yearMonth");

-- CreateIndex
CREATE INDEX "PersonnelAllocation_projectId_matchStatus_idx" ON "PersonnelAllocation"("projectId", "matchStatus");

-- CreateIndex
CREATE INDEX "PersonnelAllocation_budgetLineId_idx" ON "PersonnelAllocation"("budgetLineId");

-- CreateIndex
CREATE INDEX "PersonnelAllocation_paymentRequestId_idx" ON "PersonnelAllocation"("paymentRequestId");

-- CreateIndex
CREATE UNIQUE INDEX "PersonnelAllocation_projectId_sourceRowId_key" ON "PersonnelAllocation"("projectId", "sourceRowId");

-- CreateIndex
CREATE UNIQUE INDEX "PaymentRequest_projectId_ppNumber_key" ON "PaymentRequest"("projectId", "ppNumber");

-- CreateIndex
CREATE INDEX "PaymentDecision_paymentRequestId_idx" ON "PaymentDecision"("paymentRequestId");

-- CreateIndex
CREATE INDEX "Attachment_paymentRequestId_idx" ON "Attachment"("paymentRequestId");

-- CreateIndex
CREATE INDEX "Invoice_paymentRequestId_idx" ON "Invoice"("paymentRequestId");

-- AddForeignKey
ALTER TABLE "Invoice" ADD CONSTRAINT "Invoice_paymentRequestId_fkey" FOREIGN KEY ("paymentRequestId") REFERENCES "PaymentRequest"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PersonMonthCapacity" ADD CONSTRAINT "PersonMonthCapacity_personId_fkey" FOREIGN KEY ("personId") REFERENCES "Person"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ProjectHoursAllocation" ADD CONSTRAINT "ProjectHoursAllocation_personId_fkey" FOREIGN KEY ("personId") REFERENCES "Person"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ProjectHoursAllocation" ADD CONSTRAINT "ProjectHoursAllocation_projectId_fkey" FOREIGN KEY ("projectId") REFERENCES "Project"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PersonnelAllocation" ADD CONSTRAINT "PersonnelAllocation_projectId_fkey" FOREIGN KEY ("projectId") REFERENCES "Project"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PersonnelAllocation" ADD CONSTRAINT "PersonnelAllocation_budgetLineId_fkey" FOREIGN KEY ("budgetLineId") REFERENCES "BudgetLine"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PersonnelAllocation" ADD CONSTRAINT "PersonnelAllocation_personId_fkey" FOREIGN KEY ("personId") REFERENCES "Person"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PersonnelAllocation" ADD CONSTRAINT "PersonnelAllocation_paymentRequestId_fkey" FOREIGN KEY ("paymentRequestId") REFERENCES "PaymentRequest"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PersonnelAllocation" ADD CONSTRAINT "PersonnelAllocation_reconciledById_fkey" FOREIGN KEY ("reconciledById") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PaymentRequest" ADD CONSTRAINT "PaymentRequest_projectId_fkey" FOREIGN KEY ("projectId") REFERENCES "Project"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PaymentRequest" ADD CONSTRAINT "PaymentRequest_createdById_fkey" FOREIGN KEY ("createdById") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PaymentDecision" ADD CONSTRAINT "PaymentDecision_paymentRequestId_fkey" FOREIGN KEY ("paymentRequestId") REFERENCES "PaymentRequest"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PaymentDecision" ADD CONSTRAINT "PaymentDecision_createdById_fkey" FOREIGN KEY ("createdById") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Attachment" ADD CONSTRAINT "Attachment_paymentRequestId_fkey" FOREIGN KEY ("paymentRequestId") REFERENCES "PaymentRequest"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Attachment" ADD CONSTRAINT "Attachment_uploadedById_fkey" FOREIGN KEY ("uploadedById") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;
