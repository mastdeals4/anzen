import fs from 'fs';

const expenses = JSON.parse(fs.readFileSync('/tmp/container_expenses.json', 'utf8'));

const targetVouchers = ['EXP/26/102', 'EXP/25/288', 'EXP/26/103', 'EXP/25/292', 'EXP/25/246'];

for (const v of targetVouchers) {
  const exp = expenses.find(x => x.voucher_number === v);
  if (exp) {
    console.log(`\n======================================================`);
    console.log(`Voucher: ${exp.voucher_number} | Date: ${exp.expense_date} | Container: ${exp.container_ref}`);
    console.log(`Amount: ${Number(exp.amount).toLocaleString('id-ID')} | Payee: ${exp.paid_by}`);
    console.log(`Description: ${exp.description}`);
    console.log(`Broker Items:`, JSON.stringify(exp.broker_items, null, 2));
  }
}
