import { execFileSync } from 'node:child_process';

const sql = `
BEGIN;

SELECT set_config(
  'request.jwt.claim.sub',
  (
    SELECT id::text FROM public.user_profiles
    WHERE role IN ('admin', 'accounts') AND is_active
    ORDER BY CASE role WHEN 'admin' THEN 0 ELSE 1 END, id
    LIMIT 1
  ),
  true
);
SELECT set_config('request.jwt.claim.role', 'authenticated', true);
SET LOCAL ROLE authenticated;

DO $regression$
DECLARE
  v_user uuid := auth.uid();
  v_coa uuid;
  v_operations uuid;
  v_import_container uuid;
  v_id uuid;
  v_new_key text := 'regression_dynamic_category_' || txid_current()::text;
  v_error text;
  v_before bigint;
BEGIN
  IF EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conrelid = 'public.finance_expenses'::regclass
      AND conname = 'finance_expenses_expense_category_check'
  ) THEN
    RAISE EXCEPTION 'Stale hard-coded expense category CHECK still exists';
  END IF;

  SELECT count(*) INTO v_before FROM public.finance_expenses;
  SELECT id INTO STRICT v_coa FROM public.chart_of_accounts
   WHERE code = '6490' AND is_active AND NOT is_header;
  SELECT id INTO STRICT v_operations FROM public.expense_categories
   WHERE category_key = 'operations' AND is_active AND NOT is_posting_category;
  SELECT id INTO STRICT v_import_container FROM public.import_containers
   ORDER BY created_at NULLS LAST, id LIMIT 1;

  -- A: the live Donations category is accepted and classified as general.
  v_id := public.save_finance_expense(NULL, jsonb_build_object(
    'expense_date', current_date, 'expense_category', 'donations',
    'expense_type', 'operations', 'amount', 5000000,
    'description', 'Rollback-only Donations master regression',
    'document_urls', '[]'::jsonb, 'transaction_currency', 'IDR',
    'exchange_rate', 1, 'approval_status', 'approved', 'created_by', v_user
  ));
  PERFORM 1 FROM public.finance_expenses
   WHERE id = v_id AND expense_category = 'donations' AND expense_type = 'general';
  IF NOT FOUND THEN RAISE EXCEPTION 'Donations did not save as general'; END IF;
  PERFORM 1
    FROM public.journal_entries je
    JOIN public.journal_entry_lines jel ON jel.journal_entry_id = je.id
   WHERE je.reference_id = v_id
     AND je.source_module IN ('expense', 'expenses')
     AND je.is_posted
     AND COALESCE(je.is_reversed, false) = false
     AND jel.account_id = v_coa
     AND jel.debit = 5000000;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Donations did not post Rp5,000,000 to canonical COA 6490';
  END IF;

  -- B: existing Operations category.
  v_id := public.save_finance_expense(NULL, jsonb_build_object(
    'expense_date', current_date, 'expense_category', 'bank_charges',
    'expense_type', 'operations', 'amount', 1000,
    'description', 'Rollback-only Operations regression',
    'document_urls', '[]'::jsonb, 'transaction_currency', 'IDR',
    'exchange_rate', 1, 'approval_status', 'pending_approval', 'created_by', v_user
  ));
  PERFORM 1 FROM public.finance_expenses WHERE id = v_id AND expense_type = 'general';
  IF NOT FOUND THEN RAISE EXCEPTION 'Operations category did not save as general'; END IF;

  -- C: existing Import category retains import context and container behavior.
  v_id := public.save_finance_expense(NULL, jsonb_build_object(
    'expense_date', current_date, 'expense_category', 'bpom_ski_fees',
    'expense_type', 'operations', 'amount', 1000,
    'import_container_id', v_import_container, 'description', 'Rollback-only Import regression',
    'document_urls', '[]'::jsonb, 'transaction_currency', 'IDR',
    'exchange_rate', 1, 'approval_status', 'pending_approval', 'created_by', v_user
  ));
  PERFORM 1 FROM public.finance_expenses WHERE id = v_id AND expense_type = 'import';
  IF NOT FOUND THEN RAISE EXCEPTION 'Import category did not save as import'; END IF;

  -- D: existing Sales category retains sales context.
  v_id := public.save_finance_expense(NULL, jsonb_build_object(
    'expense_date', current_date, 'expense_category', 'delivery_sales',
    'expense_type', 'operations', 'amount', 1000,
    'description', 'Rollback-only Sales regression',
    'document_urls', '[]'::jsonb, 'transaction_currency', 'IDR',
    'exchange_rate', 1, 'approval_status', 'pending_approval', 'created_by', v_user
  ));
  PERFORM 1 FROM public.finance_expenses WHERE id = v_id AND expense_type = 'sales';
  IF NOT FOUND THEN RAISE EXCEPTION 'Sales category did not save as sales'; END IF;

  -- E: a future master leaf works without another CHECK or code change.
  INSERT INTO public.expense_categories (
    category_key, name, parent_id, category_type, coa_account_id,
    is_posting_category, is_active
  ) VALUES (
    v_new_key, 'Rollback Dynamic Category', v_operations, 'operations', v_coa,
    true, true
  );
  v_id := public.save_finance_expense(NULL, jsonb_build_object(
    'expense_date', current_date, 'expense_category', v_new_key,
    'expense_type', 'operations', 'amount', 1000,
    'description', 'Rollback-only dynamic master regression',
    'document_urls', '[]'::jsonb, 'transaction_currency', 'IDR',
    'exchange_rate', 1, 'approval_status', 'pending_approval', 'created_by', v_user
  ));
  PERFORM 1 FROM public.finance_expenses
   WHERE id = v_id AND expense_category = v_new_key AND expense_type = 'general';
  IF NOT FOUND THEN RAISE EXCEPTION 'New master category did not save'; END IF;

  -- F: grouping parents fail with a useful master validation error.
  BEGIN
    PERFORM public.save_finance_expense(NULL, jsonb_build_object(
      'expense_date', current_date, 'expense_category', 'operations',
      'amount', 1000, 'document_urls', '[]'::jsonb,
      'transaction_currency', 'IDR', 'exchange_rate', 1, 'created_by', v_user
    ));
    RAISE EXCEPTION 'Grouping category unexpectedly saved';
  EXCEPTION WHEN check_violation THEN
    GET STACKED DIAGNOSTICS v_error = MESSAGE_TEXT;
    IF v_error NOT ILIKE '%grouping category%' THEN RAISE; END IF;
  END;

  -- G: inactive categories and invalid COAs are blocked by canonical guards.
  BEGIN
    PERFORM public.save_finance_expense(NULL, jsonb_build_object(
      'expense_date', current_date, 'expense_category', 'accounting_audit',
      'amount', 1000, 'document_urls', '[]'::jsonb,
      'transaction_currency', 'IDR', 'exchange_rate', 1, 'created_by', v_user
    ));
    RAISE EXCEPTION 'Inactive category unexpectedly saved';
  EXCEPTION WHEN check_violation THEN
    GET STACKED DIAGNOSTICS v_error = MESSAGE_TEXT;
    IF v_error NOT ILIKE '%inactive%' THEN RAISE; END IF;
  END;

  BEGIN
    INSERT INTO public.expense_categories (
      category_key, name, parent_id, category_type, coa_account_id,
      is_posting_category, is_active
    ) SELECT v_new_key || '_bad', 'Rollback Invalid COA', v_operations,
             'operations', id, true, true
        FROM public.chart_of_accounts WHERE is_header LIMIT 1;
    RAISE EXCEPTION 'Header COA unexpectedly accepted';
  EXCEPTION WHEN raise_exception THEN
    GET STACKED DIAGNOSTICS v_error = MESSAGE_TEXT;
    IF v_error NOT ILIKE '%active posting Chart of Account%' THEN RAISE; END IF;
  END;

  -- H: the test transaction itself does not rewrite historical expenses.
  IF (SELECT count(*) FROM public.finance_expenses) <> v_before + 5 THEN
    RAISE EXCEPTION 'Unexpected expense row impact during regression';
  END IF;
END;
$regression$;

ROLLBACK;
`;

try {
  const stdout = execFileSync(
    'supabase',
    ['db', 'query', '--linked', '--output-format', 'json', sql],
    { cwd: process.cwd(), encoding: 'utf8', stdio: ['ignore', 'pipe', 'inherit'], maxBuffer: 50 * 1024 * 1024 },
  );
  const response = JSON.parse(stdout.slice(stdout.indexOf('{')));
  if (response.error) throw new Error(response.error.message ?? JSON.stringify(response.error));
  console.log(JSON.stringify({
    status: 'passed',
    transaction: 'rolled_back',
    checks: [
      'no_hard_coded_expense_category_check',
      'donations_operations_general',
      'donations_journal_uses_master_coa_6490',
      'existing_operations_general',
      'existing_import',
      'existing_sales',
      'future_master_category_without_code_change',
      'grouping_parent_rejected',
      'inactive_category_rejected',
      'invalid_coa_rejected',
      'historical_rows_unchanged',
    ],
  }, null, 2));
} catch (error) {
  if (error && typeof error === 'object') {
    if ('stdout' in error && error.stdout) process.stderr.write(String(error.stdout));
    if ('stderr' in error && error.stderr) process.stderr.write(String(error.stderr));
  }
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
}
