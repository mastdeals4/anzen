-- Fix both overloads of update_sales_invoice_atomic.
-- Root cause: both overloads deleted journal_entries BEFORE nulling out
-- sales_invoices.journal_entry_id, violating the NO ACTION FK constraint
-- sales_invoices_journal_entry_id_fkey.
-- Fix: NULL out the FK column first, then delete the journal entry.

-- ── Overload 1: (uuid, jsonb, jsonb[], void) ─────────────────────────────────
CREATE OR REPLACE FUNCTION public.update_sales_invoice_atomic(
  p_invoice_id uuid,
  p_invoice_updates jsonb,
  p_new_items jsonb[]
)
RETURNS uuid
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $function$
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
    -- NULL out FK first so the journal_entries row can be deleted without
    -- violating sales_invoices_journal_entry_id_fkey (NO ACTION).
    UPDATE sales_invoices SET journal_entry_id = NULL WHERE id = p_invoice_id;
    DELETE FROM journal_entry_lines WHERE journal_entry_id = v_old_je_id;
    DELETE FROM journal_entries WHERE id = v_old_je_id;
  END IF;

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
$function$;

-- ── Overload 2: (uuid, jsonb, jsonb, uuid) ───────────────────────────────────
CREATE OR REPLACE FUNCTION public.update_sales_invoice_atomic(
  p_invoice_id uuid,
  p_invoice_updates jsonb,
  p_items jsonb,
  p_user_id uuid DEFAULT NULL::uuid
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE
  v_role text;
  v_invoice RECORD;
  v_old_je_id UUID;
  v_item JSONB;
  v_batch_id UUID;
  v_result JSONB;
BEGIN
  SELECT role INTO v_role FROM user_profiles WHERE id = auth.uid();
  IF v_role NOT IN ('admin', 'accounts', 'sales', 'manager') THEN
    RAISE EXCEPTION 'Permission denied: role % cannot update sales invoices', v_role;
  END IF;

  SELECT * INTO v_invoice FROM sales_invoices WHERE id = p_invoice_id FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Invoice not found';
  END IF;

  v_old_je_id := v_invoice.journal_entry_id;

  IF v_old_je_id IS NOT NULL THEN
    -- NULL out FK first so the journal_entries row can be deleted without
    -- violating sales_invoices_journal_entry_id_fkey (NO ACTION).
    UPDATE sales_invoices SET journal_entry_id = NULL WHERE id = p_invoice_id;
    DELETE FROM journal_entry_lines WHERE journal_entry_id = v_old_je_id;
    DELETE FROM journal_entries WHERE id = v_old_je_id;
  END IF;

  DELETE FROM sales_invoice_items WHERE invoice_id = p_invoice_id;

  UPDATE sales_invoices
  SET
    invoice_date       = COALESCE((p_invoice_updates->>'invoice_date')::DATE, invoice_date),
    due_date           = COALESCE((p_invoice_updates->>'due_date')::DATE, due_date),
    customer_id        = COALESCE((p_invoice_updates->>'customer_id')::UUID, customer_id),
    subtotal           = COALESCE((p_invoice_updates->>'subtotal')::NUMERIC, subtotal),
    tax_amount         = COALESCE((p_invoice_updates->>'tax_amount')::NUMERIC, tax_amount),
    total_amount       = COALESCE((p_invoice_updates->>'total_amount')::NUMERIC, total_amount),
    discount_amount    = COALESCE((p_invoice_updates->>'discount_amount')::NUMERIC, discount_amount),
    stamp_duty_amount  = COALESCE((p_invoice_updates->>'stamp_duty_amount')::NUMERIC, stamp_duty_amount),
    notes              = COALESCE(p_invoice_updates->>'notes', notes),
    currency           = COALESCE(p_invoice_updates->>'currency', currency),
    exchange_rate      = COALESCE((p_invoice_updates->>'exchange_rate')::NUMERIC, exchange_rate),
    linked_challan_ids = CASE
      WHEN p_invoice_updates ? 'linked_challan_ids'
      THEN (SELECT ARRAY(SELECT jsonb_array_elements_text(p_invoice_updates->'linked_challan_ids'))::UUID[])
      ELSE linked_challan_ids
    END,
    updated_at = now()
  WHERE id = p_invoice_id;

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

  UPDATE sales_invoices SET status = status
  WHERE id = p_invoice_id AND journal_entry_id IS NULL;

  SELECT journal_entry_id INTO v_invoice.journal_entry_id FROM sales_invoices WHERE id = p_invoice_id;

  RETURN jsonb_build_object(
    'success', true,
    'invoice_id', p_invoice_id,
    'journal_reversed', v_old_je_id IS NOT NULL,
    'journal_entry_id', v_invoice.journal_entry_id
  );

EXCEPTION WHEN OTHERS THEN
  RAISE EXCEPTION 'Failed to update invoice: %', SQLERRM;
END;
$function$;
