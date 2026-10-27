import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const schema = JSON.parse(readFileSync(
  resolve('src/data/finance-import-templates.json'),
  'utf8',
));

const files = {
  expenses: 'finance-expenses.csv',
  payment_vouchers: 'finance-payment-vouchers.csv',
  receipt_vouchers: 'finance-receipt-vouchers.csv',
  petty_cash: 'finance-petty-cash.csv',
  salary: 'finance-salary.csv',
  bank_statement: 'finance-bank-statement.csv',
  manual_journal: 'finance-manual-journal.csv',
};

const splitCsvRow = row => {
  const cells = [];
  let current = '';
  let quoted = false;
  for (let index = 0; index < row.length; index += 1) {
    const char = row[index];
    if (char === '"') {
      if (quoted && row[index + 1] === '"') {
        current += '"';
        index += 1;
      } else {
        quoted = !quoted;
      }
    } else if (char === ',' && !quoted) {
      cells.push(current);
      current = '';
    } else {
      current += char;
    }
  }
  cells.push(current);
  return cells;
};

for (const [name, filename] of Object.entries(files)) {
  const content = readFileSync(resolve('public/templates', filename), 'utf8').trim();
  const [header, ...rows] = content.split(/\r?\n/);
  const actual = splitCsvRow(header);
  const expected = schema[name];
  if (JSON.stringify(actual) !== JSON.stringify(expected)) {
    throw new Error(`${filename} headers do not match the canonical ${name} schema`);
  }
  if (!rows.length) throw new Error(`${filename} must include an example row`);
  for (const [index, row] of rows.entries()) {
    if (splitCsvRow(row).length !== expected.length) {
      throw new Error(`${filename} row ${index + 2} has the wrong number of columns`);
    }
  }
}

const paymentHeader = schema.payment_vouchers;
for (const field of [
  'invoice_currency',
  'invoice_amount',
  'payment_currency',
  'payment_amount',
  'bank_currency',
  'exchange_rate',
  'converted_amount',
  'bank_charges',
  'actual_bank_debit',
]) {
  if (!paymentHeader.includes(field)) {
    throw new Error(`Payment template is missing canonical field ${field}`);
  }
}

console.log(JSON.stringify({
  status: 'passed',
  templates: Object.keys(files).length,
  schemas: Object.fromEntries(
    Object.entries(schema).map(([name, columns]) => [name, columns.length]),
  ),
}, null, 2));
