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

### Reading the `_Approved` sheets

Two things about these sheets are worth knowing, because both cost real money
when they were wrong:

- The header row has to be *found*, and it is found by counting **label** cells
  (non-empty, not a number or date), not filled cells. TexP@ct's first data row
  carries more computed columns than the header has labels, so counting filled
  cells made that row win — it was treated as the header and skipped, losing the
  RH 3-4 rubrica and 374 187,06 € of approved budget along with it. The rubrica's
  226 RH rows then had nowhere to go and sat unreconciled.
- The sheet's own per-rubrica "Executado" column is loaded into
  `BudgetLine.declaredExecuted`. Produtech repeats that header and only the
  rightmost column holds values, so the last occurrence is used; the import sums
  what it read and compares it against the sheet's TOTAL row, warning loudly on
  a mismatch. Both currently agree to the cent (Produtech 1 172 464,22 €,
  TexP@ct 1 057 213,88 €).

### TexP@ct payment requests

`imports/TexPact_Pedidos_Pagamento.xlsx` (`texpact-pedidos.ts`) carries what the
working spreadsheet does not: a "Resumo" sheet with submitted / cuts / approved
/ paid per request, and one sheet per request listing the invoices it declared.
It produces the 6 real requests with their decisions, and sets the Nº PP on 101
invoices — the working sheet had it on 12 of 131.

An invoice cut from one request and re-submitted in a later one appears in both
sheets, so the highest request number wins rather than whichever sheet is read
last. Personnel is declared per request as one aggregate row per TRL phase and
cannot be split back into the monthly allocations held here, so it is recorded
in the request's notes instead of linked.

## Approved budget from a payment-request PDF

Defect Free, Internacionalização, Texia and TexQualis have no `_Approved`
sheet — their approved budget only exists in the funder's payment-request form
("Quadro de Investimentos", SGO 2030). Convert that PDF to CSV once, then the
normal import reads it:

```bash
pip install pdfplumber
python3 scripts/import/extract-pp-quadro.py \
  Pedido_de_Pagamento_Defect_Free.pdf \
  imports/DefectFree_Quadro_Investimentos.csv
```

The portal prints the table as a web page, so the extractor recovers rows by
grouping words into visual lines and placing each word in a column using the
header's own x positions. It cannot hard-code those positions: the projects
differ (Texia has no AJUSTADO column, Defect Free has two REALIZADA columns and
a two-line header, and the x positions move between forms). Nor can one
geometric rule place every column — money and percentages are right-aligned,
designation and classification left-aligned, the small numeric columns centred —
so right-aligned columns are matched on their right edge and "ATIV."/"ESTAB."
only accept a word that is actually a number.

Row sums are checked against the document's own total row and the script writes
nothing if they disagree. One caveat it reports rather than hides: the portal's
print clips the last digit of the rightmost column on some forms (all three of
the newer ones), and a value clipped that way is written **empty** instead of as
a wrong number — so `declaredExecuted` is simply absent for those projects
rather than silently 10× too small.

`pp-quadro.ts` then creates one budget line per Nº ordem and links invoices to
their budget line **exactly by Nº ordem** (no text matching), since the PP
sheets carry the same number. The line is looked up by Nº ordem alone: it
identifies the line on its own, and keying on activity and classification too
made a corrected re-read create a second line for the same approved budget.
Budget lines whose Nº ordem is no longer in the CSV are reported rather than
deleted — they may already carry execution or have been added by hand.

Texia and TexQualis deliberately do **not** use this path for their budget. The
funder approves them as one line per activity, while the planning spreadsheet
breaks the same total down by activity × profile, which is what the team plans
against; importing both would double the budget. Their quadro PDFs are still
worth keeping for the approved totals (890 432,40 € and 698 040,00 €, both
matching what the spreadsheet gives).

### Movements and personnel from the portal's own exports

Two portal exports supersede the working spreadsheet for Defect Free, because
both carry data the spreadsheet doesn't:

- `imports/FPP012270004_Movimentos.xlsx` — the portal's "Lista geral de
  movimentos". Every row carries the Nº ordem, so all 45 invoices link exactly,
  and it includes travel rows the working sheet keeps in a separate table.
  `pp-movimentos.ts` deletes the superseded working-sheet rows after importing,
  otherwise execution would be counted twice.
- `imports/DefectFree_Pessoal.csv`, produced from the payment request's
  "Pessoal" table:

  ```bash
  python3 scripts/import/extract-pp-pessoas.py \
    Pedido_de_Pagamento_defect_free_pessoas.pdf \
    imports/DefectFree_Pessoal.csv
  ```

  Same total-verification guard as the Quadro extractor.

- `imports/DefectFree_Pessoal_Atividades.txt` — the one field that table omits:
  the activity each movement was imputed to. It is transcribed by hand from the
  portal's per-technician "Movimentos de despesa" screens, tab-separated as
  `Mov / Ano-mês / Atividade / ETI / Valor`, with the technician headers kept so
  it can be checked against the screen it came from. The import joins it on the
  movement id and **refuses to run** if any movement disagrees with the export
  on month or amount, which is what makes a hand transcription safe to rely on.

  With it, an activity approved as a single budget line is linked outright and
  one the funder split into annual lines is left AMBIGUOUS with those lines as
  candidates (score capped at 80: the rubrica family is certain, the annual line
  is not). For Defect Free that is 106 rows / 109 730,51 € linked and 126 rows /
  217 862,20 € awaiting a choice. Without the file every row stays UNMATCHED —
  inferring the activity from the free-text description was tested against the
  approved table's per-activity totals and did not reconcile, so it is not done.

- `imports/DefectFree_Deslocacoes.csv` — travel declared without a supplier
  invoice (per-diem style), transcribed from the portal's "Deslocações" screen.
  These rows are absent from the Movimentos export, so without them the travel
  rubricas sit below what was declared. `pp-deslocacoes.ts` imports them as
  invoices with no supplier, links them by Nº ordem, and then **verifies that
  every travel rubrica now equals its declared amount**, failing the run if it
  does not — the whole point of transcribing them by hand is to close that gap
  exactly.

### Funder decisions

`pp-decisoes.ts` records a decision on a payment request together with the
analysis document itself (`imports/DefectFree_Decisao_PP3.pdf`, stored as an
attachment). The figures are typed into `scripts/import/index.ts` rather than
parsed: these are prose documents with no fixed layout, a few per year, and a
number read from a mis-parsed sentence would be worse than one nobody typed.

### Texia and TexQualis execution

Neither project has invoices; their whole execution so far is the personnel
declared in the portal's form, extracted with the same `extract-pp-pessoas.py`
as Defect Free (Texia 262 021,15 € in request 3, TexQualis 128 208,90 € in
request 2, both matching the documents' own totals).

Those rows import unreconciled: the form gives no activity, and unlike Defect
Free there is no per-technician activity export for them yet. TexQualis gets
part of the way anyway — it budgets personnel per named person ("Rui Ferreira,
Engenheiro Mecânico") rather than per abstract profile, so the person on the row
narrows 44 rubricas to the handful budgeted for them; that covers 21 of its 79
rows. The other 58 are people with no personnel line in this project at all,
which is worth looking at on its own: several budgeted entries are still
"A contratar".

### Payment requests are derived, never assumed

`lib/sync-payment-requests.ts` runs last and builds the `PaymentRequest` rows
from the "Nº PP" the execution rows themselves carry, setting each request's
submitted amount to the sum of its rows and deleting any request left with no
rows, no decision and no attachment. Defect Free's requests are 3 and 4 — an
earlier version of this import assumed "2" from the working spreadsheet, and the
portal export disproved it. The same correction applies to Texia: the planning
sheet's "1 PP Elegível" column named no request, and the portal's form shows
that money was declared in request 3.

### Verifying against the portal

The Quadro CSV's declared-executed column is loaded per line, so the project
page shows, per rubrica, what the funder was told next to what this platform
holds, and lists every divergence above a cent.

Everything reconciles to the cent except one thing: approved 789 615,87 €,
declared executed 497 707,88 €, personnel 327 592,71 €, movements 163 891,17 €,
travel 6 224,00 €, and PP 3's declared total × 1,07 (indirect costs) gives the
330 754,66 € the funder's analysis states.

The exception is worth knowing about. The Quadro's per-line personnel split and
the activity each movement actually carries **do not agree**, though their totals
match exactly (327 592,71 €). Per activity the two differ by up to 18 000 €, and
this is visible for activities 1 and 4 even though those have a single approved
line each, so it is not an artefact of the annual-tranche ambiguity. Both figures
come from the same portal for the same request. The platform holds the row-level
version (each movement on its own activity), which is the one that can be traced
to a person and a month; the Quadro's split cannot be reproduced from any data we
have. Worth resolving with the funder before the next submission.

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
