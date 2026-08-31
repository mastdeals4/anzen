-- Preserve PO relationships when an invoice edit payload omits optional link
-- fields. Explicit JSON null remains an intentional unlink request.
CREATE OR REPLACE FUNCTION public.save_purchase_invoice_with_receiving_details(
  p_invoice_id uuid, p_purchase_order_id uuid, p_invoice_data jsonb, p_items jsonb
) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE
  v_result jsonb;
  v_invoice_id uuid;
  v_item jsonb;
  v_items jsonb := '[]'::jsonb;
  v_existing jsonb;
  v_data jsonb := COALESCE(p_invoice_data, '{}'::jsonb);
BEGIN
  -- On edit, preserve an existing PO header when the caller omitted it.
  IF p_invoice_id IS NOT NULL AND NOT (v_data ? 'purchase_order_id') THEN
    SELECT to_jsonb(purchase_order_id) INTO v_existing
      FROM public.purchase_invoices WHERE id = p_invoice_id;
    IF v_existing IS NOT NULL AND v_existing <> 'null'::jsonb THEN
      v_data := jsonb_set(v_data, '{purchase_order_id}', v_existing, true);
    END IF;
  END IF;

  -- On edit, inject existing PO-item IDs only when the key is omitted. An
  -- explicit null remains a deliberate unlink and is passed through.
  FOR v_item IN SELECT value FROM jsonb_array_elements(COALESCE(p_items, '[]'::jsonb))
  LOOP
    IF p_invoice_id IS NOT NULL
       AND NOT (v_item ? 'purchase_order_item_id')
       AND NULLIF(v_item->>'id', '') IS NOT NULL THEN
      SELECT to_jsonb(purchase_order_item_id) INTO v_existing
        FROM public.purchase_invoice_items
       WHERE id = (v_item->>'id')::uuid AND purchase_invoice_id = p_invoice_id;
      IF v_existing IS NOT NULL AND v_existing <> 'null'::jsonb THEN
        v_item := jsonb_set(v_item, '{purchase_order_item_id}', v_existing, true);
      END IF;
    END IF;
    v_items := v_items || jsonb_build_array(v_item);
  END LOOP;

  v_result := CASE
    WHEN p_invoice_id IS NOT NULL THEN public.save_purchase_invoice(p_invoice_id, v_data, v_items)
    WHEN p_purchase_order_id IS NOT NULL THEN public.create_purchase_invoice_from_po(p_purchase_order_id, v_data, v_items)
    ELSE public.save_purchase_invoice(NULL, v_data, v_items)
  END;
  v_invoice_id := COALESCE(p_invoice_id, (v_result->>'invoice_id')::uuid);

  IF p_invoice_id IS NULL THEN
    UPDATE public.purchase_invoices SET receiving_approval_status='draft' WHERE id=v_invoice_id;
  END IF;

  FOR v_item IN SELECT value FROM jsonb_array_elements(COALESCE(v_items,'[]'::jsonb)) LOOP
    IF NULLIF(v_item->>'receiving_make_id','') IS NOT NULL AND NOT EXISTS (
      SELECT 1 FROM public.product_sources ps
       WHERE ps.id=(v_item->>'receiving_make_id')::uuid
         AND ps.product_id=NULLIF(v_item->>'product_id','')::uuid
    ) THEN
      RAISE EXCEPTION 'Receiving Make does not belong to invoice Product';
    END IF;
    IF NULLIF(v_item->>'id','') IS NOT NULL THEN
      UPDATE public.purchase_invoice_items SET
        receiving_make_id=NULLIF(v_item->>'receiving_make_id','')::uuid,
        receiving_batch_number=NULLIF(v_item->>'receiving_batch_number',''),
        receiving_expiry_date=NULLIF(v_item->>'receiving_expiry_date','')::date,
        receiving_import_container_id=NULLIF(v_item->>'receiving_import_container_id','')::uuid,
        receiving_notes=NULLIF(v_item->>'receiving_notes','')
       WHERE id=(v_item->>'id')::uuid AND purchase_invoice_id=v_invoice_id;
    END IF;
  END LOOP;
  RETURN v_result;
END; $$;

GRANT EXECUTE ON FUNCTION public.save_purchase_invoice_with_receiving_details(uuid,uuid,jsonb,jsonb) TO authenticated;
