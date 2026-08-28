-- ============================================================================
-- Migration: 20260630130000_fix_purchase_invoice_atomicity_and_fund_transfer_cleanup
-- Date:      2026-06-30
--
-- FIX 1: delete_fund_transfer_journal_entries() never matched any rows because
--   it used source_module = 'fund_transfer' (wrong — plural 'fund_transfers')
--   and reference_number = 'FT-' || OLD.id::text (wrong — should be transfer_number).
--   Orphan JEs accumulated for every deleted fund transfer.
--
-- FIX 2: Two orphan journal entries from already-deleted fund transfers:
--   JE2606-0038 → FT2606-0002 (IDR 1,000)
--   JE2602-0082 → FT2602-0001 (IDR 10,000,000)
--   Cleaned up, and the fixed trigger prevents recurrence.
--
-- FIX 3: Purchase invoice save was non-atomic: header INSERT and items INSERT
--   were separate PostgREST calls → separate DB transactions. If items failed,
--   the header + JE committed as partial data. EDIT also accumulated stale JE
--   lines because old lines were never deleted before new items were inserted.
--   Replace with save_purchase_invoice() RPC: one function, one transaction,
--   full rollback on any error. pg_advisory_xact_lock prevents JE number
--   collisions under concurrent saves.
--
-- FIX 4: Drop trg_post_purchase_invoice_item_journal — the per-item JE trigger
--   is now replaced by the RPC, which builds all JE lines atomically.
--   Keeping both would cause double-posting.
--
-- Idempotency:
--   CREATE OR REPLACE / DROP TRIGGER IF EXISTS are safe to re-run.
--   The orphan-cleanup DELETEs are no-ops if already clean.
-- ============================================================================

-- ── FIX 1: Correct delete_fund_transfer_journal_entries() ───────────────────

CREATE OR REPLACE FUNCTION public.delete_fund_transfer_journal_entries()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  -- Remove JE lines first (FK constraint)
  DELETE FROM journal_entry_lines
  WHERE journal_entry_id IN (
    SELECT id FROM journal_entries
    WHERE source_module    = 'fund_transfers'
      AND reference_number = OLD.transfer_number
  );

  -- Remove JE header
  DELETE FROM journal_entries
  WHERE source_module    = 'fund_transfers'
    AND reference_number = OLD.transfer_number;

  RETURN OLD;
END;
$$;

-- ── FIX 2: Clean up two existing orphan JEs ─────────────────────────────────

DELETE FROM journal_entry_lines
WHERE journal_entry_id IN (
  SELECT id FROM journal_entries
  WHERE source_module    = 'fund_transfers'
    AND reference_number IN ('FT2606-0002', 'FT2602-0001')
);

DELETE FROM journal_entries
WHERE source_module    = 'fund_transfers'
  AND reference_number IN ('FT2606-0002', 'FT2602-0001');

DO $$
DECLARE v_count INT;
BEGIN
  SELECT COUNT(*) INTO v_count
  FROM journal_entries
  WHERE source_module    = 'fund_transfers'
    AND reference_number IN ('FT2606-0002', 'FT2602-0001');

  IF v_count > 0 THEN
    RAISE EXCEPTION 'Orphan JE cleanup incomplete: % rows remain', v_count;
  ELSE
    RAISE NOTICE 'Orphan fund transfer JEs (FT2606-0002, FT2602-0001) deleted.';
  END IF;
END $$;

-- ── FIX 3: Drop per-item JE trigger (replaced by save_purchase_invoice RPC) ─

DROP TRIGGER IF EXISTS trg_post_purchase_invoice_item_journal ON public.purchase_invoice_items;

-- ── FIX 4: Atomic Purchase Invoice Save RPC ─────────────────────────────────
-- p_invoice_id = NULL  → CREATE new invoice
-- p_invoice_id = <uuid> → EDIT existing invoice
-- Returns: { "invoice_id": "...", "journal_entry_id": "..." }

CREATE OR REPLACE FUNCTION public.save_purchase_invoice(
  p_invoice_id   UUID,
  p_invoice_data JSONB,
  p_items        JSONB
)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_invoice_id     UUID;
  v_je_id          UUID;
  v_je_number      TEXT;
  v_ap_account_id  UUID;
  v_ppn_account_id UUID;
  v_account_id     UUID;
  v_item           JSONB;
  v_line_number    INTEGER;
  v_invoice_date   DATE;
  v_invoice_number TEXT;
  v_supplier_id    UUID;
  v_total_amount   NUMERIC(15,2);
  v_tax_amount     NUMERIC(15,2);
  v_created_by     UUID;
  v_item_type      TEXT;
  v_line_total     NUMERIC(15,2);
BEGIN
  v_created_by     := auth.uid();
  v_invoice_date   := (p_invoice_data->>'invoice_date')::DATE;
  v_invoice_number := p_invoice_data->>'invoice_number';
  v_total_amount   := (p_invoice_data->>'total_amount')::NUMERIC(15,2);
  v_tax_amount     := COALESCE((p_invoice_data->>'tax_amount')::NUMERIC(15,2), 0);
  v_supplier_id    := (p_invoice_data->>'supplier_id')::UUID;

  SELECT id INTO v_ap_account_id  FROM chart_of_accounts WHERE code = '2110' LIMIT 1;
  SELECT id INTO v_ppn_account_id FROM chart_of_accounts WHERE code = '1150' LIMIT 1;

  IF v_ap_account_id IS NULL THEN
    RAISE EXCEPTION 'A/P account (code 2110) not found in chart of accounts';
  END IF;

  -- Serialize JE number generation for this month to prevent collisions
  PERFORM pg_advisory_xact_lock(hashtext('je_number_' || TO_CHAR(v_invoice_date, 'YYMM')));

  IF p_invoice_id IS NULL THEN
    -- ── CREATE path ────────────────────────────────────────────────────────

    v_je_number := 'JE-' || TO_CHAR(v_invoice_date, 'YYMM') || '-' || LPAD((
      SELECT COALESCE(MAX(CAST(SUBSTRING(entry_number FROM '(\d+)$') AS INTEGER)), 0) + 1
      FROM journal_entries
      WHERE entry_number LIKE 'JE-' || TO_CHAR(v_invoice_date, 'YYMM') || '-%'
    )::TEXT, 4, '0');

    -- Create JE header before the invoice row so we can pass the id in.
    -- reference_id is a placeholder uuid; corrected after invoice INSERT.
    INSERT INTO journal_entries (
      entry_number, entry_date, source_module, reference_id, reference_number,
      description, total_debit, total_credit, is_posted, posted_by, created_by
    ) VALUES (
      v_je_number, v_invoice_date, 'purchase_invoice', gen_random_uuid(), v_invoice_number,
      'Purchase Invoice: ' || v_invoice_number,
      0, v_total_amount, TRUE, v_created_by, v_created_by
    ) RETURNING id INTO v_je_id;

    -- Insert invoice header with journal_entry_id already set.
    -- The BEFORE INSERT trigger sees journal_entry_id IS NOT NULL and returns early,
    -- so no duplicate JE is created.
    INSERT INTO purchase_invoices (
      invoice_number, supplier_id, invoice_date, due_date,
      currency, exchange_rate, subtotal, tax_amount, total_amount,
      paid_amount, balance_amount, status,
      faktur_pajak_number, notes, document_urls,
      requires_faktur_pajak, purchase_type,
      journal_entry_id, created_by
    ) VALUES (
      v_invoice_number,
      v_supplier_id,
      v_invoice_date,
      NULLIF(p_invoice_data->>'due_date', '')::DATE,
      COALESCE(p_invoice_data->>'currency', 'IDR'),
      COALESCE((p_invoice_data->>'exchange_rate')::NUMERIC, 1),
      COALESCE((p_invoice_data->>'subtotal')::NUMERIC, 0),
      v_tax_amount,
      v_total_amount,
      0,
      v_total_amount,
      'unpaid',
      NULLIF(p_invoice_data->>'faktur_pajak_number', ''),
      NULLIF(p_invoice_data->>'notes', ''),
      CASE
        WHEN p_invoice_data -> 'document_urls' IS NOT NULL
          AND jsonb_array_length(p_invoice_data -> 'document_urls') > 0
        THEN ARRAY(SELECT jsonb_array_elements_text(p_invoice_data -> 'document_urls'))
        ELSE NULL
      END,
      COALESCE((p_invoice_data->>'requires_faktur_pajak')::BOOLEAN, FALSE),
      COALESCE(p_invoice_data->>'purchase_type', 'inventory'),
      v_je_id,
      v_created_by
    ) RETURNING id INTO v_invoice_id;

    -- Fix the placeholder reference_id now that the invoice id is known
    UPDATE journal_entries SET reference_id = v_invoice_id WHERE id = v_je_id;

  ELSE
    -- ── EDIT path ──────────────────────────────────────────────────────────
    v_invoice_id := p_invoice_id;

    SELECT journal_entry_id INTO v_je_id
    FROM purchase_invoices WHERE id = v_invoice_id;

    -- Update invoice header.
    -- BEFORE UPDATE trigger: OLD.journal_entry_id IS NOT NULL → second condition FALSE → skips.
    UPDATE purchase_invoices SET
      invoice_number        = v_invoice_number,
      supplier_id           = v_supplier_id,
      invoice_date          = v_invoice_date,
      due_date              = NULLIF(p_invoice_data->>'due_date', '')::DATE,
      currency              = COALESCE(p_invoice_data->>'currency', 'IDR'),
      exchange_rate         = COALESCE((p_invoice_data->>'exchange_rate')::NUMERIC, 1),
      subtotal              = COALESCE((p_invoice_data->>'subtotal')::NUMERIC, 0),
      tax_amount            = v_tax_amount,
      total_amount          = v_total_amount,
      faktur_pajak_number   = NULLIF(p_invoice_data->>'faktur_pajak_number', ''),
      notes                 = NULLIF(p_invoice_data->>'notes', ''),
      document_urls         = CASE
                                WHEN p_invoice_data -> 'document_urls' IS NOT NULL
                                  AND jsonb_array_length(p_invoice_data -> 'document_urls') > 0
                                THEN ARRAY(SELECT jsonb_array_elements_text(p_invoice_data -> 'document_urls'))
                                ELSE NULL
                              END,
      requires_faktur_pajak = COALESCE((p_invoice_data->>'requires_faktur_pajak')::BOOLEAN, FALSE),
      purchase_type         = COALESCE(p_invoice_data->>'purchase_type', 'inventory'),
      updated_at            = NOW()
    WHERE id = v_invoice_id;

    -- Delete old items (no trigger on purchase_invoice_items DELETE)
    DELETE FROM purchase_invoice_items WHERE purchase_invoice_id = v_invoice_id;

    IF v_je_id IS NOT NULL THEN
      -- Wipe all JE lines; rebuilt below from the new items
      DELETE FROM journal_entry_lines WHERE journal_entry_id = v_je_id;
      -- Refresh JE header to match new invoice values
      UPDATE journal_entries SET
        entry_date       = v_invoice_date,
        reference_number = v_invoice_number,
        description      = 'Purchase Invoice: ' || v_invoice_number,
        total_debit      = 0,
        total_credit     = v_total_amount
      WHERE id = v_je_id;
    ELSE
      -- Edge case: invoice has no JE (defensive; create one)
      v_je_number := 'JE-' || TO_CHAR(v_invoice_date, 'YYMM') || '-' || LPAD((
        SELECT COALESCE(MAX(CAST(SUBSTRING(entry_number FROM '(\d+)$') AS INTEGER)), 0) + 1
        FROM journal_entries
        WHERE entry_number LIKE 'JE-' || TO_CHAR(v_invoice_date, 'YYMM') || '-%'
      )::TEXT, 4, '0');

      INSERT INTO journal_entries (
        entry_number, entry_date, source_module, reference_id, reference_number,
        description, total_debit, total_credit, is_posted, posted_by, created_by
      ) VALUES (
        v_je_number, v_invoice_date, 'purchase_invoice', v_invoice_id, v_invoice_number,
        'Purchase Invoice: ' || v_invoice_number,
        0, v_total_amount, TRUE, v_created_by, v_created_by
      ) RETURNING id INTO v_je_id;

      UPDATE purchase_invoices SET journal_entry_id = v_je_id WHERE id = v_invoice_id;
    END IF;
  END IF;

  -- ── Insert items and build JE debit lines ───────────────────────────────
  v_line_number := 1;

  FOR v_item IN SELECT * FROM jsonb_array_elements(p_items)
  LOOP
    v_item_type  := v_item->>'item_type';
    v_line_total := COALESCE((v_item->>'line_total')::NUMERIC(15,2), 0);

    INSERT INTO purchase_invoice_items (
      purchase_invoice_id, item_type, product_id, description,
      quantity, unit, unit_price, discount_percent, line_total,
      tax_amount, expense_account_id, asset_account_id
    ) VALUES (
      v_invoice_id,
      v_item_type,
      NULLIF(v_item->>'product_id', '')::UUID,
      v_item->>'description',
      COALESCE((v_item->>'quantity')::NUMERIC, 1),
      v_item->>'unit',
      COALESCE((v_item->>'unit_price')::NUMERIC, 0),
      (v_item->>'discount_percent')::NUMERIC,
      v_line_total,
      (v_item->>'tax_amount')::NUMERIC,
      NULLIF(v_item->>'expense_account_id', '')::UUID,
      NULLIF(v_item->>'asset_account_id',   '')::UUID
    );

    -- Determine debit account for this item
    IF v_item_type = 'inventory' THEN
      SELECT id INTO v_account_id FROM chart_of_accounts WHERE code = '1130' LIMIT 1;
    ELSIF v_item_type = 'fixed_asset' THEN
      v_account_id := NULLIF(v_item->>'asset_account_id', '')::UUID;
      IF v_account_id IS NULL THEN
        SELECT id INTO v_account_id FROM chart_of_accounts WHERE code = '1200' LIMIT 1;
      END IF;
    ELSE
      -- expense, freight, duty, insurance, clearing, other
      v_account_id := NULLIF(v_item->>'expense_account_id', '')::UUID;
      IF v_account_id IS NULL THEN
        SELECT id INTO v_account_id FROM chart_of_accounts WHERE code = '5100' LIMIT 1;
      END IF;
    END IF;

    IF v_account_id IS NOT NULL AND v_line_total <> 0 THEN
      INSERT INTO journal_entry_lines (
        journal_entry_id, line_number, account_id, description,
        debit, credit, supplier_id
      ) VALUES (
        v_je_id, v_line_number, v_account_id,
        COALESCE(LEFT(v_item->>'description', 100), 'Purchase Item'),
        v_line_total, 0, v_supplier_id
      );
      v_line_number := v_line_number + 1;
    END IF;
  END LOOP;

  -- PPN Input debit line (if tax_amount > 0 and account exists)
  IF v_tax_amount > 0 AND v_ppn_account_id IS NOT NULL THEN
    INSERT INTO journal_entry_lines (
      journal_entry_id, line_number, account_id, description,
      debit, credit, supplier_id
    ) VALUES (
      v_je_id, v_line_number, v_ppn_account_id,
      'PPN Input - ' || v_invoice_number,
      v_tax_amount, 0, v_supplier_id
    );
    v_line_number := v_line_number + 1;
  END IF;

  -- A/P credit line
  INSERT INTO journal_entry_lines (
    journal_entry_id, line_number, account_id, description,
    debit, credit, supplier_id
  ) VALUES (
    v_je_id, v_line_number, v_ap_account_id,
    'A/P - ' || v_invoice_number,
    0, v_total_amount, v_supplier_id
  );

  -- Reconcile JE totals from the actual inserted lines
  UPDATE journal_entries SET
    total_debit  = (SELECT COALESCE(SUM(debit),  0) FROM journal_entry_lines WHERE journal_entry_id = v_je_id),
    total_credit = (SELECT COALESCE(SUM(credit), 0) FROM journal_entry_lines WHERE journal_entry_id = v_je_id)
  WHERE id = v_je_id;

  RETURN jsonb_build_object(
    'invoice_id',       v_invoice_id,
    'journal_entry_id', v_je_id
  );
END;
$$;

DO $$
BEGIN
  RAISE NOTICE '============================================================';
  RAISE NOTICE 'Migration 20260630130000 applied:';
  RAISE NOTICE '  delete_fund_transfer_journal_entries() fixed (source_module + reference_number).';
  RAISE NOTICE '  Orphan JEs FT2606-0002 and FT2602-0001 deleted.';
  RAISE NOTICE '  trg_post_purchase_invoice_item_journal dropped.';
  RAISE NOTICE '  save_purchase_invoice() RPC created (atomic, single transaction).';
  RAISE NOTICE '============================================================';
END $$;
