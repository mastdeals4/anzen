/*
  # Fix SECURITY DEFINER Views - Convert to SECURITY INVOKER

  1. Problem
    - 26 views defined with SECURITY DEFINER property
    - Security audit flags these as potential vulnerabilities
    - SECURITY DEFINER executes with view creator's permissions
    - Can be exploited if view accesses sensitive functions
    
  2. Solution
    - Convert all views to SECURITY INVOKER (default)
    - Views will execute with caller's permissions
    - Safer and follows principle of least privilege
    
  3. Impact
    - Views will respect caller's RLS policies
    - No functionality change (all authenticated users have access)
    - Eliminates 26 security audit errors
*/

-- Convert all SECURITY DEFINER views to SECURITY INVOKER
-- In PostgreSQL 15+, we can use security_invoker option

ALTER VIEW customer_advance_balances SET (security_invoker = true);
ALTER VIEW customer_receivables_view SET (security_invoker = true);
ALTER VIEW dc_invoicing_summary SET (security_invoker = true);
ALTER VIEW dc_item_invoice_status SET (security_invoker = true);
ALTER VIEW director_account_balances SET (security_invoker = true);
ALTER VIEW inventory_audit_log SET (security_invoker = true);
ALTER VIEW journal_voucher_view SET (security_invoker = true);
ALTER VIEW pending_dc_items_by_customer SET (security_invoker = true);
ALTER VIEW product_sources_with_stats SET (security_invoker = true);
ALTER VIEW product_stock_summary SET (security_invoker = true);
ALTER VIEW sales_order_advance_details SET (security_invoker = true);
ALTER VIEW supplier_payables_view SET (security_invoker = true);
ALTER VIEW trial_balance_view SET (security_invoker = true);
ALTER VIEW unbalanced_journal_entries SET (security_invoker = true);
ALTER VIEW v_batch_cost_summary SET (security_invoker = true);
ALTER VIEW v_batch_stock_summary SET (security_invoker = true);
ALTER VIEW v_system_tasks_advisory SET (security_invoker = true);
ALTER VIEW vw_all_expenses SET (security_invoker = true);
ALTER VIEW vw_bank_reconciliation_items SET (security_invoker = true);
ALTER VIEW vw_cash_on_hand_balance SET (security_invoker = true);
ALTER VIEW vw_fund_transfers_detailed SET (security_invoker = true);
ALTER VIEW vw_input_ppn_report SET (security_invoker = true);
ALTER VIEW vw_monthly_tax_summary SET (security_invoker = true);
ALTER VIEW vw_output_ppn_report SET (security_invoker = true);
ALTER VIEW vw_petty_cash_balance SET (security_invoker = true);
ALTER VIEW vw_petty_cash_statement SET (security_invoker = true);

-- Add comments
COMMENT ON VIEW customer_advance_balances IS 'Security: Converted to SECURITY INVOKER - executes with caller permissions';
COMMENT ON VIEW customer_receivables_view IS 'Security: Converted to SECURITY INVOKER - executes with caller permissions';
COMMENT ON VIEW journal_voucher_view IS 'Security: Converted to SECURITY INVOKER - executes with caller permissions';
COMMENT ON VIEW trial_balance_view IS 'Security: Converted to SECURITY INVOKER - executes with caller permissions';
