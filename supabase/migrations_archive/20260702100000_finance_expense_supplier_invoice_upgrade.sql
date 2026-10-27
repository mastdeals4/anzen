-- ============================================================================
-- Migration: 20260702100000_finance_expense_supplier_invoice_upgrade
-- Date:      2026-07-02
--
-- OBJECTIVE: Convert the Expense module into a proper Supplier Invoice /
-- Expense Bill module while preserving ALL existing accounting logic.
--
-- WHAT THIS MIGRATION DOES:
--   1. Add supplier preference columns to suppliers table
--   2. Add supplier invoice columns to finance_expenses
--   3. Add 'professional_services' to expense_category CHECK
--   4. Update get_expense_account_id() to map professional_services → 6410
--   5. Seed COA account 6410 (Professional Fees) if not present
--   6. Extend voucher_allocations to support expense bill payments
--   7. Add expense payment state sync (recalculate + trigger)
--   8. Extend save_payment_voucher_with_allocations() to handle finance_expense_id
--   9. New RPC: get_outstanding_expense_bills()
--  10. New RPC: get_asset_register()
--  11. Indexes
--
-- WHAT THIS MIGRATION DOES NOT CHANGE:
--   - auto_post_expense_accounting() — unchanged (handles outstanding via NULL payment_method)
--   - save_purchase_invoice(), post_sales_invoice_journal() — unchanged
--   - post_payment_voucher(), post_receipt_voucher() — unchanged
--   - PIB workflow — unchanged
--   - All existing journal entries — unchanged
--   - All existing reports (trial balance, P&L, balance sheet) — unchanged
--
-- BACKWARD COMPATIBILITY:
--   All new columns are nullable with defaults. Existing rows are unaffected.
--   Existing voucher_allocations rows have finance_expense_id = NULL.
--   The updated CHECK on voucher_allocations relaxes (not tightens) the constraint.
-- ============================================================================

-- ── 1. Supplier master: default preferences ──────────────────────────────────
-- All nullable so existing supplier records remain valid without migration.
-- tax_preference: 'none' | 'ppn_only' | 'ppn_pph' | 'pph_only'

ALTER TABLE public.suppliers
  ADD COLUMN IF NOT EXISTS default_expense_category VARCHAR(100),
  ADD COLUMN IF NOT EXISTS default_pph_code_id      UUID REFERENCES public.tax_codes(id),
  ADD COLUMN IF NOT EXISTS tax_preference            VARCHAR(20) DEFAULT 'none'
    CHECK (tax_preference IN ('none', 'ppn_only', 'ppn_pph', 'pph_only'));

COMMENT ON COLUMN public.suppliers.default_expense_category IS 'Auto-fill expense category when this supplier is selected in Expense entry';
COMMENT ON COLUMN public.suppliers.default_pph_code_id      IS 'Default PPh withholding tax code for this supplier';
COMMENT ON COLUMN public.suppliers.tax_preference           IS 'Which tax fields to show by default: none | ppn_only | ppn_pph | pph_only';

-- ── 2. finance_expenses: supplier invoice fields ─────────────────────────────
-- supplier_id: optional link to supplier master
-- invoice_number: supplier's invoice number for payables matching
-- due_date: payment due date (auto-calculated from supplier payment_terms_days)
-- paid_amount: maintained by trigger from voucher_allocations; 0 for cash/bank expenses

ALTER TABLE public.finance_expenses
  ADD COLUMN IF NOT EXISTS supplier_id    UUID REFERENCES public.suppliers(id),
  ADD COLUMN IF NOT EXISTS invoice_number VARCHAR(100),
  ADD COLUMN IF NOT EXISTS due_date       DATE,
  ADD COLUMN IF NOT EXISTS paid_amount    NUMERIC(18,2) NOT NULL DEFAULT 0;

COMMENT ON COLUMN public.finance_expenses.supplier_id    IS 'Supplier who issued this expense bill (optional)';
COMMENT ON COLUMN public.finance_expenses.invoice_number IS 'Supplier invoice/reference number';
COMMENT ON COLUMN public.finance_expenses.due_date       IS 'Payment due date (auto-set from supplier terms, for outstanding bills)';
COMMENT ON COLUMN public.finance_expenses.paid_amount    IS 'Amount paid via Payment Vouchers; maintained by trigger on voucher_allocations';

-- ── 3. Add 'professional_services' to expense_category CHECK ─────────────────
-- Drop and recreate — same pattern as all previous CHECK expansions.
-- This adds professional_services alongside the existing 29 values.

ALTER TABLE public.finance_expenses
  DROP CONSTRAINT IF EXISTS finance_expenses_expense_category_check;

ALTER TABLE public.finance_expenses
  ADD CONSTRAINT finance_expenses_expense_category_check
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
    'fixed_asset'::text,
    'professional_services'::text   -- NEW
  ]));

-- ── 4. Seed COA 6410 Professional Fees if not present ────────────────────────
INSERT INTO public.chart_of_accounts (code, name, account_type, is_header, normal_balance, is_active, created_at)
  SELECT '6410', 'Professional Fees', 'expense', false, 'debit', true, now()
  WHERE NOT EXISTS (SELECT 1 FROM public.chart_of_accounts WHERE code = '6410');

-- ── 5. Update get_expense_account_id() — add professional_services mapping ───
-- Replaces function in place; all callers continue to work unchanged.
-- Adds only one new WHEN branch; all existing mappings preserved exactly.

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
    WHEN 'professional_services'     THEN (SELECT id FROM chart_of_accounts WHERE code = '6410' LIMIT 1)  -- NEW
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

  -- Fallback: if still NULL and not PIB/fixed_asset, use General Expense account
  IF v_account_id IS NULL AND p_category NOT IN ('pib_import', 'fixed_asset') THEN
    SELECT id INTO v_account_id FROM chart_of_accounts WHERE code = '6000' LIMIT 1;
  END IF;

  RETURN v_account_id;
END;
$$;

-- ── 6. voucher_allocations: add finance_expense_id column ────────────────────
-- This relaxes the existing CHECK to also allow (payment + finance_expense_id).
-- Existing rows (finance_expense_id = NULL) continue to satisfy the original conditions.

ALTER TABLE public.voucher_allocations
  ADD COLUMN IF NOT EXISTS finance_expense_id UUID REFERENCES public.finance_expenses(id) ON DELETE CASCADE;

-- Drop old CHECK and replace with one that allows expense bill allocations.
-- Original: (receipt + sales_invoice) OR (payment + purchase_invoice)
-- New:      (receipt + sales_invoice) OR (payment + purchase_invoice) OR (payment + finance_expense)
ALTER TABLE public.voucher_allocations
  DROP CONSTRAINT IF EXISTS voucher_allocations_check;

ALTER TABLE public.voucher_allocations
  ADD CONSTRAINT voucher_allocations_check
  CHECK (
    (voucher_type = 'receipt'  AND receipt_voucher_id  IS NOT NULL AND sales_invoice_id     IS NOT NULL) OR
    (voucher_type = 'payment'  AND payment_voucher_id  IS NOT NULL AND purchase_invoice_id  IS NOT NULL) OR
    (voucher_type = 'payment'  AND payment_voucher_id  IS NOT NULL AND finance_expense_id   IS NOT NULL)
  );

-- ── 7a. Recalculate expense payment state ────────────────────────────────────
-- Same pattern as recalculate_purchase_invoice_payment_state().
-- Called by trigger on voucher_allocations, and by save_payment_voucher_with_allocations().

CREATE OR REPLACE FUNCTION public.recalculate_expense_payment_state(p_expense_id UUID)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_total_paid NUMERIC(18,2);
BEGIN
  IF p_expense_id IS NULL THEN
    RETURN;
  END IF;

  SELECT COALESCE(SUM(allocated_amount), 0)
  INTO v_total_paid
  FROM public.voucher_allocations
  WHERE finance_expense_id = p_expense_id
    AND voucher_type = 'payment';

  UPDATE public.finance_expenses
  SET paid_amount = v_total_paid
  WHERE id = p_expense_id;
END;
$$;

-- ── 7b. Trigger function: sync expense paid_amount from voucher_allocations ──

CREATE OR REPLACE FUNCTION public.sync_expense_payment_state_from_allocations()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  -- On INSERT or UPDATE, recalculate for the new expense
  IF TG_OP IN ('INSERT', 'UPDATE') AND NEW.finance_expense_id IS NOT NULL THEN
    PERFORM public.recalculate_expense_payment_state(NEW.finance_expense_id);
  END IF;

  -- On UPDATE or DELETE, recalculate for the old expense (if different)
  IF TG_OP IN ('UPDATE', 'DELETE') AND OLD.finance_expense_id IS NOT NULL THEN
    IF TG_OP = 'DELETE'
       OR OLD.finance_expense_id IS DISTINCT FROM NEW.finance_expense_id
       OR OLD.allocated_amount   IS DISTINCT FROM NEW.allocated_amount
       OR OLD.voucher_type       IS DISTINCT FROM NEW.voucher_type
    THEN
      PERFORM public.recalculate_expense_payment_state(OLD.finance_expense_id);
    END IF;
  END IF;

  RETURN COALESCE(NEW, OLD);
END;
$$;

-- Attach trigger to voucher_allocations (fires alongside existing purchase_invoice trigger)
DROP TRIGGER IF EXISTS trg_sync_expense_payment_state ON public.voucher_allocations;
CREATE TRIGGER trg_sync_expense_payment_state
  AFTER INSERT OR UPDATE OR DELETE ON public.voucher_allocations
  FOR EACH ROW
  EXECUTE FUNCTION public.sync_expense_payment_state_from_allocations();

-- ── 8. Extend save_payment_voucher_with_allocations() ────────────────────────
-- Extends the allocation INSERT loop to handle finance_expense_id entries.
-- Callers that pass only {invoice_id, amount} continue to work unchanged because
-- finance_expense_id is read from the JSONB only when present.
-- Signature is unchanged (p_allocations JSONB is flexible).

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
  p_allocations       jsonb       DEFAULT '[]'::jsonb
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

  -- ── Create or update the voucher header ──
  IF p_voucher_id IS NULL THEN
    INSERT INTO payment_vouchers (
      voucher_number, voucher_date, supplier_id, payment_method,
      bank_account_id, reference_number, amount, pph_amount, pph_code_id,
      description, payment_currency, exchange_rate,
      bank_amount, bank_charge, created_by
    ) VALUES (
      p_voucher_number, p_voucher_date, p_supplier_id, p_payment_method,
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
      -- Standard purchase invoice allocation (existing behaviour)
      INSERT INTO voucher_allocations (
        payment_voucher_id, purchase_invoice_id,
        allocated_amount, allocated_currency, voucher_type
      ) VALUES (
        v_voucher_id,
        v_invoice_id,
        v_alloc_amount,
        COALESCE(v_alloc->>'currency', 'IDR'),
        'payment'
      );
    ELSIF v_expense_id IS NOT NULL THEN
      -- NEW: expense bill allocation
      INSERT INTO voucher_allocations (
        payment_voucher_id, finance_expense_id,
        allocated_amount, allocated_currency, voucher_type
      ) VALUES (
        v_voucher_id,
        v_expense_id,
        v_alloc_amount,
        COALESCE(v_alloc->>'currency', 'IDR'),
        'payment'
      );
      -- paid_amount on finance_expenses updated by trg_sync_expense_payment_state
    END IF;
  END LOOP;

  RETURN v_voucher_id;
END;
$$;

-- ── 9. RPC: get_outstanding_expense_bills() ───────────────────────────────────
-- Returns expense bills recorded as Outstanding (payment_method IS NULL)
-- with remaining balance. Used by PayablesManager and PaymentVoucherManager.

CREATE OR REPLACE FUNCTION public.get_outstanding_expense_bills(
  p_as_of_date DATE DEFAULT CURRENT_DATE
)
RETURNS TABLE (
  id               UUID,
  supplier_id      UUID,
  supplier_name    TEXT,
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
  LEFT JOIN public.suppliers s ON s.id = fe.supplier_id
  WHERE fe.payment_method IS NULL
    AND fe.amount > COALESCE(fe.paid_amount, 0)
    AND fe.expense_date <= p_as_of_date
  ORDER BY COALESCE(fe.due_date, fe.expense_date);
END;
$$;

GRANT EXECUTE ON FUNCTION public.get_outstanding_expense_bills(DATE) TO authenticated;
REVOKE EXECUTE ON FUNCTION public.get_outstanding_expense_bills(DATE) FROM anon;

-- ── 10. RPC: get_asset_register() ────────────────────────────────────────────
-- Returns all fixed-asset expense records for the Asset Register report.
-- Includes supplier info and asset account for depreciation readiness.

CREATE OR REPLACE FUNCTION public.get_asset_register()
RETURNS TABLE (
  id             UUID,
  supplier_id    UUID,
  supplier_name  TEXT,
  invoice_number TEXT,
  purchase_date  DATE,
  asset_account  TEXT,
  asset_account_code TEXT,
  cost           NUMERIC,
  description    TEXT
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
    s.company_name::TEXT        AS supplier_name,
    fe.invoice_number::TEXT,
    fe.expense_date             AS purchase_date,
    coa.name::TEXT              AS asset_account,
    coa.code::TEXT              AS asset_account_code,
    fe.amount                   AS cost,
    fe.description::TEXT
  FROM public.finance_expenses fe
  LEFT JOIN public.suppliers s          ON s.id   = fe.supplier_id
  LEFT JOIN public.chart_of_accounts coa ON coa.id = fe.fixed_asset_account_id
  WHERE fe.expense_category = 'fixed_asset'
  ORDER BY fe.expense_date DESC;
END;
$$;

GRANT EXECUTE ON FUNCTION public.get_asset_register() TO authenticated;
REVOKE EXECUTE ON FUNCTION public.get_asset_register() FROM anon;

-- ── 11. Indexes ───────────────────────────────────────────────────────────────
CREATE INDEX IF NOT EXISTS idx_finance_expenses_supplier
  ON public.finance_expenses(supplier_id);

CREATE INDEX IF NOT EXISTS idx_finance_expenses_due_date
  ON public.finance_expenses(due_date);

CREATE INDEX IF NOT EXISTS idx_finance_expenses_payment_method_outstanding
  ON public.finance_expenses(payment_method, paid_amount, amount)
  WHERE payment_method IS NULL;

CREATE INDEX IF NOT EXISTS idx_va_finance_expense
  ON public.voucher_allocations(finance_expense_id)
  WHERE finance_expense_id IS NOT NULL;

-- ── Completion notice ─────────────────────────────────────────────────────────
DO $$
BEGIN
  RAISE NOTICE '============================================================';
  RAISE NOTICE 'Migration 20260702100000 applied:';
  RAISE NOTICE '  suppliers: +default_expense_category, +default_pph_code_id, +tax_preference';
  RAISE NOTICE '  finance_expenses: +supplier_id, +invoice_number, +due_date, +paid_amount';
  RAISE NOTICE '  expense_category CHECK: added professional_services';
  RAISE NOTICE '  get_expense_account_id(): professional_services → 6410';
  RAISE NOTICE '  COA 6410 Professional Fees seeded (if not present)';
  RAISE NOTICE '  voucher_allocations: +finance_expense_id, updated CHECK';
  RAISE NOTICE '  recalculate_expense_payment_state() created';
  RAISE NOTICE '  trg_sync_expense_payment_state trigger created';
  RAISE NOTICE '  save_payment_voucher_with_allocations() extended for expense bills';
  RAISE NOTICE '  get_outstanding_expense_bills() RPC created';
  RAISE NOTICE '  get_asset_register() RPC created';
  RAISE NOTICE '  Indexes created';
  RAISE NOTICE '  All existing accounting logic unchanged.';
  RAISE NOTICE '============================================================';
END $$;
