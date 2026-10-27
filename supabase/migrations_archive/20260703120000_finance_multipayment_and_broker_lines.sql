-- ═══════════════════════════════════════════════════════════════════════════
-- Finance multi-payment (supplier + PPh23) & broker sub-line PPN validation
-- ═══════════════════════════════════════════════════════════════════════════
-- Additive migration. Safe to re-run (IF NOT EXISTS guards).
--
-- Notes on real column names discovered in existing schema:
--   * finance_expenses.id                 uuid
--   * voucher_allocations.finance_expense_id uuid, amount col = allocated_amount
--   * bank_statement_lines.amount = debit_amount + credit_amount (only one set)
-- ═══════════════════════════════════════════════════════════════════════════

-- 1. finance_expenses: track PPh23 government-side payment separately.
ALTER TABLE public.finance_expenses
  ADD COLUMN IF NOT EXISTS pph_paid_amount numeric(15,2) NOT NULL DEFAULT 0;

COMMENT ON COLUMN public.finance_expenses.pph_paid_amount IS
  'Portion of pph_amount actually remitted to the government (SPT PPh23). Maintained by recalculate_expense_payment_state().';

-- 2. voucher_allocations.payment_kind — tag supplier vs pph23 remittance.
ALTER TABLE public.voucher_allocations
  ADD COLUMN IF NOT EXISTS payment_kind text NOT NULL DEFAULT 'supplier';

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'voucher_allocations_payment_kind_check'
  ) THEN
    ALTER TABLE public.voucher_allocations
      ADD CONSTRAINT voucher_allocations_payment_kind_check
      CHECK (payment_kind IN ('supplier','pph23'));
  END IF;
END $$;

-- 3. bank_statement_lines.payment_kind — same tag on direct bank matches.
ALTER TABLE public.bank_statement_lines
  ADD COLUMN IF NOT EXISTS payment_kind text NOT NULL DEFAULT 'supplier';

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'bank_statement_lines_payment_kind_check'
  ) THEN
    ALTER TABLE public.bank_statement_lines
      ADD CONSTRAINT bank_statement_lines_payment_kind_check
      CHECK (payment_kind IN ('supplier','pph23'));
  END IF;
END $$;

-- 4. Recompute helper — derive BOTH supplier and pph paid totals.
--    Replaces the previous single-total recalculator in 20260702100000.
CREATE OR REPLACE FUNCTION public.recalculate_expense_payment_state(p_expense_id uuid)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_supplier_paid numeric := 0;
  v_pph_paid      numeric := 0;
BEGIN
  -- Supplier: voucher allocations tagged 'supplier'
  SELECT COALESCE(SUM(va.allocated_amount), 0) INTO v_supplier_paid
    FROM voucher_allocations va
   WHERE va.finance_expense_id = p_expense_id
     AND va.payment_kind = 'supplier';

  -- Supplier: bank_statement_lines directly matched with kind 'supplier'
  SELECT v_supplier_paid + COALESCE(SUM(COALESCE(bsl.debit_amount,0) + COALESCE(bsl.credit_amount,0)), 0)
    INTO v_supplier_paid
    FROM bank_statement_lines bsl
   WHERE bsl.matched_expense_id = p_expense_id
     AND bsl.payment_kind = 'supplier';

  -- PPh23: voucher allocations tagged 'pph23'
  SELECT COALESCE(SUM(va.allocated_amount), 0) INTO v_pph_paid
    FROM voucher_allocations va
   WHERE va.finance_expense_id = p_expense_id
     AND va.payment_kind = 'pph23';

  -- PPh23: bank_statement_lines matched with kind 'pph23'
  SELECT v_pph_paid + COALESCE(SUM(COALESCE(bsl.debit_amount,0) + COALESCE(bsl.credit_amount,0)), 0)
    INTO v_pph_paid
    FROM bank_statement_lines bsl
   WHERE bsl.matched_expense_id = p_expense_id
     AND bsl.payment_kind = 'pph23';

  UPDATE finance_expenses
     SET paid_amount     = v_supplier_paid,
         pph_paid_amount = v_pph_paid
   WHERE id = p_expense_id;
END $$;

GRANT EXECUTE ON FUNCTION public.recalculate_expense_payment_state(uuid) TO authenticated;
REVOKE EXECUTE ON FUNCTION public.recalculate_expense_payment_state(uuid) FROM anon;

-- Hot-path indexes for the two SUM queries above. Both idempotent.
CREATE INDEX IF NOT EXISTS idx_voucher_allocations_expense_kind
  ON voucher_allocations (finance_expense_id, payment_kind)
  WHERE finance_expense_id IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_bank_stmt_lines_matched_expense_kind
  ON bank_statement_lines (matched_expense_id, payment_kind)
  WHERE matched_expense_id IS NOT NULL;

-- 5. validate_broker_items — preserve original Σ(line.amount)=parent.amount check,
--    and add: if any line supplies ppn_amount, then Σ(line.ppn_amount) MUST equal
--    parent.ppn_amount (allowing ±1 IDR rounding).
CREATE OR REPLACE FUNCTION public.validate_broker_items(p_expense_id UUID)
RETURNS BOOLEAN
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_amount        NUMERIC;
  v_ppn_amount    NUMERIC;
  v_items_total   NUMERIC;
  v_ppn_items_sum NUMERIC;
  v_ppn_present   BOOLEAN;
BEGIN
  SELECT
    amount,
    COALESCE(ppn_amount, 0),
    -- For 'included' lines, item.amount is gross (DPP+PPN); parent.amount stores
    -- DPP-only (matches client roll-up and prevents GL trigger double-count).
    (SELECT SUM((item->>'amount')::NUMERIC
                - CASE WHEN item->>'ppn_treatment' = 'included'
                       THEN COALESCE((item->>'ppn_amount')::NUMERIC, 0)
                       ELSE 0 END)
       FROM jsonb_array_elements(broker_items) AS item),
    (SELECT SUM(COALESCE((item->>'ppn_amount')::NUMERIC, 0))
       FROM jsonb_array_elements(broker_items) AS item),
    EXISTS (
      SELECT 1 FROM jsonb_array_elements(broker_items) AS item
       WHERE (item ? 'ppn_amount') AND (item->>'ppn_amount') IS NOT NULL
    )
  INTO v_amount, v_ppn_amount, v_items_total, v_ppn_items_sum, v_ppn_present
  FROM finance_expenses
  WHERE id = p_expense_id;

  -- No broker_items → always valid (unchanged behaviour)
  IF v_items_total IS NULL THEN
    RETURN TRUE;
  END IF;

  -- Existing invariant: sum of line amounts = parent amount
  IF v_items_total <> v_amount THEN
    RETURN FALSE;
  END IF;

  -- New guard: if any line carries ppn_amount, the roll-up must match parent
  IF v_ppn_present AND ABS(COALESCE(v_ppn_items_sum, 0) - v_ppn_amount) > 1 THEN
    RETURN FALSE;
  END IF;

  RETURN TRUE;
END $$;

GRANT EXECUTE ON FUNCTION public.validate_broker_items(UUID) TO authenticated;
REVOKE EXECUTE ON FUNCTION public.validate_broker_items(UUID) FROM anon;

DO $$
BEGIN
  RAISE NOTICE 'finance multipayment + broker sub-line PPN migration complete';
END $$;
