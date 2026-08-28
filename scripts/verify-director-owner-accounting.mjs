import { execFileSync } from 'node:child_process';

// Read-only report of the existing Director Loan COA ledgers. Director/Owner
// identity is represented by the COA itself; no separate master is assumed.
const sql = `
WITH director_ledgers AS (
  SELECT c.id, c.code, c.name
  FROM public.chart_of_accounts c
  WHERE c.is_active=true AND COALESCE(c.is_header,false)=false
    AND lower(c.account_type)='liability' AND c.name ~* '^director[[:space:]]+loan'
)
SELECT jsonb_build_object('director_loan_coas', COALESCE((
  SELECT jsonb_agg(jsonb_build_object(
    'coa', d.code || ' — ' || d.name,
    'loan_received', COALESCE((SELECT sum(jl.credit) FROM public.journal_entry_lines jl JOIN public.journal_entries je ON je.id=jl.journal_entry_id WHERE jl.account_id=d.id AND je.is_posted=true),0),
    'withdrawals_or_repayments', COALESCE((SELECT sum(jl.debit) FROM public.journal_entry_lines jl JOIN public.journal_entries je ON je.id=jl.journal_entry_id WHERE jl.account_id=d.id AND je.is_posted=true),0),
    'current_credit_balance', COALESCE((SELECT sum(jl.credit-jl.debit) FROM public.journal_entry_lines jl JOIN public.journal_entries je ON je.id=jl.journal_entry_id WHERE jl.account_id=d.id AND je.is_posted=true),0),
    'journal_lines', (SELECT count(*) FROM public.journal_entry_lines jl JOIN public.journal_entries je ON je.id=jl.journal_entry_id WHERE jl.account_id=d.id AND je.is_posted=true),
    'bank_reconciliation_links', (SELECT count(*) FROM public.bank_statement_lines b JOIN public.journal_entry_lines jl ON jl.journal_entry_id=b.matched_entry_id WHERE jl.account_id=d.id),
    'loan_records', (SELECT count(*) FROM public.loans l WHERE l.coa_id=d.id),
    'repayment_records', (SELECT count(*) FROM public.loan_transactions lt JOIN public.loans l ON l.id=lt.loan_id WHERE l.coa_id=d.id)
  ) ORDER BY d.code) FROM director_ledgers d
), '[]'::jsonb));
`;

try {
  const stdout = execFileSync('supabase', ['db', 'query', '--linked', '--output-format', 'json', sql], {
    cwd: process.cwd(), encoding: 'utf8', stdio: ['ignore', 'pipe', 'inherit'], maxBuffer: 100 * 1024 * 1024,
  });
  const response = JSON.parse(stdout);
  if (response.error) throw new Error(response.error.message ?? JSON.stringify(response.error));
  const report = response.rows?.[0]?.jsonb_build_object ?? response.rows?.[0];
  if (!Array.isArray(report?.director_loan_coas) || report.director_loan_coas.length === 0) {
    throw new Error('No active Director Loan COA is available for verification.');
  }
  console.log(JSON.stringify({ status: 'passed', ...report }, null, 2));
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
}
