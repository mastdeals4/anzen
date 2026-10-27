-- ============================================================================
-- Migration: 20260701100000_finance_tax_upgrade
-- Date:      2026-07-01
--
-- 1. Add stamp_duty_amount to purchase_invoices and sales_invoices
-- 2. Add ppn_amount, pph_amount, pph_code_id, stamp_duty_amount,
--    fixed_asset_account_id to finance_expenses
-- 3. Update expense_category CHECK: add pib_import (was missing) + fixed_asset
-- 4. Insert COA accounts: 6950 (Bea Meterai Expense), 2135 (Bea Meterai Payable)
-- 5. Replace save_purchase_invoice() to handle stamp_duty_amount JE line
--    and fix the GENERATED ALWAYS balance_amount INSERT bug
-- 6. Replace auto_post_expense_accounting() for fixed_asset + ppn/pph/stamp_duty
-- 7. Replace post_sales_invoice_journal() for stamp_duty_amount
-- ============================================================================

-- ── 1. Add stamp_duty_amount to purchase_invoices ─────────────────────────

ALTER TABLE purchase_invoices
  ADD COLUMN IF NOT EXISTS stamp_duty_amount NUMERIC(18,2) DEFAULT 0;

-- ── 2. Add stamp_duty_amount to sales_invoices ─────────────────────────────

ALTER TABLE sales_invoices
  ADD COLUMN IF NOT EXISTS stamp_duty_amount NUMERIC(18,2) DEFAULT 0;

-- ── 3. Add tax columns to finance_expenses ─────────────────────────────────

ALTER TABLE finance_expenses
  ADD COLUMN IF NOT EXISTS ppn_amount             NUMERIC(18,2) DEFAULT 0,
  ADD COLUMN IF NOT EXISTS pph_amount             NUMERIC(18,2) DEFAULT 0,
  ADD COLUMN IF NOT EXISTS pph_code_id            UUID REFERENCES tax_codes(id),
  ADD COLUMN IF NOT EXISTS stamp_duty_amount      NUMERIC(18,2) DEFAULT 0,
  ADD COLUMN IF NOT EXISTS fixed_asset_account_id UUID REFERENCES chart_of_accounts(id);

-- ── 4. Update expense_category CHECK (add pib_import that was missing + fixed_asset) ──

ALTER TABLE finance_expenses DROP CONSTRAINT IF EXISTS finance_expenses_expense_category_check;
ALTER TABLE finance_expenses ADD CONSTRAINT finance_expenses_expense_category_check
  CHECK (expense_category = ANY (ARRAY[
    'duty_customs'::text,
    'ppn_import'::text,
    'pph_import'::text,
    'freight_import'::text,
    'clearing_forwarding'::text,
    'port_charges'::text,
    'container_handling'::text,
    'transport_import'::text,
    'loading_import'::text,
    'bpom_ski_fees'::text,
    'other_import'::text,
    'pib_import'::text,
    'delivery_sales'::text,
    'loading_sales'::text,
    'other_sales'::text,
    'salary'::text,
    'staff_overtime'::text,
    'staff_welfare'::text,
    'travel_conveyance'::text,
    'warehouse_rent'::text,
    'utilities'::text,
    'bank_charges'::text,
    'office_admin'::text,
    'office_shifting_renovation'::text,
    'duty'::text,
    'freight'::text,
    'office'::text,
    'other'::text,
    'fixed_asset'::text
  ]));

-- ── 5. Insert COA accounts ──────────────────────────────────────────────────

INSERT INTO chart_of_accounts (code, name, account_type, is_header, normal_balance, is_active, created_at)
  SELECT '6950', 'Bea Meterai Expense', 'expense', false, 'debit', true, now()
  WHERE NOT EXISTS (SELECT 1 FROM chart_of_accounts WHERE code = '6950');

INSERT INTO chart_of_accounts (code, name, account_type, is_header, normal_balance, is_active, created_at)
  SELECT '2135', 'Bea Meterai Payable', 'liability', false, 'credit', true, now()
  WHERE NOT EXISTS (SELECT 1 FROM chart_of_accounts WHERE code = '2135');

-- ── 6. Replace save_purchase_invoice() ────────────────────────────────────
-- Changes vs previous version:
--   a. Accepts stamp_duty_amount from p_invoice_data, posts DR 6950 if > 0
--   b. Removed balance_amount from INSERT column list (it is GENERATED ALWAYS)

CREATE OR REPLACE FUNCTION public.save_purchase_invoice(
  p_invoice_id   UUID,
  p_invoice_data JSONB,
  p_items        JSONB
)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_invoice_id        UUID;
  v_je_id             UUID;
  v_je_number         TEXT;
  v_ap_account_id     UUID;
  v_ppn_account_id    UUID;
  v_bm_account_id     UUID;
  v_account_id        UUID;
  v_item              JSONB;
  v_line_number       INTEGER;
  v_invoice_date      DATE;
  v_invoice_number    TEXT;
  v_supplier_id       UUID;
  v_total_amount      NUMERIC(15,2);
  v_tax_amount        NUMERIC(15,2);
  v_stamp_duty_amount NUMERIC(15,2);
  v_created_by        UUID;
  v_item_type         TEXT;
  v_line_total        NUMERIC(15,2);
BEGIN
  v_created_by        := auth.uid();
  v_invoice_date      := (p_invoice_data->>'invoice_date')::DATE;
  v_invoice_number    := p_invoice_data->>'invoice_number';
  v_total_amount      := (p_invoice_data->>'total_amount')::NUMERIC(15,2);
  v_tax_amount        := COALESCE((p_invoice_data->>'tax_amount')::NUMERIC(15,2), 0);
  v_stamp_duty_amount := COALESCE((p_invoice_data->>'stamp_duty_amount')::NUMERIC(15,2), 0);
  v_supplier_id       := (p_invoice_data->>'supplier_id')::UUID;

  SELECT id INTO v_ap_account_id  FROM chart_of_accounts WHERE code = '2110' LIMIT 1;
  SELECT id INTO v_ppn_account_id FROM chart_of_accounts WHERE code = '1150' LIMIT 1;
  SELECT id INTO v_bm_account_id  FROM chart_of_accounts WHERE code = '6950' LIMIT 1;

  IF v_ap_account_id IS NULL THEN
    RAISE EXCEPTION 'A/P account (code 2110) not found in chart of accounts';
  END IF;

  PERFORM pg_advisory_xact_lock(hashtext('je_number_' || TO_CHAR(v_invoice_date, 'YYMM')));

  IF p_invoice_id IS NULL THEN
    -- ── CREATE path ──────────────────────────────────────────────────────────

    v_je_number := 'JE-' || TO_CHAR(v_invoice_date, 'YYMM') || '-' || LPAD((
      SELECT COALESCE(MAX(CAST(SUBSTRING(entry_number FROM '(\d+)$') AS INTEGER)), 0) + 1
      FROM journal_entries
      WHERE entry_number LIKE 'JE-' || TO_CHAR(v_invoice_date, 'YYMM') || '-%'
    )::TEXT, 4, '0');

    INSERT INTO journal_entries (
      entry_number, entry_date, source_module, reference_id, reference_number,
      description, total_debit, total_credit, is_posted, posted_by, created_by
    ) VALUES (
      v_je_number, v_invoice_date, 'purchase_invoice', gen_random_uuid(), v_invoice_number,
      'Purchase Invoice: ' || v_invoice_number,
      0, v_total_amount, TRUE, v_created_by, v_created_by
    ) RETURNING id INTO v_je_id;

    -- balance_amount is GENERATED ALWAYS AS (total_amount - paid_amount); omit from INSERT
    INSERT INTO purchase_invoices (
      invoice_number, supplier_id, invoice_date, due_date,
      currency, exchange_rate, subtotal, tax_amount, stamp_duty_amount, total_amount,
      paid_amount, status,
      faktur_pajak_number, notes, document_urls,
      requires_faktur_pajak, purchase_type,
      journal_entry_id, created_by
    ) VALUES (
      v_invoice_number,
      v_supplier_id,
      v_invoice_date,
      NULLIF(p_invoice_data->>'due_date', '')::DATE,
      COALESCE(p_invoice_data->>'currency', 'IDR'),
      COALESCE((p_invoice_data->>'exchange_rate')::NUMERIC, 1),
      COALESCE((p_invoice_data->>'subtotal')::NUMERIC, 0),
      v_tax_amount,
      v_stamp_duty_amount,
      v_total_amount,
      0,
      'unpaid',
      NULLIF(p_invoice_data->>'faktur_pajak_number', ''),
      NULLIF(p_invoice_data->>'notes', ''),
      CASE
        WHEN p_invoice_data -> 'document_urls' IS NOT NULL
          AND jsonb_array_length(p_invoice_data -> 'document_urls') > 0
        THEN ARRAY(SELECT jsonb_array_elements_text(p_invoice_data -> 'document_urls'))
        ELSE NULL
      END,
      COALESCE((p_invoice_data->>'requires_faktur_pajak')::BOOLEAN, FALSE),
      COALESCE(p_invoice_data->>'purchase_type', 'inventory'),
      v_je_id,
      v_created_by
    ) RETURNING id INTO v_invoice_id;

    UPDATE journal_entries SET reference_id = v_invoice_id WHERE id = v_je_id;

  ELSE
    -- ── EDIT path ──────────────────────────────────────────────────────────

    v_invoice_id := p_invoice_id;

    SELECT journal_entry_id INTO v_je_id
    FROM purchase_invoices WHERE id = v_invoice_id;

    -- balance_amount is GENERATED ALWAYS; do not include in UPDATE SET
    UPDATE purchase_invoices SET
      invoice_number        = v_invoice_number,
      supplier_id           = v_supplier_id,
      invoice_date          = v_invoice_date,
      due_date              = NULLIF(p_invoice_data->>'due_date', '')::DATE,
      currency              = COALESCE(p_invoice_data->>'currency', 'IDR'),
      exchange_rate         = COALESCE((p_invoice_data->>'exchange_rate')::NUMERIC, 1),
      subtotal              = COALESCE((p_invoice_data->>'subtotal')::NUMERIC, 0),
      tax_amount            = v_tax_amount,
      stamp_duty_amount     = v_stamp_duty_amount,
      total_amount          = v_total_amount,
      faktur_pajak_number   = NULLIF(p_invoice_data->>'faktur_pajak_number', ''),
      notes                 = NULLIF(p_invoice_data->>'notes', ''),
      document_urls         = CASE
                                WHEN p_invoice_data -> 'document_urls' IS NOT NULL
                                  AND jsonb_array_length(p_invoice_data -> 'document_urls') > 0
                                THEN ARRAY(SELECT jsonb_array_elements_text(p_invoice_data -> 'document_urls'))
                                ELSE NULL
                              END,
      requires_faktur_pajak = COALESCE((p_invoice_data->>'requires_faktur_pajak')::BOOLEAN, FALSE),
      purchase_type         = COALESCE(p_invoice_data->>'purchase_type', 'inventory'),
      updated_at            = NOW()
    WHERE id = v_invoice_id;

    DELETE FROM purchase_invoice_items WHERE purchase_invoice_id = v_invoice_id;

    IF v_je_id IS NOT NULL THEN
      DELETE FROM journal_entry_lines WHERE journal_entry_id = v_je_id;
      UPDATE journal_entries SET
        entry_date       = v_invoice_date,
        reference_number = v_invoice_number,
        description      = 'Purchase Invoice: ' || v_invoice_number,
        total_debit      = 0,
        total_credit     = v_total_amount
      WHERE id = v_je_id;
    ELSE
      v_je_number := 'JE-' || TO_CHAR(v_invoice_date, 'YYMM') || '-' || LPAD((
        SELECT COALESCE(MAX(CAST(SUBSTRING(entry_number FROM '(\d+)$') AS INTEGER)), 0) + 1
        FROM journal_entries
        WHERE entry_number LIKE 'JE-' || TO_CHAR(v_invoice_date, 'YYMM') || '-%'
      )::TEXT, 4, '0');

      INSERT INTO journal_entries (
        entry_number, entry_date, source_module, reference_id, reference_number,
        description, total_debit, total_credit, is_posted, posted_by, created_by
      ) VALUES (
        v_je_number, v_invoice_date, 'purchase_invoice', v_invoice_id, v_invoice_number,
        'Purchase Invoice: ' || v_invoice_number,
        0, v_total_amount, TRUE, v_created_by, v_created_by
      ) RETURNING id INTO v_je_id;

      UPDATE purchase_invoices SET journal_entry_id = v_je_id WHERE id = v_invoice_id;
    END IF;
  END IF;

  -- ── Insert items and build JE debit lines ─────────────────────────────────
  v_line_number := 1;

  FOR v_item IN SELECT * FROM jsonb_array_elements(p_items)
  LOOP
    v_item_type  := v_item->>'item_type';
    v_line_total := COALESCE((v_item->>'line_total')::NUMERIC(15,2), 0);

    INSERT INTO purchase_invoice_items (
      purchase_invoice_id, item_type, product_id, description,
      quantity, unit, unit_price, discount_percent, line_total,
      tax_amount, expense_account_id, asset_account_id
    ) VALUES (
      v_invoice_id,
      v_item_type,
      NULLIF(v_item->>'product_id', '')::UUID,
      v_item->>'description',
      COALESCE((v_item->>'quantity')::NUMERIC, 1),
      v_item->>'unit',
      COALESCE((v_item->>'unit_price')::NUMERIC, 0),
      (v_item->>'discount_percent')::NUMERIC,
      v_line_total,
      (v_item->>'tax_amount')::NUMERIC,
      NULLIF(v_item->>'expense_account_id', '')::UUID,
      NULLIF(v_item->>'asset_account_id',   '')::UUID
    );

    IF v_item_type = 'inventory' THEN
      SELECT id INTO v_account_id FROM chart_of_accounts WHERE code = '1130' LIMIT 1;
    ELSIF v_item_type = 'fixed_asset' THEN
      v_account_id := NULLIF(v_item->>'asset_account_id', '')::UUID;
      IF v_account_id IS NULL THEN
        SELECT id INTO v_account_id FROM chart_of_accounts WHERE code = '1200' LIMIT 1;
      END IF;
    ELSE
      v_account_id := NULLIF(v_item->>'expense_account_id', '')::UUID;
      IF v_account_id IS NULL THEN
        SELECT id INTO v_account_id FROM chart_of_accounts WHERE code = '5100' LIMIT 1;
      END IF;
    END IF;

    IF v_account_id IS NOT NULL AND v_line_total <> 0 THEN
      INSERT INTO journal_entry_lines (
        journal_entry_id, line_number, account_id, description,
        debit, credit, supplier_id
      ) VALUES (
        v_je_id, v_line_number, v_account_id,
        COALESCE(LEFT(v_item->>'description', 100), 'Purchase Item'),
        v_line_total, 0, v_supplier_id
      );
      v_line_number := v_line_number + 1;
    END IF;
  END LOOP;

  -- PPN Input debit line (DR 1150)
  IF v_tax_amount > 0 AND v_ppn_account_id IS NOT NULL THEN
    INSERT INTO journal_entry_lines (
      journal_entry_id, line_number, account_id, description,
      debit, credit, supplier_id
    ) VALUES (
      v_je_id, v_line_number, v_ppn_account_id,
      'PPN Input - ' || v_invoice_number,
      v_tax_amount, 0, v_supplier_id
    );
    v_line_number := v_line_number + 1;
  END IF;

  -- Stamp Duty debit line (DR 6950 Bea Meterai Expense)
  IF v_stamp_duty_amount > 0 AND v_bm_account_id IS NOT NULL THEN
    INSERT INTO journal_entry_lines (
      journal_entry_id, line_number, account_id, description,
      debit, credit, supplier_id
    ) VALUES (
      v_je_id, v_line_number, v_bm_account_id,
      'Bea Meterai - ' || v_invoice_number,
      v_stamp_duty_amount, 0, v_supplier_id
    );
    v_line_number := v_line_number + 1;
  END IF;

  -- A/P credit line (total_amount = subtotal + ppn + stamp_duty)
  INSERT INTO journal_entry_lines (
    journal_entry_id, line_number, account_id, description,
    debit, credit, supplier_id
  ) VALUES (
    v_je_id, v_line_number, v_ap_account_id,
    'A/P - ' || v_invoice_number,
    0, v_total_amount, v_supplier_id
  );

  -- Reconcile JE totals from actual inserted lines
  UPDATE journal_entries SET
    total_debit  = (SELECT COALESCE(SUM(debit),  0) FROM journal_entry_lines WHERE journal_entry_id = v_je_id),
    total_credit = (SELECT COALESCE(SUM(credit), 0) FROM journal_entry_lines WHERE journal_entry_id = v_je_id)
  WHERE id = v_je_id;

  RETURN jsonb_build_object(
    'invoice_id',       v_invoice_id,
    'journal_entry_id', v_je_id
  );
END;
$$;

-- ── 7. Replace auto_post_expense_accounting() ─────────────────────────────
-- Adds: fixed_asset category, ppn/pph/stamp_duty for standard non-PIB expenses
-- Accounting for standard expense with taxes:
--   DR Expense (amount)
--   DR PPN Input 1150 (ppn_amount, if any)
--   DR Bea Meterai 6950 (stamp_duty_amount, if any)
--   CR PPh Payable 2132 (pph_amount, if any — withheld, paid to govt later)
--   CR Bank/Cash (amount + ppn - pph + stamp_duty = net payment)

CREATE OR REPLACE FUNCTION public.auto_post_expense_accounting()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_expense_account_id    UUID;
  v_payment_account_id    UUID;
  v_journal_id            UUID;
  v_description           TEXT;
  v_credit_desc           TEXT;
  v_entry_number          TEXT;
  v_category_label        TEXT;
  v_bm_account_id         UUID;
  v_ppn_account_id        UUID;
  v_pph_account_id        UUID;
  v_stamp_duty_account_id UUID;
  v_line_num              INTEGER;
  v_net_payment           NUMERIC(18,2);
BEGIN
  IF TG_OP = 'UPDATE' THEN
    IF (
      OLD.amount                 = NEW.amount AND
      OLD.expense_category       = NEW.expense_category AND
      OLD.payment_method         IS NOT DISTINCT FROM NEW.payment_method AND
      OLD.bank_account_id        IS NOT DISTINCT FROM NEW.bank_account_id AND
      OLD.pib_bm_amount          IS NOT DISTINCT FROM NEW.pib_bm_amount AND
      OLD.pib_ppn_amount         IS NOT DISTINCT FROM NEW.pib_ppn_amount AND
      OLD.pib_pph_amount         IS NOT DISTINCT FROM NEW.pib_pph_amount AND
      OLD.ppn_amount             IS NOT DISTINCT FROM NEW.ppn_amount AND
      OLD.pph_amount             IS NOT DISTINCT FROM NEW.pph_amount AND
      OLD.stamp_duty_amount      IS NOT DISTINCT FROM NEW.stamp_duty_amount AND
      OLD.fixed_asset_account_id IS NOT DISTINCT FROM NEW.fixed_asset_account_id
    ) THEN
      RETURN NEW;
    END IF;

    DELETE FROM journal_entry_lines
    WHERE journal_entry_id IN (
      SELECT id FROM journal_entries
      WHERE reference_number = 'EXP-' || NEW.id::text
    );
    DELETE FROM journal_entries
    WHERE reference_number = 'EXP-' || NEW.id::text;
  END IF;

  IF TG_OP = 'INSERT' THEN
    IF EXISTS (
      SELECT 1 FROM journal_entries
      WHERE reference_number = 'EXP-' || NEW.id::text
    ) THEN
      RETURN NEW;
    END IF;
  END IF;

  -- Resolve payment/credit account
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

  -- ── PIB Import path (unchanged) ─────────────────────────────────────────
  IF NEW.expense_category = 'pib_import' THEN

    v_bm_account_id  := get_expense_account_id('duty_customs');
    v_ppn_account_id := get_expense_account_id('ppn_import');
    v_pph_account_id := get_expense_account_id('pph_import');

    INSERT INTO journal_entries (
      entry_number, entry_date, source_module, reference_number,
      description, transaction_category,
      total_debit, total_credit, is_posted, posted_at, created_by
    ) VALUES (
      v_entry_number, NEW.expense_date, 'expenses', 'EXP-' || NEW.id::text,
      COALESCE(NEW.description, 'PIB Import Payment'), 'pib_import',
      NEW.amount, NEW.amount, true, now(), NEW.created_by
    ) RETURNING id INTO v_journal_id;

    v_line_num := 1;

    IF COALESCE(NEW.pib_bm_amount, 0) > 0 AND v_bm_account_id IS NOT NULL THEN
      INSERT INTO journal_entry_lines (journal_entry_id, line_number, account_id, debit, credit, description)
      VALUES (v_journal_id, v_line_num, v_bm_account_id, NEW.pib_bm_amount, 0, 'PIB - Import Duty (BM) [landed cost]');
      v_line_num := v_line_num + 1;
    END IF;

    IF COALESCE(NEW.pib_ppn_amount, 0) > 0 AND v_ppn_account_id IS NOT NULL THEN
      INSERT INTO journal_entry_lines (journal_entry_id, line_number, account_id, debit, credit, description)
      VALUES (v_journal_id, v_line_num, v_ppn_account_id, NEW.pib_ppn_amount, 0, 'PIB - PPN Import (Input VAT, PPN Masukan)');
      v_line_num := v_line_num + 1;
    END IF;

    IF COALESCE(NEW.pib_pph_amount, 0) > 0 AND v_pph_account_id IS NOT NULL THEN
      INSERT INTO journal_entry_lines (journal_entry_id, line_number, account_id, debit, credit, description)
      VALUES (v_journal_id, v_line_num, v_pph_account_id, NEW.pib_pph_amount, 0, 'PIB - PPh 22 Dibayar Dimuka (Advance Income Tax)');
      v_line_num := v_line_num + 1;
    END IF;

    INSERT INTO journal_entry_lines (journal_entry_id, line_number, account_id, debit, credit, description)
    VALUES (v_journal_id, v_line_num, v_payment_account_id, 0, NEW.amount, 'PIB - Bank payment [' || COALESCE(NEW.description, '') || ']');

    RETURN NEW;
  END IF;

  -- ── Fixed Asset category ─────────────────────────────────────────────────
  IF NEW.expense_category = 'fixed_asset' THEN
    v_expense_account_id := NEW.fixed_asset_account_id;
    IF v_expense_account_id IS NULL THEN
      SELECT id INTO v_expense_account_id FROM chart_of_accounts WHERE code = '1200' LIMIT 1;
    END IF;
    IF v_expense_account_id IS NULL THEN RETURN NEW; END IF;

    v_description := COALESCE(NEW.description, 'Fixed Asset Purchase');

    INSERT INTO journal_entries (
      entry_number, entry_date, source_module, reference_number,
      description, transaction_category,
      total_debit, total_credit, is_posted, posted_at, created_by
    ) VALUES (
      v_entry_number, NEW.expense_date, 'expenses', 'EXP-' || NEW.id::text,
      v_description, 'fixed_asset',
      NEW.amount, NEW.amount, true, now(), NEW.created_by
    ) RETURNING id INTO v_journal_id;

    INSERT INTO journal_entry_lines (journal_entry_id, line_number, account_id, debit, credit, description)
    VALUES (v_journal_id, 1, v_expense_account_id, NEW.amount, 0, v_description);

    INSERT INTO journal_entry_lines (journal_entry_id, line_number, account_id, debit, credit, description)
    VALUES (v_journal_id, 2, v_payment_account_id, 0, NEW.amount, v_description);

    RETURN NEW;
  END IF;

  -- ── Standard expense path (non-PIB, non-fixed-asset) ────────────────────
  v_expense_account_id := get_expense_account_id(NEW.expense_category);
  IF v_expense_account_id IS NULL THEN RETURN NEW; END IF;

  v_category_label := REPLACE(INITCAP(REPLACE(NEW.expense_category, '_', ' ')), ' ', ' ');
  v_description    := COALESCE(NEW.description, NEW.expense_category);
  v_credit_desc    := COALESCE(SUBSTRING(NEW.description FROM '^[^\n]+'), NEW.expense_category) || ' [' || v_category_label || ']';

  SELECT id INTO v_ppn_account_id      FROM chart_of_accounts WHERE code = '1150' LIMIT 1;
  SELECT id INTO v_pph_account_id      FROM chart_of_accounts WHERE code = '2132' LIMIT 1;
  SELECT id INTO v_stamp_duty_account_id FROM chart_of_accounts WHERE code = '6950' LIMIT 1;

  -- net bank payment = gross expense + PPN paid - PPh withheld + stamp duty
  v_net_payment := NEW.amount
    + COALESCE(NEW.ppn_amount, 0)
    - COALESCE(NEW.pph_amount, 0)
    + COALESCE(NEW.stamp_duty_amount, 0);

  INSERT INTO journal_entries (
    entry_number, entry_date, source_module, reference_number,
    description, transaction_category,
    total_debit, total_credit, is_posted, posted_at, created_by
  ) VALUES (
    v_entry_number, NEW.expense_date, 'expenses', 'EXP-' || NEW.id::text,
    v_description, NEW.expense_category,
    -- total_debit = expense + ppn + stamp_duty
    -- total_credit = pph + net_payment = pph + (amount+ppn-pph+stamp_duty) = amount+ppn+stamp_duty ✓
    NEW.amount + COALESCE(NEW.ppn_amount, 0) + COALESCE(NEW.stamp_duty_amount, 0),
    NEW.amount + COALESCE(NEW.ppn_amount, 0) + COALESCE(NEW.stamp_duty_amount, 0),
    true, now(), NEW.created_by
  ) RETURNING id INTO v_journal_id;

  v_line_num := 1;

  -- DR: Expense
  INSERT INTO journal_entry_lines (journal_entry_id, line_number, account_id, debit, credit, description)
  VALUES (v_journal_id, v_line_num, v_expense_account_id, NEW.amount, 0, v_credit_desc);
  v_line_num := v_line_num + 1;

  -- DR: PPN Input (company recovers this as input tax credit)
  IF COALESCE(NEW.ppn_amount, 0) > 0 AND v_ppn_account_id IS NOT NULL THEN
    INSERT INTO journal_entry_lines (journal_entry_id, line_number, account_id, debit, credit, description)
    VALUES (v_journal_id, v_line_num, v_ppn_account_id, NEW.ppn_amount, 0, 'PPN Masukan - ' || v_description);
    v_line_num := v_line_num + 1;
  END IF;

  -- DR: Stamp Duty Expense
  IF COALESCE(NEW.stamp_duty_amount, 0) > 0 AND v_stamp_duty_account_id IS NOT NULL THEN
    INSERT INTO journal_entry_lines (journal_entry_id, line_number, account_id, debit, credit, description)
    VALUES (v_journal_id, v_line_num, v_stamp_duty_account_id, NEW.stamp_duty_amount, 0, 'Bea Meterai - ' || v_description);
    v_line_num := v_line_num + 1;
  END IF;

  -- CR: PPh Payable (withheld from vendor, paid to govt separately)
  IF COALESCE(NEW.pph_amount, 0) > 0 AND v_pph_account_id IS NOT NULL THEN
    INSERT INTO journal_entry_lines (journal_entry_id, line_number, account_id, debit, credit, description)
    VALUES (v_journal_id, v_line_num, v_pph_account_id, 0, NEW.pph_amount, 'PPh Ditahan - ' || v_description);
    v_line_num := v_line_num + 1;
  END IF;

  -- CR: Payment Account (bank/cash) = net amount leaving the account
  INSERT INTO journal_entry_lines (journal_entry_id, line_number, account_id, debit, credit, description)
  VALUES (v_journal_id, v_line_num, v_payment_account_id, 0, v_net_payment, v_credit_desc);

  RETURN NEW;

EXCEPTION WHEN OTHERS THEN
  RAISE WARNING 'auto_post_expense_accounting failed for expense %: %', NEW.id, SQLERRM;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trigger_auto_post_expense_accounting ON public.finance_expenses;
CREATE TRIGGER trigger_auto_post_expense_accounting
  AFTER INSERT OR UPDATE ON public.finance_expenses
  FOR EACH ROW
  EXECUTE FUNCTION public.auto_post_expense_accounting();

-- ── 8. Replace post_sales_invoice_journal() for stamp_duty_amount ──────────
-- Adds: CR 2135 Bea Meterai Payable when stamp_duty_amount > 0
-- total_amount must equal subtotal + tax_amount + stamp_duty_amount (UI ensures this)

CREATE OR REPLACE FUNCTION public.post_sales_invoice_journal()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $function$
DECLARE
v_existing_je_id       UUID;
v_je_id                UUID;
v_je_number            TEXT;
v_ar_account_id        UUID;
v_revenue_account_id   UUID;
v_tax_account_id       UUID;
v_bm_payable_id        UUID;
v_cogs_account_id      UUID;
v_inventory_account_id UUID;
v_item                 RECORD;
v_line_num             INTEGER := 1;
v_total_cost           NUMERIC := 0;
v_item_cost            NUMERIC;
v_total_debit          NUMERIC := 0;
v_total_credit         NUMERIC := 0;
v_stamp_duty           NUMERIC;
BEGIN
-- Strict idempotency: JE already set → skip
IF NEW.journal_entry_id IS NOT NULL THEN
  RETURN NEW;
END IF;

SELECT id INTO v_existing_je_id
FROM journal_entries
WHERE source_module = 'sales_invoice'
  AND reference_id = NEW.id
LIMIT 1;

IF v_existing_je_id IS NOT NULL THEN
  NEW.journal_entry_id := v_existing_je_id;
  RETURN NEW;
END IF;

IF NEW.payment_status NOT IN ('pending', 'partial', 'paid') THEN
  RETURN NEW;
END IF;

SELECT id INTO v_ar_account_id        FROM chart_of_accounts WHERE code = '1120' LIMIT 1;
SELECT id INTO v_revenue_account_id   FROM chart_of_accounts WHERE code = '4100' LIMIT 1;
SELECT id INTO v_tax_account_id       FROM chart_of_accounts WHERE code = '2130' LIMIT 1;
SELECT id INTO v_bm_payable_id        FROM chart_of_accounts WHERE code = '2135' LIMIT 1;
SELECT id INTO v_cogs_account_id      FROM chart_of_accounts WHERE code = '5100' LIMIT 1;
SELECT id INTO v_inventory_account_id FROM chart_of_accounts WHERE code = '1130' LIMIT 1;

IF v_ar_account_id IS NULL OR v_revenue_account_id IS NULL THEN
  RETURN NEW;
END IF;

v_stamp_duty := COALESCE(NEW.stamp_duty_amount, 0);

v_je_number := next_journal_entry_number();

INSERT INTO journal_entries (
  entry_number, entry_date, source_module, reference_id, reference_number,
  description, total_debit, total_credit, is_posted, posted_by, created_by
) VALUES (
  v_je_number, NEW.invoice_date, 'sales_invoice', NEW.id, NEW.invoice_number,
  'Sales Invoice: ' || NEW.invoice_number,
  NEW.total_amount, NEW.total_amount, true, NEW.created_by, NEW.created_by
) RETURNING id INTO v_je_id;

-- Dr: Accounts Receivable (full total including stamp duty if any)
INSERT INTO journal_entry_lines (journal_entry_id, line_number, account_id, description, debit, credit, customer_id)
VALUES (v_je_id, v_line_num, v_ar_account_id, 'A/R - ' || NEW.invoice_number, NEW.total_amount, 0, NEW.customer_id);
v_line_num := v_line_num + 1;

-- Cr: Sales Revenue (subtotal only)
INSERT INTO journal_entry_lines (journal_entry_id, line_number, account_id, description, debit, credit, customer_id)
VALUES (v_je_id, v_line_num, v_revenue_account_id, 'Sales - ' || NEW.invoice_number, 0, NEW.subtotal, NEW.customer_id);
v_line_num := v_line_num + 1;

-- Cr: PPN Output (if any)
IF COALESCE(NEW.tax_amount, 0) > 0 AND v_tax_account_id IS NOT NULL THEN
  INSERT INTO journal_entry_lines (journal_entry_id, line_number, account_id, description, debit, credit, customer_id)
  VALUES (v_je_id, v_line_num, v_tax_account_id, 'PPN - ' || NEW.invoice_number, 0, NEW.tax_amount, NEW.customer_id);
  v_line_num := v_line_num + 1;
END IF;

-- Cr: Bea Meterai Payable (collected from customer, paid to govt later)
IF v_stamp_duty > 0 AND v_bm_payable_id IS NOT NULL THEN
  INSERT INTO journal_entry_lines (journal_entry_id, line_number, account_id, description, debit, credit, customer_id)
  VALUES (v_je_id, v_line_num, v_bm_payable_id, 'Bea Meterai - ' || NEW.invoice_number, 0, v_stamp_duty, NEW.customer_id);
  v_line_num := v_line_num + 1;
END IF;

-- COGS entries
IF v_cogs_account_id IS NOT NULL AND v_inventory_account_id IS NOT NULL THEN
  FOR v_item IN
    SELECT sii.quantity, b.cost_per_unit, b.id as batch_id
    FROM sales_invoice_items sii
    LEFT JOIN batches b ON b.id = sii.batch_id
    WHERE sii.invoice_id = NEW.id AND sii.batch_id IS NOT NULL
  LOOP
    v_item_cost  := COALESCE(v_item.cost_per_unit, 0) * v_item.quantity;
    v_total_cost := v_total_cost + v_item_cost;
  END LOOP;

  IF v_total_cost > 0 THEN
    INSERT INTO journal_entry_lines (journal_entry_id, line_number, account_id, description, debit, credit, customer_id)
    VALUES (v_je_id, v_line_num, v_cogs_account_id, 'COGS - ' || NEW.invoice_number, v_total_cost, 0, NEW.customer_id);
    v_line_num := v_line_num + 1;

    INSERT INTO journal_entry_lines (journal_entry_id, line_number, account_id, description, debit, credit, customer_id)
    VALUES (v_je_id, v_line_num, v_inventory_account_id, 'Inventory - ' || NEW.invoice_number, 0, v_total_cost, NEW.customer_id);
  END IF;
END IF;

v_total_debit  := COALESCE(NEW.total_amount, 0) + COALESCE(v_total_cost, 0);
v_total_credit := COALESCE(NEW.subtotal, 0)
               + COALESCE(NEW.tax_amount, 0)
               + v_stamp_duty
               + COALESCE(v_total_cost, 0);

IF v_total_debit <> v_total_credit THEN
  RAISE EXCEPTION 'Journal not balanced: debit=% credit=%', v_total_debit, v_total_credit;
END IF;

NEW.journal_entry_id := v_je_id;
RETURN NEW;

EXCEPTION
  WHEN OTHERS THEN
    RAISE LOG 'post_sales_invoice_journal failed for invoice %: %', NEW.id, SQLERRM;
    RAISE;
END;
$function$;

-- ── 9. Fix update_sales_invoice_atomic() — add stamp_duty_amount to UPDATE ──
-- Both overloads (4-arg jsonb items and 3-arg jsonb[] items) must persist
-- stamp_duty_amount when editing a sales invoice.

-- 4-arg overload (used by Sales.tsx edit path)
CREATE OR REPLACE FUNCTION public.update_sales_invoice_atomic(
  p_invoice_id uuid,
  p_invoice_updates jsonb,
  p_items jsonb,
  p_user_id uuid DEFAULT NULL::uuid
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public', 'pg_temp'
AS $$
DECLARE
  v_role text;
  v_invoice RECORD;
  v_old_je_id UUID;
  v_item JSONB;
  v_batch_id UUID;
  v_result JSONB;
BEGIN
  SELECT role INTO v_role FROM user_profiles WHERE id = auth.uid();
  IF v_role NOT IN ('admin', 'accounts', 'sales', 'manager') THEN
    RAISE EXCEPTION 'Permission denied: role % cannot update sales invoices', v_role;
  END IF;

  SELECT * INTO v_invoice FROM sales_invoices WHERE id = p_invoice_id FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Invoice not found';
  END IF;

  v_old_je_id := v_invoice.journal_entry_id;

  IF v_old_je_id IS NOT NULL THEN
    DELETE FROM journal_entry_lines WHERE journal_entry_id = v_old_je_id;
    DELETE FROM journal_entries WHERE id = v_old_je_id;
  END IF;

  UPDATE sales_invoices SET journal_entry_id = NULL WHERE id = p_invoice_id;

  DELETE FROM sales_invoice_items WHERE invoice_id = p_invoice_id;

  UPDATE sales_invoices
  SET
    invoice_date       = COALESCE((p_invoice_updates->>'invoice_date')::DATE, invoice_date),
    due_date           = COALESCE((p_invoice_updates->>'due_date')::DATE, due_date),
    customer_id        = COALESCE((p_invoice_updates->>'customer_id')::UUID, customer_id),
    subtotal           = COALESCE((p_invoice_updates->>'subtotal')::NUMERIC, subtotal),
    tax_amount         = COALESCE((p_invoice_updates->>'tax_amount')::NUMERIC, tax_amount),
    total_amount       = COALESCE((p_invoice_updates->>'total_amount')::NUMERIC, total_amount),
    discount_amount    = COALESCE((p_invoice_updates->>'discount_amount')::NUMERIC, discount_amount),
    stamp_duty_amount  = COALESCE((p_invoice_updates->>'stamp_duty_amount')::NUMERIC, stamp_duty_amount),
    notes              = COALESCE(p_invoice_updates->>'notes', notes),
    currency           = COALESCE(p_invoice_updates->>'currency', currency),
    exchange_rate      = COALESCE((p_invoice_updates->>'exchange_rate')::NUMERIC, exchange_rate),
    linked_challan_ids = CASE
      WHEN p_invoice_updates ? 'linked_challan_ids'
      THEN (SELECT ARRAY(SELECT jsonb_array_elements_text(p_invoice_updates->'linked_challan_ids'))::UUID[])
      ELSE linked_challan_ids
    END,
    updated_at = now()
  WHERE id = p_invoice_id;

  FOR v_item IN SELECT * FROM jsonb_array_elements(p_items)
  LOOP
    v_batch_id := NULLIF((v_item->>'batch_id')::TEXT, '')::UUID;

    INSERT INTO sales_invoice_items (
      invoice_id, product_id, batch_id, quantity, unit_price, discount_percent,
      line_total, dc_item_id, unit_type
    ) VALUES (
      p_invoice_id,
      (v_item->>'product_id')::UUID,
      v_batch_id,
      (v_item->>'quantity')::NUMERIC,
      (v_item->>'unit_price')::NUMERIC,
      COALESCE((v_item->>'discount_percent')::NUMERIC, 0),
      (v_item->>'line_total')::NUMERIC,
      NULLIF((v_item->>'dc_item_id')::TEXT, '')::UUID,
      COALESCE(v_item->>'unit_type', 'pcs')
    );
  END LOOP;

  UPDATE sales_invoices
  SET status = status
  WHERE id = p_invoice_id AND journal_entry_id IS NULL;

  SELECT journal_entry_id INTO v_invoice.journal_entry_id FROM sales_invoices WHERE id = p_invoice_id;

  RETURN jsonb_build_object(
    'success', true,
    'invoice_id', p_invoice_id,
    'journal_reversed', v_old_je_id IS NOT NULL,
    'journal_entry_id', v_invoice.journal_entry_id
  );

EXCEPTION WHEN OTHERS THEN
  RAISE EXCEPTION 'Failed to update invoice: %', SQLERRM;
END;
$$;

-- 3-arg overload
CREATE OR REPLACE FUNCTION public.update_sales_invoice_atomic(
  p_invoice_id uuid,
  p_invoice_updates jsonb,
  p_new_items jsonb[]
)
RETURNS uuid
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $$
DECLARE
  v_role text;
  v_result UUID;
BEGIN
  SELECT role INTO v_role FROM user_profiles WHERE id = auth.uid();
  IF v_role NOT IN ('admin', 'accounts', 'sales', 'manager') THEN
    RAISE EXCEPTION 'Permission denied: role % cannot update sales invoices', v_role;
  END IF;

  DELETE FROM sales_invoice_items WHERE invoice_id = p_invoice_id;

  UPDATE sales_invoices
  SET
    invoice_date        = COALESCE((p_invoice_updates->>'invoice_date')::date, invoice_date),
    due_date            = COALESCE((p_invoice_updates->>'due_date')::date, due_date),
    customer_id         = COALESCE((p_invoice_updates->>'customer_id')::uuid, customer_id),
    subtotal            = COALESCE((p_invoice_updates->>'subtotal')::numeric, subtotal),
    tax_amount          = COALESCE((p_invoice_updates->>'tax_amount')::numeric, tax_amount),
    total_amount        = COALESCE((p_invoice_updates->>'total_amount')::numeric, total_amount),
    discount_amount     = COALESCE((p_invoice_updates->>'discount_amount')::numeric, discount_amount),
    stamp_duty_amount   = COALESCE((p_invoice_updates->>'stamp_duty_amount')::numeric, stamp_duty_amount),
    po_number           = COALESCE(p_invoice_updates->>'po_number', po_number),
    payment_terms_days  = COALESCE((p_invoice_updates->>'payment_terms_days')::integer, payment_terms_days),
    notes               = COALESCE(p_invoice_updates->>'notes', notes),
    updated_at          = NOW()
  WHERE id = p_invoice_id
  RETURNING id INTO v_result;

  INSERT INTO sales_invoice_items (
    invoice_id, product_id, batch_id, quantity, unit_price, tax_rate, delivery_challan_item_id
  )
  SELECT
    p_invoice_id,
    (item->>'product_id')::uuid,
    (item->>'batch_id')::uuid,
    (item->>'quantity')::numeric,
    (item->>'unit_price')::numeric,
    (item->>'tax_rate')::numeric,
    (item->>'delivery_challan_item_id')::uuid
  FROM unnest(p_new_items) AS item;

  RETURN v_result;
END;
$$;

DO $$
BEGIN
  RAISE NOTICE '============================================================';
  RAISE NOTICE 'Migration 20260701100000 applied:';
  RAISE NOTICE '  stamp_duty_amount added to purchase_invoices, sales_invoices';
  RAISE NOTICE '  ppn_amount, pph_amount, pph_code_id, stamp_duty_amount,';
  RAISE NOTICE '  fixed_asset_account_id added to finance_expenses';
  RAISE NOTICE '  expense_category CHECK updated: pib_import + fixed_asset added';
  RAISE NOTICE '  COA 6950 Bea Meterai Expense inserted (if not exists)';
  RAISE NOTICE '  COA 2135 Bea Meterai Payable inserted (if not exists)';
  RAISE NOTICE '  save_purchase_invoice() updated: stamp duty JE line + balance_amount fix';
  RAISE NOTICE '  auto_post_expense_accounting() updated: fixed_asset + ppn/pph/stamp_duty';
  RAISE NOTICE '  post_sales_invoice_journal() updated: stamp duty CR 2135';
  RAISE NOTICE '  update_sales_invoice_atomic() both overloads: stamp_duty_amount added';
  RAISE NOTICE '============================================================';
END $$;
