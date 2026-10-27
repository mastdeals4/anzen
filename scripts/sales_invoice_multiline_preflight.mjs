import { execSync } from "child_process";

// Query all multi-line invoices in scope with line details, batch details, GL journals, and attribution
const query = `
WITH invoice_gl_lines AS (
  SELECT 
    si.id AS invoice_id,
    je.id AS journal_id,
    je.entry_number,
    je.entry_date,
    je.source_module,
    jel.id AS jel_id,
    jel.account_id,
    jel.debit - jel.credit AS net_gl_cogs,
    jel.sales_invoice_item_id,
    jel.batch_id
  FROM sales_invoices si
  JOIN journal_entries je ON (je.reference_id = si.id OR je.id = si.journal_entry_id)
  JOIN journal_entry_lines jel ON jel.journal_entry_id = je.id
  WHERE si.is_draft = false
    AND si.invoice_date BETWEEN '2025-11-29' AND '2026-09-21'
    AND je.is_posted = true AND NOT COALESCE(je.is_reversed, false)
    AND jel.account_id = 'f78ba556-94ff-456b-8645-34d6b0494d97'
),
invoice_gl_totals AS (
  SELECT 
    invoice_id,
    SUM(net_gl_cogs) AS total_gl_cogs,
    SUM(net_gl_cogs) FILTER (WHERE sales_invoice_item_id IS NOT NULL) AS direct_gl_cogs_total,
    SUM(net_gl_cogs) FILTER (WHERE sales_invoice_item_id IS NULL) AS unattributed_gl_cogs_total,
    COUNT(*) FILTER (WHERE sales_invoice_item_id IS NOT NULL) AS direct_gl_line_count,
    COUNT(*) FILTER (WHERE sales_invoice_item_id IS NULL) AS unattributed_gl_line_count,
    COUNT(DISTINCT journal_id) FILTER (WHERE source_module LIKE '%correction%') AS correction_entry_count
  FROM invoice_gl_lines
  GROUP BY invoice_id
),
line_direct_gl AS (
  SELECT 
    sales_invoice_item_id AS line_id,
    SUM(net_gl_cogs) AS directly_attributed_gl_cogs
  FROM invoice_gl_lines
  WHERE sales_invoice_item_id IS NOT NULL
  GROUP BY sales_invoice_item_id
)
SELECT 
  si.id AS invoice_id,
  si.invoice_number,
  si.invoice_date,
  sii.id AS line_id,
  p.id AS product_id,
  COALESCE(p.product_name, 'Unknown') AS product_name,
  b.id AS batch_id,
  COALESCE(b.batch_number, 'No Batch') AS batch_number,
  sii.quantity,
  COALESCE(NULLIF(b.landed_cost_per_unit, 0), NULLIF(b.cost_per_unit, 0), NULLIF(b.import_price, 0), 0) AS canonical_unit_cost,
  ROUND(sii.quantity * COALESCE(NULLIF(b.landed_cost_per_unit, 0), NULLIF(b.cost_per_unit, 0), NULLIF(b.import_price, 0), 0), 2) AS canonical_batch_cogs,
  sii.cogs_total_cost AS snapshot_cogs,
  COALESCE(ldg.directly_attributed_gl_cogs, 0) AS directly_attributed_gl_cogs,
  ldg.directly_attributed_gl_cogs IS NOT NULL AS has_direct_gl,
  COALESCE(igt.total_gl_cogs, 0) AS invoice_level_gl_cogs,
  COALESCE(igt.unattributed_gl_cogs_total, 0) AS unattributed_gl_cogs_total,
  COALESCE(igt.direct_gl_line_count, 0) AS direct_gl_line_count,
  COALESCE(igt.unattributed_gl_line_count, 0) AS unattributed_gl_line_count,
  COALESCE(igt.correction_entry_count, 0) AS correction_entry_count
FROM sales_invoices si
JOIN sales_invoice_items sii ON sii.invoice_id = si.id
LEFT JOIN products p ON p.id = sii.product_id
LEFT JOIN batches b ON b.id = sii.batch_id
LEFT JOIN invoice_gl_totals igt ON igt.invoice_id = si.id
LEFT JOIN line_direct_gl ldg ON ldg.line_id = sii.id
WHERE si.is_draft = false
  AND si.invoice_date BETWEEN '2025-11-29' AND '2026-09-21'
  AND si.id IN (
    SELECT invoice_id FROM sales_invoice_items GROUP BY invoice_id HAVING count(*) > 1
  )
ORDER BY si.invoice_date, si.invoice_number, sii.id;
`;

console.log("Executing pre-flight analysis query...");
const raw = execSync(`npx supabase db query --linked -o json "${query.replace(/\n/g, " ")}"`, {
  encoding: "utf8",
  maxBuffer: 10 * 1024 * 1024
});

const parsed = JSON.parse(raw);
const rows = parsed.rows || [];

// Group rows by invoice
const invoices = new Map();
for (const r of rows) {
  if (!invoices.has(r.invoice_id)) {
    invoices.set(r.invoice_id, {
      id: r.invoice_id,
      invoice_number: r.invoice_number,
      invoice_date: r.invoice_date,
      invoice_level_gl_cogs: parseFloat(r.invoice_level_gl_cogs),
      unattributed_gl_cogs_total: parseFloat(r.unattributed_gl_cogs_total),
      unattributed_gl_line_count: parseInt(r.unattributed_gl_line_count, 10),
      correction_entry_count: parseInt(r.correction_entry_count, 10),
      lines: []
    });
  }
  invoices.get(r.invoice_id).lines.push({
    line_id: r.line_id,
    product_id: r.product_id,
    product_name: r.product_name,
    batch_id: r.batch_id,
    batch_number: r.batch_number,
    quantity: parseFloat(r.quantity),
    canonical_unit_cost: parseFloat(r.canonical_unit_cost),
    canonical_batch_cogs: parseFloat(r.canonical_batch_cogs),
    snapshot_cogs: r.snapshot_cogs !== null ? parseFloat(r.snapshot_cogs) : null,
    directly_attributed_gl_cogs: parseFloat(r.directly_attributed_gl_cogs),
    has_direct_gl: r.has_direct_gl
  });
}

console.log(`Found ${invoices.size} multi-line sales invoices in scope.`);

// Analyze each invoice and line
const report = [];

for (const [invId, inv] of invoices) {
  const lineCount = inv.lines.length;
  const distinctProducts = new Set(inv.lines.map(l => l.product_id)).size;
  const distinctBatches = new Set(inv.lines.map(l => l.batch_id)).size;

  const totalCanonicalCost = inv.lines.reduce((sum, l) => sum + l.canonical_batch_cogs, 0);
  const totalSnapshotCost = inv.lines.reduce((sum, l) => sum + (l.snapshot_cogs || 0), 0);
  const totalDirectGL = inv.lines.reduce((sum, l) => sum + l.directly_attributed_gl_cogs, 0);

  // Check how allocation should be computed
  // If invoice has unattributed GL COGS, allocate pro-rata based on canonical cost
  const linesWithAlloc = inv.lines.map(l => {
    let allocated_gl_cogs = 0;
    if (inv.unattributed_gl_line_count === 0 && l.has_direct_gl) {
      allocated_gl_cogs = l.directly_attributed_gl_cogs;
    } else {
      // Line directly attributed plus pro-rata share of unattributed GL
      const share = totalCanonicalCost > 0 ? (l.canonical_batch_cogs / totalCanonicalCost) : (1 / lineCount);
      allocated_gl_cogs = l.directly_attributed_gl_cogs + (inv.unattributed_gl_cogs_total * share);
    }
    const variance = allocated_gl_cogs - l.canonical_batch_cogs;
    return {
      ...l,
      allocated_gl_cogs: Math.round(allocated_gl_cogs * 100) / 100,
      variance: Math.round(variance * 100) / 100
    };
  });

  // Check flag conditions:
  // 1. Invoice total matches but line allocation differs:
  const invTotalDiff = Math.abs(inv.invoice_level_gl_cogs - totalCanonicalCost);
  const invoiceTotalMatches = invTotalDiff < 1.0;
  const anyLineVariance = linesWithAlloc.some(l => Math.abs(l.variance) > 1.0);
  const flagTotalMatchesLineDiffers = invoiceTotalMatches && anyLineVariance;

  // 2. Multiple batches/products exist and line attribution is inferred:
  const lineAttributionIsInferred = inv.unattributed_gl_line_count > 0;
  const flagMultiBatchInferred = (distinctBatches > 1 || distinctProducts > 1) && lineAttributionIsInferred;

  // 3. Historical COGS correction entries exist:
  const flagHistoricalCorrections = inv.correction_entry_count > 0;

  // 4. A line remains unresolved:
  const flagUnresolved = linesWithAlloc.some(l => !l.batch_id || l.canonical_batch_cogs === 0);

  const flags = [];
  if (flagTotalMatchesLineDiffers) flags.push("INVOICE_TOTAL_MATCHES_LINE_ALLOCATION_DIFFERS");
  if (flagMultiBatchInferred) flags.push("MULTI_BATCH_OR_PRODUCT_INFERRED_ATTRIBUTION");
  if (flagHistoricalCorrections) flags.push("HISTORICAL_COGS_CORRECTIONS_EXIST");
  if (flagUnresolved) flags.push("LINE_REMAINS_UNRESOLVED");

  report.push({
    invoice_number: inv.invoice_number,
    invoice_date: inv.invoice_date,
    line_count: lineCount,
    distinct_products: distinctProducts,
    distinct_batches: distinctBatches,
    total_canonical_cost: Math.round(totalCanonicalCost * 100) / 100,
    invoice_level_gl_cogs: inv.invoice_level_gl_cogs,
    unattributed_gl_line_count: inv.unattributed_gl_line_count,
    correction_entry_count: inv.correction_entry_count,
    flags,
    is_flagged: flags.length > 0,
    lines: linesWithAlloc
  });
}

console.log(JSON.stringify(report, null, 2));
