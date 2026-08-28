-- Harden RPC execute grants, function search_path, view security mode, RLS and storage policies
-- No data deletion/truncation/reset in this migration.

-- 1) RPC execute hardening based on app usage inspection
-- Keep frontend RPCs available to authenticated; revoke anon everywhere in scope.
DO $$
DECLARE
  fn regprocedure;
BEGIN
  FOR fn IN
    SELECT p.oid::regprocedure
    FROM pg_proc p
    JOIN pg_namespace n ON n.oid = p.pronamespace
    WHERE n.nspname = 'public'
      AND p.proname = ANY (ARRAY[
    'fn_cancel_sales_order',
    'fn_reserve_stock_for_so_v2',
    'fn_release_reservation_by_so_id',
    'admin_edit_approved_delivery_challan',
    'edit_delivery_challan',
    'update_so_delivered_quantity_atomic',
    'update_sales_invoice_atomic',
    'adjust_batch_stock_atomic',
    'allocate_import_costs_to_batches',
    'safe_delete_bank_statement_lines',
    'preview_bank_statement_delete',
    'create_fund_transfer_with_posting',
    'get_trial_balance',
    'get_overdue_balances',
    'get_cogs_for_period',
    'get_sales_member_performance',
    'get_sales_profit_summary',
    'get_sales_profit_drilldown',
    'get_monthly_sales_report',
    'get_product_performance_report',
    'get_customer_sales_report',
    'get_expense_vs_profit_report',
    'get_invoices_with_balance',
    'get_petty_cash_balance_by_date',
    'auto_match_smart',
    'generate_voucher_number',
    'generate_journal_entry_number',
    'get_pending_dc_items_for_customer',
    'get_invoice_paid_amount',
    'get_invoice_latest_payment_date',
    'get_current_financial_year'
  ])
  LOOP
    EXECUTE format('REVOKE EXECUTE ON FUNCTION %s FROM anon', fn);
    EXECUTE format('GRANT EXECUTE ON FUNCTION %s TO authenticated', fn);
  END LOOP;
END $$;

-- Revoke both anon+authenticated from internal trigger/helper functions (if present)
DO $$
DECLARE
  fn regprocedure;
BEGIN
  FOR fn IN
    SELECT p.oid::regprocedure
    FROM pg_proc p
    JOIN pg_namespace n ON n.oid = p.pronamespace
    WHERE n.nspname = 'public'
      AND p.proname = ANY (ARRAY[
        'handle_dc_status_change',
        'handle_invoice_status_change',
        'create_sale_transaction_from_invoice',
        'sync_product_stock_from_batches',
        'update_product_current_stock'
      ])
  LOOP
    EXECUTE format('REVOKE EXECUTE ON FUNCTION %s FROM anon', fn);
    EXECUTE format('REVOKE EXECUTE ON FUNCTION %s FROM authenticated', fn);
  END LOOP;
END $$;

-- 2) Mutable search_path hardening for known security definer entrypoints
ALTER FUNCTION public.edit_delivery_challan(uuid, jsonb) SET search_path = public, pg_temp;
ALTER FUNCTION public.admin_edit_approved_delivery_challan(uuid, jsonb) SET search_path = public, pg_temp;
ALTER FUNCTION public.update_sales_invoice_atomic(uuid, jsonb, jsonb) SET search_path = public, pg_temp;
ALTER FUNCTION public.fn_reserve_stock_for_so_v2(uuid) SET search_path = public, pg_temp;
ALTER FUNCTION public.fn_release_reservation_by_so_id(uuid) SET search_path = public, pg_temp;
ALTER FUNCTION public.adjust_batch_stock_atomic(uuid, numeric, text, text) SET search_path = public, pg_temp;

-- 3) Make view invoker-based where supported
ALTER VIEW public.so_delivery_invoice_status SET (security_invoker = true);

-- 4) Tighten overly-broad RLS policies
DROP POLICY IF EXISTS "Authenticated users can insert import data" ON public.import_data;
CREATE POLICY "Authenticated users can insert import data"
  ON public.import_data
  FOR INSERT
  TO authenticated
  WITH CHECK (auth.uid() IS NOT NULL);

DROP POLICY IF EXISTS "Authenticated users can delete import data" ON public.import_data;
CREATE POLICY "Authenticated users can delete import data"
  ON public.import_data
  FOR DELETE
  TO authenticated
  USING (auth.uid() IS NOT NULL);

DROP POLICY IF EXISTS "Authenticated users can insert pricing settings" ON public.pricing_settings;
CREATE POLICY "Authenticated users can insert pricing settings"
  ON public.pricing_settings
  FOR INSERT
  TO authenticated
  WITH CHECK (
    EXISTS (
      SELECT 1 FROM public.profiles p
      WHERE p.id = auth.uid() AND p.role IN ('admin','accounts')
    )
  );

-- 5) Storage policy tightening: remove broad SELECT by bucket-only policies and require authenticated
DROP POLICY IF EXISTS "Public can read documents" ON storage.objects;
DROP POLICY IF EXISTS "Allow public read access to sales order documents" ON storage.objects;

DROP POLICY IF EXISTS "Authenticated users can view documents" ON storage.objects;
CREATE POLICY "Authenticated users can view documents"
  ON storage.objects FOR SELECT TO authenticated
  USING (bucket_id = 'documents' AND auth.uid() IS NOT NULL);

DROP POLICY IF EXISTS "Authenticated users can view PO documents" ON storage.objects;
CREATE POLICY "Authenticated users can view PO documents"
  ON storage.objects FOR SELECT TO authenticated
  USING (bucket_id = 'sales-order-documents' AND auth.uid() IS NOT NULL);

DROP POLICY IF EXISTS "Authenticated users can read batch documents" ON storage.objects;
CREATE POLICY "Authenticated users can read batch documents"
  ON storage.objects FOR SELECT TO authenticated
  USING (bucket_id = 'batch-documents' AND auth.uid() IS NOT NULL);
