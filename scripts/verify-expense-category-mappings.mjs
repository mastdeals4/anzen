import { execFileSync } from 'node:child_process';

// Verify the live canonical master rather than keeping a second category list
// in test code. The posting resolver must agree with every active leaf.
const sql = `
SELECT c.category_key, c.name, c.parent_id, c.coa_account_id,
       coa.code, coa.name AS coa_name, coa.account_type, coa.is_header, coa.is_active,
       public.get_expense_account_id(c.category_key) AS resolved_coa_account_id
  FROM public.expense_categories c
  LEFT JOIN public.chart_of_accounts coa ON coa.id = c.coa_account_id
 WHERE c.is_active AND c.is_posting_category
 ORDER BY c.sort_order, c.name;
`;

const stdout = execFileSync(
  'supabase',
  ['db', 'query', '--linked', '--output-format', 'json', sql],
  { cwd: process.cwd(), encoding: 'utf8', stdio: ['ignore', 'pipe', 'inherit'], maxBuffer: 20 * 1024 * 1024 },
);
const response = JSON.parse(stdout.slice(stdout.indexOf('{')));
if (response.error) throw new Error(response.error.message ?? JSON.stringify(response.error));

const errors = response.rows.filter((row) =>
  !row.parent_id
  || !row.coa_account_id
  || row.resolved_coa_account_id !== row.coa_account_id
  || !row.is_active
  || row.is_header
  || !['expense', 'asset'].includes(row.account_type),
);
if (errors.length) throw new Error(`Canonical expense-category mapping errors: ${JSON.stringify(errors)}`);

console.log(JSON.stringify({
  status: 'passed',
  activePostingCategories: response.rows.length,
  source: 'expense_categories → chart_of_accounts → get_expense_account_id',
}, null, 2));
