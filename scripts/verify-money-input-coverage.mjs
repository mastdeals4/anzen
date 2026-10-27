import fs from 'node:fs';
import path from 'node:path';

const root = path.resolve(import.meta.dirname, '..');

function sourceFiles(directory) {
  return fs.readdirSync(directory, { withFileTypes: true }).flatMap(entry => {
    const target = path.join(directory, entry.name);
    if (entry.isDirectory()) return sourceFiles(target);
    return /\.(?:ts|tsx)$/.test(entry.name) ? [target] : [];
  });
}

const requiredMoneyInputCoverage = [
  'src/components/finance/ExpenseManager.tsx',
  'src/components/finance/PaymentVoucherManager.tsx',
  'src/components/finance/ReceiptVoucherManager.tsx',
  'src/components/finance/GeneralJournalEntry.tsx',
  'src/components/finance/PettyCashManager.tsx',
  'src/components/finance/BankReconciliationEnhanced.tsx',
  'src/components/finance/ReceivablesManager.tsx',
  'src/components/finance/PayablesManager.tsx',
  'src/components/finance/tax/TaxPaymentsPanel.tsx',
  'src/components/finance/PurchaseInvoiceManager.tsx',
  'src/components/finance/StaffMasterManager.tsx',
  'src/pages/PurchaseOrders.tsx',
  'src/pages/Sales.tsx',
  'src/pages/PriceCalculator.tsx',
  'src/pages/PublicCalculator.tsx',
  'src/pages/ImportContainers.tsx',
  'src/pages/CreditNotes.tsx',
  'src/pages/Batches.tsx',
];

for (const relative of requiredMoneyInputCoverage) {
  const source = fs.readFileSync(path.join(root, relative), 'utf8');
  if (!source.includes('<MoneyInput')) {
    throw new Error(`${relative} has no shared MoneyInput coverage`);
  }
}

const currencyAttribute = /amount|price|cost|debit|credit|salary|invoice_value|trucking|generic_charge|duty_bm|ppn_import|pph_import/i;
const permittedDimensionalClearance = /clearance_(?:base_limit_cbm|min_weight)/i;
const financeNonCurrency = /exchange|quantity|terms|percentage|max=["']100["']|step=["']0\.5["']/i;
const violations = [];

for (const file of sourceFiles(path.join(root, 'src'))) {
  const source = fs.readFileSync(file, 'utf8');
  for (const match of source.matchAll(/<input\b[\s\S]*?\/>/g)) {
    const input = match[0];
    if (!/type=["']number["']/.test(input)) continue;

    if (currencyAttribute.test(input) && !permittedDimensionalClearance.test(input) && !input.includes('data-non-currency')) {
      violations.push(`${path.relative(root, file)}: currency-like numeric input: ${input.replace(/\s+/g, ' ').slice(0, 180)}`);
    }

    if (file.includes(`${path.sep}components${path.sep}finance${path.sep}`) && !financeNonCurrency.test(input)) {
      violations.push(`${path.relative(root, file)}: unclassified Finance numeric input: ${input.replace(/\s+/g, ' ').slice(0, 180)}`);
    }
  }
}

if (violations.length) {
  throw new Error(`MoneyInput coverage regression failed:\n${violations.join('\n')}`);
}

console.log('MoneyInput coverage regression passed: currency fields use the shared text input.');
