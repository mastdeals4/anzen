/*
  # Add Approval Status to Finance Expenses and Petty Cash Transactions

  ## Summary
  Extends the existing approval system (used for Sales Orders, Delivery Challans,
  Material Returns, Stock Rejections) to cover:
    1. finance_expenses
    2. petty_cash_transactions

  ## Changes

  ### finance_expenses
  - Add `approval_status` (text, DEFAULT 'pending_approval') — same pattern as delivery_challans
  - Add `approved_by` (uuid FK to user_profiles)
  - Add `approved_at` (timestamptz)
  - Add `rejection_reason` (text)

  ### petty_cash_transactions
  - Same four columns added

  ### approval_workflows.transaction_type
  - Extend the enum to include 'expense_approval' and 'petty_cash_approval'
    (already has 'expense_approval' from original migration, add 'petty_cash_approval')

  ## Behaviour
  - All existing rows are set to 'approved' (retroactive, so nothing breaks)
  - New rows created via UI will default to 'pending_approval'
  - RLS: existing policies remain; approval update restricted to admin/manager via application logic

  ## Reports Impact
  - get_expense_vs_profit_report is updated to only SUM approved expenses
*/

-- ─── finance_expenses ─────────────────────────────────────────────────────────

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_name = 'finance_expenses' AND column_name = 'approval_status'
  ) THEN
    ALTER TABLE finance_expenses
      ADD COLUMN approval_status text NOT NULL DEFAULT 'pending_approval'
        CHECK (approval_status IN ('pending_approval', 'approved', 'rejected'));
  END IF;
END $$;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_name = 'finance_expenses' AND column_name = 'approved_by'
  ) THEN
    ALTER TABLE finance_expenses ADD COLUMN approved_by uuid REFERENCES user_profiles(id);
  END IF;
END $$;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_name = 'finance_expenses' AND column_name = 'approved_at'
  ) THEN
    ALTER TABLE finance_expenses ADD COLUMN approved_at timestamptz;
  END IF;
END $$;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_name = 'finance_expenses' AND column_name = 'rejection_reason'
  ) THEN
    ALTER TABLE finance_expenses ADD COLUMN rejection_reason text;
  END IF;
END $$;

-- Retroactively approve all existing expenses so nothing breaks
UPDATE finance_expenses
SET approval_status = 'approved'
WHERE approval_status = 'pending_approval';

-- ─── petty_cash_transactions ──────────────────────────────────────────────────

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_name = 'petty_cash_transactions' AND column_name = 'approval_status'
  ) THEN
    ALTER TABLE petty_cash_transactions
      ADD COLUMN approval_status text NOT NULL DEFAULT 'pending_approval'
        CHECK (approval_status IN ('pending_approval', 'approved', 'rejected'));
  END IF;
END $$;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_name = 'petty_cash_transactions' AND column_name = 'approved_by'
  ) THEN
    ALTER TABLE petty_cash_transactions ADD COLUMN approved_by uuid REFERENCES user_profiles(id);
  END IF;
END $$;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_name = 'petty_cash_transactions' AND column_name = 'approved_at'
  ) THEN
    ALTER TABLE petty_cash_transactions ADD COLUMN approved_at timestamptz;
  END IF;
END $$;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_name = 'petty_cash_transactions' AND column_name = 'rejection_reason'
  ) THEN
    ALTER TABLE petty_cash_transactions ADD COLUMN rejection_reason text;
  END IF;
END $$;

-- Retroactively approve all existing petty cash entries
UPDATE petty_cash_transactions
SET approval_status = 'approved'
WHERE approval_status = 'pending_approval';

-- ─── Extend approval_workflows transaction_type ───────────────────────────────
-- The original migration used an ENUM type. We need to check if it's an enum or text.
-- If it's an enum, add 'petty_cash_approval'. 'expense_approval' already exists.

DO $$
DECLARE
  col_type text;
BEGIN
  SELECT data_type INTO col_type
  FROM information_schema.columns
  WHERE table_name = 'approval_workflows' AND column_name = 'transaction_type';

  IF col_type = 'USER-DEFINED' THEN
    -- It's an enum - add petty_cash_approval if not present
    IF NOT EXISTS (
      SELECT 1 FROM pg_enum e
      JOIN pg_type t ON t.oid = e.enumtypid
      WHERE t.typname = 'approval_transaction_type'
        AND e.enumlabel = 'petty_cash_approval'
    ) THEN
      ALTER TYPE approval_transaction_type ADD VALUE IF NOT EXISTS 'petty_cash_approval';
    END IF;
  END IF;
  -- If it's text, no change needed - text already accepts any value
END $$;

-- ─── Update expense vs profit RPC to only include approved expenses ────────────

CREATE OR REPLACE FUNCTION get_expense_vs_profit_report(
  p_start_date date,
  p_end_date   date
)
RETURNS TABLE (
  total_sales    numeric,
  total_cogs     numeric,
  gross_profit   numeric,
  total_expenses numeric,
  net_profit     numeric,
  profit_pct     numeric
)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  WITH sales_data AS (
    SELECT
      COALESCE(SUM(si.total_amount), 0)                             AS total_sales,
      COALESCE(SUM(sii.quantity * COALESCE(b.landed_cost_per_unit, 0)), 0) AS total_cogs
    FROM sales_invoices si
    LEFT JOIN sales_invoice_items sii ON sii.invoice_id = si.id
    LEFT JOIN batches b ON b.id = sii.batch_id
    WHERE si.invoice_date BETWEEN p_start_date AND p_end_date
      AND si.is_draft = false
  ),
  expense_data AS (
    SELECT COALESCE(SUM(fe.amount), 0) AS total_expenses
    FROM finance_expenses fe
    WHERE fe.expense_date BETWEEN p_start_date AND p_end_date
      AND fe.approval_status = 'approved'
  )
  SELECT
    ROUND(sd.total_sales, 2)                                          AS total_sales,
    ROUND(sd.total_cogs, 2)                                           AS total_cogs,
    ROUND(sd.total_sales - sd.total_cogs, 2)                          AS gross_profit,
    ROUND(ed.total_expenses, 2)                                       AS total_expenses,
    ROUND(sd.total_sales - sd.total_cogs - ed.total_expenses, 2)      AS net_profit,
    CASE WHEN sd.total_sales = 0 THEN 0
         ELSE ROUND(
           (sd.total_sales - sd.total_cogs - ed.total_expenses)
           / sd.total_sales * 100,
           2
         )
    END                                                               AS profit_pct
  FROM sales_data sd, expense_data ed;
$$;

GRANT EXECUTE ON FUNCTION get_expense_vs_profit_report(date, date) TO authenticated;

-- ─── Index for performance ────────────────────────────────────────────────────

CREATE INDEX IF NOT EXISTS idx_finance_expenses_approval_status
  ON finance_expenses(approval_status);

CREATE INDEX IF NOT EXISTS idx_petty_cash_approval_status
  ON petty_cash_transactions(approval_status);
