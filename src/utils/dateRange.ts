/**
 * Anzen ERP — Rolling Calendar Date Range & Timezone Utilities
 * Business Timezone: Asia/Jakarta (WIB, UTC+7)
 */

export interface FinanceDateRange {
  startDate: string; // YYYY-MM-DD
  endDate: string;   // YYYY-MM-DD
}

export type DateRangePreset = '1M' | '2M' | 'custom';

export function getJakartaDateParts(now: Date = new Date()): { year: number; month: number; day: number } {
  const formatter = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Asia/Jakarta',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  });
  const parts = formatter.formatToParts(now);
  const year = parseInt(parts.find(p => p.type === 'year')!.value, 10);
  const month = parseInt(parts.find(p => p.type === 'month')!.value, 10);
  const day = parseInt(parts.find(p => p.type === 'day')!.value, 10);
  return { year, month, day };
}

export function daysInMonth(year: number, month: number): number {
  return new Date(year, month, 0).getDate();
}

/**
 * Returns a rolling calendar month range based on Asia/Jakarta timezone.
 * Example: If today is 08/11/2026, 1 month rolling back is 08/10/2026 to 08/11/2026.
 * Properly handles month-end clamping (e.g. March 31 -> February 28/29).
 */
export function getRollingMonthsRange(monthsBack: number = 1, now: Date = new Date()): FinanceDateRange {
  const { year, month, day } = getJakartaDateParts(now);
  const endStr = `${year}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`;

  let startYear = year;
  let startMonth = month - monthsBack;
  while (startMonth <= 0) {
    startMonth += 12;
    startYear -= 1;
  }

  const maxDayInStartMonth = daysInMonth(startYear, startMonth);
  const startDay = Math.min(day, maxDayInStartMonth);
  const startStr = `${startYear}-${String(startMonth).padStart(2, '0')}-${String(startDay).padStart(2, '0')}`;

  return { startDate: startStr, endDate: endStr };
}

