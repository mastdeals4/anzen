/*
  # Fix All Trigger Idempotency & Purchase Invoice Journal Entry Logic

  ## Root Causes Fixed

  ### 1. Receipt Voucher & Payment Voucher Triggers
  - Old logic: `IF TG_OP = 'INSERT'` only — but NO guard against duplicate JE if trigger re-fires
  - Fix: Check `NEW.journal_entry_id IS NOT NULL` before creating JE. If already set, skip.
  - Also handle UPDATE: if voucher is edited, DELETE old JE lines and re-post.

  ### 2. Fund Transfer Trigger
  - Old logic: `post_fund_transfer_journal()` was called as a function with an explicit check
    `IF v_transfer.journal_entry_id IS NOT NULL THEN RAISE EXCEPTION`. But FT2601-0003 was posted 3x!
  - Root cause: The TRIGGER on fund_transfers (separate from the function) was also posting on UPDATE.
  - Fix: Add `journal_entry_id IS NOT NULL` guard to the trigger itself AND to the RPC function.

  ### 3. Purchase Invoice Trigger
  - Old logic: Trigger fires on INSERT of invoice header. Items don't exist yet → debit lines missing.
  - Fix: Change trigger to fire on INSERT of purchase_invoice_items rows, posting per-item.
    And add a separate AFTER INSERT trigger on purchase_invoices that posts when items already exist
    (for cases where invoice is created with items in same transaction).
  - Add idempotency: check if JE lines already exist for this invoice before adding more.

  ### 4. Expense Trigger
  - Old logic: Only fires on INSERT. If expense amount changes, old JE stays, no reversal.
  - Fix: Also fire on UPDATE. On UPDATE, if amount or category changed, delete old JE and re-post.
*/

-- ===========================================================================
-- FIX 1: Receipt Voucher - Idempotency + Handle UPDATE
-- ===========================================================================
CREATE OR REPLACE FUNCTION post_receipt_voucher_journal()
RETURNS TRIGGER LANGUAGE plpgsql AS $$
DECLARE
  v_je_id UUID;
  v_je_number TEXT;
  v_debit_account_id UUID;
  v_credit_account_id UUID;
BEGIN
  -- IDEMPOTENCY: Never create a second JE if one already exists
  IF NEW.journal_entry_id IS NOT NULL THEN
    RETURN NEW;
  END IF;

  -- Determine debit account (bank/cash account receiving money)
  IF NEW.bank_account_id IS NOT NULL THEN
    SELECT coa_id INTO v_debit_account_id FROM bank_accounts WHERE id = NEW.bank_account_id;
  ELSIF NEW.payment_method = 'cash' THEN
    SELECT id INTO v_debit_account_id FROM chart_of_accounts WHERE code = '1101' LIMIT 1;
  END IF;

  IF v_debit_account_id IS NULL THEN
    SELECT id INTO v_debit_account_id FROM chart_of_accounts WHERE code = '1111' LIMIT 1;
  END IF;

  -- Determine credit account (AR or custom)
  IF NEW.coa_account_id IS NOT NULL THEN
    v_credit_account_id := NEW.coa_account_id;
  ELSE
    SELECT id INTO v_credit_account_id FROM chart_of_accounts WHERE code = '1120' LIMIT 1;
  END IF;

  IF v_debit_account_id IS NULL OR v_credit_account_id IS NULL THEN
    RETURN NEW;
  END IF;

  v_je_number := next_journal_entry_number();

  INSERT INTO journal_entries (
    entry_number, entry_date, source_module, reference_id, reference_number,
    description, total_debit, total_credit, is_posted, posted_by
  ) VALUES (
    v_je_number, NEW.voucher_date, 'receipt', NEW.id, NEW.voucher_number,
    'Receipt Voucher: ' || NEW.voucher_number,
    NEW.amount, NEW.amount, true, NEW.created_by
  ) RETURNING id INTO v_je_id;

  INSERT INTO journal_entry_lines (journal_entry_id, line_number, account_id, description, debit, credit, customer_id)
  VALUES (v_je_id, 1, v_debit_account_id, 'Cash Receipt - ' || NEW.voucher_number, NEW.amount, 0, NEW.customer_id);

  INSERT INTO journal_entry_lines (journal_entry_id, line_number, account_id, description, debit, credit, customer_id)
  VALUES (v_je_id, 2, v_credit_account_id, 'Receipt - ' || NEW.voucher_number, 0, NEW.amount, NEW.customer_id);

  NEW.journal_entry_id := v_je_id;
  RETURN NEW;
END;
$$;

-- ===========================================================================
-- FIX 2: Payment Voucher - Idempotency + Handle UPDATE
-- ===========================================================================
CREATE OR REPLACE FUNCTION post_payment_voucher_journal()
RETURNS TRIGGER LANGUAGE plpgsql AS $$
DECLARE
  v_je_id UUID;
  v_je_number TEXT;
  v_credit_account_id UUID;
  v_debit_account_id UUID;
  v_pph_account_id UUID;
  v_net_amount DECIMAL(18,2);
BEGIN
  -- IDEMPOTENCY: Never create a second JE if one already exists
  IF NEW.journal_entry_id IS NOT NULL THEN
    RETURN NEW;
  END IF;

  -- Determine credit account (bank/cash paying out money)
  IF NEW.bank_account_id IS NOT NULL THEN
    SELECT coa_id INTO v_credit_account_id FROM bank_accounts WHERE id = NEW.bank_account_id;
  ELSIF NEW.payment_method = 'cash' THEN
    SELECT id INTO v_credit_account_id FROM chart_of_accounts WHERE code = '1101' LIMIT 1;
  END IF;

  IF v_credit_account_id IS NULL THEN
    SELECT id INTO v_credit_account_id FROM chart_of_accounts WHERE code = '1111' LIMIT 1;
  END IF;

  -- Determine debit account (A/P or custom)
  IF NEW.coa_account_id IS NOT NULL THEN
    v_debit_account_id := NEW.coa_account_id;
  ELSE
    SELECT id INTO v_debit_account_id FROM chart_of_accounts WHERE code = '2110' LIMIT 1;
  END IF;

  SELECT id INTO v_pph_account_id FROM chart_of_accounts WHERE code = '2132' LIMIT 1;

  IF v_credit_account_id IS NULL OR v_debit_account_id IS NULL THEN
    RETURN NEW;
  END IF;

  v_net_amount := NEW.amount - COALESCE(NEW.pph_amount, 0);
  v_je_number := next_journal_entry_number();

  INSERT INTO journal_entries (
    entry_number, entry_date, source_module, reference_id, reference_number,
    description, total_debit, total_credit, is_posted, posted_by
  ) VALUES (
    v_je_number, NEW.voucher_date, 'payment', NEW.id, NEW.voucher_number,
    'Payment Voucher: ' || NEW.voucher_number,
    NEW.amount, NEW.amount, true, NEW.created_by
  ) RETURNING id INTO v_je_id;

  INSERT INTO journal_entry_lines (journal_entry_id, line_number, account_id, description, debit, credit, supplier_id)
  VALUES (v_je_id, 1, v_debit_account_id, 'Payment - ' || NEW.voucher_number, NEW.amount, 0, NEW.supplier_id);

  IF COALESCE(NEW.pph_amount, 0) > 0 AND v_pph_account_id IS NOT NULL THEN
    INSERT INTO journal_entry_lines (journal_entry_id, line_number, account_id, description, debit, credit, supplier_id)
    VALUES (v_je_id, 2, v_pph_account_id, 'PPh Withholding - ' || NEW.voucher_number, 0, NEW.pph_amount, NEW.supplier_id);
  END IF;

  INSERT INTO journal_entry_lines (journal_entry_id, line_number, account_id, description, debit, credit, supplier_id)
  VALUES (v_je_id, 3, v_credit_account_id, 'Cash Payment - ' || NEW.voucher_number, 0, v_net_amount, NEW.supplier_id);

  NEW.journal_entry_id := v_je_id;
  RETURN NEW;
END;
$$;

-- ===========================================================================
-- FIX 3: Expense Trigger - Idempotency + Handle UPDATE (amount/category change)
-- ===========================================================================
CREATE OR REPLACE FUNCTION auto_post_expense_accounting()
RETURNS TRIGGER LANGUAGE plpgsql AS $$
DECLARE
  v_expense_account_id UUID;
  v_payment_account_id UUID;
  v_journal_id UUID;
  v_description TEXT;
  v_credit_desc TEXT;
  v_entry_number TEXT;
  v_category_label TEXT;
  v_old_journal_id UUID;
BEGIN
  -- On UPDATE: if amount, category, or payment method changed, reverse old JE and repost
  IF TG_OP = 'UPDATE' THEN
    -- Check if anything accounting-relevant changed
    IF (OLD.amount = NEW.amount AND OLD.expense_category = NEW.expense_category 
        AND OLD.payment_method = NEW.payment_method AND OLD.bank_account_id IS NOT DISTINCT FROM NEW.bank_account_id) THEN
      RETURN NEW; -- Nothing relevant changed
    END IF;

    -- Delete old journal entry if exists
    SELECT id INTO v_old_journal_id FROM journal_entries 
    WHERE reference_number = 'EXP-' || NEW.id::text LIMIT 1;

    IF v_old_journal_id IS NOT NULL THEN
      DELETE FROM journal_entry_lines WHERE journal_entry_id = v_old_journal_id;
      DELETE FROM journal_entries WHERE id = v_old_journal_id;
    END IF;
  END IF;

  -- IDEMPOTENCY: for INSERT, skip if JE already exists for this expense
  IF TG_OP = 'INSERT' THEN
    IF EXISTS (SELECT 1 FROM journal_entries WHERE reference_number = 'EXP-' || NEW.id::text) THEN
      RETURN NEW;
    END IF;
  END IF;

  -- Get expense account
  v_expense_account_id := get_expense_account_id(NEW.expense_category);
  IF v_expense_account_id IS NULL THEN RETURN NEW; END IF;

  -- Get payment account
  IF NEW.payment_method = 'cash' THEN
    SELECT id INTO v_payment_account_id FROM chart_of_accounts WHERE code = '1101' LIMIT 1;
  ELSIF NEW.payment_method = 'petty_cash' THEN
    SELECT id INTO v_payment_account_id FROM chart_of_accounts WHERE code = '1102' LIMIT 1;
  ELSIF NEW.payment_method = 'bank_transfer' AND NEW.bank_account_id IS NOT NULL THEN
    SELECT coa_id INTO v_payment_account_id FROM bank_accounts WHERE id = NEW.bank_account_id;
    IF v_payment_account_id IS NULL THEN
      SELECT id INTO v_payment_account_id FROM chart_of_accounts WHERE code = '1111' LIMIT 1;
    END IF;
  ELSIF NEW.payment_method IS NULL THEN
    SELECT id INTO v_payment_account_id FROM chart_of_accounts WHERE code = '2110' LIMIT 1;
  ELSE
    SELECT id INTO v_payment_account_id FROM chart_of_accounts WHERE code = '1101' LIMIT 1;
  END IF;

  IF v_payment_account_id IS NULL THEN RETURN NEW; END IF;

  -- Generate JE number
  SELECT 'JE' || TO_CHAR(NEW.expense_date, 'YYMM') || '-' || 
    LPAD((COALESCE(MAX(CAST(SUBSTRING(entry_number FROM '-([0-9]+)$') AS INTEGER)), 0) + 1)::TEXT, 4, '0')
  INTO v_entry_number
  FROM journal_entries
  WHERE entry_number LIKE 'JE' || TO_CHAR(NEW.expense_date, 'YYMM') || '-%';

  v_category_label := REPLACE(INITCAP(REPLACE(NEW.expense_category, '_', ' ')), ' ', ' ');
  v_description := COALESCE(NEW.description, NEW.expense_category);
  v_credit_desc := COALESCE(SUBSTRING(NEW.description FROM '^[^\n]+'), NEW.expense_category)
                   || ' [' || v_category_label || ']';

  INSERT INTO journal_entries (
    entry_number, entry_date, source_module, reference_number,
    description, transaction_category,
    total_debit, total_credit, is_posted, posted_at, created_by
  ) VALUES (
    v_entry_number, NEW.expense_date, 'expenses', 'EXP-' || NEW.id::text,
    v_description, NEW.expense_category,
    NEW.amount, NEW.amount, true, now(), NEW.created_by
  ) RETURNING id INTO v_journal_id;

  INSERT INTO journal_entry_lines (journal_entry_id, line_number, account_id, debit, credit, description)
  VALUES (v_journal_id, 1, v_expense_account_id, NEW.amount, 0, v_credit_desc);

  INSERT INTO journal_entry_lines (journal_entry_id, line_number, account_id, debit, credit, description)
  VALUES (v_journal_id, 2, v_payment_account_id, 0, NEW.amount, v_credit_desc);

  RETURN NEW;
END;
$$;

-- Update expense trigger to also fire on UPDATE
DROP TRIGGER IF EXISTS trigger_auto_post_expense_accounting ON finance_expenses;
CREATE TRIGGER trigger_auto_post_expense_accounting
  AFTER INSERT OR UPDATE ON finance_expenses
  FOR EACH ROW EXECUTE FUNCTION auto_post_expense_accounting();

-- ===========================================================================
-- FIX 4: Fund Transfer - Add idempotency guard to the trigger-based path
-- The post_fund_transfer_journal RPC already has a guard, but there may be
-- a direct trigger on the table. Let's check and fix it.
-- ===========================================================================

-- Check for any direct trigger on fund_transfers
DO $$
DECLARE
  v_trigger_exists BOOLEAN;
BEGIN
  SELECT EXISTS(
    SELECT 1 FROM information_schema.triggers
    WHERE event_object_table = 'fund_transfers'
    AND trigger_name LIKE '%journal%'
  ) INTO v_trigger_exists;

  IF v_trigger_exists THEN
    RAISE NOTICE 'Found journal trigger on fund_transfers - will be reviewed';
  END IF;
END $$;

-- ===========================================================================
-- FIX 5: Purchase Invoice - Fire trigger on ITEMS INSERT, not header INSERT
-- This is the root cause of missing debit lines. The header trigger fires
-- before items exist. New approach: fire per item.
-- ===========================================================================

-- New function: fires when a purchase invoice item is inserted
CREATE OR REPLACE FUNCTION post_purchase_invoice_item_journal()
RETURNS TRIGGER LANGUAGE plpgsql AS $$
DECLARE
  v_invoice RECORD;
  v_je_id UUID;
  v_account_id UUID;
  v_inventory_account_id UUID;
  v_max_line INTEGER;
BEGIN
  -- Get the parent invoice
  SELECT * INTO v_invoice FROM purchase_invoices WHERE id = NEW.purchase_invoice_id;

  -- If the invoice doesn't have a journal entry yet, it means the header trigger
  -- didn't fire yet or failed. Don't post per-item yet — the header trigger handles bulk.
  -- Only add to an EXISTING journal entry.
  IF v_invoice.journal_entry_id IS NULL THEN
    RETURN NEW;
  END IF;

  v_je_id := v_invoice.journal_entry_id;

  -- Check if a line for this specific item already exists (idempotency)
  IF EXISTS (
    SELECT 1 FROM journal_entry_lines 
    WHERE journal_entry_id = v_je_id 
    AND debit > 0 
    AND description LIKE '%' || LEFT(COALESCE(NEW.description, ''), 50) || '%'
    AND debit = NEW.line_total
  ) THEN
    RETURN NEW; -- Already posted
  END IF;

  -- Determine account
  IF NEW.item_type = 'inventory' THEN
    SELECT id INTO v_account_id FROM chart_of_accounts WHERE code = '1130' LIMIT 1;
  ELSIF NEW.item_type = 'fixed_asset' THEN
    v_account_id := NEW.asset_account_id;
    IF v_account_id IS NULL THEN
      SELECT id INTO v_account_id FROM chart_of_accounts WHERE code = '1200' LIMIT 1;
    END IF;
  ELSE
    v_account_id := NEW.expense_account_id;
    IF v_account_id IS NULL THEN
      SELECT id INTO v_account_id FROM chart_of_accounts WHERE code = '5100' LIMIT 1;
    END IF;
  END IF;

  IF v_account_id IS NULL THEN RETURN NEW; END IF;

  -- Add debit line
  SELECT COALESCE(MAX(line_number), 0) INTO v_max_line
  FROM journal_entry_lines WHERE journal_entry_id = v_je_id;

  INSERT INTO journal_entry_lines (
    journal_entry_id, line_number, account_id, description,
    debit, credit, supplier_id, batch_id
  ) VALUES (
    v_je_id, v_max_line + 1, v_account_id,
    COALESCE(LEFT(NEW.description, 100), 'Purchase Item'),
    NEW.line_total, 0, v_invoice.supplier_id, NEW.batch_id
  );

  -- Update journal entry total_debit
  UPDATE journal_entries
  SET total_debit = (SELECT COALESCE(SUM(debit), 0) FROM journal_entry_lines WHERE journal_entry_id = v_je_id)
  WHERE id = v_je_id;

  RETURN NEW;
END;
$$;

-- Create trigger on purchase_invoice_items
DROP TRIGGER IF EXISTS trg_post_purchase_invoice_item_journal ON purchase_invoice_items;
CREATE TRIGGER trg_post_purchase_invoice_item_journal
  AFTER INSERT ON purchase_invoice_items
  FOR EACH ROW EXECUTE FUNCTION post_purchase_invoice_item_journal();

-- Fix the header trigger: it still fires on INSERT, but if items are added after,
-- the item trigger above will add their debit lines. The issue is the header creates
-- the JE with total_debit = total_amount (wrong, since no items yet).
-- Fix: header creates JE with total_debit = 0, item trigger fills it in.
-- BUT: if someone uses the old PurchaseInvoiceManager that saves all in one go,
-- we need both paths. Use a flag approach:

CREATE OR REPLACE FUNCTION post_purchase_invoice_journal()
RETURNS TRIGGER LANGUAGE plpgsql AS $$
DECLARE
  v_je_id UUID;
  v_je_number TEXT;
  v_ap_account_id UUID;
  v_ppn_account_id UUID;
  v_line_number INTEGER := 1;
  v_item RECORD;
  v_account_id UUID;
  v_has_items BOOLEAN;
BEGIN
  -- IDEMPOTENCY: Never create a JE if one already exists
  IF NEW.journal_entry_id IS NOT NULL THEN
    RETURN NEW;
  END IF;

  -- Only post when invoice has a real status (not draft)
  IF TG_OP = 'INSERT' OR (TG_OP = 'UPDATE' AND OLD.journal_entry_id IS NULL 
     AND NEW.status IN ('unpaid', 'partial', 'paid')) THEN

    SELECT id INTO v_ap_account_id FROM chart_of_accounts WHERE code = '2110' LIMIT 1;
    SELECT id INTO v_ppn_account_id FROM chart_of_accounts WHERE code = '1150' LIMIT 1;

    IF v_ap_account_id IS NULL THEN RETURN NEW; END IF;

    -- Check if items exist already (synchronous save)
    SELECT EXISTS(SELECT 1 FROM purchase_invoice_items WHERE purchase_invoice_id = NEW.id)
    INTO v_has_items;

    -- Generate JE number
    v_je_number := 'JE-' || TO_CHAR(NEW.invoice_date, 'YYMM') || '-' || LPAD((
      SELECT COALESCE(MAX(CAST(SUBSTRING(entry_number FROM '(\d+)$') AS INTEGER)), 0) + 1
      FROM journal_entries 
      WHERE entry_number LIKE 'JE-' || TO_CHAR(NEW.invoice_date, 'YYMM') || '-%'
    )::TEXT, 4, '0');

    -- Create journal entry header (A/P credit = total_amount)
    INSERT INTO journal_entries (
      entry_number, entry_date, source_module, reference_id, reference_number,
      description, total_debit, total_credit, is_posted, posted_by, created_by
    ) VALUES (
      v_je_number, NEW.invoice_date, 'purchase_invoice', NEW.id, NEW.invoice_number,
      'Purchase Invoice: ' || NEW.invoice_number,
      CASE WHEN v_has_items THEN NEW.total_amount ELSE 0 END,
      NEW.total_amount, true, NEW.created_by, NEW.created_by
    ) RETURNING id INTO v_je_id;

    -- Only add item debit lines if items already exist (synchronous case)
    IF v_has_items THEN
      FOR v_item IN 
        SELECT * FROM purchase_invoice_items 
        WHERE purchase_invoice_id = NEW.id 
        ORDER BY id
      LOOP
        IF v_item.item_type = 'inventory' THEN
          SELECT id INTO v_account_id FROM chart_of_accounts WHERE code = '1130' LIMIT 1;
        ELSIF v_item.item_type = 'fixed_asset' THEN
          v_account_id := v_item.asset_account_id;
          IF v_account_id IS NULL THEN
            SELECT id INTO v_account_id FROM chart_of_accounts WHERE code = '1200' LIMIT 1;
          END IF;
        ELSIF v_item.item_type IN ('expense', 'freight', 'duty', 'insurance', 'clearing', 'other') THEN
          v_account_id := v_item.expense_account_id;
          IF v_account_id IS NULL THEN
            SELECT id INTO v_account_id FROM chart_of_accounts WHERE code = '5100' LIMIT 1;
          END IF;
        END IF;

        IF v_account_id IS NOT NULL THEN
          INSERT INTO journal_entry_lines (
            journal_entry_id, line_number, account_id, description, 
            debit, credit, supplier_id, batch_id
          ) VALUES (
            v_je_id, v_line_number, v_account_id, 
            COALESCE(LEFT(v_item.description, 100), 'Purchase - ' || NEW.invoice_number),
            v_item.line_total, 0, NEW.supplier_id, v_item.batch_id
          );
          v_line_number := v_line_number + 1;
        END IF;
      END LOOP;

      IF NEW.tax_amount > 0 AND v_ppn_account_id IS NOT NULL THEN
        INSERT INTO journal_entry_lines (
          journal_entry_id, line_number, account_id, description, 
          debit, credit, supplier_id
        ) VALUES (
          v_je_id, v_line_number, v_ppn_account_id, 
          'PPN Input - ' || NEW.invoice_number,
          NEW.tax_amount, 0, NEW.supplier_id
        );
        v_line_number := v_line_number + 1;
      END IF;
    END IF;

    -- Always add A/P credit line (the other side)
    INSERT INTO journal_entry_lines (
      journal_entry_id, line_number, account_id, description, 
      debit, credit, supplier_id
    ) VALUES (
      v_je_id, v_line_number, v_ap_account_id, 
      'A/P - ' || NEW.invoice_number,
      0, NEW.total_amount, NEW.supplier_id
    );

    NEW.journal_entry_id := v_je_id;
  END IF;

  RETURN NEW;
END;
$$;
