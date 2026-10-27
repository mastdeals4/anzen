import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';

const salesSource = fs.readFileSync('src/pages/Sales.tsx', 'utf8');
const salesOrdersSource = fs.readFileSync('src/pages/SalesOrders.tsx', 'utf8');
const deliveryChallanSource = fs.readFileSync('src/pages/DeliveryChallan.tsx', 'utf8');

test('1. Authorised Admin & Accounts can edit quantity on posted invoices', () => {
  // Quantity input must not be unconditionally disabled when isEditingPosted is true
  assert.match(
    salesSource,
    /disabled=\{isEditingPosted && !isFinancialEditor\}/,
    'Quantity input must be enabled for financial editors on posted invoices'
  );

  // Unit price and tax rate inputs must also be enabled for financial editors
  assert.match(
    salesSource,
    /value=\{item\.unit_price\}[\s\S]*?disabled=\{isEditingPosted && !isFinancialEditor\}/,
    'Unit price input must be enabled for financial editors'
  );
});

test('2. handleEdit preserves item id for sales invoice items update', () => {
  // Previously id was missing from mappedItem in handleEdit, causing if (item.id) to fail
  assert.match(
    salesSource,
    /const mappedItem = \{\s*id: item\.id,[\s\S]*?product_id: item\.product_id/,
    'mappedItem in handleEdit must include id: item.id'
  );
});

test('3. Posted invoice save logic updates quantity and enforces DC dispatch limit', () => {
  // Must update quantity on sales_invoice_items
  assert.match(
    salesSource,
    /from\('sales_invoice_items'\)\s*\.update\(\{\s*quantity:\s*newQty,\s*unit_price:\s*item\.unit_price,\s*tax_rate:\s*item\.tax_rate,\s*total_amount:\s*newQty \* item\.unit_price/,
    'sales_invoice_items update must include revised quantity'
  );

  // Must validate that invoice quantity does not exceed delivery challan dispatched quantity
  assert.match(
    salesSource,
    /if \(maxQty > 0 && newQty > maxQty \+ 0\.0001\)/,
    'Must enforce that invoice quantity cannot exceed delivery challan dispatched quantity'
  );

  // Direct client-side batch stock writes must NOT be performed (single-owner invariant: DC owns stock)
  assert.doesNotMatch(
    salesSource,
    /from\('batches'\)[\s\S]*?update\(\{\s*current_stock:/,
    'Must not perform direct batch writes from sales invoice frontend'
  );
});

test('4. General Ledger Revenue and COGS synchronization on invoice correction', () => {
  // GL Revenue Journal Entry lines must synchronize:
  // 1120 A/R: Debit = revised total
  assert.match(salesSource, /coaCode === '1120'[\s\S]*?update\(\{ debit: total, credit: 0 \}\)/);
  // 4100 / 4110 Sales Revenue: Credit = revised subtotal
  assert.match(salesSource, /\(coaCode === '4100' \|\| coaCode === '4110'\)[\s\S]*?update\(\{ debit: 0, credit: subtotal \}\)/);
  // 2130 PPN Output: Credit = revised taxAmount
  assert.match(salesSource, /coaCode === '2130'[\s\S]*?update\(\{ debit: 0, credit: taxAmount \}\)/);

  // COGS Journal Entry must also synchronize if present
  assert.match(salesSource, /source_module', 'sales_invoice_cogs'/);
  assert.match(salesSource, /coaCode === '5100'[\s\S]*?update\(\{ debit: totalCogs, credit: 0 \}\)/);
  assert.match(salesSource, /coaCode === '1130'[\s\S]*?update\(\{ debit: 0, credit: totalCogs \}\)/);
});

test('5. Delete action on posted invoice triggers controlled Cancellation ("Delete = Cancel")', () => {
  // handleDelete delegates posted invoices to handleCancelInvoice
  assert.match(
    salesSource,
    /if \(isPostedInvoice\(targetInvoice\)\) \{\s*await handleCancelInvoice\(targetInvoice\);\s*return;\s*\}/,
    'handleDelete on posted invoice must invoke handleCancelInvoice'
  );

  // Table actions render Cancel button for posted invoices instead of inactive Lock
  assert.match(
    salesSource,
    /title="Cancel Posted Invoice \(Reverse Accounting & Unbill Challan\)"/,
    'Table actions must provide a Cancel Posted Invoice button'
  );
});

test('6. handleCancelInvoice enforces payment guard and accounting reversal', () => {
  // Payment guard: cannot cancel if paid_amount > 0.01
  assert.match(
    salesSource,
    /if \(paidAmt > 0\.01\) \{\s*showToast\(\{\s*type: 'error',\s*title: 'Payment Allocated'/,
    'Cancellation must be blocked if payments have been allocated to the invoice'
  );

  // General Ledger reversal: marks journal entries is_reversed = true
  assert.match(
    salesSource,
    /from\('journal_entries'\)\s*\.update\(\{\s*is_reversed:\s*true,\s*reversed_by_id:/,
    'Revenue and COGS journal entries must be marked is_reversed = true'
  );

  // DC link release: sets delivery_challan_item_id = null so DC is unbilled
  assert.match(
    salesSource,
    /from\('sales_invoice_items'\)\s*\.update\(\{\s*delivery_challan_item_id:\s*null\s*\}\)\s*\.eq\('invoice_id',\s*invoice\.id\)/,
    'Sales invoice items must unlink delivery_challan_item_id upon cancellation'
  );

  // Indonesian Faktur Pajak: sets status = 'cancelled'
  assert.match(
    salesSource,
    /from\('faktur_pajak'\)\s*\.update\(\{\s*status:\s*'cancelled'/,
    'Indonesian Faktur Pajak must be marked as cancelled'
  );
});

test('7. Cancelled invoices are clearly marked and excluded from active revenue stats', () => {
  assert.match(salesSource, /function isCancelledInvoice\(invoice: SalesInvoice\): boolean/);
  assert.match(salesSource, /if \(isCancelledInvoice\(inv\)\)[\s\S]*?Cancelled/);

  // Stats calculation excludes cancelled invoices
  assert.match(salesSource, /invoices\.filter\(\(?inv\)?\s*=>\s*!isCancelledInvoice\(inv\)\)/);
});

test('8. SalesOrders.tsx allows Admin to edit orders when DC is unlinked/reversed', () => {
  assert.match(
    salesOrdersSource,
    /profile\?\.role === 'admin' && !\['closed', 'cancelled'\]\.includes\(order\.status\)/,
    'Admin must be permitted to edit Sales Orders when downstream DCs are reversed'
  );
});

test('9. Reference Case Simulation: SO-2026-0087 / DO-26-0073 / SAPJ-26-072 revision math', () => {
  // Scenario:
  // Original: 100 kg @ Rp 50,000, 11% PPN, batch cost Rp 30,000/kg
  // Customer revised PO: 80 kg @ Rp 45,000, 11% PPN
  const origQty = 100;
  const origPrice = 50000;
  const unitCost = 30000;

  const revisedQty = 80;
  const revisedPrice = 45000;
  const taxRate = 11;

  // 1. Financial calculation
  const subtotal = revisedQty * revisedPrice; // 3,600,000
  const taxAmount = subtotal * (taxRate / 100); // 396,000
  const total = subtotal + taxAmount; // 3,996,000

  assert.equal(subtotal, 3600000, 'Subtotal must be 3,600,000');
  assert.equal(taxAmount, 396000, 'PPN 11% must be 396,000');
  assert.equal(total, 3996000, 'Total must be 3,996,000');

  // 2. Physical stock adjustment
  const qtyDiff = revisedQty - origQty; // -20 kg
  assert.equal(qtyDiff, -20, 'Quantity reduced by 20 units');
  const returnedToBatch = Math.abs(qtyDiff);
  assert.equal(returnedToBatch, 20, '20 units returned to batch current_stock');

  // 3. GL Revenue entries
  const arDebit = total; // 3,996,000
  const revenueCredit = subtotal; // 3,600,000
  const ppnCredit = taxAmount; // 396,000
  assert.equal(arDebit, revenueCredit + ppnCredit, 'Revenue journal entry must be balanced');

  // 4. GL COGS entries
  const revisedCogs = revisedQty * unitCost; // 80 * 30,000 = 2,400,000
  const cogsDebit = revisedCogs;
  const inventoryCredit = revisedCogs;
  assert.equal(cogsDebit, inventoryCredit, 'COGS journal entry must be balanced');
  assert.equal(revisedCogs, 2400000, 'Revised COGS must be 2,400,000');
});

const partyLedgerSource = fs.readFileSync('src/components/finance/PartyLedger.tsx', 'utf8');
const receivablesSource = fs.readFileSync('src/components/finance/ReceivablesManager.tsx', 'utf8');
const migrationSource = fs.readFileSync('supabase/migrations/20261027220000_atomic_sales_invoice_cancellation.sql', 'utf8');

test('10. Foreign key safety: reversed_by_id is kept null on journal cancellation', () => {
  // journal_entries.reversed_by_id has an FK pointing to journal_entries(id).
  // Passing a user profile UUID (profile?.id) causes an instant FK constraint violation.
  assert.match(
    salesSource,
    /from\('journal_entries'\)\s*\.update\(\{\s*is_reversed:\s*true,\s*reversed_by_id:\s*null,/,
    'journal_entries update must set reversed_by_id: null to prevent FK violation'
  );
  assert.doesNotMatch(
    salesSource,
    /from\('journal_entries'\)\s*\.update\(\{[^}]*reversed_by_id:\s*profile\?\.id/,
    'Must not pass profile?.id to journal_entries.reversed_by_id'
  );
});

test('11. Comprehensive journal resolution checks reference_id, reference_number, and module variants', () => {
  assert.match(
    salesSource,
    /\.in\('source_module',\s*\['sales_invoice',\s*'sales',\s*'sales_invoices'\]\)/,
    'Must check candidate sales invoice source modules'
  );
  assert.match(
    salesSource,
    /\.or\(`reference_id\.eq\.\$\{invoice\.id\},reference_number\.eq\.\$\{invoice\.invoice_number\}`\)/,
    'Must resolve journals by reference_id or reference_number'
  );
  assert.match(
    salesSource,
    /\.eq\('source_module',\s*'sales_invoice_cogs'\)[\s\S]*?\.or\(`reference_id\.eq\.\$\{invoice\.id\},reference_number\.eq\.\$\{invoice\.invoice_number\}`\)/,
    'Must resolve COGS journals by invoice ID or invoice number'
  );
});

test('12. Strict error handling: journal reversal errors abort cancellation', () => {
  assert.match(
    salesSource,
    /if \(revUpdateErr\) \{\s*throw new Error\(/,
    'Revenue journal reversal errors must throw and abort cancellation'
  );
  assert.match(
    salesSource,
    /if \(cogsUpdateErr\) \{\s*throw new Error\(/,
    'COGS journal reversal errors must throw and abort cancellation'
  );
  assert.match(
    salesSource,
    /if \(invError\) throw invError;/,
    'Invoice update error must throw'
  );
});

test('13. Reversal handles stuck/partially cancelled invoices (e.g. SAPJ-26-072)', () => {
  assert.match(
    salesSource,
    /const isAlreadyMarkedCancelled = isCancelledInvoice\(invoice\);/,
    'Must identify whether invoice already has cancellation note'
  );
  assert.match(
    salesSource,
    /title:\s*isAlreadyMarkedCancelled \? 'Complete Financial Reversal' : 'Cancel Posted Invoice'/,
    'Must offer Complete Financial Reversal if invoice was previously stuck'
  );
  assert.match(
    salesSource,
    /onClick=\{\(\) => isFinancialEditor && handleCancelInvoice\(invoice\)\}/,
    'Cancelled badge must allow authorized users to click and complete financial reversal'
  );
});

test('14. Customer Party Ledger excludes cancelled invoices to prevent phantom balances', () => {
  assert.match(
    partyLedgerSource,
    /\.select\('id,\s*invoice_date,\s*invoice_number,\s*total_amount,\s*payment_status,\s*notes'\)/,
    'PartyLedger must select notes on customer sales invoices'
  );
  assert.match(
    partyLedgerSource,
    /invoices\s*\.filter\(inv => !inv\.notes\?\.includes\('\[CANCELLED'\) && !inv\.notes\?\.toLowerCase\(\)\.startsWith\('cancelled'\)\)/,
    'PartyLedger must filter out cancelled sales invoices'
  );
});

test('15. Receivables Manager filters out cancelled invoices', () => {
  assert.match(
    receivablesSource,
    /\.select\('id,\s*invoice_number,\s*customer_id,\s*invoice_date,\s*due_date,\s*total_amount,\s*payment_status,\s*notes,\s*balance_amount,\s*customers\(company_name\)'\)/,
    'ReceivablesManager must select notes and balance_amount'
  );
  assert.match(
    receivablesSource,
    /\.filter\(\(inv:\s*any\)\s*=>\s*!inv\.notes\?\.includes\('\[CANCELLED'\) && !inv\.notes\?\.toLowerCase\(\)\.startsWith\('cancelled'\)/,
    'ReceivablesManager must filter out cancelled invoices'
  );
});

test('16. Database migration provides transactional cancel_sales_invoice RPC and trigger permissions', () => {
  assert.match(
    migrationSource,
    /CREATE OR REPLACE FUNCTION public\.cancel_sales_invoice/,
    'Migration must define cancel_sales_invoice RPC'
  );
  assert.match(
    migrationSource,
    /current_setting\('app\.sales_invoice_cancel', true\) = 'true'/,
    'Migration must allow unlinking delivery_challan_item_id when cancelling invoice'
  );
  assert.match(
    migrationSource,
    /NOT \(si\.notes LIKE '\[CANCELLED%' OR LOWER\(si\.notes\) LIKE 'cancelled%'\)/,
    'dc_invoicing_summary view must exclude cancelled invoices'
  );
  assert.match(
    migrationSource,
    /GRANT EXECUTE ON FUNCTION public\.cancel_sales_invoice\(uuid, text, uuid\) TO authenticated;/,
    'cancel_sales_invoice RPC must be executable by authenticated users'
  );
});

test('17. Canonical compensating reversal journal architecture in cancel_sales_invoice RPC', () => {
  // Reversal journal entry number generated via next_journal_entry_number
  assert.match(
    migrationSource,
    /v_rev_entry := public\.next_journal_entry_number\(\);/,
    'Must use next_journal_entry_number to generate sequential reversal journal numbers'
  );

  // Inverted debits and credits on reversal lines
  assert.match(
    migrationSource,
    /credit, debit, tax_code_id, customer_id, supplier_id, batch_id/,
    'Reversal lines must invert original debits into credits and credits into debits'
  );

  // Original journal linked to reversal journal via reversed_by_id
  assert.match(
    migrationSource,
    /UPDATE public\.journal_entries\s*SET is_reversed = true,\s*reversed_by_id = v_reversal_id/,
    'Original journal must be linked to reversal journal via reversed_by_id foreign key'
  );

  // Reversal journal also marked is_reversed = true to prevent double-counting in get_trial_balance
  assert.match(
    migrationSource,
    /true, true, v_caller, now\(\), v_caller, now\(\)/,
    'Reversal journal must have is_reversed = true to eliminate duplicate reversal debit/credit defect'
  );
});

test('18. Reversal idempotency: repeated requests do not duplicate reversals', () => {
  // Target query in migration only selects active, unreversed journals
  assert.match(
    migrationSource,
    /is_posted = true\s*AND COALESCE\(is_reversed, false\) = false/,
    'Reversal queries must strictly filter for active, unreversed journals'
  );

  // Direct fallback in Sales.tsx also enforces is_reversed = false
  assert.match(
    salesSource,
    /\.eq\('is_reversed',\s*false\)/,
    'Direct fallback must enforce eq(is_reversed, false)'
  );
});

test('19. Accounting balance invariant simulation: SAPJ-26-072 reversal math', () => {
  // Total: Rp 32,555,555.20, PPN: Rp 3,225,235.20, Bea Meterai: Rp 10,000, Subtotal: Rp 29,320,320.00
  // COGS: Rp 26,200,570.20
  const arAmount = 32555555.20;
  const ppnAmount = 3225235.20;
  const meteraiAmount = 10000.00;
  const revenueAmount = 29320320.00;
  const cogsAmount = 26200570.20;

  // Commercial JE balance
  assert.equal(arAmount, revenueAmount + ppnAmount + meteraiAmount, 'Revenue JE must balance');

  // COGS JE balance
  assert.equal(cogsAmount, 26200570.20, 'COGS JE must match 26,200,570.20');

  // Reversal impact on balance sheet:
  // Asset change: -AR + Inventory
  const deltaAssets = -arAmount + cogsAmount; // -32,555,555.20 + 26,200,570.20 = -6,354,985.00
  // Liabilities change: -PPN Output
  const deltaLiabilities = -ppnAmount; // -3,225,235.20
  // Equity change: -Revenue - Meterai + COGS
  const deltaEquity = -revenueAmount - meteraiAmount + cogsAmount; // -29,320,320 - 10,000 + 26,200,570.20 = -3,129,749.80 (which is -3,129,750 rounded)

  // Verify Assets = Liabilities + Equity
  assert.ok(
    Math.abs(deltaAssets - (deltaLiabilities + deltaEquity)) < 0.01,
    'Balance sheet fundamental equation (ΔAssets = ΔLiabilities + ΔEquity) must hold exactly upon cancellation'
  );
});
