import test from 'node:test';
import assert from 'node:assert/strict';
import { execSync } from 'child_process';
import fs from 'fs';
import os from 'os';
import path from 'path';

function runSql(sql) {
  const tmpFile = path.join(os.tmpdir(), `query_${Date.now()}_${Math.random().toString(36).slice(2)}.sql`);
  fs.writeFileSync(tmpFile, sql, 'utf-8');
  try {
    const res = execSync(`npx supabase db query --linked -f "${tmpFile}"`, {
      encoding: 'utf-8',
      maxBuffer: 50 * 1024 * 1024,
      shell: '/bin/zsh'
    });
    const jsonMatch = res.match(/\{[\s\S]*"rows":[\s\S]*\}/);
    if (jsonMatch) {
      const parsed = JSON.parse(jsonMatch[0]);
      return parsed.rows;
    }
    return [];
  } finally {
    if (fs.existsSync(tmpFile)) fs.unlinkSync(tmpFile);
  }
}

const ANZEN_SUPPLIER_ID = '8df2e209-0dc3-4ce4-8359-e619dace1d5f';

test('1. Purchase invoices appear in Anzen supplier payable ledger in USD', () => {
  const invoices = runSql(`
    SELECT id, invoice_number, invoice_date, total_amount, currency, exchange_rate, status
    FROM purchase_invoices
    WHERE supplier_id = '${ANZEN_SUPPLIER_ID}'
    ORDER BY invoice_date;
  `);

  assert.equal(invoices.length, 13, 'Anzen must have 13 purchase invoices');
  for (const inv of invoices) {
    assert.equal(inv.currency, 'USD', `Invoice ${inv.invoice_number} must have currency USD`);
    assert.ok(Number(inv.total_amount) > 0, `Invoice ${inv.invoice_number} must have positive total_amount`);
  }

  const totalInvoiceUSD = invoices.reduce((sum, i) => sum + Number(i.total_amount), 0);
  assert.equal(totalInvoiceUSD.toFixed(2), '416145.15', 'Total Anzen invoices must equal USD 416,145.15');
});

test('2. Supplier payments appear in Anzen supplier payable ledger in USD', () => {
  const payments = runSql(`
    SELECT id, voucher_number, voucher_date, amount, transaction_currency, payment_currency, exchange_rate, is_posted
    FROM payment_vouchers
    WHERE supplier_id = '${ANZEN_SUPPLIER_ID}' AND is_posted = true
    ORDER BY voucher_date;
  `);

  assert.equal(payments.length, 7, 'Anzen must have 7 posted payment vouchers');
  for (const pv of payments) {
    assert.equal(pv.transaction_currency, 'USD', `Payment ${pv.voucher_number} transaction_currency must be USD`);
    assert.ok(Number(pv.amount) > 0, `Payment ${pv.voucher_number} must have positive amount`);
  }

  const totalPaymentUSD = payments.reduce((sum, p) => sum + Number(p.amount), 0);
  assert.equal(totalPaymentUSD.toFixed(2), '200166.00', 'Total Anzen payments must equal USD 200,166.00');
});

test('3. Authoritative AP balance reconciles exactly: USD 416,145.15 - USD 200,166.00 = USD 215,979.15', () => {
  const invoiceRows = runSql(`
    SELECT SUM(total_amount) as total_invoices, SUM(balance_amount) as total_unpaid_balance
    FROM purchase_invoices
    WHERE supplier_id = '${ANZEN_SUPPLIER_ID}';
  `);
  const paymentRows = runSql(`
    SELECT SUM(amount) as total_payments
    FROM payment_vouchers
    WHERE supplier_id = '${ANZEN_SUPPLIER_ID}' AND is_posted = true;
  `);

  const totalInv = Number(invoiceRows[0].total_invoices);
  const totalPay = Number(paymentRows[0].total_payments);
  const netOutstanding = totalInv - totalPay;
  const unpaidBalanceSum = Number(invoiceRows[0].total_unpaid_balance);

  assert.equal(totalInv.toFixed(2), '416145.15', 'Authoritative invoice total');
  assert.equal(totalPay.toFixed(2), '200166.00', 'Authoritative payment total');
  assert.equal(netOutstanding.toFixed(2), '215979.15', 'Authoritative closing ledger balance must be USD 215,979.15');
  assert.equal(unpaidBalanceSum.toFixed(2), '215979.15', 'Sum of open invoice balance_amounts must equal USD 215,979.15');
});

test('4. PIB import expenses (e.g. EXP/26/253) exist operationally but do NOT contaminate supplier payable ledger', () => {
  const pibExpenses = runSql(`
    SELECT id, voucher_number, invoice_number, expense_category, amount, supplier_id
    FROM finance_expenses
    WHERE supplier_id = '${ANZEN_SUPPLIER_ID}' AND expense_category = 'pib_import';
  `);

  assert.equal(pibExpenses.length, 10, 'All 10 PIB import expenses must retain operational linkage to supplier');
  
  // Verify EXP/26/253 specifically
  const exp253 = pibExpenses.find(e => e.voucher_number === 'EXP/26/253');
  assert.ok(exp253, 'EXP/26/253 must exist in finance_expenses');
  assert.equal(exp253.expense_category, 'pib_import', 'EXP/26/253 must be categorized as pib_import');
  assert.equal(Number(exp253.amount), 80340800, 'EXP/26/253 amount is Rp 80,340,800');

  // Verify PartyLedger.tsx source code filters out pib_import and import_broker
  const partyLedgerCode = fs.readFileSync(path.join(process.cwd(), 'src/components/finance/PartyLedger.tsx'), 'utf-8');
  assert.match(
    partyLedgerCode,
    /\.not\('expense_category',\s*'in',\s*'\("pib_import","import_broker","loading_import","port_charges"\)'\)/,
    'PartyLedger must explicitly exclude import categories from supplier payable ledger'
  );
});

test('5. Import VAT (1150), PPh 22 (1155), Customs duty do NOT appear as supplier payable', () => {
  const taxLines = runSql(`
    SELECT jel.id, coa.code as account_code, coa.name as account_name, jel.debit, jel.credit
    FROM journal_entry_lines jel
    JOIN chart_of_accounts coa ON coa.id = jel.account_id
    WHERE jel.supplier_id = '${ANZEN_SUPPLIER_ID}'
      AND coa.code IN ('1150', '1155')
  `);

  assert.ok(taxLines.length > 0, 'Tax lines exist carrying supplier_id for operational traceability');

  // Verify that PartyLedger supplier payable logic only recognizes 2110 for broker/AP and purchase invoices
  const partyLedgerCode = fs.readFileSync(path.join(process.cwd(), 'src/components/finance/PartyLedger.tsx'), 'utf-8');
  assert.match(
    partyLedgerCode,
    /\.eq\('chart_of_accounts\.code',\s*'2110'\)/,
    'PartyLedger broker lines query must strictly filter by chart_of_accounts.code = 2110'
  );
});

test('6. USD supplier ledger maintains USD transaction balance and separates functional IDR', () => {
  const partyLedgerCode = fs.readFileSync(path.join(process.cwd(), 'src/components/finance/PartyLedger.tsx'), 'utf-8');
  
  assert.ok(partyLedgerCode.includes("detectedCurrency = 'USD'"), 'Must detect USD currency for USD suppliers');
  assert.ok(partyLedgerCode.includes("setSupplierCurrency(detectedCurrency)"), 'Must set supplier currency state');
  assert.ok(partyLedgerCode.includes("runningBalance += entry.debit - entry.credit"), 'Must compute running balance in transaction currency');
  assert.ok(partyLedgerCode.includes("Functional (IDR)"), 'Must render dedicated Functional (IDR) column');
  assert.ok(partyLedgerCode.includes("FX Rate"), 'Must render dedicated FX Rate column');
});

test('7. IDR settlement against USD invoice reduces the USD supplier balance correctly', () => {
  const idrSettledPV = runSql(`
    SELECT voucher_number, amount, transaction_currency, payment_currency, exchange_rate, (amount * exchange_rate) as idr_settlement
    FROM payment_vouchers
    WHERE supplier_id = '${ANZEN_SUPPLIER_ID}' AND voucher_number = 'PV/26-26/010';
  `);

  assert.equal(idrSettledPV.length, 1, 'PV/26-26/010 must exist');
  const pv = idrSettledPV[0];
  assert.equal(Number(pv.amount), 25000, 'PV amount is USD 25,000');
  assert.equal(pv.transaction_currency, 'USD', 'Transaction currency is USD');
  assert.equal(pv.payment_currency, 'IDR', 'Payment currency is IDR');
  assert.equal(Number(pv.exchange_rate), 17747, 'FX rate is 17,747');
  assert.equal(Number(pv.idr_settlement), 443675000, 'Actual IDR bank settlement is Rp 443,675,000');

  // Verify PartyLedger formats particulars with bank settlement info
  const partyLedgerCode = fs.readFileSync(path.join(process.cwd(), 'src/components/finance/PartyLedger.tsx'), 'utf-8');
  assert.ok(
    partyLedgerCode.includes('Bank settlement:'),
    'PartyLedger must display bank settlement IDR amount for IDR payments of USD invoices'
  );
});

test('8. Functional IDR accounting remains unchanged', () => {
  const piFunctional = runSql(`
    SELECT invoice_number, total_amount, exchange_rate, (total_amount * exchange_rate) as functional_idr
    FROM purchase_invoices
    WHERE supplier_id = '${ANZEN_SUPPLIER_ID}'
    ORDER BY invoice_date;
  `);

  // Verify functional calculation for sample invoice E0000332/2526 ($114,390.40 @ 16850 = Rp 1,927,478,240)
  const inv332 = piFunctional.find(i => i.invoice_number === 'E0000332/2526');
  assert.ok(inv332, 'E0000332/2526 exists');
  assert.equal(Number(inv332.functional_idr), 1927478240, 'Functional IDR matches 114390.40 * 16850');
});

test('9. Operational traceability intact: secondary Import / Customs Costs view available', () => {
  const partyLedgerCode = fs.readFileSync(path.join(process.cwd(), 'src/components/finance/PartyLedger.tsx'), 'utf-8');
  
  assert.ok(partyLedgerCode.includes('Supplier Payable Ledger'), 'UI label Supplier Payable Ledger exists');
  assert.ok(partyLedgerCode.includes('Import / Customs Costs'), 'UI label Import / Customs Costs exists');
  assert.ok(partyLedgerCode.includes('supplierSubView'), 'View mode switcher exists');
  assert.ok(partyLedgerCode.includes('loadImportCosts'), 'Import costs loader exists');
});

test('10. No historical accounting entries or operational linkages deleted', () => {
  const linesCount = runSql(`
    SELECT COUNT(*) as total_lines
    FROM journal_entry_lines
    WHERE supplier_id = '${ANZEN_SUPPLIER_ID}';
  `);

  assert.ok(Number(linesCount[0].total_lines) >= 29, 'All journal entry lines for Anzen remain intact in DB');
});
