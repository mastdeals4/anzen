import { strict as assert } from 'node:assert';
import { execSync } from 'node:child_process';
import fs from 'node:fs';

function runSql(sql) {
  fs.writeFileSync('/tmp/test_pi_batch.sql', sql);
  const out = execSync('npx supabase db query --linked --file /tmp/test_pi_batch.sql --output-format json', {
    encoding: 'utf8',
    maxBuffer: 10 * 1024 * 1024,
  });
  const jsonStart = out.indexOf('{');
  if (jsonStart !== -1) {
    const parsed = JSON.parse(out.slice(jsonStart, out.lastIndexOf('}') + 1));
    return parsed.rows || [];
  }
  return [];
}

console.log('--- Running Purchase Invoice Batch Linking Regression Tests ---');

// Test 1: Verify all historical inventory lines in live DB have a non-null batch_id
console.log('Test 1: Check live DB historical inventory PI lines have non-null batch_id...');
const nullBatchItems = runSql(`
  SELECT pii.id, pii.item_type, pii.receiving_batch_number, pi.invoice_number 
  FROM purchase_invoice_items pii
  JOIN purchase_invoices pi ON pi.id = pii.purchase_invoice_id
  WHERE pii.item_type = 'inventory' AND pii.batch_id IS NULL;
`);
assert.strictEqual(nullBatchItems.length, 0, `Expected 0 NULL batch_id lines, found ${nullBatchItems.length}`);
console.log('✓ Test 1 Passed: 0 inventory PI lines with NULL batch_id in database.');

// Test 2: Verify known audit examples resolve to valid batches
console.log('Test 2: Check known audit examples...');
const knownExamples = [
  { pi: 'E0000167/2627', batch: 'XMAL260006' },
  { pi: 'FP26090322', batch: 'DFS/126030158' },
  { pi: '017/KTT/IX/2026', batch: 'DFS/126010052' },
  { pi: '017/KTT/IX/2026', batch: 'DFS/125120554' },
];

for (const ex of knownExamples) {
  const rows = runSql(`
    SELECT pii.id, pii.batch_id, b.batch_number, pii.receiving_batch_number, pi.invoice_number
    FROM purchase_invoice_items pii
    JOIN purchase_invoices pi ON pi.id = pii.purchase_invoice_id
    JOIN batches b ON b.id = pii.batch_id
    WHERE pi.invoice_number = '${ex.pi}' AND pii.receiving_batch_number = '${ex.batch}';
  `);
  assert.ok(rows.length > 0, `Expected line for invoice ${ex.pi} and batch ${ex.batch}`);
  assert.ok(rows[0].batch_id, `Expected batch_id to be populated for ${ex.pi}`);
  assert.strictEqual(rows[0].batch_number, ex.batch, `Expected batch_number to match ${ex.batch}`);
}
console.log('✓ Test 2 Passed: All known audit examples properly resolved to batches.id.');

// Test 3: RPC test save_purchase_invoice resolves existing batch and creates new batch on unknown batch
console.log('Test 3: Testing save_purchase_invoice resolution & creation logic in transaction...');
const rpcTestResult = runSql(`
DO $$
DECLARE
  v_supplier_id uuid;
  v_product_id uuid;
  v_existing_batch_id uuid;
  v_pi_id uuid;
  v_pi_data jsonb;
  v_items jsonb;
  v_resolved_batch_id_1 uuid;
  v_resolved_batch_id_2 uuid;
  v_resolved_batch_id_3 uuid;
  v_resolved_batch_id_4 uuid;
BEGIN
  SELECT id INTO v_supplier_id FROM suppliers LIMIT 1;
  SELECT id INTO v_product_id FROM products LIMIT 1;
  
  -- Pick or create an existing test batch
  SELECT id INTO v_existing_batch_id FROM batches WHERE product_id = v_product_id LIMIT 1;
  IF v_existing_batch_id IS NULL THEN
    INSERT INTO batches (product_id, batch_number, is_active)
    VALUES (v_product_id, 'REG-EXISTING-001', true)
    RETURNING id INTO v_existing_batch_id;
  END IF;

  -- Test Case A: Create PI with existing batch number
  DECLARE
    v_pi_num_1 text := 'TEST-PI-' || floor(random()*10000000)::text;
  BEGIN
    v_pi_data := jsonb_build_object(
      'invoice_number', v_pi_num_1,
      'supplier_id', v_supplier_id,
      'invoice_date', CURRENT_DATE,
      'currency', 'IDR',
      'exchange_rate', 1,
      'subtotal', 100000,
      'total_amount', 100000
    );

    v_items := jsonb_build_array(
      jsonb_build_object(
        'item_type', 'inventory',
        'product_id', v_product_id,
        'description', 'Line 1 Existing Batch',
        'quantity', 10,
        'unit', 'pcs',
        'unit_price', 10000,
        'line_total', 100000,
        'receiving_batch_number', (SELECT batch_number FROM batches WHERE id = v_existing_batch_id)
      )
    );

    v_pi_id := (save_purchase_invoice_with_receiving_details(NULL::uuid, NULL::uuid, v_pi_data, v_items)->>'invoice_id')::uuid;
    SELECT batch_id INTO v_resolved_batch_id_1 FROM purchase_invoice_items WHERE purchase_invoice_id = v_pi_id LIMIT 1;
    IF v_resolved_batch_id_1 IS NULL OR v_resolved_batch_id_1 != v_existing_batch_id THEN
      RAISE EXCEPTION 'Test failed: expected existing batch %, got %', v_existing_batch_id, v_resolved_batch_id_1;
    END IF;

    -- Clean up test PI 1
    DELETE FROM purchase_invoice_items WHERE purchase_invoice_id = v_pi_id;
    DELETE FROM purchase_invoices WHERE id = v_pi_id;
    DELETE FROM journal_entry_lines WHERE journal_entry_id IN (SELECT id FROM journal_entries WHERE reference_number = v_pi_num_1);
    DELETE FROM journal_entries WHERE reference_number = v_pi_num_1;
  END;

  -- Test Case B: Multiple lines with same batch number get same batch_id on creation
  DECLARE
    v_pi_id_2 uuid;
    v_pi_num_2 text := 'TEST-PI-' || floor(random()*10000000)::text;
  BEGIN
    v_items := jsonb_build_array(
      jsonb_build_object(
        'item_type', 'inventory',
        'product_id', v_product_id,
        'description', 'Line 1',
        'quantity', 5,
        'unit', 'pcs',
        'unit_price', 10000,
        'line_total', 50000,
        'receiving_batch_number', (SELECT batch_number FROM batches WHERE id = v_existing_batch_id)
      ),
      jsonb_build_object(
        'item_type', 'inventory',
        'product_id', v_product_id,
        'description', 'Line 2 Same Batch',
        'quantity', 5,
        'unit', 'pcs',
        'unit_price', 10000,
        'line_total', 50000,
        'receiving_batch_number', (SELECT batch_number FROM batches WHERE id = v_existing_batch_id)
      )
    );
    v_pi_data := jsonb_build_object(
      'invoice_number', v_pi_num_2,
      'supplier_id', v_supplier_id,
      'invoice_date', CURRENT_DATE,
      'currency', 'IDR',
      'exchange_rate', 1,
      'subtotal', 100000,
      'total_amount', 100000
    );
    v_pi_id_2 := (save_purchase_invoice_with_receiving_details(NULL::uuid, NULL::uuid, v_pi_data, v_items)->>'invoice_id')::uuid;
    
    IF (SELECT count(DISTINCT batch_id) FROM purchase_invoice_items WHERE purchase_invoice_id = v_pi_id_2) != 1 THEN
      RAISE EXCEPTION 'Test failed: multiple lines did not get same batch_id';
    END IF;

    DELETE FROM purchase_invoice_items WHERE purchase_invoice_id = v_pi_id_2;
    DELETE FROM purchase_invoices WHERE id = v_pi_id_2;
    DELETE FROM journal_entry_lines WHERE journal_entry_id IN (SELECT id FROM journal_entries WHERE reference_number = v_pi_num_2);
    DELETE FROM journal_entries WHERE reference_number = v_pi_num_2;
  END;

  -- Test Case C: Unknown batch behavior (creates a new batch record automatically)
  DECLARE
    v_unknown_batch_no text := 'NEW-BATCH-' || floor(random()*1000000)::text;
    v_pi_id_3 uuid;
    v_pi_num_3 text := 'TEST-PI-' || floor(random()*10000000)::text;
    v_new_created_batch_id uuid;
  BEGIN
    v_pi_data := jsonb_build_object(
      'invoice_number', v_pi_num_3,
      'supplier_id', v_supplier_id,
      'invoice_date', CURRENT_DATE,
      'currency', 'IDR',
      'exchange_rate', 1,
      'subtotal', 150000,
      'total_amount', 150000
    );
    v_items := jsonb_build_array(
      jsonb_build_object(
        'item_type', 'inventory',
        'product_id', v_product_id,
        'description', 'Line Unknown Batch',
        'quantity', 15,
        'unit', 'kg',
        'unit_price', 10000,
        'line_total', 150000,
        'receiving_batch_number', v_unknown_batch_no
      )
    );
    v_pi_id_3 := (save_purchase_invoice_with_receiving_details(NULL::uuid, NULL::uuid, v_pi_data, v_items)->>'invoice_id')::uuid;
    SELECT batch_id INTO v_new_created_batch_id FROM purchase_invoice_items WHERE purchase_invoice_id = v_pi_id_3 LIMIT 1;
    IF v_new_created_batch_id IS NULL THEN
      RAISE EXCEPTION 'Test failed: unknown batch did not create or assign a batch_id';
    END IF;
    IF (SELECT batch_number FROM batches WHERE id = v_new_created_batch_id) != v_unknown_batch_no THEN
      RAISE EXCEPTION 'Test failed: created batch_number does not match %', v_unknown_batch_no;
    END IF;

    -- Test Case D: Edit PI and change batch number
    -- Now edit v_pi_id_3 to switch the line to v_existing_batch_id
    DECLARE
      v_pi_item_id uuid;
    BEGIN
      SELECT id INTO v_pi_item_id FROM purchase_invoice_items WHERE purchase_invoice_id = v_pi_id_3 LIMIT 1;
      v_items := jsonb_build_array(
        jsonb_build_object(
          'id', v_pi_item_id,
          'item_type', 'inventory',
          'product_id', v_product_id,
          'description', 'Line Edited to Existing Batch',
          'quantity', 15,
          'unit', 'kg',
          'unit_price', 10000,
          'line_total', 150000,
          'receiving_batch_number', (SELECT batch_number FROM batches WHERE id = v_existing_batch_id)
        )
      );
      PERFORM save_purchase_invoice_with_receiving_details(v_pi_id_3, NULL::uuid, v_pi_data, v_items);

      IF (SELECT batch_id FROM purchase_invoice_items WHERE id = v_pi_item_id) != v_existing_batch_id THEN
        RAISE EXCEPTION 'Test failed: editing PI did not update batch_id to changed batch %', v_existing_batch_id;
      END IF;
    END;

    -- Cleanup test PI 3 and temporary created batch
    DELETE FROM purchase_invoice_items WHERE purchase_invoice_id = v_pi_id_3;
    DELETE FROM batches WHERE id = v_new_created_batch_id;
    DELETE FROM purchase_invoices WHERE id = v_pi_id_3;
    DELETE FROM journal_entry_lines WHERE journal_entry_id IN (SELECT id FROM journal_entries WHERE reference_number = v_pi_num_3);
    DELETE FROM journal_entries WHERE reference_number = v_pi_num_3;
  END;

END $$;
`);

console.log('✓ Test 3 Passed: save_purchase_invoice RPC successfully handles create, edit, same batch, change batch, and unknown batch.');
console.log('--- All Purchase Invoice Batch Linking Regression Tests PASSED ---');

