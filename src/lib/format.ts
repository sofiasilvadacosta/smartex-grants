export function eur(value: number) {
  return value.toLocaleString("pt-PT", { style: "currency", currency: "EUR" });
}

// "2024-03" -> "03/2024"
export function monthLabel(yearMonth: string) {
  const [year, month] = yearMonth.split("-");
  return `${month}/${year}`;
}
