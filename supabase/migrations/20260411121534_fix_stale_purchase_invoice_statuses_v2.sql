/*
  # Fix stale Purchase Invoice statuses (v2)

  balance_amount is a generated column (total_amount - paid_amount),
  so we only update 'status' directly.

  Fixes all invoices showing 'partial' or 'unpaid' when their
  computed balance is effectively zero (fully paid).
*/

UPDATE purchase_invoices
SET status = 'paid'
WHERE
  status IN ('partial', 'unpaid')
  AND total_amount > 0
  AND (total_amount - COALESCE(paid_amount, 0)) <= 0.99;
