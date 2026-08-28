-- Input PPN snapshots must consume the same broker accounting model as the
-- journal and UI, including reimbursement-line PPN.
CREATE OR REPLACE FUNCTION public.compute_period_ppn(p_period_id uuid)
RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path=public AS $$
DECLARE
  v_period tax_periods%ROWTYPE;
  v_input numeric(18,2);
  v_output numeric(18,2);
  v_prior_cf numeric(18,2);
  v_pph_total numeric(18,2);
BEGIN
  SELECT * INTO v_period FROM tax_periods WHERE id=p_period_id;
  IF NOT FOUND THEN RAISE EXCEPTION 'Tax period % not found',p_period_id; END IF;
  IF v_period.tax_type='PPN' THEN
    SELECT COALESCE((SELECT SUM(tax_amount) FROM purchase_invoices WHERE tax_period_id=p_period_id AND tax_amount>0),0)
      + COALESCE((SELECT SUM(CASE WHEN fe.expense_category='import_broker'
          THEN c.recoverable_input_ppn ELSE fe.ppn_amount END)
          FROM finance_expenses fe
          LEFT JOIN vw_customs_broker_accounting c ON c.expense_id=fe.id
          WHERE fe.tax_period_id=p_period_id
            AND (fe.expense_category<>'import_broker' AND fe.ppn_amount>0
                 OR fe.expense_category='import_broker' AND c.recoverable_input_ppn>0)),0)
      INTO v_input;
    SELECT COALESCE(SUM(tax_amount),0) INTO v_output FROM sales_invoices WHERE tax_period_id=p_period_id AND tax_amount>0;
    SELECT COALESCE(carry_forward_out,0) INTO v_prior_cf FROM tax_periods
      WHERE tax_type='PPN' AND (fiscal_year,period_month)<(v_period.fiscal_year,v_period.period_month)
      ORDER BY fiscal_year DESC,period_month DESC LIMIT 1;
    v_prior_cf:=COALESCE(v_prior_cf,0);
    UPDATE tax_periods SET input_ppn_total=v_input,output_ppn_total=v_output,carry_forward_in=v_prior_cf,
      net_ppn=GREATEST(v_output-v_input-v_prior_cf,0),carry_forward_out=GREATEST(v_input+v_prior_cf-v_output,0),updated_at=now()
      WHERE id=p_period_id;
  ELSE
    SELECT COALESCE(SUM(fe.pph_amount),0) INTO v_pph_total FROM finance_expenses fe
      LEFT JOIN tax_codes tc ON tc.id=fe.pph_code_id
      WHERE fe.tax_period_id=p_period_id AND fe.pph_amount>0
        AND (v_period.tax_type='PPh_Unifikasi' OR tc.tax_type=v_period.tax_type);
    UPDATE tax_periods SET pph_total=v_pph_total,updated_at=now() WHERE id=p_period_id;
  END IF;
END; $$;

DO $$ DECLARE r record; BEGIN
  FOR r IN SELECT id FROM tax_periods LOOP PERFORM compute_period_ppn(r.id); END LOOP;
END $$;
