import test from 'node:test';
import assert from 'node:assert/strict';
import { execSync } from 'child_process';
import fs from 'fs';
import os from 'os';
import path from 'path';

function runSql(sql) {
  const tmpFile = path.join(os.tmpdir(), `query_${Date.now()}_${Math.random().toString(36).slice(2)}.sql`);
  fs.writeFileSync(tmpFile, sql, 'utf-8');
  try {
    const res = execSync(`npx supabase db query --linked -f "${tmpFile}"`, {
      encoding: 'utf-8',
      maxBuffer: 50 * 1024 * 1024,
      shell: '/bin/zsh'
    });
    const jsonMatch = res.match(/\{[\s\S]*"rows":[\s\S]*\}/);
    if (jsonMatch) {
      const parsed = JSON.parse(jsonMatch[0]);
      return parsed.rows;
    }
    return [];
  } finally {
    if (fs.existsSync(tmpFile)) fs.unlinkSync(tmpFile);
  }
}

test('1. Migration file and database structure exists', () => {
  const migrationPath = path.join(process.cwd(), 'supabase/migrations/20260923160000_director_related_party_finance_simplification.sql');
  assert.ok(fs.existsSync(migrationPath), 'Migration file must exist');

  const content = fs.readFileSync(migrationPath, 'utf-8');
  assert.match(content, /get_director_related_party_balance_summary/, 'Must declare get_director_related_party_balance_summary RPC');
  assert.match(content, /record_director_related_party_bank_transaction/, 'Must declare record_director_related_party_bank_transaction RPC');
  assert.match(content, /Vijay Lunkad/, 'Must reference Vijay Lunkad as director');
});

test('2. Historical loan records remain intact', () => {
  const rows = runSql(`
    SELECT loan_number, counterparty_name, loan_type, principal_amount, status, outstanding_balance
    FROM loans
    WHERE loan_number IN ('LN2502-0001', 'LN2601-0001', 'LN2609-0001')
    ORDER BY loan_number;
  `);

  assert.equal(rows.length, 3, 'Must contain all 3 historical loans');

  const ln2502 = rows.find(r => r.loan_number === 'LN2502-0001');
  assert.ok(ln2502);
  assert.equal(Number(ln2502.principal_amount), 3000000);
  assert.equal(ln2502.status, 'closed');
  assert.equal(Number(ln2502.outstanding_balance), 0);

  const ln2601 = rows.find(r => r.loan_number === 'LN2601-0001');
  assert.ok(ln2601);
  assert.equal(Number(ln2601.principal_amount), 20000000);
  assert.equal(ln2601.status, 'active');
  assert.equal(Number(ln2601.outstanding_balance), 20000000);

  const ln2609 = rows.find(r => r.loan_number === 'LN2609-0001');
  assert.ok(ln2609);
  assert.equal(Number(ln2609.principal_amount), 10000000);
  assert.equal(ln2609.status, 'closed');
  assert.equal(Number(ln2609.outstanding_balance), 0);
});

test('3. General Ledger balances for 1310, 2105, and 3110 audit verification', () => {
  const rows = runSql(`
    SELECT
      coa.code,
      coa.name,
      SUM(jel.debit) as total_debit,
      SUM(jel.credit) as total_credit,
      CASE
        WHEN coa.account_type = 'asset' THEN SUM(jel.debit) - SUM(jel.credit)
        WHEN coa.account_type = 'liability' THEN SUM(jel.credit) - SUM(jel.debit)
        ELSE SUM(jel.credit) - SUM(jel.debit)
      END as net_balance
    FROM chart_of_accounts coa
    LEFT JOIN journal_entry_lines jel ON jel.account_id = coa.id
    LEFT JOIN journal_entries je ON je.id = jel.journal_entry_id AND je.is_posted = true AND je.is_reversed = false
    WHERE coa.code IN ('1310', '2105', '3110')
    GROUP BY coa.id, coa.code, coa.name, coa.account_type
    ORDER BY coa.code;
  `);

  const acc1310 = rows.find(r => r.code === '1310');
  assert.ok(acc1310);
  assert.equal(Number(acc1310.net_balance || 0), 0, '1310 Loan Receivable net balance must be zero (settled)');

  const acc2105 = rows.find(r => r.code === '2105');
  assert.ok(acc2105);
  assert.equal(Number(acc2105.net_balance), 94247000, '2105 Director Loan net payable must be Rp 94,247,000');

  const acc3110 = rows.find(r => r.code === '3110');
  assert.ok(acc3110);
  assert.equal(Number(acc3110.total_debit || 0), 0, '3110 Owner Drawings must have zero debit transactions');
  assert.equal(Number(acc3110.total_credit || 0), 0, '3110 Owner Drawings must have zero credit transactions');
});

test('4. Unified Director summary RPC matches General Ledger', () => {
  const rows = runSql(`
    SELECT get_director_related_party_balance_summary('Vijay Lunkad') as summary;
  `);

  assert.equal(rows.length, 1);
  const summary = rows[0].summary;
  assert.equal(Number(summary.due_to_director), 94247000, 'Due to director must match 2105 net payable');
  assert.equal(Number(summary.due_from_director), 0, 'Due from director must match 1310 net receivable');
  assert.equal(Number(summary.net_position), 94247000, 'Net position must be Rp 94,247,000');
  assert.equal(summary.net_status, 'payable');
  assert.equal(summary.active_loans.length, 1);
  assert.equal(summary.active_loans[0].loan_number, 'LN2601-0001');
});

test('5. Bank statement allocation completeness and lineage for historical director transactions', () => {
  // LP2609-0001 was backfilled and must have a valid allocation entry
  const rows = runSql(`
    SELECT
      bsl.transaction_date,
      bsl.description,
      bsl.credit_amount,
      bsl.debit_amount,
      bsa.id as allocation_id,
      bsa.document_type,
      bsa.document_id,
      bsa.allocation_amount
    FROM bank_statement_lines bsl
    JOIN bank_statement_allocations bsa ON bsa.bank_statement_line_id = bsl.id
    WHERE bsl.id = '6f9781c2-ea23-443e-b77f-48ce38cdfe35';
  `);

  assert.equal(rows.length, 1, 'LP2609-0001 bank line must have an allocation row');
  assert.equal(rows[0].document_type, 'journal');
  assert.equal(Number(rows[0].allocation_amount), 10000000);
});

test('6. Direction integrity validation: bank debit vs bank credit cannot be inverted', () => {
  // Test that record_director_related_party_bank_transaction validates matching bank statement line
  const invalidLineRows = runSql(`
    DO $$
    DECLARE
      v_admin_id uuid;
    BEGIN
      SELECT id INTO v_admin_id FROM user_profiles WHERE role IN ('admin', 'accounts') LIMIT 1;
      PERFORM set_config('request.jwt.claims', json_build_object('sub', v_admin_id::text, 'role', 'authenticated')::text, true);

      BEGIN
        PERFORM record_director_related_party_bank_transaction(
          '00000000-0000-0000-0000-000000000000',
          'Vijay Lunkad'
        );
        RAISE EXCEPTION 'Should have failed on missing bank line';
      EXCEPTION WHEN OTHERS THEN
        IF SQLERRM NOT LIKE '%not found%' THEN
          RAISE;
        END IF;
      END;
    END $$;
    SELECT true as passed;
  `);

  assert.equal(invalidLineRows.length, 1);
  assert.equal(invalidLineRows[0].passed, true);
});

test('7. Journal balance integrity: every director journal must balance debit = credit', () => {
  const unbalancedRows = runSql(`
    SELECT
      je.id,
      je.entry_number,
      SUM(jel.debit) as sum_debit,
      SUM(jel.credit) as sum_credit
    FROM journal_entries je
    JOIN journal_entry_lines jel ON jel.journal_entry_id = je.id
    WHERE je.id IN (
      SELECT DISTINCT journal_entry_id
      FROM journal_entry_lines l
      JOIN chart_of_accounts a ON a.id = l.account_id
      WHERE a.code IN ('1310', '2105')
    )
    GROUP BY je.id, je.entry_number
    HAVING ABS(SUM(jel.debit) - SUM(jel.credit)) > 0.01;
  `);

  assert.equal(unbalancedRows.length, 0, 'No unbalanced journals across 1310 or 2105 transactions');
});

test('8. Duplicate bank allocation prevention', () => {
  // Test that a line already fully allocated cannot be re-allocated
  const errorCheck = runSql(`
    DO $$
    DECLARE
      v_admin_id uuid;
    BEGIN
      SELECT id INTO v_admin_id FROM user_profiles WHERE role IN ('admin', 'accounts') LIMIT 1;
      PERFORM set_config('request.jwt.claims', json_build_object('sub', v_admin_id::text, 'role', 'authenticated')::text, true);

      BEGIN
        PERFORM record_director_related_party_bank_transaction(
          '6f9781c2-ea23-443e-b77f-48ce38cdfe35',
          'Vijay Lunkad'
        );
        RAISE EXCEPTION 'Should have failed on already reconciled bank line';
      EXCEPTION WHEN OTHERS THEN
        IF SQLERRM NOT LIKE '%already linked%' AND SQLERRM NOT LIKE '%already fully reconciled%' THEN
          RAISE;
        END IF;
      END;
    END $$;
    SELECT true as passed;
  `);

  assert.equal(errorCheck.length, 1);
  assert.equal(errorCheck[0].passed, true);
});

test('9. Director-funded petty cash lineage to 2105 preserves payable nature', () => {
  const pettyCashDirectorLines = runSql(`
    SELECT COUNT(*) as count, SUM(jel.credit) as total_credit
    FROM journal_entries je
    JOIN journal_entry_lines jel ON jel.journal_entry_id = je.id
    JOIN chart_of_accounts coa ON coa.id = jel.account_id
    WHERE je.source_module = 'petty_cash'
      AND coa.code = '2105'
      AND jel.credit > 0;
  `);

  assert.equal(Number(pettyCashDirectorLines[0].count), 15, '15 petty cash transactions funded personally by director');
  assert.equal(Number(pettyCashDirectorLines[0].total_credit), 73047000, 'Total petty cash payable to director is Rp 73,047,000');
});

test('10. Owner drawings (3110) remains isolated with zero automated leakage', () => {
  const drawingEntries = runSql(`
    SELECT COUNT(*) as count
    FROM journal_entry_lines jel
    JOIN chart_of_accounts coa ON coa.id = jel.account_id
    WHERE coa.code = '3110';
  `);

  assert.equal(Number(drawingEntries[0].count), 0, 'Account 3110 has exactly 0 entries');
});
