-- The funder's project numbers, read from the headers of the Mapa de horas/ETI
-- workbooks. They are how a timesheet says which project it belongs to.
UPDATE "Project" SET "externalNumber" = '18435' WHERE "code" = 'TEXIA' AND "externalNumber" IS NULL;
UPDATE "Project" SET "externalNumber" = '12270' WHERE "code" = 'DEFECT_FREE' AND "externalNumber" IS NULL;
