-- Final Finance Stabilization, Phase 1.
--
-- Repair only the historical GL classification that is proven by an existing
-- Bank Reconciliation link. The Bank Master is the sole source of the target
-- GL (bank_accounts.coa_id). Journal identity, dates, descriptions, numbers,
-- debit/credit amounts and transaction amounts remain unchanged.

DO $$
DECLARE
  v_run_id uuid;
  v_row record;
BEGIN
  SELECT run_id INTO v_run_id
  FROM public.finance_historical_repair_summary
  ORDER BY started_at DESC
  LIMIT 1;

  IF v_run_id IS NULL THEN
    RAISE EXCEPTION 'A completed Finance historical repair run is required';
  END IF;

  FOR v_row IN
    SELECT
      b.id AS bank_line_id,
      b.matched_expense_id AS expense_id,
      b.matched_entry_id AS journal_entry_id,
      je.entry_number,
      jel.id AS journal_line_id,
      jel.account_id AS cash_coa_id,
      ba.coa_id AS bank_coa_id,
      ba.id AS bank_account_id,
      upper(ba.currency) AS bank_currency,
      CASE
        WHEN COALESCE(b.credit_amount, 0) > 0 THEN b.credit_amount
        ELSE b.debit_amount
      END AS statement_amount,
      CASE
        WHEN COALESCE(b.credit_amount, 0) > 0 THEN 'debit'
        ELSE 'credit'
      END AS journal_side
    FROM public.bank_statement_lines b
    JOIN public.bank_accounts ba
      ON ba.id = b.bank_account_id
     AND ba.coa_id IS NOT NULL
    JOIN public.chart_of_accounts bank_coa
      ON bank_coa.id = ba.coa_id
     AND bank_coa.is_active = true
     AND COALESCE(bank_coa.is_header, false) = false
    JOIN public.journal_entries je
      ON je.id = b.matched_entry_id
     AND je.is_posted = true
     AND COALESCE(je.is_reversed, false) = false
    JOIN public.journal_entry_lines jel
      ON jel.journal_entry_id = je.id
    JOIN public.chart_of_accounts cash_coa
      ON cash_coa.id = jel.account_id
     AND lower(btrim(cash_coa.name)) IN (
       'cash on hand', 'cash in hand', 'kas di tangan'
     )
     AND cash_coa.account_type = 'asset'
     AND COALESCE(cash_coa.is_header, false) = false
    WHERE b.matched_entry_id IS NOT NULL
      AND b.reconciliation_status IN ('matched', 'recorded')
      AND jel.account_id <> ba.coa_id
      -- Exactly one statement direction, on the corresponding journal side,
      -- with an exact transaction-currency amount match.
      AND (
        (
          COALESCE(b.credit_amount, 0) > 0
          AND COALESCE(b.debit_amount, 0) = 0
          AND COALESCE(NULLIF(jel.transaction_debit, 0), jel.debit) = b.credit_amount
        )
        OR
        (
          COALESCE(b.debit_amount, 0) > 0
          AND COALESCE(b.credit_amount, 0) = 0
          AND COALESCE(NULLIF(jel.transaction_credit, 0), jel.credit) = b.debit_amount
        )
      )
      -- Do not create a duplicate bank posting in the journal.
      AND NOT EXISTS (
        SELECT 1
        FROM public.journal_entry_lines existing_bank_line
        WHERE existing_bank_line.journal_entry_id = je.id
          AND existing_bank_line.account_id = ba.coa_id
      )
      -- The linked statement line must prove one and only one eligible cash
      -- line. Ambiguous split or duplicate matches remain manual exceptions.
      AND 1 = (
        SELECT count(*)
        FROM public.journal_entry_lines candidate_line
        JOIN public.chart_of_accounts candidate_cash
          ON candidate_cash.id = candidate_line.account_id
         AND lower(btrim(candidate_cash.name)) IN (
           'cash on hand', 'cash in hand', 'kas di tangan'
         )
         AND candidate_cash.account_type = 'asset'
         AND COALESCE(candidate_cash.is_header, false) = false
        WHERE candidate_line.journal_entry_id = je.id
          AND (
            (
              COALESCE(b.credit_amount, 0) > 0
              AND COALESCE(b.debit_amount, 0) = 0
              AND COALESCE(
                NULLIF(candidate_line.transaction_debit, 0),
                candidate_line.debit
              ) = b.credit_amount
            )
            OR
            (
              COALESCE(b.debit_amount, 0) > 0
              AND COALESCE(b.credit_amount, 0) = 0
              AND COALESCE(
                NULLIF(candidate_line.transaction_credit, 0),
                candidate_line.credit
              ) = b.debit_amount
            )
          )
      )
      -- A journal cannot be classified from two statement rows. This also
      -- proves that there is only one possible Bank Master GL for the line.
      AND 1 = (
        SELECT count(*)
        FROM public.bank_statement_lines linked_line
        JOIN public.bank_accounts linked_bank
          ON linked_bank.id = linked_line.bank_account_id
         AND linked_bank.coa_id IS NOT NULL
        WHERE linked_line.matched_entry_id = je.id
          AND linked_line.reconciliation_status IN ('matched', 'recorded')
      )
    ORDER BY b.transaction_date, je.entry_number, jel.line_number
    FOR UPDATE OF b, jel
  LOOP
    INSERT INTO public.finance_historical_repair_items(
      run_id, document_type, document_id, document_number, repaired_fields,
      old_metadata, new_metadata, repair_reason
    ) VALUES (
      v_run_id,
      'bank_reconciliation',
      v_row.bank_line_id,
      v_row.entry_number,
      ARRAY['journal_entry_lines.account_id'],
      jsonb_build_object(
        'journal_entry_id', v_row.journal_entry_id,
        'journal_line_id', v_row.journal_line_id,
        'account_id', v_row.cash_coa_id,
        'side', v_row.journal_side,
        'amount', v_row.statement_amount
      ),
      jsonb_build_object(
        'journal_entry_id', v_row.journal_entry_id,
        'journal_line_id', v_row.journal_line_id,
        'account_id', v_row.bank_coa_id,
        'bank_account_id', v_row.bank_account_id,
        'bank_currency', v_row.bank_currency,
        'side', v_row.journal_side,
        'amount', v_row.statement_amount
      ),
      'Unique linked Bank Reconciliation line, exact amount and direction prove replacement of Cash on Hand with bank_accounts.coa_id'
    );

    UPDATE public.journal_entry_lines
    SET account_id = v_row.bank_coa_id
    WHERE id = v_row.journal_line_id
      AND account_id = v_row.cash_coa_id;

    IF NOT FOUND THEN
      RAISE EXCEPTION 'Concurrent Finance change detected for journal line %',
        v_row.journal_line_id;
    END IF;

    INSERT INTO public.audit_logs(
      table_name, action_type, record_id, old_values, new_values, changed_fields
    ) VALUES (
      'journal_entry_lines',
      'update',
      v_row.journal_line_id,
      jsonb_build_object(
        'account_id', v_row.cash_coa_id,
        'journal_entry_id', v_row.journal_entry_id
      ),
      jsonb_build_object(
        'account_id', v_row.bank_coa_id,
        'journal_entry_id', v_row.journal_entry_id,
        'bank_account_id', v_row.bank_account_id
      ),
      ARRAY['account_id']
    );

    -- Remove only the two findings proven false by this exact repair. Other
    -- exceptions on the Expense or bank line remain available for review.
    UPDATE public.finance_historical_repair_exceptions
    SET status = 'resolved'
    WHERE run_id = v_run_id
      AND status = 'manual_review'
      AND (
        (
          document_type = 'expense'
          AND document_id = v_row.expense_id
          AND reason LIKE 'Posted expense journal does not use%'
        )
        OR
        (
          document_type = 'bank_reconciliation'
          AND document_id = v_row.bank_line_id
          AND reason LIKE 'Reconciled bank line points to an Expense journal%'
        )
      );
  END LOOP;

  -- Reconcile summary metadata against the full Finance universe. Resolved
  -- exceptions are intentionally absent from the new Exception Report.
  UPDATE public.finance_historical_repair_runs r
  SET records_repaired = (
        SELECT count(DISTINCT (i.document_type, i.document_id))
        FROM public.finance_historical_repair_items i
        WHERE i.run_id = r.id
          AND NOT EXISTS (
            SELECT 1
            FROM public.finance_historical_repair_exceptions e
            WHERE e.run_id = r.id
              AND e.document_type = i.document_type
              AND e.document_id = i.document_id
              AND e.status = 'manual_review'
          )
      ),
      records_partially_repaired = (
        SELECT count(DISTINCT (i.document_type, i.document_id))
        FROM public.finance_historical_repair_items i
        WHERE i.run_id = r.id
          AND EXISTS (
            SELECT 1
            FROM public.finance_historical_repair_exceptions e
            WHERE e.run_id = r.id
              AND e.document_type = i.document_type
              AND e.document_id = i.document_id
              AND e.status = 'manual_review'
          )
      ),
      records_manual_review = (
        SELECT count(DISTINCT (e.document_type, e.document_id))
        FROM public.finance_historical_repair_exceptions e
        WHERE e.run_id = r.id AND e.status = 'manual_review'
      ),
      records_skipped = (
        SELECT count(*)
        FROM (
          SELECT 'expense'::text document_type, id document_id FROM public.finance_expenses
          UNION ALL SELECT 'receipt', id FROM public.receipt_vouchers
          UNION ALL SELECT 'payment', id FROM public.payment_vouchers
          UNION ALL SELECT 'fund_transfer', id FROM public.fund_transfers
          UNION ALL SELECT 'journal', id FROM public.journal_entries
          UNION ALL SELECT 'bank_reconciliation', id FROM public.bank_statement_lines
          UNION ALL SELECT 'loan', id FROM public.loans
          UNION ALL SELECT 'loan_repayment', id FROM public.loan_transactions
          UNION ALL SELECT 'capital_contribution', id FROM public.capital_contributions
          UNION ALL SELECT 'petty_cash', id FROM public.petty_cash_transactions
          UNION ALL SELECT 'tax_payment', id FROM public.tax_payments
          UNION ALL SELECT 'sales_invoice', id FROM public.sales_invoices
          UNION ALL SELECT 'purchase_invoice', id FROM public.purchase_invoices
        ) universe
        WHERE NOT EXISTS (
          SELECT 1 FROM public.finance_historical_repair_items i
          WHERE i.run_id = r.id
            AND i.document_type = universe.document_type
            AND i.document_id = universe.document_id
        )
        AND NOT EXISTS (
          SELECT 1 FROM public.finance_historical_repair_exceptions e
          WHERE e.run_id = r.id
            AND e.document_type = universe.document_type
            AND e.document_id = universe.document_id
            AND e.status = 'manual_review'
        )
      ),
      notes = 'Phase 1 deterministic Cash-on-Hand to Bank Master GL repair followed by full Finance verification. Accounting amounts and journal identity are immutable.'
  WHERE r.id = v_run_id;
END $$

NOTIFY pgrst, 'reload schema'
