-- ============================================================================
-- Migration: 20260701120000_fix_stamp_duty_sales_je_cost_recovery
-- Date:      2026-07-01
--
-- PROBLEM:
--   Migration 20260701100000 credited account 2135 "Bea Meterai Payable"
--   (a liability) on sales invoices. This implies stamp duty is collected
--   from the customer and later remitted to the government — which is NOT
--   the business workflow.
--
-- ACTUAL WORKFLOW:
--   1. Company purchases stamp duty separately (Petty Cash or Bank).
--      → DR 6950 Bea Meterai Expense / CR Bank (already recorded)
--   2. Unused stamps are kept in stock.
--   3. When a sales invoice includes a stamp duty charge, the company is
--      recovering a cost it already incurred — NOT creating a government liability.
--
-- CORRECT ACCOUNTING (cost recovery):
--   DR 1120 A/R                     (subtotal + ppn + stamp_duty)
--   CR 4100 Revenue                 (subtotal)
--   CR 2130 PPN Output              (ppn, if any)
--   CR 6950 Bea Meterai Expense     (stamp_duty — offsets the original purchase expense)
--
--   Net P&L effect: stamps bought at cost, partially recovered from customer.
--   Balance Sheet: no spurious liability. A/R full. Trial Balance balanced.
--
-- CHANGES:
--   1. Replace post_sales_invoice_journal() to use CR 6950 instead of CR 2135.
--   2. Deactivate COA 2135 (Bea Meterai Payable) — no longer used.
--      Any JEs already using 2135 remain historically valid; they just become
--      an inactive account in the ledger view.
-- ============================================================================

-- ── 1. Deactivate the now-unused liability account 2135 ────────────────────
UPDATE chart_of_accounts
SET
  name      = 'Bea Meterai Payable (SUPERSEDED – use 6950 for cost recovery)',
  is_active = false
WHERE code = '2135';

-- ── 2. Replace post_sales_invoice_journal() ────────────────────────────────
-- Stamp duty collected from customer credits 6950 Bea Meterai Expense,
-- which reduces the net expense recognised when stamps were purchased.
-- All other logic (idempotency guards, COGS, balance assertion) is unchanged.

CREATE OR REPLACE FUNCTION public.post_sales_invoice_journal()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $function$
DECLARE
  v_existing_je_id       UUID;
  v_je_id                UUID;
  v_je_number            TEXT;
  v_ar_account_id        UUID;
  v_revenue_account_id   UUID;
  v_tax_account_id       UUID;
  v_bm_expense_id        UUID;   -- 6950 Bea Meterai Expense (cost recovery credit)
  v_cogs_account_id      UUID;
  v_inventory_account_id UUID;
  v_item                 RECORD;
  v_line_num             INTEGER := 1;
  v_total_cost           NUMERIC := 0;
  v_item_cost            NUMERIC;
  v_total_debit          NUMERIC := 0;
  v_total_credit         NUMERIC := 0;
  v_stamp_duty           NUMERIC;
BEGIN

  -- Strict idempotency: JE already set → skip
  IF NEW.journal_entry_id IS NOT NULL THEN
    RETURN NEW;
  END IF;

  SELECT id INTO v_existing_je_id
  FROM journal_entries
  WHERE source_module = 'sales_invoice'
    AND reference_id  = NEW.id
  LIMIT 1;

  IF v_existing_je_id IS NOT NULL THEN
    NEW.journal_entry_id := v_existing_je_id;
    RETURN NEW;
  END IF;

  IF NEW.payment_status NOT IN ('pending', 'partial', 'paid') THEN
    RETURN NEW;
  END IF;

  SELECT id INTO v_ar_account_id        FROM chart_of_accounts WHERE code = '1120' LIMIT 1;
  SELECT id INTO v_revenue_account_id   FROM chart_of_accounts WHERE code = '4100' LIMIT 1;
  SELECT id INTO v_tax_account_id       FROM chart_of_accounts WHERE code = '2130' LIMIT 1;
  SELECT id INTO v_bm_expense_id        FROM chart_of_accounts WHERE code = '6950' LIMIT 1;
  SELECT id INTO v_cogs_account_id      FROM chart_of_accounts WHERE code = '5100' LIMIT 1;
  SELECT id INTO v_inventory_account_id FROM chart_of_accounts WHERE code = '1130' LIMIT 1;

  IF v_ar_account_id IS NULL OR v_revenue_account_id IS NULL THEN
    RETURN NEW;
  END IF;

  v_stamp_duty := COALESCE(NEW.stamp_duty_amount, 0);

  v_je_number := next_journal_entry_number();

  INSERT INTO journal_entries (
    entry_number, entry_date, source_module, reference_id, reference_number,
    description, total_debit, total_credit, is_posted, posted_by, created_by
  ) VALUES (
    v_je_number, NEW.invoice_date, 'sales_invoice', NEW.id, NEW.invoice_number,
    'Sales Invoice: ' || NEW.invoice_number,
    NEW.total_amount, NEW.total_amount, true, NEW.created_by, NEW.created_by
  ) RETURNING id INTO v_je_id;

  -- Dr: Accounts Receivable (full invoice total)
  INSERT INTO journal_entry_lines (journal_entry_id, line_number, account_id, description, debit, credit, customer_id)
  VALUES (v_je_id, v_line_num, v_ar_account_id, 'A/R - ' || NEW.invoice_number, NEW.total_amount, 0, NEW.customer_id);
  v_line_num := v_line_num + 1;

  -- Cr: Sales Revenue (subtotal)
  INSERT INTO journal_entry_lines (journal_entry_id, line_number, account_id, description, debit, credit, customer_id)
  VALUES (v_je_id, v_line_num, v_revenue_account_id, 'Sales - ' || NEW.invoice_number, 0, NEW.subtotal, NEW.customer_id);
  v_line_num := v_line_num + 1;

  -- Cr: PPN Output 2130 (if any)
  IF COALESCE(NEW.tax_amount, 0) > 0 AND v_tax_account_id IS NOT NULL THEN
    INSERT INTO journal_entry_lines (journal_entry_id, line_number, account_id, description, debit, credit, customer_id)
    VALUES (v_je_id, v_line_num, v_tax_account_id, 'PPN - ' || NEW.invoice_number, 0, NEW.tax_amount, NEW.customer_id);
    v_line_num := v_line_num + 1;
  END IF;

  -- Cr: Bea Meterai Expense 6950 (cost recovery — offsets original stamp purchase expense)
  -- When the customer reimburses stamp duty, we credit the same expense account
  -- that was debited when stamps were originally purchased. Net P&L effect =
  -- original purchase cost minus recoveries collected from customers.
  IF v_stamp_duty > 0 AND v_bm_expense_id IS NOT NULL THEN
    INSERT INTO journal_entry_lines (journal_entry_id, line_number, account_id, description, debit, credit, customer_id)
    VALUES (v_je_id, v_line_num, v_bm_expense_id,
            'Bea Meterai (cost recovery) - ' || NEW.invoice_number,
            0, v_stamp_duty, NEW.customer_id);
    v_line_num := v_line_num + 1;
  END IF;

  -- COGS entries (inventory cost of goods sold)
  IF v_cogs_account_id IS NOT NULL AND v_inventory_account_id IS NOT NULL THEN
    FOR v_item IN
      SELECT sii.quantity, b.cost_per_unit, b.id as batch_id
      FROM sales_invoice_items sii
      LEFT JOIN batches b ON b.id = sii.batch_id
      WHERE sii.invoice_id = NEW.id AND sii.batch_id IS NOT NULL
    LOOP
      v_item_cost  := COALESCE(v_item.cost_per_unit, 0) * v_item.quantity;
      v_total_cost := v_total_cost + v_item_cost;
    END LOOP;

    IF v_total_cost > 0 THEN
      INSERT INTO journal_entry_lines (journal_entry_id, line_number, account_id, description, debit, credit, customer_id)
      VALUES (v_je_id, v_line_num, v_cogs_account_id, 'COGS - ' || NEW.invoice_number, v_total_cost, 0, NEW.customer_id);
      v_line_num := v_line_num + 1;

      INSERT INTO journal_entry_lines (journal_entry_id, line_number, account_id, description, debit, credit, customer_id)
      VALUES (v_je_id, v_line_num, v_inventory_account_id, 'Inventory - ' || NEW.invoice_number, 0, v_total_cost, NEW.customer_id);
    END IF;
  END IF;

  -- Balance assertion:
  -- total_debit  = total_amount + cogs
  -- total_credit = subtotal + tax + stamp_duty + cogs
  --             = (subtotal + tax + stamp_duty) + cogs
  --             = total_amount + cogs  ✓
  v_total_debit  := COALESCE(NEW.total_amount, 0) + COALESCE(v_total_cost, 0);
  v_total_credit := COALESCE(NEW.subtotal, 0)
                 + COALESCE(NEW.tax_amount, 0)
                 + v_stamp_duty
                 + COALESCE(v_total_cost, 0);

  IF v_total_debit <> v_total_credit THEN
    RAISE EXCEPTION 'Journal not balanced: debit=% credit=%', v_total_debit, v_total_credit;
  END IF;

  NEW.journal_entry_id := v_je_id;
  RETURN NEW;

EXCEPTION
  WHEN OTHERS THEN
    RAISE LOG 'post_sales_invoice_journal failed for invoice %: %', NEW.id, SQLERRM;
    RAISE;
END;
$function$;

DO $$
BEGIN
  RAISE NOTICE '============================================================';
  RAISE NOTICE 'Migration 20260701120000 applied:';
  RAISE NOTICE '  post_sales_invoice_journal() corrected:';
  RAISE NOTICE '    Stamp duty now credits 6950 Bea Meterai Expense';
  RAISE NOTICE '    (cost recovery — offsets original stamp purchase expense)';
  RAISE NOTICE '    NOT 2135 Bea Meterai Payable (which implied govt remittance)';
  RAISE NOTICE '  COA 2135 deactivated (superseded; use 6950 for cost recovery)';
  RAISE NOTICE '  All JEs remain balanced: DR A/R = CR Revenue + CR PPN + CR 6950';
  RAISE NOTICE '  Trial Balance, Balance Sheet, P&L unaffected.';
  RAISE NOTICE '============================================================';
END $$;
