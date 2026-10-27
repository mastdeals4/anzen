-- Preserve sales-invoice-item and batch attribution for future COGS postings.
-- Existing journal lines and sales invoices are intentionally untouched.
BEGIN;

ALTER TABLE public.journal_entry_lines
  ADD COLUMN IF NOT EXISTS sales_invoice_item_id uuid
    REFERENCES public.sales_invoice_items(id) ON DELETE RESTRICT;

CREATE INDEX IF NOT EXISTS idx_journal_entry_lines_sales_invoice_item_id
  ON public.journal_entry_lines(sales_invoice_item_id)
  WHERE sales_invoice_item_id IS NOT NULL;

CREATE OR REPLACE FUNCTION public.post_sales_invoice_cogs()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_existing_cogs_je_id uuid;
  v_je_id uuid;
  v_je_number text;
  v_cogs_account_id uuid;
  v_inventory_account_id uuid;
  v_item record;
  v_total_cogs numeric := 0;
  v_line_number integer := 1;
  v_snapshot_item_ids uuid[] := ARRAY[]::uuid[];
  v_snapshot_batch_ids uuid[] := ARRAY[]::uuid[];
  v_snapshot_unit_costs numeric[] := ARRAY[]::numeric[];
  v_snapshot_total_costs numeric[] := ARRAY[]::numeric[];
BEGIN
  -- Keep existing posting eligibility and idempotency rules unchanged.
  IF NEW.journal_entry_id IS NULL THEN RETURN NEW; END IF;
  IF NEW.payment_status NOT IN ('pending', 'partial', 'paid') THEN RETURN NEW; END IF;

  -- Serialize posting attempts for this invoice.  The existing journal lookup
  -- remains the idempotency authority, while this lock closes the concurrent
  -- retry race without imposing a historical-data uniqueness constraint.
  PERFORM pg_advisory_xact_lock(hashtextextended(NEW.id::text, 0));

  SELECT id INTO v_existing_cogs_je_id
    FROM public.journal_entries
   WHERE source_module = 'sales_invoice_cogs'
     AND reference_id = NEW.id
   LIMIT 1;
  IF v_existing_cogs_je_id IS NOT NULL THEN RETURN NEW; END IF;

  SELECT id INTO v_cogs_account_id FROM public.chart_of_accounts WHERE code = '5100' LIMIT 1;
  SELECT id INTO v_inventory_account_id FROM public.chart_of_accounts WHERE code = '1130' LIMIT 1;
  IF v_cogs_account_id IS NULL OR v_inventory_account_id IS NULL THEN
    RAISE EXCEPTION
      'post_sales_invoice_cogs: chart_of_accounts is missing 5100 (COGS) or 1130 (Inventory). Cannot post COGS for invoice %.',
      NEW.invoice_number;
  END IF;

  -- Preserve the established cost source. Each item is rounded at the amount
  -- actually posted, so item debit/credit totals equal the journal total.
  FOR v_item IN
    SELECT sii.id, sii.quantity, sii.batch_id,
           COALESCE(NULLIF(b.landed_cost_per_unit, 0),
                    NULLIF(b.import_price, 0),
                    NULLIF(b.cost_per_unit, 0), 0) AS effective_cost
      FROM public.sales_invoice_items sii
      LEFT JOIN public.batches b ON b.id = sii.batch_id
     WHERE sii.invoice_id = NEW.id
       AND sii.batch_id IS NOT NULL
     ORDER BY sii.id
  LOOP
    v_snapshot_item_ids := array_append(v_snapshot_item_ids, v_item.id);
    v_snapshot_batch_ids := array_append(v_snapshot_batch_ids, v_item.batch_id);
    v_snapshot_unit_costs := array_append(v_snapshot_unit_costs, v_item.effective_cost);
    v_snapshot_total_costs := array_append(
      v_snapshot_total_costs,
      ROUND(COALESCE(v_item.quantity, 0) * v_item.effective_cost, 2)
    );
    v_total_cogs := v_total_cogs + ROUND(COALESCE(v_item.quantity, 0) * v_item.effective_cost, 2);
  END LOOP;

  IF v_total_cogs <= 0 THEN RETURN NEW; END IF;

  -- The snapshots and item-level journal lines are created in this trigger's
  -- single transaction; an error rolls back both.
  UPDATE public.sales_invoice_items sii
     SET cogs_unit_cost = s.unit_cost,
         cogs_total_cost = s.total_cost
    FROM unnest(
      v_snapshot_item_ids,
      v_snapshot_unit_costs,
      v_snapshot_total_costs
    ) AS s(item_id, unit_cost, total_cost)
   WHERE sii.id = s.item_id;

  v_je_number := public.next_journal_entry_number();
  INSERT INTO public.journal_entries (
    entry_number, entry_date, source_module, reference_id, reference_number,
    description, total_debit, total_credit, is_posted, posted_by, created_by
  ) VALUES (
    v_je_number, NEW.invoice_date, 'sales_invoice_cogs', NEW.id, NEW.invoice_number,
    'COGS for Sales Invoice: ' || NEW.invoice_number,
    v_total_cogs, v_total_cogs, true, NEW.created_by, NEW.created_by
  ) RETURNING id INTO v_je_id;

  FOR v_item IN
    SELECT item_id, batch_id, total_cost
      FROM unnest(v_snapshot_item_ids, v_snapshot_batch_ids, v_snapshot_total_costs)
        AS s(item_id, batch_id, total_cost)
     WHERE total_cost <> 0
     ORDER BY item_id
  LOOP
    INSERT INTO public.journal_entry_lines (
      journal_entry_id, line_number, account_id, description, debit, credit,
      customer_id, batch_id, sales_invoice_item_id
    ) VALUES (
      v_je_id, v_line_number, v_cogs_account_id,
      'COGS - ' || NEW.invoice_number, v_item.total_cost, 0,
      NEW.customer_id, v_item.batch_id, v_item.item_id
    );
    v_line_number := v_line_number + 1;

    INSERT INTO public.journal_entry_lines (
      journal_entry_id, line_number, account_id, description, debit, credit,
      customer_id, batch_id, sales_invoice_item_id
    ) VALUES (
      v_je_id, v_line_number, v_inventory_account_id,
      'Inventory - ' || NEW.invoice_number, 0, v_item.total_cost,
      NEW.customer_id, v_item.batch_id, v_item.item_id
    );
    v_line_number := v_line_number + 1;
  END LOOP;

  RETURN NEW;
EXCEPTION WHEN OTHERS THEN
  RAISE LOG 'post_sales_invoice_cogs failed for invoice %: %', NEW.id, SQLERRM;
  RAISE;
END;
$$;

COMMENT ON FUNCTION public.post_sales_invoice_cogs() IS
  'Posts future COGS with unchanged cost basis and immutable item/batch journal attribution; existing COGS journals are never modified.';

-- Prefer directly attributed, active posted 5100 lines for future report
-- drilldown. Historical lines continue through the existing evidence waterfall.
CREATE OR REPLACE FUNCTION public.get_authoritative_sales_line_cogs(
  p_start_date date,
  p_end_date date
)
RETURNS TABLE (
  line_id uuid,
  invoice_id uuid,
  product_id uuid,
  batch_id uuid,
  quantity numeric,
  authoritative_cogs numeric,
  authoritative_unit_cogs numeric,
  resolution_tier text,
  invoice_line_count bigint,
  invoice_product_count bigint,
  posted_invoice_cogs numeric,
  base_line_cost numeric,
  reconciliation_difference numeric
)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
WITH posted_cogs AS (
  SELECT
    je.reference_id AS invoice_id,
    SUM(jel.debit - jel.credit) AS posted_invoice_cogs
  FROM public.journal_entries je
  JOIN public.journal_entry_lines jel ON jel.journal_entry_id = je.id
  JOIN public.chart_of_accounts coa ON coa.id = jel.account_id
  WHERE je.source_module = 'sales_invoice_cogs'
    AND je.is_posted = true
    AND NOT COALESCE(je.is_reversed, false)
    AND coa.code = '5100'
  GROUP BY je.reference_id
), posted_item_cogs AS (
  SELECT
    jel.sales_invoice_item_id AS line_id,
    SUM(jel.debit - jel.credit) AS posted_item_cogs
  FROM public.journal_entries je
  JOIN public.journal_entry_lines jel ON jel.journal_entry_id = je.id
  JOIN public.chart_of_accounts coa ON coa.id = jel.account_id
  WHERE je.source_module = 'sales_invoice_cogs'
    AND je.is_posted = true
    AND NOT COALESCE(je.is_reversed, false)
    AND coa.code = '5100'
    AND jel.sales_invoice_item_id IS NOT NULL
  GROUP BY jel.sales_invoice_item_id
), line_basis AS (
  SELECT
    sii.id AS line_id,
    sii.invoice_id,
    sii.product_id,
    sii.batch_id,
    sii.quantity,
    pic.posted_item_cogs,
    sii.cogs_total_cost AS snapshot_cogs,
    CASE
      WHEN COALESCE(NULLIF(b.landed_cost_per_unit, 0), NULLIF(b.cost_per_unit, 0), NULLIF(b.import_price, 0)) IS NULL
        THEN NULL
      ELSE sii.quantity * COALESCE(NULLIF(b.landed_cost_per_unit, 0), NULLIF(b.cost_per_unit, 0), NULLIF(b.import_price, 0))
    END AS base_line_cost,
    pc.posted_invoice_cogs
  FROM public.sales_invoice_items sii
  JOIN public.sales_invoices si ON si.id = sii.invoice_id
  LEFT JOIN public.batches b ON b.id = sii.batch_id
  LEFT JOIN posted_cogs pc ON pc.invoice_id = sii.invoice_id
  LEFT JOIN posted_item_cogs pic ON pic.line_id = sii.id
  WHERE si.invoice_date BETWEEN p_start_date AND p_end_date
    AND NOT COALESCE(si.is_draft, false)
), invoice_evidence AS (
  SELECT
    invoice_id,
    COUNT(*) AS invoice_line_count,
    COUNT(DISTINCT product_id) AS invoice_product_count,
    COUNT(*) FILTER (WHERE posted_item_cogs IS NULL AND snapshot_cogs IS NULL) AS unresolved_line_count,
    COUNT(*) FILTER (
      WHERE posted_item_cogs IS NULL AND snapshot_cogs IS NULL AND base_line_cost IS NOT NULL
    ) AS unresolved_base_line_count,
    COALESCE(SUM(COALESCE(posted_item_cogs, snapshot_cogs)), 0) AS resolved_cogs_total,
    SUM(base_line_cost) FILTER (
      WHERE posted_item_cogs IS NULL AND snapshot_cogs IS NULL
    ) AS unresolved_base_cost_total,
    MAX(posted_invoice_cogs) AS posted_invoice_cogs
  FROM line_basis
  GROUP BY invoice_id
), resolved AS (
  SELECT
    lb.*,
    ie.invoice_line_count,
    ie.invoice_product_count,
    ie.unresolved_line_count,
    ie.unresolved_base_line_count,
    ie.resolved_cogs_total,
    ie.unresolved_base_cost_total,
    ie.posted_invoice_cogs AS invoice_posted_cogs,
    ie.posted_invoice_cogs - ie.resolved_cogs_total AS residual_posted_cogs,
    ABS(ie.unresolved_base_cost_total - (ie.posted_invoice_cogs - ie.resolved_cogs_total)) AS reconciliation_difference
  FROM line_basis lb
  JOIN invoice_evidence ie ON ie.invoice_id = lb.invoice_id
)
SELECT
  r.line_id,
  r.invoice_id,
  r.product_id,
  r.batch_id,
  r.quantity,
  CASE
    WHEN r.posted_item_cogs IS NOT NULL THEN r.posted_item_cogs
    WHEN r.snapshot_cogs IS NOT NULL THEN r.snapshot_cogs
    WHEN r.invoice_line_count = 1 AND r.invoice_posted_cogs IS NOT NULL THEN r.invoice_posted_cogs
    WHEN r.invoice_line_count > 1
      AND r.invoice_posted_cogs IS NOT NULL
      AND r.unresolved_line_count = r.unresolved_base_line_count
      AND r.unresolved_base_cost_total > 0
      AND ABS(r.unresolved_base_cost_total - r.residual_posted_cogs) <= 1.00
      THEN r.base_line_cost * (r.residual_posted_cogs / r.unresolved_base_cost_total)
    ELSE NULL
  END AS authoritative_cogs,
  CASE
    WHEN r.quantity = 0 THEN NULL
    WHEN r.posted_item_cogs IS NOT NULL THEN r.posted_item_cogs / r.quantity
    WHEN r.snapshot_cogs IS NOT NULL THEN r.snapshot_cogs / r.quantity
    WHEN r.invoice_line_count = 1 AND r.invoice_posted_cogs IS NOT NULL THEN r.invoice_posted_cogs / r.quantity
    WHEN r.invoice_line_count > 1
      AND r.invoice_posted_cogs IS NOT NULL
      AND r.unresolved_line_count = r.unresolved_base_line_count
      AND r.unresolved_base_cost_total > 0
      AND ABS(r.unresolved_base_cost_total - r.residual_posted_cogs) <= 1.00
      THEN (r.base_line_cost * (r.residual_posted_cogs / r.unresolved_base_cost_total)) / r.quantity
    ELSE NULL
  END AS authoritative_unit_cogs,
  CASE
    WHEN r.posted_item_cogs IS NOT NULL THEN 'posted_item_cogs'
    WHEN r.snapshot_cogs IS NOT NULL THEN 'snapshot'
    WHEN r.invoice_line_count = 1 AND r.invoice_posted_cogs IS NOT NULL THEN 'single_line_posted_cogs'
    WHEN r.invoice_line_count > 1
      AND r.invoice_product_count = 1
      AND r.invoice_posted_cogs IS NOT NULL
      AND r.unresolved_line_count = r.unresolved_base_line_count
      AND r.unresolved_base_cost_total > 0
      AND ABS(r.unresolved_base_cost_total - r.residual_posted_cogs) <= 1.00
      THEN 'single_product_proven_allocation'
    WHEN r.invoice_line_count > 1
      AND r.invoice_product_count > 1
      AND r.invoice_posted_cogs IS NOT NULL
      AND r.unresolved_line_count = r.unresolved_base_line_count
      AND r.unresolved_base_cost_total > 0
      AND ABS(r.unresolved_base_cost_total - r.residual_posted_cogs) <= 1.00
      THEN 'multi_product_proven_allocation'
    ELSE 'unresolved'
  END AS resolution_tier,
  r.invoice_line_count,
  r.invoice_product_count,
  r.invoice_posted_cogs,
  r.base_line_cost,
  r.reconciliation_difference
FROM resolved r;
$$;

COMMENT ON FUNCTION public.get_authoritative_sales_line_cogs(date, date) IS
  'Read-only COGS waterfall that prefers active posted item-attributed GL 5100 lines for future invoices, then uses existing historical evidence rules.';

GRANT EXECUTE ON FUNCTION public.get_authoritative_sales_line_cogs(date, date) TO authenticated;

COMMIT;
