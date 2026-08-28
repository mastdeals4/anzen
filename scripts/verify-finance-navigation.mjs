import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';

const financeSource = readFileSync('src/pages/Finance.tsx', 'utf8');
const dashboardSource = readFileSync('src/components/finance/FinanceExceptionCorrectionDashboard.tsx', 'utf8');
const integritySource = readFileSync('src/components/finance/IntegrityMonitor.tsx', 'utf8');

const expectedMenuItems = [
  'purchase', 'receipt', 'payment', 'journal', 'contra', 'expenses', 'petty_cash',
  'ledger', 'journal_register', 'bank_ledger', 'party_ledger', 'bank_recon',
  'ca_reports', 'trial_balance', 'pnl', 'balance_sheet', 'receivables', 'payables',
  'ageing', 'tax', 'integrity_monitor', 'exception_correction',
  'coa', 'suppliers', 'banks', 'staff_master', 'utility_master',
];

const menuBlock = financeSource.match(/const getFinanceMenu[\s\S]*?function FinanceContent/)?.[0] || '';
const actualMenuItems = [...menuBlock.matchAll(/\{ id: '([^']+)'/g)].map(match => match[1]);
const missing = expectedMenuItems.filter(item => !actualMenuItems.includes(item));
const unexpected = actualMenuItems.filter(item => !expectedMenuItems.includes(item));

if (missing.length || unexpected.length || actualMenuItems.length !== expectedMenuItems.length) {
  throw new Error(`Finance menu regression. Missing: ${missing.join(', ') || 'none'}. Unexpected: ${unexpected.join(', ') || 'none'}.`);
}

const sourceMarkers = [
  "exception_correction: 'exception-correction'",
  "{ id: 'integrity_monitor', label: 'Integrity Monitor' }",
  "{ id: 'exception_correction', label: 'Exception Correction' }",
  "case 'integrity_monitor':",
  "case 'exception_correction':",
  '<IntegrityMonitor />',
  '<FinanceExceptionCorrectionDashboard canManage={canManage} />',
];
for (const marker of sourceMarkers) {
  if (!financeSource.includes(marker)) throw new Error(`Missing Finance navigation marker: ${marker}`);
}

const dashboardMarkers = ['Save repair', 'Chart of Accounts', 'From Bank', 'To Bank', 'bank_alias', 'save_finance_exception_corrections_v2'];
for (const marker of dashboardMarkers) {
  if (!dashboardSource.includes(marker)) throw new Error(`Missing Exception Correction control: ${marker}`);
}

for (const marker of ['duplicate_postings', 'orphan_journal_lines', 'missing_petty_cash_links', 'negative_cash_anomalies', 'No records found', 'openDetails']) {
  if (!integritySource.includes(marker)) throw new Error(`Missing Integrity Monitor drill-down marker: ${marker}`);
}

const assetDir = 'dist/assets';
const builtJavaScript = readdirSync(assetDir)
  .filter(file => file.endsWith('.js'))
  .map(file => readFileSync(join(assetDir, file), 'utf8'))
  .join('\n');
for (const marker of ['Exception Correction', 'Integrity Monitor', 'exception-correction', 'Save repair', 'Chart of Accounts', 'From Bank', 'To Bank']) {
  if (!builtJavaScript.includes(marker)) throw new Error(`Production build is missing: ${marker}`);
}

console.log(`Finance navigation verified: ${actualMenuItems.length} menu items; Exception Correction and Integrity Monitor are present.`);
