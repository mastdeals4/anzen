import { execFileSync } from 'node:child_process';

// Exercise the existing bank-linked manual-journal command in a transaction
// and roll it back. Director/Owner activity is represented by the selected
// existing Director Loan COA, not by a separate party, loan, or repayment row.
const sql = `
BEGIN;
SELECT set_config('request.jwt.claim.sub',(
  SELECT id::text FROM public.user_profiles
  WHERE role IN ('admin','accounts') AND is_active=true
  ORDER BY CASE role WHEN 'admin' THEN 0 ELSE 1 END, id LIMIT 1
),true);
SELECT set_config('request.jwt.claim.role','authenticated',true);
SET LOCAL ROLE authenticated;

DO $audit$
DECLARE
  v_user uuid := auth.uid();
  v_bank uuid; v_bank_coa uuid; v_director_coa uuid; v_director_code text; v_upload uuid;
  v_receipt_line uuid; v_withdrawal_line uuid; v_receipt jsonb; v_withdrawal jsonb;
  v_receipt_je uuid; v_withdrawal_je uuid; v_debits numeric; v_credits numeric; v_count bigint;
BEGIN
  SELECT id, coa_id INTO v_bank, v_bank_coa FROM public.bank_accounts
  WHERE is_active=true AND upper(currency)='IDR' AND coa_id IS NOT NULL ORDER BY created_at,id LIMIT 1;
  SELECT id, code INTO v_director_coa, v_director_code FROM public.chart_of_accounts
  WHERE is_active=true AND COALESCE(is_header,false)=false AND lower(account_type)='liability'
    AND name ~* '^director[[:space:]]+loan'
  ORDER BY code,id LIMIT 1;
  IF v_user IS NULL OR v_bank IS NULL OR v_bank_coa IS NULL OR v_director_coa IS NULL THEN
    RAISE EXCEPTION 'Required existing bank or Director Loan COA fixture is missing';
  END IF;

  INSERT INTO public.bank_statement_uploads(bank_account_id,statement_period,statement_start_date,statement_end_date,currency,uploaded_by,status)
  VALUES(v_bank,'Rollback Director COA verification',current_date,current_date,'IDR',v_user,'completed') RETURNING id INTO v_upload;
  INSERT INTO public.bank_statement_lines(upload_id,bank_account_id,transaction_date,description,debit_amount,credit_amount,currency,created_by)
  VALUES(v_upload,v_bank,current_date,'Rollback Director Loan receipt verification',0,20000000,'IDR',v_user) RETURNING id INTO v_receipt_line;
  v_receipt := public.save_bank_linked_finance_journal(v_receipt_line,'Rollback Director Loan receipt verification',v_director_code,'debit','IDR',1);
  v_receipt_je := (v_receipt->>'journal_entry_id')::uuid;
  SELECT COALESCE(sum(debit),0),COALESCE(sum(credit),0) INTO v_debits,v_credits FROM public.journal_entry_lines WHERE journal_entry_id=v_receipt_je;
  IF v_debits<>20000000 OR v_credits<>20000000 THEN RAISE EXCEPTION 'Receipt journal is unbalanced'; END IF;
  PERFORM 1 FROM public.journal_entry_lines WHERE journal_entry_id=v_receipt_je AND account_id=v_bank_coa AND debit=20000000 AND credit=0;
  IF NOT FOUND THEN RAISE EXCEPTION 'Receipt did not debit the existing bank COA'; END IF;
  PERFORM 1 FROM public.journal_entry_lines WHERE journal_entry_id=v_receipt_je AND account_id=v_director_coa AND debit=0 AND credit=20000000;
  IF NOT FOUND THEN RAISE EXCEPTION 'Receipt did not credit the selected Director Loan COA'; END IF;
  PERFORM 1 FROM public.bank_statement_lines WHERE id=v_receipt_line AND matched_entry_id=v_receipt_je AND reconciliation_status='matched';
  IF NOT FOUND THEN RAISE EXCEPTION 'Receipt was not linked to its journal'; END IF;

  INSERT INTO public.bank_statement_lines(upload_id,bank_account_id,transaction_date,description,debit_amount,credit_amount,currency,created_by)
  VALUES(v_upload,v_bank,current_date,'Rollback Director Loan withdrawal verification',20000000,0,'IDR',v_user) RETURNING id INTO v_withdrawal_line;
  v_withdrawal := public.save_bank_linked_finance_journal(v_withdrawal_line,'Rollback Director Loan withdrawal verification',v_director_code,'credit','IDR',1);
  v_withdrawal_je := (v_withdrawal->>'journal_entry_id')::uuid;
  PERFORM 1 FROM public.journal_entry_lines WHERE journal_entry_id=v_withdrawal_je AND account_id=v_director_coa AND debit=20000000 AND credit=0;
  IF NOT FOUND THEN RAISE EXCEPTION 'Withdrawal did not debit the same Director Loan COA'; END IF;
  PERFORM 1 FROM public.journal_entry_lines WHERE journal_entry_id=v_withdrawal_je AND account_id=v_bank_coa AND debit=0 AND credit=20000000;
  IF NOT FOUND THEN RAISE EXCEPTION 'Withdrawal did not credit the existing bank COA'; END IF;
  PERFORM 1 FROM public.bank_statement_lines WHERE id=v_withdrawal_line AND matched_entry_id=v_withdrawal_je AND reconciliation_status='matched';
  IF NOT FOUND THEN RAISE EXCEPTION 'Withdrawal was not linked to its journal'; END IF;
  SELECT count(*) INTO v_count FROM public.journal_entry_lines WHERE account_id=v_director_coa AND journal_entry_id IN(v_receipt_je,v_withdrawal_je);
  IF v_count<>2 THEN RAISE EXCEPTION 'Director Loan ledger is missing a verified transaction'; END IF;
  PERFORM 1 FROM public.get_trial_balance('2000-01-01',current_date,1) HAVING abs(sum(total_debit)-sum(total_credit))<=0.01;
  IF NOT FOUND THEN RAISE EXCEPTION 'Trial Balance is not balanced'; END IF;
END;
$audit$;
ROLLBACK;
`;

try {
  const stdout = execFileSync('supabase', ['db', 'query', '--linked', '--output-format', 'json', sql], {
    cwd: process.cwd(), encoding: 'utf8', stdio: ['ignore', 'pipe', 'inherit'], maxBuffer: 100 * 1024 * 1024,
  });
  const response = JSON.parse(stdout.slice(stdout.indexOf('{')));
  if (response.error) throw new Error(response.error.message ?? JSON.stringify(response.error));
  console.log(JSON.stringify({ status: 'passed', transaction: 'rolled_back', checks: [
    'existing_director_loan_coa_selected', 'receipt_dr_bank_cr_director_loan',
    'withdrawal_dr_director_loan_cr_bank', 'bank_reconciliation_links',
    'director_coa_ledger_lines', 'trial_balance',
  ] }, null, 2));
} catch (error) {
  if (error && typeof error === 'object' && 'stdout' in error && error.stdout) process.stderr.write(String(error.stdout));
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
}
