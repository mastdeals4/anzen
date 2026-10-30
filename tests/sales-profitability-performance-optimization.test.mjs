import test from 'node:test';
import assert from 'node:assert/strict';
import pg from 'pg';
import { execFileSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const rootDir = path.resolve(__dirname, '..');

const { Pool } = pg;

const PG_CONFIG = {
  host: process.env.PGHOST || '/tmp',
  port: 54329,
  database: 'test_sales_profitability_perf',
  user: process.env.USER || 'Kunal',
};

function runPsqlCommand(sql, db = 'test_sales_profitability_perf') {
  return execFileSync('/usr/local/bin/psql', [
    '-h', PG_CONFIG.host,
    '-p', String(PG_CONFIG.port),
    '-d', db,
    '-c', sql,
    '-v', 'ON_ERROR_STOP=1'
  ], { encoding: 'utf8' });
}

function runPsqlFile(filePath, db = 'test_sales_profitability_perf') {
  execFileSync('/usr/local/bin/psql', [
    '-h', PG_CONFIG.host,
    '-p', String(PG_CONFIG.port),
    '-d', db,
    '-f', filePath,
    '-v', 'ON_ERROR_STOP=1'
  ], { encoding: 'utf8' });
}

test.describe('SAPJ ERP: Sales Profitability Statement Performance & Accuracy Suite', () => {
  let pool;
  let customerId;
  let productA;
  let productB;
  let batchA;
  let batchB;
  let so1, so2, so3;
  let dc1, dc2;
  let inv1, inv2, inv3, invDraft, invCancelled;
  let line1A, line1B, line2A, line3A, line3B;

  test.before(async () => {
    // 1. Recreate test database
    runPsqlCommand('DROP DATABASE IF EXISTS test_sales_profitability_perf;', 'postgres');
    runPsqlCommand('CREATE DATABASE test_sales_profitability_perf;', 'postgres');

    const migrations = [
      'tests/fixtures/production-schema-baseline.sql',
      'supabase/migrations/20261030120000_sales_invoice_canonical_lifecycle_and_reporting_hardening.sql',
      'supabase/migrations/20261030130000_sales_cancellation_hardening_corrections.sql',
      'supabase/migrations/20261030140000_sales_lifecycle_terminal_cancellation_and_concurrency_hardening.sql',
      'supabase/migrations/20261030150000_complete_credit_note_and_sales_return_accounting.sql',
      'supabase/migrations/20261030170000_credit_note_final_accounting_and_lifecycle_corrections.sql',
      'supabase/migrations/20261030180000_sales_and_credit_note_final_completion.sql',
      'supabase/migrations/20261030190000_unified_party_settlement_and_voucher_upgrade.sql',
      'supabase/migrations/20261030200000_hotfix_sales_profitability_unallocated_expenses.sql',
      'supabase/migrations/20261030210000_optimize_sales_profitability_line_expenses.sql'
    ];

    for (const m of migrations) {
      runPsqlFile(path.join(rootDir, m));
    }

    pool = new Pool(PG_CONFIG);

    // Create legacy version of get_sales_profitability_line_expenses for 1:1 comparison
    await pool.query(`
      CREATE OR REPLACE FUNCTION public.get_sales_profitability_line_expenses_legacy(
        p_start_date date,
        p_end_date date
      )
      RETURNS TABLE(line_id uuid, sales_expense numeric)
      LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, pg_temp AS $$
      WITH scoped AS (
        SELECT sii.id AS line_id,
               dci.challan_id AS dc_id,
               si.sales_order_id AS so_id,
               ROUND(sii.quantity * sii.unit_price, 2) AS line_sales,
               sii.quantity
        FROM public.sales_invoice_items sii
        JOIN public.sales_invoices si ON si.id = sii.invoice_id
        LEFT JOIN public.delivery_challan_items dci ON dci.id = sii.delivery_challan_item_id
        WHERE si.invoice_date BETWEEN p_start_date AND p_end_date
          AND NOT COALESCE(si.is_draft, false)
          AND COALESCE(si.document_status, 'posted') = 'posted'
          AND NOT (COALESCE(si.notes, '') LIKE '[CANCELLED%' OR LOWER(COALESCE(si.notes, '')) LIKE 'cancelled%')
      ),
      dc_totals AS (
        SELECT dci.challan_id AS dc_id,
               SUM(ROUND(sii.quantity * sii.unit_price, 2)) AS total_sales,
               SUM(sii.quantity) AS total_qty
        FROM public.sales_invoice_items sii
        JOIN public.sales_invoices si ON si.id = sii.invoice_id
        JOIN public.delivery_challan_items dci ON dci.id = sii.delivery_challan_item_id
        WHERE NOT COALESCE(si.is_draft, false)
          AND COALESCE(si.document_status, 'posted') = 'posted'
          AND NOT (COALESCE(si.notes, '') LIKE '[CANCELLED%' OR LOWER(COALESCE(si.notes, '')) LIKE 'cancelled%')
          AND dci.challan_id IN (SELECT DISTINCT dc_id FROM scoped WHERE dc_id IS NOT NULL)
        GROUP BY dci.challan_id
      ),
      dc_expenses AS (
        SELECT fe.delivery_challan_id AS dc_id, SUM(fe.amount) AS total_expense
        FROM public.finance_expenses fe
        WHERE (
            fe.expense_category IN ('delivery_sales', 'loading_sales', 'marketing_advertising', 'other_sales')
            OR EXISTS (
              SELECT 1 FROM public.expense_categories ec
              WHERE ec.category_key = fe.expense_category
                AND ec.category_type = 'sales'
            )
          )
          AND fe.approval_status = 'approved'
          AND fe.delivery_challan_id IN (SELECT DISTINCT dc_id FROM scoped WHERE dc_id IS NOT NULL)
        GROUP BY fe.delivery_challan_id
      ),
      so_totals AS (
        SELECT si.sales_order_id AS so_id,
               SUM(ROUND(sii.quantity * sii.unit_price, 2)) AS total_sales,
               SUM(sii.quantity) AS total_qty
        FROM public.sales_invoice_items sii
        JOIN public.sales_invoices si ON si.id = sii.invoice_id
        WHERE NOT COALESCE(si.is_draft, false)
          AND COALESCE(si.document_status, 'posted') = 'posted'
          AND NOT (COALESCE(si.notes, '') LIKE '[CANCELLED%' OR LOWER(COALESCE(si.notes, '')) LIKE 'cancelled%')
          AND si.sales_order_id IN (SELECT DISTINCT so_id FROM scoped WHERE so_id IS NOT NULL)
        GROUP BY si.sales_order_id
      ),
      so_allocated_expenses AS (
        SELECT
          (alloc->>'sales_order_id')::uuid AS so_id,
          SUM(COALESCE((alloc->>'allocated_amount')::numeric, 0)) AS total_allocated_expense
        FROM public.finance_expenses fe,
             jsonb_array_elements(fe.sales_order_allocations) AS alloc
        WHERE (
            fe.expense_category IN ('delivery_sales', 'loading_sales', 'marketing_advertising', 'other_sales')
            OR EXISTS (
              SELECT 1 FROM public.expense_categories ec
              WHERE ec.category_key = fe.expense_category
                AND ec.category_type = 'sales'
            )
          )
          AND fe.approval_status = 'approved'
          AND fe.sales_order_allocations IS NOT NULL
          AND jsonb_typeof(fe.sales_order_allocations) = 'array'
          AND (alloc->>'sales_order_id')::uuid IN (SELECT DISTINCT so_id FROM scoped WHERE so_id IS NOT NULL)
        GROUP BY (alloc->>'sales_order_id')::uuid
      ),
      so_direct_expenses AS (
        SELECT fe.sales_order_id AS so_id, SUM(fe.amount) AS total_expense
        FROM public.finance_expenses fe
        WHERE (
            fe.expense_category IN ('delivery_sales', 'loading_sales', 'marketing_advertising', 'other_sales')
            OR EXISTS (
              SELECT 1 FROM public.expense_categories ec
              WHERE ec.category_key = fe.expense_category
                AND ec.category_type = 'sales'
            )
          )
          AND fe.approval_status = 'approved'
          AND fe.sales_order_id IN (SELECT DISTINCT so_id FROM scoped WHERE so_id IS NOT NULL)
          AND (fe.sales_order_allocations IS NULL OR fe.sales_order_allocations = '[]'::jsonb)
        GROUP BY fe.sales_order_id
      )
      SELECT
        s.line_id,
        ROUND(
          COALESCE(
            CASE WHEN COALESCE(dct.total_sales, 0) > 0 THEN (s.line_sales / dct.total_sales) * dce.total_expense
                 WHEN COALESCE(dct.total_qty, 0) > 0 THEN (s.quantity / dct.total_qty) * dce.total_expense
                 ELSE 0 END, 0
          ) +
          COALESCE(
            CASE WHEN COALESCE(sot.total_sales, 0) > 0 THEN (s.line_sales / sot.total_sales) * soa.total_allocated_expense
                 WHEN COALESCE(sot.total_qty, 0) > 0 THEN (s.quantity / sot.total_qty) * soa.total_allocated_expense
                 ELSE 0 END, 0
          ) +
          COALESCE(
            CASE WHEN COALESCE(sot.total_sales, 0) > 0 THEN (s.line_sales / sot.total_sales) * sod.total_expense
                 WHEN COALESCE(sot.total_qty, 0) > 0 THEN (s.quantity / sot.total_qty) * sod.total_expense
                 ELSE 0 END, 0
          ),
          2
        ) AS sales_expense
      FROM scoped s
      LEFT JOIN dc_totals dct ON dct.dc_id = s.dc_id
      LEFT JOIN dc_expenses dce ON dce.dc_id = s.dc_id
      LEFT JOIN so_totals sot ON sot.so_id = s.so_id
      LEFT JOIN so_allocated_expenses soa ON soa.so_id = s.so_id
      LEFT JOIN so_direct_expenses sod ON sod.so_id = s.so_id;
      $$;
    `);

    // 2. Setup Seed Master Data
    const cRes = await pool.query(`INSERT INTO customers (company_name) VALUES ('Test Corp') RETURNING id;`);
    customerId = cRes.rows[0].id;

    const pResA = await pool.query(`INSERT INTO products (product_name, product_code, unit) VALUES ('API Grade A', 'API-A', 'kg') RETURNING id;`);
    productA = pResA.rows[0].id;

    const pResB = await pool.query(`INSERT INTO products (product_name, product_code, unit) VALUES ('API Grade B', 'API-B', 'kg') RETURNING id;`);
    productB = pResB.rows[0].id;

    const bResA = await pool.query(`INSERT INTO batches (product_id, batch_number, current_stock, cost_per_unit, landed_cost_per_unit, is_active) VALUES ($1, 'B-01', 5000, 10000, 10000, true) RETURNING id;`, [productA]);
    batchA = bResA.rows[0].id;

    const bResB = await pool.query(`INSERT INTO batches (product_id, batch_number, current_stock, cost_per_unit, landed_cost_per_unit, is_active) VALUES ($1, 'B-02', 5000, 20000, 20000, true) RETURNING id;`, [productB]);
    batchB = bResB.rows[0].id;

    // Sales Orders
    const soRes1 = await pool.query(`INSERT INTO sales_orders (so_number, customer_id, order_date, total_amount, status) VALUES ('SO-001', $1, '2026-05-01', 50000000, 'approved') RETURNING id;`, [customerId]);
    so1 = soRes1.rows[0].id;

    const soRes2 = await pool.query(`INSERT INTO sales_orders (so_number, customer_id, order_date, total_amount, status) VALUES ('SO-002', $1, '2026-05-02', 30000000, 'approved') RETURNING id;`, [customerId]);
    so2 = soRes2.rows[0].id;

    const soRes3 = await pool.query(`INSERT INTO sales_orders (so_number, customer_id, order_date, total_amount, status) VALUES ('SO-003', $1, '2026-05-03', 20000000, 'approved') RETURNING id;`, [customerId]);
    so3 = soRes3.rows[0].id;

    // Delivery Challans
    const dcRes1 = await pool.query(`INSERT INTO delivery_challans (challan_number, customer_id, sales_order_id, challan_date, approval_status) VALUES ('DC-001', $1, $2, '2026-05-05', 'approved') RETURNING id;`, [customerId, so1]);
    dc1 = dcRes1.rows[0].id;

    const dci1A = (await pool.query(`INSERT INTO delivery_challan_items (challan_id, product_id, batch_id, quantity) VALUES ($1, $2, $3, 100) RETURNING id;`, [dc1, productA, batchA])).rows[0].id;
    const dci1B = (await pool.query(`INSERT INTO delivery_challan_items (challan_id, product_id, batch_id, quantity) VALUES ($1, $2, $3, 200) RETURNING id;`, [dc1, productB, batchB])).rows[0].id;

    const dcRes2 = await pool.query(`INSERT INTO delivery_challans (challan_number, customer_id, sales_order_id, challan_date, approval_status) VALUES ('DC-002', $1, $2, '2026-05-10', 'approved') RETURNING id;`, [customerId, so2]);
    dc2 = dcRes2.rows[0].id;

    const dci2A = (await pool.query(`INSERT INTO delivery_challan_items (challan_id, product_id, batch_id, quantity) VALUES ($1, $2, $3, 300) RETURNING id;`, [dc2, productA, batchA])).rows[0].id;

    // Invoices:
    // Invoice 1: under DC1 & SO1 with 2 items:
    // Item 1: 100 kg @ Rp 15,000 = Rp 1,500,000
    // Item 2: 200 kg @ Rp 25,000 = Rp 5,000,000
    // Total DC1 Sales = Rp 6,500,000
    const invRes1 = await pool.query(`
      INSERT INTO sales_invoices (invoice_number, customer_id, sales_order_id, invoice_date, subtotal, total_amount, document_status, is_draft)
      VALUES ('INV-001', $1, $2, '2026-05-06', 6500000, 7215000, 'posted', false) RETURNING id;
    `, [customerId, so1]);
    inv1 = invRes1.rows[0].id;

    line1A = (await pool.query(`
      INSERT INTO sales_invoice_items (invoice_id, delivery_challan_item_id, product_id, batch_id, quantity, unit_price)
      VALUES ($1, $2, $3, $4, 100, 15000) RETURNING id;
    `, [inv1, dci1A, productA, batchA])).rows[0].id;

    line1B = (await pool.query(`
      INSERT INTO sales_invoice_items (invoice_id, delivery_challan_item_id, product_id, batch_id, quantity, unit_price)
      VALUES ($1, $2, $3, $4, 200, 25000) RETURNING id;
    `, [inv1, dci1B, productB, batchB])).rows[0].id;

    // Invoice 2: under DC2 & SO2 with 1 item:
    // 300 kg @ Rp 10,000 = Rp 3,000,000
    const invRes2 = await pool.query(`
      INSERT INTO sales_invoices (invoice_number, customer_id, sales_order_id, invoice_date, subtotal, total_amount, document_status, is_draft)
      VALUES ('INV-002', $1, $2, '2026-05-11', 3000000, 3330000, 'posted', false) RETURNING id;
    `, [customerId, so2]);
    inv2 = invRes2.rows[0].id;

    line2A = (await pool.query(`
      INSERT INTO sales_invoice_items (invoice_id, delivery_challan_item_id, product_id, batch_id, quantity, unit_price)
      VALUES ($1, $2, $3, $4, 300, 10000) RETURNING id;
    `, [inv2, dci2A, productA, batchA])).rows[0].id;

    // Invoice 3: under SO3 without DC:
    // Item 1: 50 kg @ Rp 0 = Rp 0 (Zero revenue, tests quantity-based fallback!)
    // Item 2: 50 kg @ Rp 20,000 = Rp 1,000,000
    const invRes3 = await pool.query(`
      INSERT INTO sales_invoices (invoice_number, customer_id, sales_order_id, invoice_date, subtotal, total_amount, document_status, is_draft)
      VALUES ('INV-003', $1, $2, '2026-05-15', 1000000, 1110000, 'posted', false) RETURNING id;
    `, [customerId, so3]);
    inv3 = invRes3.rows[0].id;

    line3A = (await pool.query(`
      INSERT INTO sales_invoice_items (invoice_id, product_id, batch_id, quantity, unit_price)
      VALUES ($1, $2, $3, 50, 0) RETURNING id;
    `, [inv3, productA, batchA])).rows[0].id;

    line3B = (await pool.query(`
      INSERT INTO sales_invoice_items (invoice_id, product_id, batch_id, quantity, unit_price)
      VALUES ($1, $2, $3, 50, 20000) RETURNING id;
    `, [inv3, productB, batchB])).rows[0].id;

    // Draft Invoice (Must be excluded!)
    const draftRes = await pool.query(`
      INSERT INTO sales_invoices (invoice_number, customer_id, sales_order_id, invoice_date, subtotal, total_amount, is_draft)
      VALUES ('INV-DRAFT', $1, $2, '2026-05-16', 5000000, 5550000, true) RETURNING id;
    `, [customerId, so1]);
    invDraft = draftRes.rows[0].id;

    await pool.query(`
      INSERT INTO sales_invoice_items (invoice_id, product_id, batch_id, quantity, unit_price)
      VALUES ($1, $2, $3, 100, 50000);
    `, [invDraft, productA, batchA]);

    // Cancelled Invoice (Must be excluded!)
    const cancRes = await pool.query(`
      INSERT INTO sales_invoices (invoice_number, customer_id, sales_order_id, invoice_date, subtotal, total_amount, document_status, notes)
      VALUES ('INV-CANC', $1, $2, '2026-05-17', 2000000, 2220000, 'cancelled', '[CANCELLED] by client') RETURNING id;
    `, [customerId, so2]);
    invCancelled = cancRes.rows[0].id;

    await pool.query(`
      INSERT INTO sales_invoice_items (invoice_id, product_id, batch_id, quantity, unit_price)
      VALUES ($1, $2, $3, 50, 40000);
    `, [invCancelled, productB, batchB]);

    // 3. Finance Expenses:
    // Exp 1: Delivery expense directly linked to DC1 (Rp 650,000)
    await pool.query(`
      INSERT INTO finance_expenses (description, amount, expense_category, expense_date, approval_status, delivery_challan_id)
      VALUES ('Delivery for DC1', 650000, 'delivery_sales', '2026-05-06', 'approved', $1);
    `, [dc1]);

    // Exp 2: Direct SO expense linked to SO2 (Rp 300,000)
    await pool.query(`
      INSERT INTO finance_expenses (description, amount, expense_category, expense_date, approval_status, sales_order_id, sales_order_allocations)
      VALUES ('Direct Sales Order Exp for SO2', 300000, 'marketing_advertising', '2026-05-11', 'approved', $1, '[]'::jsonb);
    `, [so2]);

    // Exp 3: Multi-SO JSONB allocation (Rp 500,000 total: 200k to SO1, 300k to SO3)
    await pool.query(`
      INSERT INTO finance_expenses (description, amount, expense_category, expense_date, approval_status, sales_order_allocations)
      VALUES ('Multi-SO Promotion', 500000, 'loading_sales', '2026-05-12', 'approved', $1::jsonb);
    `, [JSON.stringify([
      { sales_order_id: so1, allocated_amount: 200000 },
      { sales_order_id: so3, allocated_amount: 300000 },
    ])]);

    // Exp 4: Unapproved expense (MUST be ignored!)
    await pool.query(`
      INSERT INTO finance_expenses (description, amount, expense_category, expense_date, approval_status, delivery_challan_id)
      VALUES ('Pending delivery expense', 1000000, 'delivery_sales', '2026-05-07', 'pending', $1);
    `, [dc1]);

    // Exp 5: Non-sales expense (MUST be ignored!)
    await pool.query(`
      INSERT INTO finance_expenses (description, amount, expense_category, expense_date, approval_status, delivery_challan_id)
      VALUES ('Admin fee', 250000, 'office_supplies', '2026-05-08', 'approved', $1);
    `, [dc1]);
  });

  test.after(async () => {
    if (pool) await pool.end();
  });

  test('1. Old vs New Function Parity: Exact 1:1 match for every invoice line', async () => {
    const res = await pool.query(`
      WITH old_out AS (
        SELECT line_id, sales_expense FROM public.get_sales_profitability_line_expenses_legacy('2026-01-01', '2026-12-31')
      ),
      new_out AS (
        SELECT line_id, sales_expense FROM public.get_sales_profitability_line_expenses('2026-01-01', '2026-12-31')
      )
      SELECT 
        (SELECT count(*) FROM old_out) AS old_count,
        (SELECT count(*) FROM new_out) AS new_count,
        (SELECT sum(sales_expense) FROM old_out) AS old_sum,
        (SELECT sum(sales_expense) FROM new_out) AS new_sum,
        (
          SELECT count(*) 
          FROM old_out o
          FULL OUTER JOIN new_out n ON n.line_id = o.line_id
          WHERE n.line_id IS NULL OR o.line_id IS NULL OR n.sales_expense IS DISTINCT FROM o.sales_expense
        ) AS mismatch_count;
    `);

    const r = res.rows[0];
    assert.equal(Number(r.mismatch_count), 0, 'Every line sales_expense must match exactly between legacy and optimized');
    assert.equal(Number(r.old_count), Number(r.new_count), 'Line counts must match');
    assert.equal(Number(r.old_sum), Number(r.new_sum), 'Total sales expenses must match');
    assert.equal(Number(r.new_count), 5, 'Must return exactly the 5 reportable invoice lines (excluding draft & cancelled)');
  });

  test('2. Multiple invoice lines under one DC receive proportional delivery expenses', async () => {
    // Total DC1 Sales = 1,500,000 + 5,000,000 = 6,500,000
    // DC1 delivery expense = 650,000
    // Line 1A DC share = (1.5M / 6.5M) * 650k = 150,000
    // Line 1B DC share = (5.0M / 6.5M) * 650k = 500,000
    // SO1 allocated expense = 200,000
    // Line 1A SO share = (1.5M / 6.5M) * 200k = 46,153.85
    // Line 1B SO share = (5.0M / 6.5M) * 200k = 153,846.15
    // Line 1A Total = 150,000 + 46,153.85 = 196,153.85
    // Line 1B Total = 500,000 + 153,846.15 = 653,846.15
    const res = await pool.query(`
      SELECT line_id, sales_expense 
      FROM public.get_sales_profitability_line_expenses('2026-01-01', '2026-12-31')
      WHERE line_id IN ($1, $2)
      ORDER BY line_id;
    `, [line1A, line1B]);

    const lineA = res.rows.find(r => r.line_id === line1A);
    const lineB = res.rows.find(r => r.line_id === line1B);

    assert.equal(Number(lineA.sales_expense), 196153.85);
    assert.equal(Number(lineB.sales_expense), 653846.15);
  });

  test('3. Direct Sales Order expense allocation and single invoice line under SO', async () => {
    // Invoice 2: 3,000,000 sales on SO2
    // SO2 direct expense = 300,000
    // Line 2A Total = 300,000
    const res = await pool.query(`
      SELECT line_id, sales_expense 
      FROM public.get_sales_profitability_line_expenses('2026-01-01', '2026-12-31')
      WHERE line_id = $1;
    `, [line2A]);

    assert.equal(Number(res.rows[0].sales_expense), 300000.00);
  });

  test('4. Quantity-based fallback when revenue is 0', async () => {
    // Invoice 3 on SO3 has 2 lines:
    // Line 3A: 50 kg @ Rp 0 = Rp 0
    // Line 3B: 50 kg @ Rp 20,000 = Rp 1,000,000
    // Total SO3 sales = Rp 1,000,000 > 0, so revenue allocation applies for Line 3B (1M/1M * 300k = 300k)
    // Line 3A gets 0
    const res = await pool.query(`
      SELECT line_id, sales_expense 
      FROM public.get_sales_profitability_line_expenses('2026-01-01', '2026-12-31')
      WHERE line_id IN ($1, $2);
    `, [line3A, line3B]);

    const lineA = res.rows.find(r => r.line_id === line3A);
    const lineB = res.rows.find(r => r.line_id === line3B);

    assert.equal(Number(lineA.sales_expense), 0.00);
    assert.equal(Number(lineB.sales_expense), 300000.00);
  });

  test('5. Cancelled and draft invoices are strictly excluded', async () => {
    const res = await pool.query(`
      SELECT le.line_id 
      FROM public.get_sales_profitability_line_expenses('2026-01-01', '2026-12-31') le
      JOIN public.sales_invoice_items sii ON sii.id = le.line_id
      WHERE sii.invoice_id IN ($1, $2);
    `, [invDraft, invCancelled]);

    assert.equal(res.rows.length, 0, 'No lines from draft or cancelled invoices may be returned');
  });

  test('6. Empty date range returns empty set cleanly', async () => {
    const res = await pool.query(`
      SELECT * FROM public.get_sales_profitability_line_expenses('2024-01-01', '2024-12-31');
    `);
    assert.equal(res.rows.length, 0, 'Empty date range must return 0 rows');
  });

  test('7. Performance check: Set-based architecture and execution well below statement timeout', async () => {
    const planRes = await pool.query(`
      EXPLAIN (ANALYZE, BUFFERS)
      SELECT * FROM public.get_sales_profitability_line_expenses('2026-01-01', '2026-12-31');
    `);
    const planText = planRes.rows.map(r => r['QUERY PLAN']).join('\n');

    // Function execution must complete in well under 100 ms
    const timeMatch = planText.match(/Execution Time: ([\d.]+) ms/);
    if (timeMatch) {
      const execTimeMs = parseFloat(timeMatch[1]);
      assert.ok(execTimeMs < 100, `Execution time must be < 100ms, actual: ${execTimeMs}ms`);
    }

    // Verify set-based CTE query structure
    const fnDef = (await pool.query(`
      SELECT pg_get_functiondef(oid) as def FROM pg_proc WHERE proname = 'get_sales_profitability_line_expenses';
    `)).rows[0].def;

    assert.match(fnDef, /scoped AS MATERIALIZED/);
    assert.match(fnDef, /target_dc AS MATERIALIZED/);
    assert.match(fnDef, /target_so AS MATERIALIZED/);
    assert.match(fnDef, /eligible_sales_expenses AS MATERIALIZED/);
    assert.match(fnDef, /dc_totals AS MATERIALIZED/);
    assert.match(fnDef, /dc_expenses AS MATERIALIZED/);
    assert.match(fnDef, /so_totals AS MATERIALIZED/);
    assert.match(fnDef, /so_allocated_expenses AS MATERIALIZED/);
    assert.match(fnDef, /so_direct_expenses AS MATERIALIZED/);
  });

  test('8. Robustness: Malformed and empty JSONB allocations are safely handled without throwing', async () => {
    // Insert malformed JSONB allocation
    await pool.query(`
      INSERT INTO finance_expenses (description, amount, expense_category, expense_date, approval_status, sales_order_allocations)
      VALUES ('Malformed JSONB Test', 100000, 'other_sales', '2026-05-13', 'approved', $1::jsonb);
    `, [JSON.stringify([
      { sales_order_id: 'not-a-valid-uuid', allocated_amount: 50000 },
      { sales_order_id: null, allocated_amount: 50000 },
    ])]);

    // Legacy function throws 22P02 invalid input syntax for type uuid
    await assert.rejects(
      async () => {
        await pool.query(`SELECT * FROM public.get_sales_profitability_line_expenses_legacy('2026-01-01', '2026-12-31');`);
      },
      (err) => err.code === '22P02'
    );

    // Optimized function executes without error, safely ignoring malformed entries
    const res = await pool.query(`
      SELECT * FROM public.get_sales_profitability_line_expenses('2026-01-01', '2026-12-31');
    `);
    assert.equal(res.rows.length, 5, 'Must return reportable rows safely despite malformed JSONB in expenses');
  });
});
