#!/usr/bin/env python3
"""Extract the "Quadro de Investimentos" from a SGO 2030 payment-request PDF
into the CSV the TypeScript importer reads.

The portal renders the table as a printed web page, so there is no machine
-readable structure. Rows are recovered by grouping words into visual lines and
assigning each word to a column by its x position, taken from the header row —
the columns themselves differ between projects (Texia has no AJUSTADO, Defect
Free has two REALIZADA columns, the x positions move) so their positions cannot
be hard-coded.

Row sums are checked against the document's own total row and the script fails
rather than write a mis-parsed CSV. One caveat it reports instead of hiding: the
portal's print sometimes clips the last digit of the rightmost column, and a
value clipped that way is written as empty rather than as a wrong number.

Usage:
    python3 scripts/import/extract-pp-quadro.py <pedido_de_pagamento.pdf> <out.csv>

Requires: pip install pdfplumber
"""

import csv
import re
import sys

import pdfplumber

MONEY = re.compile(r"^-?\d{1,3}(?:\.\d{3})*,\d{2}$")
# The same token with a single decimal is the portal's print clipping the last
# digit at the page edge — a real value we must not read as if it were whole.
CLIPPED_MONEY = re.compile(r"^-?\d{1,3}(?:\.\d{3})*,\d$")
ORDER = re.compile(r"^\d{1,4}$")
DATE = re.compile(r"^\d{4}-\d{2}(?:-\d{2})?$")

# Canonical spellings for the funder's cost classifications. The PDF wraps them
# across lines and sometimes appends a suffix ("- CS"), so joining the raw text
# alone would produce several spellings of one rubrica and split its budget.
# A classification not listed here is kept as written.
CLASSIFICATIONS = [
    ("Pessoal técnico do beneficiário (a)", ("Pessoal técnico",)),
    ("Matérias-primas e componentes (c)", ("Matérias-primas",)),
    ("Aquisição de serviços a terceiros (e)", ("serviços a terceiros",)),
    ("Aquisição de instrumentos e equipamento científico (f)", ("científico (f)",)),
    ("Despesas com promoção e divulgação (h)", ("promoção e divulgação",)),
    ("Viagens e estadas no estrangeiro (i)", ("Viagens e estadas",)),
]

# Words that name a column. Everything else on the header rows ("DAS",
# "DESPESAS", the "DESPESA" group label) spans several columns and would be
# mistaken for one of them.
HEADER_WORDS = ("Nº", "DESIGNAÇÃO", "ATIV.", "ESTAB.", "DATA", "CLASSIFICAÇÃO", "%")
# Money columns in the order the portal prints them. "REALIZADA" appears twice
# in some projects: the expense, then its indirect-cost share.
MONEY_HEADERS = ("APROVADO", "AJUSTADO", "REALIZADA")


def money(token: str) -> float:
    return float(token.replace(".", "").replace(",", "."))


def canonical(text: str) -> str:
    for label, needles in CLASSIFICATIONS:
        if all(n in text for n in needles):
            return label
    return " ".join(text.split())


def header_columns(page):
    """Column geometry for the table, or None if this page has no header.

    The header can span two printed rows — Defect Free puts "CLASSIFICAÇÃO" and
    "%" a line above "Nº" — so rows just above the anchor row are folded in.
    """
    rows = {}
    for word in page.extract_words():
        rows.setdefault(round(word["top"]), []).append(word)

    anchor = next(
        (
            top
            for top in sorted(rows)
            if {"Nº", "DESIGNAÇÃO", "APROVADO"} <= {w["text"] for w in rows[top]}
        ),
        None,
    )
    if anchor is None:
        return None

    words = [w for top in rows for w in rows[top] if anchor - 14 <= top <= anchor]
    columns = {}
    seen_money = 0
    money_order = []
    for word in sorted(words, key=lambda w: w["x0"]):
        if word["text"] in MONEY_HEADERS:
            seen_money += 1
            name = f"{word['text']}#{seen_money}"
            money_order.append(name)
        elif word["text"] in HEADER_WORDS:
            name = word["text"]
        else:
            continue
        columns[name] = {"x0": word["x0"], "x1": word["x1"], "cx": (word["x0"] + word["x1"]) / 2}
    if "%" in columns:
        # The percentage column is not money but is right-aligned like one, so
        # it has to take part in the right-edge matching or its value lands in
        # the neighbouring money column.
        money_order.insert(next((i for i, m in enumerate(money_order) if columns[m]["x1"] > columns["%"]["x1"]), len(money_order)), "%")
    right_edge = max(c["x1"] for c in columns.values())
    return {"columns": columns, "money": money_order, "anchor": anchor, "right": right_edge}


def column_of(word, geom) -> str:
    """Which column a word belongs to.

    Columns are aligned differently — money and the percentage to the right,
    designation and classification to the left, the small numeric columns
    centred — so one geometric rule cannot place them all. Matching the
    right-aligned columns by their right edge and the numeric ones only when the
    word *is* a number keeps long designation text from drifting into "ATIV.".
    """
    columns = geom["columns"]
    text = word["text"]
    centre = (word["x0"] + word["x1"]) / 2

    # Right-aligned columns share their header's right edge almost exactly, so
    # match on that with a tight tolerance. A looser test swallows the tail of a
    # wrapped classification ("Pessoal técnico do") into the APROVADO column,
    # which then reads as a totals row and the wrapped prefix is lost.
    right_aligned = [c for c in geom["money"] if c in columns]
    near = [c for c in right_aligned if abs(word["x1"] - columns[c]["x1"]) <= 6]
    if near:
        return min(near, key=lambda c: abs(word["x1"] - columns[c]["x1"]))

    if "CLASSIFICAÇÃO" in columns and word["x0"] >= columns["CLASSIFICAÇÃO"]["x0"] - 6:
        return "CLASSIFICAÇÃO"

    if DATE.fullmatch(text) and "DATA" in columns:
        return "DATA"

    # "ATIV." and "ESTAB." hold a small integer and nothing else. A designation
    # ending in a number ("...na Turquia 1") must not be mistaken for one, hence
    # the distance cap.
    if re.fullmatch(r"\d{1,3}", text):
        numeric = [c for c in ("Nº", "ATIV.", "ESTAB.") if c in columns]
        if numeric:
            best = min(numeric, key=lambda c: abs(centre - columns[c]["cx"]))
            if abs(centre - columns[best]["cx"]) <= 15:
                return best

    return "DESIGNAÇÃO"


def visual_rows(page, geom, header_top):
    rows = {}
    for word in page.extract_words():
        if word["top"] <= header_top + 4:
            continue
        # Defect Free prints a further, unlabelled column past the last header;
        # folding it into the nearest column would corrupt that column's value.
        if word["x0"] > geom["right"] + 8:
            continue
        rows.setdefault(round(word["top"] / 3), []).append(word)
    for key in sorted(rows):
        cells = {}
        for word in sorted(rows[key], key=lambda w: w["x0"]):
            col = column_of(word, geom)
            cells[col] = f"{cells.get(col, '')} {word['text']}".strip()
        yield cells


def parse(path: str):
    out = []
    stated = None
    clipped = []

    with pdfplumber.open(path) as pdf:
        geom = header_columns(pdf.pages[0])
        if geom is None:
            raise ValueError("linha de cabeçalho do Quadro de Investimentos não encontrada")
        money_cols = [c for c in geom["money"] if "#" in c]
        pending_designation = ""
        pending_classification = ""

        for page in pdf.pages:
            # Continuation pages repeat the table without repeating its header,
            # so their first rows sit above where page 1's header was and would
            # be skipped if page 1's position were reused.
            found = header_columns(page)
            header_top = found["anchor"] if found else -1
            for cells in visual_rows(page, geom, header_top):
                if not cells:
                    continue
                number = cells.get("Nº", "")
                values = {c: cells.get(c, "") for c in money_cols}

                # The document's own total row: every money column filled with a
                # well-formed amount, no order number and no descriptive text.
                if (
                    not number
                    and not cells.get("DESIGNAÇÃO")
                    and not cells.get("CLASSIFICAÇÃO")
                    and all(MONEY.fullmatch(values[c] or "") for c in money_cols)
                ):
                    if stated is None:
                        stated = values
                    continue

                if ORDER.fullmatch(number) and values.get(money_cols[0], ""):
                    designation = f"{pending_designation} {cells.get('DESIGNAÇÃO', '')}".strip()
                    classification = f"{pending_classification} {cells.get('CLASSIFICAÇÃO', '')}".strip()
                    pending_designation = pending_classification = ""

                    parsed = {}
                    for col in money_cols:
                        token = values[col]
                        if MONEY.fullmatch(token):
                            parsed[col] = money(token)
                        elif CLIPPED_MONEY.fullmatch(token):
                            parsed[col] = None
                            clipped.append(f"nº {number} / {col.split('#')[0]}: «{token}»")
                        else:
                            parsed[col] = 0.0 if not token else None

                    date = cells.get("DATA", "")
                    out.append(
                        {
                            "orderNumber": number,
                            "activity": cells.get("ATIV.", ""),
                            "designation": " ".join(designation.split()),
                            "classification": canonical(classification),
                            "endDate": date if DATE.fullmatch(date) else "",
                            "values": parsed,
                        }
                    )
                    continue

                # A line with text but no number is the previous cell wrapping;
                # the portal wraps it *above* the numbered row it belongs to.
                if not number and not any(values.values()):
                    if cells.get("DESIGNAÇÃO"):
                        pending_designation = f"{pending_designation} {cells['DESIGNAÇÃO']}".strip()
                    if cells.get("CLASSIFICAÇÃO"):
                        pending_classification = (
                            f"{pending_classification} {cells['CLASSIFICAÇÃO']}".strip()
                        )

    return out, stated, money_cols, clipped


def main() -> int:
    if len(sys.argv) != 3:
        print(__doc__)
        return 2
    pdf_path, csv_path = sys.argv[1], sys.argv[2]

    rows, stated, money_cols, clipped = parse(pdf_path)
    if not rows:
        print("ERRO: nenhuma linha de investimento encontrada no PDF", file=sys.stderr)
        return 1

    # "APROVADO#1" is always present; the rest vary by project.
    approved_col = money_cols[0]
    adjusted_col = next((c for c in money_cols if c.startswith("AJUSTADO")), None)
    realized_cols = [c for c in money_cols if c.startswith("REALIZADA")]
    executed_col = realized_cols[0] if realized_cols else None
    indirect_col = realized_cols[1] if len(realized_cols) > 1 else None

    def value(row, col):
        if col is None:
            return ""
        got = row["values"].get(col)
        return "" if got is None else f"{got:.2f}"

    if stated:
        for col in money_cols:
            token = stated.get(col, "")
            if not MONEY.fullmatch(token):
                continue
            got = sum(r["values"][col] for r in rows if r["values"][col] is not None)
            missing = any(r["values"][col] is None for r in rows)
            if missing:
                print(
                    f"AVISO: {col.split('#')[0]} não verificável — o PDF corta o último dígito "
                    f"em {sum(1 for r in rows if r['values'][col] is None)} linha(s).",
                    file=sys.stderr,
                )
                continue
            if abs(got - money(token)) > 0.01:
                print(
                    f"ERRO: soma de {col.split('#')[0]} ({got:,.2f}) não bate com o total do PDF "
                    f"({money(token):,.2f}); a extração está errada e não deve ser importada.",
                    file=sys.stderr,
                )
                return 1
        print("Totais conferem com a linha Total do PDF.")
    else:
        print("AVISO: linha Total não encontrada no PDF — totais não verificados.", file=sys.stderr)

    if clipped:
        # A clipped "0,0" is a row with no execution either way; listing those
        # buries the ones that actually lose information.
        notable = [c for c in clipped if not c.endswith("«0,0»")]
        print(
            f"AVISO: {len(clipped)} valor(es) com o último dígito cortado pela impressão do "
            f"portal ({len(notable)} não nulos); ficam vazios no CSV em vez de errados:",
            file=sys.stderr,
        )
        for item in notable[:10]:
            print(f"    {item}", file=sys.stderr)

    fieldnames = [
        "orderNumber",
        "activity",
        "designation",
        "classification",
        "endDate",
        "approved",
        "adjusted",
        "declaredExecuted",
        "declaredIndirect",
    ]
    with open(csv_path, "w", newline="", encoding="utf-8") as fh:
        writer = csv.DictWriter(fh, fieldnames=fieldnames)
        writer.writeheader()
        for row in rows:
            writer.writerow(
                {
                    "orderNumber": row["orderNumber"],
                    "activity": row["activity"],
                    "designation": row["designation"],
                    "classification": row["classification"],
                    "endDate": row["endDate"],
                    "approved": value(row, approved_col),
                    "adjusted": value(row, adjusted_col),
                    "declaredExecuted": value(row, executed_col),
                    "declaredIndirect": value(row, indirect_col),
                }
            )

    total = sum(r["values"][approved_col] for r in rows if r["values"][approved_col] is not None)
    print(f"{len(rows)} linhas escritas em {csv_path}")
    print(f"  aprovado {total:>14,.2f}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
