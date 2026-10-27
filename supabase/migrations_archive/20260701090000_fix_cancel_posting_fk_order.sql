-- ============================================================
-- Fix: Cancel GL Posting fails with foreign_key_violation
--
-- payment_vouchers.journal_entry_id and receipt_vouchers.journal_entry_id
-- reference journal_entries(id) with the default ON DELETE NO ACTION.
--
-- The prior wrappers called cancel_gl_posting() first (which DELETEs
-- from journal_entries) and only afterwards set the voucher's
-- journal_entry_id to NULL. Postgres enforced the FK IMMEDIATELY on
-- the DELETE, so the RPC aborted with SQLSTATE 23503, users saw
-- "Failed to cancel posting: [object Object]", and posted vouchers
-- could not be corrected during implementation.
--
-- This migration reorders the operations in each wrapper so the FK
-- reference is cleared BEFORE the journal entry is deleted. Business
-- logic, permissions, period-locked guards, and audit trail behaviour
-- are unchanged — only the statement order is corrected.
-- ============================================================

CREATE OR REPLACE FUNCTION public.cancel_payment_voucher_posting(
  p_pv_id        uuid,
  p_cancelled_by uuid,
  p_reason       text DEFAULT 'Posting cancelled by administrator'
)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_pv RECORD;
  v_je RECORD;
BEGIN
  IF auth.uid() IS NULL THEN
    RAISE EXCEPTION 'Not authenticated';
  END IF;

  SELECT * INTO v_pv FROM payment_vouchers WHERE id = p_pv_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'Payment voucher % not found', p_pv_id; END IF;
  IF NOT v_pv.is_posted THEN
    RAISE EXCEPTION 'Payment voucher % is not posted', COALESCE(v_pv.voucher_number, p_pv_id::TEXT);
  END IF;

  SELECT * INTO v_je FROM journal_entries WHERE id = v_pv.journal_entry_id;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'No journal entry found for payment voucher %', v_pv.voucher_number;
  END IF;

  -- Clear the FK reference FIRST so cancel_gl_posting can delete the JE row.
  -- (payment_vouchers.journal_entry_id has ON DELETE NO ACTION.)
  UPDATE payment_vouchers
  SET is_posted = FALSE, journal_entry_id = NULL
  WHERE id = p_pv_id;

  PERFORM cancel_gl_posting(
    v_je.id, p_pv_id, 'payment_vouchers', p_cancelled_by, p_reason,
    jsonb_build_object(
      'voucher_number', v_pv.voucher_number,
      'amount',         v_pv.amount,
      'is_posted',      TRUE
    )
  );
END;
$$;

CREATE OR REPLACE FUNCTION public.cancel_receipt_voucher_posting(
  p_rv_id        uuid,
  p_cancelled_by uuid,
  p_reason       text DEFAULT 'Posting cancelled by administrator'
)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_rv RECORD;
  v_je RECORD;
BEGIN
  IF auth.uid() IS NULL THEN
    RAISE EXCEPTION 'Not authenticated';
  END IF;

  SELECT * INTO v_rv FROM receipt_vouchers WHERE id = p_rv_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'Receipt voucher % not found', p_rv_id; END IF;
  IF NOT v_rv.is_posted THEN
    RAISE EXCEPTION 'Receipt voucher % is not posted', COALESCE(v_rv.voucher_number, p_rv_id::TEXT);
  END IF;

  SELECT * INTO v_je FROM journal_entries WHERE id = v_rv.journal_entry_id;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'No journal entry found for receipt voucher %', v_rv.voucher_number;
  END IF;

  -- Clear the FK reference FIRST so cancel_gl_posting can delete the JE row.
  UPDATE receipt_vouchers
  SET is_posted = FALSE, journal_entry_id = NULL
  WHERE id = p_rv_id;

  PERFORM cancel_gl_posting(
    v_je.id, p_rv_id, 'receipt_vouchers', p_cancelled_by, p_reason,
    jsonb_build_object(
      'voucher_number', v_rv.voucher_number,
      'amount',         v_rv.amount,
      'is_posted',      TRUE
    )
  );
END;
$$;
