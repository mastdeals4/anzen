-- ================================================================
-- Historical Correction: PV/26-27/001 (JE2604-0033)
-- JE UUID: 166682a8-1f35-4679-a581-d97865764283
--
-- Problem: Bank IDR line was posted at USD face value (9,548.50)
--          instead of the IDR equivalent.
--
-- Fix: Restate all three JE lines in USD-equivalent units so that
--      when the reporting engine multiplies by rate 17,136 the
--      resulting IDR amounts match the actual transaction:
--        AP DR    → 9,548.50  USD  = 163,623,096 IDR
--        BankChg DR → 2.9181 USD  =      50,000 IDR (transfer fee)
--        Bank CR  → 9,551.4181 USD = 163,673,096 IDR (bank_amount)
--
-- Rate used: 17,136  (stored on the voucher as exchange_rate)
-- Applied: 2026-06-26
-- ================================================================

DO $$
DECLARE
  v_je_id     UUID  := '166682a8-1f35-4679-a581-d97865764283';
  v_rate      NUMERIC := 17136;
  v_usd_amt   NUMERIC := 9548.50;        -- AP / invoice amount in USD
  v_bank_chg_idr NUMERIC := 50000;       -- bank_charge in IDR
  v_charge_usd NUMERIC;
  v_bank_cr_usd NUMERIC;
  v_bankchg_account_id UUID;
BEGIN
  -- Bank charges COA (code 7100)
  SELECT id INTO v_bankchg_account_id
    FROM chart_of_accounts WHERE code = '7100' LIMIT 1;

  -- v_charge_usd = IDR bank charge expressed in USD units
  v_charge_usd  := ROUND(v_bank_chg_idr / v_rate, 4);           -- 2.9181
  -- v_bank_cr_usd = total USD units credited from bank
  v_bank_cr_usd := v_usd_amt + v_charge_usd;                     -- 9551.4181

  -- ── 1. Update JE header totals ──────────────────────────────────
  UPDATE journal_entries
  SET
    total_debit  = v_bank_cr_usd,
    total_credit = v_bank_cr_usd
  WHERE id = v_je_id;

  -- ── 2. Line 1: AP debit — no change needed (already 9548.50) ───
  -- Verify but leave untouched; amount is correct.

  -- ── 3. Delete old bank credit line (line_number 2) ──────────────
  --    (Previously posted 9548.50 to bank; was wrong — should be net USD)
  DELETE FROM journal_entry_lines
  WHERE journal_entry_id = v_je_id AND line_number = 2;

  -- ── 4. Insert Bank Charges DR (new line 2) ──────────────────────
  INSERT INTO journal_entry_lines
    (journal_entry_id, line_number, account_id, description, debit, credit)
  VALUES
    (v_je_id, 2, v_bankchg_account_id,
     'Bank Transfer Fee - PV/26-27/001', v_charge_usd, 0);

  -- ── 5. Insert corrected Bank CR (new line 3) ────────────────────
  --    Credit = 9551.4181 USD ≈ 163,673,096 IDR at rate 17,136
  INSERT INTO journal_entry_lines
    (journal_entry_id, line_number, account_id, description, debit, credit)
  SELECT
    v_je_id, 3, coa_id,
    'Cash Payment - PV/26-27/001', 0, v_bank_cr_usd
  FROM bank_accounts
  WHERE id = (SELECT bank_account_id FROM payment_vouchers WHERE voucher_number = 'PV/26-27/001');

  RAISE NOTICE 'Correction applied: charge_usd=%, bank_cr_usd=%', v_charge_usd, v_bank_cr_usd;
END;
$$;
