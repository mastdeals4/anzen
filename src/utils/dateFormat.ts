/**
 * Centralized date formatting utilities
 * Ensures consistent DD/MM/YYYY format across the application
 */

/**
 * Format a date string or Date object to DD/MM/YYYY format
 * @param date - Date string, Date object, or null/undefined
 * @param includeTime - Whether to include time in format (DD/MM/YYYY HH:mm)
 * @returns Formatted date string or empty string if invalid
 */
export const formatDate = (
  date: string | Date | null | undefined,
  includeTime: boolean = false
): string => {
  if (!date) return '';

  const dateObj = typeof date === 'string' ? new Date(date) : date;
  if (Number.isNaN(dateObj.getTime())) return '';

  const day = String(dateObj.getDate()).padStart(2, '0');
  const month = String(dateObj.getMonth() + 1).padStart(2, '0');
  const year = dateObj.getFullYear();

  if (!includeTime) return `${day}/${month}/${year}`;

  const hours = String(dateObj.getHours()).padStart(2, '0');
  const minutes = String(dateObj.getMinutes()).padStart(2, '0');
  return `${day}/${month}/${year} ${hours}:${minutes}`;
};

/**
 * Format a date to short format (DD/MM/YY)
 * @param date - Date string or Date object
 * @returns Formatted date string (DD/MM/YY)
 */
export const formatDateShort = (date: string | Date | null | undefined): string => {
  if (!date) return '';

  try {
    const dateObj = typeof date === 'string' ? new Date(date) : date;

    if (isNaN(dateObj.getTime())) return '';

    const day = String(dateObj.getDate()).padStart(2, '0');
    const month = String(dateObj.getMonth() + 1).padStart(2, '0');
    const year = String(dateObj.getFullYear()).slice(-2);

    return `${day}/${month}/${year}`;
  } catch (error) {
    console.error('Error formatting date:', error);
    return '';
  }
};

/**
 * Format a datetime string to readable format (DD/MM/YYYY HH:mm:ss)
 * @param datetime - Datetime string or Date object
 * @returns Formatted datetime string
 */
export const formatDateTime = (datetime: string | Date | null | undefined): string => {
  if (!datetime) return '';

  try {
    const dateObj = typeof datetime === 'string' ? new Date(datetime) : datetime;

    if (isNaN(dateObj.getTime())) return '';

    const day = String(dateObj.getDate()).padStart(2, '0');
    const month = String(dateObj.getMonth() + 1).padStart(2, '0');
    const year = dateObj.getFullYear();
    const hours = String(dateObj.getHours()).padStart(2, '0');
    const minutes = String(dateObj.getMinutes()).padStart(2, '0');
    const seconds = String(dateObj.getSeconds()).padStart(2, '0');

    return `${day}/${month}/${year} ${hours}:${minutes}:${seconds}`;
  } catch (error) {
    console.error('Error formatting datetime:', error);
    return '';
  }
};

/**
 * Convert DD/MM/YYYY string to YYYY-MM-DD for input fields
 * @param dateStr - Date string in DD/MM/YYYY format
 * @returns Date string in YYYY-MM-DD format
 */
export const toInputFormat = (dateStr: string | null | undefined): string => {
  if (!dateStr) return '';

  if (/^\d{4}-\d{2}-\d{2}/.test(dateStr)) {
    return dateStr.split('T')[0];
  }

  const match = dateStr.match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})$/);
  if (!match) return '';

  const [, day, month, year] = match;
  const dayNum = Number(day);
  const monthNum = Number(month);

  if (dayNum < 1 || dayNum > 31 || monthNum < 1 || monthNum > 12) return '';

  return `${year}-${String(monthNum).padStart(2, '0')}-${String(dayNum).padStart(2, '0')}`;
};

/**
 * Get current date in YYYY-MM-DD format for input fields
 * @returns Current date string
 */
export const getTodayInputFormat = (): string => {
  const today = new Date();
  const year = today.getFullYear();
  const month = String(today.getMonth() + 1).padStart(2, '0');
  const day = String(today.getDate()).padStart(2, '0');
  return `${year}-${month}-${day}`;
};

/**
 * Format date for display in tables (DD/MM/YYYY)
 * This is an alias for formatDate for semantic clarity
 */
export const formatTableDate = formatDate;

/**
 * Returns financial year string in "YY-YY" format for a given local date.
 *
 * Default behavior is Indonesia style (Jan-Dec) with `fyStartMonth = 1`.
 * Use `fyStartMonth` to switch fiscal boundary if needed (for example, 4 for Apr-Mar).
 *
 * Logic:
 * - If date month >= fyStartMonth, FY starts in the same year.
 * - Otherwise, FY starts in the previous year.
 *
 * Examples:
 * - getFinancialYear(new Date('2026-05-10'), 1) => "26-26"
 * - getFinancialYear(new Date('2026-05-10'), 4) => "26-27"
 * - getFinancialYear(new Date('2026-02-10'), 4) => "25-26"
 */
export const getFinancialYear = (date: Date, fyStartMonth = 1): string => {
  if (!(date instanceof Date) || isNaN(date.getTime())) return '';

  const normalizedStartMonth = Number.isInteger(fyStartMonth) && fyStartMonth >= 1 && fyStartMonth <= 12
    ? fyStartMonth
    : 1;

  const month = date.getMonth() + 1;
  const year = date.getFullYear();
  const startYear = month >= normalizedStartMonth ? year : year - 1;
  const endYear = normalizedStartMonth === 1 ? startYear : startYear + 1;

  return `${String(startYear).slice(-2)}-${String(endYear).slice(-2)}`;
};

/**
 * Generate a voucher/invoice number in format PREFIX/YY-YY/NNN.
 * Counts existing numbers with same prefix+FY and increments.
 * dateStr: YYYY-MM-DD string for the document date.
 */
export const buildVoucherNumber = (prefix: string, fy: string, seq: number): string =>
  `${prefix}/${fy}/${String(seq).padStart(3, '0')}`;

/**
 * Parse ISO date string and return in DD/MM/YYYY format
 * @param isoDate - ISO date string (YYYY-MM-DD or YYYY-MM-DDTHH:mm:ss)
 * @returns Formatted date string (DD/MM/YYYY)
 */
export const parseISODate = (isoDate: string | null | undefined): string => {
  if (!isoDate) return '';

  try {
    const date = new Date(isoDate);
    return formatDate(date);
  } catch (error) {
    console.error('Error parsing ISO date:', error);
    return '';
  }
};
