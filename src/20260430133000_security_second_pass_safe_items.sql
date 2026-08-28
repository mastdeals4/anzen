/*
  Second-pass security migration (safe items only)
  - Tighten remaining permissive RLS policies
  - Remove broad public bucket listing for selected buckets without breaking authenticated app access
  - Restrict SECURITY DEFINER EXECUTE for trigger/internal-only functions not used by frontend RPC
*/

-- 1) Fix remaining overly permissive table RLS
DROP POLICY IF EXISTS "Enable insert for authenticated users only" ON public.import_data;
DROP POLICY IF EXISTS "Enable delete for authenticated users only" ON public.import_data;
DROP POLICY IF EXISTS "Enable insert for authenticated users only" ON public.pricing_settings;

CREATE POLICY "import_data_insert_accounts_admin"
ON public.import_data
FOR INSERT
TO authenticated
WITH CHECK (
  EXISTS (
    SELECT 1
    FROM public.user_profiles up
    WHERE up.id = auth.uid()
      AND up.role IN ('admin', 'accounts')
  )
);

CREATE POLICY "import_data_delete_admin_only"
ON public.import_data
FOR DELETE
TO authenticated
USING (
  EXISTS (
    SELECT 1
    FROM public.user_profiles up
    WHERE up.id = auth.uid()
      AND up.role = 'admin'
  )
);

CREATE POLICY "pricing_settings_insert_admin_only"
ON public.pricing_settings
FOR INSERT
TO authenticated
WITH CHECK (
  EXISTS (
    SELECT 1
    FROM public.user_profiles up
    WHERE up.id = auth.uid()
      AND up.role = 'admin'
  )
);

-- 2) Fix public bucket listing warnings for specific buckets
-- Remove broad SELECT policies for anon/public and keep authenticated read to avoid breaking signed URL/object access.
DO $$
DECLARE
  pol RECORD;
BEGIN
  FOR pol IN
    SELECT policyname
    FROM pg_policies
    WHERE schemaname = 'storage'
      AND tablename = 'objects'
      AND cmd = 'SELECT'
      AND (
        qual ILIKE '%batch-documents%'
        OR qual ILIKE '%documents%'
        OR qual ILIKE '%sales-order-documents%'
      )
  LOOP
    EXECUTE format('DROP POLICY IF EXISTS %I ON storage.objects', pol.policyname);
  END LOOP;
END $$;

CREATE POLICY "Authenticated read batch-documents"
ON storage.objects
FOR SELECT
TO authenticated
USING (bucket_id = 'batch-documents');

CREATE POLICY "Authenticated read documents"
ON storage.objects
FOR SELECT
TO authenticated
USING (bucket_id = 'documents');

CREATE POLICY "Authenticated read sales-order-documents"
ON storage.objects
FOR SELECT
TO authenticated
USING (bucket_id = 'sales-order-documents');

-- 3) SECURITY DEFINER follow-up (safe-only): revoke authenticated EXECUTE from trigger/internal-only functions
-- Frontend RPC allowlist discovered from `supabase.rpc(...)` usage in app code.
DO $$
DECLARE
  fn RECORD;
  frontend_rpc_allowlist text[] := ARRAY[
    'get_invoice_paid_amount',
    'get_current_financial_year',
    'get_pending_dc_items_for_customer',
    'update_sales_invoice_atomic',
    'get_sales_profit_summary',
    'get_sales_profit_drilldown',
    'get_monthly_sales_report',
    'get_product_performance_report',
    'get_customer_sales_report',
    'get_expense_vs_profit_report',
    'allocate_import_costs_to_batches',
    'get_overdue_balances',
    'get_cogs_for_period',
    'adjust_batch_stock_atomic',
    'fn_cancel_sales_order',
    'fn_reserve_stock_for_so_v2',
    'get_sales_member_performance',
    'admin_edit_approved_delivery_challan',
    'edit_delivery_challan',
    'update_so_delivered_quantity_atomic',
    'auto_match_smart',
    'generate_voucher_number',
    'create_fund_transfer_with_posting',
    'get_petty_cash_balance_by_date',
    'get_petty_cash_balance',
    'get_trial_balance',
    'generate_journal_entry_number',
    'get_invoices_with_balance',
    'get_invoice_latest_payment_date',
    'fn_release_reservation_by_so_id',
    'mark_requirement_sent',
    'get_system_tasks_summary',
    'dismiss_system_task',
    'auto_create_followup',
    'preview_bank_statement_delete',
    'safe_delete_bank_statement_lines'
  ];
BEGIN
  FOR fn IN
    SELECT n.nspname AS schema_name,
           p.proname AS function_name,
           pg_get_function_identity_arguments(p.oid) AS identity_args,
           p.oid
    FROM pg_proc p
    JOIN pg_namespace n ON n.oid = p.pronamespace
    WHERE n.nspname = 'public'
      AND p.prosecdef = true
      AND has_function_privilege('authenticated', p.oid, 'EXECUTE')
      AND p.proname <> ALL(frontend_rpc_allowlist)
      AND EXISTS (
        SELECT 1
        FROM pg_trigger t
        WHERE t.tgfoid = p.oid
          AND NOT t.tgisinternal
      )
  LOOP
    EXECUTE format(
      'REVOKE EXECUTE ON FUNCTION %I.%I(%s) FROM authenticated',
      fn.schema_name,
      fn.function_name,
      fn.identity_args
    );
  END LOOP;
END $$;
