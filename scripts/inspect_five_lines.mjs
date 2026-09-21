import { execSync } from "child_process";
import fs from "fs";

const data = JSON.parse(fs.readFileSync("/Users/Kunal/.gemini/antigravity-ide/brain/73556c95-1acf-43fd-9f69-2089a61e6410/scratch/audit_data.json", "utf8"));

const allJeIds = [];
for (const line of data.fiveLines) {
  for (const alloc of line.allocations) {
    if (alloc.journal_entry_id) allJeIds.push(alloc.journal_entry_id);
  }
}

const query = `
SELECT 
  je.id,
  je.entry_number,
  je.entry_date,
  je.source_module,
  je.description,
  je.is_posted,
  je.is_reversed,
  jel.line_number,
  coa.code AS coa_code,
  coa.name AS coa_name,
  jel.debit,
  jel.credit
FROM journal_entries je
JOIN journal_entry_lines jel ON jel.journal_entry_id = je.id
JOIN chart_of_accounts coa ON coa.id = jel.account_id
WHERE je.id IN (${allJeIds.map(id => `'${id}'`).join(",")})
ORDER BY je.entry_number, jel.line_number;
`;

fs.writeFileSync("/Users/Kunal/.gemini/antigravity-ide/brain/73556c95-1acf-43fd-9f69-2089a61e6410/scratch/inspect_five.sql", query);
const res = execSync(`npx supabase db query --linked -o json --file /Users/Kunal/.gemini/antigravity-ide/brain/73556c95-1acf-43fd-9f69-2089a61e6410/scratch/inspect_five.sql`, { encoding: "utf8" });
fs.writeFileSync("/Users/Kunal/.gemini/antigravity-ide/brain/73556c95-1acf-43fd-9f69-2089a61e6410/scratch/five_journals.json", res);
console.log("Five lines journals written to scratch/five_journals.json");
