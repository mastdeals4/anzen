-- Official PPh Register totals must come only from posted, active journals.
-- Pending documents remain visible in the UI but never enter tax accounting.
BEGIN;

ALTER FUNCTION public.compute_period_ppn(uuid)
  RENAME TO compute_period_ppn_pre_posted_register;

CREATE FUNCTION public.compute_period_ppn(p_period_id uuid)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_period public.tax_periods%ROWTYPE;
  v_pph_total numeric(18,2);
BEGIN
  -- Preserve the existing PPN engine and all established calculations first.
  PERFORM public.compute_period_ppn_pre_posted_register(p_period_id);

  SELECT * INTO v_period FROM public.tax_periods WHERE id = p_period_id;
  IF NOT FOUND THEN RAISE EXCEPTION 'Tax period % not found', p_period_id; END IF;
  IF v_period.tax_type = 'PPN' THEN RETURN; END IF;

  SELECT
    COALESCE((
      SELECT SUM(fe.pph_amount)
        FROM public.finance_expenses fe
        LEFT JOIN public.tax_codes tc ON tc.id = fe.pph_code_id
       WHERE EXTRACT(YEAR FROM fe.expense_date)::int = v_period.fiscal_year
         AND EXTRACT(MONTH FROM fe.expense_date)::int = v_period.period_month
         AND fe.pph_amount > 0
         AND COALESCE(fe.expense_category, '') NOT IN ('pib_import', 'pph_import')
         AND (v_period.tax_type = 'PPh_Unifikasi' OR tc.tax_type = v_period.tax_type)
         AND EXISTS (
           SELECT 1 FROM public.journal_entries je
            WHERE je.reference_id = fe.id
              AND je.source_module IN ('expense', 'expenses')
              AND je.is_posted = true
              AND COALESCE(je.is_reversed, false) = false
         )
    ), 0)
    + COALESCE((
      SELECT SUM(pv.pph_amount)
        FROM public.payment_vouchers pv
        LEFT JOIN public.tax_codes tc ON tc.id = pv.pph_code_id
       WHERE EXTRACT(YEAR FROM pv.voucher_date)::int = v_period.fiscal_year
         AND EXTRACT(MONTH FROM pv.voucher_date)::int = v_period.period_month
         AND pv.pph_amount > 0
         AND (v_period.tax_type = 'PPh_Unifikasi' OR tc.tax_type = v_period.tax_type)
         AND EXISTS (
           SELECT 1 FROM public.journal_entries je
            WHERE je.reference_id = pv.id
              AND je.source_module IN ('payment', 'payments', 'payment_voucher')
              AND je.is_posted = true
              AND COALESCE(je.is_reversed, false) = false
         )
    ), 0)
    + CASE WHEN v_period.tax_type IN ('PPh22', 'PPh_Unifikasi') THEN
      COALESCE((
        SELECT SUM(fe.pib_pph_amount)
          FROM public.finance_expenses fe
         WHERE fe.expense_category = 'pib_import'
           AND EXTRACT(YEAR FROM fe.expense_date)::int = v_period.fiscal_year
           AND EXTRACT(MONTH FROM fe.expense_date)::int = v_period.period_month
           AND COALESCE(fe.pib_pph_amount, 0) > 0
           AND EXISTS (
             SELECT 1 FROM public.journal_entries je
              WHERE je.reference_id = fe.id
                AND je.source_module IN ('expense', 'expenses')
                AND je.is_posted = true
                AND COALESCE(je.is_reversed, false) = false
           )
      ), 0)
      + COALESCE((
        SELECT SUM(fe.amount)
          FROM public.finance_expenses fe
         WHERE fe.expense_category = 'pph_import'
           AND EXTRACT(YEAR FROM fe.expense_date)::int = v_period.fiscal_year
           AND EXTRACT(MONTH FROM fe.expense_date)::int = v_period.period_month
           AND COALESCE(fe.amount, 0) > 0
           AND EXISTS (
             SELECT 1 FROM public.journal_entries je
              WHERE je.reference_id = fe.id
                AND je.source_module IN ('expense', 'expenses')
                AND je.is_posted = true
                AND COALESCE(je.is_reversed, false) = false
           )
      ), 0)
    ELSE 0 END
  INTO v_pph_total;

  UPDATE public.tax_periods
     SET pph_total = v_pph_total, updated_at = now()
   WHERE id = p_period_id;
END;
$$;

-- Journal lifecycle is the final accounting event. Recompute after journal
-- creation, reversal, reopening, editing or deletion so trigger ordering on
-- the source document can never leave the Register stale.
CREATE OR REPLACE FUNCTION public.trg_recompute_tax_from_journal()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_source_module text := CASE WHEN TG_OP = 'DELETE' THEN OLD.source_module ELSE NEW.source_module END;
  v_reference_id uuid := CASE WHEN TG_OP = 'DELETE' THEN OLD.reference_id ELSE NEW.reference_id END;
  v_entry_date date := CASE WHEN TG_OP = 'DELETE' THEN OLD.entry_date ELSE NEW.entry_date END;
  v_source_date date;
BEGIN
  IF v_reference_id IS NULL THEN RETURN NULL; END IF;

  IF v_source_module IN ('expense', 'expenses') THEN
    SELECT expense_date INTO v_source_date FROM public.finance_expenses WHERE id = v_reference_id;
  ELSIF v_source_module IN ('payment', 'payments', 'payment_voucher') THEN
    SELECT voucher_date INTO v_source_date FROM public.payment_vouchers WHERE id = v_reference_id;
  ELSE
    RETURN NULL;
  END IF;

  PERFORM public.recompute_periods_for_date(COALESCE(v_source_date, v_entry_date));

  IF TG_OP = 'UPDATE' AND OLD.entry_date IS DISTINCT FROM NEW.entry_date THEN
    PERFORM public.recompute_periods_for_date(OLD.entry_date);
  END IF;
  RETURN NULL;
END;
$$;

DROP TRIGGER IF EXISTS trg_recompute_tax_from_journal ON public.journal_entries;
CREATE TRIGGER trg_recompute_tax_from_journal
AFTER INSERT OR UPDATE OR DELETE ON public.journal_entries
FOR EACH ROW EXECUTE FUNCTION public.trg_recompute_tax_from_journal();

REVOKE ALL ON FUNCTION public.compute_period_ppn(uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.compute_period_ppn(uuid) TO authenticated, service_role;

DO $$
DECLARE r record;
BEGIN
  FOR r IN SELECT id FROM public.tax_periods WHERE tax_type <> 'PPN' LOOP
    PERFORM public.compute_period_ppn(r.id);
  END LOOP;
END;
$$;

NOTIFY pgrst, 'reload schema';
COMMIT;
