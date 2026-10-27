-- Fix purchase invoices stuck in 'partial' status when balance is actually 0
-- Root cause: discount applied to invoice reduced balance to 0 but status
--             was never recalculated. Also fixes floating-point rounding leftovers.

-- Step 1: Fix all 'partial' invoices with balance effectively 0
UPDATE purchase_invoices
SET
  status       = 'paid',
  balance_amount = 0
WHERE
  status = 'partial'
  AND balance_amount <= 0.99;

-- Step 2: Fix any 'unpaid' invoices that actually have full payment
-- (edge case: payment recorded but status not updated)
UPDATE purchase_invoices
SET
  status = 'paid',
  balance_amount = 0
WHERE
  status = 'unpaid'
  AND paid_amount >= total_amount
  AND total_amount > 0;

-- Step 3: Recalculate balance_amount for any where it looks inconsistent
-- (balance stored > 0 but total - paid = 0 or less)
UPDATE purchase_invoices
SET
  balance_amount = 0,
  status = 'paid'
WHERE
  status IN ('partial', 'unpaid')
  AND total_amount > 0
  AND (total_amount - COALESCE(paid_amount, 0)) <= 0.99;

-- Report how many were fixed (visible in Supabase migration logs)
DO $$
DECLARE
  fixed_count INTEGER;
BEGIN
  SELECT COUNT(*) INTO fixed_count
  FROM purchase_invoices
  WHERE status = 'paid' AND updated_at >= NOW() - INTERVAL '5 seconds';
  RAISE NOTICE 'Fixed % purchase invoices with stale partial/unpaid status', fixed_count;
END $$;
