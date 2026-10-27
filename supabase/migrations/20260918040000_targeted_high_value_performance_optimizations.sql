-- Migration: 20260918040000_targeted_high_value_performance_optimizations.sql
-- Description: Targeted high-value ERP performance optimizations (missing FK indexes, duplicate index cleanup, and task RLS InitPlan optimization)
-- Security Hardening: PRESERVED (0 role changes, 0 business logic changes, 0 permission broadening)

-- ============================================================================
-- 1. HIGH-VALUE MISSING FOREIGN KEY INDEXES (CRITICAL ERP PATHS)
-- ============================================================================

-- A. dc_batch_allocations: delivery_challan_id and (batch_id, status)
CREATE INDEX IF NOT EXISTS idx_dc_batch_allocations_dc_id 
  ON public.dc_batch_allocations (delivery_challan_id);

CREATE INDEX IF NOT EXISTS idx_dc_batch_allocations_batch_status 
  ON public.dc_batch_allocations (batch_id, status);

-- B. so_product_reservations: sales_order_id
CREATE INDEX IF NOT EXISTS idx_so_product_reservations_so_id 
  ON public.so_product_reservations (sales_order_id);

-- C. so_product_reservation_events: sales_order_id
CREATE INDEX IF NOT EXISTS idx_so_reservation_events_so_id 
  ON public.so_product_reservation_events (sales_order_id);


-- ============================================================================
-- 2. REMOVE 100% IDENTICAL DUPLICATE INDEXES
-- ============================================================================

-- A. journal_entry_lines: Drop redundant duplicates, preserving idx_jel_account and idx_jel_entry
DROP INDEX IF EXISTS public.idx_journal_entry_lines_account_id;
DROP INDEX IF EXISTS public.idx_journal_entry_lines_journal_entry_id;

-- B. inventory_transactions: Drop redundant duplicate, preserving idx_inventory_transactions_product
DROP INDEX IF EXISTS public.idx_inventory_transactions_product_id;

-- C. journal_entries: Drop redundant duplicate, preserving idx_je_number
DROP INDEX IF EXISTS public.idx_journal_entries_entry_number;


-- ============================================================================
-- 3. TARGETED RLS INITPLAN OPTIMIZATION (TASKS)
-- ============================================================================
-- Wraps auth.uid() in (SELECT auth.uid()) so PostgreSQL evaluates the current user once per query (InitPlan)
-- rather than per-row. Preserves 100% identical access semantics.

DROP POLICY IF EXISTS "All authenticated users can view tasks" ON public.tasks;
CREATE POLICY "All authenticated users can view tasks" ON public.tasks
  FOR SELECT TO authenticated
  USING (EXISTS (
    SELECT 1 FROM public.user_profiles
    WHERE user_profiles.id = (SELECT auth.uid())
  ));
