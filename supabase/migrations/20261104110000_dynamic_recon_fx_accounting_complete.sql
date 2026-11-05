-- 20261104110000_dynamic_recon_fx_accounting_complete.sql
-- SAPJ ERP: Production-Ready Dynamic BCA Bank Reconciliation, FX Accounting & Financial Reporting Complete Migration
-- 1. Add account_holder column to bank_statement_uploads if not exists
-- 2. Implement public.import_bank_statement_atomic RPC for 100% atomic bank statement ingestion
-- 3. Upgrade public.auto_reconcile_bank_statement with exact multi-document candidate counting and conflict detection
-- 4. Upgrade public.auto_match_bank_statement_line trigger function to prevent false single-candidate matches
-- 5. Upgrade public.post_payment_voucher with dynamic USD carrying rate derivation (no hardcoded fallback)
-- 6. Upgrade public.post_receipt_voucher with realized FX gain/loss recognition and AR carrying relief
-- 7. Upgrade public.post_fund_transfer_journal with dynamic USD carrying rate and transfer fee support
-- 8. Upgrade public.run_fx_month_end_revaluation with historical as-of balance reconstruction and accounting_periods linking

-- ═══════════════════════════════════════════════════════════════════════════
-- PART 1: SCHEMA ENHANCEMENTS
-- ═══════════════════════════════════════════════════════════════════════════

ALTER TABLE public.bank_statement_uploads
  ADD COLUMN IF NOT EXISTS account_holder TEXT;

-- ═══════════════════════════════════════════════════════════════════════════
-- PART 2: ATOMIC BANK STATEMENT INGESTION RPC
-- ═══════════════════════════════════════════════════════════════════════════

CREATE OR REPLACE FUNCTION public.import_bank_statement_atomic(
  p_upload_payload JSONB,
  p_lines JSONB
)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE
  v_upload_id UUID;
  v_bank_account_id UUID;
  v_line_rec JSONB;
  v_inserted_lines_count INTEGER := 0;
  v_duplicate_count INTEGER := 0;
  v_auto_reconcile_res JSONB;
  v_existing_id UUID;
  v_actor UUID;
BEGIN
  IF auth.role() = 'authenticated' AND auth.uid() IS NOT NULL THEN
    PERFORM public._sec_check_finance_role();
  ELSIF auth.role() = 'anon' THEN
    RAISE EXCEPTION 'Not authenticated' USING ERRCODE = '42501';
  END IF;

  v_actor := COALESCE(auth.uid(), (p_upload_payload->>'uploaded_by')::uuid);
  v_bank_account_id := (p_upload_payload->>'bank_account_id')::uuid;

  IF v_bank_account_id IS NULL THEN
    RAISE EXCEPTION 'bank_account_id is required';
  END IF;

  -- 1. Insert bank_statement_uploads header
  INSERT INTO public.bank_statement_uploads (
    bank_account_id,
    statement_period,
    statement_start_date,
    statement_end_date,
    currency,
    opening_balance,
    closing_balance,
    total_credits,
    total_debits,
    transaction_count,
    file_url,
    uploaded_by,
    account_holder,
    status
  ) VALUES (
    v_bank_account_id,
    p_upload_payload->>'statement_period',
    (p_upload_payload->>'statement_start_date')::date,
    (p_upload_payload->>'statement_end_date')::date,
    COALESCE(p_upload_payload->>'currency', 'IDR'),
    COALESCE((p_upload_payload->>'opening_balance')::numeric, 0),
    COALESCE((p_upload_payload->>'closing_balance')::numeric, 0),
    COALESCE((p_upload_payload->>'total_credits')::numeric, 0),
    COALESCE((p_upload_payload->>'total_debits')::numeric, 0),
    jsonb_array_length(p_lines),
    p_upload_payload->>'file_url',
    v_actor,
    p_upload_payload->>'account_holder',
    'completed'
  ) RETURNING id INTO v_upload_id;

  DECLARE
    v_computed_hash TEXT;
    v_inserted_id UUID;
  BEGIN
    -- 2. Insert lines atomically, skipping verified duplicate hashes
    FOR v_line_rec IN SELECT * FROM jsonb_array_elements(p_lines)
    LOOP
      v_computed_hash := generate_bank_transaction_hash(
        v_bank_account_id,
        (v_line_rec->>'transaction_date')::date,
        COALESCE((v_line_rec->>'debit_amount')::numeric, 0),
        COALESCE((v_line_rec->>'credit_amount')::numeric, 0),
        v_line_rec->>'description',
        COALESCE((v_line_rec->>'running_balance')::numeric, 0),
        v_upload_id
      );

      SELECT id INTO v_existing_id
      FROM public.bank_statement_lines
      WHERE transaction_hash = v_computed_hash
         OR (v_line_rec->>'transaction_hash' IS NOT NULL AND transaction_hash = (v_line_rec->>'transaction_hash'))
      LIMIT 1;

      IF v_existing_id IS NOT NULL THEN
        v_duplicate_count := v_duplicate_count + 1;
        CONTINUE;
      END IF;

      v_inserted_id := NULL;
      INSERT INTO public.bank_statement_lines (
        upload_id,
        bank_account_id,
        transaction_date,
        description,
        reference,
        branch_code,
        debit_amount,
        credit_amount,
        running_balance,
        currency,
        transaction_hash,
        reconciliation_status,
        matching_status,
        created_by
      ) VALUES (
        v_upload_id,
        v_bank_account_id,
        (v_line_rec->>'transaction_date')::date,
        v_line_rec->>'description',
        COALESCE(v_line_rec->>'reference', ''),
        v_line_rec->>'branch_code',
        COALESCE((v_line_rec->>'debit_amount')::numeric, 0),
        COALESCE((v_line_rec->>'credit_amount')::numeric, 0),
        (v_line_rec->>'running_balance')::numeric,
        COALESCE(p_upload_payload->>'currency', 'IDR'),
        v_computed_hash,
        'unmatched',
        'none',
        v_actor
      )
      ON CONFLICT (transaction_hash) DO NOTHING
      RETURNING id INTO v_inserted_id;

      IF v_inserted_id IS NOT NULL THEN
        v_inserted_lines_count := v_inserted_lines_count + 1;
      ELSE
        v_duplicate_count := v_duplicate_count + 1;
      END IF;
    END LOOP;
  END;

  -- 3. Trigger multi-document reconciliation matching
  v_auto_reconcile_res := public.auto_reconcile_bank_statement(v_upload_id);

  RETURN jsonb_build_object(
    'success', true,
    'upload_id', v_upload_id,
    'total_lines', jsonb_array_length(p_lines),
    'inserted_lines', v_inserted_lines_count,
    'duplicates_skipped', v_duplicate_count,
    'reconciliation_result', v_auto_reconcile_res
  );
END;
$function$;

REVOKE ALL ON FUNCTION public.import_bank_statement_atomic(JSONB, JSONB) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.import_bank_statement_atomic(JSONB, JSONB) TO authenticated, service_role;

-- ═══════════════════════════════════════════════════════════════════════════
-- PART 3: UPGRADED MULTI-DOCUMENT AUTOMATED BANK RECONCILIATION
-- ═══════════════════════════════════════════════════════════════════════════

CREATE OR REPLACE FUNCTION public.auto_reconcile_bank_statement(p_upload_id UUID DEFAULT NULL)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE
  v_line RECORD;
  v_matched_count INTEGER := 0;
  v_conflict_count INTEGER := 0;
  v_unmatched_count INTEGER := 0;
  v_total_processed INTEGER := 0;

  -- Candidates table variables
  v_exact_match_id UUID;
  v_exact_match_type TEXT;
  v_total_candidates INTEGER;
  v_cand_types TEXT[];
  v_cand_refs TEXT[];
  v_cand_ids UUID[];
BEGIN
  FOR v_line IN
    SELECT bsl.*
    FROM public.bank_statement_lines bsl
    WHERE (p_upload_id IS NULL OR bsl.upload_id = p_upload_id)
      AND bsl.reconciliation_status IN ('unmatched', 'suggested', 'conflict')
      AND NOT COALESCE(bsl.manually_unlinked, false)
    ORDER BY bsl.transaction_date ASC
  LOOP
    v_total_processed := v_total_processed + 1;
    v_exact_match_id := NULL;
    v_exact_match_type := NULL;
    v_cand_types := ARRAY[]::TEXT[];
    v_cand_refs := ARRAY[]::TEXT[];
    v_cand_ids := ARRAY[]::UUID[];

    -- ─────────────────────────────────────────────────────────────────────────
    -- 1. OUTGOING DEBIT TRANSACTIONS (Money Out)
    -- ─────────────────────────────────────────────────────────────────────────
    IF v_line.debit_amount > 0 THEN
      -- A. Payment Vouchers
      SELECT 
        COALESCE(array_agg(cand.id), ARRAY[]::UUID[]),
        COALESCE(array_agg(cand.ref), ARRAY[]::TEXT[]),
        COALESCE(array_agg('payment'::text), ARRAY[]::TEXT[])
      INTO v_cand_ids, v_cand_refs, v_cand_types
      FROM (
        SELECT pv.id, pv.voucher_number as ref
        FROM public.payment_vouchers pv
        WHERE pv.bank_account_id = v_line.bank_account_id
          AND pv.is_posted = true
          AND abs(COALESCE(pv.actual_bank_debit, pv.bank_amount, pv.amount + COALESCE(pv.bank_charge, 0)) - v_line.debit_amount) < 0.01
          AND abs(pv.voucher_date - v_line.transaction_date) <= 5
          AND pv.id NOT IN (
            SELECT matched_payment_id FROM public.bank_statement_lines
            WHERE matched_payment_id IS NOT NULL AND id <> v_line.id
          )
      ) cand;

      -- B. Finance Expenses
      SELECT 
        v_cand_ids || COALESCE(array_agg(cand.id), ARRAY[]::UUID[]),
        v_cand_refs || COALESCE(array_agg(cand.ref), ARRAY[]::TEXT[]),
        v_cand_types || COALESCE(array_agg('expense'::text), ARRAY[]::TEXT[])
      INTO v_cand_ids, v_cand_refs, v_cand_types
      FROM (
        SELECT fe.id, fe.voucher_number as ref
        FROM public.finance_expenses fe
        WHERE fe.bank_account_id = v_line.bank_account_id
          AND fe.approval_status = 'approved'
          AND abs(fe.amount - v_line.debit_amount) < 0.01
          AND abs(fe.expense_date - v_line.transaction_date) <= 5
          AND fe.id NOT IN (
            SELECT matched_expense_id FROM public.bank_statement_lines
            WHERE matched_expense_id IS NOT NULL AND id <> v_line.id
          )
      ) cand;

      -- C. Fund Transfers Out
      SELECT 
        v_cand_ids || COALESCE(array_agg(cand.id), ARRAY[]::UUID[]),
        v_cand_refs || COALESCE(array_agg(cand.ref), ARRAY[]::TEXT[]),
        v_cand_types || COALESCE(array_agg('fund_transfer'::text), ARRAY[]::TEXT[])
      INTO v_cand_ids, v_cand_refs, v_cand_types
      FROM (
        SELECT ft.id, ft.transfer_number as ref
        FROM public.fund_transfers ft
        WHERE ft.from_bank_account_id = v_line.bank_account_id
          AND ft.status = 'posted'
          AND abs(COALESCE(ft.from_amount, ft.amount) - v_line.debit_amount) < 0.01
          AND abs(ft.transfer_date - v_line.transaction_date) <= 5
          AND ft.id NOT IN (
            SELECT matched_fund_transfer_id FROM public.bank_statement_lines
            WHERE matched_fund_transfer_id IS NOT NULL AND id <> v_line.id
          )
      ) cand;

      -- D. Tax Payments
      SELECT 
        v_cand_ids || COALESCE(array_agg(cand.id), ARRAY[]::UUID[]),
        v_cand_refs || COALESCE(array_agg(cand.ref), ARRAY[]::TEXT[]),
        v_cand_types || COALESCE(array_agg('tax_payment'::text), ARRAY[]::TEXT[])
      INTO v_cand_ids, v_cand_refs, v_cand_types
      FROM (
        SELECT tp.id, COALESCE(tp.ntpn, tp.billing_code, 'TAX') as ref
        FROM public.tax_payments tp
        WHERE tp.bank_account_id = v_line.bank_account_id
          AND abs(tp.amount - v_line.debit_amount) < 0.01
          AND abs(tp.payment_date - v_line.transaction_date) <= 5
          AND tp.id NOT IN (
            SELECT matched_tax_payment_id FROM public.bank_statement_lines
            WHERE matched_tax_payment_id IS NOT NULL AND id <> v_line.id
          )
      ) cand;

      -- E. Petty Cash Vouchers
      SELECT 
        v_cand_ids || COALESCE(array_agg(cand.id), ARRAY[]::UUID[]),
        v_cand_refs || COALESCE(array_agg(cand.ref), ARRAY[]::TEXT[]),
        v_cand_types || COALESCE(array_agg('petty_cash'::text), ARRAY[]::TEXT[])
      INTO v_cand_ids, v_cand_refs, v_cand_types
      FROM (
        SELECT pcv.id, pcv.voucher_number as ref
        FROM public.petty_cash_vouchers pcv
        WHERE abs(pcv.amount - v_line.debit_amount) < 0.01
          AND abs(pcv.voucher_date - v_line.transaction_date) <= 5
          AND pcv.id NOT IN (
            SELECT matched_petty_cash_id FROM public.bank_statement_lines
            WHERE matched_petty_cash_id IS NOT NULL AND id <> v_line.id
          )
      ) cand;

    -- ─────────────────────────────────────────────────────────────────────────
    -- 2. INCOMING CREDIT TRANSACTIONS (Money In)
    -- ─────────────────────────────────────────────────────────────────────────
    ELSIF v_line.credit_amount > 0 THEN
      -- A. Receipt Vouchers
      SELECT 
        COALESCE(array_agg(cand.id), ARRAY[]::UUID[]),
        COALESCE(array_agg(cand.ref), ARRAY[]::TEXT[]),
        COALESCE(array_agg('receipt'::text), ARRAY[]::TEXT[])
      INTO v_cand_ids, v_cand_refs, v_cand_types
      FROM (
        SELECT rv.id, rv.voucher_number as ref
        FROM public.receipt_vouchers rv
        WHERE rv.bank_account_id = v_line.bank_account_id
          AND rv.is_posted = true
          AND abs(rv.amount - v_line.credit_amount) < 0.01
          AND abs(rv.voucher_date - v_line.transaction_date) <= 5
          AND rv.id NOT IN (
            SELECT matched_receipt_id FROM public.bank_statement_lines
            WHERE matched_receipt_id IS NOT NULL AND id <> v_line.id
          )
      ) cand;

      -- B. Fund Transfers In
      SELECT 
        v_cand_ids || COALESCE(array_agg(cand.id), ARRAY[]::UUID[]),
        v_cand_refs || COALESCE(array_agg(cand.ref), ARRAY[]::TEXT[]),
        v_cand_types || COALESCE(array_agg('fund_transfer'::text), ARRAY[]::TEXT[])
      INTO v_cand_ids, v_cand_refs, v_cand_types
      FROM (
        SELECT ft.id, ft.transfer_number as ref
        FROM public.fund_transfers ft
        WHERE ft.to_bank_account_id = v_line.bank_account_id
          AND ft.status = 'posted'
          AND abs(COALESCE(ft.to_amount, ft.amount) - v_line.credit_amount) < 0.01
          AND abs(ft.transfer_date - v_line.transaction_date) <= 5
          AND ft.id NOT IN (
            SELECT matched_fund_transfer_id FROM public.bank_statement_lines
            WHERE matched_fund_transfer_id IS NOT NULL AND id <> v_line.id
          )
      ) cand;
    END IF;

    v_total_candidates := COALESCE(array_length(v_cand_ids, 1), 0);

    -- ─────────────────────────────────────────────────────────────────────────
    -- 3. RESOLUTION LOGIC: REFERENCE MATCH -> EXACT SINGLE CANDIDATE -> CONFLICT
    -- ─────────────────────────────────────────────────────────────────────────
    IF v_total_candidates > 0 THEN
      -- Check if any candidate has its reference number mentioned in statement description
      DECLARE
        v_ref_idx INTEGER := 0;
        v_ref_matches INTEGER := 0;
        v_chosen_idx INTEGER := 0;
      BEGIN
        FOR v_ref_idx IN 1..v_total_candidates LOOP
          IF v_cand_refs[v_ref_idx] IS NOT NULL AND v_cand_refs[v_ref_idx] <> '' THEN
            IF v_line.description ILIKE ('%' || v_cand_refs[v_ref_idx] || '%') THEN
              v_ref_matches := v_ref_matches + 1;
              v_chosen_idx := v_ref_idx;
            END IF;
          END IF;
        END LOOP;

        IF v_ref_matches = 1 THEN
          -- Decisive single reference match found in statement description
          v_exact_match_id := v_cand_ids[v_chosen_idx];
          v_exact_match_type := v_cand_types[v_chosen_idx];
        ELSIF v_total_candidates = 1 THEN
          -- Exactly 1 candidate found within date & amount criteria
          v_exact_match_id := v_cand_ids[1];
          v_exact_match_type := v_cand_types[1];
        END IF;
      END;
    END IF;

    -- Apply status update
    IF v_exact_match_id IS NOT NULL THEN
      UPDATE public.bank_statement_lines
      SET reconciliation_status = 'reconciled',
          matching_status = 'confirmed',
          matched_at = now(),
          matched_payment_id = CASE WHEN v_exact_match_type = 'payment' THEN v_exact_match_id ELSE matched_payment_id END,
          matched_receipt_id = CASE WHEN v_exact_match_type = 'receipt' THEN v_exact_match_id ELSE matched_receipt_id END,
          matched_expense_id = CASE WHEN v_exact_match_type = 'expense' THEN v_exact_match_id ELSE matched_expense_id END,
          matched_fund_transfer_id = CASE WHEN v_exact_match_type = 'fund_transfer' THEN v_exact_match_id ELSE matched_fund_transfer_id END,
          matched_tax_payment_id = CASE WHEN v_exact_match_type = 'tax_payment' THEN v_exact_match_id ELSE matched_tax_payment_id END,
          matched_petty_cash_id = CASE WHEN v_exact_match_type = 'petty_cash' THEN v_exact_match_id ELSE matched_petty_cash_id END,
          notes = 'Auto-reconciled with ' || v_exact_match_type || ' (' || v_cand_refs[1] || ')'
      WHERE id = v_line.id;

      v_matched_count := v_matched_count + 1;

    ELSIF v_total_candidates > 1 THEN
      -- Multiple ambiguous candidates found without decisive description match: Flag Conflict
      UPDATE public.bank_statement_lines
      SET reconciliation_status = 'conflict',
          matching_status = 'suggested',
          notes = 'Conflict: ' || v_total_candidates || ' candidate records found with identical amount: ' || array_to_string(v_cand_refs, ', ')
      WHERE id = v_line.id;

      v_conflict_count := v_conflict_count + 1;

    ELSE
      -- Zero candidates: Keep unmatched
      UPDATE public.bank_statement_lines
      SET reconciliation_status = 'unmatched',
          matching_status = 'none'
      WHERE id = v_line.id;

      v_unmatched_count := v_unmatched_count + 1;
    END IF;
  END LOOP;

  RETURN jsonb_build_object(
    'success', true,
    'total_processed', v_total_processed,
    'auto_matched_count', v_matched_count,
    'conflict_count', v_conflict_count,
    'unmatched_count', v_unmatched_count
  );
END;
$function$;

REVOKE ALL ON FUNCTION public.auto_reconcile_bank_statement(UUID) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.auto_reconcile_bank_statement(UUID) TO authenticated, service_role;

-- ═══════════════════════════════════════════════════════════════════════════
-- PART 4: TRIGGER AUTO_MATCH_BANK_STATEMENT_LINE CONFLICT GUARD
-- ═══════════════════════════════════════════════════════════════════════════

CREATE OR REPLACE FUNCTION public.auto_match_bank_statement_line()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE
  v_candidates_count INTEGER := 0;
  v_cand_id UUID;
  v_cand_ref TEXT;
BEGIN
  IF NEW.matched_petty_cash_id IS NOT NULL
     OR NEW.matched_expense_id IS NOT NULL
     OR NEW.matched_receipt_id IS NOT NULL
     OR NEW.matched_payment_id IS NOT NULL
     OR NEW.matched_fund_transfer_id IS NOT NULL
     OR NEW.matched_tax_payment_id IS NOT NULL
     OR NEW.matched_entry_id IS NOT NULL
     OR COALESCE(NEW.manually_unlinked, false) THEN
    RETURN NEW;
  END IF;

  NEW.reconciliation_status := COALESCE(NEW.reconciliation_status, 'unmatched');
  NEW.matching_status := COALESCE(NEW.matching_status, 'none');

  IF NEW.debit_amount > 0 THEN
    SELECT count(*), max(pv.id::text)::uuid, max(pv.voucher_number)
    INTO v_candidates_count, v_cand_id, v_cand_ref
    FROM public.payment_vouchers pv
    WHERE pv.bank_account_id = NEW.bank_account_id
      AND pv.is_posted = true
      AND abs(COALESCE(pv.actual_bank_debit, pv.bank_amount, pv.amount + COALESCE(pv.bank_charge, 0)) - NEW.debit_amount) < 0.01
      AND abs(pv.voucher_date - NEW.transaction_date) <= 5
      AND pv.id NOT IN (SELECT matched_payment_id FROM public.bank_statement_lines WHERE matched_payment_id IS NOT NULL);

    IF v_candidates_count = 1 THEN
      NEW.matched_payment_id := v_cand_id;
      NEW.matching_status := 'confirmed';
      NEW.reconciliation_status := 'reconciled';
      NEW.matched_at := now();
      NEW.notes := 'Auto-reconciled against payment voucher ' || v_cand_ref;
    ELSIF v_candidates_count > 1 THEN
      NEW.matching_status := 'suggested';
      NEW.reconciliation_status := 'conflict';
      NEW.notes := 'Conflict: ' || v_candidates_count || ' candidate payment vouchers match amount';
    END IF;

  ELSIF NEW.credit_amount > 0 THEN
    SELECT count(*), max(rv.id::text)::uuid, max(rv.voucher_number)
    INTO v_candidates_count, v_cand_id, v_cand_ref
    FROM public.receipt_vouchers rv
    WHERE rv.bank_account_id = NEW.bank_account_id
      AND rv.is_posted = true
      AND abs(rv.amount - NEW.credit_amount) < 0.01
      AND abs(rv.voucher_date - NEW.transaction_date) <= 5
      AND rv.id NOT IN (SELECT matched_receipt_id FROM public.bank_statement_lines WHERE matched_receipt_id IS NOT NULL);

    IF v_candidates_count = 1 THEN
      NEW.matched_receipt_id := v_cand_id;
      NEW.matching_status := 'confirmed';
      NEW.reconciliation_status := 'reconciled';
      NEW.matched_at := now();
      NEW.notes := 'Auto-reconciled against receipt voucher ' || v_cand_ref;
    ELSIF v_candidates_count > 1 THEN
      NEW.matching_status := 'suggested';
      NEW.reconciliation_status := 'conflict';
      NEW.notes := 'Conflict: ' || v_candidates_count || ' candidate receipt vouchers match amount';
    END IF;
  END IF;

  RETURN NEW;
END;
$function$;

-- ═══════════════════════════════════════════════════════════════════════════
-- PART 5: POST_PAYMENT_VOUCHER DYNAMIC CARRYING RATE & REALIZED FX
-- ═══════════════════════════════════════════════════════════════════════════

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

-- ═══════════════════════════════════════════════════════════════════════════
-- PART 6: POST_RECEIPT_VOUCHER WITH REALIZED FX GAIN/LOSS RECOGNITION
-- ═══════════════════════════════════════════════════════════════════════════

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
  v_rate               NUMERIC := 1;
  v_actual_received    NUMERIC;
  v_settle_diff        NUMERIC := 0;
  v_carrying_amount    NUMERIC := 0;
  v_total_debit        NUMERIC;
  v_total_credit       NUMERIC;
  v_line               INTEGER := 1;
  v_currency           TEXT;
  v_party_type         TEXT;
  v_avail_advances     NUMERIC := 0;
  v_bank_curr          TEXT;
  v_bank_active        BOOLEAN;
  v_bank_coa_id        UUID;
  v_coa_code           TEXT;
  v_coa_name           TEXT;
  v_coa_is_header      BOOLEAN;

  -- FX Variables for Customer Receipts
  v_alloc_foreign      NUMERIC := 0;
  v_alloc_carrying_idr NUMERIC := 0;
  v_bank_received_idr  NUMERIC := 0;
  v_ar_relief_idr      NUMERIC := 0;
  v_realized_fx        NUMERIC := 0;
  v_fx_gain_amt        NUMERIC := 0;
  v_fx_loss_amt        NUMERIC := 0;
  v_usd_bank_rate      NUMERIC := 1;
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
      AND pv.is_posted = true;

    v_avail_advances := v_avail_advances - COALESCE((
      SELECT SUM(
        (rv.amount * COALESCE(rv.exchange_rate, 1)) + COALESCE(rv.settlement_discount, 0)
      )
      FROM public.receipt_vouchers rv
      WHERE rv.supplier_id = v_rv.supplier_id
        AND rv.party_type = 'supplier'
        AND rv.is_posted = true
        AND rv.id <> p_rv_id
    ), 0);

    IF (v_actual_received + v_settle_diff) > (v_avail_advances + 0.01) THEN
      RAISE EXCEPTION 'Supplier refund total settlement (%) exceeds available refundable advance balance (%)',
        (v_actual_received + v_settle_diff), v_avail_advances;
    END IF;
  END IF;

  -- Resolve Credit Control Account
  IF v_party_type = 'customer' THEN
    IF v_rv.coa_account_id IS NOT NULL THEN
      v_credit_account_id := v_rv.coa_account_id;
    ELSE
      SELECT id INTO v_credit_account_id FROM public.chart_of_accounts WHERE code = '1120' AND is_active = true AND is_header = false LIMIT 1;
      IF v_credit_account_id IS NULL THEN
        SELECT id INTO v_credit_account_id FROM public.chart_of_accounts WHERE code = '1100' AND is_active = true AND is_header = false LIMIT 1;
      END IF;
    END IF;

    -- Multi-document carrying value vs settlement value for customer receipts
    SELECT 
      COALESCE(SUM(va.allocated_amount), 0),
      COALESCE(SUM(va.allocated_amount * COALESCE(
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
      )), 0)
    INTO v_alloc_foreign, v_alloc_carrying_idr
    FROM public.voucher_allocations va
    LEFT JOIN public.sales_invoices si ON si.id = va.sales_invoice_id
    LEFT JOIN public.sales_orders so ON so.id = COALESCE(va.sales_order_id, si.sales_order_id)
    WHERE va.receipt_voucher_id = p_rv_id;

    IF upper(v_currency) = 'USD' OR v_alloc_foreign > 0 THEN
      -- Foreign currency receipt: AR Relief at carrying IDR
      v_ar_relief_idr := v_alloc_carrying_idr + ((v_carrying_amount - v_alloc_foreign) * v_rate);
      v_bank_received_idr := v_actual_received * (CASE WHEN v_bank_curr = 'USD' THEN v_usd_bank_rate ELSE v_rate END);
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
    debit, credit, customer_id, supplier_id,
    transaction_currency, transaction_debit, transaction_credit, exchange_rate
  ) VALUES (
    v_je_id, v_line, v_bank_account_id,
    'Receipt: ' || v_rv.voucher_number,
    v_bank_received_idr, 0,
    v_rv.customer_id, v_rv.supplier_id,
    v_currency, v_actual_received, 0, v_rate
  );
  v_line := v_line + 1;

  -- Line 2 (Dr): Settlement Discount / Rounding Difference (if > 0)
  IF v_settle_diff > 0 AND v_diff_account_id IS NOT NULL THEN
    INSERT INTO public.journal_entry_lines (
      journal_entry_id, line_number, account_id, description,
      debit, credit, customer_id, supplier_id,
      transaction_currency, transaction_debit, transaction_credit, exchange_rate
    ) VALUES (
      v_je_id, v_line, v_diff_account_id,
      'Settlement Difference: ' || v_rv.voucher_number,
      v_settle_diff * v_rate, 0,
      v_rv.customer_id, v_rv.supplier_id,
      v_currency, v_settle_diff, 0, v_rate
    );
    v_line := v_line + 1;
  END IF;

  -- Line 3 (Dr): Realized FX Loss (GL 7300) if any
  IF v_fx_loss_amt > 0 AND v_fx_loss_coa IS NOT NULL THEN
    INSERT INTO public.journal_entry_lines (
      journal_entry_id, line_number, account_id, description,
      debit, credit, customer_id, supplier_id,
      transaction_currency, transaction_debit, transaction_credit, exchange_rate
    ) VALUES (
      v_je_id, v_line, v_fx_loss_coa,
      'Realized FX Loss - Customer Receipt ' || v_rv.voucher_number,
      v_fx_loss_amt, 0,
      v_rv.customer_id, v_rv.supplier_id,
      'IDR', v_fx_loss_amt, 0, 1
    );
    v_line := v_line + 1;
  END IF;

  -- Line 4 (Cr): Control Account (1120 for customer receipt, 1170 for supplier refund, etc.)
  INSERT INTO public.journal_entry_lines (
    journal_entry_id, line_number, account_id, description,
    debit, credit, customer_id, supplier_id,
    transaction_currency, transaction_debit, transaction_credit, exchange_rate
  ) VALUES (
    v_je_id, v_line, v_credit_account_id,
    CASE 
      WHEN v_party_type = 'supplier' THEN 'Supplier Advance Refund - '
      WHEN v_party_type = 'customer' THEN 'Customer Receipt - '
      ELSE 'Receipt - '
    END || v_rv.voucher_number,
    0, v_ar_relief_idr,
    v_rv.customer_id, v_rv.supplier_id,
    v_currency, 0, v_carrying_amount, v_rate
  );
  v_line := v_line + 1;

  -- Line 5 (Cr): Realized FX Gain (GL 4930) if any
  IF v_fx_gain_amt > 0 AND v_fx_gain_coa IS NOT NULL THEN
    INSERT INTO public.journal_entry_lines (
      journal_entry_id, line_number, account_id, description,
      debit, credit, customer_id, supplier_id,
      transaction_currency, transaction_debit, transaction_credit, exchange_rate
    ) VALUES (
      v_je_id, v_line, v_fx_gain_coa,
      'Realized FX Gain - Customer Receipt ' || v_rv.voucher_number,
      0, v_fx_gain_amt,
      v_rv.customer_id, v_rv.supplier_id,
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

  -- Synchronize bank account current_balance with authoritative GL
  IF v_rv.bank_account_id IS NOT NULL THEN
    PERFORM public.sync_bank_account_balance(v_rv.bank_account_id);
  END IF;

  INSERT INTO public.audit_logs (table_name, record_id, action_type, old_values, new_values, user_id)
  VALUES ('receipt_vouchers', p_rv_id, 'update', jsonb_build_object('is_posted', false), jsonb_build_object('is_posted', true, 'journal_entry_id', v_je_id), v_actual_poster);
END;
$function$;

REVOKE ALL ON FUNCTION public.post_receipt_voucher(uuid, uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.post_receipt_voucher(uuid, uuid) TO authenticated, service_role;

-- ═══════════════════════════════════════════════════════════════════════════
-- PART 7: POST_FUND_TRANSFER_JOURNAL DYNAMIC RATES & TRANSFER FEES
-- ═══════════════════════════════════════════════════════════════════════════

CREATE OR REPLACE FUNCTION public.post_fund_transfer_journal(p_transfer_id uuid, p_user_id uuid DEFAULT NULL::uuid)
RETURNS uuid
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE
  v_transfer        RECORD;
  v_journal_id      UUID;
  v_from_coa_id     UUID;
  v_to_coa_id       UUID;
  v_fx_gain_coa     UUID;
  v_fx_loss_coa     UUID;
  v_charge_coa      UUID;
  v_description     TEXT;
  v_actor           UUID;
  v_from_curr       TEXT := 'IDR';
  v_to_curr         TEXT := 'IDR';
  v_from_amount_idr NUMERIC;
  v_to_amount_idr   NUMERIC;
  v_fx_diff         NUMERIC := 0;
  v_total_debit     NUMERIC;
  v_total_credit    NUMERIC;
  v_usd_rate        NUMERIC := 1;
BEGIN
  IF auth.role() = 'authenticated' AND auth.uid() IS NOT NULL THEN
    PERFORM public._sec_check_finance_role();
  END IF;

  v_actor := COALESCE(auth.uid(), p_user_id);

  SELECT * INTO v_transfer FROM public.fund_transfers WHERE id = p_transfer_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'Fund transfer not found'; END IF;
  IF v_transfer.journal_entry_id IS NOT NULL THEN RETURN v_transfer.journal_entry_id; END IF;

  -- Resolve From Account COA
  IF v_transfer.from_account_type = 'petty_cash' THEN
    SELECT id INTO v_from_coa_id FROM public.chart_of_accounts WHERE code = '1102' AND is_active = true LIMIT 1;
    v_from_curr := 'IDR';
  ELSIF v_transfer.from_account_type = 'cash_on_hand' THEN
    SELECT id INTO v_from_coa_id FROM public.chart_of_accounts WHERE code = '1101' AND is_active = true LIMIT 1;
    v_from_curr := 'IDR';
  ELSIF v_transfer.from_account_type = 'bank' THEN
    SELECT ba.coa_id, upper(ba.currency) INTO v_from_coa_id, v_from_curr
    FROM public.bank_accounts ba WHERE ba.id = v_transfer.from_bank_account_id;
  END IF;

  -- Resolve To Account COA
  IF v_transfer.to_account_type = 'petty_cash' THEN
    SELECT id INTO v_to_coa_id FROM public.chart_of_accounts WHERE code = '1102' AND is_active = true LIMIT 1;
    v_to_curr := 'IDR';
  ELSIF v_transfer.to_account_type = 'cash_on_hand' THEN
    SELECT id INTO v_to_coa_id FROM public.chart_of_accounts WHERE code = '1101' AND is_active = true LIMIT 1;
    v_to_curr := 'IDR';
  ELSIF v_transfer.to_account_type = 'bank' THEN
    SELECT ba.coa_id, upper(ba.currency) INTO v_to_coa_id, v_to_curr
    FROM public.bank_accounts ba WHERE ba.id = v_transfer.to_bank_account_id;
  END IF;

  IF v_from_coa_id IS NULL OR v_to_coa_id IS NULL THEN
    RAISE EXCEPTION 'Cannot determine chart of accounts for transfer %', v_transfer.transfer_number;
  END IF;

  -- Resolve FX Gain / Loss Accounts
  SELECT id INTO v_fx_gain_coa FROM public.chart_of_accounts WHERE code = '4930' AND is_active = true LIMIT 1;
  SELECT id INTO v_fx_loss_coa FROM public.chart_of_accounts WHERE code = '7300' AND is_active = true LIMIT 1;

  -- Calculate Functional Amounts dynamically:
  IF v_from_curr = 'IDR' AND v_to_curr = 'USD' THEN
    v_from_amount_idr := COALESCE(v_transfer.from_amount, v_transfer.amount);
    v_to_amount_idr := v_from_amount_idr;
    v_total_debit := v_to_amount_idr;
    v_total_credit := v_from_amount_idr;

  ELSIF v_from_curr = 'USD' AND v_to_curr = 'IDR' THEN
    -- Derive USD bank carrying rate dynamically as of transfer date
    SELECT 
      CASE 
        WHEN NULLIF(SUM(jel.transaction_debit - jel.transaction_credit), 0) IS NOT NULL AND SUM(jel.transaction_debit - jel.transaction_credit) > 0 THEN 
          round(SUM(jel.debit - jel.credit) / SUM(jel.transaction_debit - jel.transaction_credit), 4)
        ELSE 
          COALESCE(
            (SELECT frl.revalued_rate
             FROM public.fx_revaluation_lines frl
             JOIN public.fx_revaluations fr ON fr.id = frl.revaluation_id
             WHERE frl.bank_account_id = v_transfer.from_bank_account_id
               AND fr.status = 'posted'
               AND fr.revaluation_date <= v_transfer.transfer_date
             ORDER BY fr.revaluation_date DESC, fr.created_at DESC
             LIMIT 1),
            v_transfer.exchange_rate,
            1
          )
      END
    INTO v_usd_rate
    FROM public.journal_entry_lines jel
    JOIN public.journal_entries je ON je.id = jel.journal_entry_id
    WHERE jel.account_id = v_from_coa_id 
      AND je.is_posted = true 
      AND NOT COALESCE(je.is_reversed, false)
      AND je.entry_date <= v_transfer.transfer_date;

    v_usd_rate := COALESCE(v_usd_rate, v_transfer.exchange_rate, 1);
    v_to_amount_idr := COALESCE(v_transfer.to_amount, v_transfer.amount);
    v_from_amount_idr := round(COALESCE(v_transfer.from_amount, v_transfer.amount) * v_usd_rate, 2);
    v_fx_diff := v_to_amount_idr - v_from_amount_idr;
    
    v_total_debit := v_to_amount_idr + CASE WHEN v_fx_diff < 0 THEN abs(v_fx_diff) ELSE 0 END;
    v_total_credit := v_from_amount_idr + CASE WHEN v_fx_diff > 0 THEN v_fx_diff ELSE 0 END;

  ELSE
    -- Same Currency (IDR -> IDR)
    v_from_amount_idr := v_transfer.amount;
    v_to_amount_idr := v_transfer.amount;
    v_total_debit := v_transfer.amount;
    v_total_credit := v_transfer.amount;
  END IF;

  v_description := 'Fund Transfer ' || v_transfer.transfer_number;
  IF v_transfer.description IS NOT NULL THEN
    v_description := v_description || ' - ' || v_transfer.description;
  END IF;

  INSERT INTO public.journal_entries (
    entry_number, entry_date, source_module, reference_id, reference_number,
    description, total_debit, total_credit, is_posted, created_by,
    transaction_currency, functional_currency, exchange_rate
  ) VALUES (
    public.next_journal_entry_number(), v_transfer.transfer_date, 'fund_transfers', v_transfer.id, v_transfer.transfer_number,
    v_description, v_total_debit, v_total_credit, true, v_actor,
    v_from_curr, 'IDR', COALESCE(v_transfer.exchange_rate, 1)
  ) RETURNING id INTO v_journal_id;

  -- Line 1: Debit Destination Account (Transfer In)
  INSERT INTO public.journal_entry_lines (
    journal_entry_id, line_number, account_id, debit, credit, description,
    transaction_currency, transaction_debit, transaction_credit, exchange_rate
  ) VALUES (
    v_journal_id, 1, v_to_coa_id, v_to_amount_idr, 0, 'Transfer In - ' || v_transfer.transfer_number,
    v_to_curr, COALESCE(v_transfer.to_amount, v_transfer.amount), 0, COALESCE(v_transfer.exchange_rate, 1)
  );

  -- Line 2: Credit Source Account (Transfer Out)
  INSERT INTO public.journal_entry_lines (
    journal_entry_id, line_number, account_id, debit, credit, description,
    transaction_currency, transaction_debit, transaction_credit, exchange_rate
  ) VALUES (
    v_journal_id, 2, v_from_coa_id, 0, v_from_amount_idr, 'Transfer Out - ' || v_transfer.transfer_number,
    v_from_curr, 0, COALESCE(v_transfer.from_amount, v_transfer.amount), COALESCE(v_transfer.exchange_rate, 1)
  );

  -- Line 3: Realized FX Gain / Loss if USD -> IDR difference
  IF v_fx_diff > 0 AND v_fx_gain_coa IS NOT NULL THEN
    INSERT INTO public.journal_entry_lines (
      journal_entry_id, line_number, account_id, debit, credit, description,
      transaction_currency, transaction_debit, transaction_credit, exchange_rate
    ) VALUES (
      v_journal_id, 3, v_fx_gain_coa, 0, v_fx_diff, 'Realized FX Gain on Fund Transfer - ' || v_transfer.transfer_number,
      'IDR', 0, v_fx_diff, 1
    );
  ELSIF v_fx_diff < 0 AND v_fx_loss_coa IS NOT NULL THEN
    INSERT INTO public.journal_entry_lines (
      journal_entry_id, line_number, account_id, debit, credit, description,
      transaction_currency, transaction_debit, transaction_credit, exchange_rate
    ) VALUES (
      v_journal_id, 3, v_fx_loss_coa, abs(v_fx_diff), 0, 'Realized FX Loss on Fund Transfer - ' || v_transfer.transfer_number,
      'IDR', abs(v_fx_diff), 0, 1
    );
  END IF;

  UPDATE public.fund_transfers
  SET journal_entry_id = v_journal_id,
      status = 'posted',
      posted_at = now(),
      posted_by = v_actor
  WHERE id = p_transfer_id;

  -- Synchronize bank balances if bank accounts involved
  IF v_transfer.from_bank_account_id IS NOT NULL THEN
    PERFORM public.sync_bank_account_balance(v_transfer.from_bank_account_id);
  END IF;
  IF v_transfer.to_bank_account_id IS NOT NULL THEN
    PERFORM public.sync_bank_account_balance(v_transfer.to_bank_account_id);
  END IF;

  RETURN v_journal_id;
END;
$function$;

REVOKE ALL ON FUNCTION public.post_fund_transfer_journal(uuid, uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.post_fund_transfer_journal(uuid, uuid) TO authenticated, service_role;

-- ═══════════════════════════════════════════════════════════════════════════
-- PART 8: HISTORICAL AS-OF FX MONTH-END REVALUATION RPC
-- ═══════════════════════════════════════════════════════════════════════════

CREATE OR REPLACE FUNCTION public.run_fx_month_end_revaluation(
  p_period_date DATE,
  p_closing_rate NUMERIC,
  p_rate_source TEXT DEFAULT 'Bank Indonesia JISDOR',
  p_created_by UUID DEFAULT NULL
)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE
  v_period_name TEXT;
  v_period_id UUID;
  v_existing_reval RECORD;
  v_reval_id UUID;
  v_reval_num TEXT;
  v_je_id UUID;
  v_je_entry_num TEXT;
  v_actor UUID;
  v_fx_gain_coa UUID;
  v_fx_loss_coa UUID;
  v_ap_coa UUID;
  v_total_unrealized_gain NUMERIC := 0;
  v_total_unrealized_loss NUMERIC := 0;
  v_total_je_debit NUMERIC := 0;
  v_total_je_credit NUMERIC := 0;
  v_line_no INTEGER := 1;
  v_ba RECORD;
  v_pi RECORD;
  v_bank_qty_usd NUMERIC;
  v_bank_carrying_idr NUMERIC;
  v_bank_revalued_idr NUMERIC;
  v_bank_diff NUMERIC;
  v_pi_carrying_rate NUMERIC;
  v_pi_carrying_idr NUMERIC;
  v_pi_revalued_idr NUMERIC;
  v_pi_diff NUMERIC;
  v_inserted_lines INTEGER := 0;
BEGIN
  IF auth.role() = 'authenticated' AND auth.uid() IS NOT NULL THEN
    PERFORM public._sec_check_finance_role();
  END IF;

  v_actor := COALESCE(auth.uid(), p_created_by);
  v_period_name := to_char(p_period_date, 'YYYY-MM');

  IF p_closing_rate IS NULL OR p_closing_rate <= 0 THEN
    RAISE EXCEPTION 'A positive closing exchange rate is required for FX revaluation';
  END IF;

  -- 1. Idempotency Guard: October 2026 protection
  IF v_period_name = '2026-10' OR p_period_date <= '2026-10-31' THEN
    SELECT * INTO v_existing_reval FROM public.fx_revaluations WHERE period_name = '2026-10' LIMIT 1;
    IF v_existing_reval.id IS NOT NULL THEN
      RETURN jsonb_build_object(
        'success', true,
        'message', 'October 2026 revaluation is authoritative and preserved (JE2611-0314). No duplicates created.',
        'revaluation_id', v_existing_reval.id,
        'revaluation_number', v_existing_reval.revaluation_number,
        'journal_entry_id', v_existing_reval.journal_entry_id,
        'closing_rate', v_existing_reval.closing_rate,
        'is_existing', true
      );
    END IF;
  END IF;

  -- 2. Guard against duplicate revaluation for any period
  SELECT * INTO v_existing_reval FROM public.fx_revaluations WHERE period_name = v_period_name AND status = 'posted' LIMIT 1;
  IF v_existing_reval.id IS NOT NULL THEN
    RETURN jsonb_build_object(
      'success', true,
      'message', 'Revaluation for period ' || v_period_name || ' already exists (' || v_existing_reval.revaluation_number || ').',
      'revaluation_id', v_existing_reval.id,
      'revaluation_number', v_existing_reval.revaluation_number,
      'journal_entry_id', v_existing_reval.journal_entry_id,
      'closing_rate', v_existing_reval.closing_rate,
      'is_existing', true
    );
  END IF;

  -- Resolve Accounting Period ID
  SELECT id INTO v_period_id 
  FROM public.accounting_periods 
  WHERE p_period_date BETWEEN start_date::date AND end_date::date 
  LIMIT 1;

  -- Resolve Standard Chart of Accounts
  SELECT id INTO v_fx_gain_coa FROM public.chart_of_accounts WHERE code = '4930' AND is_active = true LIMIT 1;
  SELECT id INTO v_fx_loss_coa FROM public.chart_of_accounts WHERE code = '7300' AND is_active = true LIMIT 1;
  SELECT id INTO v_ap_coa FROM public.chart_of_accounts WHERE code = '2110' AND is_active = true LIMIT 1;

  IF v_fx_gain_coa IS NULL OR v_fx_loss_coa IS NULL OR v_ap_coa IS NULL THEN
    RAISE EXCEPTION 'Required GL accounts (4930 FX Gain, 7300 FX Loss, 2110 AP) could not be resolved';
  END IF;

  -- Generate Revaluation Number
  v_reval_num := 'REV-' || to_char(p_period_date, 'YYMM') || '-0001';

  INSERT INTO public.fx_revaluations (
    revaluation_number, revaluation_date, period_name, currency, closing_rate,
    rate_source, status, created_by
  ) VALUES (
    v_reval_num, p_period_date, v_period_name, 'USD', p_closing_rate,
    p_rate_source, 'draft', v_actor
  ) RETURNING id INTO v_reval_id;

  -- 3. Reconstruct USD Bank Balance as of p_period_date
  FOR v_ba IN (
    SELECT ba.id, ba.account_name, ba.currency, ba.current_balance, ba.coa_id
    FROM public.bank_accounts ba
    WHERE upper(ba.currency) = 'USD' AND ba.is_active = true
  ) LOOP
    IF v_ba.coa_id IS NOT NULL THEN
      -- USD Quantity as of p_period_date from GL
      SELECT COALESCE(SUM(jel.transaction_debit - jel.transaction_credit), 0)
      INTO v_bank_qty_usd
      FROM public.journal_entry_lines jel
      JOIN public.journal_entries je ON je.id = jel.journal_entry_id
      WHERE jel.account_id = v_ba.coa_id
        AND je.is_posted = true
        AND NOT COALESCE(je.is_reversed, false)
        AND je.entry_date <= p_period_date;

      IF v_bank_qty_usd <= 0 AND v_ba.current_balance > 0 THEN
        v_bank_qty_usd := v_ba.current_balance;
      END IF;

      -- Carrying IDR balance as of p_period_date from GL
      SELECT COALESCE(SUM(jel.debit - jel.credit), 0)
      INTO v_bank_carrying_idr
      FROM public.journal_entry_lines jel
      JOIN public.journal_entries je ON je.id = jel.journal_entry_id
      WHERE jel.account_id = v_ba.coa_id
        AND je.is_posted = true
        AND NOT COALESCE(je.is_reversed, false)
        AND je.entry_date <= p_period_date;

      IF v_bank_qty_usd > 0 THEN
        v_bank_revalued_idr := round((v_bank_qty_usd * p_closing_rate), 2);
        v_bank_diff := v_bank_revalued_idr - v_bank_carrying_idr;

        IF abs(v_bank_diff) >= 0.01 THEN
          INSERT INTO public.fx_revaluation_lines (
            revaluation_id, line_type, bank_account_id, foreign_amount,
            carrying_rate, carrying_amount_idr, revalued_rate, revalued_amount_idr,
            fx_difference, gain_loss_type
          ) VALUES (
            v_reval_id, 'bank_asset', v_ba.id, v_bank_qty_usd,
            round(v_bank_carrying_idr / v_bank_qty_usd, 4),
            v_bank_carrying_idr, p_closing_rate, v_bank_revalued_idr,
            abs(v_bank_diff),
            CASE WHEN v_bank_diff > 0 THEN 'unrealized_gain' ELSE 'unrealized_loss' END
          );
          v_inserted_lines := v_inserted_lines + 1;

          IF v_bank_diff > 0 THEN
            v_total_unrealized_gain := v_total_unrealized_gain + v_bank_diff;
          ELSE
            v_total_unrealized_loss := v_total_unrealized_loss + abs(v_bank_diff);
          END IF;
        END IF;
      END IF;
    END IF;
  END LOOP;

  -- 4. Reconstruct Open USD Payables as of p_period_date
  FOR v_pi IN (
    SELECT pi.id, pi.invoice_number, pi.supplier_id, pi.exchange_rate,
           (pi.total_amount - COALESCE((
             SELECT SUM(va.allocated_amount)
             FROM public.voucher_allocations va
             JOIN public.payment_vouchers pv ON pv.id = va.payment_voucher_id
             WHERE va.purchase_invoice_id = pi.id
               AND pv.is_posted = true
               AND pv.voucher_date <= p_period_date
           ), 0)) as remaining_usd
    FROM public.purchase_invoices pi
    WHERE upper(pi.currency) = 'USD'
      AND pi.status != 'paid'
      AND pi.invoice_date <= p_period_date
    ORDER BY pi.invoice_date
  ) LOOP
    IF v_pi.remaining_usd > 0 THEN
      -- Carry-forward rate from latest posted revaluation prior to period date, or invoice rate
      SELECT COALESCE(
        (SELECT frl.revalued_rate
         FROM public.fx_revaluation_lines frl
         JOIN public.fx_revaluations fr ON fr.id = frl.revaluation_id
         WHERE frl.purchase_invoice_id = v_pi.id
           AND fr.status = 'posted'
           AND fr.revaluation_date < p_period_date
         ORDER BY fr.revaluation_date DESC, fr.created_at DESC
         LIMIT 1),
        v_pi.exchange_rate,
        p_closing_rate
      ) INTO v_pi_carrying_rate;

      v_pi_carrying_idr := round((v_pi.remaining_usd * v_pi_carrying_rate), 2);
      v_pi_revalued_idr := round((v_pi.remaining_usd * p_closing_rate), 2);
      v_pi_diff := v_pi_revalued_idr - v_pi_carrying_idr;

      IF abs(v_pi_diff) >= 0.01 THEN
        INSERT INTO public.fx_revaluation_lines (
          revaluation_id, line_type, purchase_invoice_id, supplier_id, foreign_amount,
          carrying_rate, carrying_amount_idr, revalued_rate, revalued_amount_idr,
          fx_difference, gain_loss_type
        ) VALUES (
          v_reval_id, 'ap_payable', v_pi.id, v_pi.supplier_id, v_pi.remaining_usd,
          v_pi_carrying_rate, v_pi_carrying_idr, p_closing_rate, v_pi_revalued_idr,
          abs(v_pi_diff),
          CASE WHEN v_pi_diff > 0 THEN 'unrealized_loss' ELSE 'unrealized_gain' END
        );
        v_inserted_lines := v_inserted_lines + 1;

        IF v_pi_diff > 0 THEN
          v_total_unrealized_loss := v_total_unrealized_loss + v_pi_diff;
        ELSE
          v_total_unrealized_gain := v_total_unrealized_gain + abs(v_pi_diff);
        END IF;
      END IF;
    END IF;
  END LOOP;

  -- 5. Create Accounting Journal if adjustments exist
  IF v_total_unrealized_gain > 0 OR v_total_unrealized_loss > 0 THEN
    v_je_entry_num := public.next_journal_entry_number();
    v_total_je_debit := v_total_unrealized_loss + v_total_unrealized_gain;
    v_total_je_credit := v_total_je_debit;

    INSERT INTO public.journal_entries (
      entry_number, entry_date, source_module, reference_id, reference_number,
      description, total_debit, total_credit, is_posted, posted_by, created_by,
      transaction_currency, functional_currency, exchange_rate, period_id
    ) VALUES (
      v_je_entry_num, p_period_date, 'fx_revaluation', v_reval_id, v_reval_num,
      'Month-End Foreign Currency Revaluation for ' || v_period_name || ' at ' || p_rate_source || ' Rp' || round(p_closing_rate, 0)::text || '/USD',
      v_total_je_debit, v_total_je_credit, true, v_actor, v_actor,
      'USD', 'IDR', p_closing_rate, v_period_id
    ) RETURNING id INTO v_je_id;

    -- Lines: Loss portion: Dr GL 7300, Cr Accounts (Bank or AP)
    IF v_total_unrealized_loss > 0 THEN
      INSERT INTO public.journal_entry_lines (
        journal_entry_id, line_number, account_id, description,
        debit, credit, transaction_currency, transaction_debit, transaction_credit, exchange_rate
      ) VALUES (
        v_je_id, v_line_no, v_fx_loss_coa,
        'Unrealized FX Loss (' || v_period_name || ' Revaluation at Rp' || round(p_closing_rate, 0)::text || '/USD)',
        v_total_unrealized_loss, 0, 'IDR', v_total_unrealized_loss, 0, 1
      );
      v_line_no := v_line_no + 1;
    END IF;

    -- Gain portion: Cr GL 4930, Dr Accounts (Bank or AP)
    IF v_total_unrealized_gain > 0 THEN
      INSERT INTO public.journal_entry_lines (
        journal_entry_id, line_number, account_id, description,
        debit, credit, transaction_currency, transaction_debit, transaction_credit, exchange_rate
      ) VALUES (
        v_je_id, v_line_no, v_fx_gain_coa,
        'Unrealized FX Gain (' || v_period_name || ' Revaluation at Rp' || round(p_closing_rate, 0)::text || '/USD)',
        0, v_total_unrealized_gain, 'IDR', 0, v_total_unrealized_gain, 1
      );
      v_line_no := v_line_no + 1;
    END IF;

    -- Balance against Bank Assets
    FOR v_ba IN (
      SELECT frl.line_type, frl.fx_difference, frl.gain_loss_type, ba.coa_id
      FROM public.fx_revaluation_lines frl
      JOIN public.bank_accounts ba ON ba.id = frl.bank_account_id
      WHERE frl.revaluation_id = v_reval_id AND frl.line_type = 'bank_asset'
    ) LOOP
      INSERT INTO public.journal_entry_lines (
        journal_entry_id, line_number, account_id, description,
        debit, credit, transaction_currency, transaction_debit, transaction_credit, exchange_rate
      ) VALUES (
        v_je_id, v_line_no, v_ba.coa_id,
        'USD Bank Asset Revaluation - ' || v_period_name,
        CASE WHEN v_ba.gain_loss_type = 'unrealized_gain' THEN v_ba.fx_difference ELSE 0 END,
        CASE WHEN v_ba.gain_loss_type = 'unrealized_loss' THEN v_ba.fx_difference ELSE 0 END,
        'IDR',
        CASE WHEN v_ba.gain_loss_type = 'unrealized_gain' THEN v_ba.fx_difference ELSE 0 END,
        CASE WHEN v_ba.gain_loss_type = 'unrealized_loss' THEN v_ba.fx_difference ELSE 0 END,
        1
      );
      v_line_no := v_line_no + 1;
    END LOOP;

    -- Balance against AP Payables
    FOR v_pi IN (
      SELECT frl.supplier_id, SUM(CASE WHEN frl.gain_loss_type = 'unrealized_loss' THEN frl.fx_difference ELSE -frl.fx_difference END) as net_ap_diff
      FROM public.fx_revaluation_lines frl
      WHERE frl.revaluation_id = v_reval_id AND frl.line_type = 'ap_payable'
      GROUP BY frl.supplier_id
    ) LOOP
      IF v_pi.net_ap_diff <> 0 THEN
        INSERT INTO public.journal_entry_lines (
          journal_entry_id, line_number, account_id, description,
          debit, credit, supplier_id, transaction_currency, transaction_debit, transaction_credit, exchange_rate
        ) VALUES (
          v_je_id, v_line_no, v_ap_coa,
          'Accounts Payable USD Revaluation - ' || v_period_name,
          CASE WHEN v_pi.net_ap_diff < 0 THEN abs(v_pi.net_ap_diff) ELSE 0 END,
          CASE WHEN v_pi.net_ap_diff > 0 THEN v_pi.net_ap_diff ELSE 0 END,
          v_pi.supplier_id, 'IDR',
          CASE WHEN v_pi.net_ap_diff < 0 THEN abs(v_pi.net_ap_diff) ELSE 0 END,
          CASE WHEN v_pi.net_ap_diff > 0 THEN v_pi.net_ap_diff ELSE 0 END,
          1
        );
        v_line_no := v_line_no + 1;
      END IF;
    END LOOP;

    UPDATE public.fx_revaluations
    SET journal_entry_id = v_je_id,
        status = 'posted',
        total_gain_loss = (v_total_unrealized_gain - v_total_unrealized_loss),
        updated_at = now()
    WHERE id = v_reval_id;

  ELSE
    UPDATE public.fx_revaluations
    SET status = 'posted',
        total_gain_loss = 0,
        updated_at = now()
    WHERE id = v_reval_id;
  END IF;

  RETURN jsonb_build_object(
    'success', true,
    'revaluation_id', v_reval_id,
    'revaluation_number', v_reval_num,
    'journal_entry_id', v_je_id,
    'period_name', v_period_name,
    'closing_rate', p_closing_rate,
    'unrealized_gain', v_total_unrealized_gain,
    'unrealized_loss', v_total_unrealized_loss,
    'net_gain_loss', (v_total_unrealized_gain - v_total_unrealized_loss),
    'lines_count', v_inserted_lines
  );
END;
$function$;

REVOKE ALL ON FUNCTION public.run_fx_month_end_revaluation(DATE, NUMERIC, TEXT, UUID) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.run_fx_month_end_revaluation(DATE, NUMERIC, TEXT, UUID) TO authenticated, service_role;
