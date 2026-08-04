-- The funder's own project number, which its forms identify a project by.
-- AlterTable
ALTER TABLE "Project" ADD COLUMN "externalNumber" TEXT;

-- Known from the timesheet workbook's own header ("Projeto 20783").
UPDATE "Project" SET "externalNumber" = '20783' WHERE "code" = 'TEXQUALIS';
