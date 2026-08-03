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
- **Not yet imported**: RHAQ, Texia, TexQualis — their sheets use a
  structurally different layout (FTE-based tables, different rubrica-key
  columns) that needs a dedicated mapping rather than a guessed one. Their
  `Project` row is seeded so they're visible in the app; budget lines and
  execution rows need a follow-up import once that mapping is confirmed.

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
