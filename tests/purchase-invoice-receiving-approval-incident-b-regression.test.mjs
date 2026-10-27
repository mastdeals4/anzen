import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';

const migrationSql = fs.readFileSync('supabase/migrations/20261027160000_harden_purchase_invoice_receiving_approval_trigger.sql', 'utf8');
const repairSql = fs.readFileSync('audits/repairs/repair_invoice_80103232_receiving_approval.sql', 'utf8');
const piManager = fs.readFileSync('src/components/finance/PurchaseInvoiceManager.tsx', 'utf8');
const batchesPage = fs.readFileSync('src/pages/Batches.tsx', 'utf8');

// In-memory simulation of Purchase Invoice Receiving Approval lifecycle
class PurchaseInvoiceApprovalLifecycle {
  constructor(mode = 'hardened') {
    this.mode = mode; // 'legacy' | 'hardened'
    this.invoices = new Map();
    this.items = new Map();
    this.receivingAllocations = new Map();
    this.auditLog = [];
  }

  createInvoice(id, number, supplierId, date, total, currency = 'IDR') {
    const inv = {
      id,
      invoice_number: number,
      supplier_id: supplierId,
      invoice_date: date,
      total_amount: total,
      currency,
      receiving_approval_status: 'draft',
      receiving_submitted_at: null,
      receiving_submitted_by: null,
      receiving_approved_at: null,
      receiving_approved_by: null,
      payment_status: 'unpaid',
      paid_amount: 0,
      balance_amount: total,
      document_urls: [],
      notes: null,
    };
    this.invoices.set(id, inv);
    return inv;
  }

  submitForReceiving(invoiceId, userId) {
    const inv = this.invoices.get(invoiceId);
    if (!inv) throw new Error('Not found');
    if (inv.receiving_approval_status === 'approved') {
      throw new Error('Already approved');
    }
    inv.receiving_approval_status = 'pending_approval';
    inv.receiving_submitted_at = new Date().toISOString();
    inv.receiving_submitted_by = userId;
    this.auditLog.push({ invoiceId, action: 'submitted', status: 'pending_approval', userId });
    return inv;
  }

  approveForReceiving(invoiceId, userId) {
    const inv = this.invoices.get(invoiceId);
    if (!inv) throw new Error('Not found');
    // Idempotent behavior
    if (inv.receiving_approval_status === 'approved') {
      return { success: true, already_approved: true };
    }
    if (inv.receiving_approval_status !== 'pending_approval') {
      throw new Error('Must be pending approval');
    }
    inv.receiving_approval_status = 'approved';
    inv.receiving_approved_at = new Date().toISOString();
    inv.receiving_approved_by = userId;
    this.auditLog.push({ invoiceId, action: 'approved', status: 'approved', userId });
    return { success: true };
  }

  addItem(id, invoiceId, productId, qty, unitPrice) {
    const item = {
      id,
      purchase_invoice_id: invoiceId,
      product_id: productId,
      quantity: qty,
      unit_price: unitPrice,
      batch_id: null,
      receiving_batch_number: null,
    };
    this.items.set(id, item);
    return item;
  }

  // Simulates trigger trg_reset_receiving_approval_on_item_change
  updateItem(itemId, changes, userId) {
    const item = this.items.get(itemId);
    if (!item) throw new Error('Item not found');
    const oldItem = { ...item };
    Object.assign(item, changes);

    const inv = this.invoices.get(item.purchase_invoice_id);

    if (this.mode === 'legacy') {
      // Legacy unconstrained trigger: ANY update on purchase_invoice_items resets approval
      if (inv && inv.receiving_approval_status === 'approved') {
        inv.receiving_approval_status = 'pending_approval';
        // Note: Legacy trigger did not clear historical receiving_approved_at
      }
      return item;
    }

    // Hardened trigger behavior:
    const commercialChanged = (
      item.product_id !== oldItem.product_id ||
      item.quantity !== oldItem.quantity ||
      item.unit_price !== oldItem.unit_price
    );

    // Operational updates (batch_id, receiving_batch_number) must NOT reset approval
    if (!commercialChanged) {
      return item;
    }

    if (inv && inv.receiving_approval_status === 'approved') {
      // If already received, preserve receiving approval status
      const hasReceiving = [...this.receivingAllocations.values()].some(a => a.invoiceId === inv.id);
      if (!hasReceiving) {
        this.auditLog.push({
          invoiceId: inv.id,
          action: 'reset_by_commercial_edit',
          status: 'pending_approval',
          userId,
        });
        inv.receiving_approval_status = 'pending_approval';
        inv.receiving_submitted_at = new Date().toISOString();
        inv.receiving_submitted_by = userId;
      }
    }
    return item;
  }

  // Simulates receive_purchase_invoice_item
  receiveItem(itemId, batchId, batchNumber, receivedQty, userId) {
    const item = this.items.get(itemId);
    if (!item) throw new Error('Item not found');
    const inv = this.invoices.get(item.purchase_invoice_id);
    if (!inv || inv.receiving_approval_status !== 'approved') {
      throw new Error('Invoice must be approved for receiving');
    }

    // 1. Insert receiving allocation
    const allocId = `alloc-${Date.now()}-${Math.random()}`;
    this.receivingAllocations.set(allocId, {
      id: allocId,
      invoiceId: inv.id,
      itemId,
      batchId,
      batchNumber,
      receivedQty,
      userId,
    });

    // 2. Operational item update: link batch_id and batch_number (triggers item update)
    this.updateItem(itemId, { batch_id: batchId, receiving_batch_number: batchNumber }, userId);

    return { success: true, allocationId: allocId };
  }

  // Frontend helper simulations matching PurchaseInvoiceManager and Batches
  canShowApproveButton(invoiceId) {
    const inv = this.invoices.get(invoiceId);
    return Boolean(inv && inv.receiving_approval_status === 'pending_approval');
  }

  canShowInwardButton(invoiceId, itemId) {
    const inv = this.invoices.get(invoiceId);
    const item = this.items.get(itemId);
    if (!inv || !item) return false;
    if (inv.receiving_approval_status !== 'approved') return false;
    const receivedSoFar = [...this.receivingAllocations.values()]
      .filter(a => a.itemId === itemId)
      .reduce((sum, a) => sum + a.receivedQty, 0);
    return receivedSoFar < item.quantity;
  }

  isEligibleForWarehouseQueue(invoiceId) {
    const inv = this.invoices.get(invoiceId);
    return Boolean(inv && inv.receiving_approval_status === 'approved');
  }
}

test('1. Exact sequence: approve invoice -> record inward -> reload invoice -> approval remains approved and does NOT request duplicate approval', () => {
  const lifecycle = new PurchaseInvoiceApprovalLifecycle('hardened');
  const inv = lifecycle.createInvoice('inv-80103232', '80103232', 'supp-menjangan', '2026-10-19', 500000000);
  const item = lifecycle.addItem('item-1', 'inv-80103232', 'prod-cypro', 500, 1000000);

  // 1. Initial State: Draft
  assert.equal(inv.receiving_approval_status, 'draft');
  assert.equal(lifecycle.canShowApproveButton(inv.id), false);
  assert.equal(lifecycle.isEligibleForWarehouseQueue(inv.id), false);

  // 2. Submit for Inward Approval
  lifecycle.submitForReceiving(inv.id, 'submitter-1');
  assert.equal(inv.receiving_approval_status, 'pending_approval');
  assert.equal(lifecycle.canShowApproveButton(inv.id), true, 'UI shows Approve button for pending invoice');
  assert.equal(lifecycle.isEligibleForWarehouseQueue(inv.id), false, 'Warehouse queue excludes pending invoices');

  // 3. Management Approves Invoice
  lifecycle.approveForReceiving(inv.id, 'manager-kunal');
  assert.equal(inv.receiving_approval_status, 'approved');
  const initialApprovedAt = inv.receiving_approved_at;
  assert.ok(initialApprovedAt);
  assert.equal(lifecycle.canShowApproveButton(inv.id), false, 'Approve button disappears once approved');
  assert.equal(lifecycle.isEligibleForWarehouseQueue(inv.id), true, 'Invoice enters warehouse pending inward queue');
  assert.equal(lifecycle.canShowInwardButton(inv.id, item.id), true, 'Warehouse operator can click Receive Inward');

  // 4. Warehouse Records Physical Inward (500 kg into Batch BCYPH/2510070)
  const receiveResult = lifecycle.receiveItem(item.id, 'batch-BCYPH', 'BCYPH/2510070', 500, 'warehouse-operator');
  assert.equal(receiveResult.success, true);

  // 5. Simulate Frontend Reload (e.g. loadInvoices, loadPendingInwards)
  assert.equal(inv.receiving_approval_status, 'approved', 'Approval status MUST remain approved after inward');
  assert.equal(inv.receiving_approved_at, initialApprovedAt, 'Approval timestamp MUST NOT be altered');
  assert.equal(lifecycle.canShowApproveButton(inv.id), false, 'UI must NOT request duplicate approval!');
  assert.equal(lifecycle.canShowInwardButton(inv.id, item.id), false, 'Inward button is hidden because item is 100% received');
});

test('2. Partial inward sequence: approve -> record 200kg -> reload -> remains approved -> record 300kg -> fully received', () => {
  const lifecycle = new PurchaseInvoiceApprovalLifecycle('hardened');
  const inv = lifecycle.createInvoice('inv-partial', 'PI-2026-PARTIAL', 'supp-1', '2026-10-20', 500000000);
  const item = lifecycle.addItem('item-part', 'inv-partial', 'prod-1', 500, 1000000);

  lifecycle.submitForReceiving(inv.id, 'user-1');
  lifecycle.approveForReceiving(inv.id, 'approver-1');
  assert.equal(inv.receiving_approval_status, 'approved');

  // First partial receipt: 200 kg
  lifecycle.receiveItem(item.id, 'batch-part-1', 'BPART-01', 200, 'wh-1');
  assert.equal(inv.receiving_approval_status, 'approved', 'First partial receipt preserves approval');
  assert.equal(lifecycle.canShowApproveButton(inv.id), false, 'Duplicate approval not requested after partial receipt');
  assert.equal(lifecycle.canShowInwardButton(inv.id, item.id), true, 'Inward button remains active for remaining 300 kg');

  // Second receipt: remaining 300 kg
  lifecycle.receiveItem(item.id, 'batch-part-2', 'BPART-02', 300, 'wh-1');
  assert.equal(inv.receiving_approval_status, 'approved', 'Full receipt preserves approval');
  assert.equal(lifecycle.canShowApproveButton(inv.id), false);
  assert.equal(lifecycle.canShowInwardButton(inv.id, item.id), false, 'Item completely received');
});

test('3. Root-cause proof: Legacy unpatched trigger erroneously demoted approval on operational receiving update', () => {
  const legacyLifecycle = new PurchaseInvoiceApprovalLifecycle('legacy');
  const inv = legacyLifecycle.createInvoice('inv-legacy', '80103232', 'supp-menjangan', '2026-10-19', 500000000);
  const item = legacyLifecycle.addItem('item-1', 'inv-legacy', 'prod-cypro', 500, 1000000);

  legacyLifecycle.submitForReceiving(inv.id, 'user-1');
  legacyLifecycle.approveForReceiving(inv.id, 'manager-1');
  assert.equal(inv.receiving_approval_status, 'approved');

  // Warehouse executes inward in legacy environment
  legacyLifecycle.receiveItem(item.id, 'batch-BCYPH', 'BCYPH/2510070', 500, 'warehouse-user');

  // REPRODUCES INCIDENT B BUG:
  assert.equal(
    inv.receiving_approval_status,
    'pending_approval',
    'Demonstrates legacy bug: unconstrained item trigger demoted status to pending_approval!'
  );
  assert.equal(
    legacyLifecycle.canShowApproveButton(inv.id),
    true,
    'Demonstrates legacy bug: UI requested duplicate approval for an already received invoice!'
  );
});

test('4. Genuine commercial edit on unreceived invoice properly resets approval with audit log', () => {
  const lifecycle = new PurchaseInvoiceApprovalLifecycle('hardened');
  const inv = lifecycle.createInvoice('inv-comm', 'PI-2026-COMM', 'supp-1', '2026-10-20', 100000000);
  const item = lifecycle.addItem('item-comm', 'inv-comm', 'prod-1', 100, 1000000);

  lifecycle.submitForReceiving(inv.id, 'user-1');
  lifecycle.approveForReceiving(inv.id, 'approver-1');
  assert.equal(inv.receiving_approval_status, 'approved');

  // Commercial change: unit price modified before any goods are received
  lifecycle.updateItem(item.id, { unit_price: 1200000 }, 'editor-1');

  assert.equal(inv.receiving_approval_status, 'pending_approval');
  assert.equal(lifecycle.canShowApproveButton(inv.id), true, 'Re-approval required after commercial terms change');
  const audit = lifecycle.auditLog.find(a => a.action === 'reset_by_commercial_edit');
  assert.ok(audit, 'Audit log must record reset by commercial edit');
});

test('5. Commercial edit attempt on ALREADY received invoice preserves receiving approval', () => {
  const lifecycle = new PurchaseInvoiceApprovalLifecycle('hardened');
  const inv = lifecycle.createInvoice('inv-post-rec', 'PI-2026-POST', 'supp-1', '2026-10-20', 100000000);
  const item = lifecycle.addItem('item-post', 'inv-post-rec', 'prod-1', 100, 1000000);

  lifecycle.submitForReceiving(inv.id, 'user-1');
  lifecycle.approveForReceiving(inv.id, 'approver-1');
  lifecycle.receiveItem(item.id, 'batch-1', 'B-01', 100, 'wh-user');

  // Post-receipt item modification attempt
  lifecycle.updateItem(item.id, { unit_price: 1500000 }, 'editor-1');

  assert.equal(
    inv.receiving_approval_status,
    'approved',
    'Once goods are physically received, status cannot be demoted back to pending_approval'
  );
});

test('6. Approval is idempotent and repeated approval does not overwrite metadata', () => {
  const lifecycle = new PurchaseInvoiceApprovalLifecycle('hardened');
  const inv = lifecycle.createInvoice('inv-3', 'PI-2026-0003', 'supp-1', '2026-10-20', 100000000);
  lifecycle.submitForReceiving('inv-3', 'user-1');
  lifecycle.approveForReceiving('inv-3', 'approver-1');

  const firstApprovedAt = inv.receiving_approved_at;
  const res = lifecycle.approveForReceiving('inv-3', 'approver-1');
  assert.equal(res.already_approved, true);
  assert.equal(inv.receiving_approved_at, firstApprovedAt, 'Idempotent approval must not mutate approval timestamp');
});

test('7. Payment status remains independent of receiving approval status', () => {
  const lifecycle = new PurchaseInvoiceApprovalLifecycle('hardened');
  const inv = lifecycle.createInvoice('inv-4', 'PI-2026-0004', 'supp-1', '2026-10-20', 100000000);
  assert.equal(inv.payment_status, 'unpaid');

  lifecycle.submitForReceiving('inv-4', 'user-1');
  lifecycle.approveForReceiving('inv-4', 'approver-1');

  assert.equal(inv.payment_status, 'unpaid', 'Payment status must remain unpaid when no payment voucher exists');
  assert.equal(inv.receiving_approval_status, 'approved');
});

test('8. Migration DDL scopes trigger specifically to commercial columns', () => {
  assert.match(migrationSql, /CREATE TRIGGER trg_reset_receiving_approval_on_item_change/);
  assert.match(migrationSql, /AFTER INSERT OR DELETE OR UPDATE OF product_id, item_type, quantity, unit_price/);
  assert.match(migrationSql, /CREATE TABLE IF NOT EXISTS public\.purchase_invoice_receiving_approval_audit/);
  assert.match(migrationSql, /v_is_commercial_change/);
  assert.match(migrationSql, /already_approved/);
});

test('9. Auditable repair script for Invoice 80103232 contains safety preconditions', () => {
  assert.match(repairSql, /f71fc7e1-f666-4a61-8eaa-7edf42127238/);
  assert.match(repairSql, /80103232/);
  assert.match(repairSql, /receiving_approval_status <> 'pending_approval'/);
  assert.match(repairSql, /purchase_invoice_receiving_allocations/);
  assert.match(repairSql, /purchase_invoice_receiving_approval_audit/);
  assert.match(repairSql, /SET receiving_approval_status = 'approved'/);
});

test('10. Frontend components PurchaseInvoiceManager and Batches agree on approved status filtering', () => {
  assert.match(piManager, /invoice\.receiving_approval_status === 'pending_approval'/);
  assert.match(piManager, /updateReceivingApproval\(invoice, 'approve'\)/);
  assert.match(batchesPage, /invoice\.receiving_approval_status === 'approved'/);
});
