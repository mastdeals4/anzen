-- ============================================================================
-- HARDEN RECEIPT VOUCHER DATABASE SECURITY, AUTHORIZATION & IMPERSONATION CHECKS
-- Migration: 20260918010000_harden_receipt_voucher_security.sql
-- ============================================================================

-- 1. save_receipt_voucher_with_allocations
-- Hardened: Role check, pg_temp search path, strict auth.uid() enforcement for created_by
CREATE OR REPLACE FUNCTION public.save_receipt_voucher_with_allocations(
  p_receipt_id uuid DEFAULT NULL::uuid,
  p_payload jsonb DEFAULT '{}'::jsonb,
  p_allocations jsonb DEFAULT '[]'::jsonb
)
RETURNS uuid
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_id uuid;
  v_alloc jsonb;
  v_bank_currency text;
  v_currency text;
  v_rate numeric;
  v_actor uuid;
BEGIN
  PERFORM public._sec_check_finance_role();
  v_actor := auth.uid();

  IF NULLIF(p_payload->>'customer_id','') IS NULL THEN
    RAISE EXCEPTION 'Customer is required';
  END IF;

  IF COALESCE((p_payload->>'amount')::numeric, 0) <= 0 THEN
    RAISE EXCEPTION 'Receipt amount must be greater than zero';
  END IF;

  SELECT upper(currency) INTO v_bank_currency
  FROM public.bank_accounts
  WHERE id = NULLIF(p_payload->>'bank_account_id','')::uuid;

  v_currency := upper(COALESCE(NULLIF(p_payload->>'transaction_currency',''), v_bank_currency, 'IDR'));
  v_rate := COALESCE(NULLIF((p_payload->>'exchange_rate')::numeric, 0), CASE WHEN v_currency='IDR' THEN 1 ELSE NULL END);

  IF v_rate IS NULL OR v_rate <= 0 OR (v_currency = 'USD' AND v_rate <= 1) THEN
    RAISE EXCEPTION 'A valid exchange rate is required for % receipts', v_currency;
  END IF;

  IF v_bank_currency IS NOT NULL AND v_bank_currency <> v_currency THEN
    RAISE EXCEPTION 'Receipt currency % does not match selected bank currency %', v_currency, v_bank_currency;
  END IF;

  IF p_receipt_id IS NULL THEN
    INSERT INTO public.receipt_vouchers(
      voucher_number,
      voucher_date,
      customer_id,
      payment_method,
      bank_account_id,
      reference_number,
      amount,
      description,
      created_by,
      currency_code,
      transaction_currency,
      functional_currency,
      exchange_rate,
      bank_account_currency,
      payment_currency
    ) VALUES (
      public.next_receipt_voucher_number((p_payload->>'voucher_date')::date),
      (p_payload->>'voucher_date')::date,
      (p_payload->>'customer_id')::uuid,
      p_payload->>'payment_method',
      NULLIF(p_payload->>'bank_account_id','')::uuid,
      NULLIF(p_payload->>'reference_number',''),
      (p_payload->>'amount')::numeric,
      NULLIF(p_payload->>'description',''),
      v_actor, -- Enforce actual authenticated caller identity
      v_currency,
      v_currency,
      'IDR',
      v_rate,
      COALESCE(v_bank_currency, v_currency),
      v_currency
    ) RETURNING id INTO v_id;
  ELSE
    IF EXISTS (SELECT 1 FROM public.receipt_vouchers WHERE id = p_receipt_id AND is_posted = true) THEN
      RAISE EXCEPTION 'Cannot edit a posted receipt voucher. Cancel posting first.';
    END IF;

    UPDATE public.receipt_vouchers SET
      voucher_date          = (p_payload->>'voucher_date')::date,
      customer_id           = (p_payload->>'customer_id')::uuid,
      payment_method        = p_payload->>'payment_method',
      bank_account_id       = NULLIF(p_payload->>'bank_account_id','')::uuid,
      reference_number      = NULLIF(p_payload->>'reference_number',''),
      amount                = (p_payload->>'amount')::numeric,
      description           = NULLIF(p_payload->>'description',''),
      currency_code         = v_currency,
      transaction_currency  = v_currency,
      functional_currency   = 'IDR',
      exchange_rate         = v_rate,
      bank_account_currency = COALESCE(v_bank_currency, v_currency),
      payment_currency      = v_currency,
      updated_at            = now()
    WHERE id = p_receipt_id
    RETURNING id INTO v_id;

    DELETE FROM public.voucher_allocations WHERE receipt_voucher_id = v_id;
  END IF;

  FOR v_alloc IN SELECT value FROM jsonb_array_elements(COALESCE(p_allocations,'[]'::jsonb)) LOOP
    IF COALESCE((v_alloc->>'amount')::numeric, 0) > 0 THEN
      INSERT INTO public.voucher_allocations(
        voucher_type,
        receipt_voucher_id,
        sales_invoice_id,
        sales_order_id,
        allocated_amount
      ) VALUES (
        'receipt',
        v_id,
        NULLIF(v_alloc->>'sales_invoice_id','')::uuid,
        NULLIF(v_alloc->>'sales_order_id','')::uuid,
        (v_alloc->>'amount')::numeric
      );
    END IF;
  END LOOP;

  RETURN v_id;
END;
$$;

-- 2. cancel_receipt_voucher_posting
-- Hardened: Role check, pg_temp search path, strict auth.uid() enforcement for cancelled_by
CREATE OR REPLACE FUNCTION public.cancel_receipt_voucher_posting(
  p_rv_id uuid,
  p_cancelled_by uuid DEFAULT NULL::uuid,
  p_reason text DEFAULT 'Posting cancelled by administrator'::text
)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_rv RECORD;
  v_je RECORD;
  v_actor uuid;
BEGIN
  PERFORM public._sec_check_finance_role();
  v_actor := auth.uid();

  SELECT * INTO v_rv FROM receipt_vouchers WHERE id = p_rv_id FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Receipt voucher % not found', p_rv_id;
  END IF;

  IF NOT v_rv.is_posted THEN
    RAISE EXCEPTION 'Receipt voucher % is not posted', COALESCE(v_rv.voucher_number, p_rv_id::TEXT);
  END IF;

  SELECT * INTO v_je FROM journal_entries WHERE id = v_rv.journal_entry_id;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'No journal entry found for receipt voucher %', v_rv.voucher_number;
  END IF;

  -- Clear the FK reference FIRST so cancel_gl_posting can delete the JE row.
  UPDATE receipt_vouchers
  SET is_posted = FALSE, journal_entry_id = NULL
  WHERE id = p_rv_id;

  PERFORM cancel_gl_posting(
    v_je.id,
    p_rv_id,
    'receipt_vouchers',
    v_actor,
    p_reason,
    jsonb_build_object(
      'voucher_number', v_rv.voucher_number,
      'amount',         v_rv.amount,
      'is_posted',      TRUE
    )
  );
END;
$$;

-- 3. next_receipt_voucher_number (Hardened search_path)
CREATE OR REPLACE FUNCTION public.next_receipt_voucher_number(p_voucher_date date)
RETURNS text
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_prefix text;
  v_next int;
BEGIN
  IF p_voucher_date IS NULL THEN
    RAISE EXCEPTION 'Voucher date is required';
  END IF;
  v_prefix := 'RV' || to_char(p_voucher_date, 'YYMM') || '-';
  PERFORM pg_advisory_xact_lock(hashtext('receipt_voucher_' || v_prefix));
  SELECT COALESCE(MAX((regexp_match(voucher_number, '-([0-9]+)$'))[1]::int), 0) + 1
    INTO v_next
    FROM public.receipt_vouchers
   WHERE voucher_number LIKE v_prefix || '%';
  RETURN v_prefix || lpad(v_next::text, 4, '0');
END;
$$;

-- 4. delete_receipt_voucher_journal trigger function (Hardened search_path)
CREATE OR REPLACE FUNCTION public.delete_receipt_voucher_journal()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_je_ids uuid[];
BEGIN
  SELECT COALESCE(array_agg(id), ARRAY[]::uuid[])
    INTO v_je_ids
    FROM public.journal_entries
   WHERE source_module = 'receipt'
     AND (reference_id = OLD.id
          OR (OLD.journal_entry_id IS NOT NULL AND id = OLD.journal_entry_id));

  IF array_length(v_je_ids, 1) IS NULL THEN
    RETURN OLD;
  END IF;

  UPDATE public.bank_statement_lines
     SET matched_entry_id      = NULL,
         reconciliation_status = 'unmatched',
         matched_at            = NULL
   WHERE matched_entry_id = ANY (v_je_ids);

  DELETE FROM public.journal_entry_lines WHERE journal_entry_id = ANY (v_je_ids);
  DELETE FROM public.journal_entries     WHERE id = ANY (v_je_ids);

  RETURN OLD;
END;
$$;

-- 5. update_so_advance_status trigger function (Hardened search_path)
CREATE OR REPLACE FUNCTION public.update_so_advance_status()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_sales_order_id UUID;
  v_total_advance DECIMAL(18,2);
  v_order_total DECIMAL(18,2);
BEGIN
  IF TG_OP = 'DELETE' THEN
    v_sales_order_id := OLD.sales_order_id;
  ELSE
    v_sales_order_id := NEW.sales_order_id;
  END IF;

  IF v_sales_order_id IS NULL THEN
    RETURN COALESCE(NEW, OLD);
  END IF;

  SELECT COALESCE(SUM(va.allocated_amount), 0)
    INTO v_total_advance
    FROM public.voucher_allocations va
   WHERE va.sales_order_id = v_sales_order_id
     AND va.voucher_type = 'receipt';

  SELECT total_amount INTO v_order_total
    FROM public.sales_orders
   WHERE id = v_sales_order_id;

  UPDATE public.sales_orders
  SET 
    advance_payment_amount = v_total_advance,
    advance_payment_status = CASE
      WHEN v_total_advance = 0 THEN 'none'
      WHEN v_total_advance >= v_order_total THEN 'full'
      ELSE 'partial'
    END,
    updated_at = now()
  WHERE id = v_sales_order_id;

  RETURN COALESCE(NEW, OLD);
END;
$$;

-- 6. get_reporting_usd_rate (Hardened search_path)
CREATE OR REPLACE FUNCTION public.get_reporting_usd_rate()
RETURNS numeric
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
BEGIN
  IF auth.uid() IS NULL THEN
    RAISE EXCEPTION 'Not authenticated';
  END IF;

  RETURN (
    SELECT COALESCE(
      (SELECT exchange_rate FROM public.payment_vouchers
       WHERE exchange_rate > 1.5
       ORDER BY voucher_date DESC, created_at DESC LIMIT 1),
      (SELECT exchange_rate FROM public.purchase_invoices
       WHERE currency = 'USD' AND exchange_rate > 1.5
       ORDER BY invoice_date DESC LIMIT 1),
      (SELECT exchange_rate_usd_to_idr FROM public.batches
       WHERE exchange_rate_usd_to_idr > 1.5
       ORDER BY created_at DESC LIMIT 1),
      16000::NUMERIC
    )
  );
END;
$$;

-- 7. Clean up overly broad legacy permissive RLS policies
DROP POLICY IF EXISTS "Authenticated users can manage receipt vouchers" ON public.receipt_vouchers;
DROP POLICY IF EXISTS "Authenticated users can manage voucher allocations" ON public.voucher_allocations;
DROP POLICY IF EXISTS "admin_accounts_manage_receipt_vouchers" ON public.receipt_vouchers;
DROP POLICY IF EXISTS "admin_accounts_manage_voucher_allocations" ON public.voucher_allocations;
DROP POLICY IF EXISTS "authorized_read_receipt_vouchers" ON public.receipt_vouchers;
DROP POLICY IF EXISTS "authorized_read_voucher_allocations" ON public.voucher_allocations;

-- Recreate clean table-level RLS policies strictly guarding write operations to finance roles
CREATE POLICY "admin_accounts_manage_receipt_vouchers" ON public.receipt_vouchers
  FOR ALL TO authenticated
  USING (
    EXISTS (
      SELECT 1 FROM public.user_profiles
      WHERE id = auth.uid()
        AND role IN ('admin', 'accounts')
        AND is_active = true
    )
  )
  WITH CHECK (
    EXISTS (
      SELECT 1 FROM public.user_profiles
      WHERE id = auth.uid()
        AND role IN ('admin', 'accounts')
        AND is_active = true
    )
  );

CREATE POLICY "admin_accounts_manage_voucher_allocations" ON public.voucher_allocations
  FOR ALL TO authenticated
  USING (
    EXISTS (
      SELECT 1 FROM public.user_profiles
      WHERE id = auth.uid()
        AND role IN ('admin', 'accounts')
        AND is_active = true
    )
  )
  WITH CHECK (
    EXISTS (
      SELECT 1 FROM public.user_profiles
      WHERE id = auth.uid()
        AND role IN ('admin', 'accounts')
        AND is_active = true
    )
  );

-- Read policy for auditor and sales reference if needed
CREATE POLICY "authorized_read_receipt_vouchers" ON public.receipt_vouchers
  FOR SELECT TO authenticated
  USING (
    EXISTS (
      SELECT 1 FROM public.user_profiles
      WHERE id = auth.uid()
        AND is_active = true
        AND role IN ('admin', 'accounts', 'auditor_ca', 'sales')
    )
  );

CREATE POLICY "authorized_read_voucher_allocations" ON public.voucher_allocations
  FOR SELECT TO authenticated
  USING (
    EXISTS (
      SELECT 1 FROM public.user_profiles
      WHERE id = auth.uid()
        AND is_active = true
        AND role IN ('admin', 'accounts', 'auditor_ca', 'sales')
    )
  );

-- 8. Explicit revoke and grant controls on all Receipt Voucher functions
REVOKE ALL ON FUNCTION public.save_receipt_voucher_with_allocations(uuid, jsonb, jsonb) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.save_receipt_voucher_with_allocations(uuid, jsonb, jsonb) TO authenticated;

REVOKE ALL ON FUNCTION public.cancel_receipt_voucher_posting(uuid, uuid, text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.cancel_receipt_voucher_posting(uuid, uuid, text) TO authenticated;

REVOKE ALL ON FUNCTION public.post_receipt_voucher(uuid, uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.post_receipt_voucher(uuid, uuid) TO authenticated;

REVOKE ALL ON FUNCTION public.next_receipt_voucher_number(date) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.next_receipt_voucher_number(date) TO authenticated;

REVOKE ALL ON FUNCTION public.get_reporting_usd_rate() FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.get_reporting_usd_rate() TO authenticated;
