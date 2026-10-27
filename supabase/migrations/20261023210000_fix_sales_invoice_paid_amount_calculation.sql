-- ============================================================================
-- Migration: 20261023210000_fix_sales_invoice_paid_amount_calculation.sql
-- Fix: Prevent "Invoice paid amount cannot exceed total amount (P0001)"
--
-- 1. get_invoice_allocation_amount: Count ONLY allocations from POSTED receipt vouchers
--    (rv.is_posted = true), fulfilling the authoritative contract in
--    docs/AUTHORITATIVE_DERIVED_FIELDS.md and mirroring purchase invoices.
-- 2. recalculate_sales_invoice_payment_state: Bound paid_amount with LEAST/GREATEST
--    so that settlement adjustments (e.g. Rounding Gain / Rp 0.25 residual) or
--    overpayments never push sales_invoices.paid_amount above total_amount.
-- 3. get_invoice_paid_amount & balance RPCs: Reflect the same bounded calculation.
-- ============================================================================

-- 1. Canonical get_invoice_allocation_amount: Only posted receipt vouchers
CREATE OR REPLACE FUNCTION public.get_invoice_allocation_amount(
  p_invoice_id uuid,
  p_exclude_voucher_id uuid DEFAULT NULL::uuid
) RETURNS numeric
LANGUAGE sql SECURITY DEFINER
SET search_path TO 'public', 'pg_temp'
AS $$
  SELECT COALESCE(SUM(va.allocated_amount), 0)
  FROM public.voucher_allocations va
  JOIN public.receipt_vouchers rv ON rv.id = va.receipt_voucher_id
  WHERE va.sales_invoice_id = p_invoice_id
    AND va.voucher_type = 'receipt'
    AND rv.is_posted = true
    AND (p_exclude_voucher_id IS NULL OR va.receipt_voucher_id <> p_exclude_voucher_id);
$$;

REVOKE ALL ON FUNCTION public.get_invoice_allocation_amount(uuid, uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.get_invoice_allocation_amount(uuid, uuid) TO authenticated, service_role;

-- 2. Canonical recalculate_sales_invoice_payment_state: Bounded paid_amount
CREATE OR REPLACE FUNCTION public.recalculate_sales_invoice_payment_state(p_invoice_id uuid)
RETURNS void
LANGUAGE plpgsql SECURITY DEFINER
SET search_path TO 'public', 'pg_temp'
AS $$
DECLARE
  v_invoice record;
  v_allocated numeric(18,2);
  v_adjustment numeric(18,2);
  v_paid numeric(18,2);
BEGIN
  SELECT id, total_amount
  INTO v_invoice
  FROM public.sales_invoices
  WHERE id = p_invoice_id
  FOR UPDATE;

  IF NOT FOUND THEN
    RETURN;
  END IF;

  v_allocated := public.get_invoice_allocation_amount(p_invoice_id, NULL);
  v_adjustment := public.get_invoice_rounding_adjustment_amount(p_invoice_id);

  -- An invoice paid_amount can never be negative and cannot exceed total_amount.
  -- Any rounding difference/gain (Account 4900) or advance does not increase the customer's
  -- invoice liability beyond total_amount, ensuring trg_sync_sales_invoice_balance_cache
  -- invariant is respected while settling the invoice in full.
  v_paid := LEAST(
    GREATEST(COALESCE(v_allocated, 0) + COALESCE(v_adjustment, 0), 0),
    COALESCE(v_invoice.total_amount, 0)
  );

  UPDATE public.sales_invoices
  SET
    paid_amount = v_paid,
    payment_status = CASE
      WHEN v_paid <= 0 THEN 'pending'
      WHEN v_paid >= v_invoice.total_amount THEN 'paid'
      ELSE 'partial'
    END
  WHERE id = p_invoice_id;
END;
$$;

REVOKE ALL ON FUNCTION public.recalculate_sales_invoice_payment_state(uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.recalculate_sales_invoice_payment_state(uuid) TO authenticated, service_role;

-- 3. Canonical get_invoice_paid_amount: Bounded calculation
CREATE OR REPLACE FUNCTION public.get_invoice_paid_amount(p_invoice_id uuid)
RETURNS numeric
LANGUAGE sql SECURITY DEFINER
SET search_path TO 'public', 'pg_temp'
AS $$
  SELECT LEAST(
    GREATEST(
      public.get_invoice_allocation_amount(p_invoice_id, NULL)
      + public.get_invoice_rounding_adjustment_amount(p_invoice_id),
      0
    ),
    COALESCE((SELECT total_amount FROM public.sales_invoices WHERE id = p_invoice_id), 0)
  );
$$;

REVOKE ALL ON FUNCTION public.get_invoice_paid_amount(uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.get_invoice_paid_amount(uuid) TO authenticated, service_role;

-- 4. Canonical get_invoice_with_balance
CREATE OR REPLACE FUNCTION public.get_invoice_with_balance(
  invoice_uuid uuid,
  exclude_voucher_uuid uuid DEFAULT NULL::uuid
) RETURNS TABLE(
  id uuid,
  invoice_number text,
  invoice_date date,
  customer_id uuid,
  total_amount numeric,
  paid_amount numeric,
  balance_amount numeric
)
LANGUAGE plpgsql SECURITY DEFINER
SET search_path TO 'public', 'pg_temp'
AS $$
BEGIN
  RETURN QUERY
  SELECT
    si.id,
    si.invoice_number,
    si.invoice_date,
    si.customer_id,
    si.total_amount,
    LEAST(
      GREATEST(
        public.get_invoice_allocation_amount(si.id, exclude_voucher_uuid)
        + CASE WHEN exclude_voucher_uuid IS NULL THEN public.get_invoice_rounding_adjustment_amount(si.id) ELSE 0 END,
        0
      ),
      COALESCE(si.total_amount, 0)
    ) AS paid_amount,
    GREATEST(
      si.total_amount - (
        public.get_invoice_allocation_amount(si.id, exclude_voucher_uuid)
        + CASE WHEN exclude_voucher_uuid IS NULL THEN public.get_invoice_rounding_adjustment_amount(si.id) ELSE 0 END
      ),
      0
    ) AS balance_amount
  FROM public.sales_invoices si
  WHERE si.id = invoice_uuid;
END;
$$;

REVOKE ALL ON FUNCTION public.get_invoice_with_balance(uuid, uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.get_invoice_with_balance(uuid, uuid) TO authenticated, service_role;

-- 5. Canonical get_invoices_with_balance
CREATE OR REPLACE FUNCTION public.get_invoices_with_balance(
  customer_uuid uuid,
  exclude_voucher_uuid uuid DEFAULT NULL::uuid
) RETURNS TABLE(
  id uuid,
  invoice_number text,
  invoice_date date,
  total_amount numeric,
  paid_amount numeric,
  balance_amount numeric
)
LANGUAGE plpgsql SECURITY DEFINER
SET search_path TO 'public', 'pg_temp'
AS $$
BEGIN
  RETURN QUERY
  SELECT
    si.id,
    si.invoice_number,
    si.invoice_date,
    si.total_amount,
    LEAST(
      GREATEST(
        public.get_invoice_allocation_amount(si.id, exclude_voucher_uuid)
        + CASE WHEN exclude_voucher_uuid IS NULL THEN public.get_invoice_rounding_adjustment_amount(si.id) ELSE 0 END,
        0
      ),
      COALESCE(si.total_amount, 0)
    ) AS paid_amount,
    GREATEST(
      si.total_amount - (
        public.get_invoice_allocation_amount(si.id, exclude_voucher_uuid)
        + CASE WHEN exclude_voucher_uuid IS NULL THEN public.get_invoice_rounding_adjustment_amount(si.id) ELSE 0 END
      ),
      0
    ) AS balance_amount
  FROM public.sales_invoices si
  WHERE si.customer_id = customer_uuid
    AND COALESCE(si.is_draft, false) = false
  ORDER BY si.invoice_date;
END;
$$;

REVOKE ALL ON FUNCTION public.get_invoices_with_balance(uuid, uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.get_invoices_with_balance(uuid, uuid) TO authenticated, service_role;
