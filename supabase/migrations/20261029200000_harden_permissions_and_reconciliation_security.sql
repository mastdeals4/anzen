-- ============================================================================
-- SAPJ ERP Production Migration: Harden Permissions and Function Security
-- Version: 20261029200000
--
-- Objective:
-- 1. Ensure public.reconcile_product_shortages is revoked from PUBLIC, anon,
--    and authenticated roles, accessible only to service_role and triggers.
-- 2. Audit and correct table grants on core sensitive tables (sales_orders,
--    sales_order_items, batches, so_product_reservations) by revoking all anon
--    privileges and removing dangerous DDL/truncate grants from authenticated.
-- 3. Lock down so_product_reservations to SELECT-only for client authenticated role;
--    all mutation operations are strictly governed by canonical reservation RPCs.
-- 4. Enforce and force RLS on core sensitive tables.
-- 5. Revoke anon execution on administrative and accounting functions.
-- ============================================================================

DO $$
BEGIN
  -- 1. Function execution permissions: reconcile_product_shortages
  IF EXISTS (
    SELECT 1 FROM pg_proc p
    JOIN pg_namespace n ON n.oid = p.pronamespace
    WHERE n.nspname = 'public' AND p.proname = 'reconcile_product_shortages'
  ) THEN
    REVOKE ALL ON FUNCTION public.reconcile_product_shortages(uuid) FROM PUBLIC, anon, authenticated;
    GRANT EXECUTE ON FUNCTION public.reconcile_product_shortages(uuid) TO service_role;
  END IF;

  -- 2. Revoke table grants from anon and PUBLIC on sensitive tables
  REVOKE ALL ON TABLE public.sales_orders FROM anon, PUBLIC;
  REVOKE ALL ON TABLE public.sales_order_items FROM anon, PUBLIC;
  REVOKE ALL ON TABLE public.so_product_reservations FROM anon, PUBLIC;
  REVOKE ALL ON TABLE public.batches FROM anon, PUBLIC;

  -- 3. Strip dangerous administrative DDL/maintenance privileges from authenticated
  REVOKE TRUNCATE, TRIGGER, REFERENCES ON TABLE public.sales_orders FROM authenticated;
  REVOKE TRUNCATE, TRIGGER, REFERENCES ON TABLE public.sales_order_items FROM authenticated;
  REVOKE TRUNCATE, TRIGGER, REFERENCES ON TABLE public.batches FROM authenticated;
  REVOKE ALL ON TABLE public.so_product_reservations FROM authenticated;

  -- 4. Explicit least-privilege grants for authenticated role
  GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE public.sales_orders TO authenticated;
  GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE public.sales_order_items TO authenticated;
  GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE public.batches TO authenticated;
  -- so_product_reservations is strictly read-only for authenticated client queries
  GRANT SELECT ON TABLE public.so_product_reservations TO authenticated;

  -- 5. Retain full permissions for service_role and postgres
  GRANT ALL ON TABLE public.sales_orders TO service_role;
  GRANT ALL ON TABLE public.sales_order_items TO service_role;
  GRANT ALL ON TABLE public.so_product_reservations TO service_role;
  GRANT ALL ON TABLE public.batches TO service_role;

  -- 6. Enforce and force RLS on all sensitive tables
  ALTER TABLE public.sales_orders ENABLE ROW LEVEL SECURITY;
  ALTER TABLE public.sales_orders FORCE ROW LEVEL SECURITY;
  ALTER TABLE public.sales_order_items ENABLE ROW LEVEL SECURITY;
  ALTER TABLE public.sales_order_items FORCE ROW LEVEL SECURITY;
  ALTER TABLE public.batches ENABLE ROW LEVEL SECURITY;
  ALTER TABLE public.batches FORCE ROW LEVEL SECURITY;
  ALTER TABLE public.so_product_reservations ENABLE ROW LEVEL SECURITY;
  ALTER TABLE public.so_product_reservations FORCE ROW LEVEL SECURITY;

  -- 7. Revoke anon execution on administrative and accounting functions if present
  IF EXISTS (SELECT 1 FROM pg_proc WHERE proname = 'apply_receipt_allocation_rounding_adjustment') THEN
    REVOKE EXECUTE ON FUNCTION public.apply_receipt_allocation_rounding_adjustment(uuid, uuid, text, text, numeric) FROM anon, PUBLIC;
  END IF;
  IF EXISTS (SELECT 1 FROM pg_proc WHERE proname = 'cancel_sales_invoice') THEN
    REVOKE EXECUTE ON FUNCTION public.cancel_sales_invoice(uuid, text, uuid) FROM anon, PUBLIC;
  END IF;
  IF EXISTS (SELECT 1 FROM pg_proc WHERE proname = 'edit_delivery_challan') THEN
    REVOKE EXECUTE ON FUNCTION public.edit_delivery_challan(uuid, jsonb, jsonb) FROM anon, PUBLIC;
  END IF;
  IF EXISTS (SELECT 1 FROM pg_proc WHERE proname = 'generate_bpjs_monthly_register') THEN
    REVOKE EXECUTE ON FUNCTION public.generate_bpjs_monthly_register(integer, integer, numeric) FROM anon, PUBLIC;
  END IF;
  IF EXISTS (SELECT 1 FROM pg_proc WHERE proname = 'post_bpjs_monthly_register') THEN
    REVOKE EXECUTE ON FUNCTION public.post_bpjs_monthly_register(uuid, uuid) FROM anon, PUBLIC;
  END IF;
  IF EXISTS (SELECT 1 FROM pg_proc WHERE proname = 'reconcile_bpjs_register_payment') THEN
    REVOKE EXECUTE ON FUNCTION public.reconcile_bpjs_register_payment(uuid, uuid, text) FROM anon, PUBLIC;
  END IF;
  IF EXISTS (SELECT 1 FROM pg_proc WHERE proname = 'reverse_bpjs_monthly_register') THEN
    REVOKE EXECUTE ON FUNCTION public.reverse_bpjs_monthly_register(uuid, text) FROM anon, PUBLIC;
  END IF;
  IF EXISTS (SELECT 1 FROM pg_proc WHERE proname = 'invoke_sapj_gmail_agent') THEN
    REVOKE EXECUTE ON FUNCTION public.invoke_sapj_gmail_agent() FROM anon, PUBLIC;
  END IF;
END $$;
