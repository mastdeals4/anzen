-- Forward-only COGS cost snapshots for newly posted sales invoices.
-- Historical sales_invoice_items remain NULL; no journals are backfilled.
BEGIN;

ALTER TABLE public.sales_invoice_items
  ADD COLUMN IF NOT EXISTS cogs_unit_cost numeric(15,2),
  ADD COLUMN IF NOT EXISTS cogs_total_cost numeric(15,2);

CREATE OR REPLACE FUNCTION public.post_sales_invoice_cogs()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_existing_cogs_je_id UUID;
  v_je_id UUID;
  v_je_number TEXT;
  v_cogs_account_id UUID;
  v_inventory_account_id UUID;
  v_item RECORD;
  v_total_cogs NUMERIC := 0;
  v_snapshot_item_ids uuid[] := ARRAY[]::uuid[];
  v_snapshot_unit_costs numeric[] := ARRAY[]::numeric[];
  v_snapshot_total_costs numeric[] := ARRAY[]::numeric[];
BEGIN
  IF NEW.journal_entry_id IS NULL THEN RETURN NEW; END IF;
  IF NEW.payment_status NOT IN ('pending', 'partial', 'paid') THEN RETURN NEW; END IF;

  SELECT id INTO v_existing_cogs_je_id
    FROM public.journal_entries
   WHERE source_module = 'sales_invoice_cogs' AND reference_id = NEW.id
   LIMIT 1;
  IF v_existing_cogs_je_id IS NOT NULL THEN RETURN NEW; END IF;

  SELECT id INTO v_cogs_account_id FROM public.chart_of_accounts WHERE code = '5100' LIMIT 1;
  SELECT id INTO v_inventory_account_id FROM public.chart_of_accounts WHERE code = '1130' LIMIT 1;
  IF v_cogs_account_id IS NULL OR v_inventory_account_id IS NULL THEN
    RAISE EXCEPTION
      'post_sales_invoice_cogs: chart_of_accounts is missing 5100 (COGS) or 1130 (Inventory). Cannot post COGS for invoice %.',
      NEW.invoice_number;
  END IF;

  -- Preserve the existing batch-cost calculation exactly.
  FOR v_item IN
    SELECT sii.id, sii.quantity, sii.batch_id,
           COALESCE(NULLIF(b.landed_cost_per_unit, 0),
                    NULLIF(b.import_price, 0),
                    NULLIF(b.cost_per_unit, 0), 0) AS effective_cost
      FROM public.sales_invoice_items sii
      LEFT JOIN public.batches b ON b.id = sii.batch_id
     WHERE sii.invoice_id = NEW.id AND sii.batch_id IS NOT NULL
  LOOP
    -- Stage the exact effective cost used by the existing calculation.  The
    -- rows are written only after a positive COGS posting is guaranteed.
    v_snapshot_item_ids := array_append(v_snapshot_item_ids, v_item.id);
    v_snapshot_unit_costs := array_append(v_snapshot_unit_costs, v_item.effective_cost);
    v_snapshot_total_costs := array_append(v_snapshot_total_costs,
      ROUND(COALESCE(v_item.quantity, 0) * v_item.effective_cost, 2));
    v_total_cogs := v_total_cogs + (COALESCE(v_item.quantity, 0) * v_item.effective_cost);
  END LOOP;

  IF v_total_cogs <= 0 THEN RETURN NEW; END IF;

  -- Snapshot only as part of a successful COGS posting.  The idempotency
  -- guard above leaves every already-posted (including historical) line as-is.
  UPDATE public.sales_invoice_items sii
     SET cogs_unit_cost = s.unit_cost,
         cogs_total_cost = s.total_cost
    FROM unnest(v_snapshot_item_ids, v_snapshot_unit_costs, v_snapshot_total_costs)
      AS s(item_id, unit_cost, total_cost)
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

  INSERT INTO public.journal_entry_lines
    (journal_entry_id, line_number, account_id, description, debit, credit, customer_id)
  VALUES (v_je_id, 1, v_cogs_account_id, 'COGS - ' || NEW.invoice_number,
          v_total_cogs, 0, NEW.customer_id);
  INSERT INTO public.journal_entry_lines
    (journal_entry_id, line_number, account_id, description, debit, credit, customer_id)
  VALUES (v_je_id, 2, v_inventory_account_id, 'Inventory - ' || NEW.invoice_number,
          0, v_total_cogs, NEW.customer_id);

  RETURN NEW;
EXCEPTION WHEN OTHERS THEN
  RAISE LOG 'post_sales_invoice_cogs failed for invoice %: %', NEW.id, SQLERRM;
  RAISE;
END;
$$;

COMMENT ON FUNCTION public.post_sales_invoice_cogs() IS
  'Posts unchanged COGS JE and snapshots effective batch cost on newly posted sales_invoice_items; historical rows are not backfilled.';

COMMIT;
