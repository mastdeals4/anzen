import { execFileSync } from 'node:child_process';

function runSql(sql) {
  const stdout = execFileSync('supabase', ['db', 'query', '--linked', '--output-format', 'json', sql], {
    cwd: process.cwd(),
    encoding: 'utf8',
    maxBuffer: 50 * 1024 * 1024,
  });
  const res = JSON.parse(stdout);
  if (res.error) throw new Error(res.error.message || JSON.stringify(res.error));
  return res.rows || [];
}

async function main() {
  console.log('====================================================================');
  console.log('VERIFYING FINAL GL 1101 FORENSIC CORRECTION & INVARIANTS');
  console.log('====================================================================');

  // Verify GL 1101 Active Balance
  const gl1101Active = runSql(`
    SELECT 
      c.code, c.name,
      COUNT(jl.id) as line_count,
      COALESCE(SUM(jl.debit), 0) as total_debit,
      COALESCE(SUM(jl.credit), 0) as total_credit,
      COALESCE(SUM(jl.debit - jl.credit), 0) as net_balance
    FROM chart_of_accounts c
    JOIN journal_entry_lines jl ON jl.account_id = c.id
    JOIN journal_entries je ON je.id = jl.journal_entry_id AND je.is_posted = true AND COALESCE(je.is_reversed, false) = false
    WHERE c.code = '1101'
    GROUP BY c.code, c.name;
  `)[0];

  const gl1101Net = Number(gl1101Active?.net_balance || 0);
  const gl1101Count = Number(gl1101Active?.line_count || 0);

  console.log(`\n1. GL 1101 Cash on Hand (Active Ledger):`);
  console.log(`   Net Balance: Rp ${gl1101Net.toLocaleString('id-ID')}`);
  console.log(`   Active lines count: ${gl1101Count}`);
  if (gl1101Net !== 0 || gl1101Count !== 0) {
    throw new Error(`CRITICAL: GL 1101 has non-zero balance: ${gl1101Net}`);
  }
  console.log('   ✅ GL 1101 is EXACTLY Rp 0.00 with 0 active lines!');

  // Verify GL 1102
  const gl1102Data = runSql(`
    SELECT 
      c.code, c.name,
      COUNT(jl.id) as line_count,
      COALESCE(SUM(jl.debit), 0) as total_debit,
      COALESCE(SUM(jl.credit), 0) as total_credit,
      COALESCE(SUM(jl.debit - jl.credit), 0) as net_balance
    FROM chart_of_accounts c
    JOIN journal_entry_lines jl ON jl.account_id = c.id
    JOIN journal_entries je ON je.id = jl.journal_entry_id AND je.is_posted = true AND COALESCE(je.is_reversed, false) = false
    WHERE c.code = '1102'
    GROUP BY c.code, c.name;
  `)[0];

  console.log(`\n2. GL 1102 Petty Cash:`);
  console.log(`   Net Balance: Rp ${Number(gl1102Data.net_balance).toLocaleString('id-ID')}`);
  if (Number(gl1102Data.net_balance) !== 4594326) {
    throw new Error(`CRITICAL: GL 1102 drifted: ${gl1102Data.net_balance}`);
  }
  console.log('   ✅ GL 1102 is EXACTLY Rp 4,594,326.00!');

  // Verify Invariants (canonical query from verify_petty_cash_final.mjs)
  const invariants = runSql(`
    SELECT 
      coa.code, coa.name,
      COALESCE(SUM(jl.debit - jl.credit), 0) as net_balance
    FROM chart_of_accounts coa
    LEFT JOIN journal_entry_lines jl ON jl.account_id = coa.id
    LEFT JOIN journal_entries je ON je.id = jl.journal_entry_id AND je.is_posted = true AND NOT COALESCE(je.is_reversed, false)
    WHERE coa.code IN ('111101', '111102', '1130', '5100', '2105', '6420', '6900', '2130', '2131', '2132', '2138')
    GROUP BY coa.code, coa.name
    ORDER BY coa.code;
  `);
  console.log('\n3. Invariant Account Balances:');
  console.table(invariants);

  const bcaIdr = invariants.find(b => b.code === '111101');
  const bcaUsd = invariants.find(b => b.code === '111102');
  const inv1130 = invariants.find(b => b.code === '1130');
  const cogs5100 = invariants.find(b => b.code === '5100');
  const dirLoan2105 = invariants.find(b => b.code === '2105');

  console.log(`   Bank BCA IDR: Rp ${Number(bcaIdr.net_balance).toLocaleString('id-ID')} === 355.578.334,44? ${Number(bcaIdr.net_balance) === 355578334.44}`);
  console.log(`   Bank BCA USD: Rp ${Number(bcaUsd.net_balance).toLocaleString('id-ID')} === 756.507.280,00? ${Number(bcaUsd.net_balance) === 756507280.00}`);
  console.log(`   GL 1130 Inventory: Rp ${Number(inv1130.net_balance).toLocaleString('id-ID')} === 2.178.329.160,75? ${Number(inv1130.net_balance) === 2178329160.75}`);
  console.log(`   GL 5100 COGS: Rp ${Number(cogs5100.net_balance).toLocaleString('id-ID')} === 5.751.942.819,75? ${Number(cogs5100.net_balance) === 5751942819.75}`);
  console.log(`   GL 2105 Director Loan: Rp ${Number(Math.abs(dirLoan2105.net_balance)).toLocaleString('id-ID')} (Credit balance)`);

  if (Number(bcaIdr.net_balance) !== 355578334.44) throw new Error('Bank BCA IDR invariant failed');
  if (Number(bcaUsd.net_balance) !== 756507280.00) throw new Error('Bank BCA USD invariant failed');
  if (Number(inv1130.net_balance) !== 2178329160.75) throw new Error('Inventory 1130 invariant failed');
  if (Number(cogs5100.net_balance) !== 5751942819.75) throw new Error('COGS 5100 invariant failed');

  // Verify Petty Cash Views
  const vwBalance = runSql(`SELECT * FROM vw_petty_cash_balance;`)[0];
  const stmtNet = runSql(`
    SELECT 
      COALESCE(SUM(inflow), 0) as total_inflows,
      COALESCE(SUM(outflow), 0) as total_outflows,
      COALESCE(SUM(inflow - outflow), 0) as net_balance
    FROM vw_petty_cash_statement;
  `)[0];

  console.log('\n4. Petty Cash Views:');
  console.log(`   vw_petty_cash_balance: Rp ${Number(vwBalance.current_balance).toLocaleString('id-ID')}`);
  console.log(`   vw_petty_cash_statement: Rp ${Number(stmtNet.net_balance).toLocaleString('id-ID')}`);
  if (Number(vwBalance.current_balance) !== 4594326 || Number(stmtNet.net_balance) !== 4594326) {
    throw new Error('Petty cash view verification failed');
  }

  // Verify Sales Invoice Rounding for SAPJ-26-020
  const si = runSql(`
    SELECT si.invoice_number, si.total_amount, si.paid_amount, si.payment_status,
           ira.adjustment_amount, ira.reason
    FROM sales_invoices si
    LEFT JOIN invoice_rounding_adjustments ira ON ira.sales_invoice_id = si.id
    WHERE si.invoice_number = 'SAPJ-26-020';
  `);
  console.log('\n5. Sales Invoice SAPJ-26-020 Rounding:');
  console.table(si);

  // Verify Expense States
  const exps = runSql(`
    SELECT fe.voucher_number, fe.amount, fe.paid_amount
    FROM finance_expenses fe
    WHERE fe.voucher_number IN ('EXP/26-26/139', 'EXP/26/177');
  `);
  console.log('\n6. Payment Voucher Reversal Expenses:');
  console.table(exps);

  console.log('\n====================================================================');
  console.log('ALL VERIFICATIONS SUCCESSFUL! GL 1101 IS COMPLETELY RECONCILED.');
  console.log('====================================================================');
}

main().catch(err => {
  console.error('Verification failed:', err);
  process.exit(1);
});
