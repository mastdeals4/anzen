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

  if (compact.indexOf('-', 1) !== -1) return null;
  const pattern = decimal ? /^-?[\d.,]*$/ : /^-?[\d.]*$/;
  if (!pattern.test(compact) || !/\d/.test(compact)) return null;

  const commaCount = (compact.match(/,/g) ?? []).length;
  const dotCount = (compact.match(/\./g) ?? []).length;
  if (commaCount > 1 && dotCount === 0) return null;
  if (commaCount > 1 && dotCount > 1) return null;

  const parsed = parseIndonesianNumber(compact);
  if (!Number.isFinite(parsed)) return null;
  return decimal ? parsed : Math.round(parsed);
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
  const lastDot = cleaned.lastIndexOf('.');
  const lastComma = cleaned.lastIndexOf(',');

  if (dotCount > 0 && commaCount > 0) {
    if (lastDot < lastComma) {
      // Indonesian format: 1.000.000,50 (dot for thousands, comma for decimal)
      cleaned = cleaned.replace(/\./g, '').replace(/,/g, '.');
    } else {
      // English format: 1,000,000.50 (comma for thousands, dot for decimal)
      cleaned = cleaned.replace(/,/g, '');
    }
  } else if (dotCount > 1) {
    // Multiple dots: 1.000.000 -> thousands separators
    cleaned = cleaned.replace(/\./g, '');
  } else if (commaCount > 1) {
    // Multiple commas: 1,000,000 -> thousands separators
    cleaned = cleaned.replace(/,/g, '');
  } else if (dotCount === 1 && commaCount === 0) {
    const parts = cleaned.split('.');
    // If decimal part is exactly 3 digits and preceded by 1-3 digits, treat as thousands separator (e.g. 20.000)
    // Note: if user types "15019.50" or "0.85" or "15.5", it stays as decimal
    if (parts[1].length === 3 && parts[0].length >= 1 && parts[0].length <= 3) {
      cleaned = cleaned.replace(/\./g, '');
    }
  } else if (commaCount === 1 && dotCount === 0) {
    const parts = cleaned.split(',');
    // If preceded by 1-3 digits and exactly 3 digits after, treat as thousands (e.g. 187,500)
    // Otherwise it's an Indonesian decimal (e.g. 15019,50 or 0,85 or 15,5)
    if (parts[1].length === 3 && parts[0].length >= 1 && parts[0].length <= 3) {
      cleaned = cleaned.replace(/,/g, '');
    } else {
      cleaned = cleaned.replace(/,/g, '.');
    }
  }

  const result = parseFloat(cleaned);
  return isNaN(result) ? 0 : result;
};
