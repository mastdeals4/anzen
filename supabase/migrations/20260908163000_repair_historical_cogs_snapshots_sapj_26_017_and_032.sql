-- Migration: 20260908163000_repair_historical_cogs_snapshots_sapj_26_017_and_032.sql
-- Description: Backfill forensically proven historical line-level COGS snapshots for SAPJ-26-017 and SAPJ-26-032.
--              Proven from immutable audit_logs of batch landed cost at the exact COGS posting timestamps.
-- Zero GL change, zero inventory change, zero current batch cost change.

BEGIN;

-- ============================================================================
-- 1. Invoice SAPJ-26-017 (2026-05-05) — Ibuprofen BP
--    Total Posted COGS = Rp73,597,342.50 across JE2607-0001 and HFR-260904-FCOGS-024
--    Proven batch landed cost at posting time (2026-09-03 17:52:38 UTC) was Rp163,549.65/kg
--    Total qty = 450 kg (150 kg + 250 kg + 50 kg)
--    450 * 163,549.65 = Rp73,597,342.50 (100% exact match to posted COGS, Rp0.00 diff)
-- ============================================================================

-- Line 1: Batch 4001/1101/25/A-3147 (Qty 150 kg)
UPDATE public.sales_invoice_items
SET cogs_unit_cost = 163549.65,
    cogs_total_cost = 24532447.50
WHERE id = '3286a2c5-461f-4571-bf71-6ca050e72f29'
  AND invoice_id = '662a7c07-df0a-463a-ba0c-2cff6381907f';

-- Line 2: Batch 4001/1101/25/A-3145 (Qty 250 kg)
UPDATE public.sales_invoice_items
SET cogs_unit_cost = 163549.65,
    cogs_total_cost = 40887412.50
WHERE id = '57d9c923-0a8f-4d61-99eb-e7bb1f351f63'
  AND invoice_id = '662a7c07-df0a-463a-ba0c-2cff6381907f';

-- Line 3: Batch 4001/1101/25/A-3146 (Qty 50 kg)
UPDATE public.sales_invoice_items
SET cogs_unit_cost = 163549.65,
    cogs_total_cost = 8177482.50
WHERE id = 'f185574f-3b80-48c0-be90-dd9278934e27'
  AND invoice_id = '662a7c07-df0a-463a-ba0c-2cff6381907f';


-- ============================================================================
-- 2. Invoice SAPJ-26-032 (2026-07-24) — Diclofenac Sodium
--    Total Posted COGS = Rp112,782,600.00 from JE2609-0044
--    Proven batch landed cost at posting time (2026-09-03 17:15:18 UTC) was Rp187,971.00/kg
--    Total qty = 600 kg (50 kg + 550 kg)
--    600 * 187,971.00 = Rp112,782,600.00 (100% exact match to posted COGS, Rp0.00 diff)
-- ============================================================================

-- Line 1: Batch DFS/126010052 (Qty 50 kg)
UPDATE public.sales_invoice_items
SET cogs_unit_cost = 187971.00,
    cogs_total_cost = 9398550.00
WHERE id = '387b8c44-cd87-4b2d-9fc2-b9ed819c8d07'
  AND invoice_id = '3300fde7-f257-4c5c-8f5e-f2780ca6600f';

-- Line 2: Batch DFS/125120557 (Qty 550 kg)
UPDATE public.sales_invoice_items
SET cogs_unit_cost = 187971.00,
    cogs_total_cost = 103384050.00
WHERE id = '54368b9e-33e0-439f-be71-4b1b88417dd4'
  AND invoice_id = '3300fde7-f257-4c5c-8f5e-f2780ca6600f';

COMMIT;
