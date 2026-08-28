/*
  # PIB Import — Single Payment with Tax Breakdown
*/

ALTER TABLE finance_expenses
  ADD COLUMN IF NOT EXISTS pib_bm_amount  DECIMAL(18,2),
  ADD COLUMN IF NOT EXISTS pib_ppn_amount DECIMAL(18,2),
  ADD COLUMN IF NOT EXISTS pib_pph_amount DECIMAL(18,2);

ALTER TABLE finance_expenses
  DROP CONSTRAINT IF EXISTS chk_pib_breakdown_sum;

ALTER TABLE finance_expenses
  ADD CONSTRAINT chk_pib_breakdown_sum CHECK (
    expense_category <> 'pib_import'
    OR (
      pib_bm_amount  IS NOT NULL AND
      pib_ppn_amount IS NOT NULL AND
      pib_pph_amount IS NOT NULL AND
      ABS(
        COALESCE(pib_bm_amount,  0) +
        COALESCE(pib_ppn_amount, 0) +
        COALESCE(pib_pph_amount, 0) -
        amount
      ) < 1.00
    )
  );

INSERT INTO chart_of_accounts (
  code, name, account_type, parent_id, is_header, normal_balance, is_active, created_at
) VALUES (
  '1155',
  'PPh 22 Dibayar Dimuka',
  'asset',
  (SELECT id FROM chart_of_accounts WHERE code = '1000' LIMIT 1),
  false,
  'debit',
  true,
  now()
)
ON CONFLICT (code) DO UPDATE
  SET name      = EXCLUDED.name,
      is_active = true;

CREATE OR REPLACE FUNCTION get_expense_account_id(p_category TEXT)
RETURNS UUID
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_account_id UUID;
BEGIN
  v_account_id := CASE p_category
    WHEN 'salary'            THEN (SELECT id FROM chart_of_accounts WHERE code = '6100' LIMIT 1)
    WHEN 'staff_overtime'    THEN (SELECT id FROM chart_of_accounts WHERE code = '6100' LIMIT 1)
    WHEN 'staff_welfare'     THEN (SELECT id FROM chart_of_accounts WHERE code = '6150' LIMIT 1)
    WHEN 'employee_benefits' THEN (SELECT id FROM chart_of_accounts WHERE code = '6110' LIMIT 1)
    WHEN 'travel_conveyance' THEN (SELECT id FROM chart_of_accounts WHERE code = '6500' LIMIT 1)
    WHEN 'office_rent'      THEN (SELECT id FROM chart_of_accounts WHERE code = '6220' LIMIT 1)
    WHEN 'warehouse_rent'   THEN (SELECT id FROM chart_of_accounts WHERE code = '6210' LIMIT 1)
    WHEN 'rent'             THEN (SELECT id FROM chart_of_accounts WHERE code = '6200' LIMIT 1)
    WHEN 'office_admin'               THEN (SELECT id FROM chart_of_accounts WHERE code = '6410' LIMIT 1)
    WHEN 'office_supplies'            THEN (SELECT id FROM chart_of_accounts WHERE code = '6400' LIMIT 1)
    WHEN 'office_shifting_renovation' THEN (SELECT id FROM chart_of_accounts WHERE code = '6420' LIMIT 1)
    WHEN 'utilities'     THEN (SELECT id FROM chart_of_accounts WHERE code = '6300' LIMIT 1)
    WHEN 'electricity'   THEN (SELECT id FROM chart_of_accounts WHERE code = '6310' LIMIT 1)
    WHEN 'water'         THEN (SELECT id FROM chart_of_accounts WHERE code = '6320' LIMIT 1)
    WHEN 'internet_phone'THEN (SELECT id FROM chart_of_accounts WHERE code = '6330' LIMIT 1)
    WHEN 'fuel'                THEN (SELECT id FROM chart_of_accounts WHERE code = '6500' LIMIT 1)
    WHEN 'vehicle_maintenance' THEN (SELECT id FROM chart_of_accounts WHERE code = '6500' LIMIT 1)
    WHEN 'delivery_sales'        THEN (SELECT id FROM chart_of_accounts WHERE code = '6510' LIMIT 1)
    WHEN 'loading_sales'         THEN (SELECT id FROM chart_of_accounts WHERE code = '6520' LIMIT 1)
    WHEN 'other_sales'           THEN (SELECT id FROM chart_of_accounts WHERE code = '6510' LIMIT 1)
    WHEN 'marketing_advertising' THEN (SELECT id FROM chart_of_accounts WHERE code = '6600' LIMIT 1)
    WHEN 'legal_professional' THEN (SELECT id FROM chart_of_accounts WHERE code = '6700' LIMIT 1)
    WHEN 'consulting_fees'    THEN (SELECT id FROM chart_of_accounts WHERE code = '6700' LIMIT 1)
    WHEN 'accounting_audit'   THEN (SELECT id FROM chart_of_accounts WHERE code = '6700' LIMIT 1)
    WHEN 'bank_charges'      THEN (SELECT id FROM chart_of_accounts WHERE code = '7100' LIMIT 1)
    WHEN 'interest_expense'  THEN (SELECT id FROM chart_of_accounts WHERE code = '7200' LIMIT 1)
    WHEN 'duty_customs'       THEN (SELECT id FROM chart_of_accounts WHERE code = '1130' LIMIT 1)
    WHEN 'duty_import'        THEN (SELECT id FROM chart_of_accounts WHERE code = '1130' LIMIT 1)
    WHEN 'freight_import'     THEN (SELECT id FROM chart_of_accounts WHERE code = '5300' LIMIT 1)
    WHEN 'clearing_forwarding'THEN (SELECT id FROM chart_of_accounts WHERE code = '5300' LIMIT 1)
    WHEN 'port_charges'       THEN (SELECT id FROM chart_of_accounts WHERE code = '5300' LIMIT 1)
    WHEN 'container_handling' THEN (SELECT id FROM chart_of_accounts WHERE code = '5300' LIMIT 1)
    WHEN 'transport_import'   THEN (SELECT id FROM chart_of_accounts WHERE code = '5300' LIMIT 1)
    WHEN 'loading_import'     THEN (SELECT id FROM chart_of_accounts WHERE code = '5300' LIMIT 1)
    WHEN 'bpom_ski_fees'      THEN (SELECT id FROM chart_of_accounts WHERE code = '5410' LIMIT 1)
    WHEN 'other_import'       THEN (SELECT id FROM chart_of_accounts WHERE code = '5400' LIMIT 1)
    WHEN 'ppn_import' THEN (SELECT id FROM chart_of_accounts WHERE code = '1150' LIMIT 1)
    WHEN 'pph_import' THEN (SELECT id FROM chart_of_accounts WHERE code = '1155' LIMIT 1)
    WHEN 'pib_import' THEN NULL
    ELSE (SELECT id FROM chart_of_accounts WHERE code = '6900' LIMIT 1)
  END;

  IF v_account_id IS NULL AND p_category <> 'pib_import' THEN
    SELECT id INTO v_account_id FROM chart_of_accounts WHERE code = '6000' LIMIT 1;
  END IF;

  RETURN v_account_id;
END;
$$;

CREATE OR REPLACE FUNCTION auto_post_expense_accounting()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
DECLARE
  v_expense_account_id UUID;
  v_payment_account_id UUID;
  v_journal_id         UUID;
  v_description        TEXT;
  v_credit_desc        TEXT;
  v_entry_number       TEXT;
  v_category_label     TEXT;
  v_old_journal_id     UUID;
  v_bm_account_id      UUID;
  v_ppn_account_id     UUID;
  v_pph_account_id     UUID;
  v_line_num           INTEGER;
BEGIN
  IF TG_OP = 'UPDATE' THEN
    IF (
      OLD.amount             = NEW.amount AND
      OLD.expense_category   = NEW.expense_category AND
      OLD.payment_method     IS NOT DISTINCT FROM NEW.payment_method AND
      OLD.bank_account_id    IS NOT DISTINCT FROM NEW.bank_account_id AND
      OLD.pib_bm_amount      IS NOT DISTINCT FROM NEW.pib_bm_amount AND
      OLD.pib_ppn_amount     IS NOT DISTINCT FROM NEW.pib_ppn_amount AND
      OLD.pib_pph_amount     IS NOT DISTINCT FROM NEW.pib_pph_amount
    ) THEN
      RETURN NEW;
    END IF;

    SELECT id INTO v_old_journal_id
    FROM journal_entries
    WHERE reference_number = 'EXP-' || NEW.id::text
    LIMIT 1;

    IF v_old_journal_id IS NOT NULL THEN
      DELETE FROM journal_entry_lines WHERE journal_entry_id = v_old_journal_id;
      DELETE FROM journal_entries      WHERE id              = v_old_journal_id;
    END IF;
  END IF;

  IF TG_OP = 'INSERT' THEN
    IF EXISTS (
      SELECT 1 FROM journal_entries
      WHERE reference_number = 'EXP-' || NEW.id::text
    ) THEN
      RETURN NEW;
    END IF;
  END IF;

  IF NEW.payment_method = 'cash' THEN
    SELECT id INTO v_payment_account_id FROM chart_of_accounts WHERE code = '1101' LIMIT 1;
  ELSIF NEW.payment_method = 'petty_cash' THEN
    SELECT id INTO v_payment_account_id FROM chart_of_accounts WHERE code = '1102' LIMIT 1;
  ELSIF NEW.payment_method = 'bank_transfer' AND NEW.bank_account_id IS NOT NULL THEN
    SELECT coa_id INTO v_payment_account_id FROM bank_accounts WHERE id = NEW.bank_account_id;
    IF v_payment_account_id IS NULL THEN
      SELECT id INTO v_payment_account_id FROM chart_of_accounts WHERE code = '1111' LIMIT 1;
    END IF;
  ELSIF NEW.payment_method IS NULL THEN
    SELECT id INTO v_payment_account_id FROM chart_of_accounts WHERE code = '2110' LIMIT 1;
  ELSE
    SELECT id INTO v_payment_account_id FROM chart_of_accounts WHERE code = '1101' LIMIT 1;
  END IF;

  IF v_payment_account_id IS NULL THEN RETURN NEW; END IF;

  SELECT
    'JE' || TO_CHAR(NEW.expense_date, 'YYMM') || '-' ||
    LPAD(
      (COALESCE(
        MAX(CAST(SUBSTRING(entry_number FROM '-([0-9]+)$') AS INTEGER)), 0
      ) + 1)::TEXT,
      4, '0'
    )
  INTO v_entry_number
  FROM journal_entries
  WHERE entry_number LIKE 'JE' || TO_CHAR(NEW.expense_date, 'YYMM') || '-%';

  IF NEW.expense_category = 'pib_import' THEN

    v_bm_account_id  := get_expense_account_id('duty_customs');
    v_ppn_account_id := get_expense_account_id('ppn_import');
    v_pph_account_id := get_expense_account_id('pph_import');

    INSERT INTO journal_entries (
      entry_number, entry_date, source_module, reference_number,
      description, transaction_category,
      total_debit, total_credit, is_posted, posted_at, created_by
    ) VALUES (
      v_entry_number,
      NEW.expense_date,
      'expenses',
      'EXP-' || NEW.id::text,
      COALESCE(NEW.description, 'PIB Import Payment'),
      'pib_import',
      NEW.amount,
      NEW.amount,
      true,
      now(),
      NEW.created_by
    ) RETURNING id INTO v_journal_id;

    v_line_num := 1;

    IF COALESCE(NEW.pib_bm_amount, 0) > 0 AND v_bm_account_id IS NOT NULL THEN
      INSERT INTO journal_entry_lines
        (journal_entry_id, line_number, account_id, debit, credit, description)
      VALUES
        (v_journal_id, v_line_num, v_bm_account_id,
         NEW.pib_bm_amount, 0,
         'PIB - Import Duty (BM) [landed cost]');
      v_line_num := v_line_num + 1;
    END IF;

    IF COALESCE(NEW.pib_ppn_amount, 0) > 0 AND v_ppn_account_id IS NOT NULL THEN
      INSERT INTO journal_entry_lines
        (journal_entry_id, line_number, account_id, debit, credit, description)
      VALUES
        (v_journal_id, v_line_num, v_ppn_account_id,
         NEW.pib_ppn_amount, 0,
         'PIB - PPN Import (Input VAT, PPN Masukan)');
      v_line_num := v_line_num + 1;
    END IF;

    IF COALESCE(NEW.pib_pph_amount, 0) > 0 AND v_pph_account_id IS NOT NULL THEN
      INSERT INTO journal_entry_lines
        (journal_entry_id, line_number, account_id, debit, credit, description)
      VALUES
        (v_journal_id, v_line_num, v_pph_account_id,
         NEW.pib_pph_amount, 0,
         'PIB - PPh 22 Dibayar Dimuka (Advance Income Tax)');
      v_line_num := v_line_num + 1;
    END IF;

    INSERT INTO journal_entry_lines
      (journal_entry_id, line_number, account_id, debit, credit, description)
    VALUES
      (v_journal_id, v_line_num, v_payment_account_id,
       0, NEW.amount,
       'PIB - Bank payment [' || COALESCE(NEW.description, '') || ']');

    RETURN NEW;
  END IF;

  v_expense_account_id := get_expense_account_id(NEW.expense_category);
  IF v_expense_account_id IS NULL THEN RETURN NEW; END IF;

  v_category_label := REPLACE(INITCAP(REPLACE(NEW.expense_category, '_', ' ')), ' ', ' ');
  v_description    := COALESCE(NEW.description, NEW.expense_category);
  v_credit_desc    := COALESCE(
                        SUBSTRING(NEW.description FROM '^[^\n]+'),
                        NEW.expense_category
                      ) || ' [' || v_category_label || ']';

  INSERT INTO journal_entries (
    entry_number, entry_date, source_module, reference_number,
    description, transaction_category,
    total_debit, total_credit, is_posted, posted_at, created_by
  ) VALUES (
    v_entry_number, NEW.expense_date, 'expenses', 'EXP-' || NEW.id::text,
    v_description, NEW.expense_category,
    NEW.amount, NEW.amount, true, now(), NEW.created_by
  ) RETURNING id INTO v_journal_id;

  INSERT INTO journal_entry_lines
    (journal_entry_id, line_number, account_id, debit, credit, description)
  VALUES (v_journal_id, 1, v_expense_account_id, NEW.amount, 0, v_credit_desc);

  INSERT INTO journal_entry_lines
    (journal_entry_id, line_number, account_id, debit, credit, description)
  VALUES (v_journal_id, 2, v_payment_account_id, 0, NEW.amount, v_credit_desc);

  RETURN NEW;

EXCEPTION WHEN OTHERS THEN
  RAISE WARNING 'auto_post_expense_accounting failed for expense %: %', NEW.id, SQLERRM;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trigger_auto_post_expense_accounting ON finance_expenses;
CREATE TRIGGER trigger_auto_post_expense_accounting
  AFTER INSERT OR UPDATE ON finance_expenses
  FOR EACH ROW
  EXECUTE FUNCTION auto_post_expense_accounting();

DROP VIEW IF EXISTS vw_input_ppn_report;
CREATE VIEW vw_input_ppn_report AS
SELECT
  DATE_TRUNC('month', fe.expense_date)  AS month,
  fe.expense_date,
  ic.container_ref,
  s.company_name                         AS supplier,
  ic.import_invoice_value,
  CASE
    WHEN fe.expense_category = 'pib_import' THEN COALESCE(fe.pib_ppn_amount, 0)
    ELSE fe.amount
  END                                    AS ppn_amount,
  fe.description,
  fe.created_at
FROM finance_expenses fe
JOIN import_containers ic ON fe.import_container_id = ic.id
LEFT JOIN suppliers s ON ic.supplier_id = s.id
WHERE
  fe.expense_category = 'ppn_import'
  OR (
    fe.expense_category = 'pib_import'
    AND COALESCE(fe.pib_ppn_amount, 0) > 0
  )
ORDER BY fe.expense_date DESC;

DROP VIEW IF EXISTS vw_monthly_tax_summary;
CREATE VIEW vw_monthly_tax_summary AS
SELECT
  COALESCE(all_months.month, input.month, output.month) AS month,
  COALESCE(input_ppn,  0) AS input_ppn_paid,
  COALESCE(output_ppn, 0) AS output_ppn_collected,
  COALESCE(output_ppn, 0) - COALESCE(input_ppn, 0) AS net_ppn_payable
FROM (
  SELECT DISTINCT DATE_TRUNC('month', expense_date) AS month
  FROM finance_expenses
  WHERE
    expense_category = 'ppn_import'
    OR (expense_category = 'pib_import' AND COALESCE(pib_ppn_amount, 0) > 0)
  UNION
  SELECT DISTINCT DATE_TRUNC('month', invoice_date) AS month
  FROM sales_invoices
  WHERE tax_amount > 0
) all_months
LEFT JOIN (
  SELECT
    DATE_TRUNC('month', expense_date) AS month,
    SUM(
      CASE
        WHEN expense_category = 'pib_import' THEN COALESCE(pib_ppn_amount, 0)
        ELSE amount
      END
    ) AS input_ppn
  FROM finance_expenses
  WHERE
    expense_category = 'ppn_import'
    OR (expense_category = 'pib_import' AND COALESCE(pib_ppn_amount, 0) > 0)
  GROUP BY DATE_TRUNC('month', expense_date)
) input ON input.month = all_months.month
LEFT JOIN (
  SELECT
    DATE_TRUNC('month', invoice_date) AS month,
    SUM(tax_amount)                   AS output_ppn
  FROM sales_invoices
  WHERE tax_amount > 0
  GROUP BY DATE_TRUNC('month', invoice_date)
) output ON output.month = all_months.month
ORDER BY month DESC;

DROP VIEW IF EXISTS vw_pph22_advance_tax_report;
CREATE VIEW vw_pph22_advance_tax_report AS
SELECT
  DATE_TRUNC('month', fe.expense_date) AS month,
  fe.expense_date,
  fe.voucher_number,
  COALESCE(ic.container_ref, '—')      AS container_ref,
  COALESCE(s.company_name,  '—')       AS supplier,
  CASE
    WHEN fe.expense_category = 'pib_import' THEN COALESCE(fe.pib_pph_amount, 0)
    ELSE fe.amount
  END                                  AS pph22_amount,
  fe.description,
  fe.created_at
FROM finance_expenses fe
LEFT JOIN import_containers ic ON fe.import_container_id = ic.id
LEFT JOIN suppliers s ON ic.supplier_id = s.id
WHERE
  fe.expense_category = 'pph_import'
  OR (
    fe.expense_category = 'pib_import'
    AND COALESCE(fe.pib_pph_amount, 0) > 0
  )
ORDER BY fe.expense_date DESC;
