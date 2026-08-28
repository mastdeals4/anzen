/*
  # Fix post_sales_invoice_journal trigger - cost_price column error

  ## Problem
  The trigger references `b.cost_price` but the `batches` table has `cost_per_unit`
  (a generated column), not `cost_price`. This caused:
  - "column b.cost_price does not exist" error when saving Sales Orders
  - Sales Invoice creation failures

  ## Fix
  Replace `b.cost_price` with `b.cost_per_unit` in the COGS calculation loop.
*/

CREATE OR REPLACE FUNCTION public.post_sales_invoice_journal()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $function$
DECLARE
v_existing_je_id UUID;
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
v_total_debit NUMERIC := 0;
v_total_credit NUMERIC := 0;
BEGIN
-- STRICT IDEMPOTENCY: If JE already exists, NEVER create another one
IF NEW.journal_entry_id IS NOT NULL THEN
RETURN NEW;
END IF;

-- Idempotency guard on source_module + reference_id
SELECT id INTO v_existing_je_id
FROM journal_entries
WHERE source_module = 'sales_invoice'
  AND reference_id = NEW.id
LIMIT 1;

IF v_existing_je_id IS NOT NULL THEN
  NEW.journal_entry_id := v_existing_je_id;
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

-- COGS entries (FIXED: b.cost_price -> b.cost_per_unit)
IF v_cogs_account_id IS NOT NULL AND v_inventory_account_id IS NOT NULL THEN
FOR v_item IN
SELECT sii.quantity, b.cost_per_unit, b.id as batch_id
FROM sales_invoice_items sii
LEFT JOIN batches b ON b.id = sii.batch_id
WHERE sii.invoice_id = NEW.id AND sii.batch_id IS NOT NULL
LOOP
v_item_cost := COALESCE(v_item.cost_per_unit, 0) * v_item.quantity;
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

v_total_debit := COALESCE(NEW.total_amount, 0) + COALESCE(v_total_cost, 0);
v_total_credit := COALESCE(NEW.subtotal, 0) + COALESCE(NEW.tax_amount, 0) + COALESCE(v_total_cost, 0);

IF v_total_debit <> v_total_credit THEN
  RAISE EXCEPTION 'Journal not balanced';
END IF;

NEW.journal_entry_id := v_je_id;
RETURN NEW;

EXCEPTION
  WHEN OTHERS THEN
    RAISE LOG 'post_sales_invoice_journal failed for invoice %: %', NEW.id, SQLERRM;
    RAISE;
END;
$function$;
