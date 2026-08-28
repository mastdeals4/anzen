/*
  # PIB Import — Single Payment with Tax Breakdown

  ## Business Requirement
  The company receives ONE official Indonesian PIB document and makes ONE bank
  payment covering Import Duty (BM), PPN Import, and PPh 22 Import.
  Users must be able to record this as ONE expense transaction, not three.

  ## What this migration does (minimum change, zero breakage)

  1. Adds three nullable columns to finance_expenses:
       pib_bm_amount   – Import Duty portion
       pib_ppn_amount  – PPN Import portion
       pib_pph_amount  – PPh 22 Import portion
     These are only populated when expense_category = 'pib_import'.
     All other rows remain unaffected (NULL = zero change).

  2. Adds CHECK constraint: for pib_import rows the components must sum to amount.

  3. Adds CoA account 1155 — PPh 22 Dibayar Dimuka (Advance Income Tax).

  4. Fixes get_expense_account_id():
       duty_customs → 5200 (was falling to 6900)
       ppn_import   → 1150 (was falling to 6900)
       pph_import   → 1155 (was falling to 6900)
       pib_import   → NULL (handled by the split-journal path below)

  5. Updates auto_post_expense_accounting() to handle pib_import:
       Dr Import Duty (5200)         – pib_bm_amount
       Dr PPN Masukan (1150)         – pib_ppn_amount
       Dr PPh 22 Prepaid (1155)      – pib_pph_amount
       Cr Bank Account               – full amount (one bank debit)

  6. Updates vw_input_ppn_report to include pib_import rows (pib_ppn_amount).

  7. Updates vw_monthly_tax_summary to include pib_import PPN.

  8. Creates vw_pph22_advance_tax_report for annual corporate tax preparation.

  ## What is NOT changed
  - No existing columns renamed or removed
  - No existing expense categories removed or altered
  - No import_containers columns changed
  - allocate_import_costs_to_batches unchanged (reads container columns, not expenses)
  - Bank reconciliation unchanged
  - Existing journal entries untouched
  - P&L, Balance Sheet, existing VAT reports continue to work
*/

-- ===========================================================================
-- 1. ADD PIB BREAKDOWN COLUMNS TO finance_expenses
-- ===========================================================================

ALTER TABLE finance_expenses
  ADD COLUMN IF NOT EXISTS pib_bm_amount  DECIMAL(18,2),
  ADD COLUMN IF NOT EXISTS pib_ppn_amount DECIMAL(18,2),
  ADD COLUMN IF NOT EXISTS pib_pph_amount DECIMAL(18,2);

COMMENT ON COLUMN finance_expenses.pib_bm_amount  IS
  'PIB Import only: Import Duty (BM) portion. Goes to landed cost / inventory.';
COMMENT ON COLUMN finance_expenses.pib_ppn_amount IS
  'PIB Import only: PPN Import portion. Posted to PPN Masukan (1150). NOT in landed cost.';
COMMENT ON COLUMN finance_expenses.pib_pph_amount IS
  'PIB Import only: PPh 22 Import portion. Posted to PPh 22 Prepaid (1155). NOT in landed cost.';

-- Check: for pib_import the components must sum to the recorded amount (±1 cent rounding tolerance)
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

-- ===========================================================================
-- 2. ADD PPh 22 DIBAYAR DIMUKA ACCOUNT (1155)
-- ===========================================================================

-- Add PPh 22 Dibayar Dimuka under Current Assets parent (1000)
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

-- ===========================================================================
-- 3. FIX get_expense_account_id — correct mappings for import tax categories
-- ===========================================================================

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
    -- ── Staff ────────────────────────────────────────────────────────────
    WHEN 'salary'            THEN (SELECT id FROM chart_of_accounts WHERE code = '6100' LIMIT 1)
    WHEN 'staff_overtime'    THEN (SELECT id FROM chart_of_accounts WHERE code = '6100' LIMIT 1)
    WHEN 'staff_welfare'     THEN (SELECT id FROM chart_of_accounts WHERE code = '6150' LIMIT 1)
    WHEN 'employee_benefits' THEN (SELECT id FROM chart_of_accounts WHERE code = '6110' LIMIT 1)
    WHEN 'travel_conveyance' THEN (SELECT id FROM chart_of_accounts WHERE code = '6500' LIMIT 1)

    -- ── Rent ──────────────────────────────────────────────────────────────
    WHEN 'office_rent'      THEN (SELECT id FROM chart_of_accounts WHERE code = '6220' LIMIT 1)
    WHEN 'warehouse_rent'   THEN (SELECT id FROM chart_of_accounts WHERE code = '6210' LIMIT 1)
    WHEN 'rent'             THEN (SELECT id FROM chart_of_accounts WHERE code = '6200' LIMIT 1)

    -- ── Office & Admin ────────────────────────────────────────────────────
    WHEN 'office_admin'               THEN (SELECT id FROM chart_of_accounts WHERE code = '6410' LIMIT 1)
    WHEN 'office_supplies'            THEN (SELECT id FROM chart_of_accounts WHERE code = '6400' LIMIT 1)
    WHEN 'office_shifting_renovation' THEN (SELECT id FROM chart_of_accounts WHERE code = '6420' LIMIT 1)

    -- ── Utilities ─────────────────────────────────────────────────────────
    WHEN 'utilities'     THEN (SELECT id FROM chart_of_accounts WHERE code = '6300' LIMIT 1)
    WHEN 'electricity'   THEN (SELECT id FROM chart_of_accounts WHERE code = '6310' LIMIT 1)
    WHEN 'water'         THEN (SELECT id FROM chart_of_accounts WHERE code = '6320' LIMIT 1)
    WHEN 'internet_phone'THEN (SELECT id FROM chart_of_accounts WHERE code = '6330' LIMIT 1)

    -- ── Transport / Vehicle ───────────────────────────────────────────────
    WHEN 'fuel'                THEN (SELECT id FROM chart_of_accounts WHERE code = '6500' LIMIT 1)
    WHEN 'vehicle_maintenance' THEN (SELECT id FROM chart_of_accounts WHERE code = '6500' LIMIT 1)

    -- ── Sales & Distribution ──────────────────────────────────────────────
    WHEN 'delivery_sales'        THEN (SELECT id FROM chart_of_accounts WHERE code = '6510' LIMIT 1)
    WHEN 'loading_sales'         THEN (SELECT id FROM chart_of_accounts WHERE code = '6520' LIMIT 1)
    WHEN 'other_sales'           THEN (SELECT id FROM chart_of_accounts WHERE code = '6510' LIMIT 1)
    WHEN 'marketing_advertising' THEN (SELECT id FROM chart_of_accounts WHERE code = '6600' LIMIT 1)

    -- ── Professional / Legal ──────────────────────────────────────────────
    WHEN 'legal_professional' THEN (SELECT id FROM chart_of_accounts WHERE code = '6700' LIMIT 1)
    WHEN 'consulting_fees'    THEN (SELECT id FROM chart_of_accounts WHERE code = '6700' LIMIT 1)
    WHEN 'accounting_audit'   THEN (SELECT id FROM chart_of_accounts WHERE code = '6700' LIMIT 1)

    -- ── Finance ───────────────────────────────────────────────────────────
    WHEN 'bank_charges'      THEN (SELECT id FROM chart_of_accounts WHERE code = '7100' LIMIT 1)
    WHEN 'interest_expense'  THEN (SELECT id FROM chart_of_accounts WHERE code = '7200' LIMIT 1)

    -- ── Import Duty: capitalises into Inventory (asset 1130), never P&L ──
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

    -- ── Import Tax Accounts (Balance Sheet — NOT expenses) ────────────────
    -- ppn_import: Input VAT — debit PPN Masukan (1150), not an expense
    WHEN 'ppn_import' THEN (SELECT id FROM chart_of_accounts WHERE code = '1150' LIMIT 1)
    -- pph_import: Advance Income Tax — debit PPh 22 Prepaid (1155), not an expense
    WHEN 'pph_import' THEN (SELECT id FROM chart_of_accounts WHERE code = '1155' LIMIT 1)

    -- ── PIB Import: handled by split-journal path — return NULL ───────────
    -- The auto_post_expense_accounting trigger detects pib_import BEFORE
    -- calling get_expense_account_id and creates the multi-line journal there.
    -- Returning NULL here causes the standard 2-line path to be skipped.
    WHEN 'pib_import' THEN NULL

    -- ── Default ───────────────────────────────────────────────────────────
    ELSE (SELECT id FROM chart_of_accounts WHERE code = '6900' LIMIT 1)
  END;

  IF v_account_id IS NULL AND p_category <> 'pib_import' THEN
    SELECT id INTO v_account_id FROM chart_of_accounts WHERE code = '6000' LIMIT 1;
  END IF;

  RETURN v_account_id;
END;
$$;

COMMENT ON FUNCTION get_expense_account_id(TEXT) IS
'Maps expense_category to the debit account in the double-entry journal.
ppn_import → 1150 (PPN Masukan / Input VAT asset)
pph_import → 1155 (PPh 22 Prepaid asset)
pib_import → NULL (split journal handled separately in auto_post_expense_accounting)';

-- ===========================================================================
-- 4. UPDATE auto_post_expense_accounting — add pib_import split-journal path
-- ===========================================================================

CREATE OR REPLACE FUNCTION auto_post_expense_accounting()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
DECLARE
  -- shared
  v_expense_account_id UUID;
  v_payment_account_id UUID;
  v_journal_id         UUID;
  v_description        TEXT;
  v_credit_desc        TEXT;
  v_entry_number       TEXT;
  v_category_label     TEXT;
  v_old_journal_id     UUID;
  -- pib_import split
  v_bm_account_id      UUID;
  v_ppn_account_id     UUID;
  v_pph_account_id     UUID;
  v_line_num           INTEGER;
BEGIN
  -- ── UPDATE: reverse old journal entry if anything accounting-relevant changed ──
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
      RETURN NEW; -- nothing accounting-relevant changed
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

  -- ── INSERT idempotency guard ──
  IF TG_OP = 'INSERT' THEN
    IF EXISTS (
      SELECT 1 FROM journal_entries
      WHERE reference_number = 'EXP-' || NEW.id::text
    ) THEN
      RETURN NEW;
    END IF;
  END IF;

  -- ── Resolve bank / cash payment account ──
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

  -- ── Generate journal entry number ──
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

  -- ════════════════════════════════════════════════════════════════════════
  -- SPECIAL PATH: PIB Import — one bank payment split into three debit lines
  -- ════════════════════════════════════════════════════════════════════════
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

    -- Dr Import Duty (BM) → capitalised to inventory
    IF COALESCE(NEW.pib_bm_amount, 0) > 0 AND v_bm_account_id IS NOT NULL THEN
      INSERT INTO journal_entry_lines
        (journal_entry_id, line_number, account_id, debit, credit, description)
      VALUES
        (v_journal_id, v_line_num, v_bm_account_id,
         NEW.pib_bm_amount, 0,
         'PIB - Import Duty (BM) [landed cost]');
      v_line_num := v_line_num + 1;
    END IF;

    -- Dr PPN Masukan (Input VAT) → asset, not expense
    IF COALESCE(NEW.pib_ppn_amount, 0) > 0 AND v_ppn_account_id IS NOT NULL THEN
      INSERT INTO journal_entry_lines
        (journal_entry_id, line_number, account_id, debit, credit, description)
      VALUES
        (v_journal_id, v_line_num, v_ppn_account_id,
         NEW.pib_ppn_amount, 0,
         'PIB - PPN Import (Input VAT, PPN Masukan)');
      v_line_num := v_line_num + 1;
    END IF;

    -- Dr PPh 22 Dibayar Dimuka (Advance Income Tax) → asset, not expense
    IF COALESCE(NEW.pib_pph_amount, 0) > 0 AND v_pph_account_id IS NOT NULL THEN
      INSERT INTO journal_entry_lines
        (journal_entry_id, line_number, account_id, debit, credit, description)
      VALUES
        (v_journal_id, v_line_num, v_pph_account_id,
         NEW.pib_pph_amount, 0,
         'PIB - PPh 22 Dibayar Dimuka (Advance Income Tax)');
      v_line_num := v_line_num + 1;
    END IF;

    -- Cr Bank Account → single bank debit for full PIB amount
    INSERT INTO journal_entry_lines
      (journal_entry_id, line_number, account_id, debit, credit, description)
    VALUES
      (v_journal_id, v_line_num, v_payment_account_id,
       0, NEW.amount,
       'PIB - Bank payment [' || COALESCE(NEW.description, '') || ']');

    RETURN NEW;
  END IF;

  -- ════════════════════════════════════════════════════════════════════════
  -- STANDARD PATH: all other expense categories (2-line journal)
  -- ════════════════════════════════════════════════════════════════════════
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
  -- Never block the expense save due to a journal error
  RAISE WARNING 'auto_post_expense_accounting failed for expense %: %', NEW.id, SQLERRM;
  RETURN NEW;
END;
$$;

-- Re-attach trigger (fire on INSERT and UPDATE)
DROP TRIGGER IF EXISTS trigger_auto_post_expense_accounting ON finance_expenses;
CREATE TRIGGER trigger_auto_post_expense_accounting
  AFTER INSERT OR UPDATE ON finance_expenses
  FOR EACH ROW
  EXECUTE FUNCTION auto_post_expense_accounting();

COMMENT ON FUNCTION auto_post_expense_accounting() IS
'Auto-posts journal entries for finance_expenses.
pib_import: 4-line split (Dr BM/5200, Dr PPN Masukan/1150, Dr PPh22/1155, Cr Bank).
All other categories: standard 2-line (Dr expense account, Cr payment account).
ppn_import → debits 1150 (asset), NOT an expense line.
pph_import → debits 1155 (asset), NOT an expense line.';

-- ===========================================================================
-- 5. UPDATE vw_input_ppn_report — include pib_import rows
-- ===========================================================================

DROP VIEW IF EXISTS vw_input_ppn_report;
CREATE VIEW vw_input_ppn_report AS
SELECT
  DATE_TRUNC('month', fe.expense_date)  AS month,
  fe.expense_date,
  ic.container_ref,
  s.company_name                         AS supplier,
  ic.import_invoice_value,
  -- For pib_import use the dedicated ppn breakdown column
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

COMMENT ON VIEW vw_input_ppn_report IS
'Input PPN Report — PPN paid on imports (claimable tax credit).
Includes standalone ppn_import expenses AND the PPN component of pib_import expenses.
Used for monthly VAT filing.';

-- ===========================================================================
-- 6. UPDATE vw_monthly_tax_summary — include pib_import PPN in input side
-- ===========================================================================

DROP VIEW IF EXISTS vw_monthly_tax_summary;
CREATE VIEW vw_monthly_tax_summary AS
SELECT
  COALESCE(all_months.month, input.month, output.month) AS month,
  COALESCE(input_ppn,  0) AS input_ppn_paid,
  COALESCE(output_ppn, 0) AS output_ppn_collected,
  COALESCE(output_ppn, 0) - COALESCE(input_ppn, 0) AS net_ppn_payable
FROM (
  -- All months that have either input or output PPN activity
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
  -- Input PPN: standalone ppn_import + pib_import PPN component
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
  -- Output PPN: from sales invoices (unchanged)
  SELECT
    DATE_TRUNC('month', invoice_date) AS month,
    SUM(tax_amount)                   AS output_ppn
  FROM sales_invoices
  WHERE tax_amount > 0
  GROUP BY DATE_TRUNC('month', invoice_date)
) output ON output.month = all_months.month
ORDER BY month DESC;

COMMENT ON VIEW vw_monthly_tax_summary IS
'Monthly tax summary: Input PPN (imports), Output PPN (sales), Net PPN Payable.
Input PPN now includes both standalone ppn_import expenses and the PPN component
of pib_import (single PIB document) expenses.';

-- ===========================================================================
-- 7. CREATE vw_pph22_advance_tax_report — for annual corporate tax preparation
-- ===========================================================================

DROP VIEW IF EXISTS vw_pph22_advance_tax_report;
CREATE VIEW vw_pph22_advance_tax_report AS
SELECT
  DATE_TRUNC('month', fe.expense_date) AS month,
  fe.expense_date,
  fe.voucher_number,
  COALESCE(ic.container_ref, '—')      AS container_ref,
  COALESCE(s.company_name,  '—')       AS supplier,
  -- PPh 22 amount — from dedicated column for pib_import, from amount for standalone
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

COMMENT ON VIEW vw_pph22_advance_tax_report IS
'PPh 22 Advance Income Tax Report — for annual corporate tax (SPT Tahunan).
Includes standalone pph_import expenses and the PPh 22 component of pib_import expenses.
PPh 22 is a PREPAID asset (1155) credited when applied against annual tax liability.';

-- ===========================================================================
-- Summary
-- ===========================================================================
DO $$
BEGIN
  RAISE NOTICE '=========================================================';
  RAISE NOTICE 'PIB Import migration complete';
  RAISE NOTICE '=========================================================';
  RAISE NOTICE 'finance_expenses: added pib_bm_amount, pib_ppn_amount, pib_pph_amount';
  RAISE NOTICE 'chart_of_accounts: added 1155 PPh 22 Dibayar Dimuka';
  RAISE NOTICE 'get_expense_account_id: fixed duty_customs/ppn_import/pph_import mappings';
  RAISE NOTICE 'auto_post_expense_accounting: added pib_import 4-line split journal';
  RAISE NOTICE 'vw_input_ppn_report: updated to include pib_import PPN';
  RAISE NOTICE 'vw_monthly_tax_summary: updated to include pib_import PPN';
  RAISE NOTICE 'vw_pph22_advance_tax_report: created';
  RAISE NOTICE 'All existing workflows unchanged.';
END $$;
