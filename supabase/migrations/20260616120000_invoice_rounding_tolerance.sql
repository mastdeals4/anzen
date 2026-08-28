/*
  Receipt-allocation rounding tolerance and small residual write-off handling.

  Business rule:
  - Issued invoice totals remain immutable.
  - Receipt allocations remain the source of customer cash received.
  - When a receipt allocation leaves an invoice residual within
    app_settings.rounding_tolerance_amount,
    clear it with an auditable rounding adjustment journal entry.
  - Positive residual: Dr rounding/write-off expense, Cr Accounts Receivable.
  - Negative residual: Dr Accounts Receivable, Cr rounding gain/other income.
*/

ALTER TABLE public.app_settings
  ADD COLUMN IF NOT EXISTS rounding_tolerance_amount numeric(18,2) NOT NULL DEFAULT 100,
  ADD COLUMN IF NOT EXISTS rounding_writeoff_account_id uuid REFERENCES public.chart_of_accounts(id),
  ADD COLUMN IF NOT EXISTS rounding_gain_account_id uuid REFERENCES public.chart_of_accounts(id);

UPDATE public.app_settings s
SET
  rounding_writeoff_account_id = COALESCE(
    s.rounding_writeoff_account_id,
    (SELECT id FROM public.chart_of_accounts WHERE code = '6900' LIMIT 1)
  ),
  rounding_gain_account_id = COALESCE(
    s.rounding_gain_account_id,
    (SELECT id FROM public.chart_of_accounts WHERE code = '4900' LIMIT 1)
  );

CREATE TABLE IF NOT EXISTS public.invoice_rounding_adjustments (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  receipt_voucher_id uuid REFERENCES public.receipt_vouchers(id) ON DELETE CASCADE,
  sales_invoice_id uuid NOT NULL REFERENCES public.sales_invoices(id) ON DELETE CASCADE,
  adjustment_amount numeric(18,2) NOT NULL,
  journal_entry_id uuid REFERENCES public.journal_entries(id) ON DELETE SET NULL,
  reason text NOT NULL DEFAULT 'invoice_rounding_tolerance',
  created_by uuid REFERENCES auth.users(id),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT invoice_rounding_adjustments_unique_receipt UNIQUE (receipt_voucher_id),
  CONSTRAINT invoice_rounding_adjustments_unique_invoice UNIQUE (sales_invoice_id),
  CONSTRAINT invoice_rounding_adjustments_nonzero CHECK (adjustment_amount <> 0)
);

ALTER TABLE public.invoice_rounding_adjustments
  ADD COLUMN IF NOT EXISTS receipt_voucher_id uuid REFERENCES public.receipt_vouchers(id) ON DELETE CASCADE;

CREATE UNIQUE INDEX IF NOT EXISTS invoice_rounding_adjustments_one_per_receipt
  ON public.invoice_rounding_adjustments(receipt_voucher_id)
  WHERE receipt_voucher_id IS NOT NULL;

CREATE UNIQUE INDEX IF NOT EXISTS invoice_rounding_adjustments_one_per_invoice
  ON public.invoice_rounding_adjustments(sales_invoice_id);

ALTER TABLE public.invoice_rounding_adjustments ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "Allow read for authenticated" ON public.invoice_rounding_adjustments;
CREATE POLICY "Allow read for authenticated"
  ON public.invoice_rounding_adjustments FOR SELECT
  TO authenticated
  USING (true);

DROP POLICY IF EXISTS "Allow write for authenticated" ON public.invoice_rounding_adjustments;
CREATE POLICY "Allow write for authenticated"
  ON public.invoice_rounding_adjustments FOR ALL
  TO authenticated
  USING (true)
  WITH CHECK (true);

CREATE OR REPLACE FUNCTION public.get_invoice_allocation_amount(p_invoice_id uuid, p_exclude_voucher_id uuid DEFAULT NULL)
RETURNS numeric
LANGUAGE sql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
  SELECT COALESCE(SUM(va.allocated_amount), 0)
  FROM public.voucher_allocations va
  WHERE va.sales_invoice_id = p_invoice_id
    AND va.voucher_type = 'receipt'
    AND (p_exclude_voucher_id IS NULL OR va.receipt_voucher_id <> p_exclude_voucher_id);
$$;

CREATE OR REPLACE FUNCTION public.get_invoice_rounding_adjustment_amount(p_invoice_id uuid)
RETURNS numeric
LANGUAGE sql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
  SELECT COALESCE(SUM(ira.adjustment_amount), 0)
  FROM public.invoice_rounding_adjustments ira
  WHERE ira.sales_invoice_id = p_invoice_id;
$$;

CREATE OR REPLACE FUNCTION public.get_invoice_paid_amount(p_invoice_id uuid)
RETURNS numeric
LANGUAGE sql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
  SELECT public.get_invoice_allocation_amount(p_invoice_id, NULL)
       + public.get_invoice_rounding_adjustment_amount(p_invoice_id);
$$;

CREATE OR REPLACE FUNCTION public.recalculate_sales_invoice_payment_state(p_invoice_id uuid)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
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
  v_paid := v_allocated + v_adjustment;

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

CREATE OR REPLACE FUNCTION public.apply_receipt_allocation_rounding_adjustment(
  p_invoice_id uuid,
  p_receipt_voucher_id uuid DEFAULT NULL
)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_invoice record;
  v_allocated numeric(18,2);
  v_residual numeric(18,2);
  v_tolerance numeric(18,2);
  v_existing record;
  v_entry_id uuid;
  v_entry_number text;
  v_ar_account_id uuid;
  v_adjustment_account_id uuid;
  v_user_id uuid;
BEGIN
  SELECT *
  INTO v_invoice
  FROM public.sales_invoices
  WHERE id = p_invoice_id
  FOR UPDATE;

  IF NOT FOUND THEN
    RETURN;
  END IF;

  SELECT COALESCE(rounding_tolerance_amount, 0)
  INTO v_tolerance
  FROM public.app_settings
  LIMIT 1;
  v_tolerance := COALESCE(v_tolerance, 0);

  SELECT *
  INTO v_existing
  FROM public.invoice_rounding_adjustments
  WHERE sales_invoice_id = p_invoice_id
     OR (p_receipt_voucher_id IS NOT NULL AND receipt_voucher_id = p_receipt_voucher_id)
  LIMIT 1;

  v_allocated := public.get_invoice_allocation_amount(p_invoice_id, NULL);
  v_residual := ROUND(COALESCE(v_invoice.total_amount, 0) - COALESCE(v_allocated, 0), 2);

  IF ABS(v_residual) > 0 AND ABS(v_residual) <= v_tolerance THEN
    IF v_existing.id IS NOT NULL AND v_existing.adjustment_amount = v_residual THEN
      PERFORM public.recalculate_sales_invoice_payment_state(p_invoice_id);
      RETURN;
    END IF;

    IF v_existing.journal_entry_id IS NOT NULL THEN
      DELETE FROM public.journal_entry_lines WHERE journal_entry_id = v_existing.journal_entry_id;
      DELETE FROM public.journal_entries WHERE id = v_existing.journal_entry_id;
    END IF;
    IF v_existing.id IS NOT NULL THEN
      DELETE FROM public.invoice_rounding_adjustments WHERE id = v_existing.id;
    END IF;

    SELECT id INTO v_ar_account_id
    FROM public.chart_of_accounts
    WHERE code = '1120'
    LIMIT 1;

    IF v_residual > 0 THEN
      SELECT COALESCE(
        (SELECT rounding_writeoff_account_id FROM public.app_settings LIMIT 1),
        (SELECT id FROM public.chart_of_accounts WHERE code = '6900' LIMIT 1)
      )
      INTO v_adjustment_account_id;
    ELSE
      SELECT COALESCE(
        (SELECT rounding_gain_account_id FROM public.app_settings LIMIT 1),
        (SELECT id FROM public.chart_of_accounts WHERE code = '4900' LIMIT 1)
      )
      INTO v_adjustment_account_id;
    END IF;

    IF v_ar_account_id IS NULL OR v_adjustment_account_id IS NULL THEN
      RAISE EXCEPTION 'Missing account setup for invoice rounding adjustment';
    END IF;

    v_user_id := COALESCE(auth.uid(), v_invoice.created_by);
    v_entry_number := public.next_journal_entry_number();

    INSERT INTO public.journal_entries (
      entry_number, entry_date, source_module, reference_id, reference_number,
      description, total_debit, total_credit, is_posted, posted_by, created_by
    ) VALUES (
      v_entry_number,
      COALESCE(v_invoice.invoice_date, CURRENT_DATE),
      'sales_invoice_rounding',
      v_invoice.id,
      v_invoice.invoice_number,
      'Receipt allocation rounding adjustment: ' || v_invoice.invoice_number,
      ABS(v_residual),
      ABS(v_residual),
      true,
      v_user_id,
      v_user_id
    )
    RETURNING id INTO v_entry_id;

    IF v_residual > 0 THEN
      INSERT INTO public.journal_entry_lines (journal_entry_id, line_number, account_id, description, debit, credit, customer_id)
      VALUES
        (v_entry_id, 1, v_adjustment_account_id, 'Rounding write-off - ' || v_invoice.invoice_number, ABS(v_residual), 0, v_invoice.customer_id),
        (v_entry_id, 2, v_ar_account_id, 'A/R rounding clearance - ' || v_invoice.invoice_number, 0, ABS(v_residual), v_invoice.customer_id);
    ELSE
      INSERT INTO public.journal_entry_lines (journal_entry_id, line_number, account_id, description, debit, credit, customer_id)
      VALUES
        (v_entry_id, 1, v_ar_account_id, 'A/R rounding clearance - ' || v_invoice.invoice_number, ABS(v_residual), 0, v_invoice.customer_id),
        (v_entry_id, 2, v_adjustment_account_id, 'Rounding gain - ' || v_invoice.invoice_number, 0, ABS(v_residual), v_invoice.customer_id);
    END IF;

    INSERT INTO public.invoice_rounding_adjustments (
      receipt_voucher_id, sales_invoice_id, adjustment_amount, journal_entry_id, created_by
    ) VALUES (
      p_receipt_voucher_id, p_invoice_id, v_residual, v_entry_id, v_user_id
    );
  ELSE
    IF v_existing.journal_entry_id IS NOT NULL THEN
      DELETE FROM public.journal_entry_lines WHERE journal_entry_id = v_existing.journal_entry_id;
      DELETE FROM public.journal_entries WHERE id = v_existing.journal_entry_id;
    END IF;
    IF v_existing.id IS NOT NULL THEN
      DELETE FROM public.invoice_rounding_adjustments WHERE id = v_existing.id;
    END IF;
  END IF;

  PERFORM public.recalculate_sales_invoice_payment_state(p_invoice_id);
END;
$$;

CREATE OR REPLACE FUNCTION public.clear_receipt_allocation_rounding_adjustment(
  p_invoice_id uuid,
  p_receipt_voucher_id uuid DEFAULT NULL
)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_existing record;
BEGIN
  FOR v_existing IN
    SELECT *
    FROM public.invoice_rounding_adjustments
    WHERE sales_invoice_id = p_invoice_id
       OR (p_receipt_voucher_id IS NOT NULL AND receipt_voucher_id = p_receipt_voucher_id)
  LOOP
    IF v_existing.journal_entry_id IS NOT NULL THEN
      DELETE FROM public.journal_entry_lines WHERE journal_entry_id = v_existing.journal_entry_id;
      DELETE FROM public.journal_entries WHERE id = v_existing.journal_entry_id;
    END IF;

    DELETE FROM public.invoice_rounding_adjustments WHERE id = v_existing.id;
  END LOOP;

  PERFORM public.recalculate_sales_invoice_payment_state(p_invoice_id);
END;
$$;

CREATE OR REPLACE FUNCTION public.recalculate_invoice_payment_status()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
BEGIN
  IF TG_OP = 'INSERT' AND NEW.sales_invoice_id IS NOT NULL THEN
    PERFORM public.apply_receipt_allocation_rounding_adjustment(NEW.sales_invoice_id, NEW.receipt_voucher_id);
  ELSIF TG_OP = 'UPDATE' THEN
    IF NEW.sales_invoice_id IS NOT NULL THEN
      PERFORM public.apply_receipt_allocation_rounding_adjustment(NEW.sales_invoice_id, NEW.receipt_voucher_id);
    END IF;

    IF OLD.sales_invoice_id IS NOT NULL
       AND OLD.sales_invoice_id IS DISTINCT FROM NEW.sales_invoice_id THEN
      PERFORM public.clear_receipt_allocation_rounding_adjustment(OLD.sales_invoice_id, OLD.receipt_voucher_id);
    END IF;
  ELSIF TG_OP = 'DELETE' AND OLD.sales_invoice_id IS NOT NULL THEN
    PERFORM public.clear_receipt_allocation_rounding_adjustment(OLD.sales_invoice_id, OLD.receipt_voucher_id);
  END IF;

  RETURN COALESCE(NEW, OLD);
END;
$$;

DROP TRIGGER IF EXISTS trg_update_invoice_payment_status ON public.voucher_allocations;
CREATE TRIGGER trg_update_invoice_payment_status
  AFTER INSERT OR UPDATE OR DELETE ON public.voucher_allocations
  FOR EACH ROW
  EXECUTE FUNCTION public.recalculate_invoice_payment_status();

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
SET search_path = public, pg_temp
AS $$
BEGIN
  RETURN QUERY
  SELECT
    si.id,
    si.invoice_number,
    si.invoice_date,
    si.total_amount,
    public.get_invoice_allocation_amount(si.id, exclude_voucher_uuid)
      + CASE WHEN exclude_voucher_uuid IS NULL THEN public.get_invoice_rounding_adjustment_amount(si.id) ELSE 0 END AS paid_amount,
    si.total_amount - (
      public.get_invoice_allocation_amount(si.id, exclude_voucher_uuid)
      + CASE WHEN exclude_voucher_uuid IS NULL THEN public.get_invoice_rounding_adjustment_amount(si.id) ELSE 0 END
    ) AS balance_amount
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
SET search_path = public, pg_temp
AS $$
BEGIN
  RETURN QUERY
  SELECT
    si.id,
    si.invoice_number,
    si.invoice_date,
    si.customer_id,
    si.total_amount,
    public.get_invoice_allocation_amount(si.id, exclude_voucher_uuid)
      + CASE WHEN exclude_voucher_uuid IS NULL THEN public.get_invoice_rounding_adjustment_amount(si.id) ELSE 0 END AS paid_amount,
    si.total_amount - (
      public.get_invoice_allocation_amount(si.id, exclude_voucher_uuid)
      + CASE WHEN exclude_voucher_uuid IS NULL THEN public.get_invoice_rounding_adjustment_amount(si.id) ELSE 0 END
    ) AS balance_amount
  FROM public.sales_invoices si
  WHERE si.id = invoice_uuid
    AND COALESCE(si.is_draft, false) = false;
END;
$$;

REVOKE ALL ON FUNCTION public.get_invoice_allocation_amount(uuid, uuid) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.get_invoice_rounding_adjustment_amount(uuid) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.get_invoice_paid_amount(uuid) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.get_invoices_with_balance(uuid, uuid) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.get_invoice_with_balance(uuid, uuid) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.apply_receipt_allocation_rounding_adjustment(uuid, uuid) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.clear_receipt_allocation_rounding_adjustment(uuid, uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.get_invoice_allocation_amount(uuid, uuid) TO authenticated;
GRANT EXECUTE ON FUNCTION public.get_invoice_rounding_adjustment_amount(uuid) TO authenticated;
GRANT EXECUTE ON FUNCTION public.get_invoice_paid_amount(uuid) TO authenticated;
GRANT EXECUTE ON FUNCTION public.get_invoices_with_balance(uuid, uuid) TO authenticated;
GRANT EXECUTE ON FUNCTION public.get_invoice_with_balance(uuid, uuid) TO authenticated;
GRANT EXECUTE ON FUNCTION public.apply_receipt_allocation_rounding_adjustment(uuid, uuid) TO authenticated;
GRANT EXECUTE ON FUNCTION public.clear_receipt_allocation_rounding_adjustment(uuid, uuid) TO authenticated;

COMMENT ON COLUMN public.app_settings.rounding_tolerance_amount IS 'Maximum residual balance, in company currency, that can be automatically cleared during receipt allocation.';
COMMENT ON COLUMN public.app_settings.rounding_writeoff_account_id IS 'Expense account used when a customer underpayment residual is cleared.';
COMMENT ON COLUMN public.app_settings.rounding_gain_account_id IS 'Income account used when a small overpayment residual is cleared.';
COMMENT ON TABLE public.invoice_rounding_adjustments IS 'Auditable receipt-allocation rounding adjustments created only when residual balances fall within the configured tolerance.';

NOTIFY pgrst, 'reload schema';
