-- Migration: 20261105180000_fix_receipt_voucher_settlement_amount_and_posting_allocations.sql
-- Description: Permanently fixes receipt voucher creation & posting:
--   1. Ensures save_receipt_voucher_with_allocations never writes to generated ALWAYS column `settlement_amount`.
--   2. Fixes post_receipt_voucher to reference `public.voucher_allocations` (not non-existent `receipt_voucher_allocations`).
--   3. Fixes USD/IDR FX calculation to only trigger foreign exchange gain/loss on USD receipts/invoices.
--   4. Preserves staff_id tracking on journal entry lines and recalculates sales invoice payment states.

-- 1. Upgraded save_receipt_voucher_with_allocations
CREATE OR REPLACE FUNCTION public.save_receipt_voucher_with_allocations(
  p_receipt_id uuid DEFAULT NULL::uuid,
  p_payload jsonb DEFAULT '{}'::jsonb,
  p_allocations jsonb DEFAULT '[]'::jsonb
)
RETURNS uuid
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE
  v_id uuid;
  v_alloc jsonb;
  v_currency text;
  v_rate numeric;
  v_actor uuid;
  v_party_type text;
  v_customer_id uuid;
  v_supplier_id uuid;
  v_staff_id uuid;
  v_purpose text;
  v_settle_against text;
  v_settle_disc numeric;
  v_alloc_disc numeric;
  v_adj_reason text;
  v_adj_account_id uuid;
  v_adj_notes text;
  v_method text;
  v_bank_id uuid;
  v_ref text;
  v_amount numeric;
  v_desc text;
  v_date date;
  v_existing RECORD;
BEGIN
  IF auth.role() = 'authenticated' AND auth.uid() IS NOT NULL THEN
    PERFORM public._sec_check_finance_role();
  ELSIF auth.role() = 'anon' THEN
    RAISE EXCEPTION 'Not authenticated' USING ERRCODE = '42501';
  END IF;

  v_actor := COALESCE(auth.uid(), NULLIF(p_payload->>'created_by','')::uuid);

  v_party_type := lower(COALESCE(p_payload->>'party_type', 'customer'));
  v_customer_id := NULLIF(p_payload->>'customer_id', '')::uuid;
  v_supplier_id := NULLIF(p_payload->>'supplier_id', '')::uuid;
  v_staff_id := NULLIF(p_payload->>'staff_id', '')::uuid;
  v_purpose := COALESCE(p_payload->>'payment_purpose', CASE WHEN v_party_type = 'supplier' THEN 'supplier_refund' ELSE 'invoice_payment' END);
  v_settle_against := COALESCE(p_payload->>'settlement_against', CASE WHEN v_party_type = 'customer' THEN 'specific_document' ELSE 'advance' END);
  v_settle_disc := COALESCE((p_payload->>'settlement_discount')::numeric, 0);
  v_adj_reason := NULLIF(p_payload->>'adjustment_reason', '');
  v_adj_account_id := NULLIF(p_payload->>'adjustment_account_id', '')::uuid;
  v_adj_notes := NULLIF(p_payload->>'adjustment_notes', '');
  v_method := COALESCE(p_payload->>'payment_method', 'bank_transfer');
  v_bank_id := NULLIF(p_payload->>'bank_account_id', '')::uuid;
  v_ref := NULLIF(p_payload->>'reference_number', '');
  v_amount := COALESCE((p_payload->>'amount')::numeric, 0);
  v_desc := NULLIF(p_payload->>'description', '');
  v_date := COALESCE(NULLIF(p_payload->>'voucher_date', '')::date, CURRENT_DATE);
  v_currency := upper(COALESCE(p_payload->>'transaction_currency', p_payload->>'currency_code', 'IDR'));
  v_rate := COALESCE(NULLIF((p_payload->>'exchange_rate')::numeric, 0), 1);

  -- Auto-assign default difference account 6910 if discount is positive and account not provided
  IF v_settle_disc > 0 AND v_adj_account_id IS NULL THEN
    SELECT id INTO v_adj_account_id FROM public.chart_of_accounts WHERE code = '6910' AND is_active = true AND is_header = false LIMIT 1;
  END IF;

  IF p_receipt_id IS NOT NULL THEN
    SELECT * INTO v_existing FROM public.receipt_vouchers WHERE id = p_receipt_id FOR UPDATE;
    IF NOT FOUND THEN RAISE EXCEPTION 'Receipt voucher % not found', p_receipt_id; END IF;
    IF v_existing.is_posted THEN RAISE EXCEPTION 'Cannot update posted receipt voucher %', v_existing.voucher_number; END IF;
    v_id := p_receipt_id;

    UPDATE public.receipt_vouchers
    SET voucher_date = v_date,
        party_type = v_party_type,
        customer_id = v_customer_id,
        supplier_id = v_supplier_id,
        staff_id = v_staff_id,
        payment_purpose = v_purpose,
        settlement_against = v_settle_against,
        settlement_discount = v_settle_disc,
        adjustment_reason = v_adj_reason,
        adjustment_account_id = v_adj_account_id,
        adjustment_notes = v_adj_notes,
        payment_method = v_method,
        bank_account_id = v_bank_id,
        reference_number = v_ref,
        amount = v_amount,
        description = v_desc,
        currency_code = v_currency,
        transaction_currency = v_currency,
        exchange_rate = v_rate
    WHERE id = v_id;

    DELETE FROM public.voucher_allocations WHERE receipt_voucher_id = v_id;
  ELSE
    INSERT INTO public.receipt_vouchers (
      voucher_number,
      voucher_date,
      party_type,
      customer_id,
      supplier_id,
      staff_id,
      payment_purpose,
      settlement_against,
      settlement_discount,
      adjustment_reason,
      adjustment_account_id,
      adjustment_notes,
      payment_method,
      bank_account_id,
      reference_number,
      amount,
      description,
      currency_code,
      transaction_currency,
      exchange_rate,
      created_by
    ) VALUES (
      public.next_receipt_voucher_number(v_date),
      v_date,
      v_party_type,
      v_customer_id,
      v_supplier_id,
      v_staff_id,
      v_purpose,
      v_settle_against,
      v_settle_disc,
      v_adj_reason,
      v_adj_account_id,
      v_adj_notes,
      v_method,
      v_bank_id,
      v_ref,
      v_amount,
      v_desc,
      v_currency,
      v_currency,
      v_rate,
      v_actor
    ) RETURNING id INTO v_id;
  END IF;

  FOR v_alloc IN SELECT * FROM jsonb_array_elements(p_allocations)
  LOOP
    v_alloc_disc := COALESCE((v_alloc->>'discountAmount')::numeric, 0);
    INSERT INTO public.voucher_allocations (
      voucher_type,
      receipt_voucher_id,
      sales_invoice_id,
      sales_order_id,
      allocated_amount,
      settlement_discount,
      adjustment_reason,
      notes
    ) VALUES (
      'receipt',
      v_id,
      NULLIF(v_alloc->>'sales_invoice_id', '')::uuid,
      NULLIF(v_alloc->>'sales_order_id', '')::uuid,
      COALESCE((v_alloc->>'amount')::numeric, 0),
      v_alloc_disc,
      NULLIF(v_alloc->>'adjustment_reason', ''),
      NULLIF(v_alloc->>'notes', '')
    );
  END LOOP;

  RETURN v_id;
END;
$function$;

REVOKE ALL ON FUNCTION public.save_receipt_voucher_with_allocations(uuid, jsonb, jsonb) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.save_receipt_voucher_with_allocations(uuid, jsonb, jsonb) TO authenticated, service_role;

-- 2. Upgraded post_receipt_voucher
CREATE OR REPLACE FUNCTION public.post_receipt_voucher(p_rv_id uuid, p_posted_by uuid DEFAULT NULL::uuid)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE
  v_rv                 RECORD;
  v_je_id              UUID;
  v_je_number          TEXT;
  v_bank_account_id    UUID;
  v_credit_account_id  UUID;
  v_diff_account_id    UUID;
  v_fx_gain_coa        UUID;
  v_fx_loss_coa        UUID;
  v_actual_poster      UUID;
  v_actual_received    NUMERIC;
  v_settle_diff        NUMERIC;
  v_carrying_amount    NUMERIC;
  v_rate               NUMERIC;
  v_currency           TEXT;
  v_party_type         TEXT;
  v_bank_coa_id        UUID;
  v_bank_active        BOOLEAN;
  v_bank_curr          TEXT;
  v_coa_code           TEXT;
  v_coa_name           TEXT;
  v_coa_is_header      BOOLEAN;
  v_alloc_foreign      NUMERIC := 0;
  v_alloc_carrying_idr NUMERIC := 0;
  v_ar_relief_idr      NUMERIC := 0;
  v_bank_received_idr  NUMERIC := 0;
  v_realized_fx        NUMERIC := 0;
  v_fx_gain_amt        NUMERIC := 0;
  v_fx_loss_amt        NUMERIC := 0;
  v_total_debit        NUMERIC;
  v_total_credit       NUMERIC;
  v_line               INTEGER := 1;
  v_usd_bank_rate      NUMERIC := 1;
  v_avail_advances     NUMERIC;
BEGIN
  IF auth.role() = 'authenticated' AND auth.uid() IS NOT NULL THEN
    PERFORM public._sec_check_finance_role();
  ELSIF auth.role() = 'anon' THEN
    RAISE EXCEPTION 'Not authenticated' USING ERRCODE = '42501';
  END IF;

  v_actual_poster := COALESCE(auth.uid(), p_posted_by);

  SELECT * INTO v_rv FROM public.receipt_vouchers WHERE id = p_rv_id FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Receipt voucher % not found', p_rv_id;
  END IF;

  IF v_rv.is_posted THEN
    RAISE EXCEPTION 'Receipt voucher % is already posted', v_rv.voucher_number;
  END IF;

  v_party_type := lower(COALESCE(v_rv.party_type, 'customer'));
  v_actual_received := COALESCE(v_rv.amount, 0);
  v_settle_diff := COALESCE(v_rv.settlement_discount, 0);
  v_carrying_amount := v_actual_received + v_settle_diff;
  v_rate := COALESCE(NULLIF(v_rv.exchange_rate, 0), 1);
  v_currency := upper(COALESCE(v_rv.currency_code, v_rv.transaction_currency, 'IDR'));

  -- Strict Validation: Bank Account and Leaf COA
  IF v_rv.payment_method IN ('bank_transfer', 'check', 'giro') THEN
    IF v_rv.bank_account_id IS NULL THEN
      RAISE EXCEPTION 'Bank account selection is mandatory for % receipts (voucher %)', v_rv.payment_method, v_rv.voucher_number;
    END IF;

    SELECT ba.coa_id, ba.is_active, upper(ba.currency), coa.code, coa.name, coa.is_header
    INTO v_bank_coa_id, v_bank_active, v_bank_curr, v_coa_code, v_coa_name, v_coa_is_header
    FROM public.bank_accounts ba
    LEFT JOIN public.chart_of_accounts coa ON coa.id = ba.coa_id
    WHERE ba.id = v_rv.bank_account_id;

    IF v_bank_coa_id IS NULL THEN
      RAISE EXCEPTION 'Bank account % does not have a linked General Ledger account', v_rv.bank_account_id;
    END IF;

    IF NOT COALESCE(v_bank_active, false) THEN
      RAISE EXCEPTION 'Selected bank account % is inactive', v_rv.bank_account_id;
    END IF;

    IF COALESCE(v_coa_is_header, false) THEN
      RAISE EXCEPTION 'Journal lines cannot be posted to header account % — use a leaf account instead (P0001)', v_coa_code;
    END IF;

    -- Dynamic USD bank carrying rate if deposit into USD bank
    IF v_bank_curr = 'USD' THEN
      SELECT 
        CASE 
          WHEN NULLIF(SUM(jel.transaction_debit - jel.transaction_credit), 0) IS NOT NULL AND SUM(jel.transaction_debit - jel.transaction_credit) > 0 THEN 
            round(SUM(jel.debit - jel.credit) / SUM(jel.transaction_debit - jel.transaction_credit), 4)
          ELSE 
            COALESCE(
              (SELECT frl.revalued_rate
               FROM public.fx_revaluation_lines frl
               JOIN public.fx_revaluations fr ON fr.id = frl.revaluation_id
               WHERE frl.bank_account_id = v_rv.bank_account_id
                 AND fr.status = 'posted'
                 AND fr.revaluation_date <= v_rv.voucher_date
               ORDER BY fr.revaluation_date DESC, fr.created_at DESC
               LIMIT 1),
              v_rate
            )
        END
      INTO v_usd_bank_rate
      FROM public.journal_entry_lines jel
      JOIN public.journal_entries je ON je.id = jel.journal_entry_id
      WHERE jel.account_id = v_bank_coa_id 
        AND je.is_posted = true 
        AND NOT COALESCE(je.is_reversed, false)
        AND je.entry_date <= v_rv.voucher_date;

      v_usd_bank_rate := COALESCE(v_usd_bank_rate, v_rate);
    END IF;

    v_bank_account_id := v_bank_coa_id;

  ELSIF v_rv.payment_method = 'cash' THEN
    SELECT id INTO v_bank_account_id FROM public.chart_of_accounts WHERE code = '1101' AND is_active = true AND is_header = false LIMIT 1;
    IF v_bank_account_id IS NULL THEN
      SELECT id INTO v_bank_account_id FROM public.chart_of_accounts WHERE code = '1102' AND is_active = true AND is_header = false LIMIT 1;
    END IF;
    IF v_bank_account_id IS NULL THEN
      RAISE EXCEPTION 'No active postable Cash/Petty Cash GL account found (GL 1101/1102)';
    END IF;
  ELSE
    RAISE EXCEPTION 'Unsupported payment method: % for receipt voucher %', v_rv.payment_method, v_rv.voucher_number;
  END IF;

  -- Resolve FX Gain / Loss GL Accounts
  SELECT id INTO v_fx_gain_coa FROM public.chart_of_accounts WHERE code = '4930' AND is_active = true LIMIT 1;
  SELECT id INTO v_fx_loss_coa FROM public.chart_of_accounts WHERE code = '7300' AND is_active = true LIMIT 1;

  -- Concurrency & Balance Validation for Supplier Refund
  IF v_party_type = 'supplier' AND v_rv.supplier_id IS NOT NULL THEN
    PERFORM id FROM public.suppliers WHERE id = v_rv.supplier_id FOR UPDATE;

    SELECT COALESCE(SUM((pv.amount * COALESCE(pv.exchange_rate, 1)) - COALESCE(va.allocated, 0)), 0)
    INTO v_avail_advances
    FROM public.payment_vouchers pv
    LEFT JOIN (
      SELECT payment_voucher_id, SUM(allocated_amount) as allocated
      FROM public.voucher_allocations
      GROUP BY payment_voucher_id
    ) va ON va.payment_voucher_id = pv.id
    WHERE pv.supplier_id = v_rv.supplier_id
      AND pv.is_posted = true
      AND (pv.payment_purpose = 'supplier_advance' OR pv.settlement_against = 'advance');

    IF (v_actual_received * v_rate) > (v_avail_advances + 0.01) THEN
      RAISE EXCEPTION 'Supplier refund amount (%) exceeds available advance balance (%)',
        (v_actual_received * v_rate), v_avail_advances;
    END IF;
  END IF;

  -- Resolve Credit Control Account
  IF v_party_type = 'customer' THEN
    IF v_rv.settlement_against = 'advance' THEN
      IF v_rv.coa_account_id IS NOT NULL THEN
        v_credit_account_id := v_rv.coa_account_id;
      ELSE
        SELECT id INTO v_credit_account_id FROM public.chart_of_accounts WHERE code = '2140' AND is_active = true AND is_header = false LIMIT 1;
        IF v_credit_account_id IS NULL THEN
          SELECT id INTO v_credit_account_id FROM public.chart_of_accounts WHERE code = '1120' AND is_active = true AND is_header = false LIMIT 1;
        END IF;
      END IF;
    ELSE
      IF v_rv.coa_account_id IS NOT NULL THEN
        v_credit_account_id := v_rv.coa_account_id;
      ELSE
        SELECT id INTO v_credit_account_id FROM public.chart_of_accounts WHERE code = '1120' AND is_active = true AND is_header = false LIMIT 1;
      END IF;
    END IF;

    -- Multi-Document Allocation Handling for FX Realization (only for USD receipts)
    SELECT 
      COALESCE(SUM(CASE WHEN upper(COALESCE(so.currency, v_currency)) = 'USD' THEN va.allocated_amount ELSE 0 END), 0),
      COALESCE(SUM(CASE 
        WHEN upper(COALESCE(so.currency, v_currency)) = 'USD' THEN
          va.allocated_amount * COALESCE(
            (SELECT frl.revalued_rate
             FROM public.fx_revaluation_lines frl
             JOIN public.fx_revaluations fr ON fr.id = frl.revaluation_id
             WHERE frl.sales_invoice_id = va.sales_invoice_id
               AND fr.status = 'posted'
               AND fr.revaluation_date <= v_rv.voucher_date
             ORDER BY fr.revaluation_date DESC, fr.created_at DESC
             LIMIT 1),
            so.commercial_usd_to_idr_rate,
            v_rate
          )
        ELSE 0
      END), 0)
    INTO v_alloc_foreign, v_alloc_carrying_idr
    FROM public.voucher_allocations va
    LEFT JOIN public.sales_invoices si ON si.id = va.sales_invoice_id
    LEFT JOIN public.sales_orders so ON so.id = COALESCE(va.sales_order_id, si.sales_order_id)
    WHERE va.receipt_voucher_id = p_rv_id
      AND va.voucher_type = 'receipt';

    IF v_currency = 'USD' AND v_alloc_foreign > 0 THEN
      v_ar_relief_idr := v_alloc_carrying_idr + ((v_carrying_amount - v_alloc_foreign) * v_rate);
      v_bank_received_idr := v_actual_received * (CASE WHEN v_bank_curr = 'USD' THEN v_usd_bank_rate ELSE v_rate END);
      v_realized_fx := v_bank_received_idr - (v_ar_relief_idr - (v_settle_diff * v_rate));

      IF v_realized_fx > 0 THEN
        v_fx_gain_amt := v_realized_fx;
      ELSIF v_realized_fx < 0 THEN
        v_fx_loss_amt := abs(v_realized_fx);
      END IF;
    ELSIF v_currency = 'USD' THEN
      v_bank_received_idr := v_actual_received * (CASE WHEN v_bank_curr = 'USD' THEN v_usd_bank_rate ELSE v_rate END);
      v_ar_relief_idr := v_carrying_amount * v_rate;
      v_realized_fx := v_bank_received_idr - (v_ar_relief_idr - (v_settle_diff * v_rate));
      IF v_realized_fx > 0 THEN
        v_fx_gain_amt := v_realized_fx;
      ELSIF v_realized_fx < 0 THEN
        v_fx_loss_amt := abs(v_realized_fx);
      END IF;
    ELSE
      -- Standard IDR customer receipt
      v_ar_relief_idr := v_carrying_amount;
      v_bank_received_idr := v_actual_received;
      v_fx_gain_amt := 0;
      v_fx_loss_amt := 0;
    END IF;

  ELSIF v_party_type = 'supplier' THEN
    IF v_rv.coa_account_id IS NOT NULL THEN
      v_credit_account_id := v_rv.coa_account_id;
    ELSE
      SELECT id INTO v_credit_account_id FROM public.chart_of_accounts WHERE code = '1170' AND is_active = true AND is_header = false LIMIT 1;
      IF v_credit_account_id IS NULL THEN
        SELECT id INTO v_credit_account_id FROM public.chart_of_accounts WHERE code = '2110' AND is_active = true AND is_header = false LIMIT 1;
      END IF;
    END IF;
    v_ar_relief_idr := v_carrying_amount;
    v_bank_received_idr := v_actual_received;

  ELSIF v_party_type = 'employee' THEN
    SELECT id INTO v_credit_account_id FROM public.chart_of_accounts WHERE code = '1160' AND is_active = true AND is_header = false LIMIT 1;
    IF v_credit_account_id IS NULL THEN
      SELECT id INTO v_credit_account_id FROM public.chart_of_accounts WHERE code = '1120' AND is_active = true AND is_header = false LIMIT 1;
    END IF;
    v_ar_relief_idr := v_carrying_amount;
    v_bank_received_idr := v_actual_received;

  ELSIF v_party_type = 'director' THEN
    SELECT id INTO v_credit_account_id FROM public.chart_of_accounts WHERE code = '2105' AND is_active = true AND is_header = false LIMIT 1;
    IF v_credit_account_id IS NULL THEN
      SELECT id INTO v_credit_account_id FROM public.chart_of_accounts WHERE code = '2110' AND is_active = true AND is_header = false LIMIT 1;
    END IF;
    v_ar_relief_idr := v_carrying_amount;
    v_bank_received_idr := v_actual_received;

  ELSE
    RAISE EXCEPTION 'Unsupported party type: %', v_party_type;
  END IF;

  IF v_credit_account_id IS NULL OR NOT EXISTS (
    SELECT 1 FROM public.chart_of_accounts WHERE id = v_credit_account_id AND is_active = true AND is_header = false
  ) THEN
    RAISE EXCEPTION 'Credit control account could not be resolved or is inactive/header for voucher %', v_rv.voucher_number;
  END IF;

  -- Resolve Settlement Difference Account (COA 6910 default)
  IF v_settle_diff > 0 THEN
    IF v_rv.adjustment_account_id IS NOT NULL THEN
      SELECT id INTO v_diff_account_id FROM public.chart_of_accounts WHERE id = v_rv.adjustment_account_id AND is_active = true AND is_header = false;
    END IF;
    IF v_diff_account_id IS NULL THEN
      SELECT id INTO v_diff_account_id FROM public.chart_of_accounts WHERE code = '6910' AND is_active = true AND is_header = false LIMIT 1;
    END IF;
    IF v_diff_account_id IS NULL THEN
      SELECT id INTO v_diff_account_id FROM public.chart_of_accounts WHERE code = '6900' AND is_active = true AND is_header = false LIMIT 1;
    END IF;
  END IF;

  v_total_debit := v_bank_received_idr + (v_settle_diff * v_rate) + v_fx_loss_amt;
  v_total_credit := v_ar_relief_idr + v_fx_gain_amt;

  IF abs(v_total_debit - v_total_credit) > 0.05 THEN
    RAISE EXCEPTION 'Journal entry debit total (%) does not balance with credit total (%)', v_total_debit, v_total_credit;
  END IF;

  v_je_number := public.next_journal_entry_number();

  INSERT INTO public.journal_entries (
    entry_number,
    entry_date,
    source_module,
    reference_id,
    reference_number,
    description,
    total_debit,
    total_credit,
    is_posted,
    posted_by,
    created_by,
    transaction_currency,
    functional_currency,
    exchange_rate
  ) VALUES (
    v_je_number,
    v_rv.voucher_date,
    'receipt',
    v_rv.id,
    v_rv.voucher_number,
    'Receipt Voucher (' || v_party_type || '): ' || v_rv.voucher_number,
    v_total_debit,
    v_total_credit,
    TRUE,
    v_actual_poster,
    v_actual_poster,
    v_currency,
    'IDR',
    v_rate
  ) RETURNING id INTO v_je_id;

  -- Line 1 (Dr): Bank or Cash
  INSERT INTO public.journal_entry_lines (
    journal_entry_id, line_number, account_id, description,
    debit, credit, customer_id, supplier_id, staff_id, payee_id,
    transaction_currency, transaction_debit, transaction_credit, exchange_rate
  ) VALUES (
    v_je_id, v_line, v_bank_account_id,
    'Receipt: ' || v_rv.voucher_number,
    v_bank_received_idr, 0,
    NULL, NULL, NULL, NULL,
    v_currency, v_actual_received, 0, v_rate
  );
  v_line := v_line + 1;

  -- Line 2 (Dr): Settlement Discount / Rounding Difference (if > 0)
  IF v_settle_diff > 0 AND v_diff_account_id IS NOT NULL THEN
    INSERT INTO public.journal_entry_lines (
      journal_entry_id, line_number, account_id, description,
      debit, credit, customer_id, supplier_id, staff_id, payee_id,
      transaction_currency, transaction_debit, transaction_credit, exchange_rate
    ) VALUES (
      v_je_id, v_line, v_diff_account_id,
      'Settlement Difference: ' || v_rv.voucher_number,
      v_settle_diff * v_rate, 0,
      NULL, NULL, NULL, NULL,
      v_currency, v_settle_diff, 0, v_rate
    );
    v_line := v_line + 1;
  END IF;

  -- Line 3 (Dr): Realized FX Loss (GL 7300) if any
  IF v_fx_loss_amt > 0 AND v_fx_loss_coa IS NOT NULL THEN
    INSERT INTO public.journal_entry_lines (
      journal_entry_id, line_number, account_id, description,
      debit, credit, customer_id, supplier_id, staff_id, payee_id,
      transaction_currency, transaction_debit, transaction_credit, exchange_rate
    ) VALUES (
      v_je_id, v_line, v_fx_loss_coa,
      'Realized FX Loss - Customer Receipt ' || v_rv.voucher_number,
      v_fx_loss_amt, 0,
      NULL, NULL, NULL, NULL,
      'IDR', v_fx_loss_amt, 0, 1
    );
    v_line := v_line + 1;
  END IF;

  -- Line 4 (Cr): Control Account (1120 for customer receipt, 1170 for supplier refund, 1160 for employee, etc.)
  INSERT INTO public.journal_entry_lines (
    journal_entry_id, line_number, account_id, description,
    debit, credit, customer_id, supplier_id, staff_id, payee_id,
    transaction_currency, transaction_debit, transaction_credit, exchange_rate
  ) VALUES (
    v_je_id, v_line, v_credit_account_id,
    CASE 
      WHEN v_party_type = 'supplier' THEN 'Supplier Advance Refund - '
      WHEN v_party_type = 'customer' THEN 'Customer Receipt - '
      WHEN v_party_type = 'employee' THEN 'Staff Return - '
      ELSE 'Receipt - '
    END || v_rv.voucher_number,
    0, v_ar_relief_idr,
    CASE WHEN v_party_type = 'customer' THEN v_rv.customer_id ELSE NULL END,
    CASE WHEN v_party_type = 'supplier' THEN v_rv.supplier_id ELSE NULL END,
    CASE WHEN v_party_type = 'employee' THEN v_rv.staff_id ELSE NULL END,
    NULL,
    v_currency, 0, v_carrying_amount, v_rate
  );
  v_line := v_line + 1;

  -- Line 5 (Cr): Realized FX Gain (GL 4930) if any
  IF v_fx_gain_amt > 0 AND v_fx_gain_coa IS NOT NULL THEN
    INSERT INTO public.journal_entry_lines (
      journal_entry_id, line_number, account_id, description,
      debit, credit, customer_id, supplier_id, staff_id, payee_id,
      transaction_currency, transaction_debit, transaction_credit, exchange_rate
    ) VALUES (
      v_je_id, v_line, v_fx_gain_coa,
      'Realized FX Gain - Customer Receipt ' || v_rv.voucher_number,
      0, v_fx_gain_amt,
      NULL, NULL, NULL, NULL,
      'IDR', 0, v_fx_gain_amt, 1
    );
    v_line := v_line + 1;
  END IF;

  UPDATE public.receipt_vouchers
  SET is_posted = TRUE, journal_entry_id = v_je_id
  WHERE id = p_rv_id;

  -- Recalculate Sales Invoice states if customer receipt
  IF v_party_type = 'customer' THEN
    PERFORM public.recalculate_sales_invoice_payment_state(va.sales_invoice_id)
    FROM public.voucher_allocations va
    WHERE va.receipt_voucher_id = p_rv_id AND va.sales_invoice_id IS NOT NULL;
  END IF;

  -- Sync Bank GL
  IF v_rv.bank_account_id IS NOT NULL THEN
    PERFORM public.sync_bank_account_balance(v_rv.bank_account_id);
  END IF;

  -- Audit log
  INSERT INTO public.audit_logs (table_name, record_id, action_type, old_values, new_values, user_id)
  VALUES ('receipt_vouchers', p_rv_id, 'update', jsonb_build_object('is_posted', false), jsonb_build_object('is_posted', true, 'journal_entry_id', v_je_id), v_actual_poster);
END;
$function$;

REVOKE ALL ON FUNCTION public.post_receipt_voucher(uuid, uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.post_receipt_voucher(uuid, uuid) TO authenticated, service_role;

-- 3. Modernize sync_receipt_journal_currency to preserve canonical poster amounts
CREATE OR REPLACE FUNCTION public.sync_receipt_journal_currency()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE
  v_currency text := upper(COALESCE(NEW.transaction_currency, NEW.currency_code, 'IDR'));
  v_rate numeric := COALESCE(NEW.exchange_rate, 1);
BEGIN
  IF COALESCE(NEW.is_posted, false) = false OR NEW.journal_entry_id IS NULL THEN RETURN NEW; END IF;
  IF COALESCE(current_setting('app.finance_historical_repair', true), 'off') = 'on' THEN RETURN NEW; END IF;
  IF v_currency NOT IN ('IDR', 'USD') OR v_rate <= 0 THEN
    RAISE EXCEPTION 'Posted receipt has invalid currency metadata';
  END IF;

  -- The canonical poster owns the numerical amounts. Fill metadata only.
  UPDATE public.journal_entry_lines
     SET transaction_currency = COALESCE(transaction_currency, v_currency),
         transaction_debit = COALESCE(transaction_debit,
           CASE WHEN COALESCE(exchange_rate, 1) > 0 THEN debit / COALESCE(exchange_rate, 1) ELSE debit END),
         transaction_credit = COALESCE(transaction_credit,
           CASE WHEN COALESCE(exchange_rate, 1) > 0 THEN credit / COALESCE(exchange_rate, 1) ELSE credit END),
         functional_currency = 'IDR',
         exchange_rate = COALESCE(exchange_rate, CASE WHEN v_currency = 'USD' THEN v_rate ELSE 1 END)
   WHERE journal_entry_id = NEW.journal_entry_id;

  UPDATE public.journal_entries SET
    transaction_currency = v_currency,
    functional_currency = 'IDR',
    exchange_rate = v_rate,
    amounts_are_functional = true,
    total_debit = (SELECT COALESCE(sum(debit), 0) FROM public.journal_entry_lines WHERE journal_entry_id = NEW.journal_entry_id),
    total_credit = (SELECT COALESCE(sum(credit), 0) FROM public.journal_entry_lines WHERE journal_entry_id = NEW.journal_entry_id)
  WHERE id = NEW.journal_entry_id;
  RETURN NEW;
END;
$function$;

