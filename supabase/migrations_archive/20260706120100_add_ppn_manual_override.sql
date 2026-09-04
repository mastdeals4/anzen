/*
  # Editable Auto-PPN — manual override flag

  Finance Stabilization Sprint (2026-07-06), Task 2.

  Adds finance_expenses.ppn_manual_override boolean flag. When TRUE, the
  frontend will not recompute ppn_amount when amount or supplier changes;
  the user's manually entered PPN is preserved (Indonesian tax invoice
  rounding differences).

  Backward compatibility:
    - Existing rows default to FALSE → behaviour is unchanged for legacy data.
    - No trigger changes.
*/

ALTER TABLE public.finance_expenses
  ADD COLUMN IF NOT EXISTS ppn_manual_override BOOLEAN NOT NULL DEFAULT FALSE;

COMMENT ON COLUMN public.finance_expenses.ppn_manual_override IS
'If TRUE, ppn_amount was manually edited by the user and must not be auto-recomputed '
'by the frontend when amount or supplier changes. FALSE for auto-calculated values. '
'Reset to FALSE when the user clicks the recalculate button.';
