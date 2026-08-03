export function eur(value: number) {
  return value.toLocaleString("pt-PT", { style: "currency", currency: "EUR" });
}

// How a budget line is named wherever one has to be picked. The funder's
// "Nº ordem" leads because a project can approve several lines with the same
// classification and year, and then it is the only thing that tells them apart.
export function budgetLineLabel(line: {
  orderNumber: string;
  category: string;
  trlPhase: string;
}) {
  const suffix = line.trlPhase ? ` (${line.trlPhase})` : "";
  return line.orderNumber
    ? `${line.orderNumber} · ${line.category}${suffix}`
    : `${line.category}${suffix}`;
}

// "2024-03" -> "03/2024"
export function monthLabel(yearMonth: string) {
  const [year, month] = yearMonth.split("-");
  return `${month}/${year}`;
}
