/*
  Fix purchase invoice payment state consistency.

  Root cause:
  PaymentVoucherManager inserted voucher_allocations and then updated
  purchase_invoices.paid_amount from client-cached paid_amount, double-counting
  allocations on edit/re-save.

  Rules:
  - voucher_allocations is the source of truth for purchase invoice payments.
  - purchase_invoices.balance_amount is generated, so it is not updated directly.
  - All payment voucher allocation changes are handled in one database transaction
    by the RPCs below.
*/

CREATE OR REPLACE FUNCTION public.recalculate_purchase_invoice_payment_state(p_purchase_invoice_id uuid)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_invoice record;
  v_total_paid numeric(18,2);
BEGIN
  IF p_purchase_invoice_id IS NULL THEN
    RETURN;
  END IF;

  SELECT id, total_amount
  INTO v_invoice
  FROM public.purchase_invoices
  WHERE id = p_purchase_invoice_id
  FOR UPDATE;

  IF NOT FOUND THEN
    RETURN;
  END IF;

  SELECT COALESCE(SUM(allocated_amount), 0)
  INTO v_total_paid
  FROM public.voucher_allocations
  WHERE purchase_invoice_id = p_purchase_invoice_id
    AND voucher_type = 'payment';

  UPDATE public.purchase_invoices
  SET
    paid_amount = v_total_paid,
    status = CASE
      WHEN v_total_paid <= 0 THEN 'unpaid'
      WHEN v_total_paid >= COALESCE(v_invoice.total_amount, 0) THEN 'paid'
      ELSE 'partial'
    END
  WHERE id = p_purchase_invoice_id;
END;
$$;

CREATE OR REPLACE FUNCTION public.sync_purchase_invoice_payment_state_from_allocations()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
BEGIN
  IF TG_OP IN ('INSERT', 'UPDATE') AND NEW.purchase_invoice_id IS NOT NULL THEN
    PERFORM public.recalculate_purchase_invoice_payment_state(NEW.purchase_invoice_id);
  END IF;

  IF TG_OP IN ('UPDATE', 'DELETE') AND OLD.purchase_invoice_id IS NOT NULL THEN
    IF TG_OP = 'DELETE'
       OR OLD.purchase_invoice_id IS DISTINCT FROM NEW.purchase_invoice_id
       OR OLD.allocated_amount IS DISTINCT FROM NEW.allocated_amount
       OR OLD.voucher_type IS DISTINCT FROM NEW.voucher_type THEN
      PERFORM public.recalculate_purchase_invoice_payment_state(OLD.purchase_invoice_id);
    END IF;
  END IF;

  RETURN COALESCE(NEW, OLD);
END;
$$;

DROP TRIGGER IF EXISTS trg_sync_purchase_invoice_payment_state ON public.voucher_allocations;
CREATE TRIGGER trg_sync_purchase_invoice_payment_state
  AFTER INSERT OR UPDATE OR DELETE ON public.voucher_allocations
  FOR EACH ROW
  EXECUTE FUNCTION public.sync_purchase_invoice_payment_state_from_allocations();

DROP TRIGGER IF EXISTS trg_auto_update_purchase_invoice_status ON public.purchase_invoices;
DROP FUNCTION IF EXISTS public.auto_update_purchase_invoice_status();

CREATE OR REPLACE FUNCTION public.save_payment_voucher_with_allocations(
  p_voucher_id uuid DEFAULT NULL,
  p_voucher_number text DEFAULT NULL,
  p_voucher_date date DEFAULT NULL,
  p_supplier_id uuid DEFAULT NULL,
  p_payment_method text DEFAULT NULL,
  p_bank_account_id uuid DEFAULT NULL,
  p_reference_number text DEFAULT NULL,
  p_amount numeric DEFAULT 0,
  p_pph_amount numeric DEFAULT 0,
  p_pph_code_id uuid DEFAULT NULL,
  p_description text DEFAULT NULL,
  p_payment_currency text DEFAULT 'IDR',
  p_exchange_rate numeric DEFAULT 1,
  p_bank_amount numeric DEFAULT NULL,
  p_bank_charge numeric DEFAULT 0,
  p_created_by uuid DEFAULT NULL,
  p_allocations jsonb DEFAULT '[]'::jsonb
)
RETURNS uuid
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_voucher_id uuid;
  v_alloc jsonb;
  v_invoice_id uuid;
  v_alloc_amount numeric(18,2);
  v_alloc_currency text;
  v_affected_invoice_ids uuid[] := ARRAY[]::uuid[];
BEGIN
  IF p_voucher_id IS NOT NULL THEN
    v_voucher_id := p_voucher_id;

    SELECT COALESCE(array_agg(DISTINCT purchase_invoice_id), ARRAY[]::uuid[])
    INTO v_affected_invoice_ids
    FROM public.voucher_allocations
    WHERE payment_voucher_id = v_voucher_id
      AND purchase_invoice_id IS NOT NULL;

    UPDATE public.payment_vouchers
    SET
      voucher_date = p_voucher_date,
      supplier_id = p_supplier_id,
      payment_method = p_payment_method,
      bank_account_id = p_bank_account_id,
      reference_number = p_reference_number,
      amount = COALESCE(p_amount, 0),
      pph_amount = COALESCE(p_pph_amount, 0),
      pph_code_id = p_pph_code_id,
      description = p_description,
      payment_currency = COALESCE(p_payment_currency, 'IDR'),
      exchange_rate = COALESCE(p_exchange_rate, 1),
      bank_amount = p_bank_amount,
      bank_charge = COALESCE(p_bank_charge, 0),
      updated_at = now()
    WHERE id = v_voucher_id;

    IF NOT FOUND THEN
      RAISE EXCEPTION 'Payment voucher % not found', v_voucher_id;
    END IF;

    DELETE FROM public.voucher_allocations
    WHERE payment_voucher_id = v_voucher_id;
  ELSE
    INSERT INTO public.payment_vouchers (
      voucher_number, voucher_date, supplier_id, payment_method,
      bank_account_id, reference_number, amount, pph_amount, pph_code_id,
      description, payment_currency, exchange_rate, bank_amount, bank_charge,
      created_by
    ) VALUES (
      p_voucher_number, p_voucher_date, p_supplier_id, p_payment_method,
      p_bank_account_id, p_reference_number, COALESCE(p_amount, 0),
      COALESCE(p_pph_amount, 0), p_pph_code_id, p_description,
      COALESCE(p_payment_currency, 'IDR'), COALESCE(p_exchange_rate, 1),
      p_bank_amount, COALESCE(p_bank_charge, 0), p_created_by
    )
    RETURNING id INTO v_voucher_id;
  END IF;

  FOR v_alloc IN SELECT * FROM jsonb_array_elements(COALESCE(p_allocations, '[]'::jsonb)) LOOP
    v_invoice_id := COALESCE(v_alloc->>'invoice_id', v_alloc->>'invoiceId')::uuid;
    v_alloc_amount := COALESCE(v_alloc->>'amount', v_alloc->>'allocated_amount')::numeric;
    v_alloc_currency := COALESCE(v_alloc->>'currency', v_alloc->>'allocated_currency', 'IDR');

    IF v_invoice_id IS NULL OR v_alloc_amount IS NULL OR v_alloc_amount <= 0 THEN
      CONTINUE;
    END IF;

    INSERT INTO public.voucher_allocations (
      voucher_type, payment_voucher_id, purchase_invoice_id,
      allocated_amount, allocated_currency
    ) VALUES (
      'payment', v_voucher_id, v_invoice_id, v_alloc_amount, v_alloc_currency
    );

    v_affected_invoice_ids := array_append(v_affected_invoice_ids, v_invoice_id);
  END LOOP;

  FOR v_invoice_id IN SELECT DISTINCT unnest(v_affected_invoice_ids) LOOP
    PERFORM public.recalculate_purchase_invoice_payment_state(v_invoice_id);
  END LOOP;

  RETURN v_voucher_id;
END;
$$;

CREATE OR REPLACE FUNCTION public.delete_payment_voucher_with_allocations(p_voucher_id uuid)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_invoice_id uuid;
  v_affected_invoice_ids uuid[];
BEGIN
  SELECT COALESCE(array_agg(DISTINCT purchase_invoice_id), ARRAY[]::uuid[])
  INTO v_affected_invoice_ids
  FROM public.voucher_allocations
  WHERE payment_voucher_id = p_voucher_id
    AND purchase_invoice_id IS NOT NULL;

  DELETE FROM public.voucher_allocations
  WHERE payment_voucher_id = p_voucher_id;

  DELETE FROM public.payment_vouchers
  WHERE id = p_voucher_id;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'Payment voucher % not found', p_voucher_id;
  END IF;

  FOR v_invoice_id IN SELECT DISTINCT unnest(v_affected_invoice_ids) LOOP
    PERFORM public.recalculate_purchase_invoice_payment_state(v_invoice_id);
  END LOOP;
END;
$$;

CREATE OR REPLACE FUNCTION public.save_payment_voucher(
  p_voucher_date date,
  p_supplier_id uuid,
  p_payment_method text,
  p_bank_account_id uuid,
  p_reference_number text,
  p_amount numeric,
  p_pph_amount numeric,
  p_pph_code_id uuid,
  p_description text,
  p_created_by uuid,
  p_allocations jsonb
)
RETURNS uuid
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_voucher_number text;
BEGIN
  v_voucher_number := public.generate_voucher_number('PV');

  RETURN public.save_payment_voucher_with_allocations(
    NULL,
    v_voucher_number,
    p_voucher_date,
    p_supplier_id,
    p_payment_method,
    p_bank_account_id,
    p_reference_number,
    p_amount,
    p_pph_amount,
    p_pph_code_id,
    p_description,
    'IDR',
    1,
    NULL,
    0,
    p_created_by,
    p_allocations
  );
END;
$$;

UPDATE public.purchase_invoices pi
SET
  paid_amount = COALESCE(alloc.total_paid, 0),
  status = CASE
    WHEN COALESCE(alloc.total_paid, 0) <= 0 THEN 'unpaid'
    WHEN COALESCE(alloc.total_paid, 0) >= COALESCE(pi.total_amount, 0) THEN 'paid'
    ELSE 'partial'
  END
FROM (
  SELECT
    pi_inner.id,
    COALESCE(SUM(va.allocated_amount), 0) AS total_paid
  FROM public.purchase_invoices pi_inner
  LEFT JOIN public.voucher_allocations va
    ON va.purchase_invoice_id = pi_inner.id
   AND va.voucher_type = 'payment'
  GROUP BY pi_inner.id
) alloc
WHERE alloc.id = pi.id;

REVOKE ALL ON FUNCTION public.recalculate_purchase_invoice_payment_state(uuid) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.save_payment_voucher_with_allocations(
  uuid, text, date, uuid, text, uuid, text, numeric, numeric, uuid, text,
  text, numeric, numeric, numeric, uuid, jsonb
) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.delete_payment_voucher_with_allocations(uuid) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.save_payment_voucher(
  date, uuid, text, uuid, text, numeric, numeric, uuid, text, uuid, jsonb
) FROM PUBLIC;

GRANT EXECUTE ON FUNCTION public.recalculate_purchase_invoice_payment_state(uuid) TO authenticated;
GRANT EXECUTE ON FUNCTION public.save_payment_voucher_with_allocations(
  uuid, text, date, uuid, text, uuid, text, numeric, numeric, uuid, text,
  text, numeric, numeric, numeric, uuid, jsonb
) TO authenticated;
GRANT EXECUTE ON FUNCTION public.delete_payment_voucher_with_allocations(uuid) TO authenticated;
GRANT EXECUTE ON FUNCTION public.save_payment_voucher(
  date, uuid, text, uuid, text, numeric, numeric, uuid, text, uuid, jsonb
) TO authenticated;
