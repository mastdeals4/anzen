/*
  Phase 4 architecture guards (not historical data repair).

  The existing auto matcher already uses the canonical settlement view, but it
  wrote only the legacy typed-FK projection on bank_statement_lines.  Manual
  linking writes bank_statement_allocations.  This wrapper preserves the
  proven matcher and makes its result use the same allocation ledger, without
  creating another journal or changing any historical row.
*/
BEGIN;

ALTER FUNCTION public.auto_match_smart() RENAME TO auto_match_smart_legacy;
REVOKE ALL ON FUNCTION public.auto_match_smart_legacy() FROM PUBLIC, anon, authenticated;

CREATE OR REPLACE FUNCTION public.auto_match_smart()
RETURNS TABLE(matched_count integer, suggested_count integer, skipped_count integer)
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp
AS $$
DECLARE
  v_result record;
  v_line record;
  v_document_type text;
  v_document_id uuid;
  v_amount numeric;
BEGIN
  PERFORM public._sec_check_finance_role();

  SELECT * INTO v_result FROM public.auto_match_smart_legacy();

  /* Materialize every automatic match in the same allocation ledger used by
     manual linking. This is idempotent and preserves split/partial rows. */
  FOR v_line IN
    SELECT b.id, b.bank_account_id, b.matched_entry_id,
           b.matched_expense_id, b.matched_receipt_id, b.matched_payment_id,
           b.matched_fund_transfer_id, b.matched_petty_cash_id,
           b.matched_tax_payment_id, b.payment_kind,
           CASE WHEN COALESCE(b.credit_amount,0) > 0
                THEN b.credit_amount ELSE b.debit_amount END AS bank_amount
      FROM public.bank_statement_lines b
     WHERE b.matched_entry_id IS NOT NULL
       AND b.reconciliation_status = 'matched'
       AND NOT EXISTS (
         SELECT 1 FROM public.bank_statement_allocations a
          WHERE a.bank_statement_line_id=b.id
       )
  LOOP
    v_document_type := CASE
      WHEN v_line.matched_expense_id IS NOT NULL THEN 'expense'
      WHEN v_line.matched_receipt_id IS NOT NULL THEN 'receipt'
      WHEN v_line.matched_payment_id IS NOT NULL THEN 'payment'
      WHEN v_line.matched_fund_transfer_id IS NOT NULL THEN 'fund_transfer'
      WHEN v_line.matched_petty_cash_id IS NOT NULL THEN 'petty_cash'
      WHEN v_line.matched_tax_payment_id IS NOT NULL THEN 'tax_payment'
      ELSE NULL END;
    v_document_id := COALESCE(v_line.matched_expense_id, v_line.matched_receipt_id,
      v_line.matched_payment_id, v_line.matched_fund_transfer_id,
      v_line.matched_petty_cash_id, v_line.matched_tax_payment_id);
    IF v_document_type IS NULL OR v_document_id IS NULL OR v_line.bank_amount IS NULL THEN
      CONTINUE;
    END IF;

    INSERT INTO public.bank_statement_allocations(
      bank_statement_line_id, document_type, document_id, journal_entry_id,
      allocation_amount, payment_kind, created_by
    ) VALUES (
      v_line.id, v_document_type, v_document_id, v_line.matched_entry_id,
      round(abs(v_line.bank_amount),2), COALESCE(v_line.payment_kind,'supplier'), auth.uid()
    ) ON CONFLICT (bank_statement_line_id, document_type, document_id, payment_kind)
      DO NOTHING;
  END LOOP;

  RETURN QUERY SELECT v_result.matched_count, v_result.suggested_count, v_result.skipped_count;
END;
$$;

COMMENT ON FUNCTION public.auto_match_smart() IS
  'Canonical idempotent auto matcher: settlement-view matching plus allocation-ledger materialization. Historical rows are not repaired.';

REVOKE ALL ON FUNCTION public.auto_match_smart() FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.auto_match_smart() TO authenticated, service_role;

NOTIFY pgrst, 'reload schema';
COMMIT;
