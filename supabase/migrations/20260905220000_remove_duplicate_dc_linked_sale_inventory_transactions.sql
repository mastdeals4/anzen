-- Migration: Remove 21 Proven Duplicate DC-Linked Sale Inventory Transactions
-- Description:
-- Removes 21 historical duplicate 'sale' records from public.inventory_transactions that double-deducted
-- inventory movements for dispatches already accounted for by approved Delivery Challans ('delivery_challan').
--
-- Background:
-- When Delivery Challans were approved, stock was correctly deducted from batches.current_stock
-- and recorded as transaction_type = 'delivery_challan'. Subsequent invoice triggers or backfill
-- migration 20260225062555 inserted a second movement (transaction_type = 'sale') for the same dispatch.
--
-- Safety & Auditability:
-- - This migration deletes ONLY the 21 proven duplicate inventory_transactions IDs and their FK classification rows.
-- - batches.current_stock is NOT modified (physical stock remains exactly 23,785.000 kg across 30 active batches).
-- - GL 1130 and all journal entries are NOT modified (Account 1130 remains exactly Rp1,982,552,282.65).
-- - Each deleted row is preserved in audit_removed_duplicate_sale_inventory_transactions with full provenance.

BEGIN;

-- 1. Enable inventory engine override for controlled administrative data repair
SET LOCAL app.canonical_stock_engine = 'on';

-- 2. Create permanent auditable log table if not exists
CREATE TABLE IF NOT EXISTS public.audit_removed_duplicate_sale_inventory_transactions (
    deleted_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
    repair_reason TEXT NOT NULL,
    transaction_id UUID NOT NULL,
    batch_id UUID NOT NULL,
    product_id UUID,
    quantity NUMERIC,
    transaction_type TEXT,
    reference_id UUID,
    reference_type TEXT,
    reference_number TEXT,
    transaction_date DATE,
    notes TEXT,
    matching_dc_transaction_id UUID,
    matching_dc_reference_number TEXT,
    classification_notes TEXT
);

-- 3. Populate audit table with the 21 duplicate records and their matching DC transactions
INSERT INTO public.audit_removed_duplicate_sale_inventory_transactions (
    repair_reason,
    transaction_id,
    batch_id,
    product_id,
    quantity,
    transaction_type,
    reference_id,
    reference_type,
    reference_number,
    transaction_date,
    notes,
    matching_dc_transaction_id,
    matching_dc_reference_number,
    classification_notes
)
SELECT 
    'Duplicate DC-linked sale movement; physical deduction already recorded by approved DC transaction',
    it_sale.id,
    it_sale.batch_id,
    it_sale.product_id,
    it_sale.quantity,
    it_sale.transaction_type,
    it_sale.reference_id,
    it_sale.reference_type,
    it_sale.reference_number,
    it_sale.transaction_date,
    it_sale.notes,
    it_dc.id,
    it_dc.reference_number,
    c.reason
FROM public.inventory_transactions it_sale
JOIN public.sales_invoice_items sii ON sii.id = it_sale.reference_id AND it_sale.reference_type = 'sales_invoice_item'
JOIN public.delivery_challan_items dci ON dci.id = sii.delivery_challan_item_id
JOIN public.delivery_challans dc ON dc.id = dci.challan_id
JOIN public.inventory_transactions it_dc ON it_dc.batch_id = it_sale.batch_id 
    AND (it_dc.reference_id = dci.id OR it_dc.reference_id = dci.challan_id)
    AND it_dc.transaction_type = 'delivery_challan'
LEFT JOIN public.inventory_historical_movement_classifications c ON c.transaction_id = it_sale.id
WHERE it_sale.id IN (
    '72c3e16b-64e1-438c-9b6f-4496103e0247',
    '2b929d2d-7207-4994-ae9b-854c5035b1ad',
    '5a914016-e770-44a4-aabc-1cecb6a91e86',
    '105bed14-f6a1-4ca1-9c82-c53787ae617b',
    '5fe8f625-9bad-45b1-9af4-3241d17f7b3f',
    '9e334737-e019-472f-a27d-61fc815235d6',
    '2367cc0b-4b6d-49a8-bddb-a9fb316a213e',
    'aad4f2bb-99bd-43c6-a29e-8df81692b319',
    '643f3033-56fc-4536-a10d-9915e363b00a',
    'eb750a5c-e6a1-4954-92c9-d29164522a45',
    'b84c456f-314a-4d17-8e64-9144f7c0c383',
    'bd3ee2b6-90f9-462f-8124-31db91ec5c58',
    '8dd6a7e8-d1db-4ecb-b38e-4c3742c6ed67',
    'e90e72e0-3e8b-4ddd-8a62-c3c1bf7758cc',
    '4569b748-c823-4e9e-ab1c-4900788861ba',
    '7fc5f381-a6ef-4109-9e48-41ef4364c221',
    'e55f77b9-d0a1-462a-acb4-e8d3a3a458d6',
    'f865913e-0d47-43d3-b10d-daf0e3994bae',
    'e30f3c41-bb6e-4dac-906f-3ab2653b5b90',
    'e3e39538-df32-4cb3-8f73-f9d96a49baf6',
    'b9b25fb8-4d1b-42da-807f-e7c9a874df72'
)
ON CONFLICT DO NOTHING;

-- 4. Delete referencing rows in classification table
DELETE FROM public.inventory_historical_movement_classifications
WHERE transaction_id IN (
    '72c3e16b-64e1-438c-9b6f-4496103e0247',
    '2b929d2d-7207-4994-ae9b-854c5035b1ad',
    '5a914016-e770-44a4-aabc-1cecb6a91e86',
    '105bed14-f6a1-4ca1-9c82-c53787ae617b',
    '5fe8f625-9bad-45b1-9af4-3241d17f7b3f',
    '9e334737-e019-472f-a27d-61fc815235d6',
    '2367cc0b-4b6d-49a8-bddb-a9fb316a213e',
    'aad4f2bb-99bd-43c6-a29e-8df81692b319',
    '643f3033-56fc-4536-a10d-9915e363b00a',
    'eb750a5c-e6a1-4954-92c9-d29164522a45',
    'b84c456f-314a-4d17-8e64-9144f7c0c383',
    'bd3ee2b6-90f9-462f-8124-31db91ec5c58',
    '8dd6a7e8-d1db-4ecb-b38e-4c3742c6ed67',
    'e90e72e0-3e8b-4ddd-8a62-c3c1bf7758cc',
    '4569b748-c823-4e9e-ab1c-4900788861ba',
    '7fc5f381-a6ef-4109-9e48-41ef4364c221',
    'e55f77b9-d0a1-462a-acb4-e8d3a3a458d6',
    'f865913e-0d47-43d3-b10d-daf0e3994bae',
    'e30f3c41-bb6e-4dac-906f-3ab2653b5b90',
    'e3e39538-df32-4cb3-8f73-f9d96a49baf6',
    'b9b25fb8-4d1b-42da-807f-e7c9a874df72'
);

-- 5. Delete ONLY the 21 proven duplicate inventory_transactions records
DELETE FROM public.inventory_transactions
WHERE id IN (
    '72c3e16b-64e1-438c-9b6f-4496103e0247',
    '2b929d2d-7207-4994-ae9b-854c5035b1ad',
    '5a914016-e770-44a4-aabc-1cecb6a91e86',
    '105bed14-f6a1-4ca1-9c82-c53787ae617b',
    '5fe8f625-9bad-45b1-9af4-3241d17f7b3f',
    '9e334737-e019-472f-a27d-61fc815235d6',
    '2367cc0b-4b6d-49a8-bddb-a9fb316a213e',
    'aad4f2bb-99bd-43c6-a29e-8df81692b319',
    '643f3033-56fc-4536-a10d-9915e363b00a',
    'eb750a5c-e6a1-4954-92c9-d29164522a45',
    'b84c456f-314a-4d17-8e64-9144f7c0c383',
    'bd3ee2b6-90f9-462f-8124-31db91ec5c58',
    '8dd6a7e8-d1db-4ecb-b38e-4c3742c6ed67',
    'e90e72e0-3e8b-4ddd-8a62-c3c1bf7758cc',
    '4569b748-c823-4e9e-ab1c-4900788861ba',
    '7fc5f381-a6ef-4109-9e48-41ef4364c221',
    'e55f77b9-d0a1-462a-acb4-e8d3a3a458d6',
    'f865913e-0d47-43d3-b10d-daf0e3994bae',
    'e30f3c41-bb6e-4dac-906f-3ab2653b5b90',
    'e3e39538-df32-4cb3-8f73-f9d96a49baf6',
    'b9b25fb8-4d1b-42da-807f-e7c9a874df72'
);

-- 6. Post-execution strict assertions
DO $$
DECLARE
    v_active_stock NUMERIC;
    v_positive_batches INT;
    v_remaining_duplicates INT;
    v_gl_balance NUMERIC;
BEGIN
    -- Assert physical stock unchanged
    SELECT SUM(current_stock), COUNT(*)
      INTO v_active_stock, v_positive_batches
      FROM public.batches
     WHERE current_stock > 0;

    IF v_active_stock <> 23785.000 THEN
        RAISE EXCEPTION 'Assertion failed: total active stock is %, expected 23785.000', v_active_stock;
    END IF;

    IF v_positive_batches <> 30 THEN
        RAISE EXCEPTION 'Assertion failed: positive batch count is %, expected 30', v_positive_batches;
    END IF;

    -- Assert 21 duplicate rows are completely removed
    SELECT COUNT(*) INTO v_remaining_duplicates
      FROM public.inventory_transactions
     WHERE id IN (
        '72c3e16b-64e1-438c-9b6f-4496103e0247',
        '2b929d2d-7207-4994-ae9b-854c5035b1ad',
        '5a914016-e770-44a4-aabc-1cecb6a91e86',
        '105bed14-f6a1-4ca1-9c82-c53787ae617b',
        '5fe8f625-9bad-45b1-9af4-3241d17f7b3f',
        '9e334737-e019-472f-a27d-61fc815235d6',
        '2367cc0b-4b6d-49a8-bddb-a9fb316a213e',
        'aad4f2bb-99bd-43c6-a29e-8df81692b319',
        '643f3033-56fc-4536-a10d-9915e363b00a',
        'eb750a5c-e6a1-4954-92c9-d29164522a45',
        'b84c456f-314a-4d17-8e64-9144f7c0c383',
        'bd3ee2b6-90f9-462f-8124-31db91ec5c58',
        '8dd6a7e8-d1db-4ecb-b38e-4c3742c6ed67',
        'e90e72e0-3e8b-4ddd-8a62-c3c1bf7758cc',
        '4569b748-c823-4e9e-ab1c-4900788861ba',
        '7fc5f381-a6ef-4109-9e48-41ef4364c221',
        'e55f77b9-d0a1-462a-acb4-e8d3a3a458d6',
        'f865913e-0d47-43d3-b10d-daf0e3994bae',
        'e30f3c41-bb6e-4dac-906f-3ab2653b5b90',
        'e3e39538-df32-4cb3-8f73-f9d96a49baf6',
        'b9b25fb8-4d1b-42da-807f-e7c9a874df72'
    );

    IF v_remaining_duplicates <> 0 THEN
        RAISE EXCEPTION 'Assertion failed: % duplicate rows still remain', v_remaining_duplicates;
    END IF;

    -- Assert GL 1130 unchanged
    SELECT SUM(jel.debit - jel.credit) INTO v_gl_balance
      FROM public.journal_entry_lines jel
      JOIN public.chart_of_accounts coa ON coa.id = jel.account_id
      JOIN public.journal_entries je ON je.id = jel.journal_entry_id
     WHERE coa.code = '1130' AND je.is_posted AND NOT COALESCE(je.is_reversed, false);

    IF v_gl_balance <> 1982552282.65 THEN
        RAISE EXCEPTION 'Assertion failed: GL 1130 balance is %, expected 1982552282.65', v_gl_balance;
    END IF;
END $$;

COMMIT;
