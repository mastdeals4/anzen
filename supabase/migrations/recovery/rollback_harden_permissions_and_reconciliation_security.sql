-- ============================================================================
-- SAPJ ERP Recovery Rollback: Revert Permissions Hardening
-- Version: rollback_20261029200000
-- ============================================================================

DO $$
BEGIN
  -- Re-grant execute on reconcile_product_shortages if needed
  IF EXISTS (
    SELECT 1 FROM pg_proc p
    JOIN pg_namespace n ON n.oid = p.pronamespace
    WHERE n.nspname = 'public' AND p.proname = 'reconcile_product_shortages'
  ) THEN
    GRANT EXECUTE ON FUNCTION public.reconcile_product_shortages(uuid) TO authenticated, service_role;
  END IF;

  -- Restore table grants
  GRANT ALL ON TABLE public.sales_orders TO authenticated, anon;
  GRANT ALL ON TABLE public.sales_order_items TO authenticated, anon;
  GRANT ALL ON TABLE public.batches TO authenticated, anon;
  GRANT ALL ON TABLE public.so_product_reservations TO authenticated, anon;
END $$;
