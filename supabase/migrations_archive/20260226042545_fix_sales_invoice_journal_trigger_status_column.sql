/*
  # Fix: sales invoice journal trigger references wrong column name
  
  The trigger function post_sales_invoice_journal checks NEW.status
  but the column on sales_invoices is payment_status.
  This caused "record new has no field status" error on every invoice creation.
*/

CREATE OR REPLACE FUNCTION post_sales_invoice_journal()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
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

  -- Only post when invoice reaches a billable payment_status (FIXED: was NEW.status)
  IF NEW.payment_status NOT IN ('pending', 'partial', 'paid') THEN
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

  -- COGS entries
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
