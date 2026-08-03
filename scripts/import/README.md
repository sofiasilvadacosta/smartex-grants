# Historical data import

One-time import of the legacy Excel workbooks into the app's database. Source
files are **never committed** (they contain salaries, supplier tax IDs and
invoice data) — `imports/` is gitignored.

## Usage

1. Place the source workbooks in `imports/` at the repo root:
   - `Grants_Approved_Execution_v3.xlsx` (legacy `.xls` converted to `.xlsx` —
     see note below)
   - `Smartex_Gestao_Projetos_V4.xlsx`
2. Set `DATABASE_URL` (`.env`) to the target database.
3. Run `npm run db:import`.

The import is idempotent in the ways that matter: re-running it upserts rows
keyed on a stable `sourceRowId` (never duplicating) and never overwrites a
budget-line link a human has already reconciled (`reconciledAt` set).

One caveat worth knowing: for rows *not* yet reconciled by a human, the
auto-match is re-evaluated on every run, and its score depends on each budget
line's **remaining margin** — which grows as more execution rows load. So a
second run can move some rows between `MATCHED` and `AMBIGUOUS` compared to the
first. That is intended (the suggestion always reflects the best current
information), but it means match results are not byte-identical run to run.
Human decisions are the only thing frozen.

## Converting the legacy `.xls`

`exceljs` (used here to avoid the unmaintained/vulnerable `xlsx` npm package —
see commit history) only reads `.xlsx`. Convert the original `.xls` once with
Python (`xlrd` + `openpyxl`):

```python
import xlrd, openpyxl

rb = xlrd.open_workbook("Grants_Approved_Execution_v3.xls")
wb = openpyxl.Workbook()
wb.remove(wb.active)
for sn in rb.sheet_names():
    ws_r = rb.sheet_by_name(sn)
    ws_w = wb.create_sheet(title=sn[:31])
    for r in range(ws_r.nrows):
        for c in range(ws_r.ncols):
            val = ws_r.cell_value(r, c)
            if ws_r.cell_type(r, c) == xlrd.XL_CELL_DATE:
                val = xlrd.xldate_as_datetime(val, rb.datemode)
            ws_w.cell(row=r + 1, column=c + 1, value=val or None)
wb.save("Grants_Approved_Execution_v3.xlsx")
```

## Current scope

Imported from `Grants_Approved_Execution_v3.xlsx`:

- **Projects**: all 7 (from `DADOS` + the two projects not listed there but
  present in the grants workbook: RHAQ, Internacionalização).
- **Budget lines + invoices + RH cost imputation, fully automated**: Produtech,
  TexP@ct (clean `_Approved` / `_Investments` / `_RH` sheet trios). The RH
  totals reconcile to the cent against the source `_Approved` sheet's
  "Executado" column, which is the main correctness check for this import.
- **Invoices only** (no `_Approved`-equivalent sheet identified with
  confidence): Internacionalização, Defect Free — enter their budget lines
  manually via the UI for now.
- **Texia and TexQualis** (`fte-projects.ts`): budgeted per Atividade × Perfil
  with a fixed eligible cost per FTE (5189 € and 4432 €) instead of real
  salaries, so `Project.fteRate` is set and execution is entered in the app as
  FTE × that rate. Two source quirks handled and reported:
  - The per-year investment columns are the source of truth, not the sheet's
    own "Investimento Total" column — in TexQualis that column under-sums by
    250 851,20 € across 42 rows, while the sheet's Total *row* agrees with the
    per-year sums.
  - Three TexQualis rows have yearly FTE filled in but their Total column at
    zero; they are imported at the yearly value and listed in the run output,
    since they may be cancelled work.

  Texia's "1 PP Elegível" is recorded per activity (not per profile), so the
  import creates payment request nº 1 with the submitted total (262 021,15 €)
  and leaves the per-line split to be entered in the app. TexQualis has no
  execution in the sheet yet.
- **Out of scope**: RHAQ (excluded by decision).

## Approved budget from a payment-request PDF (Defect Free)

Defect Free has no `_Approved` sheet — its approved budget only exists in the
funder's payment-request form ("Quadro de Investimentos", SGO 2030 / Norte
2030). Convert that PDF to CSV once, then the normal import reads it:

```bash
pip install pdfplumber
python3 scripts/import/extract-pp-pdf.py \
  Pedido_de_Pagamento_Defect_Free.pdf \
  imports/DefectFree_Quadro_Investimentos.csv
```

The extractor cross-checks its row sums against the document's own Total row
and refuses to write the CSV if they disagree, so a mis-parse can't quietly
become budget data. It produces one row per **Nº ordem** — the unit the funder
approves and reports against — with the activity, official cost classification
(a/c/e/f/h/i), year, approved amount and the amounts declared as executed.

`pp-quadro.ts` then creates one budget line per Nº ordem, registers the payment
request with the declared totals, and links invoices to their budget line
**exactly by Nº ordem** (no text matching), since the PP sheets carry the same
number. Budget lines whose Nº ordem is no longer in the CSV are reported rather
than deleted — they may already carry execution or have been added by hand.

Note: the PDF does not state its own request number; the importer is configured
with `"2"` because that is what the project's invoices carry in "Nº PP".

Imported from `Smartex_Gestao_Projetos_V4.xlsx`:

- **People** (`DADOS`): 80 people with salary, profile and entry/exit dates.
  `active` is derived from the free-text "Obs." column saying the person left,
  since the source has no explicit flag.
- **Work calendar** (`HorasProdutivas`): company-wide available hours per month.
- **Per-person capacity and per-project hours** (`Recursos`): productive hours
  per person/month, and hours allocated per person/project/month.

A handful of RH rows reference people who are not in the `DADOS` list (former
employees); those rows import with `personId` unresolved and are listed on the
people page so they can be linked or ignored deliberately.
