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

async function main() {
  console.log('=== Post-Nov 2025 Inflows ===');
  const inflows = runSql(`
    SELECT ft.transfer_number, ft.transfer_date, ft.amount, ft.from_account_type, ft.to_account_type, ft.description
    FROM fund_transfers ft
    WHERE ft.to_account_type = 'petty_cash' AND ft.status = 'posted' AND ft.transfer_date >= '2025-11-01'
    ORDER BY ft.transfer_date;
  `);
  console.log('Inflows count:', inflows.length);
  let totalInflows = 0;
  for (const f of inflows) {
    totalInflows += Number(f.amount);
    console.log(`  ${f.transfer_date} | ${f.transfer_number} | Rp ${Number(f.amount).toLocaleString('id-ID')} | from: ${f.from_account_type} | ${f.description || ''}`);
  }
  console.log('Total Post-Nov Inflows:', totalInflows.toLocaleString('id-ID'));

  console.log('\n=== Post-Nov 2025 Outflows ===');
  const outflows = runSql(`
    SELECT 
      count(*) as count,
      sum(amount) as total_amount
    FROM petty_cash_transactions
    WHERE transaction_date >= '2025-11-01' AND transaction_type = 'expense' AND approval_status = 'approved';
  `);
  console.log('Post-Nov Expenses:', outflows);

  console.log('\n=== Post-Nov 2025 Transfer Outflows ===');
  const transferOutflows = runSql(`
    SELECT ft.transfer_number, ft.transfer_date, ft.amount, ft.from_account_type, ft.to_account_type, ft.description
    FROM fund_transfers ft
    WHERE ft.from_account_type = 'petty_cash' AND ft.status = 'posted' AND ft.transfer_date >= '2025-11-01'
    ORDER BY ft.transfer_date;
  `);
  console.log('Transfer Outflows:', transferOutflows);

  // Exclude the 71.987M transfer from cash on hand:
  const genuineInflows = totalInflows - 71987000;
  const genuineOutflows = Number(outflows[0].total_amount);
  const genuineTransferOutflows = Number(transferOutflows[0]?.amount || 0);
  console.log('\n=== Genuine Post-Nov Petty Cash (without FT2607-0003 71.987M) ===');
  console.log('Genuine Bank Replenishments:', genuineInflows.toLocaleString('id-ID'));
  console.log('Genuine Petty Cash Expenses:', genuineOutflows.toLocaleString('id-ID'));
  console.log('Genuine Transfer Outflows:', genuineTransferOutflows.toLocaleString('id-ID'));
  console.log('Net Genuine Cash Remaining:', (genuineInflows - genuineOutflows - genuineTransferOutflows).toLocaleString('id-ID'));
}

main().catch(console.error);
