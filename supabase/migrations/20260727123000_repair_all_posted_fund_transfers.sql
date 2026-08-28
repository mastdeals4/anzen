-- Batch audit/repair for every posted Fund Transfer.
-- The existing repair function remains the only writer. This migration adds
-- read-only eligibility checks and a summary-producing batch command.

CREATE OR REPLACE FUNCTION public.audit_fund_transfer_repair_eligibility(p_fund_transfer_id uuid)
RETURNS text
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  t public.fund_transfers%ROWTYPE;
  j public.journal_entries%ROWTYPE;
  from_coa uuid;
  to_coa uuid;
  from_currency text;
  to_currency text;
  expected_rate numeric;
  candidate_count integer;
  line_count integer;
BEGIN
  SELECT * INTO t FROM public.fund_transfers WHERE id = p_fund_transfer_id;
  IF NOT FOUND THEN RETURN 'Fund Transfer record is missing'; END IF;
  IF t.status <> 'posted' THEN RETURN 'Fund Transfer is not posted'; END IF;
  IF t.journal_entry_id IS NULL THEN RETURN 'Posted Fund Transfer has no linked journal'; END IF;

  SELECT * INTO j FROM public.journal_entries WHERE id = t.journal_entry_id;
  IF NOT FOUND OR NOT COALESCE(j.is_posted, false) OR COALESCE(j.is_reversed, false)
     THEN RETURN 'Linked journal is missing, unposted, or reversed'; END IF;
  IF j.source_module NOT IN ('fund_transfer', 'fund_transfers')
     OR j.reference_id IS DISTINCT FROM t.id
     THEN RETURN 'Journal source relationship does not prove this Fund Transfer'; END IF;

  IF t.from_account_type = 'bank' THEN
    SELECT coa_id, upper(currency) INTO from_coa, from_currency
      FROM public.bank_accounts WHERE id = t.from_bank_account_id AND is_active;
  ELSIF t.from_account_type = 'petty_cash' THEN
    SELECT id, 'IDR' INTO from_coa, from_currency FROM public.chart_of_accounts
      WHERE code = '1102' AND is_active LIMIT 1;
  ELSE
    SELECT id, 'IDR' INTO from_coa, from_currency FROM public.chart_of_accounts
      WHERE code = '1101' AND is_active LIMIT 1;
  END IF;
  IF t.to_account_type = 'bank' THEN
    SELECT coa_id, upper(currency) INTO to_coa, to_currency
      FROM public.bank_accounts WHERE id = t.to_bank_account_id AND is_active;
  ELSIF t.to_account_type = 'petty_cash' THEN
    SELECT id, 'IDR' INTO to_coa, to_currency FROM public.chart_of_accounts
      WHERE code = '1102' AND is_active LIMIT 1;
  ELSE
    SELECT id, 'IDR' INTO to_coa, to_currency FROM public.chart_of_accounts
      WHERE code = '1101' AND is_active LIMIT 1;
  END IF;
  IF from_coa IS NULL OR to_coa IS NULL OR from_currency IS NULL OR to_currency IS NULL
     THEN RETURN 'Fund Transfer account or currency cannot be derived'; END IF;
  IF t.from_amount IS NULL OR t.to_amount IS NULL OR t.exchange_rate IS NULL
     THEN RETURN 'Fund Transfer is missing an amount or exchange rate'; END IF;

  expected_rate := CASE
    WHEN from_currency = to_currency THEN 1
    WHEN from_currency = 'IDR' AND t.to_amount > 0 THEN t.from_amount / t.to_amount
    WHEN to_currency = 'IDR' AND t.from_amount > 0 THEN t.to_amount / t.from_amount
  END;
  IF expected_rate IS NULL OR abs(t.exchange_rate - expected_rate) > 0.000001
     THEN RETURN 'Fund Transfer exchange rate is inconsistent with its stored amounts'; END IF;
  -- This is the known unsafe legacy shape: the USD source amount was stored
  -- in functional journal columns. Do not silently reinterpret posted values.
  IF from_currency = 'USD' AND to_currency = 'IDR'
     THEN RETURN 'Legacy USD-source transfer has a functional accounting inconsistency'; END IF;

  SELECT count(*) INTO line_count FROM public.journal_entry_lines WHERE journal_entry_id = j.id;
  IF line_count <> 2
     OR NOT EXISTS (SELECT 1 FROM public.journal_entry_lines WHERE journal_entry_id=j.id AND line_number=1 AND COALESCE(debit,0)>0 AND COALESCE(credit,0)=0)
     OR NOT EXISTS (SELECT 1 FROM public.journal_entry_lines WHERE journal_entry_id=j.id AND line_number=2 AND COALESCE(credit,0)>0 AND COALESCE(debit,0)=0)
     THEN RETURN 'Posted journal is not a safe two-line transfer'; END IF;
  IF abs(COALESCE(j.total_debit,0) - t.from_amount) > 0.01
     OR abs(COALESCE(j.total_credit,0) - t.from_amount) > 0.01
     OR EXISTS (SELECT 1 FROM public.journal_entry_lines l WHERE l.journal_entry_id=j.id
       AND ((l.line_number=1 AND abs(COALESCE(l.debit,0)-t.from_amount)>0.01)
         OR (l.line_number=2 AND abs(COALESCE(l.credit,0)-t.from_amount)>0.01)))
     THEN RETURN 'Posted journal debit/credit values do not match the Fund Transfer'; END IF;

  -- The Fund Transfer may name a statement line, but this audit never changes
  -- that row. A missing link is only eligible when there is no ambiguity; a
  -- multiple-match case is always left for manual review.
  IF t.from_account_type = 'bank' AND t.from_bank_statement_line_id IS NULL THEN
    SELECT count(*) INTO candidate_count FROM public.bank_statement_lines b
      WHERE b.bank_account_id=t.from_bank_account_id AND abs(b.transaction_date-t.transfer_date)<=8
        AND (COALESCE(b.debit_amount,0)=t.from_amount OR COALESCE(b.credit_amount,0)=t.from_amount);
    IF candidate_count > 1 THEN RETURN 'Multiple possible From Bank transactions; no link was guessed'; END IF;
  END IF;
  IF t.to_account_type = 'bank' AND t.to_bank_statement_line_id IS NULL THEN
    SELECT count(*) INTO candidate_count FROM public.bank_statement_lines b
      WHERE b.bank_account_id=t.to_bank_account_id AND abs(b.transaction_date-t.transfer_date)<=8
        AND (COALESCE(b.debit_amount,0)=t.to_amount OR COALESCE(b.credit_amount,0)=t.to_amount);
    IF candidate_count > 1 THEN RETURN 'Multiple possible To Bank transactions; no link was guessed'; END IF;
  END IF;

  -- Explicit links are audited for consistency but never updated.
  IF t.from_bank_statement_line_id IS NOT NULL AND NOT EXISTS (
    SELECT 1 FROM public.bank_statement_lines b
    WHERE b.id=t.from_bank_statement_line_id AND b.bank_account_id=t.from_bank_account_id
      AND COALESCE(b.debit_amount,0)=t.from_amount
  ) THEN RETURN 'From Bank statement link does not match the Fund Transfer source'; END IF;
  IF t.to_bank_statement_line_id IS NOT NULL AND NOT EXISTS (
    SELECT 1 FROM public.bank_statement_lines b
    WHERE b.id=t.to_bank_statement_line_id AND b.bank_account_id=t.to_bank_account_id
      AND COALESCE(b.credit_amount,0)=t.to_amount
  ) THEN RETURN 'To Bank statement link does not match the Fund Transfer source'; END IF;
  RETURN NULL;
END;
$$;

CREATE OR REPLACE FUNCTION public.repair_all_posted_fund_transfers()
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  t record;
  eligibility text;
  result jsonb;
  scanned integer := 0;
  repaired integer := 0;
  skipped integer := 0;
  skipped_details jsonb := '[]'::jsonb;
BEGIN
  PERFORM public._sec_check_finance_role();
  FOR t IN SELECT id, transfer_number FROM public.fund_transfers WHERE status='posted' ORDER BY transfer_date, transfer_number LOOP
    scanned := scanned + 1;
    eligibility := public.audit_fund_transfer_repair_eligibility(t.id);
    IF eligibility IS NOT NULL THEN
      skipped := skipped + 1;
      skipped_details := skipped_details || jsonb_build_array(jsonb_build_object(
        'fund_transfer_id', t.id, 'transfer_number', t.transfer_number, 'reason', eligibility));
      CONTINUE;
    END IF;
    SELECT public.repair_posted_fund_transfer_from_source(t.id) INTO result;
    IF COALESCE((result->>'repaired')::boolean, false) THEN
      repaired := repaired + 1;
    ELSE
      skipped := skipped + 1;
      skipped_details := skipped_details || jsonb_build_array(jsonb_build_object(
        'fund_transfer_id', t.id, 'transfer_number', t.transfer_number,
        'reason', COALESCE(result->>'reason', 'Repair did not pass validation')));
    END IF;
  END LOOP;
  RETURN jsonb_build_object('total_scanned', scanned, 'automatically_repaired', repaired,
    'skipped', skipped, 'skipped_details', skipped_details);
END;
$$;

REVOKE ALL ON FUNCTION public.audit_fund_transfer_repair_eligibility(uuid) FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.repair_all_posted_fund_transfers() FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.audit_fund_transfer_repair_eligibility(uuid), public.repair_all_posted_fund_transfers() TO authenticated, service_role;

NOTIFY pgrst, 'reload schema';
