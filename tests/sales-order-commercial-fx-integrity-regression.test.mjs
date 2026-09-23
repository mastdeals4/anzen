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

test('1. Historical Data Audit: Only SO-2026-0066 has IDR + quoted USD + missing FX rate', () => {
  const auditRows = runSql(`
    SELECT
      so.id,
      so.so_number,
      so.status,
      so.currency,
      so.commercial_usd_to_idr_rate,
      count(soi.id) FILTER (WHERE soi.quoted_usd_unit_price > 0) as quoted_usd_items
    FROM sales_orders so
    JOIN sales_order_items soi ON soi.sales_order_id = so.id
    WHERE so.currency = 'IDR'
      AND so.commercial_usd_to_idr_rate IS NULL
      AND soi.quoted_usd_unit_price IS NOT NULL
      AND soi.quoted_usd_unit_price > 0
    GROUP BY so.id, so.so_number, so.status, so.currency, so.commercial_usd_to_idr_rate
    ORDER BY so.created_at;
  `);

  assert.equal(auditRows.length, 1, 'Exactly one historical SO should match audit criteria');
  assert.equal(auditRows[0].so_number, 'SO-2026-0066', 'The single matching SO must be SO-2026-0066');
  assert.equal(auditRows[0].commercial_usd_to_idr_rate, null, 'Historical rate must remain NULL until user confirms');
});

test('2. SO-2026-0066 data integrity: USD quoted prices and IDR amounts unchanged', () => {
  const rows = runSql(`
    SELECT
      so.id,
      so.so_number,
      so.currency,
      so.commercial_usd_to_idr_rate,
      so.subtotal_amount::numeric as subtotal_amount,
      so.tax_amount::numeric as tax_amount,
      so.total_amount::numeric as total_amount,
      json_agg(json_build_object(
        'quantity', soi.quantity,
        'unit_price', soi.unit_price,
        'quoted_usd_unit_price', soi.quoted_usd_unit_price,
        'line_total', soi.line_total
      ) ORDER BY soi.id) as items
    FROM sales_orders so
    JOIN sales_order_items soi ON soi.sales_order_id = so.id
    WHERE so.so_number = 'SO-2026-0066'
    GROUP BY so.id, so.so_number, so.currency, so.commercial_usd_to_idr_rate, so.subtotal_amount, so.tax_amount, so.total_amount;
  `);

  assert.equal(rows.length, 1);
  const so = rows[0];
  assert.equal(so.currency, 'IDR');
  assert.equal(so.commercial_usd_to_idr_rate, null);
  assert.equal(Number(so.subtotal_amount), 44730050.00);
  assert.equal(Number(so.tax_amount), 4920305.50);
  assert.equal(Number(so.total_amount), 49650355.50);

  const items = so.items;
  assert.equal(items.length, 2);
  const usdPrices = items.map(i => Number(i.quoted_usd_unit_price)).sort((a, b) => a - b);
  assert.deepEqual(usdPrices, [0.95, 10.5]);
});

test('3. DB Guard: IDR SO with quoted USD and no rate blocks approval, succeeds when rate provided', () => {
  const testScript = `
    DO $$
    DECLARE
      v_user_id uuid;
      v_customer_id uuid;
      v_product_id uuid;
      v_so_id uuid;
      v_so_item_id uuid;
      v_error_caught boolean := false;
      v_error_msg text;
    BEGIN
      SELECT id INTO v_user_id FROM public.user_profiles WHERE role IN ('admin', 'manager', 'accounts', 'sales') LIMIT 1;
      SELECT id INTO v_customer_id FROM public.customers LIMIT 1;
      SELECT id INTO v_product_id FROM public.products LIMIT 1;

      PERFORM set_config('request.jwt.claim.sub', v_user_id::text, true);
      PERFORM set_config('app.canonical_reservation_engine', 'on', true);

      -- 1. Create a draft IDR Sales Order without commercial FX rate
      INSERT INTO public.sales_orders (
        so_number, customer_id, customer_po_number, customer_po_date, so_date,
        currency, commercial_usd_to_idr_rate, status, subtotal_amount, tax_amount, total_amount, created_by
      ) VALUES (
        'TEST-SO-FX-GUARD', v_customer_id, 'PO-FX-TEST', CURRENT_DATE, CURRENT_DATE,
        'IDR', NULL, 'draft', 1860070, 204607.7, 2064677.7, v_user_id
      ) RETURNING id INTO v_so_id;

      -- 2. Add an item with quoted_usd_unit_price
      INSERT INTO public.sales_order_items (
        sales_order_id, product_id, quantity, unit_price, quoted_usd_unit_price,
        discount_percent, discount_amount, tax_percent, tax_amount, line_total
      ) VALUES (
        v_so_id, v_product_id, 10, 186007, 10.50,
        0, 0, 11, 204607.7, 2064677.7
      ) RETURNING id INTO v_so_item_id;

      -- 3. Attempt approval without rate -> MUST fail with exact error
      BEGIN
        PERFORM public.approve_sales_order_product_reservation_v2(v_so_id, v_user_id);
      EXCEPTION WHEN OTHERS THEN
        v_error_caught := true;
        v_error_msg := SQLERRM;
      END;

      IF NOT v_error_caught THEN
        RAISE EXCEPTION 'Guard failed: approve_sales_order_product_reservation_v2 should have blocked missing FX rate';
      END IF;

      IF v_error_msg NOT LIKE '%Set the commercial USD→IDR exchange rate before approving this Sales Order.%' THEN
        RAISE EXCEPTION 'Guard failed: unexpected error message: %', v_error_msg;
      END IF;

      -- Test trigger guard: direct status update to 'stock_reserved' must also fail
      v_error_caught := false;
      BEGIN
        UPDATE public.sales_orders SET status = 'stock_reserved' WHERE id = v_so_id;
      EXCEPTION WHEN OTHERS THEN
        v_error_caught := true;
        v_error_msg := SQLERRM;
      END;

      IF NOT v_error_caught OR v_error_msg NOT LIKE '%Set the commercial USD→IDR exchange rate before approving this Sales Order.%' THEN
        RAISE EXCEPTION 'Trigger guard failed on direct status update: %', v_error_msg;
      END IF;

      -- 4. Set the commercial rate using update_sales_order_commercial_rate
      PERFORM public.update_sales_order_commercial_rate(v_so_id, 17714.8, 'Test commercial rate entry');

      -- Verify rate is populated
      IF NOT EXISTS (
        SELECT 1 FROM public.sales_orders
        WHERE id = v_so_id AND commercial_usd_to_idr_rate = 17714.8
      ) THEN
        RAISE EXCEPTION 'Rate was not updated by update_sales_order_commercial_rate';
      END IF;

      -- 5. Approval should now succeed with valid commercial FX rate
      PERFORM public.approve_sales_order_product_reservation_v2(v_so_id, v_user_id);

      -- Clean up test records
      DELETE FROM public.sales_order_items WHERE sales_order_id = v_so_id;
      DELETE FROM public.sales_orders WHERE id = v_so_id;
    END;
    $$;
  `;

  runSql(testScript);
  assert.ok(true, 'DB guard blocked approval without rate and allowed after rate update');
});

test('4. Rate update is metadata only: no journal entries created or accounting modified', () => {
  const testScript = `
    DO $$
    DECLARE
      v_user_id uuid;
      v_customer_id uuid;
      v_product_id uuid;
      v_so_id uuid;
      v_journal_count_before int;
      v_journal_count_after int;
    BEGIN
      SELECT count(*) INTO v_journal_count_before FROM public.journal_entries;
      SELECT id INTO v_user_id FROM public.user_profiles WHERE role IN ('admin', 'manager', 'accounts', 'sales') LIMIT 1;
      SELECT id INTO v_customer_id FROM public.customers LIMIT 1;
      SELECT id INTO v_product_id FROM public.products LIMIT 1;

      PERFORM set_config('request.jwt.claim.sub', v_user_id::text, true);

      INSERT INTO public.sales_orders (
        so_number, customer_id, customer_po_number, customer_po_date, so_date,
        currency, commercial_usd_to_idr_rate, status, subtotal_amount, tax_amount, total_amount, created_by
      ) VALUES (
        'TEST-SO-FX-JOURNAL', v_customer_id, 'PO-FX-TEST', CURRENT_DATE, CURRENT_DATE,
        'IDR', NULL, 'draft', 100000, 11000, 111000, v_user_id
      ) RETURNING id INTO v_so_id;

      PERFORM public.update_sales_order_commercial_rate(v_so_id, 17500.0, 'Audit test');

      SELECT count(*) INTO v_journal_count_after FROM public.journal_entries;

      IF v_journal_count_before <> v_journal_count_after THEN
        RAISE EXCEPTION 'update_sales_order_commercial_rate created journal entries! It must be metadata only.';
      END IF;

      DELETE FROM public.sales_orders WHERE id = v_so_id;
    END;
    $$;
  `;

  runSql(testScript);
  assert.ok(true, 'Commercial FX rate is purely metadata with zero journal impact');
});

test('5. ProformaInvoiceView code contract: Warning and rate display logic', () => {
  const content = fs.readFileSync('src/components/ProformaInvoiceView.tsx', 'utf-8');

  // Must detect IDR SO with quoted USD without rate
  assert.match(content, /hasQuotedUsdWithoutRate/, 'Proforma must calculate hasQuotedUsdWithoutRate');
  assert.match(content, /USD quoted prices exist, but the commercial USD→IDR exchange rate has not been set\./,
    'Proforma must render the exact data-integrity warning message');
  assert.match(content, /Exchange Rate \(USD → IDR\):/, 'Proforma must display Exchange Rate label');
  assert.match(content, /'Not Set'/, 'Proforma must display Not Set when rate is null');
  assert.match(content, /USD quoted price \(commercial USD→IDR exchange rate not set\)/,
    'Proforma must clarify tooltip when rate is not set');
});

test('6. SalesOrderForm and SalesOrders code contract: Block approval without rate', () => {
  const formContent = fs.readFileSync('src/components/SalesOrderForm.tsx', 'utf-8');
  assert.match(formContent, /Set the commercial USD→IDR exchange rate before approving this Sales Order\./,
    'SalesOrderForm must show exact message when blocking approval');

  const pageContent = fs.readFileSync('src/pages/SalesOrders.tsx', 'utf-8');
  assert.match(pageContent, /Set the commercial USD→IDR exchange rate before approving this Sales Order\./,
    'SalesOrders page must show exact message when blocking approval');
});
