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

The import is idempotent: re-running it upserts rows keyed on a stable
`sourceRowId` and never overwrites a budget-line link a human has already
reconciled (`Invoice.reconciledAt` set).

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

## Current scope (Fase 1)

- **Projects**: all 7 (from `DADOS` + the two projects not listed there but
  present in the grants workbook: RHAQ, Internacionalização).
- **Budget lines + invoices, fully automated**: Produtech, TexP@ct (clean
  `_Approved` + `_Investments` sheet pairs).
- **Invoices only** (no `_Approved`-equivalent sheet identified with
  confidence): Internacionalização, Defect Free — enter their budget lines
  manually via the UI for now.
- **Not yet imported**: RHAQ, Texia, TexQualis — their sheets use a
  structurally different layout (FTE-based tables, different rubrica-key
  columns) that needs a dedicated mapping rather than a guessed one. Their
  `Project` row is seeded so they're visible in the app; budget lines and
  invoices need a follow-up import script once that mapping is confirmed.
