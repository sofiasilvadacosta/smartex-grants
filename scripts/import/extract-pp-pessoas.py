#!/usr/bin/env python3
"""Extract the "Pessoal" table from a SGO 2030 / Norte 2030 payment request PDF
into the CSV the TypeScript importer reads.

Unlike the investment table, this one has no activity or "Nº ordem" column: the
portal reports personnel cost per technician and month, and the aggregation to
the approved investment lines happens elsewhere. The importer therefore leaves
each row's budget line unresolved for reconciliation in the app.

Columns are recovered by x-position (the description wraps over several visual
lines and would otherwise bleed into the name column). The row sum is checked
against the document's own total and the script fails if they disagree.

Usage:
    python3 scripts/import/extract-pp-pessoas.py <pedido_de_pagamento.pdf> <out.csv>

Requires: pip install pdfplumber
"""

import csv
import re
import sys
from collections import defaultdict

import pdfplumber

# Left edge of each column, read off the header row of the portal's form.
COLUMNS = [
    ("id", 50),
    ("pp", 68),
    ("tecnico", 80),
    ("nif", 110),
    ("nome", 150),
    ("descricao", 300),
    ("yearMonth", 430),
    ("amount", 480),
    ("valid", 535),
]
MONEY_ONLY = re.compile(r"^[\d.]+,\d{2}$")
YEAR_MONTH = re.compile(r"^\d{4}-\d{2}$")


def column_of(x: float) -> str:
    name = COLUMNS[0][0]
    for column, left in COLUMNS:
        if x >= left - 2:
            name = column
    return name


def money(token: str) -> float:
    return float(token.replace(".", "").replace(",", "."))


def parse(path: str):
    rows, wrapped_description, stated_total = [], [], None

    with pdfplumber.open(path) as pdf:
        for page in pdf.pages:
            buckets = defaultdict(list)
            for word in page.extract_words():
                buckets[round(word["top"] / 3)].append(word)

            for key in sorted(buckets):
                cells = defaultdict(list)
                for word in sorted(buckets[key], key=lambda w: w["x0"]):
                    cells[column_of(word["x0"])].append(word["text"])
                joined = {k: " ".join(v).strip() for k, v in cells.items()}

                year_month = joined.get("yearMonth", "")
                if YEAR_MONTH.fullmatch(year_month) and joined.get("id", "").isdigit():
                    rows.append(
                        {
                            "sourceId": joined["id"],
                            "ppNumber": joined.get("pp", ""),
                            "technician": joined.get("tecnico", ""),
                            "taxId": joined.get("nif", ""),
                            "name": joined.get("nome", ""),
                            "description": " ".join(
                                wrapped_description + [joined.get("descricao", "")]
                            ).strip(),
                            "yearMonth": year_month,
                            "amount": f"{money(joined.get('amount', '0,00')):.2f}",
                        }
                    )
                    wrapped_description = []
                elif joined.get("descricao") and not joined.get("id"):
                    wrapped_description.append(joined["descricao"])
                else:
                    # A lone money token on its own line is the table's total.
                    lone = [t for v in cells.values() for t in v]
                    if len(lone) == 1 and MONEY_ONLY.fullmatch(lone[0]):
                        stated_total = money(lone[0])

    return rows, stated_total


def main() -> int:
    if len(sys.argv) != 3:
        print(__doc__)
        return 2
    pdf_path, csv_path = sys.argv[1], sys.argv[2]

    rows, stated_total = parse(pdf_path)
    if not rows:
        print("ERRO: nenhuma linha de pessoal encontrada no PDF", file=sys.stderr)
        return 1

    total = sum(float(r["amount"]) for r in rows)
    if stated_total is None:
        print("AVISO: total não encontrado no PDF — soma não verificada.", file=sys.stderr)
    elif abs(total - stated_total) > 0.01:
        print(
            f"ERRO: soma das linhas ({total:,.2f}) não bate com o total do PDF"
            f" ({stated_total:,.2f}); a extração está errada e não deve ser importada.",
            file=sys.stderr,
        )
        return 1
    else:
        print("Total confere com o total do PDF.")

    with open(csv_path, "w", newline="", encoding="utf-8") as fh:
        writer = csv.DictWriter(fh, fieldnames=list(rows[0].keys()))
        writer.writeheader()
        writer.writerows(rows)

    by_pp = defaultdict(float)
    for r in rows:
        by_pp[r["ppNumber"]] += float(r["amount"])
    print(f"{len(rows)} linhas escritas em {csv_path}")
    for pp in sorted(by_pp):
        print(f"  PP {pp}: {by_pp[pp]:>14,.2f}")
    print(f"  TOTAL {total:>16,.2f}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
