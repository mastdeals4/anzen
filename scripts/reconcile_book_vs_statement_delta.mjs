import { execSync } from "child_process";
import fs from "fs";

console.log("Analyzing exact components of the Rp 27,124,735.00 variance...");

// 1. Get all bank statement lines through 10 Sep 2026
const bslSql = `
SELECT 
  id,
  transaction_date,
  description,
  debit_amount,
  credit_amount,
  credit_amount - debit_amount AS net_movement,
  reconciliation_status,
  matching_status,
  matched_entry_id
FROM bank_statement_lines
WHERE bank_account_id = 'bfe79829-07d1-48ed-8965-ff9d367d758e'
  AND transaction_date <= '2026-09-10'
ORDER BY transaction_date, id;
`;

// 2. Get all posted GL lines on account 111101 through 10 Sep 2026
const glSql = `
SELECT 
  je.id AS je_id,
  je.entry_number,
  je.entry_date,
  je.source_module,
  je.description,
  jel.id AS jel_id,
  jel.debit,
  jel.credit,
  jel.debit - jel.credit AS net_movement
FROM journal_entries je
JOIN journal_entry_lines jel ON jel.journal_entry_id = je.id
WHERE jel.account_id = 'eda4928b-2120-4c1c-a4e1-46c9eb7a610d'
  AND je.is_posted = true
  AND je.entry_date <= '2026-09-10'
ORDER BY je.entry_date, je.entry_number;
`;

fs.writeFileSync("/Users/Kunal/.gemini/antigravity-ide/brain/73556c95-1acf-43fd-9f69-2089a61e6410/scratch/recon_bsl.sql", bslSql);
fs.writeFileSync("/Users/Kunal/.gemini/antigravity-ide/brain/73556c95-1acf-43fd-9f69-2089a61e6410/scratch/recon_gl.sql", glSql);

const bslRes = JSON.parse(execSync(`npx supabase db query --linked -o json --file /Users/Kunal/.gemini/antigravity-ide/brain/73556c95-1acf-43fd-9f69-2089a61e6410/scratch/recon_bsl.sql`, { encoding: "utf8" })).rows || [];
const glRes = JSON.parse(execSync(`npx supabase db query --linked -o json --file /Users/Kunal/.gemini/antigravity-ide/brain/73556c95-1acf-43fd-9f69-2089a61e6410/scratch/recon_gl.sql`, { encoding: "utf8" })).rows || [];

console.log(`Total BSL lines: ${bslRes.length}, Total GL lines: ${glRes.length}`);

// Sum totals
const bslTotalNet = bslRes.reduce((s, r) => s + parseFloat(r.net_movement), 0);
const glTotalNet = glRes.reduce((s, r) => s + parseFloat(r.net_movement), 0);

console.log(`BSL Net Movement: ${bslTotalNet}`);
console.log(`GL Net Movement: ${glTotalNet}`);
console.log(`Difference (GL - BSL): ${glTotalNet - bslTotalNet}`);

// Fetch all bank statement allocations through 10 Sep
const bsaSql = `
SELECT 
  bsa.id,
  bsa.bank_statement_line_id,
  bsa.allocation_amount,
  bsa.document_type,
  bsa.document_id,
  bsa.journal_entry_id
FROM bank_statement_allocations bsa
JOIN bank_statement_lines bsl ON bsl.id = bsa.bank_statement_line_id
WHERE bsl.bank_account_id = 'bfe79829-07d1-48ed-8965-ff9d367d758e'
  AND bsl.transaction_date <= '2026-09-10';
`;

fs.writeFileSync("/Users/Kunal/.gemini/antigravity-ide/brain/73556c95-1acf-43fd-9f69-2089a61e6410/scratch/recon_bsa.sql", bsaSql);
const bsaRes = JSON.parse(execSync(`npx supabase db query --linked -o json --file /Users/Kunal/.gemini/antigravity-ide/brain/73556c95-1acf-43fd-9f69-2089a61e6410/scratch/recon_bsa.sql`, { encoding: "utf8" })).rows || [];

console.log(`Total BSA allocations: ${bsaRes.length}`);

// Map GL lines linked
const matchedJeIds = new Set();
for (const a of bsaRes) {
  if (a.journal_entry_id) matchedJeIds.add(a.journal_entry_id);
}
for (const b of bslRes) {
  if (b.matched_entry_id) matchedJeIds.add(b.matched_entry_id);
}

// Identify unallocated GL lines
const unallocatedGl = glRes.filter(g => !matchedJeIds.has(g.je_id));
console.log(`Unallocated GL lines count: ${unallocatedGl.length}`);
let unallocatedGlNet = 0;
for (const g of unallocatedGl) {
  unallocatedGlNet += parseFloat(g.net_movement);
}
console.log(`Unallocated GL Net Movement: ${unallocatedGlNet}`);

// Group unallocated GL lines
const byModule = {};
for (const g of unallocatedGl) {
  byModule[g.source_module] = (byModule[g.source_module] || 0) + parseFloat(g.net_movement);
}
console.log("Unallocated GL by Source Module:", byModule);

fs.writeFileSync("/Users/Kunal/.gemini/antigravity-ide/brain/73556c95-1acf-43fd-9f69-2089a61e6410/scratch/unallocated_gl.json", JSON.stringify(unallocatedGl, null, 2));
