-- Migration: 20260908153000_repair_august_september_sales_cogs_snapshots.sql
-- Description: Backfill authoritative historical COGS snapshots for August and September 2026 sales invoices
--              and correct SAPJ-26-045 to its forensically proven historical posting allocation.
-- Zero GL change, zero inventory change, zero batch cost change, zero revenue change.

BEGIN;

-- ============================================================================
-- 1. PART 1: Correct SAPJ-26-045 to forensically proven historical values
--    Diclofenac Potassium = Rp141,296.94/unit * 150 = Rp21,194,541.00
--    Corn Starch BP       = Rp10,008.60/unit * 1000 = Rp10,008,600.00
--    Total = Rp31,203,141.00 (reconciles 100% to JE2609-0007)
-- ============================================================================
UPDATE public.sales_invoice_items
SET cogs_unit_cost = 141296.94,
    cogs_total_cost = 21194541.00
WHERE id = '2886ee2a-c6f6-4073-8dbe-45da3c6ff63a'
  AND invoice_id = '47b60acf-e3b7-44da-91ea-15c6e716bfe7';

UPDATE public.sales_invoice_items
SET cogs_unit_cost = 10008.60,
    cogs_total_cost = 10008600.00
WHERE id = '47da953f-cfe3-4239-ac4a-33f69e0a156f'
  AND invoice_id = '47b60acf-e3b7-44da-91ea-15c6e716bfe7';

-- ============================================================================
-- 2. Multi-line Invoice SAPJ-26-044
--    MCC PH-102 (Qty 25)  @ Rp42,348.49 = Rp1,058,712.25
--    MCC PH-101 (Qty 100) @ Rp40,282.71 = Rp4,028,271.00
--    Total = Rp5,086,983.25 (reconciles 100% to JE2609-0049)
-- ============================================================================
UPDATE public.sales_invoice_items
SET cogs_unit_cost = 42348.49,
    cogs_total_cost = 1058712.25
WHERE id = '5b6dd348-4b2d-4a0f-9461-1d97bf665e5a'
  AND invoice_id = 'e3b01ec5-ec9e-4454-ad48-665852259d5d';

UPDATE public.sales_invoice_items
SET cogs_unit_cost = 40282.71,
    cogs_total_cost = 4028271.00
WHERE id = 'ee70d8a3-c42c-4f42-8d77-babafb2b906b'
  AND invoice_id = 'e3b01ec5-ec9e-4454-ad48-665852259d5d';

-- ============================================================================
-- 3. Single-line Invoices (SAPJ-26-035 through SAPJ-26-053)
--    Each single-line invoice has 100% of posted COGS uniquely attributable
-- ============================================================================

-- SAPJ-26-035 (Pregabalin, Qty 100, JE2609-0006 = Rp101,716,562.00)
UPDATE public.sales_invoice_items
SET cogs_unit_cost = 1017165.62,
    cogs_total_cost = 101716562.00
WHERE id = '1c1a4883-4fb3-4969-8c52-a1be1e8c9a67';

-- SAPJ-26-036 (Diclofenac Potassium, Qty 75, Net Posted COGS = Rp10,597,270.50 across JE2608-0067, HFR-260904-FCOGS-036, HFR-260904-FCOGS-FIX-16)
UPDATE public.sales_invoice_items
SET cogs_unit_cost = 141296.94,
    cogs_total_cost = 10597270.50
WHERE id = 'dfcc4439-dcfe-4c6a-b05a-a429cc12381e';

-- SAPJ-26-037 (Cetirizine HCl EP, Qty 25, Net Posted COGS = Rp14,700,479.50 across JE2608-0066, HFR-260904-FCOGS-037)
UPDATE public.sales_invoice_items
SET cogs_unit_cost = 588019.18,
    cogs_total_cost = 14700479.50
WHERE id = '4c7393a2-3d51-4abd-8e79-8efdb20c022d';

-- SAPJ-26-038 (Piperazine Phosphate, Qty 600, JE2609-0005 = Rp91,608,738.00)
UPDATE public.sales_invoice_items
SET cogs_unit_cost = 152681.23,
    cogs_total_cost = 91608738.00
WHERE id = 'f31d5bd0-1083-4ce3-9855-2f7294e985d1';

-- SAPJ-26-039 (Corn Starch BP, Qty 300, JE2609-0009 = Rp2,964,498.00)
UPDATE public.sales_invoice_items
SET cogs_unit_cost = 9881.66,
    cogs_total_cost = 2964498.00
WHERE id = '1e1869cf-2cb4-4c48-a3da-e6128531c934';

-- SAPJ-26-040 (Corn Starch BP, Qty 4525, JE2609-0008 = Rp44,714,511.50)
UPDATE public.sales_invoice_items
SET cogs_unit_cost = 9881.66,
    cogs_total_cost = 44714511.50
WHERE id = '4f651d4a-8af5-4a8d-9680-f2acd6f87dea';

-- SAPJ-26-041 (MCC PH-102, Qty 125, Net Posted COGS = Rp5,293,561.25 across JE2608-0051, HFR-260904-FCOGS-038, HFR-260904-FCOGS-FIX-17)
UPDATE public.sales_invoice_items
SET cogs_unit_cost = 42348.49,
    cogs_total_cost = 5293561.25
WHERE id = 'ec7d4d89-624e-4f41-8970-85cb724ffcc8';

-- SAPJ-26-042 (Diclofenac Sodium, Qty 200, JE2609-0047 = Rp36,000,000.00)
UPDATE public.sales_invoice_items
SET cogs_unit_cost = 180000.00,
    cogs_total_cost = 36000000.00
WHERE id = '04c9b531-689f-4291-8e5f-723b01290e18';

-- SAPJ-26-043 (Diclofenac Sodium, Qty 300, JE2609-0048 = Rp54,000,000.00)
UPDATE public.sales_invoice_items
SET cogs_unit_cost = 180000.00,
    cogs_total_cost = 54000000.00
WHERE id = 'bd57805a-d15e-4b8a-a118-21c71245f0b9';

-- SAPJ-26-046 (Corn Starch BP, Qty 500, JE2609-0025 = Rp5,004,300.00)
UPDATE public.sales_invoice_items
SET cogs_unit_cost = 10008.60,
    cogs_total_cost = 5004300.00
WHERE id = '85c2f253-6cc8-4f87-81fb-1775990d9a2e';

-- SAPJ-26-047 (Corn Starch BP, Qty 500, JE2609-0028 = Rp5,004,300.00)
UPDATE public.sales_invoice_items
SET cogs_unit_cost = 10008.60,
    cogs_total_cost = 5004300.00
WHERE id = '99c1f69b-5afb-4af1-bd68-d6142b474772';

-- SAPJ-26-048 (Cefixime USP, Qty 125, JE2609-0031 = Rp284,488,486.25)
UPDATE public.sales_invoice_items
SET cogs_unit_cost = 2275907.89,
    cogs_total_cost = 284488486.25
WHERE id = 'ab322cf1-225a-4d77-9898-b1452a178b2f';

-- SAPJ-26-049 (Corn Starch BP, Qty 4175, JE2609-0033 = Rp41,255,930.50)
UPDATE public.sales_invoice_items
SET cogs_unit_cost = 9881.66,
    cogs_total_cost = 41255930.50
WHERE id = '805bd9e9-6f4b-4faa-8a78-2830691ef8f8';

-- SAPJ-26-050 (Corn Starch BP, Qty 1000, JE2609-0035 = Rp10,008,600.00)
UPDATE public.sales_invoice_items
SET cogs_unit_cost = 10008.60,
    cogs_total_cost = 10008600.00
WHERE id = '3ec1e936-2e75-474b-a565-aac43d4ae824';

-- SAPJ-26-051 (MCC PH-101, Qty 500, JE2609-0037 = Rp20,141,355.00)
UPDATE public.sales_invoice_items
SET cogs_unit_cost = 40282.71,
    cogs_total_cost = 20141355.00
WHERE id = '53a41550-1b47-49a9-82f6-910c0ed12098';

-- SAPJ-26-052 (Corn Starch BP, Qty 7000, JE2609-0039 = Rp70,060,200.00)
UPDATE public.sales_invoice_items
SET cogs_unit_cost = 10008.60,
    cogs_total_cost = 70060200.00
WHERE id = '35974d7e-e595-4e96-a4a2-f1a699430648';

-- SAPJ-26-053 (MCC PH-101, Qty 125, JE2609-0041 = Rp5,035,338.75)
UPDATE public.sales_invoice_items
SET cogs_unit_cost = 40282.71,
    cogs_total_cost = 5035338.75
WHERE id = 'd2aa55c2-0df8-4ac8-ab78-1ed277b37350';

-- ============================================================================
-- 4. Attribution on single-line COGS journal lines (links journal line to item)
--    Preserves GL amounts and accounts while enabling direct item reconciliation
-- ============================================================================
UPDATE public.journal_entry_lines jel
SET sales_invoice_item_id = sii.id,
    batch_id = sii.batch_id
FROM public.journal_entries je
JOIN public.sales_invoices si ON si.id = je.reference_id
JOIN public.sales_invoice_items sii ON sii.invoice_id = si.id
WHERE jel.journal_entry_id = je.id
  AND (je.source_module = 'sales_invoice_cogs' OR je.source_module LIKE 'historical_cogs%')
  AND je.is_posted = true
  AND NOT COALESCE(je.is_reversed, false)
  AND jel.sales_invoice_item_id IS NULL
  AND si.invoice_number IN (
    'SAPJ-26-035', 'SAPJ-26-036', 'SAPJ-26-037', 'SAPJ-26-038', 'SAPJ-26-039',
    'SAPJ-26-040', 'SAPJ-26-041', 'SAPJ-26-042', 'SAPJ-26-043', 'SAPJ-26-046',
    'SAPJ-26-047', 'SAPJ-26-048', 'SAPJ-26-049', 'SAPJ-26-050', 'SAPJ-26-051',
    'SAPJ-26-052', 'SAPJ-26-053'
  );

COMMIT;
