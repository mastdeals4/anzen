import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import pg from 'pg';

const { Pool, Client } = pg;
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const rootDir = path.resolve(__dirname, '..');

const PG_CONFIG = {
  host: '/tmp',
  port: 54329,
  database: 'test_migration_db',
  user: process.env.USER || 'Kunal',
};

// Helper to execute SQL file using psql
import { execFileSync } from 'node:child_process';

function runPsqlFile(filePath, db = 'test_migration_db') {
  execFileSync('/usr/local/bin/psql', [
    '-h', PG_CONFIG.host,
    '-p', String(PG_CONFIG.port),
    '-d', db,
    '-f', filePath,
    '-v', 'ON_ERROR_STOP=1'
  ], { encoding: 'utf8' });
}

function runPsqlCommand(sql, db = 'test_migration_db') {
  return execFileSync('/usr/local/bin/psql', [
    '-h', PG_CONFIG.host,
    '-p', String(PG_CONFIG.port),
    '-d', db,
    '-c', sql,
    '-v', 'ON_ERROR_STOP=1'
  ], { encoding: 'utf8' });
}

test.describe('Real PostgreSQL Migration, View Compatibility & Concurrency Verification', () => {
  let pool;

  test.before(() => {
    // Recreate fresh test database
    try {
      runPsqlCommand('DROP DATABASE IF EXISTS test_migration_db;', 'postgres');
      runPsqlCommand('CREATE DATABASE test_migration_db;', 'postgres');
      runPsqlFile(path.join(rootDir, 'tests/fixtures/production-schema-baseline.sql'));
      runPsqlFile(path.join(rootDir, 'supabase/migrations/20261030120000_sales_invoice_canonical_lifecycle_and_reporting_hardening.sql'));
      runPsqlFile(path.join(rootDir, 'supabase/migrations/20261030130000_sales_cancellation_hardening_corrections.sql'));
      runPsqlFile(path.join(rootDir, 'supabase/migrations/20261030140000_sales_lifecycle_terminal_cancellation_and_concurrency_hardening.sql'));
    } catch (err) {
      console.error('Setup failed:', err);
      throw err;
    }

    pool = new Pool(PG_CONFIG);
  });

  test.after(async () => {
    if (pool) {
      await pool.end();
    }
  });

  test('1. Migration in-order application succeeds and view column shapes strictly match production', async () => {
    const res = await pool.query(`
      SELECT table_name, column_name, ordinal_position, data_type 
      FROM information_schema.columns 
      WHERE table_name IN ('so_delivery_invoice_status', 'dc_invoicing_summary', 'so_delivery_invoice_financial_summary_v2')
      ORDER BY table_name, ordinal_position;
    `);

    const soStatusCols = res.rows.filter(r => r.table_name === 'so_delivery_invoice_status');
    const dcSummaryCols = res.rows.filter(r => r.table_name === 'dc_invoicing_summary');
    const soSummaryV2Cols = res.rows.filter(r => r.table_name === 'so_delivery_invoice_financial_summary_v2');

    // Expected 12 columns for so_delivery_invoice_status
    assert.equal(soStatusCols.length, 12, 'so_delivery_invoice_status must have exactly 12 columns');
    const expectedSoCols = [
      'so_id', 'so_number', 'customer_id', 'so_status',
      'delivery_status', 'invoice_status', 'special_status',
      'approved_dc_count', 'invoice_count', 'ordered_qty',
      'approved_delivered_qty', 'invoiced_qty'
    ];
    assert.deepEqual(soStatusCols.map(c => c.column_name), expectedSoCols);

    // Expected 13 columns for dc_invoicing_summary
    assert.equal(dcSummaryCols.length, 13, 'dc_invoicing_summary must have exactly 13 columns');
    const expectedDcCols = [
      'challan_id', 'challan_number', 'customer_id', 'challan_date',
      'approval_status', 'total_items', 'not_invoiced_items',
      'invoiced_items', 'total_quantity', 'total_remaining_quantity',
      'dc_status', 'linked_invoices', 'linked_invoice_numbers'
    ];
    assert.deepEqual(dcSummaryCols.map(c => c.column_name), expectedDcCols);

    // Expected 14 columns for so_delivery_invoice_financial_summary_v2
    assert.equal(soSummaryV2Cols.length, 14, 'so_delivery_invoice_financial_summary_v2 must have 14 columns');
  });

  test('2. Multiple invoice lines per DC item and multiple invoices do not cause Cartesian quantity inflation', async () => {
    const client = await pool.connect();
    try {
      await client.query('BEGIN');

      // Create test user, customer, product, batch, SO, DC
      const userId = '00000000-0000-0000-0000-000000000001';
      await client.query(`
        INSERT INTO user_profiles (id, role, full_name)
        VALUES ('${userId}', 'admin', 'Test Admin')
        ON CONFLICT (id) DO NOTHING;
      `);

      const custRes = await client.query(`
        INSERT INTO customers (company_name) VALUES ('Test Customer Multi') RETURNING id;
      `);
      const custId = custRes.rows[0].id;

      const prodRes = await client.query(`
        INSERT INTO products (product_name, product_code) VALUES ('API Multi Prod', 'AMP-01') RETURNING id;
      `);
      const prodId = prodRes.rows[0].id;

      const batchRes = await client.query(`
        INSERT INTO batches (product_id, batch_number, landed_cost_per_unit, cost_per_unit, current_stock)
        VALUES ('${prodId}', 'B-MULTI-01', 50000, 50000, 100) RETURNING id;
      `);
      const batchId = batchRes.rows[0].id;

      const soRes = await client.query(`
        INSERT INTO sales_orders (so_number, customer_id, total_amount)
        VALUES ('SO-MULTI-001', '${custId}', 1000000) RETURNING id;
      `);
      const soId = soRes.rows[0].id;

      const dcRes = await client.query(`
        INSERT INTO delivery_challans (challan_number, customer_id, sales_order_id, approval_status)
        VALUES ('DC-MULTI-001', '${custId}', '${soId}', 'approved') RETURNING id;
      `);
      const dcId = dcRes.rows[0].id;

      const dciRes = await client.query(`
        INSERT INTO delivery_challan_items (challan_id, product_id, batch_id, quantity)
        VALUES ('${dcId}', '${prodId}', '${batchId}', 30) RETURNING id;
      `);
      const dciId = dciRes.rows[0].id;

      // Create Invoice 1 with TWO lines referencing the SAME DC item (10 kg + 10 kg = 20 kg)
      const inv1Res = await client.query(`
        INSERT INTO sales_invoices (
          invoice_number, customer_id, sales_order_id, document_status,
          is_draft, linked_challan_ids, total_amount
        ) VALUES (
          'INV-MULTI-001', '${custId}', '${soId}', 'posted',
          false, ARRAY['${dcId}'], 500000
        ) RETURNING id;
      `);
      const inv1Id = inv1Res.rows[0].id;

      await client.query(`
        INSERT INTO sales_invoice_items (invoice_id, product_id, batch_id, quantity, unit_price, delivery_challan_item_id)
        VALUES ('${inv1Id}', '${prodId}', '${batchId}', 10, 25000, '${dciId}'),
               ('${inv1Id}', '${prodId}', '${batchId}', 10, 25000, '${dciId}');
      `);

      // Create Invoice 2 with ONE line referencing the SAME DC item (10 kg)
      const inv2Res = await client.query(`
        INSERT INTO sales_invoices (
          invoice_number, customer_id, sales_order_id, document_status,
          is_draft, linked_challan_ids, total_amount
        ) VALUES (
          'INV-MULTI-002', '${custId}', '${soId}', 'posted',
          false, ARRAY['${dcId}'], 250000
        ) RETURNING id;
      `);
      const inv2Id = inv2Res.rows[0].id;

      await client.query(`
        INSERT INTO sales_invoice_items (invoice_id, product_id, batch_id, quantity, unit_price, delivery_challan_item_id)
        VALUES ('${inv2Id}', '${prodId}', '${batchId}', 10, 25000, '${dciId}');
      `);

      // Query dc_invoicing_summary view
      const summaryRes = await client.query(`
        SELECT * FROM dc_invoicing_summary WHERE challan_id = '${dcId}';
      `);
      assert.equal(summaryRes.rowCount, 1);
      const row = summaryRes.rows[0];

      // Verification:
      // total_quantity must be exactly 30 (not multiplied)
      assert.equal(Number(row.total_quantity), 30, 'Total quantity must remain 30');
      // invoiced: 10 + 10 + 10 = 30 -> remaining = 0
      assert.equal(Number(row.total_remaining_quantity), 0, 'Remaining quantity must be 0 after 30kg invoiced');
      assert.equal(row.dc_status, 'fully_invoiced', 'DC status must be fully_invoiced');
      assert.equal(Number(row.total_items), 1, 'Total items must be 1');
      assert.equal(Number(row.invoiced_items), 1, 'Invoiced items must be 1');
      assert.equal(Number(row.not_invoiced_items), 0, 'Not invoiced items must be 0');

      // Arrays should contain the distinct invoices without Cartesian explosion
      assert.equal(row.linked_invoices.length, 2, 'Should have 2 linked invoices');
      assert.equal(row.linked_invoice_numbers.length, 2, 'Should have 2 linked invoice numbers');
      assert(row.linked_invoice_numbers.includes('INV-MULTI-001'));
      assert(row.linked_invoice_numbers.includes('INV-MULTI-002'));

      await client.query('ROLLBACK');
    } catch (err) {
      await client.query('ROLLBACK');
      throw err;
    } finally {
      client.release();
    }
  });

  test('3. Concurrency with real independent PostgreSQL sessions enforces row-level locking', async () => {
    // Connect two independent clients
    const clientA = new Client(PG_CONFIG);
    const clientB = new Client(PG_CONFIG);
    await clientA.connect();
    await clientB.connect();

    try {
      // Setup customer, product, batch, SO, DC
      const setupRes = await clientA.query(`
        WITH c AS (INSERT INTO customers (company_name) VALUES ('Concurrency Cust') RETURNING id),
             p AS (INSERT INTO products (product_name) VALUES ('Concurrency Prod') RETURNING id),
             b AS (INSERT INTO batches (product_id, batch_number, current_stock) 
                   SELECT p.id, 'B-LOCK-1', 100 FROM p RETURNING id),
             so AS (INSERT INTO sales_orders (so_number, customer_id) 
                    SELECT 'SO-LOCK-1', c.id FROM c RETURNING id),
             dc AS (INSERT INTO delivery_challans (challan_number, customer_id, sales_order_id, approval_status)
                    SELECT 'DC-LOCK-1', c.id, so.id, 'approved' FROM c, so RETURNING id)
        INSERT INTO delivery_challan_items (challan_id, product_id, batch_id, quantity)
        SELECT dc.id, p.id, b.id, 50 FROM dc, p, b RETURNING id, challan_id;
      `);
      const dciId = setupRes.rows[0].id;
      const dcId = setupRes.rows[0].challan_id;

      // Session A locks the delivery challan item FOR UPDATE
      await clientA.query('BEGIN');
      await clientA.query(`SELECT * FROM delivery_challan_items WHERE id = '${dciId}' FOR UPDATE;`);

      // Session B attempts to lock the same delivery challan item with a 500ms lock timeout
      await clientB.query('BEGIN');
      await clientB.query('SET lock_timeout = 300;');

      let lockFailed = false;
      try {
        await clientB.query(`SELECT * FROM delivery_challan_items WHERE id = '${dciId}' FOR UPDATE;`);
      } catch (err) {
        lockFailed = true;
        assert(err.message.includes('canceling statement due to lock timeout') || err.code === '55P03');
      }
      assert.equal(lockFailed, true, 'Session B must be blocked and time out while Session A holds lock');

      await clientB.query('ROLLBACK');
      await clientA.query('ROLLBACK');
    } finally {
      await clientA.end();
      await clientB.end();
    }
  });

  test('4. Delivery Challan cancellation is blocked by active sales invoice and allowed after invoice cancellation', async () => {
    const client = await pool.connect();
    try {
      await client.query('BEGIN');

      const adminId = '00000000-0000-0000-0000-000000000001';

      const custRes = await client.query(`
        INSERT INTO customers (company_name) VALUES ('DC Block Test Cust') RETURNING id;
      `);
      const custId = custRes.rows[0].id;

      const soRes = await client.query(`
        INSERT INTO sales_orders (so_number, customer_id) VALUES ('SO-DC-BLOCK', '${custId}') RETURNING id;
      `);
      const soId = soRes.rows[0].id;

      const dcRes = await client.query(`
        INSERT INTO delivery_challans (challan_number, customer_id, sales_order_id, approval_status)
        VALUES ('DC-BLOCK-001', '${custId}', '${soId}', 'approved') RETURNING id;
      `);
      const dcId = dcRes.rows[0].id;

      const prodRes = await client.query(`
        INSERT INTO products (product_name) VALUES ('DC Block Prod') RETURNING id;
      `);
      const prodId = prodRes.rows[0].id;

      const batchRes = await client.query(`
        INSERT INTO batches (product_id, batch_number, current_stock) VALUES ('${prodId}', 'B-DC-BLOCK', 50) RETURNING id;
      `);
      const batchId = batchRes.rows[0].id;

      const dciRes = await client.query(`
        INSERT INTO delivery_challan_items (challan_id, product_id, batch_id, quantity)
        VALUES ('${dcId}', '${prodId}', '${batchId}', 20) RETURNING id;
      `);
      const dciId = dciRes.rows[0].id;

      // Active posted invoice exists
      const invRes = await client.query(`
        INSERT INTO sales_invoices (invoice_number, customer_id, sales_order_id, document_status, is_draft, linked_challan_ids)
        VALUES ('INV-ACTIVE-DC', '${custId}', '${soId}', 'posted', false, ARRAY['${dcId}']) RETURNING id;
      `);
      const invId = invRes.rows[0].id;

      await client.query(`
        INSERT INTO sales_invoice_items (invoice_id, product_id, batch_id, quantity, delivery_challan_item_id)
        VALUES ('${invId}', '${prodId}', '${batchId}', 20, '${dciId}');
      `);

      // Attempting to cancel DC must fail because active invoice exists
      let dcCancelFailed = false;
      await client.query('SAVEPOINT sp_dc_cancel;');
      try {
        await client.query(`
          SELECT fn_cancel_delivery_challan('${dcId}', '${adminId}', 'Test reason');
        `);
      } catch (err) {
        dcCancelFailed = true;
        await client.query('ROLLBACK TO SAVEPOINT sp_dc_cancel;');
        assert(err.message.includes('active sales invoice') || err.message.includes('Cannot cancel delivery challan'));
      }
      assert.equal(dcCancelFailed, true, 'fn_cancel_delivery_challan must raise exception when active invoice exists');

      // Now cancel the invoice
      await client.query(`
        SELECT cancel_sales_invoice('${invId}', 'Customer requested cancellation', '${adminId}');
      `);

      // DC cancellation should now succeed
      await client.query(`
        SELECT fn_cancel_delivery_challan('${dcId}', '${adminId}', 'Test reason after inv cancelled');
      `);

      // Verify DC approval_status is now cancelled
      const verifyDc = await client.query(`SELECT approval_status FROM delivery_challans WHERE id = '${dcId}';`);
      assert.equal(verifyDc.rows[0].approval_status, 'cancelled');

      await client.query('ROLLBACK');
    } catch (err) {
      await client.query('ROLLBACK');
      throw err;
    } finally {
      client.release();
    }
  });

  test('5. Atomic rollback occurs when validation fails during invoice creation', async () => {
    const client = await pool.connect();
    try {
      await client.query('BEGIN');

      const adminId = '00000000-0000-0000-0000-000000000001';
      const custRes = await client.query(`
        INSERT INTO customers (company_name) VALUES ('Rollback Cust') RETURNING id;
      `);
      const custId = custRes.rows[0].id;

      const prodRes = await client.query(`
        INSERT INTO products (product_name) VALUES ('Rollback Prod') RETURNING id;
      `);
      const prodId = prodRes.rows[0].id;

      const batchRes = await client.query(`
        INSERT INTO batches (product_id, batch_number, current_stock) VALUES ('${prodId}', 'B-RB-01', 50) RETURNING id;
      `);
      const batchId = batchRes.rows[0].id;

      const soRes = await client.query(`
        INSERT INTO sales_orders (so_number, customer_id) VALUES ('SO-RB-01', '${custId}') RETURNING id;
      `);
      const soId = soRes.rows[0].id;

      const dcRes = await client.query(`
        INSERT INTO delivery_challans (challan_number, customer_id, sales_order_id, approval_status)
        VALUES ('DC-RB-001', '${custId}', '${soId}', 'approved') RETURNING id;
      `);
      const dcId = dcRes.rows[0].id;

      const dciRes = await client.query(`
        INSERT INTO delivery_challan_items (challan_id, product_id, batch_id, quantity)
        VALUES ('${dcId}', '${prodId}', '${batchId}', 10) RETURNING id;
      `);
      const dciId = dciRes.rows[0].id;

      // Set authenticated user context
      await client.query(`SET LOCAL request.jwt.claim.sub = '${adminId}';`);

      // Attempt to create invoice asking for 15 kg when DC item has only 10 kg
      let createFailed = false;
      await client.query('SAVEPOINT sp_inv_create;');
      try {
        await client.query(`
          SELECT create_sales_invoice_atomic(
            '{"invoice_number": "INV-FAIL-01", "customer_id": "${custId}", "sales_order_id": "${soId}", "document_status": "posted"}'::jsonb,
            '[{"product_id": "${prodId}", "batch_id": "${batchId}", "delivery_challan_item_id": "${dciId}", "quantity": 15, "unit_price": 100}]'::jsonb
          );
        `);
      } catch (err) {
        createFailed = true;
        await client.query('ROLLBACK TO SAVEPOINT sp_inv_create;');
        assert(err.message.includes('exceeds available remaining quantity') || err.message.includes('exceeds'));
      }
      assert.equal(createFailed, true, 'Must reject quantity exceeding remaining quantity');

      // Verify that no invoice was inserted (atomic transaction)
      const countRes = await client.query(`
        SELECT count(*) as cnt FROM sales_invoices WHERE invoice_number = 'INV-FAIL-01';
      `);
      assert.equal(Number(countRes.rows[0].cnt), 0, 'No rows should be inserted after failed validation');

      await client.query('ROLLBACK');
    } catch (err) {
      await client.query('ROLLBACK');
      throw err;
    } finally {
      client.release();
    }
  });

  test('6. Role Authorization: rejects NULL role, unprivileged role, and prevents actor spoofing', async () => {
    const client = await pool.connect();
    try {
      await client.query('BEGIN');

      const nonExistentUserId = '00000000-0000-0000-0000-000000000999';
      const warehouseUserId = '00000000-0000-0000-0000-000000000002'; // warehouse user
      const viewerUserId = '00000000-0000-0000-0000-000000000003'; // viewer user

      // 1. cancel_sales_invoice with unknown user (NULL role)
      let cancelUnknownFailed = false;
      await client.query('SAVEPOINT sp_auth_1;');
      try {
        await client.query(`
          SELECT cancel_sales_invoice('00000000-0000-0000-0000-000000000001'::uuid, 'reason', '${nonExistentUserId}'::uuid);
        `);
      } catch (err) {
        cancelUnknownFailed = true;
        await client.query('ROLLBACK TO SAVEPOINT sp_auth_1;');
        const msg = err.message.toLowerCase();
        assert(msg.includes('unauthorized') || msg.includes('permission denied'));
      }
      assert.equal(cancelUnknownFailed, true, 'cancel_sales_invoice must reject unknown user with NULL role');

      // 2. cancel_sales_invoice with unprivileged role ('warehouse' cannot cancel invoices)
      let cancelUnprivFailed = false;
      await client.query('SAVEPOINT sp_auth_2;');
      try {
        await client.query(`
          SELECT cancel_sales_invoice('00000000-0000-0000-0000-000000000001'::uuid, 'reason', '${warehouseUserId}'::uuid);
        `);
      } catch (err) {
        cancelUnprivFailed = true;
        await client.query('ROLLBACK TO SAVEPOINT sp_auth_2;');
        const msg = err.message.toLowerCase();
        assert(msg.includes('unauthorized') || msg.includes('permission denied'));
      }
      assert.equal(cancelUnprivFailed, true, 'cancel_sales_invoice must reject unprivileged role');

      // 3. create_sales_invoice_atomic with NULL role (unauthenticated)
      let createUnknownFailed = false;
      await client.query('SAVEPOINT sp_auth_3;');
      try {
        await client.query(`SET LOCAL request.jwt.claim.sub = '${nonExistentUserId}';`);
        await client.query(`
          SELECT create_sales_invoice_atomic(
            '{"invoice_number": "INV-AUTH-1", "customer_id": "00000000-0000-0000-0000-000000000001"}'::jsonb,
            '[{"product_id": "00000000-0000-0000-0000-000000000001", "quantity": 1, "unit_price": 100}]'::jsonb
          );
        `);
      } catch (err) {
        createUnknownFailed = true;
        await client.query('ROLLBACK TO SAVEPOINT sp_auth_3;');
        const msg = err.message.toLowerCase();
        assert(msg.includes('unauthorized') || msg.includes('permission denied'));
      }
      assert.equal(createUnknownFailed, true, 'create_sales_invoice_atomic must reject NULL role');

      // 4. fn_cancel_delivery_challan with unprivileged role ('viewer' cannot cancel DC)
      let dcCancelUnprivFailed = false;
      await client.query('SAVEPOINT sp_auth_4;');
      try {
        await client.query(`
          SELECT fn_cancel_delivery_challan(
            '00000000-0000-0000-0000-000000000001'::uuid,
            '${viewerUserId}'::uuid,
            'reason'
          );
        `);
      } catch (err) {
        dcCancelUnprivFailed = true;
        await client.query('ROLLBACK TO SAVEPOINT sp_auth_4;');
        const msg = err.message.toLowerCase();
        assert(msg.includes('unauthorized') || msg.includes('permission denied') || msg.includes('not authorized'));
      }
      assert.equal(dcCancelUnprivFailed, true, 'fn_cancel_delivery_challan must reject unprivileged role');

      await client.query('ROLLBACK');
    } catch (err) {
      await client.query('ROLLBACK');
      throw err;
    } finally {
      client.release();
    }
  });
});
