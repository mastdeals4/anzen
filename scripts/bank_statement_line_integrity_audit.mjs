import { execSync } from "child_process";
import fs from "fs";

console.log("Running Bank Statement Line Integrity Audit (A through P)...");

const sql = `
WITH bsl_basis AS (
  SELECT 
    bsl.id AS bsl_id,
    bsl.upload_id,
    bsl.bank_account_id,
    bsl.transaction_date,
    bsl.description,
    bsl.debit_amount,
    bsl.credit_amount,
    COALESCE(NULLIF(bsl.debit_amount, 0), bsl.credit_amount, 0) AS line_amount,
    CASE WHEN bsl.debit_amount > 0 THEN 'debit' ELSE 'credit' END AS line_direction,
    bsl.currency,
    bsl.payment_kind,
    bsl.reconciliation_status,
    bsl.matching_status,
    bsl.matched_entry_id,
    bsl.matched_expense_id,
    bsl.matched_receipt_id,
    bsl.matched_payment_id,
    bsl.matched_fund_transfer_id,
    bsl.matched_petty_cash_id,
    bsl.matched_tax_payment_id,
    ba.coa_id AS bank_coa_id,
    ba.currency AS account_currency
  FROM bank_statement_lines bsl
  JOIN bank_accounts ba ON ba.id = bsl.bank_account_id
  WHERE bsl.bank_account_id = 'bfe79829-07d1-48ed-8965-ff9d367d758e'
    AND bsl.transaction_date <= '2026-09-10'
),
bsl_alloc_agg AS (
  SELECT 
    bsa.bank_statement_line_id AS bsl_id,
    COUNT(*) AS alloc_count,
    SUM(bsa.allocation_amount) AS total_allocated,
    COUNT(DISTINCT bsa.journal_entry_id) AS distinct_jes,
    jsonb_agg(jsonb_build_object(
      'alloc_id', bsa.id,
      'amount', bsa.allocation_amount,
      'doc_type', bsa.document_type,
      'doc_id', bsa.document_id,
      'journal_entry_id', bsa.journal_entry_id,
      'payment_kind', bsa.payment_kind
    )) AS allocations
  FROM bank_statement_allocations bsa
  GROUP BY bsa.bank_statement_line_id
)
SELECT 
  bb.*,
  COALESCE(baa.alloc_count, 0) AS alloc_count,
  COALESCE(baa.total_allocated, 0) AS total_allocated,
  baa.distinct_jes,
  baa.allocations
FROM bsl_basis bb
LEFT JOIN bsl_alloc_agg baa ON baa.bsl_id = bb.bsl_id
ORDER BY bb.transaction_date, bb.bsl_id;
`;

fs.writeFileSync("/Users/Kunal/.gemini/antigravity-ide/brain/73556c95-1acf-43fd-9f69-2089a61e6410/scratch/bsl_integrity.sql", sql);
const res = execSync(`npx supabase db query --linked -o json --file /Users/Kunal/.gemini/antigravity-ide/brain/73556c95-1acf-43fd-9f69-2089a61e6410/scratch/bsl_integrity.sql`, {
  encoding: "utf8",
  maxBuffer: 30 * 1024 * 1024
});

fs.writeFileSync("/Users/Kunal/.gemini/antigravity-ide/brain/73556c95-1acf-43fd-9f69-2089a61e6410/scratch/bsl_integrity_results.json", res);
console.log("BSL Integrity base data written to scratch/bsl_integrity_results.json");
