import test from 'node:test';
import assert from 'node:assert/strict';
import { execSync } from 'child_process';

function runSql(sql) {
  const sanitizedSql = sql.replace(/"/g, '\\"');
  const res = execSync(`npx supabase db query --linked "${sanitizedSql}"`, {
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
}

test('1. P&L RPC equals Canonical GL with zero unexplained difference', async () => {
  const rows = runSql(`
    WITH rpc_pnl AS (
      SELECT * FROM get_pnl_summary('2026-01-01'::date, '2026-12-31'::date, 1.0)
    ), gl_pnl AS (
      SELECT 
        ROUND(SUM(CASE WHEN coa.account_type = 'revenue' THEN jel.credit - jel.debit ELSE 0 END), 2) as gl_revenue,
        ROUND(SUM(CASE WHEN coa.account_type = 'expense' THEN jel.debit - jel.credit ELSE 0 END), 2) as gl_expense,
        ROUND(SUM(CASE WHEN coa.account_type = 'revenue' THEN jel.credit - jel.debit 
                       WHEN coa.account_type = 'expense' THEN -(jel.debit - jel.credit) ELSE 0 END), 2) as gl_net_income
      FROM journal_entry_lines jel
      JOIN journal_entries je ON je.id = jel.journal_entry_id
      JOIN chart_of_accounts coa ON coa.id = jel.account_id
      WHERE je.is_posted = true AND je.entry_date BETWEEN '2026-01-01' AND '2026-12-31'
    )
    SELECT 
      r.total_revenue - g.gl_revenue as rev_diff,
      r.total_expenses - g.gl_expense as exp_diff,
      r.net_income - g.gl_net_income as net_diff
    FROM rpc_pnl r, gl_pnl g;
  `);

  assert.equal(rows.length, 1);
  assert.equal(Number(rows[0].rev_diff), 0);
  assert.equal(Number(rows[0].exp_diff), 0);
  assert.equal(Number(rows[0].net_diff), 0);
});

test('2. COGS 4-way tie-out holds exactly (Batch = Item = GL 5100 = Profitability)', async () => {
  const rows = runSql(`
    SELECT 
      (SELECT ROUND(SUM(sii.quantity * COALESCE(b.landed_cost_per_unit, b.cost_per_unit, b.import_price, 0)), 2)
         FROM public.sales_invoice_items sii
         JOIN public.sales_invoices si ON si.id = sii.invoice_id
         JOIN public.batches b ON b.id = sii.batch_id
        WHERE COALESCE(si.is_draft, false) = false) as batch_cogs,

      (SELECT ROUND(SUM(sii.cogs_total_cost), 2)
         FROM public.sales_invoice_items sii
         JOIN public.sales_invoices si ON si.id = sii.invoice_id
        WHERE COALESCE(si.is_draft, false) = false) as invoice_item_cogs,

      (SELECT ROUND(SUM(jel.debit - jel.credit), 2)
         FROM public.journal_entries je
         JOIN public.journal_entry_lines jel ON jel.journal_entry_id = je.id
         JOIN public.chart_of_accounts coa ON coa.id = jel.account_id
        WHERE je.is_posted = true AND coa.code = '5100') as gl_5100_cogs,

      (SELECT COUNT(*) 
         FROM public.sales_invoice_items sii
         JOIN public.sales_invoices si ON si.id = sii.invoice_id
        WHERE COALESCE(si.is_draft, false) = false AND (sii.cogs_total_cost IS NULL OR sii.cogs_total_cost = 0)) as blank_cogs_lines;
  `);

  assert.equal(rows.length, 1);
  assert.equal(rows[0].batch_cogs, rows[0].invoice_item_cogs);
  assert.equal(rows[0].invoice_item_cogs, rows[0].gl_5100_cogs);
  assert.equal(Number(rows[0].blank_cogs_lines), 0);
});

test('3. Sold batches are 100% cost-locked and protected', async () => {
  const rows = runSql(`
    SELECT 
      COUNT(DISTINCT CASE WHEN sii.id IS NOT NULL THEN b.id END) as sold_batches,
      COUNT(DISTINCT CASE WHEN sii.id IS NOT NULL AND b.cost_locked = true THEN b.id END) as cost_locked_sold_batches,
      COUNT(DISTINCT CASE WHEN sii.id IS NOT NULL AND (b.cost_locked IS NULL OR b.cost_locked = false) THEN b.id END) as unlocked_sold_batches
    FROM public.batches b
    LEFT JOIN public.sales_invoice_items sii ON sii.batch_id = b.id;
  `);

  assert.equal(rows.length, 1);
  assert.equal(Number(rows[0].sold_batches), 43);
  assert.equal(Number(rows[0].cost_locked_sold_batches), 43);
  assert.equal(Number(rows[0].unlocked_sold_batches), 0);
});

test('4. Tax subledgers reconcile with GL (PPN Masukan, PPN Keluaran)', async () => {
  const rows = runSql(`
    SELECT 
      (SELECT ROUND(SUM(ppn_amount), 2) FROM vw_input_ppn_report) as input_report_tax,
      (SELECT ROUND(SUM(jel.debit - jel.credit), 2) FROM journal_entry_lines jel JOIN journal_entries je ON je.id = jel.journal_entry_id JOIN chart_of_accounts coa ON coa.id = jel.account_id WHERE coa.code = '1150' AND je.is_posted = true) as gl_1150_tax,
      (SELECT ROUND(SUM(ppn_amount), 2) FROM vw_output_ppn_report) as output_report_tax,
      (SELECT ROUND(SUM(jel.credit - jel.debit), 2) FROM journal_entry_lines jel JOIN journal_entries je ON je.id = jel.journal_entry_id JOIN chart_of_accounts coa ON coa.id = jel.account_id WHERE coa.code = '2130' AND je.is_posted = true) as gl_2130_tax;
  `);

  assert.equal(rows.length, 1);
  assert.equal(rows[0].input_report_tax, rows[0].gl_1150_tax);
  assert.equal(rows[0].output_report_tax, rows[0].gl_2130_tax);
});

test('5. Database-level negative stock protection prevents negative inventory', async () => {
  const rows = runSql(`
    SELECT 
      (SELECT COUNT(*) FROM pg_constraint WHERE conname = 'batches_current_stock_check') as has_check,
      (SELECT COUNT(*) FROM batches WHERE current_stock < 0) as negative_batches;
  `);

  assert.equal(rows.length, 1);
  assert.equal(Number(rows[0].has_check), 1);
  assert.equal(Number(rows[0].negative_batches), 0);
});

test('6. Inventory accounting equation holds exactly for GL 1130', async () => {
  const rows = runSql(`
    SELECT 
      ROUND(SUM(jel.debit), 2) as total_debits,
      ROUND(SUM(jel.credit), 2) as total_credits,
      ROUND(SUM(jel.debit - jel.credit), 2) as net_balance
    FROM journal_entry_lines jel
    JOIN journal_entries je ON je.id = jel.journal_entry_id
    JOIN chart_of_accounts coa ON coa.id = jel.account_id
    WHERE coa.code = '1130' AND je.is_posted = true;
  `);

  assert.equal(rows.length, 1);
  // Debits (Purchases + Landed Costs + Inflow adjustments) = 14,926,761,234.70
  // Credits (COGS credits + transfers) = 12,827,846,962.75
  // Net balance = 2,098,914,271.95
  assert.equal(rows[0].net_balance, '2098914271.95');
});
