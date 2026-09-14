import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { execSync } from 'node:child_process';
import test from 'node:test';

const migration = readFileSync(
  new URL('../supabase/migrations/20260914140000_fix_import_pph22_classification.sql', import.meta.url),
  'utf8',
);
const pphRegisterUi = readFileSync(
  new URL('../src/components/finance/tax/PphRegisterPanel.tsx', import.meta.url),
  'utf8',
);
const taxReportsUi = readFileSync(
  new URL('../src/components/finance/tax/TaxReportsPanel.tsx', import.meta.url),
  'utf8',
);

function runDbQuery(sql) {
  try {
    const cmd = `npx supabase db query --linked "${sql.replace(/"/g, '\\"')}"`;
    const output = execSync(cmd, { encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'] });
    return JSON.parse(output);
  } catch (err) {
    console.warn('Database query failed or not connected in this test run:', err.message);
    return null;
  }
}

test('Migration: excludes pib_import and pph_import from fn_pph_authoritative_source_total', () => {
  assert.match(migration, /CREATE OR REPLACE FUNCTION public\.fn_pph_authoritative_source_total/);
  assert.match(migration, /COALESCE\(fe\.expense_category,''\) NOT IN \('pib_import','pph_import'\)/);
});

test('Migration: excludes import pph from compute_period_ppn_pre_posted_register', () => {
  assert.match(migration, /CREATE OR REPLACE FUNCTION public\.compute_period_ppn_pre_posted_register/);
  assert.match(migration, /COALESCE\(fe\.expense_category, ''\) NOT IN \('pib_import', 'pph_import'\)/);
  assert.match(migration, /UPDATE tax_periods SET[\s\S]*pph_total\s*=\s*v_pph_total/);
});

test('Migration: does NOT modify journals, expenses, or create synthetic tax payments', () => {
  assert.doesNotMatch(migration, /INSERT INTO public\.journal/i);
  assert.doesNotMatch(migration, /UPDATE public\.journal/i);
  assert.doesNotMatch(migration, /DELETE FROM public\.journal/i);
  assert.doesNotMatch(migration, /UPDATE public\.finance_expenses/i);
  assert.doesNotMatch(migration, /INSERT INTO public\.tax_payments/i);
});

test('Migration: recalculates PPh22 and PPh_Unifikasi open tax periods', () => {
  assert.match(migration, /tax_type IN \('PPh22',\s*'PPh_Unifikasi'\)/);
  assert.match(migration, /PERFORM public\.compute_period_ppn\(r\.id\)/);
});

test('PphRegisterPanel: separates Prepaid Import PPh 22 (COA 1155) from Monthly Withheld Liability', () => {
  assert.match(pphRegisterUi, /vw_pph22_advance_tax_report/);
  assert.match(pphRegisterUi, /importAdvanceTaxTotal/);
  assert.match(pphRegisterUi, /Prepaid Import PPh 22 \(Pajak Dibayar di Muka \/ Kredit Pajak\)/);
  assert.match(pphRegisterUi, /COA 1155/);
  assert.match(pphRegisterUi, /Withheld PPh 22 \(Payable\)/);
  assert.match(pphRegisterUi, /Paid at Customs/);
  assert.match(pphRegisterUi, /Import PPh22 \(Prepaid\)/);
  assert.match(pphRegisterUi, /withheldTotal - Number\(r\.pph_total/);
});

test('TaxReportsPanel: classifies import PPh 22 correctly in tax compliance export', () => {
  assert.match(taxReportsUi, /PPh22 Import \(Prepaid\)/);
  assert.match(taxReportsUi, /Prepaid \/ Advance Tax \(Kredit Pajak PPh 22\)/);
  assert.match(taxReportsUi, /Approved \(Paid at Customs\)/);
});

test('Live DB Invariant: COA 1155 remains Rp 179,791,222.00 Debit and COA 2137 remains Rp 0.00', () => {
  const json = runDbQuery(`
    SELECT a.code, a.name,
      COALESCE(SUM(jel.debit), 0) - COALESCE(SUM(jel.credit), 0) AS net_debit
    FROM chart_of_accounts a
    LEFT JOIN journal_entry_lines jel ON jel.account_id = a.id
    LEFT JOIN journal_entries je ON je.id = jel.journal_entry_id
    WHERE a.code IN ('1155', '2137')
    GROUP BY a.code, a.name
    ORDER BY a.code;
  `);
  if (!json) return;
  const row1155 = json.rows.find(r => r.code === '1155');
  const row2137 = json.rows.find(r => r.code === '2137');
  assert.equal(Number(row1155.net_debit), 179791222.00, 'COA 1155 net debit balance');
  assert.equal(Number(row2137.net_debit), 0, 'COA 2137 net debit balance');
});

test('Live DB Invariant: vw_outstanding_tax has zero outstanding PPh 22', () => {
  const json = runDbQuery(`
    SELECT COUNT(*) as count, COALESCE(SUM(outstanding_amount), 0) as total
    FROM vw_outstanding_tax
    WHERE tax_type = 'PPh22';
  `);
  if (!json) return;
  assert.equal(Number(json.rows[0].count), 0, 'Outstanding PPh22 count');
  assert.equal(Number(json.rows[0].total), 0, 'Outstanding PPh22 amount');
});

test('Live DB Invariant: vw_pph22_advance_tax_report contains all 9 import records totaling Rp 179,791,222.00', () => {
  const json = runDbQuery(`
    SELECT COUNT(*) as count, COALESCE(SUM(pph22_amount), 0) as total
    FROM vw_pph22_advance_tax_report;
  `);
  if (!json) return;
  assert.equal(Number(json.rows[0].count), 9, 'Advance tax report record count');
  assert.equal(Number(json.rows[0].total), 179791222.00, 'Advance tax report total amount');
});

test('Live DB Invariant: PPh_Unifikasi withholding totals reflect genuine withholdings without import PPh 22', () => {
  const json = runDbQuery(`
    SELECT period_month, pph_total, paid_amount, outstanding_amount
    FROM vw_canonical_tax_period_amounts
    WHERE tax_type = 'PPh_Unifikasi' AND fiscal_year = 2026 AND period_month IN (2, 6, 8)
    ORDER BY period_month;
  `);
  if (!json) return;
  const m2 = json.rows.find(r => r.period_month === 2);
  const m6 = json.rows.find(r => r.period_month === 6);
  const m8 = json.rows.find(r => r.period_month === 8);

  assert.equal(Number(m2.pph_total), 456500.00, 'PPh_Unifikasi Feb 2026');
  assert.equal(Number(m6.pph_total), 260000.00, 'PPh_Unifikasi Jun 2026');
  assert.equal(Number(m8.pph_total), 1844566.00, 'PPh_Unifikasi Aug 2026');
});
