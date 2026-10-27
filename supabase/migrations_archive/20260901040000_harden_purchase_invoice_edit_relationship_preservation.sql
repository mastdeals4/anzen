-- Preserve existing PI/PO and receiving relationships during edits.
-- The edit form always serializes optional fields; an asynchronous form
-- refresh can therefore send JSON nulls even though the stored relationship
-- was not intentionally cleared.  Keep the persisted value for existing
-- rows and only replace it when a non-null value is supplied.
CREATE OR REPLACE FUNCTION public.save_purchase_invoice_with_receiving_details(
  p_invoice_id uuid, p_purchase_order_id uuid, p_invoice_data jsonb, p_items jsonb
) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_data jsonb := COALESCE(p_invoice_data, '{}'::jsonb);
  v_items jsonb := '[]'::jsonb;
  v_item jsonb;
  v_old public.purchase_invoice_items%ROWTYPE;
  v_existing_po uuid;
BEGIN
  -- Never erase an existing PO link because the edit payload contained null.
  IF p_invoice_id IS NOT NULL AND NULLIF(v_data->>'purchase_order_id','') IS NULL THEN
    SELECT purchase_order_id INTO v_existing_po
      FROM public.purchase_invoices WHERE id = p_invoice_id;
    IF v_existing_po IS NOT NULL THEN
      v_data := jsonb_set(v_data, '{purchase_order_id}', to_jsonb(v_existing_po), true);
    END IF;
  ELSIF p_invoice_id IS NULL AND p_purchase_order_id IS NOT NULL
        AND NULLIF(v_data->>'purchase_order_id','') IS NULL THEN
    v_data := jsonb_set(v_data, '{purchase_order_id}', to_jsonb(p_purchase_order_id), true);
  END IF;

  FOR v_item IN SELECT value FROM jsonb_array_elements(COALESCE(p_items,'[]'::jsonb)) LOOP
    IF p_invoice_id IS NOT NULL AND NULLIF(v_item->>'id','') IS NOT NULL THEN
      SELECT * INTO v_old FROM public.purchase_invoice_items
       WHERE id = (v_item->>'id')::uuid AND purchase_invoice_id = p_invoice_id;
      IF FOUND THEN
        -- Merge optional relationship fields: null means "unchanged" for an
        -- existing item; non-null values still update normally.
        IF NULLIF(v_item->>'purchase_order_item_id','') IS NULL AND v_old.purchase_order_item_id IS NOT NULL THEN
          v_item := jsonb_set(v_item, '{purchase_order_item_id}', to_jsonb(v_old.purchase_order_item_id), true);
        END IF;
        IF NULLIF(v_item->>'receiving_make_id','') IS NULL AND v_old.receiving_make_id IS NOT NULL THEN
          v_item := jsonb_set(v_item, '{receiving_make_id}', to_jsonb(v_old.receiving_make_id), true);
        END IF;
        IF NULLIF(v_item->>'receiving_batch_number','') IS NULL AND v_old.receiving_batch_number IS NOT NULL THEN
          v_item := jsonb_set(v_item, '{receiving_batch_number}', to_jsonb(v_old.receiving_batch_number), true);
        END IF;
        IF NULLIF(v_item->>'receiving_expiry_date','') IS NULL AND v_old.receiving_expiry_date IS NOT NULL THEN
          v_item := jsonb_set(v_item, '{receiving_expiry_date}', to_jsonb(v_old.receiving_expiry_date), true);
        END IF;
        IF NULLIF(v_item->>'receiving_import_container_id','') IS NULL AND v_old.receiving_import_container_id IS NOT NULL THEN
          v_item := jsonb_set(v_item, '{receiving_import_container_id}', to_jsonb(v_old.receiving_import_container_id), true);
        END IF;
        IF NULLIF(v_item->>'receiving_notes','') IS NULL AND v_old.receiving_notes IS NOT NULL THEN
          v_item := jsonb_set(v_item, '{receiving_notes}', to_jsonb(v_old.receiving_notes), true);
        END IF;
      END IF;
    END IF;
    v_items := v_items || jsonb_build_array(v_item);
  END LOOP;

  RETURN CASE
    WHEN p_invoice_id IS NOT NULL THEN public.save_purchase_invoice(p_invoice_id, v_data, v_items)
    WHEN p_purchase_order_id IS NOT NULL THEN public.create_purchase_invoice_from_po(p_purchase_order_id, v_data, v_items)
    ELSE public.save_purchase_invoice(NULL, v_data, v_items)
  END;
END;
$$;

GRANT EXECUTE ON FUNCTION public.save_purchase_invoice_with_receiving_details(uuid,uuid,jsonb,jsonb)
  TO authenticated;
