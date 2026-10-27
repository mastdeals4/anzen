import { execFileSync } from 'node:child_process';

const runSql = (sql) => {
  const stdout = execFileSync('supabase', ['db', 'query', '--linked', '--output-format', 'json', sql], {
    cwd: process.cwd(),
    encoding: 'utf8',
    maxBuffer: 50 * 1024 * 1024,
  });
  const res = JSON.parse(stdout);
  if (res.error) throw new Error(res.error.message || JSON.stringify(res.error));
  return res.rows || [];
};

async function verify() {
  console.log('=================================================================');
  console.log('FINAL VERIFICATION REPORT: HISTORICAL PETTY CASH & GL 1101 AUDIT');
  console.log('=================================================================');

  // 1. GL 1101 Balance (Must be exactly Rp 0.00 with 0 active lines)
  const gl1101 = runSql(`
    SELECT 
      c.code, c.name,
      COUNT(jl.id) as line_count,
      COALESCE(SUM(jl.debit), 0) as total_debit,
      COALESCE(SUM(jl.credit), 0) as total_credit,
      COALESCE(SUM(jl.debit - jl.credit), 0) as net_balance
    FROM chart_of_accounts c
    LEFT JOIN journal_entry_lines jl ON jl.account_id = c.id
    INNER JOIN journal_entries je ON je.id = jl.journal_entry_id
    WHERE c.code = '1101' AND je.is_posted = true AND NOT COALESCE(je.is_reversed, false)
    GROUP BY c.code, c.name;
  `)[0] || { code: '1101', name: 'Cash on Hand', line_count: 0, total_debit: 0, total_credit: 0, net_balance: 0 };
  console.log('1. GL 1101 Ledger (Active):', gl1101);

  // Check remaining active journal lines on 1101
  const active1101Lines = runSql(`
    SELECT 
      je.entry_number,
      je.entry_date,
      jl.description,
      jl.debit,
      jl.credit,
      je.source_module,
      je.reference_id
    FROM journal_entry_lines jl
    INNER JOIN journal_entries je ON je.id = jl.journal_entry_id
    INNER JOIN chart_of_accounts c ON c.id = jl.account_id
    WHERE c.code = '1101'
      AND je.is_posted = true
      AND NOT COALESCE(je.is_reversed, false);
  `);
  console.log(`   Remaining active lines on GL 1101: ${active1101Lines.length}`);

  // 2. GL 1102 Balance
  const gl1102 = runSql(`
    SELECT 
      c.code, c.name,
      COUNT(jl.id) as line_count,
      COALESCE(SUM(jl.debit), 0) as total_debit,
      COALESCE(SUM(jl.credit), 0) as total_credit,
      COALESCE(SUM(jl.debit - jl.credit), 0) as net_balance
    FROM chart_of_accounts c
    INNER JOIN journal_entry_lines jl ON jl.account_id = c.id
    INNER JOIN journal_entries je ON je.id = jl.journal_entry_id
    WHERE c.code = '1102' AND je.is_posted = true AND NOT COALESCE(je.is_reversed, false)
    GROUP BY c.code, c.name;
  `)[0];
  console.log('2. GL 1102 Ledger:', gl1102);

  // 3. vw_petty_cash_balance
  const vwBalance = runSql(`SELECT * FROM vw_petty_cash_balance;`)[0];
  console.log('3. vw_petty_cash_balance:', vwBalance);

  // 4. vw_petty_cash_statement Net
  const stmtNet = runSql(`
    SELECT 
      COALESCE(SUM(inflow), 0) as total_inflows,
      COALESCE(SUM(outflow), 0) as total_outflows,
      COALESCE(SUM(inflow - outflow), 0) as net_balance
    FROM vw_petty_cash_statement;
  `)[0];
  console.log('4. vw_petty_cash_statement:', stmtNet);

  // Check mathematical equality:
  const glNet = Number(gl1102.net_balance);
  const vwNet = Number(vwBalance.current_balance);
  const stNet = Number(stmtNet.net_balance);
  console.log(`\nCheck 1: GL 1102 (${glNet}) === vw_petty_cash_balance (${vwNet})? ${glNet === vwNet}`);
  console.log(`Check 2: GL 1102 (${glNet}) === vw_petty_cash_statement (${stNet})? ${glNet === stNet}`);

  // 5. Missing petty cash links
  const missing = runSql(`SELECT count(*) as count FROM missing_petty_cash_links;`)[0];
  console.log(`Check 3: missing_petty_cash_links count: ${missing.count}`);

  // 6. Invariant Accounts Check: Bank, Inventory, COGS, Tax
  const invariants = runSql(`
    SELECT 
      coa.code, coa.name,
      COALESCE(SUM(jl.debit - jl.credit), 0) as net_balance
    FROM chart_of_accounts coa
    INNER JOIN journal_entry_lines jl ON jl.account_id = coa.id
    INNER JOIN journal_entries je ON je.id = jl.journal_entry_id
    WHERE coa.code IN ('111101', '111102', '1130', '5100', '2130', '2131', '2132', '2138')
      AND je.is_posted = true
      AND NOT COALESCE(je.is_reversed, false)
    GROUP BY coa.code, coa.name
    ORDER BY coa.code;
  `);
  console.log('\nInvariant Accounts Balances:');
  for (const inv of invariants) {
    console.log(`  ${inv.code} ${inv.name}: Rp ${Number(inv.net_balance).toLocaleString('id-ID')}`);
  }

  // 7. Reclassified Target Balances: 2105 (Director Loan) & 2120 (Accrued Expenses)
  const reclassifiedAccounts = runSql(`
    SELECT 
      coa.code, coa.name,
      COALESCE(SUM(jl.credit - jl.debit), 0) as net_credit_balance
    FROM chart_of_accounts coa
    INNER JOIN journal_entry_lines jl ON jl.account_id = coa.id
    INNER JOIN journal_entries je ON je.id = jl.journal_entry_id
    WHERE coa.code IN ('2105', '2120')
      AND je.is_posted = true
      AND NOT COALESCE(je.is_reversed, false)
    GROUP BY coa.code, coa.name
    ORDER BY coa.code;
  `);
  console.log('\nTarget Reclassified Liabilities (Credit Balances):');
  for (const r of reclassifiedAccounts) {
    console.log(`  ${r.code} ${r.name}: Rp ${Number(r.net_credit_balance).toLocaleString('id-ID')}`);
  }
}

verify().catch(console.error);

