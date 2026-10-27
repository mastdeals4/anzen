-- Keep an edited invoice header synchronized with its existing invoice-line
-- delivery_challan_item_id relationships. The line FK remains authoritative.

CREATE OR REPLACE FUNCTION public.update_sales_invoice_atomic(
  p_invoice_id uuid,
  p_invoice_updates jsonb,
  p_new_items jsonb[]
)
RETURNS uuid
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_role text;
  v_old_je_id uuid;
  v_result uuid;
BEGIN
  SELECT role INTO v_role FROM user_profiles WHERE id = auth.uid();
  IF v_role NOT IN ('admin', 'accounts', 'sales', 'manager') THEN
    RAISE EXCEPTION 'Permission denied: role % cannot update sales invoices', v_role;
  END IF;

  SELECT journal_entry_id INTO v_old_je_id FROM sales_invoices WHERE id = p_invoice_id;
  IF v_old_je_id IS NOT NULL THEN
    DELETE FROM journal_entry_lines WHERE journal_entry_id = v_old_je_id;
    DELETE FROM journal_entries WHERE id = v_old_je_id;
  END IF;
  UPDATE sales_invoices SET journal_entry_id = NULL WHERE id = p_invoice_id;

  DELETE FROM sales_invoice_items WHERE invoice_id = p_invoice_id;

  UPDATE sales_invoices
  SET
    invoice_date       = COALESCE((p_invoice_updates->>'invoice_date')::date, invoice_date),
    due_date           = COALESCE((p_invoice_updates->>'due_date')::date, due_date),
    customer_id        = COALESCE((p_invoice_updates->>'customer_id')::uuid, customer_id),
    subtotal           = COALESCE((p_invoice_updates->>'subtotal')::numeric, subtotal),
    tax_amount         = COALESCE((p_invoice_updates->>'tax_amount')::numeric, tax_amount),
    total_amount       = COALESCE((p_invoice_updates->>'total_amount')::numeric, total_amount),
    discount_amount    = COALESCE((p_invoice_updates->>'discount_amount')::numeric, discount_amount),
    stamp_duty_amount  = COALESCE((p_invoice_updates->>'stamp_duty_amount')::numeric, stamp_duty_amount),
    po_number          = COALESCE(p_invoice_updates->>'po_number', po_number),
    payment_terms_days = COALESCE((p_invoice_updates->>'payment_terms_days')::integer, payment_terms_days),
    notes              = COALESCE(p_invoice_updates->>'notes', notes),
    linked_challan_ids = CASE
      WHEN p_invoice_updates ? 'linked_challan_ids' THEN
        CASE WHEN p_invoice_updates->'linked_challan_ids' IS NULL
                    OR p_invoice_updates->'linked_challan_ids' = 'null'::jsonb THEN NULL
             ELSE ARRAY(SELECT jsonb_array_elements_text(p_invoice_updates->'linked_challan_ids')::uuid)
        END
      ELSE linked_challan_ids
    END,
    updated_at         = now()
  WHERE id = p_invoice_id
  RETURNING id INTO v_result;

  INSERT INTO sales_invoice_items (
    invoice_id, product_id, batch_id, quantity, unit_price, tax_rate, delivery_challan_item_id
  )
  SELECT
    p_invoice_id,
    (unique_items.item->>'product_id')::uuid,
    (unique_items.item->>'batch_id')::uuid,
    (unique_items.item->>'quantity')::numeric,
    (unique_items.item->>'unit_price')::numeric,
    (unique_items.item->>'tax_rate')::numeric,
    NULLIF(unique_items.item->>'delivery_challan_item_id', '')::uuid
  FROM (
    SELECT DISTINCT ON (COALESCE(NULLIF(item->>'delivery_challan_item_id', ''), '__manual_' || ord::text))
      item
    FROM unnest(p_new_items) WITH ORDINALITY AS payload(item, ord)
    ORDER BY COALESCE(NULLIF(item->>'delivery_challan_item_id', ''), '__manual_' || ord::text)
  ) AS unique_items;

  UPDATE sales_invoices SET status = status
  WHERE id = p_invoice_id AND journal_entry_id IS NULL;

  RETURN v_result;
END;
$$;
