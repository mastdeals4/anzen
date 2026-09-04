-- ============================================================================
-- Phase 2: Staff accounting on the ONE payment engine (2026-07-17)
--
-- Salary payable, salary payment, staff advance, advance recovery and the
-- staff running ledger all reuse the existing finance_expenses +
-- payment_vouchers + voucher_allocations + journal engine. No new tables,
-- no parallel ledgers.
--
--   * finance_expenses.staff_id           — identifies the staff member on
--     salary/advance/welfare expense rows (FK finance_staff_master).
--   * payment_vouchers.staff_id           — payee when paying a staff member
--     (supplier_id becomes nullable; exactly the same voucher/allocation/
--     posting path as supplier payments).
--   * expense_category 'staff_advance'    — posts Dr 1160 Staff Advances
--     (asset) instead of an expense account, via get_expense_account_id.
--   * payment_method 'advance_adjustment' — a payment voucher that settles a
--     salary bill by crediting 1160 Staff Advances instead of bank/cash
--     (advance recovery / deduction from salary). Allocations and
--     paid_amount recompute work unchanged because the engine only looks at
--     voucher_allocations.finance_expense_id.
--   * get_outstanding_expense_bills()     — now also returns staff_id /
--     staff_name so Payment Vouchers and Bank Reconciliation can settle
--     staff bills exactly like supplier bills.
--
-- Idempotent: ADD COLUMN IF NOT EXISTS / CREATE OR REPLACE / guarded DDL.
-- Existing rows and all supplier flows are unaffected (new columns nullable,
-- CHECKs only relaxed/extended).
-- ============================================================================

BEGIN;

-- ── 1. finance_expenses.staff_id ─────────────────────────────────────────────
ALTER TABLE public.finance_expenses
  ADD COLUMN IF NOT EXISTS staff_id UUID REFERENCES public.finance_staff_master(id);

COMMENT ON COLUMN public.finance_expenses.staff_id IS
  'Staff member this expense belongs to (salary, overtime, welfare, advance). NULL for non-staff expenses.';

CREATE INDEX IF NOT EXISTS idx_finance_expenses_staff
  ON public.finance_expenses(staff_id) WHERE staff_id IS NOT NULL;

-- ── 2. payment_vouchers: staff payee ─────────────────────────────────────────
ALTER TABLE public.payment_vouchers ALTER COLUMN supplier_id DROP NOT NULL;

ALTER TABLE public.payment_vouchers
  ADD COLUMN IF NOT EXISTS staff_id UUID REFERENCES public.finance_staff_master(id);

COMMENT ON COLUMN public.payment_vouchers.staff_id IS
  'Staff payee (salary payment / advance / advance adjustment). Mutually exclusive with supplier_id in practice; both nullable.';

CREATE INDEX IF NOT EXISTS idx_pv_staff
  ON public.payment_vouchers(staff_id) WHERE staff_id IS NOT NULL;

-- payment_method CHECK: add 'advance_adjustment'
ALTER TABLE public.payment_vouchers
  DROP CONSTRAINT IF EXISTS payment_vouchers_payment_method_check;
ALTER TABLE public.payment_vouchers
  ADD CONSTRAINT payment_vouchers_payment_method_check
  CHECK (payment_method IN ('cash', 'bank_transfer', 'check', 'giro', 'other', 'advance_adjustment'));

-- ── 3. expense_category CHECK: add 'staff_advance' ───────────────────────────
ALTER TABLE public.finance_expenses
  DROP CONSTRAINT IF EXISTS finance_expenses_expense_category_check;

ALTER TABLE public.finance_expenses
  ADD CONSTRAINT finance_expenses_expense_category_check
  CHECK (expense_category = ANY (ARRAY[
    'duty_customs'::text, 'ppn_import'::text, 'pph_import'::text,
    'freight_import'::text, 'clearing_forwarding'::text, 'port_charges'::text,
    'container_handling'::text, 'transport_import'::text, 'loading_import'::text,
    'bpom_ski_fees'::text, 'other_import'::text, 'pib_import'::text,
    'import_broker'::text,
    'delivery_sales'::text, 'loading_sales'::text, 'other_sales'::text,
    'salary'::text, 'staff_overtime'::text, 'staff_welfare'::text,
    'travel_conveyance'::text, 'warehouse_rent'::text, 'utilities'::text,
    'bank_charges'::text, 'office_admin'::text, 'office_shifting_renovation'::text,
    'duty'::text, 'freight'::text, 'office'::text, 'other'::text,
    'fixed_asset'::text, 'professional_services'::text,
    'staff_advance'::text   -- NEW: Dr Staff Advances (asset), not P&L
  ]));

-- ── 4. Seed COA 1160 Staff Advances (asset) if absent ────────────────────────
INSERT INTO public.chart_of_accounts (code, name, account_type, is_header, normal_balance, is_active, created_at)
  SELECT '1160', 'Staff Advances', 'asset', false, 'debit', true, now()
  WHERE NOT EXISTS (SELECT 1 FROM public.chart_of_accounts WHERE code = '1160');

-- ── 5. get_expense_account_id(): staff_advance → 1160 ────────────────────────
-- Full replacement of the 20260702100000 version + one new branch.
CREATE OR REPLACE FUNCTION public.get_expense_account_id(p_category TEXT)
RETURNS UUID
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_account_id UUID;
BEGIN
  v_account_id := CASE p_category
    WHEN 'salary'                    THEN (SELECT id FROM chart_of_accounts WHERE code = '6100' LIMIT 1)
    WHEN 'staff_overtime'            THEN (SELECT id FROM chart_of_accounts WHERE code = '6100' LIMIT 1)
    WHEN 'staff_welfare'             THEN (SELECT id FROM chart_of_accounts WHERE code = '6150' LIMIT 1)
    WHEN 'employee_benefits'         THEN (SELECT id FROM chart_of_accounts WHERE code = '6110' LIMIT 1)
    WHEN 'travel_conveyance'         THEN (SELECT id FROM chart_of_accounts WHERE code = '6500' LIMIT 1)
    WHEN 'office_rent'               THEN (SELECT id FROM chart_of_accounts WHERE code = '6220' LIMIT 1)
    WHEN 'warehouse_rent'            THEN (SELECT id FROM chart_of_accounts WHERE code = '6210' LIMIT 1)
    WHEN 'rent'                      THEN (SELECT id FROM chart_of_accounts WHERE code = '6200' LIMIT 1)
    WHEN 'office_admin'              THEN (SELECT id FROM chart_of_accounts WHERE code = '6410' LIMIT 1)
    WHEN 'office_supplies'           THEN (SELECT id FROM chart_of_accounts WHERE code = '6400' LIMIT 1)
    WHEN 'office_shifting_renovation'THEN (SELECT id FROM chart_of_accounts WHERE code = '6420' LIMIT 1)
    WHEN 'utilities'                 THEN (SELECT id FROM chart_of_accounts WHERE code = '6300' LIMIT 1)
    WHEN 'electricity'               THEN (SELECT id FROM chart_of_accounts WHERE code = '6310' LIMIT 1)
    WHEN 'water'                     THEN (SELECT id FROM chart_of_accounts WHERE code = '6320' LIMIT 1)
    WHEN 'internet_phone'            THEN (SELECT id FROM chart_of_accounts WHERE code = '6330' LIMIT 1)
    WHEN 'fuel'                      THEN (SELECT id FROM chart_of_accounts WHERE code = '6500' LIMIT 1)
    WHEN 'vehicle_maintenance'       THEN (SELECT id FROM chart_of_accounts WHERE code = '6500' LIMIT 1)
    WHEN 'delivery_sales'            THEN (SELECT id FROM chart_of_accounts WHERE code = '6510' LIMIT 1)
    WHEN 'loading_sales'             THEN (SELECT id FROM chart_of_accounts WHERE code = '6520' LIMIT 1)
    WHEN 'other_sales'               THEN (SELECT id FROM chart_of_accounts WHERE code = '6510' LIMIT 1)
    WHEN 'marketing_advertising'     THEN (SELECT id FROM chart_of_accounts WHERE code = '6600' LIMIT 1)
    WHEN 'legal_professional'        THEN (SELECT id FROM chart_of_accounts WHERE code = '6700' LIMIT 1)
    WHEN 'consulting_fees'           THEN (SELECT id FROM chart_of_accounts WHERE code = '6700' LIMIT 1)
    WHEN 'accounting_audit'          THEN (SELECT id FROM chart_of_accounts WHERE code = '6700' LIMIT 1)
    WHEN 'professional_services'     THEN (SELECT id FROM chart_of_accounts WHERE code = '6410' LIMIT 1)
    WHEN 'staff_advance'             THEN (SELECT id FROM chart_of_accounts WHERE code = '1160' LIMIT 1)  -- NEW: asset
    WHEN 'bank_charges'              THEN (SELECT id FROM chart_of_accounts WHERE code = '7100' LIMIT 1)
    WHEN 'interest_expense'          THEN (SELECT id FROM chart_of_accounts WHERE code = '7200' LIMIT 1)
    WHEN 'duty_customs'              THEN (SELECT id FROM chart_of_accounts WHERE code = '1130' LIMIT 1)
    WHEN 'duty_import'               THEN (SELECT id FROM chart_of_accounts WHERE code = '1130' LIMIT 1)
    WHEN 'freight_import'            THEN (SELECT id FROM chart_of_accounts WHERE code = '5300' LIMIT 1)
    WHEN 'clearing_forwarding'       THEN (SELECT id FROM chart_of_accounts WHERE code = '5300' LIMIT 1)
    WHEN 'port_charges'              THEN (SELECT id FROM chart_of_accounts WHERE code = '5300' LIMIT 1)
    WHEN 'container_handling'        THEN (SELECT id FROM chart_of_accounts WHERE code = '5300' LIMIT 1)
    WHEN 'transport_import'          THEN (SELECT id FROM chart_of_accounts WHERE code = '5300' LIMIT 1)
    WHEN 'loading_import'            THEN (SELECT id FROM chart_of_accounts WHERE code = '5300' LIMIT 1)
    WHEN 'import_broker'             THEN (SELECT id FROM chart_of_accounts WHERE code = '5300' LIMIT 1)
    WHEN 'bpom_ski_fees'             THEN (SELECT id FROM chart_of_accounts WHERE code = '5410' LIMIT 1)
    WHEN 'other_import'              THEN (SELECT id FROM chart_of_accounts WHERE code = '5400' LIMIT 1)
    WHEN 'ppn_import'                THEN (SELECT id FROM chart_of_accounts WHERE code = '1150' LIMIT 1)
    WHEN 'pph_import'                THEN (SELECT id FROM chart_of_accounts WHERE code = '1155' LIMIT 1)
    WHEN 'pib_import'                THEN NULL  -- PIB handled by dedicated path; no single account
    WHEN 'duty'                      THEN (SELECT id FROM chart_of_accounts WHERE code = '1130' LIMIT 1)
    WHEN 'freight'                   THEN (SELECT id FROM chart_of_accounts WHERE code = '5300' LIMIT 1)
    WHEN 'office'                    THEN (SELECT id FROM chart_of_accounts WHERE code = '6400' LIMIT 1)
    WHEN 'other'                     THEN (SELECT id FROM chart_of_accounts WHERE code = '6900' LIMIT 1)
    -- fixed_asset handled separately in auto_post_expense_accounting(); NULL here is correct
    WHEN 'fixed_asset'               THEN NULL
    ELSE (SELECT id FROM chart_of_accounts WHERE code = '6900' LIMIT 1)
  END;

  IF v_account_id IS NULL AND p_category NOT IN ('pib_import', 'fixed_asset') THEN
    SELECT id INTO v_account_id FROM chart_of_accounts WHERE code = '6000' LIMIT 1;
  END IF;

  RETURN v_account_id;
END;
$$;

-- ── 6. save_payment_voucher_with_allocations(): +p_staff_id ──────────────────
-- Signature changes (new optional param), so drop the old signature first to
-- avoid a PostgREST PGRST203 overload ambiguity for named-arg callers.
DROP FUNCTION IF EXISTS public.save_payment_voucher_with_allocations(
  uuid, text, date, uuid, text, uuid, text, numeric, numeric, uuid,
  text, text, numeric, numeric, numeric, uuid, jsonb);

CREATE OR REPLACE FUNCTION public.save_payment_voucher_with_allocations(
  p_voucher_id        uuid        DEFAULT NULL,
  p_voucher_number    text        DEFAULT NULL,
  p_voucher_date      date        DEFAULT NULL,
  p_supplier_id       uuid        DEFAULT NULL,
  p_payment_method    text        DEFAULT NULL,
  p_bank_account_id   uuid        DEFAULT NULL,
  p_reference_number  text        DEFAULT NULL,
  p_amount            numeric     DEFAULT 0,
  p_pph_amount        numeric     DEFAULT 0,
  p_pph_code_id       uuid        DEFAULT NULL,
  p_description       text        DEFAULT NULL,
  p_payment_currency  text        DEFAULT 'IDR',
  p_exchange_rate     numeric     DEFAULT 1,
  p_bank_amount       numeric     DEFAULT NULL,
  p_bank_charge       numeric     DEFAULT 0,
  p_created_by        uuid        DEFAULT NULL,
  p_allocations       jsonb       DEFAULT '[]'::jsonb,
  p_staff_id          uuid        DEFAULT NULL
)
RETURNS uuid
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_voucher_id    UUID;
  v_alloc         JSONB;
  v_invoice_id    UUID;
  v_expense_id    UUID;
  v_alloc_amount  NUMERIC;
BEGIN
  IF auth.uid() IS NULL THEN
    RAISE EXCEPTION 'Not authenticated';
  END IF;

  IF p_supplier_id IS NULL AND p_staff_id IS NULL THEN
    RAISE EXCEPTION 'Payment voucher needs a payee: supplier or staff';
  END IF;

  -- ── Create or update the voucher header ──
  IF p_voucher_id IS NULL THEN
    INSERT INTO payment_vouchers (
      voucher_number, voucher_date, supplier_id, staff_id, payment_method,
      bank_account_id, reference_number, amount, pph_amount, pph_code_id,
      description, payment_currency, exchange_rate,
      bank_amount, bank_charge, created_by
    ) VALUES (
      p_voucher_number, p_voucher_date, p_supplier_id, p_staff_id, p_payment_method,
      p_bank_account_id, p_reference_number, p_amount, p_pph_amount, p_pph_code_id,
      p_description, p_payment_currency, p_exchange_rate,
      p_bank_amount, p_bank_charge, p_created_by
    ) RETURNING id INTO v_voucher_id;
  ELSE
    v_voucher_id := p_voucher_id;

    IF EXISTS (SELECT 1 FROM payment_vouchers WHERE id = v_voucher_id AND is_posted = TRUE) THEN
      RAISE EXCEPTION 'Cannot edit: % is posted. Cancel Posting first to make changes.', p_voucher_number;
    END IF;

    UPDATE payment_vouchers SET
      voucher_date      = p_voucher_date,
      supplier_id       = p_supplier_id,
      staff_id          = p_staff_id,
      payment_method    = p_payment_method,
      bank_account_id   = p_bank_account_id,
      reference_number  = p_reference_number,
      amount            = p_amount,
      pph_amount        = p_pph_amount,
      pph_code_id       = p_pph_code_id,
      description       = p_description,
      payment_currency  = p_payment_currency,
      exchange_rate     = p_exchange_rate,
      bank_amount       = p_bank_amount,
      bank_charge       = p_bank_charge,
      updated_at        = NOW()
    WHERE id = v_voucher_id;
  END IF;

  -- ── Replace all allocations ──
  DELETE FROM voucher_allocations WHERE payment_voucher_id = v_voucher_id;

  FOR v_alloc IN SELECT value FROM jsonb_array_elements(p_allocations) AS value
  LOOP
    v_alloc_amount := COALESCE((v_alloc->>'amount')::NUMERIC, 0);
    IF v_alloc_amount <= 0 THEN
      CONTINUE;
    END IF;

    v_invoice_id := NULLIF(v_alloc->>'invoice_id', '')::UUID;
    v_expense_id := NULLIF(v_alloc->>'finance_expense_id', '')::UUID;

    IF v_invoice_id IS NOT NULL THEN
      INSERT INTO voucher_allocations (
        payment_voucher_id, purchase_invoice_id,
        allocated_amount, allocated_currency, voucher_type
      ) VALUES (
        v_voucher_id, v_invoice_id, v_alloc_amount,
        COALESCE(v_alloc->>'currency', 'IDR'), 'payment'
      );
    ELSIF v_expense_id IS NOT NULL THEN
      INSERT INTO voucher_allocations (
        payment_voucher_id, finance_expense_id,
        allocated_amount, allocated_currency, voucher_type
      ) VALUES (
        v_voucher_id, v_expense_id, v_alloc_amount,
        COALESCE(v_alloc->>'currency', 'IDR'), 'payment'
      );
      -- paid_amount on finance_expenses updated by trg_sync_expense_payment_state
    END IF;
  END LOOP;

  RETURN v_voucher_id;
END;
$$;

REVOKE ALL ON FUNCTION public.save_payment_voucher_with_allocations(
  uuid, text, date, uuid, text, uuid, text, numeric, numeric, uuid,
  text, text, numeric, numeric, numeric, uuid, jsonb, uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.save_payment_voucher_with_allocations(
  uuid, text, date, uuid, text, uuid, text, numeric, numeric, uuid,
  text, text, numeric, numeric, numeric, uuid, jsonb, uuid) TO authenticated;

-- ── 7. post_payment_voucher(): advance_adjustment credits 1160 ───────────────
-- Full replacement of the 20260629 (batch3) version. Only changes:
--   * payment_method = 'advance_adjustment' → credit COA 1160 Staff Advances
--     (Dr A/P 2110 or custom, Cr Staff Advances — advance recovery).
--   * journal lines still carry supplier_id (NULL for staff payees — the
--     staff link lives on payment_vouchers.staff_id).
CREATE OR REPLACE FUNCTION public.post_payment_voucher(
  p_pv_id     uuid,
  p_posted_by uuid
)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_pv                RECORD;
  v_je_id             UUID;
  v_je_number         TEXT;
  v_credit_account_id UUID;
  v_debit_account_id  UUID;
  v_pph_account_id    UUID;
  v_net_amount        NUMERIC;
  v_line_num          INT := 1;
BEGIN
  IF auth.uid() IS NULL THEN
    RAISE EXCEPTION 'Not authenticated';
  END IF;

  SELECT * INTO v_pv FROM payment_vouchers WHERE id = p_pv_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'Payment voucher % not found', p_pv_id; END IF;
  IF v_pv.is_posted THEN RAISE EXCEPTION 'Payment voucher % is already posted', v_pv.voucher_number; END IF;

  IF v_pv.payment_method = 'advance_adjustment' THEN
    -- Settle against Staff Advances (asset) instead of bank/cash
    SELECT id INTO v_credit_account_id FROM chart_of_accounts WHERE code = '1160' LIMIT 1;
    IF v_credit_account_id IS NULL THEN
      RAISE EXCEPTION 'Cannot post: Staff Advances account (1160) missing';
    END IF;
  ELSIF v_pv.bank_account_id IS NOT NULL THEN
    SELECT coa_id INTO v_credit_account_id FROM bank_accounts WHERE id = v_pv.bank_account_id;
  ELSIF v_pv.payment_method = 'cash' THEN
    SELECT id INTO v_credit_account_id FROM chart_of_accounts WHERE code = '1101' LIMIT 1;
  END IF;
  IF v_credit_account_id IS NULL THEN
    SELECT id INTO v_credit_account_id FROM chart_of_accounts WHERE code = '1111' LIMIT 1;
  END IF;

  IF v_pv.coa_account_id IS NOT NULL THEN
    v_debit_account_id := v_pv.coa_account_id;
  ELSE
    SELECT id INTO v_debit_account_id FROM chart_of_accounts WHERE code = '2110' LIMIT 1;
  END IF;

  SELECT id INTO v_pph_account_id FROM chart_of_accounts WHERE code = '2132' LIMIT 1;

  IF v_credit_account_id IS NULL OR v_debit_account_id IS NULL THEN
    RAISE EXCEPTION 'Cannot post: required chart of accounts entries missing';
  END IF;

  v_net_amount := v_pv.amount - COALESCE(v_pv.pph_amount, 0);
  v_je_number  := next_journal_entry_number();

  INSERT INTO journal_entries (
    entry_number, entry_date, source_module, reference_id, reference_number,
    description, total_debit, total_credit, is_posted, posted_by
  ) VALUES (
    v_je_number, v_pv.voucher_date, 'payment', v_pv.id, v_pv.voucher_number,
    'Payment Voucher: ' || v_pv.voucher_number,
    v_pv.amount, v_pv.amount, TRUE, p_posted_by
  ) RETURNING id INTO v_je_id;

  INSERT INTO journal_entry_lines (journal_entry_id, line_number, account_id, description, debit, credit, supplier_id)
  VALUES (v_je_id, v_line_num, v_debit_account_id, 'Payment - ' || v_pv.voucher_number, v_pv.amount, 0, v_pv.supplier_id);
  v_line_num := v_line_num + 1;

  IF COALESCE(v_pv.pph_amount, 0) > 0 AND v_pph_account_id IS NOT NULL THEN
    INSERT INTO journal_entry_lines (journal_entry_id, line_number, account_id, description, debit, credit, supplier_id)
    VALUES (v_je_id, v_line_num, v_pph_account_id, 'PPh Withholding - ' || v_pv.voucher_number, 0, v_pv.pph_amount, v_pv.supplier_id);
    v_line_num := v_line_num + 1;
  END IF;

  INSERT INTO journal_entry_lines (journal_entry_id, line_number, account_id, description, debit, credit, supplier_id)
  VALUES (v_je_id, v_line_num, v_credit_account_id,
          CASE WHEN v_pv.payment_method = 'advance_adjustment'
               THEN 'Advance Adjustment - ' || v_pv.voucher_number
               ELSE 'Cash Payment - ' || v_pv.voucher_number END,
          0, v_net_amount, v_pv.supplier_id);

  UPDATE payment_vouchers
  SET is_posted = TRUE, journal_entry_id = v_je_id
  WHERE id = p_pv_id;

  INSERT INTO audit_logs (table_name, record_id, action_type, old_values, new_values, user_id)
  VALUES (
    'payment_vouchers', p_pv_id, 'update',
    jsonb_build_object('is_posted', FALSE),
    jsonb_build_object('is_posted', TRUE, 'journal_entry_id', v_je_id, 'journal_entry_number', v_je_number, 'posted_by', p_posted_by),
    p_posted_by
  );
END;
$$;

REVOKE ALL ON FUNCTION public.post_payment_voucher(uuid, uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.post_payment_voucher(uuid, uuid) TO authenticated;

-- ── 8. get_outstanding_expense_bills(): +staff_id / staff_name ───────────────
DROP FUNCTION IF EXISTS public.get_outstanding_expense_bills(date);

CREATE OR REPLACE FUNCTION public.get_outstanding_expense_bills(
  p_as_of_date DATE DEFAULT CURRENT_DATE
)
RETURNS TABLE (
  id               UUID,
  supplier_id      UUID,
  supplier_name    TEXT,
  staff_id         UUID,
  staff_name       TEXT,
  invoice_number   TEXT,
  invoice_date     DATE,
  due_date         DATE,
  expense_category TEXT,
  description      TEXT,
  amount           NUMERIC,
  paid_amount      NUMERIC,
  balance_amount   NUMERIC,
  days_overdue     INTEGER
)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  IF auth.uid() IS NULL THEN
    RAISE EXCEPTION 'Not authenticated';
  END IF;

  RETURN QUERY
  SELECT
    fe.id,
    fe.supplier_id,
    s.company_name::TEXT            AS supplier_name,
    fe.staff_id,
    sm.full_name::TEXT              AS staff_name,
    fe.invoice_number::TEXT,
    fe.expense_date                 AS invoice_date,
    fe.due_date,
    fe.expense_category::TEXT,
    fe.description::TEXT,
    fe.amount,
    COALESCE(fe.paid_amount, 0)     AS paid_amount,
    fe.amount - COALESCE(fe.paid_amount, 0) AS balance_amount,
    CASE
      WHEN fe.due_date IS NOT NULL AND fe.due_date < p_as_of_date
        THEN (p_as_of_date - fe.due_date)::INTEGER
      ELSE 0
    END                             AS days_overdue
  FROM public.finance_expenses fe
  LEFT JOIN public.suppliers s            ON s.id  = fe.supplier_id
  LEFT JOIN public.finance_staff_master sm ON sm.id = fe.staff_id
  WHERE fe.payment_method IS NULL
    AND fe.amount > COALESCE(fe.paid_amount, 0)
    AND fe.expense_date <= p_as_of_date
  ORDER BY COALESCE(fe.due_date, fe.expense_date);
END;
$$;

GRANT EXECUTE ON FUNCTION public.get_outstanding_expense_bills(DATE) TO authenticated;
REVOKE EXECUTE ON FUNCTION public.get_outstanding_expense_bills(DATE) FROM anon;

COMMIT;

DO $$
BEGIN
  RAISE NOTICE '============================================================';
  RAISE NOTICE 'Migration 20260717120000 applied:';
  RAISE NOTICE '  finance_expenses: +staff_id (FK finance_staff_master)';
  RAISE NOTICE '  payment_vouchers: supplier_id nullable, +staff_id,';
  RAISE NOTICE '    payment_method +advance_adjustment';
  RAISE NOTICE '  expense_category: +staff_advance (Dr 1160 Staff Advances)';
  RAISE NOTICE '  COA 1160 Staff Advances seeded (if not present)';
  RAISE NOTICE '  save_payment_voucher_with_allocations(): +p_staff_id';
  RAISE NOTICE '  post_payment_voucher(): advance_adjustment credits 1160';
  RAISE NOTICE '  get_outstanding_expense_bills(): +staff_id/staff_name';
  RAISE NOTICE '  All existing supplier/purchase flows unchanged.';
  RAISE NOTICE '============================================================';
END $$;
