-- Historical finance/tax repair for SAPJ
-- Safe/idempotent data repair for records verified against bank statement narrations.
-- Does NOT alter inventory, sales, purchase, or operational workflows.

BEGIN;

-- The bank_accounts master is the source of truth for the two BCA accounts.
UPDATE public.chart_of_accounts
SET name = 'Bank BCA - IDR (0930201014)'
WHERE code = '111101';

UPDATE public.chart_of_accounts
SET name = 'Bank BCA - USD (0930201022)'
WHERE code = '111102';

-- PPh 4(2): Feb-2025 payment was already present in tax_payments but was not linked
-- to its bank line. Repair the bank/tax/payment/allocation linkage.
UPDATE public.bank_statement_lines
SET matched_expense_id = NULL,
    matched_entry_id = NULL,
    matched_tax_payment_id = NULL,
    reconciliation_status = 'unmatched',
    matching_status = 'none',
    manually_unlinked = true
WHERE id = '89647a09-7d7e-48e4-b1de-97b4d064e3d0';

UPDATE public.bank_statement_lines bsl
SET matched_entry_id = tp.journal_entry_id,
    matched_tax_payment_id = tp.id,
    reconciliation_status = 'matched',
    matching_status = 'confirmed',
    manually_unlinked = false
FROM public.tax_payments tp
WHERE bsl.id = '89647a09-7d7e-48e4-b1de-97b4d064e3d0'
  AND tp.id = 'dc6b0860-8ed2-47d3-9baf-d05c2ea2167b';

INSERT INTO public.bank_statement_allocations
  (bank_statement_line_id, document_type, document_id, journal_entry_id,
   allocation_amount, payment_kind, created_by)
SELECT bsl.id, 'tax_payment', tp.id, tp.journal_entry_id,
       tp.amount, 'supplier', NULL
FROM public.bank_statement_lines bsl
JOIN public.tax_payments tp ON tp.id = 'dc6b0860-8ed2-47d3-9baf-d05c2ea2167b'
WHERE bsl.id = '89647a09-7d7e-48e4-b1de-97b4d064e3d0'
  AND NOT EXISTS (
    SELECT 1 FROM public.bank_statement_allocations a
    WHERE a.bank_statement_line_id = bsl.id
      AND a.document_type = 'tax_payment'
      AND a.document_id = tp.id
      AND a.payment_kind = 'supplier'
  );

-- Helper block: migrate a verified PPh payment that had been incorrectly stored
-- as an ordinary finance_expense. The tax payment remains linked to the original
-- bank statement line and receives a proper tax-payment journal.
DO $$
DECLARE
  v_tp uuid;
  v_bank uuid;
BEGIN
  -- Oct-2025 PPh 4(2), formerly EXP/25/136.
  SELECT id INTO v_tp FROM public.tax_payments WHERE billing_code = '041338538422705' LIMIT 1;
  IF v_tp IS NULL THEN
    SELECT bank_account_id INTO v_bank FROM public.bank_statement_lines
    WHERE id = '454c5e63-b167-4eae-b62b-70708c4d7638';
    v_tp := public.record_tax_payment(
      (SELECT id FROM public.tax_periods WHERE fiscal_year=2025 AND period_month=10 AND tax_type='PPh4(2)'),
      'PPh4(2)', '2025-10-10', 14500000, v_bank,
      '041338538422705', NULL, NULL,
      'Historical repair: PPh 10% for new Ruko 1st year; migrated from EXP/25/136',
      '041338538422705'
    );
  END IF;

  UPDATE public.bank_statement_lines
  SET matched_expense_id=NULL, matched_entry_id=NULL,
      matched_tax_payment_id=NULL, reconciliation_status='unmatched',
      matching_status='none', manually_unlinked=true
  WHERE id='454c5e63-b167-4eae-b62b-70708c4d7638';

  DELETE FROM public.finance_expenses WHERE voucher_number='EXP/25/136';

  UPDATE public.bank_statement_lines bsl
  SET matched_entry_id=tp.journal_entry_id,
      matched_tax_payment_id=tp.id,
      reconciliation_status='matched', matching_status='confirmed',
      manually_unlinked=false
  FROM public.tax_payments tp
  WHERE bsl.id='454c5e63-b167-4eae-b62b-70708c4d7638' AND tp.id=v_tp;

  INSERT INTO public.bank_statement_allocations
    (bank_statement_line_id,document_type,document_id,journal_entry_id,allocation_amount,payment_kind,created_by)
  SELECT bsl.id,'tax_payment',tp.id,tp.journal_entry_id,tp.amount,'supplier',NULL
  FROM public.bank_statement_lines bsl CROSS JOIN public.tax_payments tp
  WHERE bsl.id='454c5e63-b167-4eae-b62b-70708c4d7638' AND tp.id=v_tp
    AND NOT EXISTS (SELECT 1 FROM public.bank_statement_allocations a
                    WHERE a.bank_statement_line_id=bsl.id AND a.document_type='tax_payment'
                      AND a.document_id=tp.id AND a.payment_kind='supplier');

  -- Nov-2025 PPh 4(2), formerly EXP/25/217.
  SELECT id INTO v_tp FROM public.tax_payments WHERE billing_code = '041420372661471' LIMIT 1;
  IF v_tp IS NULL THEN
    SELECT bank_account_id INTO v_bank FROM public.bank_statement_lines
    WHERE id = 'e8f0a1f1-5372-441b-971d-3dbe06eff231';
    v_tp := public.record_tax_payment(
      (SELECT id FROM public.tax_periods WHERE fiscal_year=2025 AND period_month=11 AND tax_type='PPh4(2)'),
      'PPh4(2)', '2025-11-13', 14500000, v_bank,
      '041420372661471', NULL, NULL,
      'Historical repair: PPh 10% for new Ruko 2nd year; migrated from EXP/25/217',
      '041420372661471'
    );
  END IF;

  UPDATE public.bank_statement_lines
  SET matched_expense_id=NULL, matched_entry_id=NULL,
      matched_tax_payment_id=NULL, reconciliation_status='unmatched',
      matching_status='none', manually_unlinked=true
  WHERE id='e8f0a1f1-5372-441b-971d-3dbe06eff231';

  DELETE FROM public.finance_expenses WHERE voucher_number='EXP/25/217';

  UPDATE public.bank_statement_lines bsl
  SET matched_entry_id=tp.journal_entry_id,
      matched_tax_payment_id=tp.id,
      reconciliation_status='matched', matching_status='confirmed',
      manually_unlinked=false
  FROM public.tax_payments tp
  WHERE bsl.id='e8f0a1f1-5372-441b-971d-3dbe06eff231' AND tp.id=v_tp;

  INSERT INTO public.bank_statement_allocations
    (bank_statement_line_id,document_type,document_id,journal_entry_id,allocation_amount,payment_kind,created_by)
  SELECT bsl.id,'tax_payment',tp.id,tp.journal_entry_id,tp.amount,'supplier',NULL
  FROM public.bank_statement_lines bsl CROSS JOIN public.tax_payments tp
  WHERE bsl.id='e8f0a1f1-5372-441b-971d-3dbe06eff231' AND tp.id=v_tp
    AND NOT EXISTS (SELECT 1 FROM public.bank_statement_allocations a
                    WHERE a.bank_statement_line_id=bsl.id AND a.document_type='tax_payment'
                      AND a.document_id=tp.id AND a.payment_kind='supplier');

  -- PPh 23: Feb-2026 payment, formerly EXP/26/081.
  SELECT id INTO v_tp FROM public.tax_payments WHERE billing_code = '041788403913719' LIMIT 1;
  IF v_tp IS NULL THEN
    SELECT bank_account_id INTO v_bank FROM public.bank_statement_lines
    WHERE id='836c62ba-aa5d-4c3f-ad23-9182f9b8b7e0';
    v_tp := public.record_tax_payment(
      (SELECT id FROM public.tax_periods WHERE fiscal_year=2026 AND period_month=1 AND tax_type='PPh23'),
      'PPh23','2026-02-13',228000,v_bank,
      '041788403913719',NULL,NULL,
      'Historical repair: PPh 23 January payment; migrated from EXP/26/081',
      '041788403913719'
    );
  END IF;

  UPDATE public.bank_statement_lines
  SET matched_expense_id=NULL, matched_entry_id=NULL,
      matched_tax_payment_id=NULL, reconciliation_status='unmatched',
      matching_status='none', manually_unlinked=true
  WHERE id='836c62ba-aa5d-4c3f-ad23-9182f9b8b7e0';
  DELETE FROM public.finance_expenses WHERE voucher_number='EXP/26/081';
  UPDATE public.bank_statement_lines bsl
  SET matched_entry_id=tp.journal_entry_id,matched_tax_payment_id=tp.id,
      reconciliation_status='matched',matching_status='confirmed',manually_unlinked=false
  FROM public.tax_payments tp
  WHERE bsl.id='836c62ba-aa5d-4c3f-ad23-9182f9b8b7e0' AND tp.id=v_tp;
  INSERT INTO public.bank_statement_allocations
    (bank_statement_line_id,document_type,document_id,journal_entry_id,allocation_amount,payment_kind,created_by)
  SELECT bsl.id,'tax_payment',tp.id,tp.journal_entry_id,tp.amount,'supplier',NULL
  FROM public.bank_statement_lines bsl CROSS JOIN public.tax_payments tp
  WHERE bsl.id='836c62ba-aa5d-4c3f-ad23-9182f9b8b7e0' AND tp.id=v_tp
    AND NOT EXISTS (SELECT 1 FROM public.bank_statement_allocations a
                    WHERE a.bank_statement_line_id=bsl.id AND a.document_type='tax_payment'
                      AND a.document_id=tp.id AND a.payment_kind='supplier');

  -- PPh 23: June-2026 payment for May, formerly EXP/26-26/054.
  SELECT id INTO v_tp FROM public.tax_payments WHERE billing_code = '042150913410331' LIMIT 1;
  IF v_tp IS NULL THEN
    SELECT bank_account_id INTO v_bank FROM public.bank_statement_lines
    WHERE id='199359e6-0cc2-4019-befd-389ff70a4d72';
    v_tp := public.record_tax_payment(
      (SELECT id FROM public.tax_periods WHERE fiscal_year=2026 AND period_month=5 AND tax_type='PPh23'),
      'PPh23','2026-06-19',205000,v_bank,
      '042150913410331',NULL,NULL,
      'Historical repair: PPh 23 May payment; migrated from EXP/26-26/054',
      '042150913410331'
    );
  END IF;

  UPDATE public.bank_statement_lines
  SET matched_expense_id=NULL, matched_entry_id=NULL,
      matched_tax_payment_id=NULL, reconciliation_status='unmatched',
      matching_status='none', manually_unlinked=true
  WHERE id='199359e6-0cc2-4019-befd-389ff70a4d72';
  DELETE FROM public.finance_expenses WHERE voucher_number='EXP/26-26/054';
  UPDATE public.bank_statement_lines bsl
  SET matched_entry_id=tp.journal_entry_id,matched_tax_payment_id=tp.id,
      reconciliation_status='matched',matching_status='confirmed',manually_unlinked=false
  FROM public.tax_payments tp
  WHERE bsl.id='199359e6-0cc2-4019-befd-389ff70a4d72' AND tp.id=v_tp;
  INSERT INTO public.bank_statement_allocations
    (bank_statement_line_id,document_type,document_id,journal_entry_id,allocation_amount,payment_kind,created_by)
  SELECT bsl.id,'tax_payment',tp.id,tp.journal_entry_id,tp.amount,'supplier',NULL
  FROM public.bank_statement_lines bsl CROSS JOIN public.tax_payments tp
  WHERE bsl.id='199359e6-0cc2-4019-befd-389ff70a4d72' AND tp.id=v_tp
    AND NOT EXISTS (SELECT 1 FROM public.bank_statement_allocations a
                    WHERE a.bank_statement_line_id=bsl.id AND a.document_type='tax_payment'
                      AND a.document_id=tp.id AND a.payment_kind='supplier');
END $$;

-- One existing PPh21 payment had its billing code missing even though the bank
-- narration contains it. Fill it from the linked bank statement line.
UPDATE public.tax_payments
SET billing_code='041737677719534',
    payment_reference='041737677719534',
    updated_at=now()
WHERE id='a33e6340-acdc-4d7e-b600-d03f5a843125'
  AND billing_code IS NULL;

-- Payment status is a reconciliation state, not a filing state. Keep filing_status
-- untouched; mark periods paid only when an actual reconciled tax payment exists.
UPDATE public.tax_periods tp
SET status='paid', updated_at=now()
WHERE EXISTS (SELECT 1 FROM public.tax_payments p
              WHERE p.tax_period_id=tp.id AND p.status='reconciled')
  AND tp.status IN ('open','payment_pending','reopened');

-- The three verified PPh 4(2) 2025 periods have direct tax-payment evidence.
-- Set the period amount to the reconciled payment amount so outstanding-tax views
-- do not incorrectly show the liability as zero after the historical reclassification.
UPDATE public.tax_periods tp
SET pph_total=(SELECT COALESCE(SUM(p.amount),0)
               FROM public.tax_payments p
               WHERE p.tax_period_id=tp.id AND p.status IN ('posted','reconciled')),
    updated_at=now()
WHERE tp.fiscal_year=2025
  AND tp.tax_type='PPh4(2)'
  AND tp.period_month IN (2,10,11)
  AND EXISTS (SELECT 1 FROM public.tax_payments p
              WHERE p.tax_period_id=tp.id AND p.status='reconciled');

COMMIT;
