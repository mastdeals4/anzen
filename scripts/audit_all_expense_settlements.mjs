import { execSync } from "child_process";
import fs from "fs";

console.log("Auditing all finance expenses with settlements...");

const sql = `
WITH expense_basis AS (
  SELECT 
    fe.id AS expense_id,
    fe.voucher_number,
    fe.expense_date,
    fe.amount AS gross_amount,
    COALESCE(fe.ppn_amount, 0) AS ppn_amount,
    COALESCE(fe.pph_amount, 0) AS pph_amount,
    fe.amount - COALESCE(fe.pph_amount, 0) AS net_payable,
    fe.paid_amount,
    fe.settlement_amount
  FROM finance_expenses fe
),
va_settlements AS (
  SELECT 
    va.finance_expense_id AS expense_id,
    SUM(va.allocated_amount) AS va_total,
    COUNT(DISTINCT va.payment_voucher_id) AS pv_count
  FROM voucher_allocations va
  JOIN payment_vouchers pv ON pv.id = va.payment_voucher_id
  WHERE COALESCE(pv.payment_purpose, 'general') NOT IN ('salary_advance', 'salary_advance_settlement')
  GROUP BY va.finance_expense_id
),
direct_je_settlements AS (
  -- Direct payment journals referencing this expense (source_module in ('expense_payment', 'expenses'))
  -- where bank COA is credited
  SELECT 
    je.reference_id AS expense_id,
    SUM(jel.credit - jel.debit) AS direct_je_bank_credit,
    COUNT(DISTINCT je.id) AS direct_je_count
  FROM journal_entries je
  JOIN journal_entry_lines jel ON jel.journal_entry_id = je.id
  JOIN chart_of_accounts coa ON coa.id = jel.account_id
  WHERE je.is_posted = true
    AND coa.code IN ('111101', '111102')
    AND je.source_module IN ('expense_payment', 'expenses', 'historical_repair')
    AND je.reference_id IS NOT NULL
  GROUP BY je.reference_id
),
bsa_allocations AS (
  SELECT 
    bsa.document_id AS expense_id,
    SUM(bsa.allocation_amount) AS bsa_total,
    COUNT(*) AS bsa_count
  FROM bank_statement_allocations bsa
  WHERE bsa.document_type = 'expense'
  GROUP BY bsa.document_id
),
bsl_legacy AS (
  SELECT 
    bsl.matched_expense_id AS expense_id,
    SUM(COALESCE(NULLIF(bsl.debit_amount, 0), bsl.credit_amount, 0)) AS bsl_legacy_total,
    COUNT(*) AS bsl_legacy_count
  FROM bank_statement_lines bsl
  WHERE bsl.matched_expense_id IS NOT NULL
    AND NOT EXISTS (
      SELECT 1 FROM bank_statement_allocations a WHERE a.bank_statement_line_id = bsl.id
    )
  GROUP BY bsl.matched_expense_id
)
SELECT 
  eb.expense_id,
  eb.voucher_number,
  eb.expense_date,
  eb.gross_amount,
  eb.pph_amount,
  eb.net_payable,
  COALESCE(va.va_total, 0) AS va_settlement,
  COALESCE(va.pv_count, 0) AS pv_count,
  COALESCE(dje.direct_je_bank_credit, 0) AS direct_je_settlement,
  COALESCE(dje.direct_je_count, 0) AS direct_je_count,
  COALESCE(bsa.bsa_total, 0) AS bsa_reconciliation,
  COALESCE(bsa.bsa_count, 0) AS bsa_count,
  COALESCE(leg.bsl_legacy_total, 0) AS bsl_legacy_total,
  COALESCE(leg.bsl_legacy_count, 0) AS bsl_legacy_count
FROM expense_basis eb
LEFT JOIN va_settlements va ON va.expense_id = eb.expense_id
LEFT JOIN direct_je_settlements dje ON dje.expense_id = eb.expense_id
LEFT JOIN bsa_allocations bsa ON bsa.expense_id = eb.expense_id
LEFT JOIN bsl_legacy leg ON leg.expense_id = eb.expense_id
WHERE COALESCE(va.va_total, 0) > 0 
   OR COALESCE(dje.direct_je_bank_credit, 0) > 0 
   OR COALESCE(bsa.bsa_total, 0) > 0 
   OR COALESCE(leg.bsl_legacy_total, 0) > 0
ORDER BY eb.expense_date, eb.voucher_number;
`;

fs.writeFileSync("/Users/Kunal/.gemini/antigravity-ide/brain/73556c95-1acf-43fd-9f69-2089a61e6410/scratch/expense_audit.sql", sql);
const res = execSync(`npx supabase db query --linked -o json --file /Users/Kunal/.gemini/antigravity-ide/brain/73556c95-1acf-43fd-9f69-2089a61e6410/scratch/expense_audit.sql`, {
  encoding: "utf8",
  maxBuffer: 30 * 1024 * 1024
});

fs.writeFileSync("/Users/Kunal/.gemini/antigravity-ide/brain/73556c95-1acf-43fd-9f69-2089a61e6410/scratch/expense_audit_results.json", res);
console.log("Expense settlement audit results written to scratch/expense_audit_results.json");
