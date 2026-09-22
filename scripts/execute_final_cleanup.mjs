import { execFileSync } from 'node:child_process';

const sql = `
BEGIN;

-- =========================================================================
-- FINAL ACCOUNTING CLEANUP
-- 1. Void / Reverse FT2607-0003 (Rp 71,987,000 legacy plug from 1101 to 1102)
-- 2. Synchronize 8 batch master costs to authoritative purchase_batch_cost_layers
-- =========================================================================

-- Configure session role
SELECT set_config('request.jwt.claim.role', 'service_role', true);
SET LOCAL app.finance_metadata_repair = 'on';

-- 1. Reverse FT2607-0003 if not already reversed
DO $$
DECLARE
  v_ft record;
  v_rev_id uuid;
BEGIN
  SELECT * INTO v_ft FROM public.fund_transfers WHERE transfer_number = 'FT2607-0003';
  IF v_ft.id IS NOT NULL AND v_ft.status = 'posted' THEN
    v_rev_id := public.reverse_fund_transfer(v_ft.id);
    
    -- Ensure the reversal journal is marked is_reversed = true so both original & reversal
    -- are cleanly ignored by queries filtering WHERE NOT is_reversed, and net to zero otherwise.
    UPDATE public.journal_entries
       SET is_reversed = true
     WHERE reference_id = v_ft.id
       AND reference_number LIKE 'REV-%';
       
    RAISE NOTICE 'Reversed FT2607-0003, reversal journal ID: %', v_rev_id;
  ELSE
    RAISE NOTICE 'FT2607-0003 already reversed or not posted (status: %)', v_ft.status;
  END IF;
END;
$$;

-- 2. Synchronize the 8 batch master cost fields with authoritative purchase_batch_cost_layers
UPDATE public.batches b
SET 
  landed_cost_per_unit = pbcl.final_functional_unit_cost,
  cost_per_unit = pbcl.final_functional_unit_cost,
  final_landed_cost = ROUND(b.import_quantity * pbcl.final_functional_unit_cost, 2),
  updated_at = now()
FROM public.purchase_batch_cost_layers pbcl
WHERE pbcl.batch_id = b.id
  AND b.batch_number IN (
    '17721025',
    'DX/L/25/0048',
    'PRAH0640725',
    '25CTH027',
    'EX/PG/26-27/M014',
    'DFK/125090136',
    '4001/1101/25/A-3146',
    '1699/2025'
  );

COMMIT;
`;

console.log('Executing final accounting cleanup on linked Supabase database...');
const stdout = execFileSync('supabase', ['db', 'query', '--linked', '--output-format', 'json', sql], {
  encoding: 'utf8',
  maxBuffer: 50 * 1024 * 1024,
});

console.log('Execution finished successfully.');
console.log(stdout);
