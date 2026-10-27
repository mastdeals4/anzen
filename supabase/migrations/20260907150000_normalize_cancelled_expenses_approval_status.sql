-- Migration: 20260907150000_normalize_cancelled_expenses_approval_status.sql
-- Ensure cancelled expenses have approval_status = 'cancelled' and are not left in 'pending_approval'

-- 1. Correct any existing expenses that were cancelled/reversed but retained 'pending_approval'
UPDATE public.finance_expenses
SET approval_status = 'cancelled',
    approved_by = NULL,
    approved_at = NULL
WHERE approval_status = 'pending_approval'
  AND id IN (
    SELECT expense_id
    FROM public.effective_expense_posting_state
    WHERE effective_posting_state = 'REVERSED'
  );

-- 2. Explicitly ensure target expense EXP/26-26/052 is marked cancelled
UPDATE public.finance_expenses
SET approval_status = 'cancelled',
    approved_by = NULL,
    approved_at = NULL
WHERE voucher_number = 'EXP/26-26/052'
  AND approval_status <> 'cancelled';
