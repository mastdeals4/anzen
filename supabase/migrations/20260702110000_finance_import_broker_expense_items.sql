-- ============================================================================
-- Migration: 20260702110000_finance_import_broker_expense_items
-- Date:      2026-07-02
--
-- OBJECTIVE:
--   Support the "Import / Customs Broker Invoice" as a specialised expense
--   bill: ONE supplier invoice containing optional sub-cost line items
--   (DO Charges, Port Charges, Clearing & Forwarding, Handling, Truck,
--   Freight, Administration, Other) that sum to the invoice total.
--
-- DESIGN:
--   • A JSONB column `broker_items` on finance_expenses stores the breakdown.
--   • The aggregate totals (amount, ppn_amount, pph_amount, stamp_duty_amount)
--     remain on the parent row — auto_post_expense_accounting() needs ZERO
--     changes because it already handles all tax fields correctly.
--   • A new expense_category 'import_broker' is added so the UI can identify
--     this document type and render the line-item form.
--   • All sub-cost types map to GL account 5300 (Import/Customs Costs) unless
--     overridden in get_expense_account_id().
--   • PIB (pib_import) remains completely separate — its BM, PPN Import, and
--     PPh 22 breakdown are untouched.
--
-- BACKWARD COMPATIBILITY:
--   • All existing finance_expenses rows: broker_items = NULL (no effect).
--   • All existing JEs: unchanged.
--   • auto_post_expense_accounting(): unchanged.
--   • Existing 'other_import' expenses: unchanged; they can continue as before.
--
-- BROKER ITEMS JSONB SCHEMA:
--   [
--     { "type": "do_charges",         "description": "D/O Charges",   "amount": 5000000 },
--     { "type": "port_charges",        "description": "Port Charges",  "amount": 2000000 },
--     { "type": "clearing_forwarding", "description": "C&F",           "amount": 3000000 },
--     { "type": "handling",            "description": "Handling",      "amount": 1000000 },
--     { "type": "truck",               "description": "Trucking",      "amount": 2000000 },
--     { "type": "freight",             "description": "Freight",       "amount": 4000000 },
--     { "type": "administration",      "description": "Admin",         "amount":  500000 },
--     { "type": "other",               "description": "Miscellaneous", "amount":  500000 }
--   ]
--   SUM(items.amount) must equal finance_expenses.amount (enforced in UI).
--   PPN, PPh, Stamp Duty remain on parent columns (ppn_amount, pph_amount,
--   stamp_duty_amount) — they are NOT in broker_items.
-- ============================================================================

-- ── 1. Add broker_items JSONB column to finance_expenses ─────────────────────
-- NULL = not a broker invoice.
-- '[]' = broker invoice with no breakdown (single-line).
-- Non-empty array = breakdown sub-items.

ALTER TABLE public.finance_expenses
  ADD COLUMN IF NOT EXISTS broker_items JSONB;

COMMENT ON COLUMN public.finance_expenses.broker_items IS
  'Optional cost breakdown for Import/Customs Broker invoices. '
  'Array of {type, description, amount}. '
  'SUM(amount) = finance_expenses.amount. '
  'NULL = not a broker invoice. '
  'PPN, PPh, Stamp Duty are NOT included here — they stay on parent columns.';

-- ── 2. Add import_broker to expense_category CHECK ───────────────────────────
-- Drop existing constraint, recreate with 'import_broker' added.
-- Preserves all values added by 20260701100000 and 20260702100000.

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
    'import_broker'::text,           -- NEW: Customs Broker Invoice
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
    'professional_services'::text
  ]));

-- ── 3. Update get_expense_account_id() for import_broker ─────────────────────
-- import_broker → 5300 (Import/Customs Costs, same as freight_import).
-- All other mappings carried forward from 20260702100000 unchanged.

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
    WHEN 'import_broker'             THEN (SELECT id FROM chart_of_accounts WHERE code = '5300' LIMIT 1) -- NEW
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

-- ── 4. RPC: validate_broker_items(p_expense_id UUID) ─────────────────────────
-- Utility: checks that SUM(broker_items[*].amount) = finance_expenses.amount.
-- Called from UI before save to surface any rounding discrepancy.
-- Returns TRUE if valid (or if broker_items is NULL).

CREATE OR REPLACE FUNCTION public.validate_broker_items(p_expense_id UUID)
RETURNS BOOLEAN
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_amount      NUMERIC;
  v_items_total NUMERIC;
BEGIN
  SELECT amount, COALESCE(
    (SELECT SUM((item->>'amount')::NUMERIC)
     FROM jsonb_array_elements(broker_items) AS item),
    NULL
  )
  INTO v_amount, v_items_total
  FROM finance_expenses
  WHERE id = p_expense_id;

  -- If no broker_items, always valid
  IF v_items_total IS NULL THEN
    RETURN TRUE;
  END IF;

  RETURN v_items_total = v_amount;
END;
$$;

GRANT EXECUTE ON FUNCTION public.validate_broker_items(UUID) TO authenticated;
REVOKE EXECUTE ON FUNCTION public.validate_broker_items(UUID) FROM anon;

-- ── 5. Index for broker_items queries ────────────────────────────────────────
CREATE INDEX IF NOT EXISTS idx_finance_expenses_import_broker
  ON public.finance_expenses(expense_category)
  WHERE expense_category = 'import_broker';

-- ── Completion notice ─────────────────────────────────────────────────────────
DO $$
BEGIN
  RAISE NOTICE '============================================================';
  RAISE NOTICE 'Migration 20260702110000 applied:';
  RAISE NOTICE '  finance_expenses: +broker_items JSONB';
  RAISE NOTICE '  expense_category CHECK: added import_broker';
  RAISE NOTICE '  get_expense_account_id(): import_broker → 5300';
  RAISE NOTICE '  validate_broker_items() RPC created';
  RAISE NOTICE '  auto_post_expense_accounting(): NO CHANGES (handles import_broker';
  RAISE NOTICE '    via standard path: DR 5300 / CR A/P or Bank, + PPN/PPh/Stamp)';
  RAISE NOTICE '  PIB workflow: unchanged';
  RAISE NOTICE '  All existing JEs: unchanged';
  RAISE NOTICE '============================================================';
END $$;
