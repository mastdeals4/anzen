-- ═══════════════════════════════════════════════════════════════════════════
-- Migration: 20261105110000_add_staff_id_to_journal_entry_lines_and_fix_post_pv.sql
-- Description: Add staff_id foreign key to journal_entry_lines, separate
--              finance_staff_master from finance_payees, and permanently fix
--              post_payment_voucher and post_receipt_voucher party field mapping.
-- ═══════════════════════════════════════════════════════════════════════════

-- 1. Database Schema Correction: Add staff_id to journal_entry_lines
ALTER TABLE public.journal_entry_lines
  ADD COLUMN IF NOT EXISTS staff_id UUID REFERENCES public.finance_staff_master(id) ON DELETE SET NULL;

CREATE INDEX IF NOT EXISTS idx_journal_entry_lines_staff_id
  ON public.journal_entry_lines(staff_id)
  WHERE staff_id IS NOT NULL;

-- 2. Update post_payment_voucher with accurate employee and party routing
CREATE OR REPLACE FUNCTION public.post_payment_voucher(p_pv_id uuid, p_posted_by uuid DEFAULT NULL::uuid)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE
  v_pv                      RECORD;
  v_je                      UUID;
  v_entry                   TEXT;
  v_actual_poster           UUID;
  v_bank_coa                UUID;
  v_bank_active             BOOLEAN;
  v_bank_is_header          BOOLEAN;
  v_debit_coa               UUID;
  v_charge_coa              UUID;
  v_diff_coa                UUID;
  v_fx_loss_coa             UUID;
  v_fx_gain_coa             UUID;
  v_rate                    NUMERIC := 1;
  v_actual                  NUMERIC;
  v_gross                   NUMERIC;
  v_charge_amt              NUMERIC := 0;
  v_settle_diff             NUMERIC := 0;
  v_bank_currency           TEXT := 'IDR';
  v_invoice_currency        TEXT := 'IDR';
  v_party_type              TEXT;
  v_ap_relief_idr           NUMERIC := 0;
  v_bank_credit_idr         NUMERIC := 0;
  v_alloc_usd               NUMERIC := 0;
  v_alloc_carrying_idr      NUMERIC := 0;
  v_alloc_settle_idr        NUMERIC := 0;
  v_realized_fx             NUMERIC := 0;
  v_fx_loss_amt             NUMERIC := 0;
  v_fx_gain_amt             NUMERIC := 0;
  v_total_debit             NUMERIC;
  v_total_credit            NUMERIC;
  v_line                    INTEGER := 1;
  v_usd_bank_carrying_rate  NUMERIC := 1;
BEGIN
  IF auth.role() = 'authenticated' AND auth.uid() IS NOT NULL THEN
    PERFORM public._sec_check_finance_role();
  ELSIF auth.role() = 'anon' THEN
    RAISE EXCEPTION 'Not authenticated' USING ERRCODE = '42501';
  END IF;

  v_actual_poster := COALESCE(auth.uid(), p_posted_by);

  SELECT * INTO v_pv FROM public.payment_vouchers WHERE id = p_pv_id FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Payment voucher % not found', p_pv_id;
  END IF;

  IF v_pv.is_posted THEN
    RAISE EXCEPTION 'Payment voucher % is already posted', v_pv.voucher_number;
  END IF;

  v_party_type := lower(COALESCE(v_pv.party_type, 'supplier'));
  v_gross := COALESCE(v_pv.amount, 0);
  v_charge_amt := COALESCE(v_pv.bank_charge, 0);
  v_settle_diff := COALESCE(v_pv.settlement_discount, 0);
  v_actual := COALESCE(v_pv.actual_bank_debit, v_pv.bank_amount, v_gross + v_charge_amt);
  v_rate := COALESCE(NULLIF(v_pv.exchange_rate, 0), 1);
  v_bank_currency := COALESCE(v_pv.currency_code, v_pv.transaction_currency, 'IDR');

  -- Resolve Bank COA
  IF v_pv.payment_method IN ('bank_transfer', 'check', 'giro') THEN
    IF v_pv.bank_account_id IS NULL THEN
      RAISE EXCEPTION 'Bank account selection is mandatory for % payments (voucher %)', v_pv.payment_method, v_pv.voucher_number;
    END IF;

    SELECT ba.coa_id, ba.is_active, coa.is_header, upper(ba.currency)
    INTO v_bank_coa, v_bank_active, v_bank_is_header, v_bank_currency
    FROM public.bank_accounts ba
    LEFT JOIN public.chart_of_accounts coa ON coa.id = ba.coa_id
    WHERE ba.id = v_pv.bank_account_id;

    IF v_bank_coa IS NULL THEN
      RAISE EXCEPTION 'Bank account % has no linked Chart of Accounts', v_pv.bank_account_id;
    END IF;
    IF NOT COALESCE(v_bank_active, false) THEN
      RAISE EXCEPTION 'Linked bank GL account % is inactive', v_bank_coa;
    END IF;
    IF COALESCE(v_bank_is_header, false) THEN
      RAISE EXCEPTION 'Linked bank GL account % is a header account — leaf required', v_bank_coa;
    END IF;

    -- Dynamic derivation of USD bank carrying rate (as of voucher date)
    IF v_bank_currency = 'USD' THEN
      SELECT 
        CASE 
          WHEN NULLIF(SUM(jel.transaction_debit - jel.transaction_credit), 0) IS NOT NULL AND SUM(jel.transaction_debit - jel.transaction_credit) > 0 THEN 
            round(SUM(jel.debit - jel.credit) / SUM(jel.transaction_debit - jel.transaction_credit), 4)
          ELSE 
            COALESCE(
              (SELECT frl.revalued_rate
               FROM public.fx_revaluation_lines frl
               JOIN public.fx_revaluations fr ON fr.id = frl.revaluation_id
               WHERE frl.bank_account_id = v_pv.bank_account_id
                 AND fr.status = 'posted'
                 AND fr.revaluation_date <= v_pv.voucher_date
               ORDER BY fr.revaluation_date DESC, fr.created_at DESC
               LIMIT 1),
              v_rate
            )
        END
      INTO v_usd_bank_carrying_rate
      FROM public.journal_entry_lines jel
      JOIN public.journal_entries je ON je.id = jel.journal_entry_id
      WHERE jel.account_id = v_bank_coa 
        AND je.is_posted = true 
        AND NOT COALESCE(je.is_reversed, false)
        AND je.entry_date <= v_pv.voucher_date;

      v_usd_bank_carrying_rate := COALESCE(v_usd_bank_carrying_rate, v_rate);
    END IF;

  ELSIF v_pv.payment_method = 'cash' THEN
    SELECT id, is_active, is_header INTO v_bank_coa, v_bank_active, v_bank_is_header
    FROM public.chart_of_accounts
    WHERE code = '1101' AND is_active = true AND is_header = false LIMIT 1;

    IF v_bank_coa IS NULL THEN
      SELECT id, is_active, is_header INTO v_bank_coa, v_bank_active, v_bank_is_header
      FROM public.chart_of_accounts
      WHERE code = '1102' AND is_active = true AND is_header = false LIMIT 1;
    END IF;

    IF v_bank_coa IS NULL THEN
      RAISE EXCEPTION 'No active postable Cash/Petty Cash GL account found (GL 1101/1102)';
    END IF;
  ELSE
    RAISE EXCEPTION 'Unsupported payment method: % for payment voucher %', v_pv.payment_method, v_pv.voucher_number;
  END IF;

  -- Resolve Standard Chart of Accounts
  SELECT id INTO v_fx_loss_coa FROM public.chart_of_accounts WHERE code = '7300' AND is_active = true LIMIT 1;
  SELECT id INTO v_fx_gain_coa FROM public.chart_of_accounts WHERE code = '4930' AND is_active = true LIMIT 1;

  -- Resolve Debit Control Account
  IF v_party_type = 'supplier' THEN
    IF v_pv.payment_purpose = 'supplier_advance' OR v_pv.settlement_against = 'advance' THEN
      IF v_pv.coa_account_id IS NOT NULL THEN
        v_debit_coa := v_pv.coa_account_id;
      ELSE
        SELECT id INTO v_debit_coa FROM public.chart_of_accounts WHERE code = '1170' AND is_active = true AND is_header = false LIMIT 1;
      END IF;
    ELSE
      IF v_pv.coa_account_id IS NOT NULL THEN
        v_debit_coa := v_pv.coa_account_id;
      ELSE
        SELECT id INTO v_debit_coa FROM public.chart_of_accounts WHERE code = '2110' AND is_active = true AND is_header = false LIMIT 1;
      END IF;
    END IF;

    -- Compute Multi-Document Carrying Value vs Settlement Value with Carry-Forward Rate
    SELECT 
      COALESCE(SUM(va.allocated_amount), 0),
      COALESCE(SUM(va.allocated_amount * COALESCE(
        (SELECT frl.revalued_rate
         FROM public.fx_revaluation_lines frl
         JOIN public.fx_revaluations fr ON fr.id = frl.revaluation_id
         WHERE frl.purchase_invoice_id = va.purchase_invoice_id
           AND fr.status = 'posted'
           AND fr.revaluation_date <= v_pv.voucher_date
         ORDER BY fr.revaluation_date DESC, fr.created_at DESC
         LIMIT 1),
        pi.exchange_rate,
        v_rate
      )), 0)
    INTO v_alloc_usd, v_alloc_carrying_idr
    FROM public.voucher_allocations va
    JOIN public.purchase_invoices pi ON pi.id = va.purchase_invoice_id
    WHERE va.payment_voucher_id = p_pv_id;

    IF v_alloc_usd > 0 THEN
      -- AP relief is strictly at carrying IDR
      v_ap_relief_idr := v_alloc_carrying_idr + ((v_gross - v_alloc_usd) * v_rate);
      
      IF v_bank_currency = 'USD' THEN
        v_alloc_settle_idr := (v_gross * v_usd_bank_carrying_rate);
        v_bank_credit_idr := (v_actual * v_usd_bank_carrying_rate);
      ELSE
        v_alloc_settle_idr := (v_gross * v_rate);
        v_bank_credit_idr := v_actual;
      END IF;

      v_realized_fx := v_alloc_settle_idr - v_ap_relief_idr;

      IF v_realized_fx > 0 THEN
        v_fx_loss_amt := v_realized_fx;
      ELSIF v_realized_fx < 0 THEN
        v_fx_gain_amt := abs(v_realized_fx);
      END IF;
    ELSE
      -- Unallocated / Advance payment
      v_ap_relief_idr := (v_gross + v_settle_diff) * v_rate;
      v_bank_credit_idr := v_actual * (CASE WHEN v_bank_currency = 'USD' THEN v_usd_bank_carrying_rate ELSE 1 END);
      v_fx_loss_amt := 0;
      v_fx_gain_amt := 0;
    END IF;

  ELSIF v_party_type = 'customer' THEN
    IF v_pv.coa_account_id IS NOT NULL THEN
      v_debit_coa := v_pv.coa_account_id;
    ELSE
      SELECT id INTO v_debit_coa FROM public.chart_of_accounts WHERE code = '2111' AND is_active = true AND is_header = false LIMIT 1;
      IF v_debit_coa IS NULL THEN
        SELECT id INTO v_debit_coa FROM public.chart_of_accounts WHERE code = '1120' AND is_active = true AND is_header = false LIMIT 1;
      END IF;
    END IF;
    v_ap_relief_idr := (v_gross + v_settle_diff) * v_rate;
    v_bank_credit_idr := (v_actual + v_settle_diff) * v_rate;

  ELSIF v_party_type = 'employee' THEN
    IF v_pv.payment_purpose = 'salary_advance' THEN
      SELECT id INTO v_debit_coa FROM public.chart_of_accounts WHERE code = '1160' AND is_active = true AND is_header = false LIMIT 1;
    ELSE
      IF v_pv.coa_account_id IS NOT NULL THEN
        SELECT id INTO v_debit_coa FROM public.chart_of_accounts WHERE id = v_pv.coa_account_id AND is_active = true AND is_header = false;
      END IF;
      IF v_debit_coa IS NULL AND v_pv.staff_id IS NOT NULL THEN
        SELECT default_gl_account_id INTO v_debit_coa FROM public.finance_staff_master WHERE id = v_pv.staff_id;
      END IF;
      IF v_debit_coa IS NULL THEN
        SELECT id INTO v_debit_coa FROM public.chart_of_accounts WHERE code = '6100' AND is_active = true AND is_header = false LIMIT 1;
      END IF;
      IF v_debit_coa IS NULL THEN
        SELECT id INTO v_debit_coa FROM public.chart_of_accounts WHERE code = '5101' AND is_active = true AND is_header = false LIMIT 1;
      END IF;
    END IF;
    v_ap_relief_idr := (v_gross + v_settle_diff) * v_rate;
    v_bank_credit_idr := (v_actual + v_settle_diff) * v_rate;

  ELSIF v_party_type = 'director' THEN
    DECLARE
      v_dir_loan_acc uuid;
    BEGIN
      SELECT loan_account_id INTO v_dir_loan_acc FROM public.directors WHERE id = v_pv.staff_id;
      IF v_dir_loan_acc IS NOT NULL THEN
        v_debit_coa := v_dir_loan_acc;
      ELSE
        SELECT id INTO v_debit_coa FROM public.chart_of_accounts WHERE code = '2105' AND is_active = true AND is_header = false LIMIT 1;
      END IF;
    END;
    v_ap_relief_idr := v_gross * v_rate;
    v_bank_credit_idr := v_actual * v_rate;

  ELSE
    IF v_pv.coa_account_id IS NOT NULL THEN
      v_debit_coa := v_pv.coa_account_id;
    ELSE
      SELECT id INTO v_debit_coa FROM public.chart_of_accounts WHERE code = '6900' AND is_active = true AND is_header = false LIMIT 1;
    END IF;
    v_ap_relief_idr := (v_gross + v_settle_diff) * v_rate;
    v_bank_credit_idr := (v_actual + v_settle_diff) * v_rate;
  END IF;

  IF v_debit_coa IS NULL OR NOT EXISTS (
    SELECT 1 FROM public.chart_of_accounts WHERE id = v_debit_coa AND is_active = true AND is_header = false
  ) THEN
    RAISE EXCEPTION 'Debit control account could not be resolved or is inactive/header for payment voucher %', v_pv.voucher_number;
  END IF;

  -- Resolve bank charge account if any (COA 7100 or 8101)
  IF v_charge_amt > 0 THEN
    SELECT id INTO v_charge_coa FROM public.chart_of_accounts WHERE code = '7100' AND is_active = true AND is_header = false LIMIT 1;
    IF v_charge_coa IS NULL THEN
      SELECT id INTO v_charge_coa FROM public.chart_of_accounts WHERE code = '8101' AND is_active = true AND is_header = false LIMIT 1;
    END IF;
    IF v_charge_coa IS NULL THEN
      SELECT id INTO v_charge_coa FROM public.chart_of_accounts WHERE code = '6900' AND is_active = true AND is_header = false LIMIT 1;
    END IF;
  END IF;

  -- Resolve settlement difference account if any
  IF v_settle_diff > 0 THEN
    IF v_pv.adjustment_account_id IS NOT NULL THEN
      SELECT id INTO v_diff_coa FROM public.chart_of_accounts WHERE id = v_pv.adjustment_account_id AND is_active = true AND is_header = false;
    END IF;
    IF v_diff_coa IS NULL THEN
      SELECT id INTO v_diff_coa FROM public.chart_of_accounts WHERE code = '6910' AND is_active = true AND is_header = false LIMIT 1;
    END IF;
    IF v_diff_coa IS NULL THEN
      SELECT id INTO v_diff_coa FROM public.chart_of_accounts WHERE code = '6900' AND is_active = true AND is_header = false LIMIT 1;
    END IF;
  END IF;

  -- Calculate balanced totals
  v_total_debit := v_ap_relief_idr + (v_charge_amt * (CASE WHEN v_bank_currency = 'USD' THEN v_usd_bank_carrying_rate ELSE 1 END)) + v_fx_loss_amt;
  v_total_credit := v_bank_credit_idr + (v_settle_diff * v_rate) + v_fx_gain_amt;

  IF abs(v_total_debit - v_total_credit) > 0.05 THEN
    RAISE EXCEPTION 'Payment voucher journal does not balance: Debit (%) != Credit (%)', v_total_debit, v_total_credit;
  END IF;

  v_entry := public.next_journal_entry_number();

  INSERT INTO public.journal_entries(
    entry_number, entry_date, source_module, reference_id, reference_number,
    description, total_debit, total_credit, is_posted, posted_by,
    created_by, transaction_currency, functional_currency, exchange_rate
  ) VALUES (
    v_entry, v_pv.voucher_date, 'payment', v_pv.id, v_pv.voucher_number,
    'Payment Voucher (' || v_party_type || '): ' || v_pv.voucher_number,
    v_total_debit, v_total_credit, true, v_actual_poster,
    v_actual_poster, v_bank_currency, 'IDR', v_rate
  ) RETURNING id INTO v_je;

  -- Line 1: Debit AP Control Account / Expense / Advance
  -- Note: staff_id, supplier_id, and customer_id are mutually exclusive and assigned based on party_type.
  -- payee_id references finance_payees and is never populated from staff_id.
  INSERT INTO public.journal_entry_lines(
    journal_entry_id, line_number, account_id, description, debit, credit,
    transaction_currency, transaction_debit, transaction_credit, exchange_rate,
    supplier_id, customer_id, staff_id, payee_id
  ) VALUES (
    v_je, v_line, v_debit_coa,
    CASE 
      WHEN v_party_type = 'supplier' AND (v_pv.payment_purpose = 'supplier_advance' OR v_pv.settlement_against = 'advance') THEN 'Supplier Advance - '
      WHEN v_party_type = 'supplier' THEN 'Supplier Payment - '
      WHEN v_party_type = 'customer' THEN 'Customer Refund - '
      WHEN v_party_type = 'employee' AND v_pv.payment_purpose = 'salary_advance' THEN 'Staff Salary Advance - '
      WHEN v_party_type = 'employee' THEN 'Staff Payment - '
      WHEN v_party_type = 'director' THEN 'Director Loan Repayment - '
      ELSE 'Payment - '
    END || v_pv.voucher_number,
    v_ap_relief_idr, 0,
    v_invoice_currency, (v_gross + v_settle_diff), 0, v_rate,
    CASE WHEN v_party_type = 'supplier' THEN v_pv.supplier_id ELSE NULL END,
    CASE WHEN v_party_type = 'customer' THEN v_pv.customer_id ELSE NULL END,
    CASE WHEN v_party_type = 'employee' THEN v_pv.staff_id ELSE NULL END,
    NULL
  );
  v_line := v_line + 1;

  -- Line 2: Realized FX Loss (GL 7300) if any
  IF v_fx_loss_amt > 0 AND v_fx_loss_coa IS NOT NULL THEN
    INSERT INTO public.journal_entry_lines(
      journal_entry_id, line_number, account_id, description, debit, credit,
      transaction_currency, transaction_debit, transaction_credit, exchange_rate,
      supplier_id, customer_id, staff_id, payee_id
    ) VALUES (
      v_je, v_line, v_fx_loss_coa, 'Realized Foreign Exchange Loss - ' || v_pv.voucher_number,
      v_fx_loss_amt, 0, 'IDR', v_fx_loss_amt, 0, 1,
      NULL, NULL, NULL, NULL
    );
    v_line := v_line + 1;
  END IF;

  -- Line 3: Bank Charge (GL 7100 / 8101)
  IF v_charge_amt > 0 AND v_charge_coa IS NOT NULL THEN
    INSERT INTO public.journal_entry_lines(
      journal_entry_id, line_number, account_id, description, debit, credit,
      transaction_currency, transaction_debit, transaction_credit, exchange_rate,
      supplier_id, customer_id, staff_id, payee_id
    ) VALUES (
      v_je, v_line, v_charge_coa, 'Bank Charge - ' || v_pv.voucher_number,
      v_charge_amt * (CASE WHEN v_bank_currency = 'USD' THEN v_usd_bank_carrying_rate ELSE 1 END), 0,
      v_bank_currency, v_charge_amt, 0, 1,
      NULL, NULL, NULL, NULL
    );
    v_line := v_line + 1;
  END IF;

  -- Line 4: Credit Realized FX Gain (GL 4930) if any
  IF v_fx_gain_amt > 0 AND v_fx_gain_coa IS NOT NULL THEN
    INSERT INTO public.journal_entry_lines(
      journal_entry_id, line_number, account_id, description, debit, credit,
      transaction_currency, transaction_debit, transaction_credit, exchange_rate,
      supplier_id, customer_id, staff_id, payee_id
    ) VALUES (
      v_je, v_line, v_fx_gain_coa, 'Realized Foreign Exchange Gain - ' || v_pv.voucher_number,
      0, v_fx_gain_amt, 'IDR', 0, v_fx_gain_amt, 1,
      NULL, NULL, NULL, NULL
    );
    v_line := v_line + 1;
  END IF;

  -- Line 5: Credit Settlement Discount / Difference if any
  IF v_settle_diff > 0 AND v_diff_coa IS NOT NULL THEN
    INSERT INTO public.journal_entry_lines(
      journal_entry_id, line_number, account_id, description, debit, credit,
      transaction_currency, transaction_debit, transaction_credit, exchange_rate,
      supplier_id, customer_id, staff_id, payee_id
    ) VALUES (
      v_je, v_line, v_diff_coa, 'Settlement Discount / Difference - ' || v_pv.voucher_number,
      0, v_settle_diff * v_rate, v_bank_currency, 0, v_settle_diff, 1,
      NULL, NULL, NULL, NULL
    );
    v_line := v_line + 1;
  END IF;

  -- Line 6: Credit Bank / Cash
  INSERT INTO public.journal_entry_lines(
    journal_entry_id, line_number, account_id, description, debit, credit,
    transaction_currency, transaction_debit, transaction_credit, exchange_rate,
    supplier_id, customer_id, staff_id, payee_id
  ) VALUES (
    v_je, v_line, v_bank_coa, 'Bank Payment - ' || v_pv.voucher_number,
    0, v_bank_credit_idr,
    v_bank_currency, 0, v_actual, 1,
    NULL, NULL, NULL, NULL
  );

  UPDATE public.payment_vouchers SET is_posted = true, journal_entry_id = v_je WHERE id = p_pv_id;

  -- Recalculate Purchase Invoice balances and states
  IF v_party_type = 'supplier' THEN
    PERFORM public.recalculate_purchase_invoice_payment_state(va.purchase_invoice_id)
    FROM public.voucher_allocations va
    WHERE va.payment_voucher_id = p_pv_id AND va.purchase_invoice_id IS NOT NULL;
  END IF;

  -- Synchronize bank account current_balance with authoritative GL
  IF v_pv.bank_account_id IS NOT NULL THEN
    PERFORM public.sync_bank_account_balance(v_pv.bank_account_id);
  END IF;

  INSERT INTO public.audit_logs(table_name, record_id, action_type, old_values, new_values, user_id)
  VALUES('payment_vouchers', p_pv_id, 'update', jsonb_build_object('is_posted', false), jsonb_build_object('is_posted', true, 'journal_entry_id', v_je), v_actual_poster);
END;
$function$;

REVOKE ALL ON FUNCTION public.post_payment_voucher(uuid, uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.post_payment_voucher(uuid, uuid) TO authenticated, service_role;

-- 3. Update post_receipt_voucher to assign staff_id and clean party assignments
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
  v_currency := COALESCE(v_rv.currency_code, v_rv.transaction_currency, 'IDR');

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
        SELECT id INTO v_credit_account_id FROM public.chart_of_accounts WHERE code = '2111' AND is_active = true AND is_header = false LIMIT 1;
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

-- 4. Update reverse_credit_note_journal to copy staff_id as well
CREATE OR REPLACE FUNCTION public.reverse_credit_note_journal()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE
  v_je record;
  v_rev_entry text;
  v_reversal_id uuid;
  v_period_id uuid;
BEGIN
  IF (TG_OP = 'DELETE' AND OLD.status = 'approved')
     OR (TG_OP = 'UPDATE' AND OLD.status = 'approved' AND NEW.status IS DISTINCT FROM 'approved') THEN

    FOR v_je IN
      SELECT *
      FROM public.journal_entries
      WHERE source_module IN ('credit_note', 'credit_note_cogs')
        AND (reference_id = OLD.id OR id = OLD.journal_entry_id)
        AND is_posted = true
        AND NOT COALESCE(is_reversed, false)
      ORDER BY created_at ASC
    LOOP
      UPDATE public.bank_statement_lines
      SET matched_entry_id = NULL,
          reconciliation_status = 'unmatched',
          matched_at = NULL
      WHERE matched_entry_id = v_je.id;

      SELECT id INTO v_period_id
      FROM public.accounting_periods
      WHERE CURRENT_DATE BETWEEN start_date AND end_date
        AND status = 'open'
      LIMIT 1;

      IF v_period_id IS NULL THEN
        v_period_id := v_je.period_id;
      END IF;

      v_rev_entry := public.next_journal_entry_number();

      INSERT INTO public.journal_entries (
        entry_number,
        entry_date,
        period_id,
        source_module,
        reference_id,
        reference_number,
        description,
        total_debit,
        total_credit,
        is_posted,
        posted_by,
        posted_at,
        created_by,
        created_at,
        transaction_category,
        transaction_currency,
        functional_currency,
        exchange_rate,
        amounts_are_functional
      ) VALUES (
        v_rev_entry,
        CURRENT_DATE,
        v_period_id,
        v_je.source_module || '_reversal',
        OLD.id,
        'REV-' || v_je.entry_number,
        'Reversal of ' || v_je.entry_number || ': ' || COALESCE(v_je.description, ''),
        v_je.total_credit,
        v_je.total_debit,
        true,
        COALESCE(auth.uid(), v_je.posted_by),
        now(),
        COALESCE(auth.uid(), v_je.created_by),
        now(),
        v_je.transaction_category,
        v_je.transaction_currency,
        v_je.functional_currency,
        v_je.exchange_rate,
        v_je.amounts_are_functional
      ) RETURNING id INTO v_reversal_id;

      INSERT INTO public.journal_entry_lines (
        journal_entry_id,
        line_number,
        account_id,
        description,
        debit,
        credit,
        tax_code_id,
        customer_id,
        supplier_id,
        batch_id,
        transaction_currency,
        transaction_debit,
        transaction_credit,
        functional_currency,
        exchange_rate,
        sales_invoice_item_id,
        payee_id,
        staff_id
      )
      SELECT
        v_reversal_id,
        line_number,
        account_id,
        'Reversal of ' || v_je.entry_number || ' L' || line_number || ': ' || COALESCE(description, ''),
        credit,
        debit,
        tax_code_id,
        customer_id,
        supplier_id,
        batch_id,
        transaction_currency,
        transaction_credit,
        transaction_debit,
        functional_currency,
        exchange_rate,
        sales_invoice_item_id,
        payee_id,
        staff_id
      FROM public.journal_entry_lines
      WHERE journal_entry_id = v_je.id
      ORDER BY line_number;

      UPDATE public.journal_entries
      SET is_reversed = true,
          reversed_by_id = v_reversal_id
      WHERE id = v_je.id;

    END LOOP;

    IF TG_OP = 'UPDATE' AND NEW.journal_entry_id IS NOT NULL THEN
      UPDATE public.credit_notes
      SET journal_entry_id = NULL
      WHERE id = NEW.id;
    END IF;

  END IF;

  RETURN CASE WHEN TG_OP = 'DELETE' THEN OLD ELSE NEW END;
END $function$;

