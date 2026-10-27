-- Migration: Tighten anon privileges on sensitive security definer RPCs
-- Purpose: Revoke anon execute permissions from internal accounting/pricing functions

REVOKE EXECUTE ON FUNCTION public.get_customer_product_price_history(uuid, uuid) FROM anon;
GRANT EXECUTE ON FUNCTION public.get_customer_product_price_history(uuid, uuid) TO authenticated;

REVOKE EXECUTE ON FUNCTION public.get_gmail_connection_secret(uuid) FROM anon;
GRANT EXECUTE ON FUNCTION public.get_gmail_connection_secret(uuid) TO authenticated;

REVOKE EXECUTE ON FUNCTION public.update_sales_order_commercial_rate(uuid, numeric, text) FROM anon;
GRANT EXECUTE ON FUNCTION public.update_sales_order_commercial_rate(uuid, numeric, text) TO authenticated;

REVOKE EXECUTE ON FUNCTION public.reconcile_all_sales_cogs(date, date) FROM anon;
GRANT EXECUTE ON FUNCTION public.reconcile_all_sales_cogs(date, date) TO authenticated;

REVOKE EXECUTE ON FUNCTION public.get_bank_account_balances(date) FROM anon;
GRANT EXECUTE ON FUNCTION public.get_bank_account_balances(date) TO authenticated;

REVOKE EXECUTE ON FUNCTION public.calculate_bank_account_book_balance(uuid, date) FROM anon;
GRANT EXECUTE ON FUNCTION public.calculate_bank_account_book_balance(uuid, date) TO authenticated;

REVOKE EXECUTE ON FUNCTION public.save_payment_voucher_command(uuid, jsonb, jsonb, text) FROM anon;
GRANT EXECUTE ON FUNCTION public.save_payment_voucher_command(uuid, jsonb, jsonb, text) TO authenticated;
