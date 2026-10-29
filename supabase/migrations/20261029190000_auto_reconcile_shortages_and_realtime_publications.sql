-- ============================================================================
-- SAPJ ERP — Dynamic Shortage Re-allocation & Realtime Publication Sync
-- Migration: 20261029190000_auto_reconcile_shortages_and_realtime_publications.sql
-- ============================================================================
-- 1. Automates re-evaluation and fulfillment of pending shortage Sales Orders
--    whenever stock is freed (via SO cancellation/rejection) or inward stock arrives.
-- 2. Integrates with canonical reservation engine (approve_sales_order_product_reservation_v2).
-- 3. Adds core ERP tables to supabase_realtime publication for cross-device live sync.
-- ============================================================================

-- Function: reconcile_product_shortages(p_product_id uuid)
-- Re-evaluates queued shortage orders in FIFO order (so_date ASC, created_at ASC)
-- and allocates unreserved available pool stock if sufficient.
CREATE OR REPLACE FUNCTION public.reconcile_product_shortages(p_product_id uuid)
RETURNS integer
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public', 'pg_temp'
AS $func$
DECLARE
  v_so record;
  v_res record;
  v_count integer := 0;
BEGIN
  -- Reconcile orders in FIFO order
  FOR v_so IN
    SELECT DISTINCT so.id, so.so_number, so.so_date, so.created_at
    FROM public.sales_orders so
    JOIN public.sales_order_items soi ON soi.sales_order_id = so.id
    WHERE soi.product_id = p_product_id
      AND so.status = 'shortage'
    ORDER BY so.so_date ASC, so.created_at ASC
  LOOP
    PERFORM set_config('app.canonical_reservation_engine', 'on', true);
    SELECT * INTO v_res FROM public.approve_sales_order_product_reservation_v2(v_so.id, NULL);
    IF v_res.success THEN
      v_count := v_count + 1;
    END IF;
  END LOOP;
  RETURN v_count;
END;
$func$;

-- Update trigger function: trg_release_so_product_reservation_status_v2()
-- When a sales order status transitions to released states (cancelled, rejected, closed, delivered),
-- release its reservations and immediately trigger shortage reconciliation for all affected products.
CREATE OR REPLACE FUNCTION public.trg_release_so_product_reservation_status_v2()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public', 'pg_temp'
AS $$
DECLARE
  v_item record;
BEGIN
  IF NEW.status::text IN ('rejected', 'cancelled', 'closed', 'delivered')
     AND OLD.status::text IS DISTINCT FROM NEW.status::text THEN
    -- 1. Release active reservations for this Sales Order
    PERFORM public.release_so_product_reservations_v2(NEW.id, 'SO status changed to ' || NEW.status::text);

    -- 2. Dynamically re-evaluate any pending shortage orders for all products on this SO
    FOR v_item IN
      SELECT DISTINCT product_id
      FROM public.sales_order_items
      WHERE sales_order_id = NEW.id
    LOOP
      PERFORM public.reconcile_product_shortages(v_item.product_id);
    END LOOP;
  END IF;
  RETURN NEW;
END;
$$;

-- Trigger: trg_batch_inward_reconcile_shortages
-- When new batch stock arrives (INSERT or current_stock increase), trigger reconciliation
CREATE OR REPLACE FUNCTION public.trg_batch_inward_reconcile_shortages()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public', 'pg_temp'
AS $$
BEGIN
  IF TG_OP = 'INSERT' AND NEW.current_stock > 0 THEN
    PERFORM public.reconcile_product_shortages(NEW.product_id);
  ELSIF TG_OP = 'UPDATE' AND NEW.current_stock > OLD.current_stock THEN
    PERFORM public.reconcile_product_shortages(NEW.product_id);
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_batches_shortage_reconcile ON public.batches;
CREATE TRIGGER trg_batches_shortage_reconcile
  AFTER INSERT OR UPDATE OF current_stock ON public.batches
  FOR EACH ROW
  EXECUTE FUNCTION public.trg_batch_inward_reconcile_shortages();

-- ============================================================================
-- Supabase Realtime Publication Registration
-- Adds core business tables to PostgreSQL publication for instant change capture
-- ============================================================================
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
  -- Ensure publication exists
  IF NOT EXISTS (SELECT 1 FROM pg_publication WHERE pubname = 'supabase_realtime') THEN
    CREATE PUBLICATION supabase_realtime;
  END IF;

  FOREACH t IN ARRAY v_tables LOOP
    BEGIN
      EXECUTE format('ALTER PUBLICATION supabase_realtime ADD TABLE public.%I', t);
    EXCEPTION
      WHEN duplicate_object THEN
        -- Table already in publication, safe to continue
        NULL;
      WHEN undefined_table THEN
        -- In case a table does not exist in some environment, skip gracefully
        NULL;
    END;
  END LOOP;
END;
$$;

