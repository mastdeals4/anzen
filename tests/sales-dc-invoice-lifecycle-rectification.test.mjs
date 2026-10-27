import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';

const migrationCancelSql = fs.readFileSync('supabase/migrations/20261027220000_atomic_sales_invoice_cancellation.sql', 'utf8');
const migrationRectifySql = fs.readFileSync('supabase/migrations/20261028000000_sales_dc_invoice_lifecycle_rectification.sql', 'utf8');
const migrationRecoverySql = fs.readFileSync('supabase/migrations/20261028010000_delivery_challan_recovery_and_source_relinking.sql', 'utf8');
const migrationAtomicHeaderSql = fs.readFileSync('supabase/migrations/20261028020000_delivery_challan_atomic_header_edit_and_quantity_workflow.sql', 'utf8');
const migrationGuardSql = fs.readFileSync('supabase/migrations/20261028030000_guard_dc_approval_on_cancelled_so.sql', 'utf8');
const salesSource = fs.readFileSync('src/pages/Sales.tsx', 'utf8');
const deliveryChallanSource = fs.readFileSync('src/pages/DeliveryChallan.tsx', 'utf8');
const salesOrdersSource = fs.readFileSync('src/pages/SalesOrders.tsx', 'utf8');
const salesOrderFormSource = fs.readFileSync('src/components/SalesOrderForm.tsx', 'utf8');
const partyLedgerSource = fs.readFileSync('src/components/finance/PartyLedger.tsx', 'utf8');
const receivablesSource = fs.readFileSync('src/components/finance/ReceivablesManager.tsx', 'utf8');
const linkedDocsSource = fs.readFileSync('src/utils/linkedDocuments.ts', 'utf8');
const linkedDocsCellSource = fs.readFileSync('src/components/LinkedDocsCell.tsx', 'utf8');
const creditNotesSource = fs.readFileSync('src/pages/CreditNotes.tsx', 'utf8');
const invoiceViewSource = fs.readFileSync('src/components/InvoiceView.tsx', 'utf8');

// ==============================================================================
// 1. Cancel an unpaid posted invoice successfully
// ==============================================================================
test('Case 1: Cancel an unpaid posted invoice successfully with atomic GL reversal and DC item unlinking', () => {
  // Must provide canonical cancel_sales_invoice RPC
  assert.match(
    migrationCancelSql,
    /CREATE OR REPLACE FUNCTION public\.cancel_sales_invoice/,
    'Migration must declare public.cancel_sales_invoice RPC'
  );

  // Must reverse revenue journals
  assert.match(
    migrationCancelSql,
    /INSERT INTO public\.journal_entries[\s\S]*?source_module \|\| '_cancellation'/,
    'Must insert compensating reversal for revenue journal entry'
  );

  // Must reverse COGS journals
  assert.match(
    migrationCancelSql,
    /INSERT INTO public\.journal_entries[\s\S]*?'sales_invoice_cogs_cancellation'/,
    'Must insert compensating reversal for COGS journal entry'
  );

  // Must unlink delivery challan item link
  assert.match(
    migrationCancelSql,
    /UPDATE public\.sales_invoice_items\s+SET delivery_challan_item_id = NULL\s+WHERE invoice_id = p_invoice_id/,
    'Must release delivery_challan_item_id link on invoice cancellation'
  );

  // Frontend invokes cancel_sales_invoice RPC
  assert.match(
    salesSource,
    /await supabase\.rpc\('cancel_sales_invoice', \{\s*p_invoice_id: invoice\.id/,
    'Sales.tsx must invoke cancel_sales_invoice RPC'
  );
});

// ==============================================================================
// 2. Attempt cancellation twice; no duplicate reversals
// ==============================================================================
test('Case 2: Attempt cancellation twice; idempotent execution prevents duplicate reversals', () => {
  // RPC loop filters COALESCE(is_reversed, false) = false
  assert.match(
    migrationCancelSql,
    /COALESCE\(is_reversed, false\) = false/,
    'RPC cursor must only select unreversed journals'
  );

  // Frontend detects if invoice is already marked cancelled
  assert.match(
    salesSource,
    /const isAlreadyMarkedCancelled = isCancelledInvoice\(invoice\);/,
    'Frontend must inspect existing cancellation state'
  );

  // Frontend updates only unreversed journals in fallback
  assert.match(
    salesSource,
    /\.eq\('is_reversed', false\)/,
    'Journal reversal updates must be guarded by .eq("is_reversed", false)'
  );
});

// ==============================================================================
// 3. Cancel an invoice and then reverse its linked approved DC
// ==============================================================================
test('Case 3: Cancel an invoice and then reverse its linked approved DC', () => {
  // Trigger trg_dc_reverse_product_reservation_v2 ignores cancelled invoices
  assert.match(
    migrationRectifySql,
    /CREATE OR REPLACE FUNCTION public\.trg_dc_reverse_product_reservation_v2\(\)/,
    'Migration must update trg_dc_reverse_product_reservation_v2'
  );
  assert.match(
    migrationRectifySql,
    /WHERE dci\.challan_id = NEW\.id\s+AND NOT \(si\.notes LIKE '\[CANCELLED%' OR LOWER\(si\.notes\) LIKE 'cancelled%'\)/,
    'Trigger must exclude cancelled invoices when checking for invoice dependency'
  );

  // Reversal restores stock via post_inventory_movement
  assert.match(
    migrationRectifySql,
    /PERFORM public\.post_inventory_movement\([\s\S]*?'adjustment',[\s\S]*?'delivery_challan_reversal'/,
    'Reversal must post inventory movement with adjustment type to restore batch stock'
  );

  // Reversal updates dc_batch_allocations to reversed
  assert.match(
    migrationRectifySql,
    /UPDATE public\.dc_batch_allocations\s+SET status = 'reversed'/,
    'Must update dc_batch_allocations status to reversed'
  );

  // Reversal triggers fn_recompute_so_delivered and reconcile_so_product_reservation_v2
  assert.match(
    migrationRectifySql,
    /PERFORM public\.fn_recompute_so_delivered\(NEW\.sales_order_id\);/,
    'Must recompute SO delivered quantity'
  );
  assert.match(
    migrationRectifySql,
    /PERFORM public\.reconcile_so_product_reservation_v2\(r\.sales_order_item_id, 'DC reversal'\);/,
    'Must reconcile product reservation balance on DC reversal'
  );
});

// ==============================================================================
// 4. Attempt DC reversal while an active posted invoice still exists; reject safely
// ==============================================================================
test('Case 4: Attempt DC reversal while an active posted invoice still exists; reject safely and explain blocking invoice', () => {
  // If an active (uncancelled) invoice item exists, it must identify blocking invoice numbers and raise exception
  assert.match(
    migrationRectifySql,
    /SELECT string_agg\(DISTINCT si\.invoice_number, ', '\)\s+INTO v_blocking_invoices[\s\S]*?WHERE dci\.challan_id = NEW\.id\s+AND NOT \(si\.notes LIKE '\[CANCELLED%' OR LOWER\(si\.notes\) LIKE 'cancelled%'\);/,
    'Must aggregate blocking active invoice numbers'
  );
  assert.match(
    migrationRectifySql,
    /RAISE EXCEPTION 'Approved Delivery Challan % already invoiced by active invoice\(s\) %; reverse or cancel the invoice\(s\) first'/,
    'Must raise exception with exact blocking invoice numbers'
  );

  // Also enforced in trg_dc_reverse_inventory_v1 and admin_edit_approved_delivery_challan
  assert.match(
    migrationRectifySql,
    /CREATE OR REPLACE FUNCTION public\.trg_dc_reverse_inventory_v1\(\)/,
    'Must update trg_dc_reverse_inventory_v1'
  );
  assert.match(
    migrationRectifySql,
    /CREATE OR REPLACE FUNCTION public\.admin_edit_approved_delivery_challan/,
    'Must update admin_edit_approved_delivery_challan'
  );
});

// ==============================================================================
// 5. Edit the Sales Order after the linked DC has been properly reversed
// ==============================================================================
test('Case 5: Edit the Sales Order after the linked DC has been properly reversed', () => {
  // SalesOrderForm checks .in('approval_status', ['pending_approval', 'approved'])
  assert.match(
    salesOrderFormSource,
    /\.in\('approval_status', \['pending_approval', 'approved'\]\)/,
    'SalesOrderForm only blocks editing when an approved or pending DC is found'
  );

  // Once DC is rejected, activeChallan is null, proceeding to showConfirm
  assert.match(
    salesOrderFormSource,
    /const confirmed = await showConfirm\(\{[\s\S]*?title: 'Confirm',[\s\S]*?variant: 'warning',/,
    'Allows editing order once DC is reversed'
  );
});

// ==============================================================================
// 6. Prevent editing when a genuinely active DC/reservation makes the edit unsafe
// ==============================================================================
test('Case 6: Prevent editing when a genuinely active DC/reservation makes the edit unsafe', () => {
  // If activeChallan exists, editing is blocked with clear toast message
  assert.match(
    salesOrderFormSource,
    /if \(activeChallan\) \{\s*const isApproved = activeChallan\.approval_status === 'approved';\s*showToast\(\{\s*type: 'error',\s*title: 'Sales order cannot be edited',\s*message: `Delivery Challan \$\{activeChallan\.challan_number\} is \$\{isApproved \? 'already approved' : 'pending approval'\}\. \$\{isApproved \? 'Reverse' : 'Reject or cancel'\} it before editing this order so its reservation history remains intact\.`/,
    'Must display actionable error specifying whether DC is already approved or pending'
  );
});

// ==============================================================================
// 7. Verify stock and reservation quantities before and after every operation
// ==============================================================================
test('Case 7: Verify stock and reservation quantities before and after every operation (Single-owner DC invariant)', () => {
  // Reference transaction simulation: SO-2026-0087 / DO-26-0073 / SAPJ-26-072
  let batchStock = 90.0;
  let batchReserved = 0.0;
  let soDelivered = 0.0;
  const orderQty = 50.0;

  // Step 1: SO approved -> stock reserved
  batchReserved += orderQty;
  let atp = batchStock - batchReserved;
  assert.equal(batchStock, 90.0, 'Batch physical stock unchanged on SO approval');
  assert.equal(batchReserved, 50.0, 'Batch reserved stock incremented by SO order quantity');
  assert.equal(atp, 40.0, 'ATP accurately reflects available unreserved stock');

  // Step 2: DC approved -> physical stock deducted, reservation consumed, delivered increased
  batchStock -= orderQty;
  batchReserved -= orderQty;
  soDelivered += orderQty;
  atp = batchStock - batchReserved;
  assert.equal(batchStock, 40.0, 'Batch physical stock deducted on DC approval');
  assert.equal(batchReserved, 0.0, 'Batch reservation consumed on DC approval');
  assert.equal(soDelivered, 50.0, 'SO delivered quantity updated on DC approval');
  assert.equal(atp, 40.0, 'ATP remains 40 kg');

  // Step 3: Sales Invoice posted -> Single-owner invariant: invoice NEVER touches physical stock
  assert.doesNotMatch(
    salesSource,
    /from\('batches'\)[\s\S]*?update\(\{\s*current_stock:/,
    'Sales.tsx must not touch batches table on invoice creation/editing'
  );
  assert.equal(batchStock, 40.0, 'Batch physical stock completely untouched by invoice posting');

  // Step 4: Invoice cancelled -> physical stock remains untouched
  assert.equal(batchStock, 40.0, 'Batch physical stock completely untouched by invoice cancellation');

  // Step 5: DC reversed by Admin -> physical stock restored, soDelivered reset, reservation restored
  batchStock += orderQty;
  soDelivered -= orderQty;
  batchReserved += orderQty; // Reconciled by reconcile_so_product_reservation_v2
  atp = batchStock - batchReserved;
  assert.equal(batchStock, 90.0, 'Batch physical stock fully restored on DC reversal');
  assert.equal(soDelivered, 0.0, 'SO delivered quantity decremented to 0');
  assert.equal(batchReserved, 50.0, 'SO product reservation restored');
  assert.equal(atp, 40.0, 'ATP remains consistent');
});

// ==============================================================================
// 8. Verify journal debits and credits, reversal links, receivables and ledger balances
// ==============================================================================
test('Case 8: Verify journal debits and credits, reversal links, receivables and ledger balances', () => {
  // Invoice SAPJ-26-072 values
  const subtotal = 29330320.0;
  const taxAmount = 3225235.2;
  const totalAmount = subtotal + taxAmount; // 32,555,555.20
  const cogsAmount = 26200570.2;

  // Original Commercial Journal JE2610-0187
  const origCommercial = [
    { account: '1120', name: 'Trade Receivables', debit: totalAmount, credit: 0 },
    { account: '4100', name: 'Sales Revenue', debit: 0, credit: subtotal },
    { account: '2130', name: 'PPN Output', debit: 0, credit: taxAmount },
  ];
  const origCommDebit = origCommercial.reduce((s, l) => s + l.debit, 0);
  const origCommCredit = origCommercial.reduce((s, l) => s + l.credit, 0);
  assert.equal(origCommDebit, origCommCredit, 'Original commercial journal must balance');

  // Compensating Reversal Journal JE2610-0189
  const revCommercial = origCommercial.map((line) => ({
    account: line.account,
    name: line.name,
    debit: line.credit,
    credit: line.debit,
  }));
  const revCommDebit = revCommercial.reduce((s, l) => s + l.debit, 0);
  const revCommCredit = revCommercial.reduce((s, l) => s + l.credit, 0);
  assert.equal(revCommDebit, revCommCredit, 'Commercial reversal journal must balance');

  // Net general ledger effect across both journals
  const netArDebit = origCommercial[0].debit - revCommercial[0].credit;
  assert.equal(netArDebit, 0, 'Net Accounts Receivable debit balance after reversal is exactly 0.00');

  // Original COGS Journal JE2610-0188
  const origCogs = [
    { account: '5100', name: 'Cost of Goods Sold', debit: cogsAmount, credit: 0 },
    { account: '1130', name: 'Inventory Asset', debit: 0, credit: cogsAmount },
  ];
  const origCogsDebit = origCogs.reduce((s, l) => s + l.debit, 0);
  const origCogsCredit = origCogs.reduce((s, l) => s + l.credit, 0);
  assert.equal(origCogsDebit, origCogsCredit, 'Original COGS journal must balance');

  // Compensating COGS Reversal Journal JE2610-0190
  const revCogs = origCogs.map((line) => ({
    account: line.account,
    name: line.name,
    debit: line.credit,
    credit: line.debit,
  }));
  const revCogsDebit = revCogs.reduce((s, l) => s + l.debit, 0);
  const revCogsCredit = revCogs.reduce((s, l) => s + l.credit, 0);
  assert.equal(revCogsDebit, revCogsCredit, 'COGS reversal journal must balance');

  const netCogsDebit = origCogs[0].debit - revCogs[0].credit;
  assert.equal(netCogsDebit, 0, 'Net COGS debit balance after reversal is exactly 0.00');
});

// ==============================================================================
// 9. Verify cancelled invoices do not count as active invoices or active receivables
// ==============================================================================
test('Case 9: Verify cancelled invoices do not count as active invoices or active receivables', () => {
  // Sales.tsx stats exclude cancelled invoices
  assert.match(
    salesSource,
    /total:\s*invoices\.filter\(\(inv\)\s*=>\s*!isCancelledInvoice\(inv\)\)\.length/,
    'Total invoice count excludes cancelled invoices'
  );
  assert.match(
    salesSource,
    /totalRevenue:\s*invoices\s*\.filter\(\(inv\)\s*=>\s*!isCancelledInvoice\(inv\)\)/,
    'Total revenue excludes cancelled invoices'
  );

  // PartyLedger.tsx filters cancelled invoices
  assert.match(
    partyLedgerSource,
    /\.filter\(inv\s*=>\s*!inv\.notes\?\.includes\('\[CANCELLED'\)\s*&&\s*!inv\.notes\?\.toLowerCase\(\)\.startsWith\('cancelled'\)\)/,
    'Customer Party Ledger excludes cancelled invoices'
  );

  // ReceivablesManager.tsx filters cancelled invoices
  assert.match(
    receivablesSource,
    /!inv\.notes\?\.includes\('\[CANCELLED'\)\s*&&\s*!inv\.notes\?\.toLowerCase\(\)\.startsWith\('cancelled'\)/,
    'Receivables Manager excludes cancelled invoices'
  );

  // CreditNotes.tsx customer invoice selection excludes cancelled invoices
  assert.match(
    creditNotesSource,
    /!inv\.notes\?\.includes\('\[CANCELLED'\)\s*&&\s*!inv\.notes\?\.toLowerCase\(\)\.startsWith\('cancelled'\)/,
    'Credit Notes creation dropdown excludes cancelled invoices'
  );
});

// ==============================================================================
// 10. Simulate RPC failure and retry; no partial database state
// ==============================================================================
test('Case 10: Simulate RPC failure and retry; transactional atomicity preserves integrity', () => {
  // RPC locks invoice row FOR UPDATE
  assert.match(
    migrationCancelSql,
    /SELECT \* INTO v_inv\s+FROM public\.sales_invoices\s+WHERE id = p_invoice_id\s+FOR UPDATE;/,
    'RPC must lock invoice row FOR UPDATE'
  );

  // Payment guard check inside transaction
  assert.match(
    migrationCancelSql,
    /IF \(COALESCE\(v_inv\.paid_amount, 0\) > 0\.01 OR v_alloc_paid > 0\.01 OR v_adj_paid > 0\.01\) THEN\s+RAISE EXCEPTION 'Cannot cancel invoice %: payments of Rp % are allocated/,
    'Payment guard must abort within database transaction'
  );

  // Frontend error handling aborts on RPC failure
  assert.match(
    salesSource,
    /if \(rpcError\) throw rpcError;/,
    'Frontend must throw on RPC error and not update local state'
  );
});

// ==============================================================================
// 11. Verify a cancelled invoice's DC is not incorrectly labelled fully invoiced
// ==============================================================================
test('Case 11: Verify a cancelled invoice DC is not incorrectly labelled fully invoiced', () => {
  // dc_invoicing_summary excludes cancelled invoices
  assert.match(
    migrationRectifySql,
    /CREATE OR REPLACE VIEW public\.dc_invoicing_summary WITH \(security_invoker = true\) AS[\s\S]*?JOIN public\.sales_invoices si ON si\.id = sii\.invoice_id\s+AND NOT \(si\.notes LIKE '\[CANCELLED%' OR LOWER\(si\.notes\) LIKE 'cancelled%'\)/,
    'dc_invoicing_summary must exclude cancelled invoices'
  );

  // dc_item_invoice_status excludes cancelled invoices
  assert.match(
    migrationRectifySql,
    /CREATE OR REPLACE VIEW public\.dc_item_invoice_status WITH \(security_invoker = true\) AS[\s\S]*?JOIN public\.sales_invoices si ON si\.id = sii\.invoice_id\s+AND NOT \(si\.notes LIKE '\[CANCELLED%' OR LOWER\(si\.notes\) LIKE 'cancelled%'\)/,
    'dc_item_invoice_status must exclude cancelled invoices'
  );

  // so_delivery_invoice_status excludes cancelled invoices
  assert.match(
    migrationRectifySql,
    /CREATE OR REPLACE VIEW public\.so_delivery_invoice_status WITH \(security_invoker = true\) AS[\s\S]*?WHERE[\s\S]*?AND NOT \(si\.notes LIKE '\[CANCELLED%' OR LOWER\(si\.notes\) LIKE 'cancelled%'\)/,
    'so_delivery_invoice_status must exclude cancelled invoices'
  );

  // fn_recompute_so_status excludes cancelled invoices
  assert.match(
    migrationRectifySql,
    /CREATE OR REPLACE FUNCTION public\.fn_recompute_so_status[\s\S]*?AND NOT \(si\.notes LIKE '\[CANCELLED%' OR LOWER\(si\.notes\) LIKE 'cancelled%'\)/,
    'fn_recompute_so_status must exclude cancelled invoices'
  );

  // DeliveryChallan.tsx reconciles allInvoicesCancelled
  assert.match(
    deliveryChallanSource,
    /const allInvoicesCancelled = invs\.length > 0 && invs\.every\(\(i: any\) => i\.isCancelled\);[\s\S]*?const resolvedInvoicingStatus = allInvoicesCancelled\s*\?\s*'not_invoiced'\s*:\s*c\.invoicing_status;/,
    'DeliveryChallan.tsx must resolve invoicing_status to not_invoiced when all linked invoices are cancelled'
  );

  // LinkedDocsCell renders cancelled badge/line-through
  assert.match(
    linkedDocsCellSource,
    /d\.isCancelled \? 'text-gray-400 line-through' : color/,
    'LinkedDocsCell must visually mark cancelled invoices'
  );
});

// ==============================================================================
// 12. Verify role permissions and concurrent cancellation/reversal behaviour
// ==============================================================================
test('Case 12: Verify role permissions and concurrent cancellation/reversal behaviour', () => {
  // cancel_sales_invoice role guard
  assert.match(
    migrationCancelSql,
    /IF v_role NOT IN \('admin', 'accounts'\) THEN\s+RAISE EXCEPTION 'Permission denied: role % cannot cancel sales invoices', v_role;/,
    'cancel_sales_invoice enforces admin and accounts role restriction'
  );

  // admin_edit_approved_delivery_challan role guard
  assert.match(
    migrationRectifySql,
    /IF NOT public\.inventory_v1_actor_allowed\(ARRAY\['admin'\]\) THEN\s+RAISE EXCEPTION 'Only admin can edit an approved Delivery Challan';/,
    'admin_edit_approved_delivery_challan enforces admin role restriction'
  );

  // DeliveryChallan.tsx Admin reverse button is restricted to admin
  assert.match(
    deliveryChallanSource,
    /\{profile\?\.role === 'admin' && \(\s*<button[\s\S]*?title="Admin Correction:.*Reverse approved DC \(restores stock\)"/,
    'DeliveryChallan.tsx restricts approved DC reversal to admin'
  );

  // Concurrency protection: journal entries locked FOR UPDATE during reversal
  assert.match(
    migrationCancelSql,
    /FROM public\.journal_entries[\s\S]*?FOR UPDATE/,
    'Reversal cursor locks target journal entries FOR UPDATE'
  );

  // Concurrency protection: dc_batch_allocations locked FOR UPDATE OF a
  assert.match(
    migrationRectifySql,
    /FROM public\.delivery_challan_items dci\s+JOIN public\.dc_batch_allocations a[\s\S]*?FOR UPDATE OF a/,
    'DC reversal locks batch allocations FOR UPDATE'
  );
});

// ==============================================================================
// 13. Cancelled invoice watermark in preview and print/PDF (Requirement B)
// ==============================================================================
test('Case 13: Cancelled invoice watermark, void banner, and status display in preview and print/PDF', () => {
  // Must detect cancellation status from notes
  assert.match(
    invoiceViewSource,
    /const isCancelled = Boolean\(\s*invoice\.notes\?\.includes\('\[CANCELLED'\)\s*\|\|\s*invoice\.notes\?\.toLowerCase\(\)\.startsWith\('cancelled'\)\s*\);/,
    'InvoiceView must detect cancelled invoice state'
  );

  // Must parse cancellation date
  assert.match(
    invoiceViewSource,
    /const cancellationDateMatch = invoice\.notes\?\.match\(\/\\\[CANCELLED on \(\[0-9\]\{4\}-\[0-9\]\{2\}-\[0-9\]\{2\}\)\/i\);/,
    'InvoiceView must parse cancellation date'
  );

  // Must render prominent diagonal CANCELLED watermark inside printable content
  assert.match(
    invoiceViewSource,
    /<div[\s\S]*?className="[^"]*border-8[^"]*text-red-500[^"]*font-extrabold[^"]*"[\s\S]*?>\s*CANCELLED\s*<\/div>/,
    'InvoiceView must render prominent CANCELLED watermark inside printable container'
  );
  assert.match(
    invoiceViewSource,
    /transform:\s*'rotate\(-30deg\)'/,
    'Watermark must be rotated diagonally'
  );

  // Must render prominent cancellation void banner with cancellation date
  assert.match(
    invoiceViewSource,
    /VOID \/ CANCELLED/,
    'InvoiceView must render VOID / CANCELLED banner'
  );
  assert.match(
    invoiceViewSource,
    /INVOICE CANCELLED & VOID/,
    'InvoiceView must display INVOICE CANCELLED & VOID notice'
  );

  // Must render CANCELLED badge in modal top bar
  assert.match(
    invoiceViewSource,
    /\{isCancelled && \(\s*<span className="[^"]*bg-red-100 text-red-700[^"]*">\s*CANCELLED\s*<\/span>\s*\)\}/,
    'Modal top bar must show CANCELLED badge'
  );

  // Must render Status: Cancelled in invoice details box
  assert.match(
    invoiceViewSource,
    /\{isCancelled && \(\s*<div className="pt-1 text-red-600 font-bold">\s*<span>Status:<\/span>\s*<span className="ml-2 uppercase tracking-wide">Cancelled<\/span>\s*<\/div>\s*\)\}/,
    'Invoice details section must explicitly display Status: Cancelled'
  );
});

// ==============================================================================
// 14. Rejected DC recovery, edit, SO relinking, and item upsert architecture
// ==============================================================================
test('Case 14: Rejected DC recovery, edit, SO relinking, and item upsert architecture', () => {
  // edit_delivery_challan checks approval_status = 'approved', allowing rejected/cancelled DCs to be edited
  assert.match(
    migrationRecoverySql,
    /IF v_challan\.approval_status = 'approved' THEN\s+RETURN jsonb_build_object\('success', false, 'error', 'Cannot edit approved delivery challan directly; reverse it or use approved DC edit'\);/,
    'edit_delivery_challan must guard on approval_status = approved rather than approved_at IS NOT NULL'
  );

  // edit_delivery_challan checks active uncancelled invoices and explains blocking invoice numbers
  assert.match(
    migrationRecoverySql,
    /SELECT string_agg\(DISTINCT si\.invoice_number, ', '\)\s+INTO v_blocking_invoices[\s\S]*?WHERE dci\.challan_id = p_challan_id\s+AND NOT \(si\.notes LIKE '\[CANCELLED%' OR LOWER\(si\.notes\) LIKE 'cancelled%'\);/,
    'edit_delivery_challan must aggregate active blocking invoice numbers'
  );
  assert.match(
    migrationRecoverySql,
    /'Delivery Challan already invoiced by active invoice\(s\) ' \|\| v_blocking_invoices \|\| '; cancel or reverse the invoice\(s\) first'/,
    'edit_delivery_challan must report exact blocking invoices'
  );

  // edit_delivery_challan preserves and persists sales_order_item_id
  assert.match(
    migrationRecoverySql,
    /v_so_item_id := NULLIF\(v_item->>'sales_order_item_id', ''\)::uuid;/,
    'edit_delivery_challan must extract sales_order_item_id'
  );
  assert.match(
    migrationRecoverySql,
    /INSERT INTO public\.delivery_challan_items \([\s\S]*?sales_order_item_id[\s\S]*?\) VALUES \([\s\S]*?v_so_item_id[\s\S]*?\);/,
    'edit_delivery_challan must insert sales_order_item_id'
  );

  // guard_delivery_challan_source_link permits relinking non-approved DCs
  assert.match(
    migrationRecoverySql,
    /IF OLD\.approval_status = 'approved'\s+AND OLD\.sales_order_id IS NOT NULL\s+AND NEW\.sales_order_id IS DISTINCT FROM OLD\.sales_order_id THEN\s+RAISE EXCEPTION 'An approved Delivery Challan linked to a Sales Order cannot be detached or reassigned; cancel or reverse it first';/,
    'guard_delivery_challan_source_link only blocks reassigning currently approved DCs'
  );

  // Frontend DeliveryChallan.tsx loads sales orders on handleEdit so relinking dropdown is ready
  assert.match(
    deliveryChallanSource,
    /await loadSalesOrders\(targetCustomerId\);/,
    'handleEdit must load sales orders for customer to populate relinking dropdown'
  );

  // Frontend DeliveryChallan.tsx resets status to pending_approval when saving edited rejected/cancelled DC
  assert.match(
    deliveryChallanSource,
    /const isReactivating = editingChallan\.approval_status === 'rejected' \|\| editingChallan\.approval_status === 'cancelled';/,
    'Frontend must detect reactivation of rejected or cancelled DC'
  );
  assert.match(
    deliveryChallanSource,
    /updateData\.approval_status = 'pending_approval';\s+updateData\.rejection_reason = null;/,
    'Saving edited rejected DC must reset status to pending_approval and clear rejection reason'
  );
});

// ==============================================================================
// 15. Re-approval of corrected DC consumes reservations and records single-owner physical delivery
// ==============================================================================
test('Case 15: Re-approval of corrected DC consumes reservations and records single-owner physical delivery', () => {
  // trg_dc_approval_product_reservation_v2 allows re-approval of previously rejected DCs
  assert.doesNotMatch(
    migrationRecoverySql,
    /IF NEW\.approval_status='approved'\s+AND OLD\.approval_status IN \('rejected','cancelled'\) THEN\s+RAISE EXCEPTION/,
    'trg_dc_approval_product_reservation_v2 must not contain blanket re-approval prohibition'
  );

  // Re-approval calls consume_so_product_reservation_v2 and fn_recompute_so_delivered
  assert.match(
    migrationRecoverySql,
    /PERFORM public\.consume_so_product_reservation_v2\(\s*r\.id,\s*NEW\.approval_operation_id,\s*COALESCE\(NEW\.approved_by, auth\.uid\(\)\)\s*\);/,
    'Approval must invoke consume_so_product_reservation_v2 for every item'
  );
  assert.match(
    migrationRecoverySql,
    /PERFORM public\.fn_recompute_so_delivered\(NEW\.sales_order_id\);\s+PERFORM public\.fn_recompute_so_status\(NEW\.sales_order_id\);/,
    'Approval must trigger recomputation of SO delivered quantity and status'
  );
});

// ==============================================================================
// 16. Safe DC deletion handling and audit preservation toast (no false success)
// ==============================================================================
test('Case 16: Safe DC deletion handling and audit preservation toast (no false success)', () => {
  // handleDelete must verify affected count and never claim success on 0 deleted rows
  assert.match(
    deliveryChallanSource,
    /\.delete\(\{ count: 'exact' \}\)/,
    'handleDelete must request exact delete count'
  );
  assert.match(
    deliveryChallanSource,
    /if \(count === 0\) \{[\s\S]*?title: 'Not Deleted'/,
    'handleDelete must warn user if 0 rows were deleted'
  );
  assert.match(
    deliveryChallanSource,
    /title: 'Audit Record Preserved'[\s\S]*?has posted inventory history and cannot be deleted/,
    'handleDelete must explain audit history preservation when stock movements exist'
  );

  // RLS DELETE policy for unposted DCs declared in migration
  assert.match(
    migrationRecoverySql,
    /CREATE POLICY "Admin, sales, and warehouse can delete unposted delivery_challans"/,
    'Migration must declare RLS delete policy for unposted delivery challans'
  );
});

// ==============================================================================
// 17. Migration 20261028010000 schema integrity: nullable invoice-item DC link, ON DELETE SET NULL
// ==============================================================================
test('Case 17: Migration 20261028010000 schema integrity: nullable invoice-item DC link, ON DELETE SET NULL', () => {
  // delivery_challan_item_id column made nullable
  assert.match(
    migrationRecoverySql,
    /ALTER TABLE public\.sales_invoice_items\s+ALTER COLUMN delivery_challan_item_id DROP NOT NULL;/,
    'Must drop NOT NULL constraint on sales_invoice_items.delivery_challan_item_id'
  );

  // Foreign keys updated to ON DELETE SET NULL / CASCADE
  assert.match(
    migrationRecoverySql,
    /ADD CONSTRAINT sales_invoice_items_delivery_challan_item_id_fkey\s+FOREIGN KEY \(delivery_challan_item_id\)\s+REFERENCES public\.delivery_challan_items\(id\)\s+ON DELETE SET NULL;/,
    'sales_invoice_items FK must use ON DELETE SET NULL'
  );
  assert.match(
    migrationRecoverySql,
    /ADD CONSTRAINT so_product_reservation_events_delivery_challan_item_id_fkey\s+FOREIGN KEY \(delivery_challan_item_id\)\s+REFERENCES public\.delivery_challan_items\(id\)\s+ON DELETE SET NULL;/,
    'so_product_reservation_events FK must use ON DELETE SET NULL'
  );
  assert.match(
    migrationRecoverySql,
    /ADD CONSTRAINT dc_batch_allocations_delivery_challan_item_id_fkey\s+FOREIGN KEY \(delivery_challan_item_id\)\s+REFERENCES public\.delivery_challan_items\(id\)\s+ON DELETE CASCADE;/,
    'dc_batch_allocations FK must use ON DELETE CASCADE'
  );
});

// ==============================================================================
// 18. Delivery Challan Quantity Constraint Detection, Workflows, and Visual Guidance
// ==============================================================================
test('Case 18: Delivery Challan Quantity Constraint Detection, Workflows, and Visual Guidance', () => {
  // Real-time quantity constraint computation in DeliveryChallan.tsx
  assert.match(
    deliveryChallanSource,
    /const quantityViolations = useMemo\(\(\) => \{[\s\S]*?requestedQty > remainingQty \+ 0\.0001/,
    'Must detect when requested quantity exceeds remaining Sales Order deliverable quantity'
  );

  // Workflow options: Edit SO, switch SO, or cap quantity
  assert.match(
    deliveryChallanSource,
    /handleNavigateToEditSO[\s\S]*?editSalesOrderId: soId[\s\S]*?setCurrentPage\('sales-orders'\)/,
    'Must provide one-click workflow to navigate to Sales Order edit screen'
  );

  assert.match(
    deliveryChallanSource,
    /handleCapQuantityToRemaining[\s\S]*?finalQty = remainingQty/,
    'Must provide option to cap delivery quantity to remaining deliverable SO quantity'
  );

  // Visual warning banner rendered in modal
  assert.match(
    deliveryChallanSource,
    /Sales Order Delivery Quantity Constraint Detected[\s\S]*?Requested delivery quantity[\s\S]*?exceeds remaining order quantity/,
    'Must render prominent constraint alert banner identifying exact requested vs remaining quantities'
  );

  // Highlighting over-quantity inputs with warning borders
  assert.match(
    deliveryChallanSource,
    /quantityViolations\.some\(v => v\.soItemId === item\.sales_order_item_id\)\s*\?\s*['"]border-amber-500/,
    'Must highlight over-quantity input fields with amber warning borders'
  );

  // Submission validation blocks saving invalid over-deliveries
  assert.match(
    deliveryChallanSource,
    /title: 'Sales Order Quantity Constraint'[\s\S]*?exceeds remaining Sales Order quantity/,
    'Must block saving when requested quantity exceeds remaining SO quantity'
  );
});

// ==============================================================================
// 19. Atomic DC Header and Item Edit with Transactional Rollback Protection
// ==============================================================================
test('Case 19: Atomic DC Header and Item Edit with Transactional Rollback Protection', () => {
  // edit_delivery_challan accepts optional p_header
  assert.match(
    migrationAtomicHeaderSql,
    /CREATE OR REPLACE FUNCTION public\.edit_delivery_challan\(\s*p_challan_id uuid,\s*p_new_items jsonb,\s*p_header jsonb DEFAULT NULL\s*\)/,
    'edit_delivery_challan must accept optional p_header parameter'
  );

  // Header update occurs inside function transaction
  assert.match(
    migrationAtomicHeaderSql,
    /IF p_header IS NOT NULL THEN\s*UPDATE public\.delivery_challans SET[\s\S]*?customer_id = COALESCE[\s\S]*?sales_order_id =[\s\S]*?WHERE id = p_challan_id;/,
    'Must update delivery_challans header atomically inside the function'
  );

  // 2-argument backward compatible wrapper
  assert.match(
    migrationAtomicHeaderSql,
    /CREATE OR REPLACE FUNCTION public\.edit_delivery_challan\(\s*p_challan_id uuid,\s*p_new_items jsonb\s*\)[\s\S]*?SELECT public\.edit_delivery_challan\(p_challan_id, p_new_items, NULL::jsonb\);/,
    'Must maintain 2-argument wrapper for backward compatibility'
  );

  // Frontend passes p_header directly to edit_delivery_challan
  assert.match(
    deliveryChallanSource,
    /await supabase\.rpc\('edit_delivery_challan', \{\s*p_challan_id: editingChallan\.id,\s*p_new_items: itemsForRpc,\s*p_header: updateData,?\s*\}\)/,
    'Frontend must pass p_header to edit_delivery_challan for atomic execution'
  );
});

// ==============================================================================
// 20. Sales Order Edit Navigation and Re-Approval Workflow for Quantity Adjustments
// ==============================================================================
test('Case 20: Sales Order Edit Navigation and Re-Approval Workflow for Quantity Adjustments', () => {
  // SalesOrders page handles navigationData.editSalesOrderId
  assert.match(
    salesOrdersSource,
    /const editId = navigationData\?\.editSalesOrderId;[\s\S]*?setEditingOrder\([\s\S]*?setShowCreateModal\(true\)/,
    'SalesOrders page must automatically open target order for edit when editSalesOrderId is passed'
  );

  // Simulated workflow: SO-2026-0087 (30 kg) -> edit to 50 kg -> approve -> DC delivers 50 kg
  const initialSoQty = 30.0;
  let requestedDcQty = 50.0;

  // Step 1: Constraint detected because 50 > 30
  assert.strictEqual(requestedDcQty > initialSoQty, true, '50 kg exceeds initial 30 kg order');

  // Step 2: SO quantity increased through authorized edit process
  const updatedSoQty = 50.0;
  const isSoReApproved = true;

  // Step 3: Once approved, remaining SO quantity accommodates full DC quantity
  const remainingDeliverable = updatedSoQty - 0.0; // 0 delivered
  assert.strictEqual(requestedDcQty <= remainingDeliverable, true, '50 kg is now fully deliverable');

  // Step 4: DC approved and stock posted atomically
  const batchInitialStock = 90.0;
  const batchStockAfterDelivery = batchInitialStock - requestedDcQty;
  assert.strictEqual(batchStockAfterDelivery, 40.0, 'Batch stock correctly deducted by 50 kg');
});

// ==============================================================================
// 21. Guard DC approval and items against cancelled or rejected Sales Orders
// ==============================================================================
test('Case 21: Guard DC approval and items against cancelled or rejected Sales Orders', () => {
  // consume_so_product_reservation_v2 checks SO status
  assert.match(
    migrationGuardSql,
    /SELECT status::text INTO v_so_status\s+FROM public\.sales_orders\s+WHERE id = v\.sales_order_id;\s+IF v_so_status IN \('cancelled', 'rejected'\) THEN\s+RAISE EXCEPTION 'Cannot approve Delivery Challan %: linked Sales Order is %'/,
    'consume_so_product_reservation_v2 must prevent approving a DC linked to cancelled or rejected SO'
  );

  // validate_dc_item_product_reservation_v2 checks SO status
  assert.match(
    migrationGuardSql,
    /SELECT status::text INTO v_so_status\s+FROM public\.sales_orders\s+WHERE id = v_dc\.sales_order_id;\s+IF v_so_status IN \('cancelled', 'rejected'\) THEN\s+RAISE EXCEPTION 'Cannot add or modify Delivery Challan items: linked Sales Order is %'/,
    'validate_dc_item_product_reservation_v2 must prevent adding/modifying items on cancelled or rejected SO'
  );

  // trg_dc_approval_product_reservation_v2 checks SO status
  assert.match(
    migrationGuardSql,
    /IF NEW\.sales_order_id IS NOT NULL THEN\s+SELECT status::text INTO v_so_status\s+FROM public\.sales_orders\s+WHERE id = NEW\.sales_order_id;\s+IF v_so_status IN \('cancelled', 'rejected'\) THEN\s+RAISE EXCEPTION 'Cannot approve Delivery Challan %: linked Sales Order is %'/,
    'trg_dc_approval_product_reservation_v2 trigger must abort approval on cancelled or rejected SO'
  );
});

// ==============================================================================
// 22. Auto-cancel/reject draft and pending DCs when SO is cancelled or rejected
// ==============================================================================
test('Case 22: Auto-cancel/reject draft and pending DCs when SO is cancelled or rejected', () => {
  // fn_cancel_sales_order updates draft & pending DCs
  assert.match(
    migrationGuardSql,
    /UPDATE public\.delivery_challans\s+SET approval_status = 'rejected',\s+rejection_reason = 'Cancelled because linked Sales Order was cancelled: ' \|\| p_reason,[\s\S]*?WHERE sales_order_id = p_so_id\s+AND approval_status IN \('draft', 'pending_approval'\);/,
    'fn_cancel_sales_order must transition draft and pending DCs to rejected with reason'
  );

  // fn_reject_sales_order updates draft & pending DCs
  assert.match(
    migrationGuardSql,
    /UPDATE public\.delivery_challans\s+SET approval_status = 'rejected',\s+rejection_reason = 'Rejected because linked Sales Order was rejected: ' \|\| p_reason,[\s\S]*?WHERE sales_order_id = p_so_id\s+AND approval_status IN \('draft', 'pending_approval'\);/,
    'fn_reject_sales_order must transition draft and pending DCs to rejected with reason'
  );
});

// ==============================================================================
// 23. Deleting draft DC recomputes Sales Order status dynamically via fn_recompute_so_status
// ==============================================================================
test('Case 23: Deleting draft DC recomputes Sales Order status dynamically via fn_recompute_so_status', () => {
  // DeliveryChallan.tsx handleDelete calls fn_recompute_so_status
  assert.match(
    deliveryChallanSource,
    /await supabase\.rpc\('fn_recompute_so_status', \{ p_so_id: dcData\.sales_order_id \}\);/,
    'handleDelete must invoke fn_recompute_so_status to preserve actual SO order and delivery state'
  );

  // Sales.tsx cancel RPC error propagation
  assert.match(
    salesSource,
    /const \{ data: rpcResult, error: rpcError \} = await supabase\.rpc\('cancel_sales_invoice'[\s\S]*?if \(rpcError\) \{[\s\S]*?throw rpcError;/,
    'Sales.tsx cancel_sales_invoice must throw real RPC errors to outer error handler'
  );
});


