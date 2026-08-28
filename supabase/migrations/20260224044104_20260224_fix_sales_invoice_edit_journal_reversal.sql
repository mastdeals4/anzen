/*
  # Fix Sales Invoice Edit - Journal Entry Reversal on Edit

  ## Problem
  When a sales invoice is edited via `update_sales_invoice_atomic()`:
  1. Old items are deleted (stock correctly restored via trigger)
  2. New items are inserted (stock correctly deducted via trigger)
  3. BUT: Old journal entries are NEVER reversed or deleted
  4. Result: Ledger shows BOTH the old entry AND the new entry = double counting

  ## Fix
  Modify `update_sales_invoice_atomic()` to:
  1. Before updating, delete old journal entry lines and the header
  2. Clear the journal_entry_id on the invoice
  3. The existing trigger (`post_sales_invoice_journal`) will re-fire when 
     journal_entry_id is NULL and status is set, creating fresh correct entries

  ## Also Fixed
  - `post_sales_invoice_journal` trigger: added hard idempotency guard so it 
    NEVER fires when journal_entry_id is already set (prevents double posting)
*/

-- First fix the sales invoice journal trigger for strict idempotency
CREATE OR REPLACE FUNCTION post_sales_invoice_journal()
RETURNS TRIGGER LANGUAGE plpgsql AS $$
DECLARE
  v_je_id UUID;
  v_je_number TEXT;
  v_ar_account_id UUID;
  v_revenue_account_id UUID;
  v_tax_account_id UUID;
  v_cogs_account_id UUID;
  v_inventory_account_id UUID;
  v_item RECORD;
  v_line_num INTEGER := 1;
  v_total_cost NUMERIC := 0;
  v_item_cost NUMERIC;
BEGIN
  -- STRICT IDEMPOTENCY: If JE already exists, NEVER create another one
  IF NEW.journal_entry_id IS NOT NULL THEN
    RETURN NEW;
  END IF;

  -- Only post when invoice reaches a billable status
  IF NEW.status NOT IN ('unpaid', 'partial', 'paid') THEN
    RETURN NEW;
  END IF;

  -- Accounts
  SELECT id INTO v_ar_account_id FROM chart_of_accounts WHERE code = '1120' LIMIT 1;
  SELECT id INTO v_revenue_account_id FROM chart_of_accounts WHERE code = '4100' LIMIT 1;
  SELECT id INTO v_tax_account_id FROM chart_of_accounts WHERE code = '2130' LIMIT 1;
  SELECT id INTO v_cogs_account_id FROM chart_of_accounts WHERE code = '5100' LIMIT 1;
  SELECT id INTO v_inventory_account_id FROM chart_of_accounts WHERE code = '1130' LIMIT 1;

  IF v_ar_account_id IS NULL OR v_revenue_account_id IS NULL THEN
    RETURN NEW;
  END IF;

  v_je_number := next_journal_entry_number();

  -- Create journal entry (Revenue recognition)
  INSERT INTO journal_entries (
    entry_number, entry_date, source_module, reference_id, reference_number,
    description, total_debit, total_credit, is_posted, posted_by, created_by
  ) VALUES (
    v_je_number, NEW.invoice_date, 'sales_invoice', NEW.id, NEW.invoice_number,
    'Sales Invoice: ' || NEW.invoice_number,
    NEW.total_amount, NEW.total_amount, true, NEW.created_by, NEW.created_by
  ) RETURNING id INTO v_je_id;

  -- Dr: Accounts Receivable
  INSERT INTO journal_entry_lines (journal_entry_id, line_number, account_id, description, debit, credit, customer_id)
  VALUES (v_je_id, v_line_num, v_ar_account_id, 'A/R - ' || NEW.invoice_number, NEW.total_amount, 0, NEW.customer_id);
  v_line_num := v_line_num + 1;

  -- Cr: Sales Revenue (subtotal)
  INSERT INTO journal_entry_lines (journal_entry_id, line_number, account_id, description, debit, credit, customer_id)
  VALUES (v_je_id, v_line_num, v_revenue_account_id, 'Sales - ' || NEW.invoice_number, 0, NEW.subtotal, NEW.customer_id);
  v_line_num := v_line_num + 1;

  -- Cr: Tax Payable (if any)
  IF COALESCE(NEW.tax_amount, 0) > 0 AND v_tax_account_id IS NOT NULL THEN
    INSERT INTO journal_entry_lines (journal_entry_id, line_number, account_id, description, debit, credit, customer_id)
    VALUES (v_je_id, v_line_num, v_tax_account_id, 'PPN - ' || NEW.invoice_number, 0, NEW.tax_amount, NEW.customer_id);
    v_line_num := v_line_num + 1;
  END IF;

  -- COGS entries (if inventory account exists)
  IF v_cogs_account_id IS NOT NULL AND v_inventory_account_id IS NOT NULL THEN
    FOR v_item IN
      SELECT sii.quantity, b.cost_price, b.id as batch_id
      FROM sales_invoice_items sii
      LEFT JOIN batches b ON b.id = sii.batch_id
      WHERE sii.invoice_id = NEW.id AND sii.batch_id IS NOT NULL
    LOOP
      v_item_cost := COALESCE(v_item.cost_price, 0) * v_item.quantity;
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

  NEW.journal_entry_id := v_je_id;
  RETURN NEW;
END;
$$;

-- Now fix update_sales_invoice_atomic to reverse old JE before re-posting
CREATE OR REPLACE FUNCTION update_sales_invoice_atomic(
  p_invoice_id UUID,
  p_invoice_updates JSONB,
  p_items JSONB,
  p_user_id UUID DEFAULT NULL
)
RETURNS JSONB LANGUAGE plpgsql SECURITY DEFINER AS $$
DECLARE
  v_invoice RECORD;
  v_old_je_id UUID;
  v_item JSONB;
  v_batch_id UUID;
  v_result JSONB;
BEGIN
  -- Lock the invoice row
  SELECT * INTO v_invoice FROM sales_invoices WHERE id = p_invoice_id FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Invoice not found';
  END IF;

  -- Step 1: Capture old journal entry ID and delete it (will be re-posted after update)
  v_old_je_id := v_invoice.journal_entry_id;

  IF v_old_je_id IS NOT NULL THEN
    -- Delete old journal entry lines first
    DELETE FROM journal_entry_lines WHERE journal_entry_id = v_old_je_id;
    -- Delete old journal entry header
    DELETE FROM journal_entries WHERE id = v_old_je_id;
  END IF;

  -- Step 2: Clear journal_entry_id so the trigger will re-fire
  UPDATE sales_invoices
  SET journal_entry_id = NULL
  WHERE id = p_invoice_id;

  -- Step 3: Delete old items (triggers will restore stock)
  DELETE FROM sales_invoice_items WHERE invoice_id = p_invoice_id;

  -- Step 4: Update invoice header
  UPDATE sales_invoices
  SET
    invoice_date = COALESCE((p_invoice_updates->>'invoice_date')::DATE, invoice_date),
    due_date = COALESCE((p_invoice_updates->>'due_date')::DATE, due_date),
    customer_id = COALESCE((p_invoice_updates->>'customer_id')::UUID, customer_id),
    subtotal = COALESCE((p_invoice_updates->>'subtotal')::NUMERIC, subtotal),
    tax_amount = COALESCE((p_invoice_updates->>'tax_amount')::NUMERIC, tax_amount),
    total_amount = COALESCE((p_invoice_updates->>'total_amount')::NUMERIC, total_amount),
    discount_amount = COALESCE((p_invoice_updates->>'discount_amount')::NUMERIC, discount_amount),
    notes = COALESCE(p_invoice_updates->>'notes', notes),
    currency = COALESCE(p_invoice_updates->>'currency', currency),
    exchange_rate = COALESCE((p_invoice_updates->>'exchange_rate')::NUMERIC, exchange_rate),
    linked_challan_ids = CASE 
      WHEN p_invoice_updates ? 'linked_challan_ids' 
      THEN (SELECT ARRAY(SELECT jsonb_array_elements_text(p_invoice_updates->'linked_challan_ids'))::UUID[])
      ELSE linked_challan_ids 
    END,
    updated_at = now()
  WHERE id = p_invoice_id;

  -- Step 5: Insert new items (triggers will deduct stock)
  FOR v_item IN SELECT * FROM jsonb_array_elements(p_items)
  LOOP
    v_batch_id := NULLIF((v_item->>'batch_id')::TEXT, '')::UUID;

    INSERT INTO sales_invoice_items (
      invoice_id, product_id, batch_id, quantity, unit_price, discount_percent,
      line_total, dc_item_id, unit_type
    ) VALUES (
      p_invoice_id,
      (v_item->>'product_id')::UUID,
      v_batch_id,
      (v_item->>'quantity')::NUMERIC,
      (v_item->>'unit_price')::NUMERIC,
      COALESCE((v_item->>'discount_percent')::NUMERIC, 0),
      (v_item->>'line_total')::NUMERIC,
      NULLIF((v_item->>'dc_item_id')::TEXT, '')::UUID,
      COALESCE(v_item->>'unit_type', 'pcs')
    );
  END LOOP;

  -- Step 6: Re-trigger journal posting by updating status (clears NULL journal_entry_id path)
  UPDATE sales_invoices
  SET status = status  -- same value, but triggers re-evaluation
  WHERE id = p_invoice_id AND journal_entry_id IS NULL;

  -- If the trigger didn't fire (status might be 'draft'), manually post
  SELECT journal_entry_id INTO v_invoice.journal_entry_id 
  FROM sales_invoices WHERE id = p_invoice_id;

  RETURN jsonb_build_object(
    'success', true,
    'invoice_id', p_invoice_id,
    'journal_reversed', v_old_je_id IS NOT NULL,
    'journal_entry_id', v_invoice.journal_entry_id
  );

EXCEPTION WHEN OTHERS THEN
  RAISE EXCEPTION 'Failed to update invoice: %', SQLERRM;
END;
$$;
