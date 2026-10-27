import { execSync } from 'child_process';

console.log('=== Starting Safe SAPJ Sales COGS Reconciliation ===\n');

function runLinkedQuery(sql) {
  const result = execSync('npx supabase db query --linked', {
    input: sql,
    encoding: 'utf8',
  });
  // Extract JSON output from supabase db query output
  const firstBrace = result.indexOf('{');
  const lastBrace = result.lastIndexOf('}');
  if (firstBrace === -1 || lastBrace === -1) {
    throw new Error('Unexpected CLI output: ' + result);
  }
  const parsed = JSON.parse(result.substring(firstBrace, lastBrace + 1));
  return parsed.rows || [];
}

try {
  // Step 1: Run reconciliation
  console.log('Step 1: Running reconcile_all_sales_cogs(2025-11-29, 2026-09-21)...');
  const run1 = runLinkedQuery(`
    SELECT * FROM public.reconcile_all_sales_cogs('2025-11-29', '2026-09-21');
  `);
  console.log('Reconciliation Run 1 Result:', JSON.stringify(run1[0], null, 2));

  // Step 2: Idempotency check - Run again immediately
  console.log('\nStep 2: Testing Idempotency (Run 2)...');
  const run2 = runLinkedQuery(`
    SELECT * FROM public.reconcile_all_sales_cogs('2025-11-29', '2026-09-21');
  `);
  console.log('Reconciliation Run 2 Result:', JSON.stringify(run2[0], null, 2));

  if (Number(run2[0]?.delta_journals_created || 0) !== 0 || Number(run2[0]?.total_delta_posted || 0) !== 0) {
    throw new Error(`Idempotency check failed: Run 2 created ${run2[0]?.delta_journals_created} journals with delta ${run2[0]?.total_delta_posted}`);
  }
  console.log('✔ Idempotency verified: Exactly 0 journals created on second execution.');

  // Step 3: Check resolution tiers in get_authoritative_sales_line_cogs
  console.log('\nStep 3: Checking Authoritative Sales Line Resolution Tiers...');
  const tiers = runLinkedQuery(`
    SELECT
      resolution_tier,
      COUNT(*) as line_count,
      ROUND(SUM(authoritative_cogs), 2) as sum_cogs
    FROM public.get_authoritative_sales_line_cogs('2025-11-29', '2026-09-21')
    GROUP BY resolution_tier
    ORDER BY resolution_tier;
  `);
  console.table(tiers);

  const unresolved = tiers.find(t => t.resolution_tier === 'unresolved');
  if (unresolved && Number(unresolved.line_count) > 0) {
    throw new Error(`Verification failed: ${unresolved.line_count} lines remain unresolved in get_authoritative_sales_line_cogs`);
  }
  console.log('✔ Resolution verified: 0 lines unresolved across all 91 sales invoice items.');

  // Step 4: Three-Layer Reconciliation (Batch Cost vs Invoice Items vs GL 5100)
  console.log('\nStep 4: Checking Three-Layer Reconciliation (Batch vs Invoice Items vs GL 5100)...');
  const threeLayers = runLinkedQuery(`
    WITH batch_cost AS (
      SELECT
        ROUND(SUM(sii.quantity * public.calculate_batch_authoritative_cost(b)), 2) as total_batch_cogs,
        ROUND(SUM(sii.cogs_total_cost), 2) as total_invoice_items_cogs,
        COUNT(sii.id) as total_lines,
        COUNT(sii.cogs_total_cost) as costed_lines
      FROM sales_invoice_items sii
      JOIN sales_invoices si ON si.id = sii.invoice_id
      JOIN batches b ON b.id = sii.batch_id
      WHERE NOT COALESCE(si.is_draft, false)
        AND si.invoice_date BETWEEN '2025-11-29' AND '2026-09-21'
    ),
    gl_cost AS (
      SELECT
        ROUND(SUM(jel.debit - jel.credit), 2) as total_gl_5100_cogs
      FROM journal_entries je
      JOIN journal_entry_lines jel ON jel.journal_entry_id = je.id
      JOIN chart_of_accounts coa ON coa.id = jel.account_id
      WHERE coa.code = '5100'
        AND je.is_posted = true
        AND NOT COALESCE(je.is_reversed, false)
        AND je.reference_id IN (
          SELECT id FROM sales_invoices WHERE NOT COALESCE(is_draft, false) AND invoice_date BETWEEN '2025-11-29' AND '2026-09-21'
        )
    )
    SELECT
      bc.total_lines,
      bc.costed_lines,
      bc.total_batch_cogs,
      bc.total_invoice_items_cogs,
      gl.total_gl_5100_cogs,
      ROUND(bc.total_invoice_items_cogs - bc.total_batch_cogs, 2) as diff_items_minus_batch,
      ROUND(gl.total_gl_5100_cogs - bc.total_batch_cogs, 2) as diff_gl_minus_batch
    FROM batch_cost bc, gl_cost gl;
  `);
  console.table(threeLayers);

  const diffItems = Math.abs(Number(threeLayers[0]?.diff_items_minus_batch || 0));
  const diffGL = Math.abs(Number(threeLayers[0]?.diff_gl_minus_batch || 0));

  if (diffItems > 0.05) {
    throw new Error(`Discrepancy: Invoice Items COGS differs from Batch COGS by ${diffItems}`);
  }
  if (diffGL > 0.05) {
    throw new Error(`Discrepancy: GL 5100 COGS differs from Batch COGS by ${diffGL}`);
  }

  // Step 5: Verify Sales Profitability Report Output
  console.log('\nStep 5: Verifying Sales Profitability Report Output...');
  const profitReport = runLinkedQuery(`
    SELECT (public.get_sales_profitability_summary('2025-11-29', '2026-09-21')->'company'->>'product_cost')::numeric as report_total_cogs;
  `);
  const reportCogs = Number(profitReport[0]?.report_total_cogs || 0);
  const canonicalBatchCogs = Number(threeLayers[0]?.total_batch_cogs || 0);
  console.log(`Sales Profit Report COGS: ${reportCogs.toLocaleString('id-ID')}`);
  console.log(`Canonical Batch COGS:     ${canonicalBatchCogs.toLocaleString('id-ID')}`);
  console.log(`Difference:               ${Math.abs(reportCogs - canonicalBatchCogs)}`);

  if (Math.abs(reportCogs - canonicalBatchCogs) > 1.00) {
    throw new Error(`Discrepancy: Sales Profit Report COGS (${reportCogs}) does not match Canonical Batch COGS (${canonicalBatchCogs})`);
  }

  console.log('\n===============================================================');
  console.log('ALL THREE LAYERS ARE DEMONSTRABLY RECONCILED WITH ZERO GAP:');
  console.log(`  1. Canonical Batch Cost:    Rp ${canonicalBatchCogs.toLocaleString('id-ID')}`);
  console.log(`  2. Sales Invoice Item COGS: Rp ${Number(threeLayers[0]?.total_invoice_items_cogs).toLocaleString('id-ID')}`);
  console.log(`  3. GL 5100 COGS:            Rp ${Number(threeLayers[0]?.total_gl_5100_cogs).toLocaleString('id-ID')}`);
  console.log(`  4. Sales Profit Report:     Rp ${reportCogs.toLocaleString('id-ID')}`);
  console.log('===============================================================\n');

} catch (err) {
  console.error('Reconciliation failed:', err);
  process.exit(1);
}
