import assert from 'node:assert/strict'; import fs from 'node:fs'; import test from 'node:test';
const ui=fs.readFileSync(new URL('../src/components/finance/PurchaseInvoiceManager.tsx',import.meta.url),'utf8');
const sql=fs.readFileSync(new URL('../supabase/migrations/20260901150000_fix_current_finance_regressions.sql',import.meta.url),'utf8');
test('PI edit payload preserves existing line IDs',()=>assert.match(ui,/\.\.\.\(item\.id \? \{ id: item\.id \} : \{\}\)/));
test('salary advance routes to staff advances account',()=>assert.match(sql,/v_pv\.payment_purpose = 'salary_advance'/));
test('UI PI save wrapper converts USD journal amounts and metadata',()=>{assert.match(sql,/debit=round\(l\.debit\*v_rate,2\)/);assert.match(sql,/transaction_currency='USD'/);});
