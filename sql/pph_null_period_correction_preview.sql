-- ==============================================================================
-- ANZEN ERP — PPh NULL TAX PERIOD CORRECTION PREVIEW SCRIPT
-- ==============================================================================
-- STATUS: PREVIEW ONLY — DO NOT EXECUTE WITHOUT EXPLICIT OWNER APPROVAL.
--
-- STRICT SAFEGUARDS INCLUDED:
-- 1. Updates ONLY records where pph_tax_period_id IS NULL (never overwrites).
-- 2. Exact match on id, voucher_number, and pph_amount for each row.
-- 3. Ricardo Suhendra W (EXP/26/179, EXP/26/180) assigned to November 2026 PPh21.
-- 4. EXP/26/345 excluded (retained as NULL).
-- 5. Wrapped in BEGIN ... COMMIT with strict row count assertions.
-- 6. Zero modifications to tax_periods, journal_entries, vouchers, or payments.
-- ==============================================================================

-- ------------------------------------------------------------------------------
-- PART 1: READ-ONLY VERIFICATION SELECT (BEFORE UPDATE)
-- Run this query to inspect all 32 candidate expenses prior to any modification.
-- ------------------------------------------------------------------------------
SELECT 
    fe.id,
    fe.voucher_number,
    fe.expense_date,
    fe.expense_category,
    fe.amount AS gross_amount,
    fe.pph_amount,
    fe.paid_amount,
    fe.approval_status,
    fe.tax_period_id AS current_general_tax_period_id,
    fe.pph_tax_period_id AS current_pph_tax_period_id,
    CASE 
        WHEN fe.voucher_number IN ('EXP/26/179', 'EXP/26/180') THEN 'bfc9d875-2df8-4999-9800-1ab920b105eb'::uuid
        WHEN fe.voucher_number = 'EXP/26/056' THEN '6d0d38c7-aae5-4fd2-abd4-b82077006193'::uuid
        WHEN fe.voucher_number IN ('EXP/26/101', 'EXP/26/119', 'EXP/26/174') THEN '771db4fb-0c6f-4bb2-84b9-dd6e265f5c1c'::uuid
        WHEN fe.voucher_number = 'EXP/26/116' THEN '585ad2e9-13a8-40fe-9d5f-d0816dc8cad1'::uuid
        WHEN fe.voucher_number = 'EXP/26/148' THEN '6c380273-bb37-4d35-a94a-4b2a95afee1c'::uuid
        WHEN fe.voucher_number IN ('EXP/26/138', 'EXP/26/152') THEN 'bdeb7f72-a071-400f-b919-c2c39fe2f32c'::uuid
        WHEN fe.voucher_number = 'EXP/26-26/005' THEN 'f00a398f-664b-4619-b899-81124271353d'::uuid
        WHEN fe.voucher_number = 'EXP/26-26/008' THEN 'fa79b6b0-4af9-4fca-9049-554ef43e2026'::uuid
        WHEN fe.voucher_number = 'EXP/26-26/029' THEN '33122579-346c-48cd-ae4f-ee48ffbd65c6'::uuid
        WHEN fe.voucher_number = 'EXP/26-26/034' THEN '4366e140-360b-496d-b5de-c6a32f922d9c'::uuid
        WHEN fe.voucher_number = 'EXP/26-26/073' THEN 'a70d0563-36ba-4d1f-b052-5429468a3670'::uuid
        WHEN fe.voucher_number = 'EXP/26-26/067' THEN '7b20f162-b614-4430-a11a-4b75e97aff07'::uuid
        WHEN fe.voucher_number IN ('EXP/26-26/116', 'EXP/26-26/118') THEN 'c9f09090-fc0c-484e-af2d-d07896f53e82'::uuid
        WHEN fe.voucher_number = 'EXP/26-26/121' THEN '26817fdf-ca18-46f9-9280-c961b6b639d1'::uuid
        WHEN fe.voucher_number IN ('EXP/26/206', 'EXP/26/222', 'EXP/26/224', 'EXP/26/226') THEN '538a3c5e-673e-4c40-87d8-56f310607a35'::uuid
        WHEN fe.voucher_number = 'EXP/26/212' THEN 'b81fa230-564f-40e9-9d12-4ce969e5b35a'::uuid
        WHEN fe.voucher_number IN ('EXP/26/250', 'EXP/26/281') THEN '4daf1eec-1b01-4d37-bace-25ac5759abe0'::uuid
        WHEN fe.voucher_number = 'EXP/26/286' THEN '43b7832d-ddd0-46cf-bd60-d1228a83989d'::uuid
        WHEN fe.voucher_number IN ('EXP/26/304', 'EXP/26/363', 'EXP/26/364') THEN 'f2fffa5e-6a74-42b0-b30d-7403e15965b4'::uuid
        WHEN fe.voucher_number IN ('EXP/26/317', 'EXP/26/361') THEN 'a3108713-6918-4971-9c0f-95c6b1beee49'::uuid
    END AS proposed_pph_tax_period_id
FROM public.finance_expenses fe
WHERE fe.pph_amount > 0
  AND fe.pph_tax_period_id IS NULL
  AND fe.voucher_number <> 'EXP/26/345'
ORDER BY fe.expense_date, fe.voucher_number;

-- ------------------------------------------------------------------------------
-- PART 2: TRANSACTION-WRAPPED ATOMIC CORRECTION UPDATE SCRIPT
-- Execute ONLY when instructed by the business owner.
-- ------------------------------------------------------------------------------
BEGIN;

-- Pre-flight Safety Assertion: Confirm exactly 32 candidate rows exist with pph_tax_period_id IS NULL
DO $$
DECLARE
    v_candidate_count integer;
BEGIN
    SELECT count(*) INTO v_candidate_count
    FROM public.finance_expenses
    WHERE pph_amount > 0
      AND pph_tax_period_id IS NULL
      AND voucher_number <> 'EXP/26/345';

    IF v_candidate_count <> 32 THEN
        RAISE EXCEPTION 'Safety check failed: Expected 32 NULL PPh candidates, found %', v_candidate_count;
    END IF;
END $$;

-- Voucher EXP/26/056 (Nia Delisma Nasution - Rp120000 PPh) -> PPh21 2026-01
UPDATE public.finance_expenses
SET pph_tax_period_id = '6d0d38c7-aae5-4fd2-abd4-b82077006193'::uuid
WHERE id = '64c4f787-978a-4c23-8a3f-2b01ae881a8e'::uuid
  AND voucher_number = 'EXP/26/056'
  AND pph_amount = 120000
  AND pph_tax_period_id IS NULL;

-- Voucher EXP/26/174 (PT BERKAT KASIH BERSAUDARA - Rp9000 PPh) -> PPh23 2026-02
UPDATE public.finance_expenses
SET pph_tax_period_id = '771db4fb-0c6f-4bb2-84b9-dd6e265f5c1c'::uuid
WHERE id = '3a762d5b-0369-49de-ae25-4c1019b0508f'::uuid
  AND voucher_number = 'EXP/26/174'
  AND pph_amount = 9000
  AND pph_tax_period_id IS NULL;

-- Voucher EXP/26/101 (PT BERKAT KASIH BERSAUDARA - Rp58000 PPh) -> PPh23 2026-02
UPDATE public.finance_expenses
SET pph_tax_period_id = '771db4fb-0c6f-4bb2-84b9-dd6e265f5c1c'::uuid
WHERE id = '8f091c1e-d13f-4a96-8999-1e46884a1318'::uuid
  AND voucher_number = 'EXP/26/101'
  AND pph_amount = 58000
  AND pph_tax_period_id IS NULL;

-- Voucher EXP/26/119 (PT Harsonu - Rp140000 PPh) -> PPh23 2026-02
UPDATE public.finance_expenses
SET pph_tax_period_id = '771db4fb-0c6f-4bb2-84b9-dd6e265f5c1c'::uuid
WHERE id = 'dce25240-9ed2-4f3a-a095-16c6263b5a67'::uuid
  AND voucher_number = 'EXP/26/119'
  AND pph_amount = 140000
  AND pph_tax_period_id IS NULL;

-- Voucher EXP/26/116 (Nia Delisma Nasution - Rp120000 PPh) -> PPh21 2026-02
UPDATE public.finance_expenses
SET pph_tax_period_id = '585ad2e9-13a8-40fe-9d5f-d0816dc8cad1'::uuid
WHERE id = '1c40cd74-3437-4d1a-b196-4e627d162632'::uuid
  AND voucher_number = 'EXP/26/116'
  AND pph_amount = 120000
  AND pph_tax_period_id IS NULL;

-- Voucher EXP/26/138 (PT Nusantara Card Semesta - Rp52000 PPh) -> PPh23 2026-03
UPDATE public.finance_expenses
SET pph_tax_period_id = 'bdeb7f72-a071-400f-b919-c2c39fe2f32c'::uuid
WHERE id = 'a5b24bfd-8920-41fc-8275-220d37a5d398'::uuid
  AND voucher_number = 'EXP/26/138'
  AND pph_amount = 52000
  AND pph_tax_period_id IS NULL;

-- Voucher EXP/26/148 (Nia Delisma Nasution - Rp120000 PPh) -> PPh21 2026-03
UPDATE public.finance_expenses
SET pph_tax_period_id = '6c380273-bb37-4d35-a94a-4b2a95afee1c'::uuid
WHERE id = '7e65ae78-dc94-4f8c-8c70-5d5bea0967bb'::uuid
  AND voucher_number = 'EXP/26/148'
  AND pph_amount = 120000
  AND pph_tax_period_id IS NULL;

-- Voucher EXP/26/152 (PT Harsonu - Rp140000 PPh) -> PPh23 2026-03
UPDATE public.finance_expenses
SET pph_tax_period_id = 'bdeb7f72-a071-400f-b919-c2c39fe2f32c'::uuid
WHERE id = '6922661d-6c68-4a7b-b84e-bcfe04ce0e80'::uuid
  AND voucher_number = 'EXP/26/152'
  AND pph_amount = 140000
  AND pph_tax_period_id IS NULL;

-- Voucher EXP/26-26/005 (Nia Delisma Nasution - Rp120000 PPh) -> PPh21 2026-04
UPDATE public.finance_expenses
SET pph_tax_period_id = 'f00a398f-664b-4619-b899-81124271353d'::uuid
WHERE id = '44c06c88-291d-4a7b-b77f-e12f1c674414'::uuid
  AND voucher_number = 'EXP/26-26/005'
  AND pph_amount = 120000
  AND pph_tax_period_id IS NULL;

-- Voucher EXP/26-26/008 (PT Harsonu - Rp140000 PPh) -> PPh23 2026-04
UPDATE public.finance_expenses
SET pph_tax_period_id = 'fa79b6b0-4af9-4fca-9049-554ef43e2026'::uuid
WHERE id = '778e41dd-72e4-48dd-b6ce-2dce013bfac1'::uuid
  AND voucher_number = 'EXP/26-26/008'
  AND pph_amount = 140000
  AND pph_tax_period_id IS NULL;

-- Voucher EXP/26-26/029 (Nia Delisma Nasution - Rp120000 PPh) -> PPh21 2026-05
UPDATE public.finance_expenses
SET pph_tax_period_id = '33122579-346c-48cd-ae4f-ee48ffbd65c6'::uuid
WHERE id = 'c4d068b8-3990-4f9c-933e-55ec78791144'::uuid
  AND voucher_number = 'EXP/26-26/029'
  AND pph_amount = 120000
  AND pph_tax_period_id IS NULL;

-- Voucher EXP/26-26/034 (PT Harsonu - Rp140000 PPh) -> PPh23 2026-05
UPDATE public.finance_expenses
SET pph_tax_period_id = '4366e140-360b-496d-b5de-c6a32f922d9c'::uuid
WHERE id = '2bbfe192-f2d5-41b4-9e7c-148a31743f35'::uuid
  AND voucher_number = 'EXP/26-26/034'
  AND pph_amount = 140000
  AND pph_tax_period_id IS NULL;

-- Voucher EXP/26-26/067 (PT Harsonu - Rp140000 PPh) -> PPh23 2026-06
UPDATE public.finance_expenses
SET pph_tax_period_id = '7b20f162-b614-4430-a11a-4b75e97aff07'::uuid
WHERE id = '16556297-f6a2-41b0-bc5e-3bfa00c381d9'::uuid
  AND voucher_number = 'EXP/26-26/067'
  AND pph_amount = 140000
  AND pph_tax_period_id IS NULL;

-- Voucher EXP/26-26/073 (Nia Delisma Nasution - Rp120000 PPh) -> PPh21 2026-06
UPDATE public.finance_expenses
SET pph_tax_period_id = 'a70d0563-36ba-4d1f-b052-5429468a3670'::uuid
WHERE id = 'aa1e2912-6b65-4590-a45c-d38caf4d21e4'::uuid
  AND voucher_number = 'EXP/26-26/073'
  AND pph_amount = 120000
  AND pph_tax_period_id IS NULL;

-- Voucher EXP/26-26/116 (Nia Delisma Nasution - Rp120000 PPh) -> PPh21 2026-07
UPDATE public.finance_expenses
SET pph_tax_period_id = 'c9f09090-fc0c-484e-af2d-d07896f53e82'::uuid
WHERE id = '457674c8-02f4-4591-96cd-83ffe5a33fb6'::uuid
  AND voucher_number = 'EXP/26-26/116'
  AND pph_amount = 120000
  AND pph_tax_period_id IS NULL;

-- Voucher EXP/26-26/118 (Nuraenun Jariah - Rp87500 PPh) -> PPh21 2026-07
UPDATE public.finance_expenses
SET pph_tax_period_id = 'c9f09090-fc0c-484e-af2d-d07896f53e82'::uuid
WHERE id = '5f9e6a88-fc92-4835-9517-190cc92c699d'::uuid
  AND voucher_number = 'EXP/26-26/118'
  AND pph_amount = 87500
  AND pph_tax_period_id IS NULL;

-- Voucher EXP/26-26/121 (PT Harsonu - Rp140000 PPh) -> PPh23 2026-07
UPDATE public.finance_expenses
SET pph_tax_period_id = '26817fdf-ca18-46f9-9280-c961b6b639d1'::uuid
WHERE id = '1ffe03b8-e50d-4d02-b5e8-df82f586a88f'::uuid
  AND voucher_number = 'EXP/26-26/121'
  AND pph_amount = 140000
  AND pph_tax_period_id IS NULL;

-- Voucher EXP/26/179 (Ricardo Suhendra W - Rp50000 PPh) -> PPh21 2026-11
UPDATE public.finance_expenses
SET pph_tax_period_id = 'bfc9d875-2df8-4999-9800-1ab920b105eb'::uuid
WHERE id = '34ef7c58-64a0-4072-9f27-8948ef312f41'::uuid
  AND voucher_number = 'EXP/26/179'
  AND pph_amount = 50000
  AND pph_tax_period_id IS NULL;

-- Voucher EXP/26/180 (Ricardo Suhendra W - Rp50000 PPh) -> PPh21 2026-11
UPDATE public.finance_expenses
SET pph_tax_period_id = 'bfc9d875-2df8-4999-9800-1ab920b105eb'::uuid
WHERE id = '063afd7a-b9d9-41dd-bc3e-9c2f9a37b29f'::uuid
  AND voucher_number = 'EXP/26/180'
  AND pph_amount = 50000
  AND pph_tax_period_id IS NULL;

-- Voucher EXP/26/226 (Rudi Kartono - Rp447000 PPh) -> PPh21 2026-08
UPDATE public.finance_expenses
SET pph_tax_period_id = '538a3c5e-673e-4c40-87d8-56f310607a35'::uuid
WHERE id = 'c65a391d-1014-429f-918b-c335036ddf3b'::uuid
  AND voucher_number = 'EXP/26/226'
  AND pph_amount = 447000
  AND pph_tax_period_id IS NULL;

-- Voucher EXP/26/224 (YENY FAHRIANI - Rp375000 PPh) -> PPh21 2026-08
UPDATE public.finance_expenses
SET pph_tax_period_id = '538a3c5e-673e-4c40-87d8-56f310607a35'::uuid
WHERE id = '94266d06-dc23-4c8e-8de8-4e1b3c71913e'::uuid
  AND voucher_number = 'EXP/26/224'
  AND pph_amount = 375000
  AND pph_tax_period_id IS NULL;

-- Voucher EXP/26/212 (PT Harsonu - Rp140000 PPh) -> PPh23 2026-08
UPDATE public.finance_expenses
SET pph_tax_period_id = 'b81fa230-564f-40e9-9d12-4ce969e5b35a'::uuid
WHERE id = 'f09fcf55-4a87-4f6d-b5e6-85e6ff741d25'::uuid
  AND voucher_number = 'EXP/26/212'
  AND pph_amount = 140000
  AND pph_tax_period_id IS NULL;

-- Voucher EXP/26/206 (Nia Delisma Nasution - Rp120000 PPh) -> PPh21 2026-08
UPDATE public.finance_expenses
SET pph_tax_period_id = '538a3c5e-673e-4c40-87d8-56f310607a35'::uuid
WHERE id = 'a850519d-67cc-4b74-bc0a-8c13f5d51024'::uuid
  AND voucher_number = 'EXP/26/206'
  AND pph_amount = 120000
  AND pph_tax_period_id IS NULL;

-- Voucher EXP/26/222 (Nuraenun Jariah - Rp87500 PPh) -> PPh21 2026-08
UPDATE public.finance_expenses
SET pph_tax_period_id = '538a3c5e-673e-4c40-87d8-56f310607a35'::uuid
WHERE id = 'd2220cb6-bb2a-4f6d-bf82-fdbf8be996f9'::uuid
  AND voucher_number = 'EXP/26/222'
  AND pph_amount = 87500
  AND pph_tax_period_id IS NULL;

-- Voucher EXP/26/250 (Fenty Abidin SH - Rp64102 PPh) -> PPh21 2026-09
UPDATE public.finance_expenses
SET pph_tax_period_id = '4daf1eec-1b01-4d37-bace-25ac5759abe0'::uuid
WHERE id = '1dfd3d22-236f-4105-a373-bc5382ed9d8d'::uuid
  AND voucher_number = 'EXP/26/250'
  AND pph_amount = 64102
  AND pph_tax_period_id IS NULL;

-- Voucher EXP/26/286 (PT Harsonu - Rp140000 PPh) -> PPh23 2026-09
UPDATE public.finance_expenses
SET pph_tax_period_id = '43b7832d-ddd0-46cf-bd60-d1228a83989d'::uuid
WHERE id = 'c95de4c5-f655-4960-85ef-61c8637c58b0'::uuid
  AND voucher_number = 'EXP/26/286'
  AND pph_amount = 140000
  AND pph_tax_period_id IS NULL;

-- Voucher EXP/26/281 (Nia Delisma Nasution - Rp120000 PPh) -> PPh21 2026-09
UPDATE public.finance_expenses
SET pph_tax_period_id = '4daf1eec-1b01-4d37-bace-25ac5759abe0'::uuid
WHERE id = '0e99d7ec-8bd0-48da-ad39-79ed7b9e097b'::uuid
  AND voucher_number = 'EXP/26/281'
  AND pph_amount = 120000
  AND pph_tax_period_id IS NULL;

-- Voucher EXP/26/317 (PT. TRANS EXIS JAYA - Rp52000 PPh) -> PPh23 2026-10
UPDATE public.finance_expenses
SET pph_tax_period_id = 'a3108713-6918-4971-9c0f-95c6b1beee49'::uuid
WHERE id = '25974efd-37fe-400c-b635-514387acbb45'::uuid
  AND voucher_number = 'EXP/26/317'
  AND pph_amount = 52000
  AND pph_tax_period_id IS NULL;

-- Voucher EXP/26/304 (YENY FAHRIANI - Rp112500 PPh) -> PPh21 2026-10
UPDATE public.finance_expenses
SET pph_tax_period_id = 'f2fffa5e-6a74-42b0-b30d-7403e15965b4'::uuid
WHERE id = '6c650919-1970-4ec9-85e4-7cc68dedddf6'::uuid
  AND voucher_number = 'EXP/26/304'
  AND pph_amount = 112500
  AND pph_tax_period_id IS NULL;

-- Voucher EXP/26/361 (PT Harsonu - Rp140000 PPh) -> PPh23 2026-10
UPDATE public.finance_expenses
SET pph_tax_period_id = 'a3108713-6918-4971-9c0f-95c6b1beee49'::uuid
WHERE id = 'a59447da-f090-4466-af7f-455d0dbc6296'::uuid
  AND voucher_number = 'EXP/26/361'
  AND pph_amount = 140000
  AND pph_tax_period_id IS NULL;

-- Voucher EXP/26/364 (Tiara Zalfa Imtinan - Rp120000 PPh) -> PPh21 2026-10
UPDATE public.finance_expenses
SET pph_tax_period_id = 'f2fffa5e-6a74-42b0-b30d-7403e15965b4'::uuid
WHERE id = '37698222-fff1-4659-a62b-95613b462260'::uuid
  AND voucher_number = 'EXP/26/364'
  AND pph_amount = 120000
  AND pph_tax_period_id IS NULL;

-- Voucher EXP/26/363 (Nia Delisma Nasution - Rp170000 PPh) -> PPh21 2026-10
UPDATE public.finance_expenses
SET pph_tax_period_id = 'f2fffa5e-6a74-42b0-b30d-7403e15965b4'::uuid
WHERE id = '16ba0fa9-62e9-421e-9697-c4e75d40e3aa'::uuid
  AND voucher_number = 'EXP/26/363'
  AND pph_amount = 170000
  AND pph_tax_period_id IS NULL;


-- Post-flight Safety Assertion: Confirm exactly 1 record remains NULL (EXP/26/345)
DO $$
DECLARE
    v_remaining_null integer;
    v_unpaid_voucher text;
BEGIN
    SELECT count(*), max(voucher_number) INTO v_remaining_null, v_unpaid_voucher
    FROM public.finance_expenses
    WHERE pph_amount > 0
      AND pph_tax_period_id IS NULL;

    IF v_remaining_null <> 1 OR v_unpaid_voucher <> 'EXP/26/345' THEN
        RAISE EXCEPTION 'Safety check failed: Expected exactly 1 remaining NULL record (EXP/26/345), found % with voucher %', v_remaining_null, v_unpaid_voucher;
    END IF;
END $$;

-- If all checks pass, commit transaction
COMMIT;

-- ------------------------------------------------------------------------------
-- PART 3: BEFORE-AND-AFTER RECONCILIATION QUERY
-- Run this query after update to verify exact expense sums vs tax_periods.pph_total.
-- ------------------------------------------------------------------------------
SELECT 
    tp.fiscal_year,
    tp.period_month,
    tp.tax_type,
    tp.id AS tax_period_id,
    tp.pph_total AS accepted_period_total,
    coalesce(sum(fe.pph_amount), 0) AS allocated_expense_pph_sum,
    count(fe.id) AS allocated_expense_count,
    coalesce(sum(fe.pph_amount), 0) - tp.pph_total AS variance,
    CASE 
        WHEN coalesce(sum(fe.pph_amount), 0) - tp.pph_total = 0 THEN 'PERFECT MATCH'
        WHEN tp.tax_type = 'PPh21' AND tp.period_month = 8 AND (coalesce(sum(fe.pph_amount), 0) - tp.pph_total) = -100000 
            THEN 'EXPECTED VARIANCE (-100k Ricardo Suhendra moved to Nov per owner decision)'
        WHEN tp.tax_type = 'PPh21' AND tp.period_month = 11 AND (coalesce(sum(fe.pph_amount), 0) - tp.pph_total) = 100000 
            THEN 'EXPECTED VARIANCE (+100k Ricardo Suhendra allocated to Nov per owner decision)'
        ELSE 'UNEXPECTED VARIANCE'
    END AS audit_status
FROM public.tax_periods tp
LEFT JOIN public.finance_expenses fe ON fe.pph_tax_period_id = tp.id
WHERE tp.fiscal_year = 2026
  AND tp.tax_type IN ('PPh21', 'PPh23')
  AND tp.period_month BETWEEN 1 AND 11
GROUP BY tp.fiscal_year, tp.period_month, tp.tax_type, tp.id, tp.pph_total
ORDER BY tp.period_month, tp.tax_type;

-- ------------------------------------------------------------------------------
-- PART 4: ROLLBACK SCRIPT (IF EVER REQUIRED)
-- Restores pph_tax_period_id = NULL for ONLY these exact 32 expense IDs.
-- ------------------------------------------------------------------------------
/*
BEGIN;

UPDATE public.finance_expenses
SET pph_tax_period_id = NULL
WHERE id IN (
    '64c4f787-978a-4c23-8a3f-2b01ae881a8e'::uuid,
    '3a762d5b-0369-49de-ae25-4c1019b0508f'::uuid,
    '8f091c1e-d13f-4a96-8999-1e46884a1318'::uuid,
    'dce25240-9ed2-4f3a-a095-16c6263b5a67'::uuid,
    '1c40cd74-3437-4d1a-b196-4e627d162632'::uuid,
    'a5b24bfd-8920-41fc-8275-220d37a5d398'::uuid,
    '7e65ae78-dc94-4f8c-8c70-5d5bea0967bb'::uuid,
    '6922661d-6c68-4a7b-b84e-bcfe04ce0e80'::uuid,
    '44c06c88-291d-4a7b-b77f-e12f1c674414'::uuid,
    '778e41dd-72e4-48dd-b6ce-2dce013bfac1'::uuid,
    'c4d068b8-3990-4f9c-933e-55ec78791144'::uuid,
    '2bbfe192-f2d5-41b4-9e7c-148a31743f35'::uuid,
    '16556297-f6a2-41b0-bc5e-3bfa00c381d9'::uuid,
    'aa1e2912-6b65-4590-a45c-d38caf4d21e4'::uuid,
    '457674c8-02f4-4591-96cd-83ffe5a33fb6'::uuid,
    '5f9e6a88-fc92-4835-9517-190cc92c699d'::uuid,
    '1ffe03b8-e50d-4d02-b5e8-df82f586a88f'::uuid,
    '34ef7c58-64a0-4072-9f27-8948ef312f41'::uuid,
    '063afd7a-b9d9-41dd-bc3e-9c2f9a37b29f'::uuid,
    'c65a391d-1014-429f-918b-c335036ddf3b'::uuid,
    '94266d06-dc23-4c8e-8de8-4e1b3c71913e'::uuid,
    'f09fcf55-4a87-4f6d-b5e6-85e6ff741d25'::uuid,
    'a850519d-67cc-4b74-bc0a-8c13f5d51024'::uuid,
    'd2220cb6-bb2a-4f6d-bf82-fdbf8be996f9'::uuid,
    '1dfd3d22-236f-4105-a373-bc5382ed9d8d'::uuid,
    'c95de4c5-f655-4960-85ef-61c8637c58b0'::uuid,
    '0e99d7ec-8bd0-48da-ad39-79ed7b9e097b'::uuid,
    '25974efd-37fe-400c-b635-514387acbb45'::uuid,
    '6c650919-1970-4ec9-85e4-7cc68dedddf6'::uuid,
    'a59447da-f090-4466-af7f-455d0dbc6296'::uuid,
    '37698222-fff1-4659-a62b-95613b462260'::uuid,
    '16ba0fa9-62e9-421e-9697-c4e75d40e3aa'::uuid
)
AND voucher_number IN (
    'EXP/26/056',
    'EXP/26/174',
    'EXP/26/101',
    'EXP/26/119',
    'EXP/26/116',
    'EXP/26/138',
    'EXP/26/148',
    'EXP/26/152',
    'EXP/26-26/005',
    'EXP/26-26/008',
    'EXP/26-26/029',
    'EXP/26-26/034',
    'EXP/26-26/067',
    'EXP/26-26/073',
    'EXP/26-26/116',
    'EXP/26-26/118',
    'EXP/26-26/121',
    'EXP/26/179',
    'EXP/26/180',
    'EXP/26/226',
    'EXP/26/224',
    'EXP/26/212',
    'EXP/26/206',
    'EXP/26/222',
    'EXP/26/250',
    'EXP/26/286',
    'EXP/26/281',
    'EXP/26/317',
    'EXP/26/304',
    'EXP/26/361',
    'EXP/26/364',
    'EXP/26/363'
);

COMMIT;
*/
