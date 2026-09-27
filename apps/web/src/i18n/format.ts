/** Fills {placeholders}. A missing value is left visible rather than guessed. */
export function fmt(template: string, values: Record<string, string | number> = {}): string {
  return template.replace(/\{(\w+)\}/g, (whole, key: string) => (key in values ? String(values[key]) : whole));
}

export function formatDate(locale: string, iso: string | number | Date): string {
  return new Intl.DateTimeFormat(locale, { dateStyle: "medium", timeZone: "UTC" }).format(new Date(iso));
}

export function formatMoney(locale: string, cents: number, currency: string): string {
  return new Intl.NumberFormat(locale, { style: "currency", currency: currency.toUpperCase() }).format(cents / 100);
}
