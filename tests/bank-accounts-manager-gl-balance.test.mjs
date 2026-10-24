import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

const bankAccountsCode = readFileSync(
  new URL('../src/components/finance/BankAccountsManager.tsx', import.meta.url),
  'utf8',
);

test('1. BankAccountsManager Never Falls Back to opening_balance as GL Balance', () => {
  // Ensure the old bug pattern is absent:
  // : (acct.chart_of_accounts?.code ? Number(acct.opening_balance || 0) : null)
  assert.doesNotMatch(
    bankAccountsCode,
    /acct\.opening_balance.*?:.*?null/,
    'Must not fall back to opening_balance for GL balance',
  );

  // Ensure explicit unavailable status is used
  assert.match(
    bankAccountsCode,
    /'unavailable'/,
    'Must set unavailable status when RPC result is missing',
  );
  assert.match(
    bankAccountsCode,
    /GL balance unavailable/,
    'Must display "GL balance unavailable" label in UI',
  );
});

test('2. BankAccountsManager GL Balance Status Simulation', () => {
  // Simulation of the exact mapping logic implemented in BankAccountsManager:
  function mapAccount(acct, balanceMap) {
    const hasCoa = Boolean(acct.chart_of_accounts?.code);
    const hasBalance = balanceMap[acct.id] !== undefined;
    return {
      ...acct,
      coa_code: acct.chart_of_accounts?.code,
      ledger_balance: hasCoa && hasBalance ? balanceMap[acct.id] : null,
      ledger_balance_status: !hasCoa
        ? 'no_coa'
        : hasBalance
        ? 'ok'
        : 'unavailable',
    };
  }

  function renderBalance(item) {
    if (!item.coa_code || item.ledger_balance_status === 'no_coa') {
      return 'No COA linked';
    }
    if (item.ledger_balance_status === 'unavailable' || item.ledger_balance === null || item.ledger_balance === undefined) {
      return 'GL balance unavailable';
    }
    return `Rp ${item.ledger_balance.toLocaleString('id-ID')}`;
  }

  const accountWithCoa = {
    id: 'bfe79829-07d1-48ed-8965-ff9d367d758e',
    account_name: 'BCA IDR',
    opening_balance: 10000000,
    chart_of_accounts: { code: '111101', id: 'coa-1' },
  };

  const accountWithoutCoa = {
    id: 'acct-no-coa',
    account_name: 'Cash Box',
    opening_balance: 500000,
    chart_of_accounts: null,
  };

  // Case A: RPC succeeded and returned balance
  const resultA = mapAccount(accountWithCoa, { 'bfe79829-07d1-48ed-8965-ff9d367d758e': 37731632.44 });
  assert.equal(resultA.ledger_balance_status, 'ok');
  assert.equal(resultA.ledger_balance, 37731632.44);
  assert.equal(renderBalance(resultA), 'Rp 37.731.632,44');

  // Case B: RPC failed or missing result for account
  const resultB = mapAccount(accountWithCoa, {});
  assert.equal(resultB.ledger_balance_status, 'unavailable');
  assert.equal(resultB.ledger_balance, null);
  // NEVER show opening balance 10,000,000!
  assert.notEqual(resultB.ledger_balance, 10000000);
  assert.equal(renderBalance(resultB), 'GL balance unavailable');

  // Case C: Account without COA linked
  const resultC = mapAccount(accountWithoutCoa, {});
  assert.equal(resultC.ledger_balance_status, 'no_coa');
  assert.equal(resultC.ledger_balance, null);
  assert.equal(renderBalance(resultC), 'No COA linked');
});
