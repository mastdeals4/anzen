-- ============================================================================
-- Migration: 20260702140000_fix_unbalanced_purchase_invoice_jes
-- Date:      2026-07-02
--
-- Fix: 2 purchase invoices have partially-written journal entries
-- (only A/P credit line, missing DR Inventory + DR PPN Input).
--
-- These were created before save_purchase_invoice() was fully implemented.
-- Fix: Insert the missing debit lines to balance the JEs.
--
-- Invoices affected:
--   PI-2606004       (JE-2606-0001): subtotal 23,195,500 + PPN 2,550,405
--   001/OR/SAPJ/...  (JE-2602-0002): subtotal 12,165,503 + PPN 0
--
-- Pattern: inventory purchase invoice → DR Inventory (subtotal) + DR PPN (tax) / CR A/P (total)
-- ============================================================================

DO $$
DECLARE
  v_inventory_account UUID;
  v_ppn_account       UUID;
  v_je1_id            UUID := '171fd29c-d7df-414f-8900-3640222161c6'; -- PI-2606004
  v_je2_id            UUID := 'eb3da865-cdcb-4319-94e0-e83b587df89e'; -- 001/OR/SAPJ/...
  v_sup1              UUID := 'bdbde1cc-e10c-49cc-8d4e-2713e5cf04b7';
  v_sup2              UUID := '701bbcb1-3fe8-421f-acec-9d216193346d';
BEGIN
  -- Get account IDs
  SELECT id INTO v_inventory_account FROM chart_of_accounts WHERE code = '1130' LIMIT 1;
  SELECT id INTO v_ppn_account       FROM chart_of_accounts WHERE code = '1150' LIMIT 1;

  IF v_inventory_account IS NULL THEN
    RAISE EXCEPTION 'Inventory account 1130 not found';
  END IF;
  IF v_ppn_account IS NULL THEN
    RAISE EXCEPTION 'PPN Masukan account 1150 not found';
  END IF;

  -- ── JE-2606-0001: PI-2606004 ───────────────────────────────────────────────
  -- A/P credit already exists: 25,745,905
  -- Missing: DR Inventory 23,195,500 (subtotal) + DR PPN 2,550,405 (tax)

  -- DR Inventory (line 2)
  INSERT INTO journal_entry_lines (
    journal_entry_id, line_number, account_id, description, debit, credit, supplier_id
  )
  SELECT v_je1_id, 2, v_inventory_account, 'Inventory - PI-2606004', 23195500, 0, v_sup1
  WHERE NOT EXISTS (
    SELECT 1 FROM journal_entry_lines
    WHERE journal_entry_id = v_je1_id AND line_number = 2
  );

  -- DR PPN Masukan (line 3)
  INSERT INTO journal_entry_lines (
    journal_entry_id, line_number, account_id, description, debit, credit, supplier_id
  )
  SELECT v_je1_id, 3, v_ppn_account, 'PPN Masukan - PI-2606004', 2550405, 0, v_sup1
  WHERE NOT EXISTS (
    SELECT 1 FROM journal_entry_lines
    WHERE journal_entry_id = v_je1_id AND line_number = 3
  );

  -- ── JE-2602-0002: 001/OR/SAPJ/II/2026 ────────────────────────────────────
  -- A/P credit already exists: 12,165,503
  -- Missing: DR Inventory 12,165,503 (no PPN on this invoice)

  -- DR Inventory (line 2)
  INSERT INTO journal_entry_lines (
    journal_entry_id, line_number, account_id, description, debit, credit, supplier_id
  )
  SELECT v_je2_id, 2, v_inventory_account,
    'Inventory - 001/OR/SAPJ/II/2026', 12165503, 0, v_sup2
  WHERE NOT EXISTS (
    SELECT 1 FROM journal_entry_lines
    WHERE journal_entry_id = v_je2_id AND line_number = 2
  );

  RAISE NOTICE 'JE correction complete. Lines inserted for % and %', v_je1_id, v_je2_id;
END;
$$;

-- ── Verify: unbalanced JEs should now be 0 ──────────────────────────────────
DO $$
DECLARE
  v_unbalanced INTEGER;
BEGIN
  SELECT COUNT(*) INTO v_unbalanced
  FROM (
    SELECT journal_entry_id
    FROM journal_entry_lines
    GROUP BY journal_entry_id
    HAVING ABS(SUM(debit) - SUM(credit)) > 0.01
  ) x;

  IF v_unbalanced > 0 THEN
    RAISE WARNING 'There are still % unbalanced journal entries after fix', v_unbalanced;
  ELSE
    RAISE NOTICE 'All journal entries are balanced.';
  END IF;
END;
$$;
