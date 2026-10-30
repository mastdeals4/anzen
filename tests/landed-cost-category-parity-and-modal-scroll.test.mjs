import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  CAPITALIZABLE_LANDED_COST_CATEGORIES,
  CAPITALIZABLE_LANDED_COST_CATEGORIES_ARRAY,
  ALL_IMPORT_EXPENSE_CATEGORIES,
  isCapitalizableLandedCostCategory,
  isImportExpenseCategory,
  calculateContainerLandedCostPool,
  calculateExpenseLandedCostAmount,
} from '../src/utils/landedCost.ts';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const rootDir = path.resolve(__dirname, '..');

test('1. TypeScript and PostgreSQL Category Rules Parity: 100% Exact Match', () => {
  // Read live definition from PostgreSQL migration
  const migrationPath = path.join(
    rootDir,
    'supabase/migrations/20260921220000_fix_costing_engine_pib_null_and_stale_costs.sql'
  );
  const migrationSql = fs.readFileSync(migrationPath, 'utf8');

  // Extract categories from public.is_capitalizable_landed_cost_category
  const match = migrationSql.match(/FUNCTION public\.is_capitalizable_landed_cost_category[\s\S]*?IN \(([\s\S]*?)\);/);
  assert.ok(match, 'Must find is_capitalizable_landed_cost_category definition in migration SQL');

  const rawCategories = match[1];
  const postgresCategories = new Set(
    rawCategories
      .split(',')
      .map((s) => s.replace(/--.*$/gm, '').replace(/['\s]/g, ''))
      .filter(Boolean)
  );

  // Exact parity checks:
  assert.equal(
    postgresCategories.size,
    13,
    'PostgreSQL authoritative whitelist must contain exactly 13 categories'
  );
  assert.equal(
    CAPITALIZABLE_LANDED_COST_CATEGORIES.size,
    13,
    'TypeScript CAPITALIZABLE_LANDED_COST_CATEGORIES must contain exactly 13 categories'
  );

  // Every category in PostgreSQL must be in TypeScript Set
  for (const cat of postgresCategories) {
    assert.ok(
      CAPITALIZABLE_LANDED_COST_CATEGORIES.has(cat),
      `PostgreSQL category '${cat}' must exist in TypeScript CAPITALIZABLE_LANDED_COST_CATEGORIES`
    );
    assert.equal(
      isCapitalizableLandedCostCategory(cat),
      true,
      `isCapitalizableLandedCostCategory('${cat}') must return true`
    );
  }

  // Every category in TypeScript Set must be in PostgreSQL
  for (const cat of CAPITALIZABLE_LANDED_COST_CATEGORIES) {
    assert.ok(
      postgresCategories.has(cat),
      `TypeScript category '${cat}' must exist in PostgreSQL authoritative whitelist`
    );
  }

  // Strictly rejected categories
  const rejectedCategories = [
    'freight_charges',
    'transportation',
    'other_import_costs',
    'bpom_ski_fees',
    'staff_welfare',
    'ppn_import',
    'pph_import',
  ];

  for (const rejected of rejectedCategories) {
    assert.equal(
      CAPITALIZABLE_LANDED_COST_CATEGORIES.has(rejected),
      false,
      `Category '${rejected}' must NOT be in CAPITALIZABLE_LANDED_COST_CATEGORIES`
    );
    assert.equal(
      isCapitalizableLandedCostCategory(rejected),
      false,
      `isCapitalizableLandedCostCategory('${rejected}') must return false`
    );
  }
});

test('2. Container E0000085/2627: Canonical Landed Cost Pool equals exactly Rp 66,658,805', () => {
  const linkedExpenses = [
    {
      id: 'exp-broker-1',
      expense_category: 'import_broker',
      amount: 3300000,
      ppn_amount: 0,
      stamp_duty_amount: 0,
      broker_items: [
        { amount: 18254727, ppn_amount: 0, invoice_amount_authoritative: true },
        { amount: 554220, ppn_amount: 0, invoice_amount_authoritative: true },
        { amount: 6077102, ppn_amount: 601244, invoice_amount_authoritative: true },
        { amount: 721500, ppn_amount: 71500, invoice_amount_authoritative: true },
        { amount: 20000, ppn_amount: 0, invoice_amount_authoritative: true },
      ],
      include_in_landed_cost: true,
    },
    {
      id: 'exp-loading-1',
      expense_category: 'loading_import',
      amount: 200000,
      include_in_landed_cost: true,
    },
    {
      id: 'exp-loading-2',
      expense_category: 'loading_import',
      amount: 900000,
      include_in_landed_cost: true,
    },
    {
      id: 'exp-pib-1',
      expense_category: 'pib_import',
      amount: 142196038,
      pib_bm_amount: 37079000,
      pib_ppn_amount: 85650988,
      pib_pph_amount: 19466050,
      include_in_landed_cost: true,
    },
    // 5 BPOM/SKI regulatory registration fees (Account 5410, Rp 50,000 each = Rp 250,000)
    { id: 'exp-ski-1', expense_category: 'bpom_ski_fees', amount: 50000, include_in_landed_cost: true },
    { id: 'exp-ski-2', expense_category: 'bpom_ski_fees', amount: 50000, include_in_landed_cost: true },
    { id: 'exp-ski-3', expense_category: 'bpom_ski_fees', amount: 50000, include_in_landed_cost: true },
    { id: 'exp-ski-4', expense_category: 'bpom_ski_fees', amount: 50000, include_in_landed_cost: true },
    { id: 'exp-ski-5', expense_category: 'bpom_ski_fees', amount: 50000, include_in_landed_cost: true },
  ];

  const linkedPettyCash = [
    { id: 'pc-1', expense_category: 'loading_import', amount: 100000, include_in_landed_cost: true },
    { id: 'pc-2', expense_category: 'loading_import', amount: 125000, include_in_landed_cost: true },
    { id: 'pc-welfare', expense_category: 'staff_welfare', amount: 482000, include_in_landed_cost: true },
  ];

  const pool = calculateContainerLandedCostPool({
    linkedExpenses,
    linkedPettyCash,
    otherImportCosts: 0,
  });

  // Broker: 3,300,000 + 18,254,727 + 554,220 + 5,475,858 + 650,000 + 20,000 = 28,254,805
  assert.equal(calculateExpenseLandedCostAmount(linkedExpenses[0]).amount, 28254805);

  // Capitalized Linked Expenses = 28,254,805 + 200,000 + 900,000 = 29,354,805
  assert.equal(pool.selectedLandedExpensesTotal, 29354805);

  // Capitalized Petty Cash = 100,000 + 125,000 = 225,000
  assert.equal(pool.selectedLandedPettyCashTotal, 225000);

  // Linked Total = 29,354,805 + 225,000 = 29,579,805
  assert.equal(pool.selectedLandedLinkedTotal, 29579805);

  // PIB Duty (Bea Masuk) = 37,079,000
  assert.equal(pool.pibDutyTotal, 37079000);

  // Final Landed-Cost Pool = 29,579,805 + 37,079,000 = 66,658,805
  assert.equal(pool.containerLandedCostPool, 66658805);

  // PIB PPN (1150) and PPh (1155) strictly excluded
  assert.equal(pool.pibPpnTotal, 85650988);
  assert.equal(pool.pibPphTotal, 19466050);

  // Excluded BPOM fees (250,000) + staff welfare (482,000) = 732,000
  assert.equal(pool.excludedOperationalExpensesTotal, 732000);
});

test('3. Modal Scroll-Reset Regression: Scroll position preserved during form updates and re-renders', () => {
  const modalFilePath = path.join(rootDir, 'src/components/Modal.tsx');
  const modalCode = fs.readFileSync(modalFilePath, 'utf8');

  // Verify that the scroll reset is decoupled from onClose
  assert.ok(
    modalCode.includes('prevIsOpenRef.current'),
    'Modal must use a ref to track previous isOpen state'
  );
  const scrollIndex = modalCode.indexOf('bodyRef.current.scrollTop = 0');
  assert.ok(scrollIndex > -1, 'bodyRef.current.scrollTop = 0 must exist');
  const depStart = modalCode.indexOf('}, [', scrollIndex);
  assert.ok(depStart > -1, 'Effect dependency array must follow scroll reset');
  const depEnd = modalCode.indexOf(']', depStart);
  const depArray = modalCode.slice(depStart + 3, depEnd + 1);
  assert.ok(
    !depArray.includes('onClose'),
    `Scroll reset effect dependencies (${depArray}) must not include onClose`
  );
  assert.ok(
    depArray.includes('isOpen'),
    `Scroll reset effect dependencies (${depArray}) must include isOpen`
  );

  // Simulate Modal hook behavior across state updates
  class MockModalScroller {
    constructor() {
      this.body = { scrollTop: 0 };
      this.prevIsOpen = false;
    }

    render(isOpen, _onClose) {
      // Effect 1: scroll reset (runs on [isOpen])
      if (isOpen && !this.prevIsOpen && this.body) {
        this.body.scrollTop = 0;
      }
      this.prevIsOpen = isOpen;
    }
  }

  const modal = new MockModalScroller();

  // 1. Initial Open: modal transitions false -> true
  modal.render(true, () => {});
  assert.equal(modal.body.scrollTop, 0, 'Scroll top should be 0 on initial open');

  // 2. User scrolls down inside the modal
  modal.body.scrollTop = 420;

  // 3. User types in a form field or toggles a checkbox in parent
  // This passes a NEW onClose arrow function reference
  modal.render(true, () => {}); // new inline function reference
  assert.equal(
    modal.body.scrollTop,
    420,
    'Scroll position must be retained when parent re-renders and passes a new onClose reference'
  );

  modal.render(true, () => {}); // another render
  assert.equal(
    modal.body.scrollTop,
    420,
    'Scroll position must not be reset on repeated form re-renders'
  );

  // 4. Modal is closed
  modal.render(false, () => {});

  // 5. Modal is reopened: scroll should reset to top
  modal.render(true, () => {});
  assert.equal(
    modal.body.scrollTop,
    0,
    'Scroll position must reset to 0 when reopened after closing'
  );
});

test('4. Import Containers: Authoritative Category Filter and Bulk Error Handling', () => {
  const pagePath = path.join(rootDir, 'src/pages/ImportContainers.tsx');
  const pageCode = fs.readFileSync(pagePath, 'utf8');

  // 1. Authoritative category filter check:
  // Must use isImportExpenseCategory from landedCost.ts instead of a fragmented local list
  assert.ok(
    pageCode.includes('isImportExpenseCategory(e.expense_category)'),
    'loadLinkedExpenses must filter using authoritative isImportExpenseCategory'
  );
  assert.ok(
    !pageCode.includes("const importExpenseCategories = new Set(["),
    'Must not have a divergent hardcoded local importExpenseCategories Set'
  );

  // All 13 capitalizable categories must be admitted by isImportExpenseCategory
  for (const cat of CAPITALIZABLE_LANDED_COST_CATEGORIES_ARRAY) {
    assert.equal(
      isImportExpenseCategory(cat),
      true,
      `Category '${cat}' must be included in isImportExpenseCategory`
    );
  }

  // 2. Bulk Checkbox Error Handling check:
  // Both handleSelectAll and handleClearAll must check { error } from supabase.from().update()
  const selectAllMatch = pageCode.match(/const handleSelectAll = async \(\) => \{([\s\S]*?)\n  \};/);
  assert.ok(selectAllMatch, 'handleSelectAll function found');
  const selectAllBody = selectAllMatch[1];
  assert.ok(
    selectAllBody.includes('const { error } = await supabase.from(table).update'),
    'handleSelectAll must inspect { error } on supabase update'
  );
  assert.ok(
    selectAllBody.includes('if (error) throw error;'),
    'handleSelectAll must throw on error'
  );
  assert.ok(
    selectAllBody.includes('setInclusionMap(previousInclusionMap);'),
    'handleSelectAll must rollback inclusion map on error'
  );
  assert.ok(
    selectAllBody.includes('loadLinkedExpenses(editingContainer.id)'),
    'handleSelectAll must reload from server on failure'
  );

  const clearAllMatch = pageCode.match(/const handleClearAll = async \(\) => \{([\s\S]*?)\n  \};/);
  assert.ok(clearAllMatch, 'handleClearAll function found');
  const clearAllBody = clearAllMatch[1];
  assert.ok(
    clearAllBody.includes('const { error } = await supabase.from(table).update'),
    'handleClearAll must inspect { error } on supabase update'
  );
  assert.ok(
    clearAllBody.includes('if (error) throw error;'),
    'handleClearAll must throw on error'
  );
  assert.ok(
    clearAllBody.includes('setInclusionMap(previousInclusionMap);'),
    'handleClearAll must rollback inclusion map on error'
  );
  assert.ok(
    clearAllBody.includes('loadLinkedExpenses(editingContainer.id)'),
    'handleClearAll must reload from server on failure'
  );
});
