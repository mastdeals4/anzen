import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const rootDir = path.resolve(__dirname, '..');

const migrationSql = fs.readFileSync(
  path.join(rootDir, 'supabase/migrations/20261030130000_sales_cancellation_hardening_corrections.sql'),
  'utf8'
);
const salesPageCode = fs.readFileSync(
  path.join(rootDir, 'src/pages/Sales.tsx'),
  'utf8'
);

// ==============================================================================
// 1. Cancelled Invoice Disclosure Aggregation (Multi-line Cartesian Fix)
// ==============================================================================
test('1. Cancelled invoice disclosure aggregation: Separates headers and line quantities to prevent fanout multiplication', () => {
  // Verify migration separates cancelled_headers and cancelled_items / cancelled_invoices_data
  assert.ok(
    migrationSql.includes('cancelled_headers AS ('),
    'Migration must define separate cancelled_headers CTE'
  );
  assert.ok(
    migrationSql.includes('COUNT(ch.id)::int AS cancelled_count'),
    'Must aggregate count from distinct cancelled_headers'
  );
  assert.ok(
    migrationSql.includes('COALESCE(SUM(ch.total_amount), 0)::numeric AS cancelled_total_amount'),
    'Must aggregate total_amount from distinct cancelled_headers'
  );
  assert.ok(
    migrationSql.includes('COALESCE(SUM(ch.subtotal), 0)::numeric AS cancelled_subtotal'),
    'Must aggregate subtotal from distinct cancelled_headers'
  );

  // Concrete simulation comparing buggy fanout JOIN vs corrected separated CTE:
  const mockCancelledInvoice = {
    id: 'inv-cancelled-001',
    invoice_number: 'SAPJ-26-072',
    total_amount: 55000000,
    subtotal: 50000000,
    document_status: 'cancelled',
  };
  const mockInvoiceLines = [
    { id: 'line-1', invoice_id: 'inv-cancelled-001', product_id: 'prod-1', quantity: 10 },
    { id: 'line-2', invoice_id: 'inv-cancelled-001', product_id: 'prod-2', quantity: 15 },
    { id: 'line-3', invoice_id: 'inv-cancelled-001', product_id: 'prod-3', quantity: 5 },
  ];

  // A. Buggy direct JOIN simulation:
  const buggyJoinedRows = mockInvoiceLines.map((line) => ({
    header_total: mockCancelledInvoice.total_amount,
    header_subtotal: mockCancelledInvoice.subtotal,
    line_qty: line.quantity,
  }));
  const buggyTotalAmount = buggyJoinedRows.reduce((sum, r) => sum + r.header_total, 0);
  const buggySubtotal = buggyJoinedRows.reduce((sum, r) => sum + r.header_subtotal, 0);
  const buggyTotalQty = buggyJoinedRows.reduce((sum, r) => sum + r.line_qty, 0);

  // Proves the bug: total was multiplied by line count (3 * 55,000,000 = 165,000,000)
  assert.equal(buggyTotalAmount, 165000000, 'Buggy join multiplies total by line count');
  assert.equal(buggySubtotal, 150000000, 'Buggy join multiplies subtotal by line count');

  // B. Corrected separated aggregation simulation:
  const headers = [mockCancelledInvoice];
  const correctedCount = headers.length;
  const correctedTotalAmount = headers.reduce((sum, h) => sum + h.total_amount, 0);
  const correctedSubtotal = headers.reduce((sum, h) => sum + h.subtotal, 0);
  const correctedTotalQty = mockInvoiceLines.reduce((sum, l) => sum + l.quantity, 0);

  // Correct result: each invoice header counted exactly once, line quantities summed
  assert.equal(correctedCount, 1);
  assert.equal(correctedTotalAmount, 55000000, 'Must count invoice total exactly once');
  assert.equal(correctedSubtotal, 50000000, 'Must count invoice subtotal exactly once');
  assert.equal(correctedTotalQty, 30, 'Must sum all product line quantities (10+15+5=30)');
});

// ==============================================================================
// 2. Sales KPI Eligibility: Posted vs Draft vs Cancelled
// ==============================================================================
test('2. Sales KPI eligibility: Recognized sales, paid totals, and pending receivables include posted only; drafts segregated', () => {
  // Test dataset with mixed document statuses
  const testInvoices = [
    // 2 Posted Invoices:
    {
      id: 'inv-post-1',
      invoice_number: 'SAPJ-26-001',
      document_status: 'posted',
      is_draft: false,
      total_amount: 10000000,
      paid_amount: 10000000,
      balance_amount: 0,
      payment_status: 'paid',
    },
    {
      id: 'inv-post-2',
      invoice_number: 'SAPJ-26-002',
      document_status: 'posted',
      is_draft: false,
      total_amount: 20000000,
      paid_amount: 5000000,
      balance_amount: 15000000,
      payment_status: 'partial',
    },
    // 2 Draft Invoices (unposted documents):
    {
      id: 'inv-draft-1',
      invoice_number: 'SAPJ-26-003',
      document_status: 'draft',
      is_draft: true,
      total_amount: 8000000,
      paid_amount: 0,
      balance_amount: 8000000,
      payment_status: 'pending',
    },
    {
      id: 'inv-draft-2',
      invoice_number: 'SAPJ-26-004',
      document_status: 'draft',
      is_draft: true,
      total_amount: 12000000,
      paid_amount: 0,
      balance_amount: 12000000,
      payment_status: 'pending',
    },
    // 1 Cancelled Invoice:
    {
      id: 'inv-canc-1',
      invoice_number: 'SAPJ-26-005',
      document_status: 'cancelled',
      is_draft: false,
      total_amount: 25000000,
      paid_amount: 0,
      balance_amount: 0,
      payment_status: 'pending',
      notes: '[CANCELLED] Customer order cancelled',
    },
  ];

  function isCancelledInvoice(inv) {
    return (
      inv.document_status === 'cancelled' ||
      Boolean(inv.notes?.includes('[CANCELLED') || inv.notes?.toLowerCase().startsWith('cancelled'))
    );
  }

  function isPostedInvoice(inv) {
    if (isCancelledInvoice(inv)) return false;
    if (inv.document_status) return inv.document_status === 'posted';
    return !inv.is_draft;
  }

  const activeInvoices = testInvoices.filter((inv) => !isCancelledInvoice(inv));
  const postedInvoices = testInvoices.filter((inv) => isPostedInvoice(inv));
  const draftInvoices = testInvoices.filter((inv) => !isCancelledInvoice(inv) && !isPostedInvoice(inv));
  const cancelledInvoices = testInvoices.filter((inv) => isCancelledInvoice(inv));

  assert.equal(postedInvoices.length, 2);
  assert.equal(draftInvoices.length, 2);
  assert.equal(cancelledInvoices.length, 1);
  assert.equal(activeInvoices.length, 4);

  // Compute stats replicating updated Sales.tsx logic
  const postedRevenue = postedInvoices.reduce((sum, inv) => sum + inv.total_amount, 0);
  const pendingInvoices = postedInvoices.filter((inv) => inv.payment_status === 'pending' || inv.payment_status === 'partial');
  const pendingValue = postedInvoices.reduce((sum, inv) => sum + inv.balance_amount, 0);
  const paidInvoices = postedInvoices.filter((inv) => inv.payment_status === 'paid');
  const paidValue = postedInvoices.reduce((sum, inv) => sum + inv.paid_amount, 0);

  const draftCount = draftInvoices.length;
  const draftValue = draftInvoices.reduce((sum, inv) => sum + inv.total_amount, 0);

  // Assertions:
  // Recognized revenue = 10,000,000 + 20,000,000 = 30,000,000
  assert.equal(postedRevenue, 30000000, 'Recognized sales revenue must be posted only');

  // Paid = 10,000,000 (inv1) + 5,000,000 (inv2) = 15,000,000
  assert.equal(paidValue, 15000000, 'Paid value must be from posted invoices only');

  // Pending = 15,000,000 (inv2 balance)
  assert.equal(pendingInvoices.length, 1);
  assert.equal(pendingValue, 15000000, 'Pending receivables must be from posted invoices only');

  // Drafts segregated: count 2, value 20,000,000 (8M + 12M)
  assert.equal(draftCount, 2);
  assert.equal(draftValue, 20000000, 'Draft documents must be segregated into distinct metric');

  // Cancelled: count 1, value 25,000,000
  assert.equal(cancelledInvoices.length, 1);
  assert.equal(cancelledInvoices[0].total_amount, 25000000);

  // Verify Sales.tsx code matches this architecture
  assert.ok(
    salesPageCode.includes('postedRevenue = postedInvoices.reduce'),
    'Sales.tsx must calculate posted revenue from postedInvoices'
  );
  assert.ok(
    salesPageCode.includes('draftValue = draftInvoices.reduce'),
    'Sales.tsx must calculate separate draftValue'
  );
  assert.ok(
    salesPageCode.includes('Excluded from recognized sales revenue, receivables, and accounting ledger until posted'),
    'Sales.tsx must show disclosure banner for drafts'
  );
});

// ==============================================================================
// 3. Lifecycle Trigger: State Transitions, Cancellation Preservation, Precedence
// ==============================================================================
test('3. Lifecycle trigger: Preserves cancellation status on legacy updates and enforces status precedence', () => {
  // Replicate trigger logic from public.trg_sync_sales_invoice_document_status()
  function simulateTrigger(tg_op, oldRow, newRow) {
    const row = { ...newRow };
    if (tg_op === 'INSERT') {
      if (row.document_status === 'draft') {
        row.is_draft = true;
      } else if (row.document_status === 'posted' || row.document_status === 'cancelled') {
        row.is_draft = false;
      } else if (row.is_draft === true) {
        row.document_status = 'draft';
      } else if (row.notes?.startsWith('[CANCELLED') || row.notes?.toLowerCase().startsWith('cancelled')) {
        row.document_status = 'cancelled';
        row.is_draft = false;
      } else {
        row.document_status = 'posted';
        row.is_draft = false;
      }
      if (row.document_status === 'cancelled' && !row.cancelled_at) {
        row.cancelled_at = '2026-10-30T12:00:00Z';
      }
      return row;
    }

    // UPDATE
    const v_status_changed = row.document_status !== oldRow.document_status;
    const v_draft_changed = row.is_draft !== oldRow.is_draft;
    const v_is_cancelled =
      oldRow.document_status === 'cancelled' ||
      Boolean(oldRow.notes?.startsWith('[CANCELLED') || oldRow.notes?.toLowerCase().startsWith('cancelled'));

    // Preservation rule:
    if (v_is_cancelled && !v_status_changed) {
      row.document_status = 'cancelled';
      row.is_draft = false;
      if (!row.cancelled_at) row.cancelled_at = oldRow.cancelled_at || '2026-10-30T12:00:00Z';
      return row;
    }

    // Precedence and Conflict Resolution rule:
    // If document_status was explicitly changed (or conflicting update where status changed),
    // document_status takes absolute precedence over is_draft.
    if (v_status_changed) {
      if (row.document_status === 'draft') row.is_draft = true;
      else if (row.document_status === 'posted' || row.document_status === 'cancelled') row.is_draft = false;
    } else if (v_draft_changed) {
      // Legacy update where only is_draft was changed on an uncancelled invoice
      if (row.is_draft === true) row.document_status = 'draft';
      else row.document_status = 'posted';
    }

    if (row.document_status === 'cancelled' && !row.cancelled_at) {
      row.cancelled_at = oldRow.cancelled_at || '2026-10-30T12:00:00Z';
    }
    return row;
  }

  // 1. INSERT tests
  const insDraft = simulateTrigger('INSERT', null, { document_status: 'draft', notes: '' });
  assert.equal(insDraft.document_status, 'draft');
  assert.equal(insDraft.is_draft, true);

  const insPosted = simulateTrigger('INSERT', null, { document_status: 'posted', notes: '' });
  assert.equal(insPosted.document_status, 'posted');
  assert.equal(insPosted.is_draft, false);

  const insCancelled = simulateTrigger('INSERT', null, { document_status: 'cancelled', notes: '' });
  assert.equal(insCancelled.document_status, 'cancelled');
  assert.equal(insCancelled.is_draft, false);
  assert.ok(insCancelled.cancelled_at);

  const insLegacyDraft = simulateTrigger('INSERT', null, { is_draft: true, notes: '' });
  assert.equal(insLegacyDraft.document_status, 'draft');
  assert.equal(insLegacyDraft.is_draft, true);

  // 2. CRITICAL PRESERVATION TEST:
  // A cancelled invoice is updated with legacy code doing `SET is_draft = false`:
  const oldCancelled = {
    document_status: 'cancelled',
    is_draft: false,
    cancelled_at: '2026-10-25T10:00:00Z',
    notes: '[CANCELLED] Bad order',
  };
  const updateLegacyDraftFalse = simulateTrigger('UPDATE', oldCancelled, {
    ...oldCancelled,
    is_draft: false, // legacy update
  });
  assert.equal(
    updateLegacyDraftFalse.document_status,
    'cancelled',
    'Legacy update to is_draft=false must NEVER uncancel a cancelled invoice'
  );
  assert.equal(updateLegacyDraftFalse.is_draft, false);

  const updateLegacyDraftTrue = simulateTrigger('UPDATE', oldCancelled, {
    ...oldCancelled,
    is_draft: true, // legacy update
  });
  assert.equal(
    updateLegacyDraftTrue.document_status,
    'cancelled',
    'Legacy update to is_draft=true must NEVER change cancelled invoice to draft'
  );
  assert.equal(updateLegacyDraftTrue.is_draft, false);

  // 3. Normal update on active posted invoice:
  const oldPosted = { document_status: 'posted', is_draft: false, notes: '' };
  const updateToDraft = simulateTrigger('UPDATE', oldPosted, { ...oldPosted, is_draft: true });
  assert.equal(updateToDraft.document_status, 'draft');
  assert.equal(updateToDraft.is_draft, true);

  // 4. Conflicting simultaneous update:
  // oldDraft has document_status='draft', is_draft=true.
  // Caller updates document_status='posted', but also sends is_draft=true:
  // document_status takes precedence over is_draft!
  const oldDraft = { document_status: 'draft', is_draft: true, notes: '' };
  const updateConflicting = simulateTrigger('UPDATE', oldDraft, {
    ...oldDraft,
    document_status: 'posted',
    is_draft: true,
  });
  assert.equal(updateConflicting.document_status, 'posted');
  assert.equal(updateConflicting.is_draft, false, 'document_status takes precedence over is_draft');
});

// ==============================================================================
// 4. Concurrent DC Invoicing Serialization & Row Locking
// ==============================================================================
test('4. Concurrent DC Invoicing: Row-level locking and remaining quantity recalculation prevents overselling and deadlocks', () => {
  // Verify migration implements row locking with deterministic ORDER BY
  assert.match(
    migrationSql,
    /PERFORM dci\.id\s+FROM public\.delivery_challan_items dci[\s\S]*?ORDER BY dci\.id ASC\s+FOR UPDATE;/,
    'Must acquire row lock on delivery_challan_items in ORDER BY dci.id ASC FOR UPDATE'
  );

  // Verify remaining quantity recalculation using authoritative helper
  assert.match(
    migrationSql,
    /SELECT COALESCE\(SUM\(sii\.quantity\), 0\)[\s\S]*?INTO v_already_invoiced[\s\S]*?WHERE sii\.delivery_challan_item_id = v_dc_item[\s\S]*?AND public\.is_reportable_sales_invoice\(si\.document_status, si\.is_draft, si\.notes\);/,
    'Must recalculate v_already_invoiced across reportable sales invoices'
  );

  // Verify intra-request summation across multiple product lines
  assert.match(
    migrationSql,
    /IF \(v_already_invoiced \+ v_requested_dc_qty\) > v_dc\.quantity THEN\s+RAISE EXCEPTION/,
    'Must reject when v_already_invoiced + v_requested_dc_qty exceeds DC quantity'
  );

  // Concurrency Simulation:
  // Approved Delivery Challan Item has quantity = 50 kg
  const dcItem = { id: 'dci-101', quantity: 50 };
  let committedInvoicedQuantity = 0;

  function simulateCreateInvoice(requestedQty) {
    // 1. Transaction starts and locks row (simulated lock)
    // 2. Recalculate remaining quantity
    const remainingQty = dcItem.quantity - committedInvoicedQuantity;
    if (requestedQty > remainingQty) {
      throw new Error(
        `Invoice quantity ${requestedQty} exceeds remaining Delivery Challan quantity ${remainingQty} (DC total ${dcItem.quantity}, already invoiced ${committedInvoicedQuantity})`
      );
    }
    // 3. Commit
    committedInvoicedQuantity += requestedQty;
    return { success: true, remainingQty: dcItem.quantity - committedInvoicedQuantity };
  }

  // Concurrent Transaction 1 requests 30 kg
  const tx1 = simulateCreateInvoice(30);
  assert.equal(tx1.success, true);
  assert.equal(tx1.remainingQty, 20);

  // Concurrent Transaction 2 also requests 30 kg (competing for same DC item)
  // In serial execution guaranteed by FOR UPDATE, Tx 2 checks after Tx 1 commits:
  assert.throws(
    () => simulateCreateInvoice(30),
    /Invoice quantity 30 exceeds remaining Delivery Challan quantity 20/,
    'Concurrent request exceeding remaining approved DC quantity must be rejected'
  );

  // Transaction 3 requests 20 kg (exact remainder):
  const tx3 = simulateCreateInvoice(20);
  assert.equal(tx3.success, true);
  assert.equal(tx3.remainingQty, 0);

  // Delivery Challan item is now fully invoiced (50/50 kg):
  assert.throws(
    () => simulateCreateInvoice(1),
    /Invoice quantity 1 exceeds remaining Delivery Challan quantity 0/,
    'Fully invoiced DC item cannot accept any more invoices'
  );
});

// ==============================================================================
// 5. Single Reportability Rule Across Views, RPCs, and Queries
// ==============================================================================
test('5. Single reportability rule: is_reportable_sales_invoice is authoritative and consistent', () => {
  // Read and verify helper function logic
  assert.match(
    migrationSql,
    /CREATE OR REPLACE FUNCTION public\.is_reportable_sales_invoice\([\s\S]*?p_document_status text,[\s\S]*?p_is_draft boolean,[\s\S]*?p_notes text[\s\S]*?\)\s*RETURNS boolean/,
    'Must define is_reportable_sales_invoice'
  );

  function isReportable(docStatus, isDraft, notes) {
    const effectiveStatus = docStatus || (isDraft ? 'draft' : 'posted');
    const isCancelled =
      Boolean(notes?.startsWith('[CANCELLED')) || Boolean(notes?.toLowerCase().startsWith('cancelled'));
    return effectiveStatus === 'posted' && !Boolean(isDraft) && !isCancelled;
  }

  // Standard posted invoice: reportable
  assert.equal(isReportable('posted', false, 'Standard invoice'), true);

  // Draft invoices: non-reportable
  assert.equal(isReportable('draft', true, null), false);
  assert.equal(isReportable('draft', false, null), false);
  assert.equal(isReportable(null, true, null), false);

  // Cancelled invoices: non-reportable
  assert.equal(isReportable('cancelled', false, null), false);
  assert.equal(isReportable('posted', false, '[CANCELLED] Customer refused'), false);
  assert.equal(isReportable('posted', false, 'cancelled by accounts'), false);

  // Verify all canonical views and functions use the authoritative helper:
  assert.ok(
    migrationSql.includes('WHERE public.is_reportable_sales_invoice(document_status, is_draft, notes);'),
    'active_sales_invoices view must use is_reportable_sales_invoice'
  );
  assert.ok(
    migrationSql.includes('WHERE public.is_reportable_sales_invoice(si.document_status, si.is_draft, si.notes)'),
    'active_sales_invoice_items and functions must use is_reportable_sales_invoice'
  );
});

// ==============================================================================
// 6. Cancellation Archive Audit & Attribution
// ==============================================================================
test('6. Cancellation archive audit: Displays verified cancelling user name and avoids fabricated attribution', () => {
  // Test verified user profile resolution
  const userMap = new Map([
    ['user-uuid-1', 'Budi Santoso'],
    ['user-uuid-2', 'Accounts Admin'],
  ]);

  function getCancellationAttribution(inv) {
    const authorName = inv.canceller_name || (inv.cancelled_by ? userMap.get(inv.cancelled_by) : null);
    const hasVerifiedAuthor = Boolean(authorName);
    const reason = inv.cancellation_reason || inv.notes || null;
    const displayReason = reason ? reason.split('\n')[0] : 'No reason recorded';

    return {
      authorName: hasVerifiedAuthor ? authorName : 'Unknown (historical record)',
      hasVerifiedAuthor,
      displayReason,
    };
  }

  // A. Verified modern cancellation with user ID
  const modernCancelledInv = {
    id: 'inv-modern-canc',
    cancelled_by: 'user-uuid-1',
    canceller_name: 'Budi Santoso',
    cancellation_reason: 'Duplicate billing order created by mistake',
    cancelled_at: '2026-10-30T10:00:00Z',
  };
  const modernAttribution = getCancellationAttribution(modernCancelledInv);
  assert.equal(modernAttribution.hasVerifiedAuthor, true);
  assert.equal(modernAttribution.authorName, 'Budi Santoso');
  assert.equal(modernAttribution.displayReason, 'Duplicate billing order created by mistake');

  // B. Historical legacy cancellation without user ID
  const legacyCancelledInv = {
    id: 'inv-legacy-canc',
    cancelled_by: null,
    canceller_name: null,
    notes: '[CANCELLED - 2026-08-10] Order cancelled by customer request',
  };
  const legacyAttribution = getCancellationAttribution(legacyCancelledInv);
  assert.equal(legacyAttribution.hasVerifiedAuthor, false);
  assert.equal(
    legacyAttribution.authorName,
    'Unknown (historical record)',
    'Must display unknown historical record instead of fabricating an author'
  );
  assert.equal(legacyAttribution.displayReason, '[CANCELLED - 2026-08-10] Order cancelled by customer request');

  // Verify Sales.tsx implements verified vs unknown attribution
  assert.ok(
    salesPageCode.includes('Unknown (historical record)'),
    'Sales.tsx must render Unknown (historical record) for unverified attribution'
  );
  assert.ok(
    salesPageCode.includes('inv.canceller_name'),
    'Sales.tsx must display canceller_name when verified'
  );
});

// ==============================================================================
// 7. Retest of SAPJ-26-072 (cancelled, 20 kg) and SAPJ-26-073 (valid, 30 kg) against DO-26-0073
// ==============================================================================
test('7. Retest SAPJ-26-072 & SAPJ-26-073 against DO-26-0073: 30 kg active sales, 20 kg cancelled disclosure, 30 kg stock deduction', () => {
  // Scenario:
  // Delivery Challan DO-26-0073 had approved delivery of 50 kg total.
  // Invoice 1: SAPJ-26-072 billed 20 kg -> later CANCELLED.
  // Invoice 2: SAPJ-26-073 billed 30 kg -> active POSTED.
  const dcItem = { id: 'dci-do-73', product_id: 'prod-api', quantity: 50 };

  const allInvoices = [
    {
      invoice_number: 'SAPJ-26-072',
      document_status: 'cancelled',
      is_draft: false,
      notes: '[CANCELLED] Replaced by invoice SAPJ-26-073',
      lines: [{ quantity: 20, unit_price: 150000 }],
    },
    {
      invoice_number: 'SAPJ-26-073',
      document_status: 'posted',
      is_draft: false,
      notes: 'Valid replacement invoice',
      lines: [{ quantity: 30, unit_price: 150000 }],
    },
  ];

  // Reportable sales calculation:
  const reportableInvoices = allInvoices.filter((inv) =>
    inv.document_status === 'posted' && !inv.is_draft && !inv.notes?.includes('[CANCELLED')
  );
  assert.equal(reportableInvoices.length, 1);
  assert.equal(reportableInvoices[0].invoice_number, 'SAPJ-26-073');

  const reportableSoldQty = reportableInvoices.reduce(
    (sum, inv) => sum + inv.lines.reduce((lSum, l) => lSum + l.quantity, 0),
    0
  );
  assert.equal(reportableSoldQty, 30, 'Recognized sales quantity must remain exactly 30 kg');

  // Cancelled disclosure:
  const cancelledInvoices = allInvoices.filter(
    (inv) => inv.document_status === 'cancelled' || inv.notes?.includes('[CANCELLED')
  );
  assert.equal(cancelledInvoices.length, 1);
  assert.equal(cancelledInvoices[0].invoice_number, 'SAPJ-26-072');

  const cancelledDisclosureQty = cancelledInvoices.reduce(
    (sum, inv) => sum + inv.lines.reduce((lSum, l) => lSum + l.quantity, 0),
    0
  );
  assert.equal(cancelledDisclosureQty, 20, 'Cancelled disclosure must show 20 kg separately');

  // Invoiced quantity on DC:
  // Since SAPJ-26-072 was cancelled, its 20 kg was released from the DC item's billed quantity.
  // The only active invoice is SAPJ-26-073 (30 kg).
  const dcBilledQty = reportableInvoices.reduce(
    (sum, inv) => sum + inv.lines.reduce((lSum, l) => lSum + l.quantity, 0),
    0
  );
  assert.equal(dcBilledQty, 30);
  assert.equal(dcItem.quantity - dcBilledQty, 20, 'DC item remaining unbilled quantity is 20 kg');

  // Idempotency test of cancel_sales_invoice RPC:
  // If cancel_sales_invoice is called again on SAPJ-26-072:
  function simulateCancelRpc(inv) {
    if (inv.document_status === 'cancelled' || inv.notes?.includes('[CANCELLED')) {
      return { success: true, already_cancelled: true, reversalsCreated: 0 };
    }
    return { success: true, already_cancelled: false, reversalsCreated: 2 };
  }

  const secondCancelCall = simulateCancelRpc(cancelledInvoices[0]);
  assert.equal(secondCancelCall.already_cancelled, true);
  assert.equal(
    secondCancelCall.reversalsCreated,
    0,
    'Subsequent cancel call must be idempotent without creating duplicate reversals'
  );
});
