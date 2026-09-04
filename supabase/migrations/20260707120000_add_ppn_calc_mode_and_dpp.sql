/*
  # Indonesian PPN calculation modes — Standard / DPP Nilai Lain / Manual

  Additive, backward-compatible schema change. No JE / trigger / report
  changes: all downstream code already consumes the STORED
  finance_expenses.ppn_amount as-is, so this migration only adds three
  fields that let the frontend compute and persist ppn_amount using the
  correct Indonesian convention.

  Modes
    'standard'          → ppn_amount = round(amount * ppn_rate / 100)
    'dpp_nilai_lain'    → ppn_amount = round(dpp_amount * ppn_rate / 100)
                          (used when supplier issues a Faktur Pajak with a
                          separate DPP Nilai Lain figure — e.g. freight,
                          agency services, package tours.)
    'manual'            → user-entered ppn_amount, system never overrides

  Backward compatibility
    - Existing rows default to 'standard' with dpp_amount = NULL and
      ppn_rate = 11. Reads that don't know about these fields keep
      working. The trigger that posts JEs continues to use the stored
      ppn_amount, so existing accounting is untouched.
*/

ALTER TABLE public.finance_expenses
  ADD COLUMN IF NOT EXISTS ppn_calc_mode TEXT NOT NULL DEFAULT 'standard'
    CHECK (ppn_calc_mode IN ('standard', 'dpp_nilai_lain', 'manual'));

ALTER TABLE public.finance_expenses
  ADD COLUMN IF NOT EXISTS dpp_amount NUMERIC(18, 2);

ALTER TABLE public.finance_expenses
  ADD COLUMN IF NOT EXISTS ppn_rate NUMERIC(6, 3) NOT NULL DEFAULT 11;

COMMENT ON COLUMN public.finance_expenses.ppn_calc_mode IS
'Indonesian PPN calculation mode. standard = ppn from invoice amount, '
'dpp_nilai_lain = ppn from supplier-provided DPP, manual = user-entered.';

COMMENT ON COLUMN public.finance_expenses.dpp_amount IS
'Supplier-provided DPP (Dasar Pengenaan Pajak) used when ppn_calc_mode = ''dpp_nilai_lain''. '
'NULL for standard and manual modes.';

COMMENT ON COLUMN public.finance_expenses.ppn_rate IS
'PPN rate percent (default 11). Stored to preserve historical rates when '
'rate changes (e.g. 11% → 12%).';
