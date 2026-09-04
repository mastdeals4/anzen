-- ============================================================================
-- Fix: Cast linked_challan_ids text array to uuid[] in validate_sales_invoice_so_link
-- ============================================================================
-- delivery_challans.id is UUID while sales_invoices.linked_challan_ids is text[].
-- Explicitly cast NEW.linked_challan_ids::uuid[] to prevent operator error 42883
-- (operator does not exist: uuid = text).
-- ============================================================================

CREATE OR REPLACE FUNCTION public.validate_sales_invoice_so_link()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_so_customer uuid;
  v_so_created_by uuid;
  v_role text;
  v_is_dc_sourced boolean := false;
BEGIN
  IF pg_trigger_depth() > 1 THEN RETURN NEW; END IF;
  IF NEW.sales_order_id IS NULL THEN RETURN NEW; END IF;
  IF auth.role() = 'service_role' THEN RETURN NEW; END IF;

  SELECT customer_id, created_by
    INTO v_so_customer, v_so_created_by
  FROM public.sales_orders
  WHERE id = NEW.sales_order_id;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'Sales order % not found', NEW.sales_order_id;
  END IF;

  IF NEW.customer_id IS DISTINCT FROM v_so_customer THEN
    RAISE EXCEPTION 'Invoice customer_id must match linked sales order customer_id';
  END IF;

  SELECT role INTO v_role
  FROM public.user_profiles
  WHERE id = auth.uid();

  IF v_role IN ('admin','accounts') OR v_so_created_by = auth.uid() THEN
    RETURN NEW;
  END IF;

  IF v_role = 'warehouse' AND COALESCE(array_length(NEW.linked_challan_ids, 1), 0) > 0 THEN
    SELECT EXISTS (
      SELECT 1
      FROM public.delivery_challans dc
      WHERE dc.id = ANY(NEW.linked_challan_ids::uuid[])
        AND dc.sales_order_id = NEW.sales_order_id
    ) INTO v_is_dc_sourced;

    IF v_is_dc_sourced THEN
      RETURN NEW;
    END IF;
  END IF;

  RAISE EXCEPTION 'Only admin/accounts, warehouse staff creating an invoice from its source Delivery Challan, or the SO owner may link this sales order';
END;
$$;
