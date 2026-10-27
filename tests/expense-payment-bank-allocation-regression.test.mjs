import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';

const migration = fs.readFileSync(
  new URL('../supabase/migrations_archive/20260905140000_fix_resolve_bank_allocation_expense_payment.sql', import.meta.url),
  'utf8',
);

test('migration includes expense_payment in resolve_bank_allocation_document', () => {
  assert.match(
    migration,
    /ELSIF v_module IN \('expense','expenses','expense_payment'\)/,
    'Must include expense_payment in module resolution',
  );
  assert.match(
    migration,
    /document_type := 'expense'; document_id := v_reference; RETURN NEXT; RETURN;/,
    'Must resolve to document_type expense and document_id reference_id',
  );
  assert.match(
    migration,
    /UPDATE public\.bank_statement_allocations/,
    'Must update the historical allocation record',
  );
  assert.match(
    migration,
    /b1fff80f-e427-4d09-b4aa-a91741959097/,
    'Must target the EXP/25/234 allocation',
  );
  assert.match(
    migration,
    /SELECT public\.sync_bank_line_allocation_owner\('26b73b9d-5a89-4119-b2d5-535cd21def27'\);/,
    'Must refresh the bank statement line owner',
  );
  assert.match(
    migration,
    /SELECT public\.recalculate_expense_payment_state\('95d9d4e2-817a-4304-86ad-ab83855fea44'\);/,
    'Must recalculate expense payment state',
  );
});

test('resolution logic maps expense_payment to expense document', () => {
  const resolve = (module, referenceId, expenseExists) => {
    const v_module = (module || '').toLowerCase();
    const v_reference = referenceId;
    if (['payment', 'payments', 'payment_voucher'].includes(v_module)) {
      return { document_type: 'payment', document_id: v_reference };
    }
    if (['receipt', 'receipts', 'receipt_voucher'].includes(v_module)) {
      return { document_type: 'receipt', document_id: v_reference };
    }
    if (['expense', 'expenses', 'expense_payment'].includes(v_module) && v_reference && expenseExists) {
      return { document_type: 'expense', document_id: v_reference };
    }
    return { document_type: 'journal', document_id: 'journal-uuid' };
  };

  const res = resolve('expense_payment', '95d9d4e2-817a-4304-86ad-ab83855fea44', true);
  assert.equal(res.document_type, 'expense');
  assert.equal(res.document_id, '95d9d4e2-817a-4304-86ad-ab83855fea44');

  const fallback = resolve('manual_journal', null, false);
  assert.equal(fallback.document_type, 'journal');
});
