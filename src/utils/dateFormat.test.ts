import { formatDate, getFinancialYear, toInputFormat } from './dateFormat';

const assertEqual = (actual: string, expected: string, message: string): void => {
  if (actual !== expected) {
    throw new Error(`${message}: expected "${expected}", got "${actual}"`);
  }
};

assertEqual(getFinancialYear(new Date(2026, 2, 31), 4), '25-26', 'FY Apr-Mar on March 31');
assertEqual(getFinancialYear(new Date(2026, 3, 1), 4), '26-27', 'FY Apr-Mar on April 1');
assertEqual(getFinancialYear(new Date(2026, 11, 31), 1), '26-26', 'FY Jan-Dec on Dec 31');
assertEqual(getFinancialYear(new Date(2027, 0, 1), 1), '27-27', 'FY Jan-Dec on Jan 1');
assertEqual(getFinancialYear(new Date(2026, 4, 10), 1), '26-26', 'FY Jan-Dec in May');
assertEqual(getFinancialYear(new Date(2026, 1, 10), 4), '25-26', 'FY Apr-Mar in February');

assertEqual(formatDate(null), '', 'formatDate null');
assertEqual(formatDate(undefined), '', 'formatDate undefined');
assertEqual(formatDate('invalid-date'), '', 'formatDate invalid input');

assertEqual(toInputFormat('31/12/2026'), '2026-12-31', 'toInputFormat DD/MM/YYYY');
assertEqual(toInputFormat('2026-12-31T08:00:00.000Z'), '2026-12-31', 'toInputFormat ISO input');
assertEqual(toInputFormat('99/99/2026'), '', 'toInputFormat invalid input');
