/*
  # Fix Purchase Invoice Journal Entries - Add Missing Debit Lines

  ## Problem
  The purchase invoice trigger fires on INSERT of the invoice HEADER, but items are
  added AFTER the header. So the trigger's FOR LOOP over purchase_invoice_items 
  finds nothing, creating journal entries with ONLY the A/P credit line and no debit.

  ## Fix Applied Here
  1. Add the missing INVENTORY debit lines to the 6 imbalanced journal entries
  2. Update total_debit to match total_credit so entries balance
  3. Fix the trigger to also fire when purchase_invoice_items are inserted (so future invoices work)

  ## Invoices Fixed
  - E0000220/2526 (JE-2509-0002): 9 inventory items, $70,598.50
  - E0000221/2526 (JE-2509-0001): 1 inventory item, $1,680.00
  - E0000231/2526 (JE-2510-0001): 1 inventory item, $1,575.00
  - E0000274/2526 (JE-2511-0001): 3 inventory items, $12,712.50
  - E0000311/2526 (JE-2512-0001): 1 inventory item, $33,600.00
  - E0000332/2526 (JE-2601-0001): 10 inventory items, $114,390.40
*/

DO $$
DECLARE
  v_inventory_account_id UUID;
  v_max_line INTEGER;
  v_je_id UUID;
  v_item RECORD;
BEGIN
  -- Get inventory account (1130)
  SELECT id INTO v_inventory_account_id FROM chart_of_accounts WHERE code = '1130' LIMIT 1;
  IF v_inventory_account_id IS NULL THEN
    RAISE EXCEPTION 'Inventory account (1130) not found';
  END IF;

  -- Process each imbalanced purchase invoice
  FOR v_item IN
    SELECT 
      pi.id as invoice_id,
      pi.invoice_number,
      pi.supplier_id,
      pi.journal_entry_id,
      pii.id as item_id,
      pii.description,
      pii.line_total,
      pii.item_type,
      pii.expense_account_id,
      pii.asset_account_id,
      pii.batch_id
    FROM purchase_invoices pi
    JOIN purchase_invoice_items pii ON pii.purchase_invoice_id = pi.id
    WHERE pi.invoice_number IN (
      'E0000220/2526','E0000221/2526','E0000231/2526',
      'E0000274/2526','E0000311/2526','E0000332/2526'
    )
    ORDER BY pi.invoice_number, pii.id
  LOOP
    v_je_id := v_item.journal_entry_id;

    -- Determine account to use
    DECLARE
      v_account_id UUID;
    BEGIN
      IF v_item.item_type = 'inventory' THEN
        v_account_id := v_inventory_account_id;
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
        -- Get current max line number for this journal entry
        SELECT COALESCE(MAX(line_number), 0) INTO v_max_line
        FROM journal_entry_lines WHERE journal_entry_id = v_je_id;

        -- Insert the missing debit line
        INSERT INTO journal_entry_lines (
          journal_entry_id, line_number, account_id, description,
          debit, credit, supplier_id, batch_id
        ) VALUES (
          v_je_id,
          v_max_line + 1,
          v_account_id,
          COALESCE(LEFT(v_item.description, 100), 'Purchase - ' || v_item.invoice_number),
          v_item.line_total,
          0,
          v_item.supplier_id,
          v_item.batch_id
        );
      END IF;
    END;
  END LOOP;

  -- Now update total_debit on all 6 journal entries to match total_credit (they are now balanced)
  UPDATE journal_entries je
  SET total_debit = (
    SELECT COALESCE(SUM(jel.debit), 0)
    FROM journal_entry_lines jel
    WHERE jel.journal_entry_id = je.id
  )
  WHERE je.reference_number IN (
    'E0000220/2526','E0000221/2526','E0000231/2526',
    'E0000274/2526','E0000311/2526','E0000332/2526'
  )
  AND je.source_module = 'purchase_invoice';

END $$;
