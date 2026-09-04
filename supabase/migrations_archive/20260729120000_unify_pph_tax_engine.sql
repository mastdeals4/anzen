-- Unify PPh calculation, posting and reporting around the existing tax engine.
--
-- The expense screen stores the authoritative withholding amount in
-- finance_expenses.pph_amount and identifies its type through pph_code_id.
-- This migration makes the payable account, tax-period snapshot and reports
-- derive from that same source. It does not create a second tax ledger.

BEGIN;

-- PPh payable account is determined by the source tax code, never by a
-- hard-coded default. PPh_Unifikasi is a reporting consolidation, not a
-- source transaction tax code.
CREATE OR REPLACE FUNCTION public.fn_pph_payable_account_id(p_tax_code_id uuid)
RETURNS uuid
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT coa.id
    FROM chart_of_accounts coa
   WHERE coa.code = CASE (
     SELECT tc.tax_type FROM tax_codes tc WHERE tc.id = p_tax_code_id
   )
     WHEN 'PPh21'   THEN '2131'
     WHEN 'PPh22'   THEN '2137'
     WHEN 'PPh23'   THEN '2132'
     WHEN 'PPh4(2)' THEN '2138'
     ELSE '2132'
   END
   LIMIT 1;
$$;

GRANT EXECUTE ON FUNCTION public.fn_pph_payable_account_id(uuid) TO authenticated;

-- Correct the PPh line after the existing expense posting triggers have
-- created/recreated the journal. This preserves the original journal and
-- amount while ensuring its liability account agrees with pph_code_id.
CREATE OR REPLACE FUNCTION public.trg_sync_expense_pph_account()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_account_id uuid;
  v_journal_id uuid;
  v_line_number integer;
BEGIN
  IF COALESCE(NEW.pph_amount, 0) <= 0 THEN
    RETURN NEW;
  END IF;

  v_account_id := fn_pph_payable_account_id(NEW.pph_code_id);
  IF v_account_id IS NULL THEN
    RETURN NEW;
  END IF;

  SELECT id INTO v_journal_id
    FROM journal_entries
   WHERE reference_id = NEW.id
     AND source_module = 'expenses'
   ORDER BY created_at DESC
   LIMIT 1;

  IF v_journal_id IS NULL THEN
    RETURN NEW;
  END IF;

  IF EXISTS (
    SELECT 1 FROM journal_entry_lines
     WHERE journal_entry_id = v_journal_id
       AND debit = 0
       AND description ILIKE 'PPh Ditahan%'
  ) THEN
    UPDATE journal_entry_lines
       SET account_id = v_account_id
     WHERE journal_entry_id = v_journal_id
       AND debit = 0
       AND description ILIKE 'PPh Ditahan%';
  ELSE
    -- The legacy salary posting path created only the gross bank credit.
    -- Split that existing credit into net pay plus the PPh payable without
    -- changing the expense debit or the journal's economic total.
    UPDATE journal_entry_lines
       SET credit = credit - NEW.pph_amount
     WHERE id = (
       SELECT id FROM journal_entry_lines
        WHERE journal_entry_id = v_journal_id
          AND credit >= NEW.pph_amount
        ORDER BY credit DESC, line_number DESC
        LIMIT 1
     );

    SELECT COALESCE(MAX(line_number), 0) + 1 INTO v_line_number
      FROM journal_entry_lines
     WHERE journal_entry_id = v_journal_id;

    INSERT INTO journal_entry_lines
      (journal_entry_id, line_number, account_id, debit, credit, description)
    VALUES
      (v_journal_id, v_line_number, v_account_id, 0, NEW.pph_amount,
       'PPh Ditahan - ' || COALESCE(NEW.description, NEW.voucher_number, 'Expense'));
  END IF;

  UPDATE journal_entries
     SET total_debit = (SELECT COALESCE(SUM(debit), 0) FROM journal_entry_lines WHERE journal_entry_id = v_journal_id),
         total_credit = (SELECT COALESCE(SUM(credit), 0) FROM journal_entry_lines WHERE journal_entry_id = v_journal_id)
   WHERE id = v_journal_id;

  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_z_sync_expense_pph_account ON public.finance_expenses;
DROP TRIGGER IF EXISTS zzz_sync_expense_pph_account ON public.finance_expenses;
CREATE TRIGGER zzz_sync_expense_pph_account
  AFTER INSERT OR UPDATE ON public.finance_expenses
  FOR EACH ROW EXECUTE FUNCTION public.trg_sync_expense_pph_account();

-- Repair historical standard-expense PPh lines using the source tax code.
UPDATE journal_entry_lines jel
   SET account_id = fn_pph_payable_account_id(fe.pph_code_id)
  FROM journal_entries je
  JOIN finance_expenses fe ON fe.id = je.reference_id
 WHERE jel.journal_entry_id = je.id
   AND je.source_module = 'expenses'
   AND COALESCE(fe.pph_amount, 0) > 0
   AND jel.credit = fe.pph_amount
   AND jel.debit = 0
   AND jel.description ILIKE 'PPh Ditahan%'
   AND fn_pph_payable_account_id(fe.pph_code_id) IS NOT NULL;

-- Repair legacy approved expenses whose journal omitted the withholding line
-- entirely (notably salary-family postings). Reduce the existing payment
-- credit by the tax and add the corresponding payable credit.
WITH missing AS (
  SELECT fe.id AS expense_id, fe.pph_amount,
         fn_pph_payable_account_id(fe.pph_code_id) AS account_id,
         je.id AS journal_id
    FROM finance_expenses fe
    JOIN journal_entries je ON je.reference_id = fe.id AND je.source_module = 'expenses'
   WHERE COALESCE(fe.pph_amount, 0) > 0
     AND fn_pph_payable_account_id(fe.pph_code_id) IS NOT NULL
     AND NOT EXISTS (
       SELECT 1 FROM journal_entry_lines jel
        WHERE jel.journal_entry_id = je.id
          AND jel.debit = 0
          AND jel.description ILIKE 'PPh Ditahan%'
     )
), payment_line AS (
  SELECT DISTINCT ON (m.journal_id) m.journal_id, m.pph_amount, jel.id AS line_id
    FROM missing m
    JOIN journal_entry_lines jel ON jel.journal_entry_id = m.journal_id
     AND jel.credit >= m.pph_amount
   ORDER BY m.journal_id, jel.credit DESC, jel.line_number DESC
)
UPDATE journal_entry_lines jel
   SET credit = jel.credit - pl.pph_amount
  FROM payment_line pl
 WHERE jel.id = pl.line_id;

WITH missing AS (
  SELECT fe.pph_amount, fn_pph_payable_account_id(fe.pph_code_id) AS account_id,
         je.id AS journal_id, COALESCE(fe.description, fe.voucher_number, 'Expense') AS description
    FROM finance_expenses fe
    JOIN journal_entries je ON je.reference_id = fe.id AND je.source_module = 'expenses'
   WHERE COALESCE(fe.pph_amount, 0) > 0
     AND fn_pph_payable_account_id(fe.pph_code_id) IS NOT NULL
     AND NOT EXISTS (
       SELECT 1 FROM journal_entry_lines jel
        WHERE jel.journal_entry_id = je.id
          AND jel.debit = 0
          AND jel.description ILIKE 'PPh Ditahan%'
     )
)
INSERT INTO journal_entry_lines (journal_entry_id, line_number, account_id, debit, credit, description)
SELECT m.journal_id,
       (SELECT COALESCE(MAX(line_number), 0) + 1 FROM journal_entry_lines WHERE journal_entry_id = m.journal_id),
       m.account_id, 0, m.pph_amount, 'PPh Ditahan - ' || m.description
  FROM missing m;

UPDATE journal_entries je
   SET total_debit = (SELECT COALESCE(SUM(debit), 0) FROM journal_entry_lines WHERE journal_entry_id = je.id),
       total_credit = (SELECT COALESCE(SUM(credit), 0) FROM journal_entry_lines WHERE journal_entry_id = je.id)
 WHERE je.source_module = 'expenses'
   AND EXISTS (SELECT 1 FROM finance_expenses fe WHERE fe.id = je.reference_id AND COALESCE(fe.pph_amount, 0) > 0);

-- The period snapshot is the single PPh liability source. Tax payments are
-- the only settlement source for ordinary withholding; import settlement is
-- retained through the existing helper for PPh22 imports.
CREATE OR REPLACE VIEW public.vw_pph_by_period_type AS
SELECT
  tp.id AS tax_period_id,
  tp.fiscal_year,
  tp.period_month,
  tp.tax_type,
  tp.pph_total,
  LEAST(tp.pph_total, fn_tax_payments_paid(tp.id)
    + fn_settled_import_pph22(tp.fiscal_year, tp.period_month, tp.tax_type)) AS pph_paid_total,
  GREATEST(tp.pph_total - LEAST(tp.pph_total, fn_tax_payments_paid(tp.id)
    + fn_settled_import_pph22(tp.fiscal_year, tp.period_month, tp.tax_type)), 0) AS pph_outstanding,
  tp.status,
  tp.payment_due_date,
  tp.filing_due_date,
  fn_period_payment_status(
    tp.status,
    GREATEST(tp.pph_total - LEAST(tp.pph_total, fn_tax_payments_paid(tp.id)
      + fn_settled_import_pph22(tp.fiscal_year, tp.period_month, tp.tax_type)), 0),
    tp.payment_due_date
  ) AS payment_status,
  fn_period_payment_source(
    tp.pph_total,
    fn_tax_payments_paid(tp.id),
    fn_settled_import_pph22(tp.fiscal_year, tp.period_month, tp.tax_type)
  ) AS payment_source
FROM tax_periods tp
WHERE tp.tax_type <> 'PPN';

ALTER VIEW public.vw_pph_by_period_type SET (security_invoker = true);
GRANT SELECT ON public.vw_pph_by_period_type TO authenticated;

CREATE OR REPLACE VIEW public.vw_outstanding_tax AS
SELECT
  tp.id AS tax_period_id,
  tp.fiscal_year,
  tp.period_month,
  tp.tax_type,
  tp.status,
  tp.payment_due_date,
  GREATEST(
    (CASE WHEN tp.tax_type = 'PPN' THEN tp.net_ppn ELSE tp.pph_total END)
    - LEAST(
      (CASE WHEN tp.tax_type = 'PPN' THEN tp.net_ppn ELSE tp.pph_total END),
      fn_tax_payments_paid(tp.id)
        + fn_settled_import_pph22(tp.fiscal_year, tp.period_month, tp.tax_type)
    ), 0
  ) AS outstanding_amount
FROM tax_periods tp
WHERE tp.status NOT IN ('paid', 'closed');

ALTER VIEW public.vw_outstanding_tax SET (security_invoker = true);
GRANT SELECT ON public.vw_outstanding_tax TO authenticated;

CREATE OR REPLACE VIEW public.vw_tax_period_status AS
SELECT
  tp.id,
  tp.fiscal_year,
  tp.period_month,
  tp.tax_type,
  tp.status,
  tp.filing_status,
  tp.payment_due_date,
  tp.filing_due_date,
  tp.net_ppn,
  tp.pph_total,
  (SELECT COUNT(*) FROM tax_payments WHERE tax_period_id = tp.id AND status = 'reconciled') AS reconciled_payments_count,
  (SELECT COUNT(*) FROM tax_payments WHERE tax_period_id = tp.id AND status IN ('draft', 'posted')) AS unreconciled_payments_count,
  (SELECT COUNT(*) FROM sales_invoices si WHERE si.tax_period_id = tp.id
    AND (si.faktur_pajak_number IS NULL OR si.faktur_pajak_number = '')
    AND si.tax_amount > 0) AS missing_faktur_count,
  (CASE WHEN tp.tax_type = 'PPN' THEN tp.net_ppn ELSE tp.pph_total END)
    - COALESCE(ot.outstanding_amount, 0) AS paid_amount,
  COALESCE(ot.outstanding_amount, 0) AS outstanding_amount,
  fn_period_payment_status(tp.status, COALESCE(ot.outstanding_amount, 0), tp.payment_due_date) AS payment_status,
  fn_period_payment_source(
    CASE WHEN tp.tax_type = 'PPN' THEN tp.net_ppn ELSE tp.pph_total END,
    fn_tax_payments_paid(tp.id),
    fn_settled_import_pph22(tp.fiscal_year, tp.period_month, tp.tax_type)
  ) AS payment_source
FROM tax_periods tp
LEFT JOIN vw_outstanding_tax ot ON ot.tax_period_id = tp.id;

ALTER VIEW public.vw_tax_period_status SET (security_invoker = true);
GRANT SELECT ON public.vw_tax_period_status TO authenticated;

-- Refresh every snapshot after the historical posting repair.
DO $$
DECLARE r record;
BEGIN
  FOR r IN SELECT id FROM tax_periods LOOP
    PERFORM compute_period_ppn(r.id);
  END LOOP;
END;
$$;

NOTIFY pgrst, 'reload schema';
COMMIT;
