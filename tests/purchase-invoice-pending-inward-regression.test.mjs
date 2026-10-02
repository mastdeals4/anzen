import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { execSync } from 'node:child_process';

const migration = fs.readFileSync('supabase/migrations/20261002133000_fix_purchase_invoice_pending_inward_batch_fallback.sql', 'utf8');

function runSql(sql) {
  const tmpFile = 'tests/.tmp_pi_pending_inward.sql';
  fs.writeFileSync(tmpFile, sql);
  try {
    const out = execSync(`npx supabase db query --linked --file ${tmpFile} --output-format json`, {
      encoding: 'utf8',
      maxBuffer: 10 * 1024 * 1024,
    });
    const jsonStart = out.indexOf('{');
    if (jsonStart !== -1) {
      const parsed = JSON.parse(out.slice(jsonStart, out.lastIndexOf('}') + 1));
      return parsed.rows || [];
    }
    return [];
  } finally {
    if (fs.existsSync(tmpFile)) fs.unlinkSync(tmpFile);
  }
}

test('migration specifies strict guards on purchase_invoice_item_received_quantity', () => {
  // A batch with current_stock = 0 and no transactions must NOT be treated as received
  assert.match(migration, /COALESCE\(v_batch\.current_stock,\s*0\)\s*=\s*0/);
  assert.match(migration, /NOT EXISTS\s*\(\s*SELECT 1 FROM public\.inventory_transactions it WHERE it\.batch_id = v_batch\.id\s*\)/);
  // Current PI receiving items must not use legacy batch share fallback
  assert.match(migration, /COALESCE\(v_invoice\.receiving_approval_status,\s*''\)\s*<>\s*''/);
});

test('migration handles pre-created skeleton batches properly in receive_purchase_invoice_item', () => {
  // Sets import_quantity to received quantity (not double adding)
  assert.match(migration, /import_quantity\s*=\s*p_received_quantity/);
  // Posts 'purchase' movement for first receipt into pre-created batch
  assert.match(migration, /'purchase',\s*p_received_quantity/);
  // Posts 'adjustment' for existing batches with prior receipts
  assert.match(migration, /'adjustment',\s*p_received_quantity/);
});

test('Live DB check: FJ1-2610001 shows 250 KG pending inward and batch 2610892 remains at current stock 0', () => {
  const rows = runSql(`
    SELECT
      pi.invoice_number,
      pii.id as item_id,
      pii.quantity,
      b.batch_number,
      b.import_quantity,
      b.current_stock,
      (SELECT count(*) FROM inventory_transactions it WHERE it.batch_id = b.id) as tx_count,
      (SELECT count(*) FROM purchase_invoice_receiving_allocations a WHERE a.purchase_invoice_item_id = pii.id) as alloc_count,
      public.purchase_invoice_item_received_quantity(pii.id) as received_qty
    FROM purchase_invoice_items pii
    JOIN purchase_invoices pi ON pi.id = pii.purchase_invoice_id
    LEFT JOIN batches b ON b.id = pii.batch_id
    WHERE pi.invoice_number = 'FJ1-2610001';
  `);

  assert.equal(rows.length, 1, 'Expected exactly 1 item for FJ1-2610001');
  const r = rows[0];
  assert.equal(Number(r.quantity), 250, 'Invoice item quantity must be 250');
  assert.equal(Number(r.received_qty), 0, 'Received quantity must be 0 before physical inward');
  assert.equal(Number(r.quantity) - Number(r.received_qty), 250, 'Pending inward must be 250 KG');
  assert.equal(r.batch_number, '2610892', 'Batch number must be 2610892');
  assert.equal(Number(r.current_stock), 0, 'Current stock must remain 0 before inward approval');
  assert.equal(Number(r.import_quantity), 250, 'Batch import_quantity must remain 250');
  assert.equal(Number(r.tx_count), 0, 'No inventory transactions should exist yet');
  assert.equal(Number(r.alloc_count), 0, 'No receiving allocations should exist yet');
});

test('Transactional simulation: Inward approval creates purchase tx, stock becomes 250, import_qty is 250, and received is 250', () => {
  const tmpFile = 'tests/.tmp_sim_inward.sql';
  fs.writeFileSync(tmpFile, `
    DO $test$
    DECLARE
      v_item_id uuid := '4c8958d1-9831-436e-aa4f-631c686de259';
      v_batch_id uuid := 'fb1c88e9-ac76-45f1-a0a7-56e05dff93ab';
      v_op_id uuid := gen_random_uuid();
      v_res jsonb;
      v_tx public.inventory_transactions%ROWTYPE;
      v_batch public.batches%ROWTYPE;
      v_received numeric;
    BEGIN
      SELECT * INTO v_batch FROM batches WHERE id = v_batch_id;
      IF v_batch.current_stock <> 0 THEN
        RAISE EXCEPTION 'Precondition failed: current_stock is %, expected 0', v_batch.current_stock;
      END IF;

      v_res := public.receive_purchase_invoice_item(
        v_item_id,
        jsonb_build_object(
          'product_id', v_batch.product_id,
          'make_id', v_batch.make_id,
          'batch_id', v_batch_id,
          'batch_number', v_batch.batch_number,
          'import_date', CURRENT_DATE,
          'import_quantity', 250
        ),
        250,
        v_op_id
      );

      SELECT * INTO v_batch FROM batches WHERE id = v_batch_id;
      IF v_batch.current_stock <> 250 THEN
        RAISE EXCEPTION 'Postcondition failed: current_stock is %, expected 250', v_batch.current_stock;
      END IF;
      IF v_batch.import_quantity <> 250 THEN
        RAISE EXCEPTION 'Postcondition failed: import_quantity is %, expected 250', v_batch.import_quantity;
      END IF;

      SELECT * INTO v_tx FROM inventory_transactions WHERE operation_id = v_op_id;
      IF NOT FOUND THEN
        RAISE EXCEPTION 'Postcondition failed: inventory_transaction not found';
      END IF;
      IF v_tx.quantity <> 250 THEN
        RAISE EXCEPTION 'Postcondition failed: tx quantity is %, expected 250', v_tx.quantity;
      END IF;
      IF v_tx.transaction_type <> 'purchase' THEN
        RAISE EXCEPTION 'Postcondition failed: tx transaction_type is %, expected purchase', v_tx.transaction_type;
      END IF;

      v_received := public.purchase_invoice_item_received_quantity(v_item_id);
      IF v_received <> 250 THEN
        RAISE EXCEPTION 'Postcondition failed: received_quantity is %, expected 250', v_received;
      END IF;

      RAISE EXCEPTION 'ROLLBACK_TEST_PASSED';
    END $test$;
  `);

  try {
    let passed = false;
    try {
      execSync(`npx supabase db query --linked --file ${tmpFile}`, { encoding: 'utf8' });
    } catch (err) {
      const allText = [err.message, err.stdout, err.stderr].filter(Boolean).join(' ');
      if (allText.includes('ROLLBACK_TEST_PASSED')) {
        passed = true;
      } else {
        throw err;
      }
    }
    assert.equal(passed, true, 'Inward approval simulation should pass all assertions and rollback');
  } finally {
    if (fs.existsSync(tmpFile)) fs.unlinkSync(tmpFile);
  }
});
