BEGIN;

-- Count meaningful shared words without relying on fuzzy amount matching.
-- Document numbers are handled separately as the highest-confidence signal.
CREATE OR REPLACE FUNCTION public.finance_bank_match_text_score(
  p_bank_text text,
  p_document_text text
)
RETURNS integer
LANGUAGE sql
IMMUTABLE
SET search_path = public, pg_temp
AS $$
  SELECT count(*)::integer
  FROM (
    SELECT DISTINCT token
    FROM unnest(tsvector_to_array(to_tsvector('simple', lower(COALESCE(p_document_text, ''))))) AS token
    WHERE length(token) >= 4
      AND token !~ '^[0-9]+$'
      AND token NOT IN (
        'bank', 'transfer', 'payment', 'paid', 'expense', 'expenses',
        'invoice', 'general', 'admin', 'amount', 'charge', 'charges'
      )
  ) document_tokens
  WHERE token = ANY (
    tsvector_to_array(to_tsvector('simple', lower(COALESCE(p_bank_text, ''))))
  );
$$;

-- The row trigger cannot create a canonical allocation before its parent bank
-- line exists. Leave new rows unmatched; the post-insert auto_match_smart RPC
-- performs the locked, allocation-backed match immediately after every import.
-- This also removes the old amount/date-only typed-FK matching path.
CREATE OR REPLACE FUNCTION public.auto_match_bank_statement_line()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
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
  RETURN NEW;
END;
$$;

CREATE OR REPLACE FUNCTION public.auto_match_smart()
RETURNS TABLE(matched_count integer, suggested_count integer, skipped_count integer)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_line public.bank_statement_lines%ROWTYPE;
  v_bank_amount numeric;
  v_direction text;
  v_bank_text text;
  v_candidates jsonb;
  v_candidate jsonb;
  v_candidate_count integer;
  v_expense public.finance_expenses%ROWTYPE;
  v_payload jsonb;
  v_matched integer := 0;
  v_suggested integer := 0;
  v_skipped integer := 0;
BEGIN
  PERFORM public._sec_check_finance_role();

  FOR v_line IN
    SELECT b.*
    FROM public.bank_statement_lines b
    WHERE b.reconciliation_status = 'unmatched'
      AND NOT COALESCE(b.manually_unlinked, false)
      AND b.matched_expense_id IS NULL
      AND b.matched_receipt_id IS NULL
      AND b.matched_payment_id IS NULL
      AND b.matched_petty_cash_id IS NULL
      AND b.matched_fund_transfer_id IS NULL
      AND b.matched_tax_payment_id IS NULL
      AND b.matched_entry_id IS NULL
      AND NOT EXISTS (
        SELECT 1 FROM public.bank_statement_allocations a
        WHERE a.bank_statement_line_id = b.id
      )
    ORDER BY b.transaction_date, b.id
    FOR UPDATE SKIP LOCKED
  LOOP
    v_bank_amount := CASE
      WHEN COALESCE(v_line.credit_amount, 0) > 0 THEN v_line.credit_amount
      ELSE v_line.debit_amount
    END;
    v_direction := CASE
      WHEN COALESCE(v_line.credit_amount, 0) > 0 THEN 'credit'
      ELSE 'debit'
    END;
    v_bank_text := concat_ws(' ', v_line.reference, v_line.description);

    IF COALESCE(v_bank_amount, 0) <= 0.01 THEN
      v_skipped := v_skipped + 1;
      CONTINUE;
    END IF;

    -- First resolve documents which already have the authoritative bank leg:
    -- expenses, posted payment vouchers (including AP/Purchase allocations),
    -- receipts/sales, fund transfers, petty cash and tax payments all enter
    -- through vw_finance_document_settlements.
    WITH source_candidates AS MATERIALIZED (
      SELECT s.*,
             GREATEST(
               s.settlement_amount - COALESCE((
                 SELECT sum(a.allocation_amount)
                 FROM public.bank_statement_allocations a
                 WHERE a.document_type = s.document_type
                   AND a.document_id = s.document_id
                   AND a.journal_entry_id = s.journal_entry_id
               ), 0),
               0
             ) AS remaining_amount,
             concat_ws(
               ' ', s.document_number, je.reference_number, je.description,
               (SELECT string_agg(l.description, ' ' ORDER BY l.line_number)
                FROM public.journal_entry_lines l
                WHERE l.journal_entry_id = s.journal_entry_id)
             ) AS document_text
      FROM public.vw_finance_document_settlements s
      JOIN public.journal_entries je ON je.id = s.journal_entry_id
      WHERE s.bank_account_id = v_line.bank_account_id
        AND s.direction = v_direction
        AND abs(v_line.transaction_date - s.settlement_date) <= 7
    ), scored AS MATERIALIZED (
      SELECT c.*,
             public.finance_bank_match_text_score(v_bank_text, c.document_text) AS text_score,
             CASE
               WHEN length(regexp_replace(lower(COALESCE(c.document_number, '')), '[^a-z0-9]+', '', 'g')) >= 5
                AND position(
                  regexp_replace(lower(c.document_number), '[^a-z0-9]+', '', 'g')
                  IN regexp_replace(lower(v_bank_text), '[^a-z0-9]+', '', 'g')
                ) > 0 THEN 1
               WHEN public.finance_bank_match_text_score(v_bank_text, c.document_text) >= 2 THEN 2
               WHEN public.finance_bank_match_text_score(v_bank_text, c.document_text) >= 1
                AND v_line.transaction_date = c.settlement_date THEN 3
               ELSE NULL
             END AS match_tier
      FROM source_candidates c
      WHERE abs(c.remaining_amount - v_bank_amount) <= 1
    ), best AS (
      SELECT s.*
      FROM scored s
      WHERE s.match_tier IS NOT NULL
        AND s.match_tier = (SELECT min(match_tier) FROM scored WHERE match_tier IS NOT NULL)
    )
    SELECT COALESCE(jsonb_agg(to_jsonb(best) ORDER BY match_tier, settlement_date, document_type, document_id), '[]'::jsonb)
    INTO v_candidates
    FROM best;

    v_candidate_count := jsonb_array_length(v_candidates);
    IF v_candidate_count = 1 THEN
      v_candidate := v_candidates->0;
      BEGIN
        PERFORM public.link_bank_statement_line(
          v_line.id,
          v_candidate->>'document_type',
          (v_candidate->>'document_id')::uuid,
          'supplier',
          v_bank_amount
        );
        UPDATE public.bank_statement_lines
        SET notes = 'Canonical auto-match: existing bank journal; tier '
                    || (v_candidate->>'match_tier')
                    || ', text score ' || (v_candidate->>'text_score'),
            manually_unlinked = false
        WHERE id = v_line.id;
        v_matched := v_matched + 1;
        CONTINUE;
      EXCEPTION WHEN OTHERS THEN
        -- The subtransaction rolls back every attempted allocation/update for
        -- this line. Other independent lines may still be considered.
        v_skipped := v_skipped + 1;
        CONTINUE;
      END;
    ELSIF v_candidate_count > 1 THEN
      -- Equal-strength candidates are deliberately left fully unmatched.
      v_skipped := v_skipped + 1;
      CONTINUE;
    END IF;

    -- A directly-recorded approved Expense can initially be an AP posting
    -- because no bank line was selected on entry. Only reclassify that same
    -- journal to the selected bank when a unique, exact remaining amount also
    -- has business-text evidence. The existing approved-expense atomic edit
    -- command preserves the journal identity and creates the allocation.
    IF v_direction = 'debit' THEN
      WITH expense_candidates AS MATERIALIZED (
        SELECT fe.id AS document_id,
               fe.voucher_number AS document_number,
               fe.expense_date AS settlement_date,
               je.id AS journal_entry_id,
               public.calculate_finance_expense_payable(fe.id)
                 - COALESCE(fe.paid_amount, 0) AS remaining_amount,
               concat_ws(
                 ' ', fe.voucher_number, fe.invoice_number, fe.payment_reference,
                 fe.description, ic.container_ref, supplier.company_name,
                 staff.full_name, je.reference_number,
                 je.description,
                 (SELECT string_agg(l.description, ' ' ORDER BY l.line_number)
                  FROM public.journal_entry_lines l
                  WHERE l.journal_entry_id = je.id)
               ) AS document_text
        FROM public.finance_expenses fe
        LEFT JOIN public.import_containers ic ON ic.id = fe.import_container_id
        LEFT JOIN public.suppliers supplier ON supplier.id = fe.supplier_id
        LEFT JOIN public.finance_staff_master staff ON staff.id = fe.staff_id
        JOIN LATERAL (
          SELECT j.*
          FROM public.journal_entries j
          WHERE j.source_module IN ('expense', 'expenses')
            AND (j.reference_id = fe.id OR j.reference_number = 'EXP-' || fe.id::text)
            AND j.is_posted
            AND NOT COALESCE(j.is_reversed, false)
          ORDER BY j.created_at DESC, j.id DESC
          LIMIT 1
        ) je ON true
        WHERE fe.approval_status = 'approved'
          AND fe.payment_method IS NULL
          AND fe.bank_account_id IS NULL
          AND COALESCE(fe.paid_amount, 0) <= 0.01
          AND COALESCE(fe.pph_paid_amount, 0) <= 0.01
          AND abs(v_line.transaction_date - fe.expense_date) <= 7
          AND NOT EXISTS (
            SELECT 1 FROM public.voucher_allocations va
            WHERE va.finance_expense_id = fe.id
          )
          AND NOT EXISTS (
            SELECT 1 FROM public.bank_statement_allocations a
            WHERE a.document_type = 'expense' AND a.document_id = fe.id
          )
      ), scored AS MATERIALIZED (
        SELECT c.*,
               public.finance_bank_match_text_score(v_bank_text, c.document_text) AS text_score,
               CASE
                 WHEN length(regexp_replace(lower(COALESCE(c.document_number, '')), '[^a-z0-9]+', '', 'g')) >= 5
                  AND position(
                    regexp_replace(lower(c.document_number), '[^a-z0-9]+', '', 'g')
                    IN regexp_replace(lower(v_bank_text), '[^a-z0-9]+', '', 'g')
                  ) > 0 THEN 1
                 WHEN public.finance_bank_match_text_score(v_bank_text, c.document_text) >= 2 THEN 2
                 WHEN public.finance_bank_match_text_score(v_bank_text, c.document_text) >= 1
                  AND v_line.transaction_date = c.settlement_date THEN 3
                 ELSE NULL
               END AS match_tier
        FROM expense_candidates c
        WHERE abs(c.remaining_amount - v_bank_amount) <= 1
      ), best AS (
        SELECT s.*
        FROM scored s
        WHERE s.match_tier IS NOT NULL
          AND s.match_tier = (SELECT min(match_tier) FROM scored WHERE match_tier IS NOT NULL)
      )
      SELECT COALESCE(jsonb_agg(to_jsonb(best) ORDER BY match_tier, settlement_date, document_id), '[]'::jsonb)
      INTO v_candidates
      FROM best;

      v_candidate_count := jsonb_array_length(v_candidates);
      IF v_candidate_count = 1 THEN
        v_candidate := v_candidates->0;
        SELECT * INTO v_expense
        FROM public.finance_expenses
        WHERE id = (v_candidate->>'document_id')::uuid
        FOR UPDATE;

        v_payload := to_jsonb(v_expense) || jsonb_build_object(
          'payment_method', 'bank_transfer',
          'bank_account_id', v_line.bank_account_id,
          'paid_by', 'bank',
          'payment_reference', COALESCE(NULLIF(v_line.reference, ''), v_expense.payment_reference),
          'transaction_currency', upper(COALESCE(v_line.currency, v_expense.transaction_currency, 'IDR')),
          'currency_code', upper(COALESCE(v_line.currency, v_expense.currency_code, 'IDR')),
          'functional_currency', 'IDR',
          'exchange_rate', CASE
            WHEN upper(COALESCE(v_line.currency, v_expense.transaction_currency, 'IDR')) = 'IDR' THEN 1
            ELSE v_expense.exchange_rate
          END
        );

        BEGIN
          PERFORM public.edit_approved_finance_expense_atomic(
            v_expense.id,
            v_payload,
            v_line.id,
            v_bank_amount
          );
          UPDATE public.bank_statement_lines
          SET notes = 'Canonical auto-match: unique existing Expense; tier '
                      || (v_candidate->>'match_tier')
                      || ', text score ' || (v_candidate->>'text_score'),
              manually_unlinked = false
          WHERE id = v_line.id;
          v_matched := v_matched + 1;
        EXCEPTION WHEN OTHERS THEN
          v_skipped := v_skipped + 1;
        END;
      ELSIF v_candidate_count > 1 THEN
        v_skipped := v_skipped + 1;
      END IF;
    END IF;
  END LOOP;

  RETURN QUERY SELECT v_matched, v_suggested, v_skipped;
END;
$$;

COMMENT ON FUNCTION public.auto_match_smart() IS
  'Canonical atomic matcher: unique bank-journal documents first; unique exact directly-recorded Expenses only with date/account/direction and business-text evidence. Ambiguity remains unmatched.';

REVOKE ALL ON FUNCTION public.finance_bank_match_text_score(text, text) FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.auto_match_bank_statement_line() FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.auto_match_smart() FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.finance_bank_match_text_score(text, text) TO service_role;
GRANT EXECUTE ON FUNCTION public.auto_match_bank_statement_line() TO authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.auto_match_smart() TO authenticated, service_role;

NOTIFY pgrst, 'reload schema';
COMMIT;
