/*
  Fix invoice balance RPC deployment issues.

  Live PostgREST was resolving get_invoices_with_balance(customer_uuid) against
  two overloads and returning PGRST203. Keep one canonical signature with the
  optional voucher exclusion argument, restore the singular helper, and reload
  PostgREST schema cache.

  No business logic changes, no data writes, no historical repairs.
*/

DROP FUNCTION IF EXISTS public.get_invoices_with_balance(uuid);

CREATE OR REPLACE FUNCTION public.get_invoices_with_balance(
  customer_uuid uuid,
  exclude_voucher_uuid uuid DEFAULT NULL
)
RETURNS TABLE (
  id uuid,
  invoice_number text,
  invoice_date date,
  total_amount numeric,
  paid_amount numeric,
  balance_amount numeric
)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  RETURN QUERY
  SELECT
    si.id,
    si.invoice_number,
    si.invoice_date,
    si.total_amount,
    COALESCE((
      SELECT SUM(va.allocated_amount)
      FROM public.voucher_allocations va
      WHERE va.sales_invoice_id = si.id
        AND va.voucher_type = 'receipt'
        AND (exclude_voucher_uuid IS NULL OR va.receipt_voucher_id <> exclude_voucher_uuid)
    ), 0) AS paid_amount,
    si.total_amount - COALESCE((
      SELECT SUM(va.allocated_amount)
      FROM public.voucher_allocations va
      WHERE va.sales_invoice_id = si.id
        AND va.voucher_type = 'receipt'
        AND (exclude_voucher_uuid IS NULL OR va.receipt_voucher_id <> exclude_voucher_uuid)
    ), 0) AS balance_amount
  FROM public.sales_invoices si
  WHERE si.customer_id = customer_uuid
    AND COALESCE(si.is_draft, false) = false
  ORDER BY si.invoice_date;
END;
$$;

CREATE OR REPLACE FUNCTION public.get_invoice_with_balance(
  invoice_uuid uuid,
  exclude_voucher_uuid uuid DEFAULT NULL
)
RETURNS TABLE (
  id uuid,
  invoice_number text,
  invoice_date date,
  customer_id uuid,
  total_amount numeric,
  paid_amount numeric,
  balance_amount numeric
)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  RETURN QUERY
  SELECT
    si.id,
    si.invoice_number,
    si.invoice_date,
    si.customer_id,
    si.total_amount,
    COALESCE((
      SELECT SUM(va.allocated_amount)
      FROM public.voucher_allocations va
      WHERE va.sales_invoice_id = si.id
        AND va.voucher_type = 'receipt'
        AND (exclude_voucher_uuid IS NULL OR va.receipt_voucher_id <> exclude_voucher_uuid)
    ), 0) AS paid_amount,
    si.total_amount - COALESCE((
      SELECT SUM(va.allocated_amount)
      FROM public.voucher_allocations va
      WHERE va.sales_invoice_id = si.id
        AND va.voucher_type = 'receipt'
        AND (exclude_voucher_uuid IS NULL OR va.receipt_voucher_id <> exclude_voucher_uuid)
    ), 0) AS balance_amount
  FROM public.sales_invoices si
  WHERE si.id = invoice_uuid
    AND COALESCE(si.is_draft, false) = false;
END;
$$;

REVOKE ALL ON FUNCTION public.get_invoices_with_balance(uuid, uuid) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.get_invoice_with_balance(uuid, uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.get_invoices_with_balance(uuid, uuid) TO authenticated;
GRANT EXECUTE ON FUNCTION public.get_invoice_with_balance(uuid, uuid) TO authenticated;

NOTIFY pgrst, 'reload schema';
