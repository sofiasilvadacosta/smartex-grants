#!/usr/bin/env python3
"""Extract the "Quadro de Investimentos" from a SGO 2030 / Norte 2030 payment
request PDF into the CSV the TypeScript importer reads.

The portal renders the table as a printed web page, so there is no machine
-readable structure: rows are recovered by grouping words into visual lines and
locating the trailing block of money-formatted tokens. The row's own totals are
checked against the document's total row, and the script fails loudly if they
disagree — a silent mis-parse of financial data is worse than no import.

Usage:
    python3 scripts/import/extract-pp-pdf.py <pedido_de_pagamento.pdf> <out.csv>

Requires: pip install pdfplumber
"""

import csv
import re
import sys

import pdfplumber

MONEY = re.compile(r"^\d{1,3}(?:\.\d{3})*,\d{2}$")
ORDER = re.compile(r"^\d{1,3}$")
DATE = re.compile(r"^\d{4}-\d{2}-\d{2}$")

# The funder's cost classifications, recognised by their trailing letter code.
CLASSIFICATIONS = [
    ("Pessoal técnico do beneficiário (a)", ("Pessoal técnico",)),
    ("Matérias-primas e componentes (c)", ("Matérias-primas",)),
    ("Aquisição de serviços a terceiros (e)", ("serviços", "terceiros")),
    ("Aquisição de instrumentos e equipamento científico (f)", ("científico (f)",)),
    ("Despesas com promoção e divulgação (h)", ("divulgação",)),
    ("Viagens e estadas no estrangeiro (i)", ("Viagens", "estrangeiro")),
]


def money(token: str) -> float:
    return float(token.replace(".", "").replace(",", "."))


def classify(text: str) -> str:
    for label, needles in CLASSIFICATIONS:
        if any(n in text for n in needles):
            return label
    raise ValueError(f"classificação não reconhecida em: {text!r}")


def visual_lines(pdf):
    for page in pdf.pages:
        buckets = {}
        for word in page.extract_words():
            buckets.setdefault(round(word["top"] / 3), []).append(word)
        for key in sorted(buckets):
            yield [w["text"] for w in sorted(buckets[key], key=lambda w: w["x0"])]


def parse(path: str):
    rows, carry = [], []
    stated_totals = None

    with pdfplumber.open(path) as pdf:
        for tokens in visual_lines(pdf):
            if not tokens:
                continue
            nums = [t for t in tokens if MONEY.fullmatch(t)]

            # The document's own total row: no order number, 4+ money tokens.
            if len(nums) >= 4 and not ORDER.fullmatch(tokens[0]) and stated_totals is None:
                if not any(c.isalpha() for t in tokens for c in t):
                    stated_totals = (money(nums[0]), money(nums[-2]), money(nums[-1]))
                    continue

            if ORDER.fullmatch(tokens[0]) and len(nums) >= 5:
                first_money = next(i for i, t in enumerate(tokens) if MONEY.fullmatch(t))
                head = tokens[1:first_money]
                date = next((t for t in head if DATE.fullmatch(t)), None)

                # The activity and establishment numbers are the last two bare
                # integers before the date. Travel rows carry no date, so fall
                # back to scanning the whole head — without this they all lose
                # their activity and collapse into one another.
                scan = head[: head.index(date)] if date else head
                plain = [t for t in scan if re.fullmatch(r"\d+", t)]
                activity = plain[-2] if len(plain) >= 2 else None

                text = " ".join(carry + [t for t in head if not re.fullmatch(r"\d+|\d{4}-\d{2}-\d{2}", t)])
                rows.append(
                    {
                        "orderNumber": tokens[0],
                        "activity": activity or "",
                        "classification": classify(text),
                        "endDate": date or "",
                        "approved": f"{money(nums[0]):.2f}",
                        "declaredExecuted": f"{money(nums[3]):.2f}",
                        "declaredIndirect": f"{money(nums[4]):.2f}",
                    }
                )
                carry = []
            elif not MONEY.fullmatch(tokens[-1]) and len(tokens) <= 8 and not tokens[0].startswith("http"):
                joined = " ".join(tokens)
                carry = tokens if len(joined) < 90 else []

    return rows, stated_totals


def main() -> int:
    if len(sys.argv) != 3:
        print(__doc__)
        return 2
    pdf_path, csv_path = sys.argv[1], sys.argv[2]

    rows, stated = parse(pdf_path)
    if not rows:
        print("ERRO: nenhuma linha de investimento encontrada no PDF", file=sys.stderr)
        return 1

    totals = (
        sum(float(r["approved"]) for r in rows),
        sum(float(r["declaredExecuted"]) for r in rows),
        sum(float(r["declaredIndirect"]) for r in rows),
    )
    if stated:
        for name, got, want in zip(("aprovado", "executado", "indiretos"), totals, stated):
            if abs(got - want) > 0.01:
                print(
                    f"ERRO: soma de {name} ({got:,.2f}) não bate com o total do PDF ({want:,.2f});"
                    " a extração está errada e não deve ser importada.",
                    file=sys.stderr,
                )
                return 1
        print("Totais conferem com a linha Total do PDF.")
    else:
        print("AVISO: linha Total não encontrada no PDF — totais não verificados.", file=sys.stderr)

    with open(csv_path, "w", newline="", encoding="utf-8") as fh:
        writer = csv.DictWriter(fh, fieldnames=list(rows[0].keys()))
        writer.writeheader()
        writer.writerows(rows)

    print(f"{len(rows)} linhas escritas em {csv_path}")
    print(f"  aprovado   {totals[0]:>14,.2f}")
    print(f"  executado  {totals[1]:>14,.2f}")
    print(f"  indiretos  {totals[2]:>14,.2f}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
