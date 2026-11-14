import fs from 'fs';
import path from 'path';

const BRAIN_DIR = '/Users/Kunal/.gemini/antigravity/brain/ba0a5665-f6f0-4bb7-bcd8-a665594273a2';
const jsonPath = path.join(BRAIN_DIR, 'pph_null_audit_records.json');
const records = JSON.parse(fs.readFileSync(jsonPath, 'utf8'));

// Exact Period IDs
const PERIOD_IDS = {
  'PPh21_2026_01': { id: '6d0d38c7-aae5-4fd2-abd4-b82077006193', name: 'PPh21 2026-01' },
  'PPh23_2026_01': { id: 'd2295c53-0c66-4aab-ae74-a15e86d0e897', name: 'PPh23 2026-01' },
  'PPh21_2026_02': { id: '585ad2e9-13a8-40fe-9d5f-d0816dc8cad1', name: 'PPh21 2026-02' },
  'PPh23_2026_02': { id: '771db4fb-0c6f-4bb2-84b9-dd6e265f5c1c', name: 'PPh23 2026-02' },
  'PPh21_2026_03': { id: '6c380273-bb37-4d35-a94a-4b2a95afee1c', name: 'PPh21 2026-03' },
  'PPh23_2026_03': { id: 'bdeb7f72-a071-400f-b919-c2c39fe2f32c', name: 'PPh23 2026-03' },
  'PPh21_2026_04': { id: 'f00a398f-664b-4619-b899-81124271353d', name: 'PPh21 2026-04' },
  'PPh23_2026_04': { id: 'fa79b6b0-4af9-4fca-9049-554ef43e2026', name: 'PPh23 2026-04' },
  'PPh21_2026_05': { id: '33122579-346c-48cd-ae4f-ee48ffbd65c6', name: 'PPh21 2026-05' },
  'PPh23_2026_05': { id: '4366e140-360b-496d-b5de-c6a32f922d9c', name: 'PPh23 2026-05' },
  'PPh21_2026_06': { id: 'a70d0563-36ba-4d1f-b052-5429468a3670', name: 'PPh21 2026-06' },
  'PPh23_2026_06': { id: '7b20f162-b614-4430-a11a-4b75e97aff07', name: 'PPh23 2026-06' },
  'PPh21_2026_07': { id: 'c9f09090-fc0c-484e-af2d-d07896f53e82', name: 'PPh21 2026-07' },
  'PPh23_2026_07': { id: '26817fdf-ca18-46f9-9280-c961b6b639d1', name: 'PPh23 2026-07' },
  'PPh21_2026_08': { id: '538a3c5e-673e-4c40-87d8-56f310607a35', name: 'PPh21 2026-08' },
  'PPh23_2026_08': { id: 'b81fa230-564f-40e9-9d12-4ce969e5b35a', name: 'PPh23 2026-08' },
  'PPh21_2026_09': { id: '4daf1eec-1b01-4d37-bace-25ac5759abe0', name: 'PPh21 2026-09' },
  'PPh23_2026_09': { id: '43b7832d-ddd0-46cf-bd60-d1228a83989d', name: 'PPh23 2026-09' },
  'PPh21_2026_10': { id: 'f2fffa5e-6a74-42b0-b30d-7403e15965b4', name: 'PPh21 2026-10' },
  'PPh23_2026_10': { id: 'a3108713-6918-4971-9c0f-95c6b1beee49', name: 'PPh23 2026-10' },
  'PPh21_2026_11': { id: 'bfc9d875-2df8-4999-9800-1ab920b105eb', name: 'PPh21 2026-11' },
};

// Filter out EXP/26/345 (unpaid, kept NULL)
const candidates = records.filter(r => r.voucher_number !== 'EXP/26/345');

// Map each candidate to target period
const mappedCandidates = candidates.map(r => {
  let targetKey = null;

  // Ricardo special case per owner decision: November 2026
  if (r.voucher_number === 'EXP/26/179' || r.voucher_number === 'EXP/26/180') {
    targetKey = 'PPh21_2026_11';
  } else {
    const d = new Date(r.expense_date);
    const m = String(d.getMonth() + 1).padStart(2, '0');
    targetKey = `${r.pph_tax_type}_2026_${m}`;
  }

  const target = PERIOD_IDS[targetKey];
  return {
    ...r,
    target_period_id: target.id,
    target_period_name: target.name,
  };
});

// 1. Generate SQL File
let sql = `-- ==============================================================================
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

`;

// Generate individual safe update statements
for (const cand of mappedCandidates) {
  sql += `-- Voucher ${cand.voucher_number} (${cand.recipient} - Rp${cand.pph_amount} PPh) -> ${cand.target_period_name}
UPDATE public.finance_expenses
SET pph_tax_period_id = '${cand.target_period_id}'::uuid
WHERE id = '${cand.id}'::uuid
  AND voucher_number = '${cand.voucher_number}'
  AND pph_amount = ${cand.pph_amount}
  AND pph_tax_period_id IS NULL;

`;
}

sql += `
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
${mappedCandidates.map(c => `    '${c.id}'::uuid`).join(',\n')}
)
AND voucher_number IN (
${mappedCandidates.map(c => `    '${c.voucher_number}'`).join(',\n')}
);

COMMIT;
*/
`;

// Write SQL preview file
const sqlDir = path.resolve('sql');
if (!fs.existsSync(sqlDir)) fs.mkdirSync(sqlDir, { recursive: true });
const sqlFilePath = path.join(sqlDir, 'pph_null_period_correction_preview.sql');
fs.writeFileSync(sqlFilePath, sql, 'utf8');

const brainSqlFilePath = path.join(BRAIN_DIR, 'pph_null_period_correction_preview.sql');
fs.writeFileSync(brainSqlFilePath, sql, 'utf8');

console.log('SQL Preview Script generated:');
console.log('1.', sqlFilePath);
console.log('2.', brainSqlFilePath);

