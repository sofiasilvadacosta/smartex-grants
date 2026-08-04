-- Known from the timesheet workbook's PROGRAMA column, which the funder's form
-- requires. The other projects are left null rather than guessed: the form is
-- filled from this field, and a wrong programme on a submitted form is worse
-- than a blank one someone has to fill in.
UPDATE "Project" SET "fundingProgram" = 'COMPETE2030' WHERE "code" = 'TEXQUALIS' AND "fundingProgram" IS NULL;
