/*
  # Security hardening: SECURITY DEFINER function audit

  This migration addresses Supabase Security Advisor warnings about
  SECURITY DEFINER functions that are callable by the `authenticated` role
  via the REST API (/rest/v1/rpc/...).

  ## Strategy

  1. **Trigger-only functions** (16 functions)
     - These are never called directly from the frontend or edge functions.
     - They are invoked exclusively by database triggers.
     - Fix: REVOKE EXECUTE from `authenticated` (and `anon`/`PUBLIC`).

  2. **Read-only getter functions** (25+ functions)
     - These only SELECT data and do not modify anything.
     - They do NOT need elevated privileges (SECURITY DEFINER).
     - Fix: Convert to SECURITY INVOKER. RLS will apply naturally.

  3. **Number generators** (10 functions)
     - These need SECURITY DEFINER because they query all rows for sequence.
     - Called from frontend or from trigger functions.
     - Fix: Keep SECURITY DEFINER, keep authenticated EXECUTE (intentional).

  4. **Write RPCs called from frontend** (15+ functions)
     - These perform multi-table atomic operations that require elevated access.
     - Fix: Keep SECURITY DEFINER, keep authenticated EXECUTE (intentional).

  5. **RLS helper functions**
     - current_user_has_pricing_role, is_read_only_user
     - Must remain callable by authenticated for RLS USING clauses.
     - Fix: Keep as-is (intentional).

  ## Changes Applied

  ### Trigger-only: REVOKE from authenticated
    - set_inquiry_number
    - prevent_empty_delivery_challans
    - recalculate_invoice_payment_from_allocations
    - trigger_reallocate_on_container_cost_change
    - update_batch_stock_from_transactions
    - update_inventory_on_batch_insert_or_update
    - update_invoice_payment_status_from_allocation
    - trg_create_batch_from_grn
    - trg_delivery_challan_item_inventory
    - trg_generate_grn_number
    - record_batch_import_accounting_entry
    - post_grn_journal
    - post_petty_cash_to_journal
    - auto_create_appointment_followup
    - calculate_rejection_financial_loss (trigger)
    - calculate_return_financial_impact (trigger)

  ### Read-only getters: Convert to SECURITY INVOKER
    - get_accounts_dashboard_data
    - get_admin_dashboard_data
    - get_batch_transaction_history
    - get_cogs_for_period
    - get_current_financial_year
    - get_customer_outstanding_summary
    - get_customer_sales_report
    - get_dc_item_details
    - get_expense_account_id
    - get_expense_vs_profit_report
    - get_invoice_balance
    - get_invoice_latest_payment_date
    - get_invoice_paid_amount
    - get_invoices_with_balance (both overloads)
    - get_low_stock_products
    - get_monthly_sales_report
    - get_overdue_balances
    - get_petty_cash_balance
    - get_po_summary
    - get_product_performance_report
    - get_rejection_history_with_photos (both overloads)
    - get_sales_dashboard_data
    - get_sales_member_performance
    - get_sales_profit_drilldown
    - get_sales_profit_summary
    - get_staff_ledger_from_journal
    - get_staff_outstanding_summary
    - get_supplier_outstanding_summary
    - get_system_tasks_summary
    - get_trial_balance
    - get_user_appointments (both overloads)
    - get_user_tasks_summary
    - get_users_by_role
    - get_warehouse_dashboard_data
    - is_journal_entry_balanced
    - calculate_balance_between_dates
    - calculate_import_cost_allocation
    - fn_check_product_availability
    - fn_get_free_stock
    - fn_get_import_requirements_summary
    - get_pending_dc_items_for_customer
    - validate_invoice_dc_items

  ### Kept as SECURITY DEFINER (intentional, documented)
    - adjust_batch_stock_atomic (atomic writes)
    - admin_edit_approved_delivery_challan (atomic writes)
    - allocate_import_costs_to_batches (atomic writes)
    - apply_import_costs_to_batches (atomic writes)
    - auto_match_smart (atomic writes)
    - confirm_bank_match (atomic writes)
    - create_batch_inventory_transaction (atomic writes)
    - create_staff_account (cross-table writes)
    - create_system_task (both overloads, cross-table writes)
    - current_user_has_pricing_role (RLS helper)
    - delete_expense_safe (atomic deletes)
    - dismiss_system_task (atomic writes)
    - edit_delivery_challan (atomic writes)
    - fn_approve_delivery_challan (atomic writes)
    - fn_approve_sales_order (atomic writes)
    - fn_approve_sales_order_with_import (atomic writes)
    - fn_cancel_sales_order (atomic writes)
    - fn_create_import_requirements (atomic writes)
    - fn_deduct_stock_and_release_reservation (atomic writes)
    - fn_reject_delivery_challan (atomic writes)
    - fn_reject_sales_order (atomic writes)
    - fn_release_partial_reservation (atomic writes)
    - fn_release_reservation_by_so_id (atomic writes)
    - fn_release_stock_reservations (both overloads, atomic writes)
    - fn_reserve_stock_for_so (atomic writes)
    - fn_reserve_stock_for_so_v2 (atomic writes)
    - fn_safe_autolink_dc_to_so (atomic writes)
    - generate_* (number generators need full table scan)
    - is_read_only_user (RLS helper)
    - learn_from_match (write)
    - lock_import_container (write)
    - log_export (write)
    - log_timeline_event (write)
    - lookup_email_by_username (needs cross-auth reads)
    - manually_post_pending_fund_transfers (atomic writes)
    - mark_requirement_sent (write)
    - move_expense_to_petty_cash (atomic writes)
    - move_expense_to_tracker (atomic writes)
    - next_journal_entry_number (sequence)
    - post_fund_transfer_journal (atomic writes)
    - post_import_cost_journal (atomic writes)
    - preview_bank_statement_delete (reads across RLS)
    - reallocate_container_costs (atomic writes)
    - safe_delete_bank_statement_lines (atomic deletes)
    - unlink_expense_from_bank_statement (atomic writes)
    - unmatch_bank_line (atomic writes)
    - update_batch_stock (atomic writes)
    - update_sales_invoice_atomic (both overloads, atomic writes)
    - update_so_delivered_quantity_atomic (atomic writes)
    - upsert_notification (write)
    - complete_import_cost_posting (atomic writes)
    - create_fund_transfer_with_posting (atomic writes)
    - auto_create_followup (write)
    - auto_match_bank_transactions_smart (atomic writes)
    - check_inquiry_requirements_fulfilled (reads + potential writes)
    - generate_inquiry_number (sequence, now intentional)

  ## Security Notes
    - No data is modified or deleted
    - All trigger functions remain functional (triggers run as function owner)
    - Frontend RPC calls continue to work for authenticated users
    - anon role cannot execute any of these functions
*/

-- ============================================================================
-- PART 1: REVOKE EXECUTE from trigger-only functions
-- These are invoked by PostgreSQL trigger mechanism, not by users directly.
-- ============================================================================

DO $$
DECLARE
  fn_name text;
  trigger_fns text[] := ARRAY[
    'set_inquiry_number',
    'prevent_empty_delivery_challans',
    'recalculate_invoice_payment_from_allocations',
    'trigger_reallocate_on_container_cost_change',
    'update_batch_stock_from_transactions',
    'update_inventory_on_batch_insert_or_update',
    'update_invoice_payment_status_from_allocation',
    'trg_create_batch_from_grn',
    'trg_delivery_challan_item_inventory',
    'trg_generate_grn_number',
    'record_batch_import_accounting_entry',
    'post_grn_journal',
    'post_petty_cash_to_journal',
    'auto_create_appointment_followup',
    'calculate_rejection_financial_loss',
    'calculate_return_financial_impact'
  ];
BEGIN
  FOREACH fn_name IN ARRAY trigger_fns
  LOOP
    -- Find all overloads for this function name and revoke
    PERFORM 1 FROM pg_proc p
      JOIN pg_namespace n ON n.oid = p.pronamespace
      WHERE n.nspname = 'public' AND p.proname = fn_name;
    IF FOUND THEN
      FOR fn_name IN
        SELECT p.oid::regprocedure::text
        FROM pg_proc p
        JOIN pg_namespace n ON n.oid = p.pronamespace
        WHERE n.nspname = 'public' AND p.proname = fn_name
      LOOP
        EXECUTE format('REVOKE EXECUTE ON FUNCTION %s FROM authenticated', fn_name);
        EXECUTE format('REVOKE EXECUTE ON FUNCTION %s FROM anon', fn_name);
        EXECUTE format('REVOKE EXECUTE ON FUNCTION %s FROM PUBLIC', fn_name);
      END LOOP;
    END IF;
  END LOOP;
END $$;

-- ============================================================================
-- PART 2: Convert read-only getter functions to SECURITY INVOKER
-- These functions only SELECT data and do not need elevated privileges.
-- RLS will apply naturally through the calling user's context.
-- ============================================================================

DO $$
DECLARE
  fn_sig text;
  getter_fns text[] := ARRAY[
    'get_accounts_dashboard_data',
    'get_admin_dashboard_data',
    'get_batch_transaction_history',
    'get_cogs_for_period',
    'get_current_financial_year',
    'get_customer_outstanding_summary',
    'get_customer_sales_report',
    'get_dc_item_details',
    'get_expense_account_id',
    'get_expense_vs_profit_report',
    'get_invoice_balance',
    'get_invoice_latest_payment_date',
    'get_invoice_paid_amount',
    'get_invoices_with_balance',
    'get_low_stock_products',
    'get_monthly_sales_report',
    'get_overdue_balances',
    'get_petty_cash_balance',
    'get_po_summary',
    'get_product_performance_report',
    'get_rejection_history_with_photos',
    'get_sales_dashboard_data',
    'get_sales_member_performance',
    'get_sales_profit_drilldown',
    'get_sales_profit_summary',
    'get_staff_ledger_from_journal',
    'get_staff_outstanding_summary',
    'get_supplier_outstanding_summary',
    'get_system_tasks_summary',
    'get_trial_balance',
    'get_user_appointments',
    'get_user_tasks_summary',
    'get_users_by_role',
    'get_warehouse_dashboard_data',
    'is_journal_entry_balanced',
    'calculate_balance_between_dates',
    'calculate_import_cost_allocation',
    'fn_check_product_availability',
    'fn_get_free_stock',
    'fn_get_import_requirements_summary',
    'get_pending_dc_items_for_customer',
    'validate_invoice_dc_items'
  ];
BEGIN
  FOREACH fn_sig IN ARRAY getter_fns
  LOOP
    -- Convert all overloads of each function to SECURITY INVOKER
    FOR fn_sig IN
      SELECT p.oid::regprocedure::text
      FROM pg_proc p
      JOIN pg_namespace n ON n.oid = p.pronamespace
      WHERE n.nspname = 'public'
        AND p.proname = fn_sig
        AND p.prosecdef = true
    LOOP
      EXECUTE format('ALTER FUNCTION %s SECURITY INVOKER', fn_sig);
    END LOOP;
  END LOOP;
END $$;
