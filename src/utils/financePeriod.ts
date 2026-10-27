const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'] as const;

export function formatFinancePeriod(year: number, month: number): string {
  const label = MONTHS[month - 1];
  if (!label || !Number.isInteger(year)) return '';
  return `${label}-${String(year).slice(-2)}`;
}

export function formatFinancePeriodValue(value: string): string {
  const match = value.match(/^(\d{4})-(\d{2})$/);
  return match ? formatFinancePeriod(Number(match[1]), Number(match[2])) : value;
}

export function currentFinancePeriod(): string {
  const now = new Date();
  return `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}`;
}

export function normalizeSalaryPeriod(value: string, referenceYear = new Date().getFullYear()): string {
  if (/^\d{4}-(0[1-9]|1[0-2])$/.test(value)) return value;
  const displayPeriod = value.match(/^([A-Za-z]{3})-(\d{2})$/);
  if (displayPeriod) {
    const displayMonth = MONTHS.findIndex(month => month.toLowerCase() === displayPeriod[1].toLowerCase());
    if (displayMonth >= 0) return `20${displayPeriod[2]}-${String(displayMonth + 1).padStart(2, '0')}`;
  }
  const legacyMonth = MONTHS.findIndex(month => value.toLowerCase().startsWith(month.toLowerCase()));
  if (legacyMonth >= 0) return `${referenceYear}-${String(legacyMonth + 1).padStart(2, '0')}`;
  return currentFinancePeriod();
}

export function salaryPeriodOptions(centerYear = new Date().getFullYear()): Array<{ value: string; label: string }> {
  return [centerYear - 1, centerYear, centerYear + 1].flatMap(year =>
    MONTHS.map((_, index) => {
      const value = `${year}-${String(index + 1).padStart(2, '0')}`;
      return { value, label: formatFinancePeriodValue(value) };
    }),
  );
}
