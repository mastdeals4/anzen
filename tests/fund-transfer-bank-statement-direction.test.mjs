import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

const source = readFileSync(
  new URL('../src/components/finance/FundTransferManager.tsx', import.meta.url),
  'utf8',
);

test('Contra source bank statement candidates are outgoing DB/debit transactions only', () => {
  assert.match(
    source,
    /query = type === 'from'[\s\S]{0,90}query\.gt\('debit_amount', 0\.01\)/,
    'From Bank Stmt must only query positive debit lines',
  );
});

test('Contra destination bank statement candidates are incoming CR/credit transactions only', () => {
  assert.match(
    source,
    /query = type === 'from'[\s\S]{0,150}query\.gt\('credit_amount', 0\.01\)/,
    'To Bank Stmt must only query positive credit lines',
  );
});

test('Contra statement candidates exclude every legacy match owner and canonical allocations', () => {
  for (const column of [
    'matched_fund_transfer_id',
    'matched_expense_id',
    'matched_receipt_id',
    'matched_petty_cash_id',
    'matched_entry_id',
    'matched_payment_id',
    'matched_tax_payment_id',
  ]) {
    assert.match(source, new RegExp(String.raw`\.is\('${column}', null\)`), `${column} must be null`);
  }

  assert.match(source, /from\('bank_statement_allocations'\)[\s\S]{0,220}\.in\('bank_statement_line_id', candidateIds\)/);
  assert.match(source, /from\('fund_transfers'\)[\s\S]{0,220}\.in\('from_bank_statement_line_id', candidateIds\)/);
  assert.match(source, /from\('fund_transfers'\)[\s\S]{0,220}\.in\('to_bank_statement_line_id', candidateIds\)/);
  assert.match(source, /statements = statements\.filter\(line => !alreadyUsed\.has\(line\.id\)\)/);
});

test('Contra dropdown labels make DB/CR direction explicit and prevent selecting one line on both sides', () => {
  assert.match(source, /stmt\.isCurrentLink \? 'Current link · DB · ' : 'DB · '/);
  assert.match(source, /stmt\.isCurrentLink \? 'Current link · CR · ' : 'CR · '/);
  assert.match(source, /stmt\.id !== formData\.to_bank_statement_line_id/);
  assert.match(source, /stmt\.id !== formData\.from_bank_statement_line_id/);
});

test('Editing a transfer retains its existing linked line and warns on a wrong-side legacy link', () => {
  assert.match(source, /isCurrentLink: true/);
  assert.match(source, /isWrongDirection: !isCorrectDirection/);
  assert.match(source, /wrong side \(\${actualSide}; expected DB\)/);
  assert.match(source, /wrong side \(\${actualSide}; expected CR\)/);
});

test('If bank-link availability cannot be verified, options fail closed without changing a transfer', () => {
  assert.match(source, /Could not verify which bank transactions are still unlinked\. Please retry; no transfer was changed\./);
  assert.match(source, /if \(type === 'from'\) setFromBankStatements\(\[\]\);\s*else setToBankStatements\(\[\]\)/);
});
