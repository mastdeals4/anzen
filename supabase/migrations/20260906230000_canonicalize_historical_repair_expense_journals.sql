-- Migration: 20260906230000_canonicalize_historical_repair_expense_journals.sql
-- Description: Canonicalize active replacement journals for EXP/26-26/139 and EXP/26/177
--              so that edit_approved_finance_expense_atomic recognizes them as canonical active journals.
--
-- Target 1: EXP/26-26/139 (id: 3b56b2ee-c157-4da8-8bdc-c0bea9b3316d)
--           Active replacement journal: JE2609-0018 (id: 2cde9efd-9b22-4ba6-acbe-f712d6bb0497)
--
-- Target 2: EXP/26/177 (id: e95a4775-cca4-4f38-830b-fcfd7ed5a1f3)
--           Active replacement journal: JE2609-0022 (id: 4d89886c-eab1-4d39-8a46-f499319e1b69)

DO $$
DECLARE
  v_count integer;
  v_exp1_state text;
  v_exp2_state text;
BEGIN
  -- 1. Canonicalize JE2609-0018 for EXP/26-26/139
  UPDATE public.journal_entries
  SET source_module = 'expenses',
      reference_number = 'EXP-3b56b2ee-c157-4da8-8bdc-c0bea9b3316d'
  WHERE id = '2cde9efd-9b22-4ba6-acbe-f712d6bb0497'
    AND entry_number = 'JE2609-0018'
    AND reference_id = '3b56b2ee-c157-4da8-8bdc-c0bea9b3316d'
    AND is_posted = true
    AND NOT COALESCE(is_reversed, false);

  GET DIAGNOSTICS v_count = ROW_COUNT;
  IF v_count <> 1 THEN
    RAISE EXCEPTION 'Failed to update JE2609-0018: expected 1 row, got %', v_count;
  END IF;

  -- 2. Canonicalize JE2609-0022 for EXP/26/177
  UPDATE public.journal_entries
  SET source_module = 'expenses',
      reference_number = 'EXP-e95a4775-cca4-4f38-830b-fcfd7ed5a1f3'
  WHERE id = '4d89886c-eab1-4d39-8a46-f499319e1b69'
    AND entry_number = 'JE2609-0022'
    AND reference_id = 'e95a4775-cca4-4f38-830b-fcfd7ed5a1f3'
    AND is_posted = true
    AND NOT COALESCE(is_reversed, false);

  GET DIAGNOSTICS v_count = ROW_COUNT;
  IF v_count <> 1 THEN
    RAISE EXCEPTION 'Failed to update JE2609-0022: expected 1 row, got %', v_count;
  END IF;

  -- 3. Verify effective_expense_posting_state invariants
  SELECT effective_posting_state INTO v_exp1_state
  FROM public.effective_expense_posting_state
  WHERE expense_id = '3b56b2ee-c157-4da8-8bdc-c0bea9b3316d';

  IF v_exp1_state <> 'ACTIVE' THEN
    RAISE EXCEPTION 'EXP/26-26/139 effective_posting_state expected ACTIVE, got %', v_exp1_state;
  END IF;

  SELECT effective_posting_state INTO v_exp2_state
  FROM public.effective_expense_posting_state
  WHERE expense_id = 'e95a4775-cca4-4f38-830b-fcfd7ed5a1f3';

  IF v_exp2_state <> 'ACTIVE' THEN
    RAISE EXCEPTION 'EXP/26/177 effective_posting_state expected ACTIVE, got %', v_exp2_state;
  END IF;
END $$;
