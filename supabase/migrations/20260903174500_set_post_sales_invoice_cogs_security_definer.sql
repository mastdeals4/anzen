-- ============================================================================
-- Fix: Set post_sales_invoice_cogs() to SECURITY DEFINER
-- ============================================================================
-- When non-admin roles (e.g. warehouse) create a Sales Invoice from an approved
-- Delivery Challan, the deferred COGS trigger fires at transaction commit.
-- Because post_sales_invoice_cogs was previously SECURITY INVOKER, it executed
-- under the caller's identity and violated journal_entries RLS (42501).
--
-- Making post_sales_invoice_cogs SECURITY DEFINER (matching post_sales_invoice_journal)
-- ensures the internal trigger posts COGS securely under function owner (postgres)
-- without granting direct journal_entries write access to warehouse users.
-- ============================================================================

CREATE OR REPLACE FUNCTION public.post_sales_invoice_cogs()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $function$
DECLARE
  v_existing_cogs_je_id UUID;
  v_je_id UUID;
  v_je_number TEXT;
  v_cogs_account_id UUID;
  v_inventory_account_id UUID;
  v_item RECORD;
  v_total_cogs NUMERIC := 0;
BEGIN
  -- Only consider invoices that have already had their revenue JE posted.
  IF NEW.journal_entry_id IS NULL THEN
    RETURN NEW;
  END IF;

  -- Skip non-billable invoices (drafts, voids, cancellations).
  IF NEW.payment_status NOT IN ('pending', 'partial', 'paid') THEN
    RETURN NEW;
  END IF;

  -- Idempotency: never post a second COGS JE for the same invoice.
  SELECT id INTO v_existing_cogs_je_id
  FROM journal_entries
  WHERE source_module = 'sales_invoice_cogs'
    AND reference_id = NEW.id
  LIMIT 1;

  IF v_existing_cogs_je_id IS NOT NULL THEN
    RETURN NEW;
  END IF;

  SELECT id INTO v_cogs_account_id      FROM chart_of_accounts WHERE code = '5100' LIMIT 1;
  SELECT id INTO v_inventory_account_id FROM chart_of_accounts WHERE code = '1130' LIMIT 1;

  IF v_cogs_account_id IS NULL OR v_inventory_account_id IS NULL THEN
    -- Configuration missing — surface this loudly rather than silently skip.
    RAISE EXCEPTION
      'post_sales_invoice_cogs: chart_of_accounts is missing 5100 (COGS) or 1130 (Inventory). Cannot post COGS for invoice %.',
      NEW.invoice_number;
  END IF;

  -- Compute COGS from items (now guaranteed to exist — this trigger fires
  -- at end of transaction via DEFERRABLE INITIALLY DEFERRED).
  --
  -- Cost basis priority: landed_cost_per_unit → cost_per_unit → 0.
  -- An invoice item without a batch_id is skipped (no cost basis).
  FOR v_item IN
    SELECT
      sii.quantity,
      sii.batch_id,
      COALESCE(b.landed_cost_per_unit, b.cost_per_unit, 0) AS effective_cost
    FROM sales_invoice_items sii
    LEFT JOIN batches b ON b.id = sii.batch_id
    WHERE sii.invoice_id = NEW.id
      AND sii.batch_id IS NOT NULL
  LOOP
    v_total_cogs := v_total_cogs + (COALESCE(v_item.quantity, 0) * v_item.effective_cost);
  END LOOP;

  -- No cost basis available (no items, all items have no batch, or all
  -- batches have zero cost). Nothing to post.
  IF v_total_cogs <= 0 THEN
    RETURN NEW;
  END IF;

  v_je_number := next_journal_entry_number();

  INSERT INTO journal_entries (
    entry_number, entry_date, source_module, reference_id, reference_number,
    description, total_debit, total_credit, is_posted, posted_by, created_by
  ) VALUES (
    v_je_number, NEW.invoice_date, 'sales_invoice_cogs', NEW.id, NEW.invoice_number,
    'COGS for Sales Invoice: ' || NEW.invoice_number,
    v_total_cogs, v_total_cogs, true, NEW.created_by, NEW.created_by
  )
  RETURNING id INTO v_je_id;

  -- Dr: COGS
  INSERT INTO journal_entry_lines (
    journal_entry_id, line_number, account_id, description, debit, credit, customer_id
  ) VALUES (
    v_je_id, 1, v_cogs_account_id, 'COGS - ' || NEW.invoice_number,
    v_total_cogs, 0, NEW.customer_id
  );

  -- Cr: Inventory
  INSERT INTO journal_entry_lines (
    journal_entry_id, line_number, account_id, description, debit, credit, customer_id
  ) VALUES (
    v_je_id, 2, v_inventory_account_id, 'Inventory - ' || NEW.invoice_number,
    0, v_total_cogs, NEW.customer_id
  );

  RETURN NEW;

EXCEPTION
  WHEN OTHERS THEN
    RAISE LOG 'post_sales_invoice_cogs failed for invoice %: %', NEW.id, SQLERRM;
    RAISE;
END;
$function$;
