import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

const cases = [
  ['src/components/finance/ReceiptVoucherManager.tsx', 'receipt_vouchers', 'voucher_date'],
  ['src/components/finance/PaymentVoucherManager.tsx', 'payment_vouchers', 'voucher_date'],
  ['src/components/finance/FundTransferManager.tsx', 'vw_fund_transfers_detailed', 'transfer_date'],
  ['src/components/finance/JournalEntryViewerEnhanced.tsx', 'journal_entries', 'entry_date'],
  ['src/components/finance/PurchaseInvoiceManager.tsx', 'purchase_invoices', 'invoice_date'],
  ['src/components/finance/PayablesManager.tsx', 'vendor_bills', 'bill_date'],
  ['src/components/finance/PayablesManager.tsx', 'vendor_payments', 'payment_date'],
];

for (const [file, table, dateColumn] of cases) {
  const source = await readFile(file, 'utf8');
  assert.match(source, /useFinance/, `${file} must use the existing global Finance context`);
  const tableStart = source.indexOf(`.from('${table}')`);
  assert.notEqual(tableStart, -1, `${file} must query ${table}`);
  const query = source.slice(tableStart, tableStart + 1_500);
  assert.match(query, new RegExp(`\\.gte\\('${dateColumn}', dateRange\\.startDate\\)`), `${table} must apply the global start date to ${dateColumn}`);
  assert.match(query, new RegExp(`\\.lte\\('${dateColumn}', dateRange\\.endDate\\)`), `${table} must apply the global end date to ${dateColumn}`);
}

console.log('finance global date-filter regression passed');
