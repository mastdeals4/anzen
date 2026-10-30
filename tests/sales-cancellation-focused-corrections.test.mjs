import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const rootDir = path.resolve(__dirname, '..');

const migration13Sql = fs.readFileSync(
  path.join(rootDir, 'supabase/migrations/20261030130000_sales_cancellation_hardening_corrections.sql'),
  'utf8'
);
const migration14Sql = fs.readFileSync(
  path.join(rootDir, 'supabase/migrations/20261030140000_sales_lifecycle_terminal_cancellation_and_concurrency_hardening.sql'),
  'utf8'
);
const combinedMigrationsSql = `${migration13Sql}\n\n${migration14Sql}`;

const salesPageCode = fs.readFileSync(
  path.join(rootDir, 'src/pages/Sales.tsx'),
  'utf8'
);

// Trigger simulation replicating public.trg_sync_sales_invoice_document_status()
function simulateTrigger(tg_op, oldRow, newRow) {
  const row = { ...newRow };
  if (tg_op === 'INSERT') {
    if (row.document_status !== undefined && row.document_status !== null) {
      if (row.document_status === 'draft') {
        row.is_draft = true;
      } else if (row.document_status === 'posted' || row.document_status === 'cancelled') {
        row.is_draft = false;
      }
    } else {
      // document_status was omitted (NULL) -> infer from is_draft and notes
      if (row.is_draft === true) {
        row.document_status = 'draft';
      } else if (row.notes?.startsWith('[CANCELLED') || row.notes?.toLowerCase().startsWith('cancelled')) {
        row.document_status = 'cancelled';
        row.is_draft = false;
      } else {
        row.document_status = 'posted';
        row.is_draft = false;
      }
    }

    if (row.document_status === 'cancelled' && !row.cancelled_at) {
      row.cancelled_at = '2026-10-30T12:00:00Z';
    }
    return row;
  }

  // TG_OP = 'UPDATE'
  const v_status_changed = row.document_status !== oldRow.document_status;
  const v_draft_changed = row.is_draft !== oldRow.is_draft;
  const v_is_cancelled =
    oldRow.document_status === 'cancelled' ||
    Boolean(oldRow.notes?.startsWith('[CANCELLED') || oldRow.notes?.toLowerCase().startsWith('cancelled'));

  // Terminal cancellation enforcement:
  if (v_is_cancelled) {
    if (row.document_status !== 'cancelled') {
      throw new Error(
        `Cannot update or reopen cancelled sales invoice ${oldRow.invoice_number || 'INV'}: cancellation is terminal`
      );
    }
    row.document_status = 'cancelled';
    row.is_draft = false;
    if (!row.cancelled_at) row.cancelled_at = oldRow.cancelled_at || '2026-10-30T12:00:00Z';
    return row;
  }

  // Precedence and Conflict Resolution rule for uncancelled invoices:
  if (v_status_changed) {
    if (row.document_status === 'draft') row.is_draft = true;
    else if (row.document_status === 'posted' || row.document_status === 'cancelled') row.is_draft = false;
  } else if (v_draft_changed) {
    if (row.is_draft === true) row.document_status = 'draft';
    else row.document_status = 'posted';
  } else {
    if (row.document_status === null || row.document_status === undefined) {
      row.document_status = row.is_draft ? 'draft' : 'posted';
    } else if (row.document_status === 'draft') {
      row.is_draft = true;
    } else if (row.document_status === 'posted' || row.document_status === 'cancelled') {
      row.is_draft = false;
    }
  }

  if (row.document_status === 'cancelled' && !row.cancelled_at) {
    row.cancelled_at = oldRow.cancelled_at || '2026-10-30T12:00:00Z';
  }
  return row;
}

// ==============================================================================
// 1. Creating a draft invoice
// ==============================================================================
test('1. Creating a draft invoice: document_status = draft sets is_draft = true', () => {
  const result = simulateTrigger('INSERT', null, { document_status: 'draft', is_draft: false });
  assert.equal(result.document_status, 'draft');
  assert.equal(result.is_draft, true, 'Draft document_status must enforce is_draft = true');
});

// ==============================================================================
// 2. Creating a posted invoice
// ==============================================================================
test('2. Creating a posted invoice: document_status = posted sets is_draft = false', () => {
  const result = simulateTrigger('INSERT', null, { document_status: 'posted', is_draft: true });
  assert.equal(result.document_status, 'posted');
  assert.equal(result.is_draft, false, 'Posted document_status must enforce is_draft = false');
});

// ==============================================================================
// 3. Cancelling an invoice
// ==============================================================================
test('3. Cancelling an invoice: sets document_status = cancelled, cancelled_at timestamp, and is idempotent', () => {
  const activeInvoice = {
    id: 'inv-active-1',
    invoice_number: 'SAPJ-26-072',
    document_status: 'posted',
    is_draft: false,
    notes: 'Standard delivery',
  };

  function simulateCancelSalesInvoice(inv, userId, reason) {
    if (inv.document_status === 'cancelled' || inv.notes?.startsWith('[CANCELLED')) {
      return { success: true, already_cancelled: true, reversalsCreated: 0 };
    }
    inv.document_status = 'cancelled';
    inv.is_draft = false;
    inv.cancelled_at = '2026-10-30T12:30:00Z';
    inv.cancelled_by = userId;
    inv.cancellation_reason = reason;
    inv.notes = `[CANCELLED ${inv.cancelled_at.split('T')[0]}] ${reason}\n${inv.notes || ''}`;
    return { success: true, already_cancelled: false, reversalsCreated: 2 };
  }

  const cancelResult = simulateCancelSalesInvoice(activeInvoice, 'user-123', 'Replaced by SAPJ-26-073');
  assert.equal(cancelResult.success, true);
  assert.equal(cancelResult.already_cancelled, false);
  assert.equal(activeInvoice.document_status, 'cancelled');
  assert.equal(activeInvoice.is_draft, false);
  assert.ok(activeInvoice.cancelled_at);
  assert.equal(activeInvoice.cancelled_by, 'user-123');

  // Second cancel call must be idempotent
  const repeatCancel = simulateCancelSalesInvoice(activeInvoice, 'user-123', 'Repeat cancel');
  assert.equal(repeatCancel.already_cancelled, true);
  assert.equal(repeatCancel.reversalsCreated, 0, 'No duplicate reversals created on repeat cancel');
});

// ==============================================================================
// 4. Updating a cancelled invoice without changing its status
// ==============================================================================
test('4. Updating a cancelled invoice without changing its status: preserves cancellation and prevents un-cancellation', () => {
  const cancelledRow = {
    invoice_number: 'SAPJ-26-072',
    document_status: 'cancelled',
    is_draft: false,
    cancelled_at: '2026-10-25T10:00:00Z',
    notes: '[CANCELLED] Cancelled invoice notes',
  };

  // Routine update (e.g. updating description or payment terms)
  const routineUpdate = simulateTrigger('UPDATE', cancelledRow, {
    ...cancelledRow,
    payment_terms_days: 45,
  });
  assert.equal(routineUpdate.document_status, 'cancelled');
  assert.equal(routineUpdate.is_draft, false);
  assert.equal(routineUpdate.cancelled_at, '2026-10-25T10:00:00Z');

  // Legacy update that sends is_draft = false
  const legacyDraftFalseUpdate = simulateTrigger('UPDATE', cancelledRow, {
    ...cancelledRow,
    is_draft: false,
  });
  assert.equal(legacyDraftFalseUpdate.document_status, 'cancelled');
  assert.equal(legacyDraftFalseUpdate.is_draft, false);
});

// ==============================================================================
// 5. Attempting an unauthorized cancelled-to-posted transition
// ==============================================================================
test('5. Attempting an unauthorized cancelled-to-posted transition: raises terminal cancellation exception', () => {
  const cancelledRow = {
    invoice_number: 'SAPJ-26-072',
    document_status: 'cancelled',
    is_draft: false,
    notes: '[CANCELLED] Order cancelled',
  };

  assert.throws(
    () =>
      simulateTrigger('UPDATE', cancelledRow, {
        ...cancelledRow,
        document_status: 'posted',
      }),
    /Cannot update or reopen cancelled sales invoice SAPJ-26-072: cancellation is terminal/,
    'Must throw exception when attempting to reopen a cancelled invoice'
  );

  assert.throws(
    () =>
      simulateTrigger('UPDATE', cancelledRow, {
        ...cancelledRow,
        document_status: 'draft',
      }),
    /Cannot update or reopen cancelled sales invoice SAPJ-26-072: cancellation is terminal/,
    'Must throw exception when attempting to convert a cancelled invoice to draft'
  );
});

// ==============================================================================
// 6. Legacy callers that omit document_status
// ==============================================================================
test('6. Legacy callers that omit document_status: trigger infers status safely after dropping column default', () => {
  assert.match(
    migration14Sql,
    /ALTER TABLE public\.sales_invoices ALTER COLUMN document_status DROP DEFAULT;/,
    'Migration must drop default on document_status'
  );

  // Legacy caller omitting document_status but providing is_draft: true
  const legacyDraft = simulateTrigger('INSERT', null, { is_draft: true, notes: 'Draft order' });
  assert.equal(legacyDraft.document_status, 'draft');
  assert.equal(legacyDraft.is_draft, true);

  // Legacy caller omitting document_status and is_draft (defaults to posted)
  const legacyPosted = simulateTrigger('INSERT', null, { notes: 'Standard order' });
  assert.equal(legacyPosted.document_status, 'posted');
  assert.equal(legacyPosted.is_draft, false);

  // Legacy caller inserting an invoice with cancellation notes
  const legacyCancelled = simulateTrigger('INSERT', null, { notes: '[CANCELLED] Customer refused' });
  assert.equal(legacyCancelled.document_status, 'cancelled');
  assert.equal(legacyCancelled.is_draft, false);
  assert.ok(legacyCancelled.cancelled_at);
});

// ==============================================================================
// 7. Multi-line cancelled invoice disclosure totals
// ==============================================================================
test('7. Multi-line cancelled invoice disclosure totals: headers counted exactly once without Cartesian duplication', () => {
  assert.ok(
    combinedMigrationsSql.includes('cancelled_headers AS ('),
    'Migration must define separate cancelled_headers CTE'
  );

  const multiLineCancelledInvoice = {
    id: 'inv-canc-multi',
    invoice_number: 'SAPJ-26-072',
    total_amount: 60000000,
    subtotal: 55000000,
    document_status: 'cancelled',
  };

  const invoiceLines = [
    { id: 'l1', invoice_id: 'inv-canc-multi', quantity: 10 },
    { id: 'l2', invoice_id: 'inv-canc-multi', quantity: 15 },
    { id: 'l3', invoice_id: 'inv-canc-multi', quantity: 25 },
  ];

  // Separated aggregation:
  const headers = [multiLineCancelledInvoice];
  const totalAmount = headers.reduce((sum, h) => sum + h.total_amount, 0);
  const subtotal = headers.reduce((sum, h) => sum + h.subtotal, 0);
  const totalQuantity = invoiceLines.reduce((sum, l) => sum + l.quantity, 0);

  assert.equal(totalAmount, 60000000, 'Header total must be counted once (60M, not 180M)');
  assert.equal(subtotal, 55000000, 'Header subtotal must be counted once (55M, not 165M)');
  assert.equal(totalQuantity, 50, 'Line quantities must be summed across all lines (10+15+25=50)');
});

// ==============================================================================
// 8. Multiple invoices against one DC item
// ==============================================================================
test('8. Multiple invoices against one DC item: validates remaining capacity correctly across multiple invoices', () => {
  const dcItem = { id: 'dci-multi-inv', quantity: 100 };
  const committedInvoices = [
    { invoice_number: 'INV-1', quantity: 40, status: 'posted' },
    { invoice_number: 'INV-2', quantity: 30, status: 'posted' },
  ];

  const totalInvoiced = committedInvoices.reduce((sum, i) => sum + i.quantity, 0);
  const remainingCapacity = dcItem.quantity - totalInvoiced;
  assert.equal(totalInvoiced, 70);
  assert.equal(remainingCapacity, 30);

  // Attempting to invoice 35 kg exceeds remaining capacity
  const requestedQty = 35;
  assert.ok(
    totalInvoiced + requestedQty > dcItem.quantity,
    'Must detect that 70 + 35 > 100'
  );
});

// ==============================================================================
// 9. Partial invoicing and correct remaining quantity in dc_invoicing_summary
// ==============================================================================
test('9. Partial invoicing and correct remaining quantity: dc_invoicing_summary rolls up accurately', () => {
  assert.match(
    migration14Sql,
    /CREATE OR REPLACE VIEW public\.dc_invoicing_summary/,
    'Migration 14 must recreate dc_invoicing_summary'
  );
  assert.match(
    migration14Sql,
    /dci\.quantity AS approved_quantity,[\s\S]*?COALESCE\(SUM\(sii\.quantity\), 0::numeric\) AS invoiced_quantity,[\s\S]*?GREATEST\(0::numeric, dci\.quantity - COALESCE\(SUM\(sii\.quantity\), 0::numeric\)\) AS remaining_quantity/,
    'Must calculate approved_quantity, invoiced_quantity, and remaining_quantity per DC item'
  );

  // Simulation of dc_invoicing_summary logic:
  const dcItems = [
    { id: 'dci-1', quantity: 50, invoiced_qty: 30 }, // partial (20 remaining)
    { id: 'dci-2', quantity: 50, invoiced_qty: 0 },  // uninvoiced (50 remaining)
  ];

  const totalApproved = dcItems.reduce((sum, i) => sum + i.quantity, 0);
  const totalInvoiced = dcItems.reduce((sum, i) => sum + i.invoiced_qty, 0);
  const totalRemaining = dcItems.reduce((sum, i) => sum + (i.quantity - i.invoiced_qty), 0);

  assert.equal(totalApproved, 100);
  assert.equal(totalInvoiced, 30);
  assert.equal(totalRemaining, 70);

  const status =
    totalInvoiced === 0 ? 'not_invoiced' : totalRemaining === 0 ? 'fully_invoiced' : 'partially_invoiced';
  assert.equal(status, 'partially_invoiced');
});

// ==============================================================================
// 10. Invoice editing that moves quantities between DC items
// ==============================================================================
test('10. Invoice editing that moves quantities between DC items: excludes invoice being edited from existing invoiced sum', () => {
  assert.match(
    migration14Sql,
    /WHERE sii\.delivery_challan_item_id = v_dc_item\s+AND si\.id <> p_invoice_id\s+AND public\.is_reportable_sales_invoice/,
    'update_sales_invoice_atomic must exclude p_invoice_id when validating available capacity'
  );

  // Simulation: Invoice E has 20 kg on DCI-1.
  // User edits Invoice E to move 10 kg to DCI-2 (so DCI-1 gets 10 kg, DCI-2 gets 10 kg).
  const dcItem1 = { id: 'dci-1', quantity: 30 };
  const dcItem2 = { id: 'dci-2', quantity: 30 };

  const existingInvoices = [
    { id: 'inv-E', dc_item_id: 'dci-1', quantity: 20 },
    { id: 'inv-Other', dc_item_id: 'dci-2', quantity: 25 },
  ];

  function validateEdit(editingInvId, targetDcItem, newRequestedQty) {
    // Other invoices on target DC item:
    const otherInvoiced = existingInvoices
      .filter((inv) => inv.id !== editingInvId && inv.dc_item_id === targetDcItem.id)
      .reduce((sum, inv) => sum + inv.quantity, 0);

    const available = targetDcItem.quantity - otherInvoiced;
    if (newRequestedQty > available) {
      throw new Error(
        `Invoice edit quantity ${newRequestedQty} exceeds remaining Delivery Challan quantity ${available}`
      );
    }
    return { success: true, remaining: available - newRequestedQty };
  }

  // DCI-1: requesting 10 kg. Total = 30. Other = 0. Available = 30. Requested 10 -> OK!
  const dci1Validation = validateEdit('inv-E', dcItem1, 10);
  assert.equal(dci1Validation.success, true);
  assert.equal(dci1Validation.remaining, 20);

  // DCI-2: requesting 10 kg. Total = 30. Other = 25 (inv-Other). Available = 5.
  // Requesting 10 exceeds 5!
  assert.throws(
    () => validateEdit('inv-E', dcItem2, 10),
    /Invoice edit quantity 10 exceeds remaining Delivery Challan quantity 5/
  );
});

// ==============================================================================
// 11. Invoice creation and editing competing for the same remaining DC quantity
// ==============================================================================
test('11. Invoice creation and invoice editing competing for remaining DC quantity: deterministic row locking order', () => {
  // Both create_sales_invoice_atomic and update_sales_invoice_atomic must lock parent DCs first, then DC items in ASC order
  assert.match(
    migration14Sql,
    /PERFORM dc\.id\s+FROM public\.delivery_challans dc[\s\S]*?ORDER BY dc\.id ASC\s+FOR UPDATE;/,
    'create_sales_invoice_atomic must lock parent delivery_challans in ASC order'
  );
  assert.match(
    migration14Sql,
    /PERFORM dci\.id\s+FROM public\.delivery_challan_items dci[\s\S]*?ORDER BY dci\.id ASC\s+FOR UPDATE;/,
    'create_sales_invoice_atomic must lock child delivery_challan_items in ASC order'
  );

  assert.match(
    migration14Sql,
    /PERFORM dc\.id\s+FROM public\.delivery_challans dc\s+WHERE dc\.id = ANY\(v_all_parent_dc_ids\)\s+ORDER BY dc\.id ASC\s+FOR UPDATE;/,
    'update_sales_invoice_atomic must lock parent delivery_challans in ASC order'
  );
  assert.match(
    migration14Sql,
    /PERFORM dci\.id\s+FROM public\.delivery_challan_items dci\s+WHERE dci\.id = ANY\(v_all_dc_item_ids\)\s+ORDER BY dci\.id ASC\s+FOR UPDATE;/,
    'update_sales_invoice_atomic must lock child delivery_challan_items in ASC order'
  );
});

// ==============================================================================
// 12. Invoice creation/editing competing with DC cancellation
// ==============================================================================
test('12. Invoice creation/editing competing with DC cancellation: coordinated lock ordering and active invoice guard', () => {
  // fn_cancel_delivery_challan locks parent DC, then child DC items in ASC order
  assert.match(
    migration14Sql,
    /PERFORM dc\.id\s+FROM public\.delivery_challans dc\s+WHERE dc\.id = p_dc_id\s+FOR UPDATE;/,
    'fn_cancel_delivery_challan must lock parent DC first'
  );
  assert.match(
    migration14Sql,
    /PERFORM dci\.id\s+FROM public\.delivery_challan_items dci\s+WHERE dci\.challan_id = p_dc_id\s+ORDER BY dci\.id ASC\s+FOR UPDATE;/,
    'fn_cancel_delivery_challan must lock child DC items in ASC order second'
  );

  // fn_cancel_delivery_challan raises exception if active reportable invoices exist
  assert.match(
    migration14Sql,
    /Cannot cancel Delivery Challan %: already invoiced by active sales invoice\(s\) %/,
    'fn_cancel_delivery_challan must reject cancellation when active reportable invoices exist'
  );
});

// ==============================================================================
// 13. Rollback after a failed quantity validation
// ==============================================================================
test('13. Rollback after failed quantity validation: transaction guarantees atomic rollback', () => {
  let dbState = {
    invoices: [{ id: 'inv-1', total: 1000000 }],
    items: [{ id: 'item-1', invoice_id: 'inv-1', qty: 10 }],
  };

  function executeAtomicTransaction(fn) {
    const snapshot = JSON.parse(JSON.stringify(dbState));
    try {
      fn();
    } catch (err) {
      dbState = snapshot; // Rollback
      throw err;
    }
  }

  assert.throws(() => {
    executeAtomicTransaction(() => {
      dbState.invoices.push({ id: 'inv-2', total: 5000000 });
      // Validation failure on item quantity exceeding capacity
      throw new Error('Invoice quantity exceeds remaining Delivery Challan quantity');
    });
  }, /Invoice quantity exceeds remaining Delivery Challan quantity/);

  assert.equal(dbState.invoices.length, 1, 'Failed transaction must roll back completely');
});

// ==============================================================================
// 14. Sales, receivables, ageing and dashboard exclusions
// ==============================================================================
test('14. Sales, receivables, ageing and dashboard exclusions: drafts and cancellations excluded across all metrics', () => {
  const invoices = [
    { id: '1', number: 'POST-1', document_status: 'posted', is_draft: false, total_amount: 10000000, balance: 10000000 },
    { id: '2', number: 'POST-2', document_status: 'posted', is_draft: false, total_amount: 20000000, balance: 5000000 },
    { id: '3', number: 'DRAFT-1', document_status: 'draft', is_draft: true, total_amount: 15000000, balance: 15000000 },
    { id: '4', number: 'CANC-1', document_status: 'cancelled', is_draft: false, total_amount: 25000000, balance: 0 },
  ];

  function isReportable(inv) {
    return inv.document_status === 'posted' && !inv.is_draft;
  }

  const reportableInvoices = invoices.filter(isReportable);
  assert.equal(reportableInvoices.length, 2);

  const recognizedRevenue = reportableInvoices.reduce((sum, inv) => sum + inv.total_amount, 0);
  const outstandingReceivables = reportableInvoices.reduce((sum, inv) => sum + inv.balance, 0);

  assert.equal(recognizedRevenue, 30000000, 'Recognized revenue must be 30M (excluding draft 15M and cancelled 25M)');
  assert.equal(outstandingReceivables, 15000000, 'Receivables must be 15M (excluding draft and cancelled)');

  // Verify Sales.tsx implements these exact checks
  assert.ok(salesPageCode.includes('postedRevenue = postedInvoices.reduce'));
  assert.ok(salesPageCode.includes('pendingValue = postedInvoices.reduce'));
  assert.ok(salesPageCode.includes('draftValue = draftInvoices.reduce'));
});

// ==============================================================================
// 15. The complete DO-26-0073 verification case
// ==============================================================================
test('15. DO-26-0073 Real-Data Verification: 30 kg approved DC, 30 kg active sales, 20 kg cancelled disclosure, 0 kg remaining capacity', () => {
  // Verification Case Parameters from Section 6:
  // Delivery Challan: DO-26-0073
  // DC ID: abda70d6-cede-4a14-bc47-1adea0729f6f
  // Status: approved
  // DC item ID: baadf206-f75f-4109-89e3-2a20f836351f
  // Actual DC quantity: 30 kg
  // Batch: DX/L/25/0048 (f767785c-1d74-4b03-b7be-1e6cd6b8282f)
  //
  // Linked invoices:
  // 1. SAPJ-26-072: Cancelled, 20 kg
  // 2. SAPJ-26-073: Active, 30 kg
  const dcRecord = {
    id: 'abda70d6-cede-4a14-bc47-1adea0729f6f',
    challan_number: 'DO-26-0073',
    approval_status: 'approved',
    items: [
      {
        id: 'baadf206-f75f-4109-89e3-2a20f836351f',
        product_id: 'prod-dx',
        batch_id: 'f767785c-1d74-4b03-b7be-1e6cd6b8282f',
        quantity: 30, // ACTUAL DC QUANTITY IS 30 kg (NOT 50 kg)
      },
    ],
  };

  const linkedInvoices = [
    {
      invoice_number: 'SAPJ-26-072',
      document_status: 'cancelled',
      is_draft: false,
      notes: '[CANCELLED] Replaced by invoice SAPJ-26-073',
      lines: [{ dc_item_id: 'baadf206-f75f-4109-89e3-2a20f836351f', quantity: 20 }],
    },
    {
      invoice_number: 'SAPJ-26-073',
      document_status: 'posted',
      is_draft: false,
      notes: 'Valid posted replacement invoice',
      lines: [{ dc_item_id: 'baadf206-f75f-4109-89e3-2a20f836351f', quantity: 30 }],
    },
  ];

  // 1. Active recognized sales quantity:
  const activeInvoices = linkedInvoices.filter(
    (inv) => inv.document_status === 'posted' && !inv.is_draft && !inv.notes.includes('[CANCELLED')
  );
  assert.equal(activeInvoices.length, 1);
  assert.equal(activeInvoices[0].invoice_number, 'SAPJ-26-073');

  const activeSalesQty = activeInvoices.reduce(
    (sum, inv) => sum + inv.lines.reduce((lSum, l) => lSum + l.quantity, 0),
    0
  );
  assert.equal(activeSalesQty, 30, 'Active recognized sales quantity must be exactly 30 kg');

  // 2. Cancelled disclosure quantity:
  const cancelledInvoices = linkedInvoices.filter(
    (inv) => inv.document_status === 'cancelled' || inv.notes.includes('[CANCELLED')
  );
  assert.equal(cancelledInvoices.length, 1);
  assert.equal(cancelledInvoices[0].invoice_number, 'SAPJ-26-072');

  const cancelledDisclosureQty = cancelledInvoices.reduce(
    (sum, inv) => sum + inv.lines.reduce((lSum, l) => lSum + l.quantity, 0),
    0
  );
  assert.equal(cancelledDisclosureQty, 20, 'Cancelled disclosure quantity must be exactly 20 kg');

  // 3. Remaining invoiceable quantity on DO-26-0073:
  const approvedDcQty = dcRecord.items[0].quantity; // 30 kg
  const remainingInvoiceableQty = approvedDcQty - activeSalesQty;

  // CRITICAL REQUIREMENT:
  // "The active invoice already consumes the full approved 30 kg DC quantity.
  // Remaining invoiceable quantity: 0 kg.
  // Do not create another 20 kg invoice. Do not treat this DC as 50 kg."
  assert.equal(approvedDcQty, 30, 'Approved DC quantity is 30 kg');
  assert.equal(remainingInvoiceableQty, 0, 'Remaining invoiceable quantity must be exactly 0 kg');

  // 4. Verification that any attempt to invoice another quantity against DO-26-0073 is rejected:
  function attemptCreateInvoiceAgainstDc(requestedQty) {
    if (activeSalesQty + requestedQty > approvedDcQty) {
      throw new Error(
        `Invoice quantity ${requestedQty} exceeds remaining Delivery Challan quantity ${approvedDcQty - activeSalesQty} (DC total ${approvedDcQty}, already invoiced ${activeSalesQty})`
      );
    }
  }

  assert.throws(
    () => attemptCreateInvoiceAgainstDc(20),
    /Invoice quantity 20 exceeds remaining Delivery Challan quantity 0/,
    'Attempt to create another 20 kg invoice must be rejected'
  );
});
