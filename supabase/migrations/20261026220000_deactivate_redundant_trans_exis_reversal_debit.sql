-- Migration: 20261026220000_deactivate_redundant_trans_exis_reversal_debit.sql
-- Description: Deactivate redundant active reversal journal JE2609-0017 (HR-REV-421d9e6e-3601-41cb-9993-cd5f596d28dd)
--              which was posted during Phase 2 partial payment correction to reverse JE2606-0120.
--              Because JE2606-0120 was already marked is_reversed = true, leaving JE2609-0017 as is_reversed = false
--              introduced an extraneous duplicate debit of Rp 48,000.00 to Account 2132 (PPh 23 Payable),
--              a duplicate debit of Rp 6,094,500.00 to Bank BCA (111101), and a duplicate credit to Freight In (5300).
--              Following standard SAPJ historical repair reversal pattern (matching JE2608-0112..0160),
--              marking JE2609-0017 as is_reversed = true preserves the complete audit trail while eliminating
--              the duplicate GL entries.

DO $$
DECLARE
  v_count integer;
  v_target_id uuid;
BEGIN
  -- Verify target journal exists
  SELECT id INTO v_target_id
  FROM public.journal_entries
  WHERE entry_number = 'JE2609-0017'
    AND reference_number = 'HR-REV-421d9e6e-3601-41cb-9993-cd5f596d28dd'
    AND is_posted = true;

  IF v_target_id IS NULL THEN
    RAISE NOTICE 'Target journal JE2609-0017 not found or already in expected state';
    RETURN;
  END IF;

  -- Ensure is_reversed is set to true to avoid double-counting in active GL queries
  UPDATE public.journal_entries
  SET is_reversed = true
  WHERE id = v_target_id
    AND is_reversed = false;

  GET DIAGNOSTICS v_count = ROW_COUNT;
  IF v_count = 1 THEN
    RAISE NOTICE 'Successfully marked JE2609-0017 as is_reversed = true';
  END IF;
END $$;
