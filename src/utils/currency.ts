/**
 * Centralized currency formatting utilities
 * Ensures consistent decimal place display across the application
 */

export interface CurrencyFormatOptions {
  minimumFractionDigits?: number;
  maximumFractionDigits?: number;
  zeroAsDash?: boolean;
}

export const normalizeCurrency = (currency: string | null | undefined): string =>
  (currency || 'IDR').trim().toUpperCase() || 'IDR';

export interface TransactionCurrencyMetadata {
  transaction_currency?: string | null;
  currency_code?: string | null;
  payment_currency?: string | null;
  bank_account_currency?: string | null;
  currency?: string | null;
  bank_accounts?: { currency?: string | null } | Array<{ currency?: string | null }> | null;
}

/**
 * Resolves a document's display currency using the same precedence as the
 * Finance repair/reporting paths. Functional currency is intentionally not a
 * fallback: it describes the ledger amount, not the source document amount.
 */
export const resolveTransactionCurrency = (
  document: TransactionCurrencyMetadata | null | undefined,
): string => {
  const bankAccount = Array.isArray(document?.bank_accounts)
    ? document.bank_accounts[0]
    : document?.bank_accounts;

  return normalizeCurrency(
    document?.transaction_currency
      ?? document?.currency_code
      ?? document?.payment_currency
      ?? document?.bank_account_currency
      ?? document?.currency
      ?? bankAccount?.currency,
  );
};

export const formatCurrency = (
  amount: number | string | null | undefined,
  currency: string | null | undefined = 'IDR',
  options: CurrencyFormatOptions = {},
): string => {
  const numAmount = Number(amount) || 0;
  if (options.zeroAsDash && numAmount === 0) return '-';

  const normalizedCurrency = normalizeCurrency(currency);
  const minimumFractionDigits = options.minimumFractionDigits ?? 2;
  const maximumFractionDigits = options.maximumFractionDigits ?? 2;
  const locale = normalizedCurrency === 'IDR' ? 'id-ID' : 'en-US';
  const prefix = normalizedCurrency === 'IDR' ? 'Rp' : normalizedCurrency;

  return `${prefix} ${numAmount.toLocaleString(locale, {
    minimumFractionDigits,
    maximumFractionDigits,
  })}`;
};

export const formatNumber = (amount: number | string | null | undefined, decimals: number = 2): string => {
  const numAmount = Number(amount) || 0;
  return numAmount.toLocaleString('id-ID', {
    minimumFractionDigits: decimals,
    maximumFractionDigits: decimals
  });
};

export const formatPercentage = (value: number | string | null | undefined, decimals: number = 2): string => {
  const numValue = Number(value) || 0;
  return `${numValue.toLocaleString('id-ID', {
    minimumFractionDigits: decimals,
    maximumFractionDigits: decimals
  })}%`;
};

/** Format a normalized currency-input value using Indonesian separators. */
export const formatIndonesianMoneyInput = (
  value: number,
  decimal = true,
  minimumFractionDigits = 2,
  maximumFractionDigits = Math.max(2, minimumFractionDigits),
): string => {
  if (!Number.isFinite(value)) return '';
  if (!decimal) return value.toLocaleString('id-ID', { maximumFractionDigits: 0 });
  return value.toLocaleString('id-ID', {
    minimumFractionDigits,
    maximumFractionDigits,
  });
};

/**
 * Deterministic parser for an Indonesian input draft. Dots are thousands
 * separators and the single comma is the decimal separator. Null means the
 * draft is incomplete or invalid; an empty draft represents zero.
 */
export const parseIndonesianMoneyInput = (draft: string, decimal = true): number | null => {
  const compact = draft.replace(/\s/g, '');
  if (compact === '') return 0;

  const pattern = decimal ? /^-?[\d.]*,?\d*$/ : /^-?[\d.]*$/;
  if (!pattern.test(compact) || !/\d/.test(compact)) return null;
  if ((compact.match(/,/g) ?? []).length > 1) return null;

  const normalized = decimal
    ? compact.replace(/\./g, '').replace(',', '.')
    : compact.replace(/\./g, '');
  const parsed = Number(normalized);
  return Number.isFinite(parsed) ? parsed : null;
};

/**
 * Parse Indonesian number format to JavaScript number
 * Indonesian format: 1.000.000,50 (dot for thousands, comma for decimal)
 * Handles multiple formats:
 * - 20.000.000 or 20000000 or 20,000,000 (all treated as 20 million)
 * - 20.000.000,50 or 20000000.50 (20 million with decimals)
 */
export const parseIndonesianNumber = (value: string | number | null | undefined): number => {
  if (value === null || value === undefined || value === '') return 0;
  if (typeof value === 'number') return value;

  const str = String(value).trim();
  if (str === '') return 0;

  // Remove spaces and any currency decoration ("Rp 187.500" → "187.500"),
  // keeping only digits, separators and a leading minus.
  let cleaned = str.replace(/[^\d.,-]/g, '');

  // Count dots and commas to determine format
  const dotCount = (cleaned.match(/\./g) || []).length;
  const commaCount = (cleaned.match(/,/g) || []).length;

  // Indonesian format: 1.000.000,50 (multiple dots, one comma at end)
  if (dotCount > 1 || (dotCount >= 1 && commaCount === 1)) {
    // Remove thousand separators (dots)
    cleaned = cleaned.replace(/\./g, '');
    // Convert comma to decimal point
    cleaned = cleaned.replace(/,/g, '.');
  }
  // English with commas as thousands: 1,000,000.50
  else if (commaCount > 1 || (commaCount >= 1 && dotCount === 1)) {
    // Remove thousand separators (commas)
    cleaned = cleaned.replace(/,/g, '');
    // Dot is already decimal point
  }
  // Single separator - need to determine if it's thousands or decimal
  else if (dotCount === 1 && commaCount === 0) {
    const parts = cleaned.split('.');
    // If no decimal part or decimal part is exactly 3 digits, it's likely thousands
    // e.g., "20.000" or "20.000" - treat as 20000
    if (parts[1].length === 3) {
      cleaned = cleaned.replace(/\./g, '');
    }
    // Otherwise it's a decimal: "20.5" stays as 20.5
  }
  else if (commaCount === 1 && dotCount === 0) {
    const parts = cleaned.split(',');
    // Mirror the single-dot rule: exactly 3 digits after a single comma is a
    // thousands separator ("187,500" → 187500); anything else is an
    // Indonesian decimal ("187,50" → 187.5).
    if (parts[1].length === 3) {
      cleaned = cleaned.replace(/,/g, '');
    } else {
      cleaned = cleaned.replace(/,/g, '.');
    }
  }

  const result = parseFloat(cleaned);
  return isNaN(result) ? 0 : result;
};
