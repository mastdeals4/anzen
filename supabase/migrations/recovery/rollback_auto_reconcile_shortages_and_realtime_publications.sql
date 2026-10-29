-- ============================================================================
-- SAPJ ERP — Rollback Script: Dynamic Shortage Re-allocation & Realtime Publications
-- Migration Rollback: rollback_auto_reconcile_shortages_and_realtime_publications.sql
-- ============================================================================

-- 1. Drop batch inward trigger & function
DROP TRIGGER IF EXISTS trg_batches_shortage_reconcile ON public.batches;
DROP FUNCTION IF EXISTS public.trg_batch_inward_reconcile_shortages();

-- 2. Restore trg_release_so_product_reservation_status_v2 to pre-migration baseline
CREATE OR REPLACE FUNCTION public.trg_release_so_product_reservation_status_v2()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public', 'pg_temp'
AS $$
BEGIN
  IF NEW.status::text IN ('rejected', 'cancelled', 'closed', 'delivered')
     AND OLD.status::text IS DISTINCT FROM NEW.status::text THEN
    PERFORM public.release_so_product_reservations_v2(NEW.id, 'SO status changed to ' || NEW.status::text);
  END IF;
  RETURN NEW;
END;
$$;

-- 3. Drop reconcile_product_shortages function
DROP FUNCTION IF EXISTS public.reconcile_product_shortages(p_product_id uuid);

-- 4. Remove tables from supabase_realtime publication
DO $$
DECLARE
  v_tables text[] := ARRAY[
    'sales_orders',
    'so_product_reservations',
    'batches',
    'inventory_transactions',
    'delivery_challans',
    'sales_invoices',
    'credit_notes',
    'expenses',
    'petty_cash_transactions',
    'bank_transactions',
    'journal_entries',
    'material_returns'
  ];
  t text;
BEGIN
  IF EXISTS (SELECT 1 FROM pg_publication WHERE pubname = 'supabase_realtime') THEN
    FOREACH t IN ARRAY v_tables LOOP
      BEGIN
        EXECUTE format('ALTER PUBLICATION supabase_realtime DROP TABLE public.%I', t);
      EXCEPTION
        WHEN undefined_object THEN
          NULL;
        WHEN undefined_table THEN
          NULL;
      END;
    END LOOP;
  END IF;
END;
$$;

