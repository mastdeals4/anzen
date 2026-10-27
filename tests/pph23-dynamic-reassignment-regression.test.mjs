import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

const migration = readFileSync(
  new URL('../supabase/migrations/20260911153000_fix_dynamic_pph23_period_reassignment.sql', import.meta.url),
  'utf8',
);
const register = readFileSync(
  new URL('../src/components/finance/tax/PphRegisterPanel.tsx', import.meta.url),
  'utf8',
);

test('reassign_tax_document_period handles previously unassigned documents and recomputes both periods', () => {
  assert.match(migration, /IF v_old_period_id IS NULL AND v_doc_date IS NOT NULL/);
  assert.match(migration, /SELECT id INTO v_old_period_id FROM public\.tax_periods WHERE tax_type = v_tax_type AND v_doc_date BETWEEN period_start AND period_end/);
  assert.match(migration, /PERFORM public\.compute_period_ppn\(v_old_period_id\)/);
  assert.match(migration, /PERFORM public\.compute_period_ppn\(p_tax_period_id\)/);
});

test('trg_recompute_from_expense watches pph_tax_period_id and tax_period_id changes', () => {
  assert.match(migration, /NEW\.pph_tax_period_id IS DISTINCT FROM OLD\.pph_tax_period_id/);
  assert.match(migration, /NEW\.tax_period_id IS DISTINCT FROM OLD\.tax_period_id/);
  assert.match(migration, /PERFORM public\.compute_period_ppn\(NEW\.pph_tax_period_id\)/);
  assert.match(migration, /PERFORM public\.compute_period_ppn\(OLD\.pph_tax_period_id\)/);
});

test('vw_canonical_tax_period_amounts dynamically calculates resolved_pph_total unless filed or closed', () => {
  assert.match(migration, /CASE WHEN tp\.status IN \('filed','closed'\) OR tp\.filing_status = 'filed' THEN tp\.pph_total/);
  assert.match(migration, /ELSE public\.fn_pph_authoritative_source_total\(tp\.id\) END/);
});

test('PphRegisterPanel correctly handles reassigned periods in both single and consolidated views', () => {
  assert.match(register, /pph_period:pph_tax_period_id\(id, fiscal_year, period_month, tax_type\)/);
  assert.match(register, /expense\.pph_period\.fiscal_year === yr && expense\.pph_period\.period_month === mo/);
  assert.match(register, /expense\.pph_tax_period_id === row\.tax_period_id/);
});
