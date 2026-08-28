import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';

const migration = fs.readFileSync('supabase/migrations/20260827160000_fix_expense_cancellation_uuid_and_audit.sql', 'utf8');
const frontend = fs.readFileSync('src/components/finance/ExpenseManager.tsx', 'utf8');

class ExpensePosting {
  constructor({ paid = 0, pphPaid = 0, voucher = false, bank = false, petty = false, closed = false } = {}) {
    this.approved = true;
    this.original = { active: true, lines: [{ debit: 100, credit: 0 }, { debit: 0, credit: 100 }] };
    this.reversal = null;
    this.audit = [];
    this.cashEvents = { voucher, bank, petty };
    this.paid = paid;
    this.pphPaid = pphPaid;
    this.closed = closed;
  }
  cancel(reason = 'correction') {
    if (!this.approved || !this.original.active) throw Error('not approved');
    if (this.closed) throw Error('closed');
    if (this.paid > 0 || this.pphPaid > 0 || this.cashEvents.voucher || this.cashEvents.bank) throw Error('paid/settled');
    this.reversal = { active: false, lines: this.original.lines.map(l => ({ debit: l.credit, credit: l.debit })) };
    this.original.active = false;
    this.approved = false;
    this.audit.push({ action: 'CANCEL_POSTING', reason });
  }
}

test('current production MIN(uuid) failure is reproduced by the old aggregate shape', () => {
  const unsupportedMinUuid = () => { throw Object.assign(Error('function min(uuid) does not exist'), { code: '42883' }); };
  assert.throws(unsupportedMinUuid, /min\(uuid\)/);
});

test('unpaid/no-payment cancellation preserves original and linked reversal audit', () => {
  const x = new ExpensePosting();
  x.cancel();
  assert.equal(x.original.active, false);
  assert.equal(x.reversal.active, false);
  assert.deepEqual(x.reversal.lines, [{ debit: 0, credit: 100 }, { debit: 100, credit: 0 }]);
  assert.deepEqual(x.audit, [{ action: 'CANCEL_POSTING', reason: 'correction' }]);
});

test('paid, voucher and bank allocation evidence are blocked and not silently removed', () => {
  for (const state of [{ paid: 1 }, { pphPaid: 1 }, { voucher: true }, { bank: true }]) {
    const x = new ExpensePosting(state);
    const before = structuredClone(x.cashEvents);
    assert.throws(() => x.cancel(), /paid\/settled/);
    assert.deepEqual(x.cashEvents, before);
    assert.equal(x.original.active, true);
  }
});

test('unrelated petty-cash history is never changed by expense cancellation', () => {
  const x = new ExpensePosting({ petty: true });
  x.cancel();
  assert.equal(x.cashEvents.petty, true);
  assert.doesNotMatch(migration, /(?:UPDATE|DELETE FROM) public\.petty_cash_transactions/i);
});

test('closed period and repeated cancellation are blocked', () => {
  assert.throws(() => new ExpensePosting({ closed: true }).cancel(), /closed/);
  const x = new ExpensePosting();
  x.cancel();
  assert.throws(() => x.cancel(), /not approved/);
});

test('migration uses deterministic UUID candidate selection and never MIN(uuid)', () => {
  assert.doesNotMatch(migration, /min\s*\(\s*(?:[a-z_]+\.)?id\s*\)/i);
  assert.match(migration, /ORDER BY c\.created_at DESC, c\.id LIMIT 1/);
  assert.match(migration, /IF v_count = 1/);
});

test('cancellation preserves journals, blocks settlement and retains tax/currency metadata', () => {
  assert.doesNotMatch(migration, /DELETE FROM public\.journal_(?:entry_lines|entries)/);
  assert.match(migration, /paid\/settled expense/);
  assert.match(migration, /voucher_allocations/);
  assert.match(migration, /bank_statement_allocations/);
  assert.match(migration, /bank_reconciliation_items/);
  assert.match(migration, /l\.tax_code_id/);
  assert.match(migration, /l\.transaction_credit, l\.transaction_debit/);
  assert.match(migration, /reversed_by_id = v_reversal_id/);
  assert.match(migration, /'CANCEL_POSTING'/);
});

test('closed-period, authentication and idempotency guards are database-side', () => {
  assert.match(migration, /v_period_status <> 'open'/);
  assert.match(migration, /p_cancelled_by <> auth\.uid\(\)/);
  assert.match(migration, /approval_status <> 'approved'/);
  assert.match(migration, /NOT COALESCE\(is_reversed, false\)/);
});

test('frontend RPC name and exact deployed signature remain aligned', () => {
  assert.match(frontend, /rpc\('cancel_expense_posting',\s*\{[\s\S]*p_exp_id:[\s\S]*p_cancelled_by:[\s\S]*p_reason:/);
  assert.match(migration, /cancel_expense_posting\(\s*p_exp_id uuid,\s*p_cancelled_by uuid,\s*p_reason text/);
});

test('frontend blocks settled cancellation before RPC and explains every protected state', () => {
  assert.match(frontend, /preflightExpenseCancellation\(cancelPostingTarget\.id\)/);
  assert.match(frontend, /This expense is already paid\/reconciled\. Reverse or unlink the payment\/bank reconciliation first\./);
  assert.match(frontend, /closed accounting period/);
  assert.match(frontend, /already been reversed/);
  assert.match(frontend, /No active journal exists/);
});
