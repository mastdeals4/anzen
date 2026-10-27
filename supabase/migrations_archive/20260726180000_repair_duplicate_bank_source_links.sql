-- Final Finance stabilization: a legacy Petty Cash projection of a Fund
-- Transfer must not remain as a second canonical source link on the same bank
-- statement line. This repair is metadata-only and runs only when every stored
-- relationship and amount proves that both links describe the same transfer.

DO $$
DECLARE
  v_row record;
  v_run_id uuid;
BEGIN
  SELECT run_id INTO v_run_id
  FROM public.finance_historical_repair_summary
  ORDER BY started_at DESC
  LIMIT 1;

  FOR v_row IN
    SELECT
      b.id AS bank_line_id,
      b.matched_petty_cash_id AS petty_cash_id,
      b.matched_fund_transfer_id AS fund_transfer_id,
      b.matched_entry_id AS journal_entry_id,
      ft.transfer_number
    FROM public.bank_statement_lines b
    JOIN public.petty_cash_transactions pc
      ON pc.id = b.matched_petty_cash_id
    JOIN public.fund_transfers ft
      ON ft.id = b.matched_fund_transfer_id
    WHERE pc.fund_transfer_id = ft.id
      AND b.matched_entry_id = ft.journal_entry_id
      AND b.bank_account_id = ft.from_bank_account_id
      AND b.debit_amount = ft.amount
      AND pc.amount = ft.amount
      AND num_nonnulls(
        b.matched_expense_id,
        b.matched_receipt_id,
        b.matched_payment_id,
        b.matched_petty_cash_id,
        b.matched_fund_transfer_id,
        b.matched_tax_payment_id
      ) = 2
  LOOP
    INSERT INTO public.finance_historical_repair_items(
      run_id, document_type, document_id, document_number, repaired_fields,
      old_metadata, new_metadata, repair_reason
    ) VALUES (
      v_run_id,
      'bank_reconciliation',
      v_row.bank_line_id,
      v_row.transfer_number,
      ARRAY['matched_petty_cash_id'],
      jsonb_build_object(
        'matched_petty_cash_id', v_row.petty_cash_id,
        'matched_fund_transfer_id', v_row.fund_transfer_id
      ),
      jsonb_build_object(
        'matched_petty_cash_id', NULL,
        'matched_fund_transfer_id', v_row.fund_transfer_id
      ),
      'Removed a redundant legacy Petty Cash projection link after the source row, Fund Transfer, journal, bank account and amounts all proved the Fund Transfer is canonical'
    );

    UPDATE public.finance_historical_repair_exceptions
    SET status = 'resolved'
    WHERE run_id = v_run_id
      AND document_type = 'bank_reconciliation'
      AND document_id = v_row.bank_line_id
      AND status = 'manual_review'
      AND reason ILIKE '%multiple typed document links%';

    UPDATE public.bank_statement_lines
    SET matched_petty_cash_id = NULL
    WHERE id = v_row.bank_line_id
      AND matched_petty_cash_id = v_row.petty_cash_id
      AND matched_fund_transfer_id = v_row.fund_transfer_id;

    INSERT INTO public.audit_logs(
      table_name, action_type, record_id, old_values, new_values, changed_fields
    ) VALUES (
      'bank_statement_lines',
      'update',
      v_row.bank_line_id,
      jsonb_build_object(
        'matched_petty_cash_id', v_row.petty_cash_id,
        'matched_fund_transfer_id', v_row.fund_transfer_id
      ),
      jsonb_build_object(
        'matched_petty_cash_id', NULL,
        'matched_fund_transfer_id', v_row.fund_transfer_id
      ),
      ARRAY['matched_petty_cash_id']
    );
  END LOOP;

  UPDATE public.finance_historical_repair_runs r
  SET records_repaired = (
        SELECT count(DISTINCT (i.document_type, i.document_id))
        FROM public.finance_historical_repair_items i
        WHERE i.run_id = r.id
      ),
      records_manual_review = (
        SELECT count(DISTINCT (e.document_type, e.document_id))
        FROM public.finance_historical_repair_exceptions e
        WHERE e.run_id = r.id AND e.status = 'manual_review'
      )
  WHERE r.id = v_run_id;
END $$
