-- ============================================================================
-- Migration: 20260701110000_fix_sales_invoice_atomic_3arg_je_clearing
-- Date:      2026-07-01
--
-- Bug: the 3-arg overload of update_sales_invoice_atomic() did not clear
-- the old journal entry before updating. Any edit via this overload would
-- retain a stale JE (wrong amounts, missing stamp_duty line).
-- Currently dormant (Sales.tsx uses the 4-arg overload), but fixes it
-- proactively so no future caller is affected.
-- ============================================================================

CREATE OR REPLACE FUNCTION public.update_sales_invoice_atomic(
  p_invoice_id uuid,
  p_invoice_updates jsonb,
  p_new_items jsonb[]
)
RETURNS uuid
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $$
DECLARE
  v_role      text;
  v_old_je_id UUID;
  v_result    UUID;
BEGIN
  SELECT role INTO v_role FROM user_profiles WHERE id = auth.uid();
  IF v_role NOT IN ('admin', 'accounts', 'sales', 'manager') THEN
    RAISE EXCEPTION 'Permission denied: role % cannot update sales invoices', v_role;
  END IF;

  -- Clear old journal entry so the BEFORE UPDATE trigger re-posts it
  SELECT journal_entry_id INTO v_old_je_id FROM sales_invoices WHERE id = p_invoice_id;
  IF v_old_je_id IS NOT NULL THEN
    DELETE FROM journal_entry_lines WHERE journal_entry_id = v_old_je_id;
    DELETE FROM journal_entries WHERE id = v_old_je_id;
  END IF;
  UPDATE sales_invoices SET journal_entry_id = NULL WHERE id = p_invoice_id;

  DELETE FROM sales_invoice_items WHERE invoice_id = p_invoice_id;

  UPDATE sales_invoices
  SET
    invoice_date        = COALESCE((p_invoice_updates->>'invoice_date')::date, invoice_date),
    due_date            = COALESCE((p_invoice_updates->>'due_date')::date, due_date),
    customer_id         = COALESCE((p_invoice_updates->>'customer_id')::uuid, customer_id),
    subtotal            = COALESCE((p_invoice_updates->>'subtotal')::numeric, subtotal),
    tax_amount          = COALESCE((p_invoice_updates->>'tax_amount')::numeric, tax_amount),
    total_amount        = COALESCE((p_invoice_updates->>'total_amount')::numeric, total_amount),
    discount_amount     = COALESCE((p_invoice_updates->>'discount_amount')::numeric, discount_amount),
    stamp_duty_amount   = COALESCE((p_invoice_updates->>'stamp_duty_amount')::numeric, stamp_duty_amount),
    po_number           = COALESCE(p_invoice_updates->>'po_number', po_number),
    payment_terms_days  = COALESCE((p_invoice_updates->>'payment_terms_days')::integer, payment_terms_days),
    notes               = COALESCE(p_invoice_updates->>'notes', notes),
    updated_at          = NOW()
  WHERE id = p_invoice_id
  RETURNING id INTO v_result;

  INSERT INTO sales_invoice_items (
    invoice_id, product_id, batch_id, quantity, unit_price, tax_rate, delivery_challan_item_id
  )
  SELECT
    p_invoice_id,
    (item->>'product_id')::uuid,
    (item->>'batch_id')::uuid,
    (item->>'quantity')::numeric,
    (item->>'unit_price')::numeric,
    (item->>'tax_rate')::numeric,
    (item->>'delivery_challan_item_id')::uuid
  FROM unnest(p_new_items) AS item;

  -- Dummy UPDATE to re-fire the BEFORE UPDATE trigger and post the new JE
  UPDATE sales_invoices SET status = status
  WHERE id = p_invoice_id AND journal_entry_id IS NULL;

  RETURN v_result;
END;
$$;
