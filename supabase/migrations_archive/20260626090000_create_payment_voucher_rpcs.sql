-- ================================================================
-- Payment Voucher RPCs
-- save_payment_voucher_with_allocations  (CREATE + EDIT)
-- delete_payment_voucher_with_allocations
-- ================================================================

-- ────────────────────────────────────────────────────────────────
-- 1. SAVE (handles both INSERT and UPDATE)
-- ────────────────────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION save_payment_voucher_with_allocations(
  p_voucher_id       UUID,
  p_voucher_number   TEXT,
  p_voucher_date     DATE,
  p_supplier_id      UUID,
  p_payment_method   TEXT,
  p_bank_account_id  UUID,
  p_reference_number TEXT,
  p_amount           NUMERIC,
  p_pph_amount       NUMERIC,
  p_pph_code_id      UUID,
  p_description      TEXT,
  p_payment_currency TEXT,
  p_exchange_rate    NUMERIC,
  p_bank_amount      NUMERIC,
  p_bank_charge      NUMERIC,
  p_created_by       UUID,
  p_allocations      JSONB          -- [{invoice_id, amount, currency}]
)
RETURNS UUID
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $$
DECLARE
  v_voucher_id        UUID;
  v_je_id             UUID;
  v_credit_account_id UUID;
  v_debit_account_id  UUID;
  v_pph_account_id    UUID;
  v_coa_account_id    UUID;
  v_net_amount        NUMERIC;
  v_line_num          INT;
  v_alloc             JSONB;
BEGIN
  v_net_amount := p_amount - COALESCE(p_pph_amount, 0);

  -- ── Resolve credit account (bank or cash) ─────────────────────
  IF p_bank_account_id IS NOT NULL THEN
    SELECT coa_id INTO v_credit_account_id
      FROM bank_accounts WHERE id = p_bank_account_id;
  ELSIF p_payment_method = 'cash' THEN
    SELECT id INTO v_credit_account_id
      FROM chart_of_accounts WHERE code = '1101' LIMIT 1;
  END IF;
  IF v_credit_account_id IS NULL THEN
    SELECT id INTO v_credit_account_id
      FROM chart_of_accounts WHERE code = '1111' LIMIT 1;
  END IF;

  -- ── Default AP debit account ───────────────────────────────────
  SELECT id INTO v_debit_account_id
    FROM chart_of_accounts WHERE code = '2110' LIMIT 1;

  -- ── PPh payable account ────────────────────────────────────────
  SELECT id INTO v_pph_account_id
    FROM chart_of_accounts WHERE code = '2132' LIMIT 1;

  -- ══════════════════════════════════════════════════════════════
  --  CREATE MODE  (p_voucher_id IS NULL)
  -- ══════════════════════════════════════════════════════════════
  IF p_voucher_id IS NULL THEN

    -- INSERT fires trg_post_payment_voucher which creates the JE
    -- net_amount is a generated column — do NOT include it
    INSERT INTO payment_vouchers (
      voucher_number, voucher_date, supplier_id, payment_method,
      bank_account_id, reference_number, amount, pph_amount, pph_code_id,
      description, payment_currency, exchange_rate,
      bank_amount, bank_charge, created_by
    ) VALUES (
      p_voucher_number, p_voucher_date, p_supplier_id, p_payment_method,
      p_bank_account_id, p_reference_number, p_amount, p_pph_amount, p_pph_code_id,
      p_description, p_payment_currency, p_exchange_rate,
      p_bank_amount, p_bank_charge, p_created_by
    ) RETURNING id INTO v_voucher_id;

  -- ══════════════════════════════════════════════════════════════
  --  EDIT MODE  (p_voucher_id IS NOT NULL)
  -- ══════════════════════════════════════════════════════════════
  ELSE
    v_voucher_id := p_voucher_id;

    -- Fetch existing JE id and any custom COA override
    SELECT journal_entry_id, coa_account_id
      INTO v_je_id, v_coa_account_id
      FROM payment_vouchers WHERE id = v_voucher_id;

    -- If the original voucher used a custom debit account, keep using it
    IF v_coa_account_id IS NOT NULL THEN
      v_debit_account_id := v_coa_account_id;
    END IF;

    -- Update voucher header (net_amount is generated — omit it)
    UPDATE payment_vouchers SET
      voucher_date     = p_voucher_date,
      supplier_id      = p_supplier_id,
      payment_method   = p_payment_method,
      bank_account_id  = p_bank_account_id,
      reference_number = p_reference_number,
      amount           = p_amount,
      pph_amount       = p_pph_amount,
      pph_code_id      = p_pph_code_id,
      description      = p_description,
      payment_currency = p_payment_currency,
      exchange_rate    = p_exchange_rate,
      bank_amount      = p_bank_amount,
      bank_charge      = p_bank_charge,
      updated_at       = NOW()
    WHERE id = v_voucher_id;

    -- Rebuild JE lines if the journal entry exists
    IF v_je_id IS NOT NULL THEN
      UPDATE journal_entries SET
        entry_date   = p_voucher_date,
        total_debit  = p_amount,
        total_credit = p_amount,
        description  = 'Payment Voucher: ' || p_voucher_number
      WHERE id = v_je_id;

      DELETE FROM journal_entry_lines WHERE journal_entry_id = v_je_id;

      v_line_num := 1;

      -- DR: Accounts Payable (or custom debit account)
      INSERT INTO journal_entry_lines
        (journal_entry_id, line_number, account_id, description, debit, credit, supplier_id)
      VALUES
        (v_je_id, v_line_num, v_debit_account_id,
         'Payment - ' || p_voucher_number, p_amount, 0, p_supplier_id);
      v_line_num := v_line_num + 1;

      -- CR: PPh Withholding (if applicable)
      IF COALESCE(p_pph_amount, 0) > 0 AND v_pph_account_id IS NOT NULL THEN
        INSERT INTO journal_entry_lines
          (journal_entry_id, line_number, account_id, description, debit, credit, supplier_id)
        VALUES
          (v_je_id, v_line_num, v_pph_account_id,
           'PPh Withholding - ' || p_voucher_number, 0, p_pph_amount, p_supplier_id);
        v_line_num := v_line_num + 1;
      END IF;

      -- CR: Bank / Cash
      INSERT INTO journal_entry_lines
        (journal_entry_id, line_number, account_id, description, debit, credit, supplier_id)
      VALUES
        (v_je_id, v_line_num, v_credit_account_id,
         'Cash Payment - ' || p_voucher_number, 0, v_net_amount, p_supplier_id);
    END IF;
  END IF;

  -- ── Rebuild allocations (DELETE + re-INSERT triggers recalc invoices) ──
  DELETE FROM voucher_allocations WHERE payment_voucher_id = v_voucher_id;

  FOR v_alloc IN SELECT value FROM jsonb_array_elements(p_allocations) AS value
  LOOP
    IF (v_alloc->>'amount')::NUMERIC > 0 THEN
      INSERT INTO voucher_allocations (
        payment_voucher_id, purchase_invoice_id,
        allocated_amount, allocated_currency, voucher_type
      ) VALUES (
        v_voucher_id,
        (v_alloc->>'invoice_id')::UUID,
        (v_alloc->>'amount')::NUMERIC,
        COALESCE(v_alloc->>'currency', 'IDR'),
        'payment'
      );
    END IF;
  END LOOP;

  RETURN v_voucher_id;
END;
$$;

-- ────────────────────────────────────────────────────────────────
-- 2. DELETE
-- ────────────────────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION delete_payment_voucher_with_allocations(
  p_voucher_id UUID
)
RETURNS VOID
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $$
DECLARE
  v_je_id UUID;
BEGIN
  -- Capture JE id before deletion
  SELECT journal_entry_id INTO v_je_id
    FROM payment_vouchers WHERE id = p_voucher_id;

  -- Remove allocations first — triggers recalculate invoice balances
  DELETE FROM voucher_allocations WHERE payment_voucher_id = p_voucher_id;

  -- Remove voucher (clears the FK reference to journal_entries)
  DELETE FROM payment_vouchers WHERE id = p_voucher_id;

  -- Remove journal entry and its lines
  IF v_je_id IS NOT NULL THEN
    DELETE FROM journal_entry_lines WHERE journal_entry_id = v_je_id;
    DELETE FROM journal_entries       WHERE id             = v_je_id;
  END IF;
END;
$$;
