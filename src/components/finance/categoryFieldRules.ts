/**
 * categoryFieldRules — single source of truth for which fields the Expense
 * form shows for a given expense_category.
 *
 * Rules (per user brief 2026-07-08):
 *   • Salary / staff_overtime / staff_welfare / travel_conveyance
 *       → HIDE Supplier. SHOW Staff picker + Salary Month.
 *   • Utilities
 *       → HIDE Supplier. SHOW Utility picker + Billing Month.
 *   • Travel (travel_conveyance is a Staff category above; general travel
 *       is not a separate category yet — treated as Staff Expense.)
 *   • Import Broker (import_broker)
 *       → SHOW Supplier + Container + Broker/Reimbursement lines.
 *   • All other expense-supplier categories (rent, professional services,
 *       office, purchases, admin, etc.)
 *       → SHOW Supplier as before.
 *
 * The rules are read by ExpenseManager to decide field visibility.
 * They do NOT affect what gets saved to finance_expenses — that stays
 * exactly as it was. When a Staff or Utility row is picked, the frontend
 * resolves the underlying supplier_id (utility_master.supplier_id) or
 * leaves it null (staff) and writes the master row's id into the
 * description prefix so it's traceable in the ledger.
 */

export type FieldFlag = 'show' | 'hide' | 'optional';

export interface CategoryFieldRules {
  supplier: FieldFlag;        // top-line Supplier picker
  staff: FieldFlag;           // Staff Master picker (Salary / Staff Welfare / etc.)
  utility: FieldFlag;         // Utility Master picker
  container: FieldFlag;       // Import container picker
  brokerLines: FieldFlag;     // Reimbursement line editor
  salaryMonth: FieldFlag;     // Salary month (period label)
  billingMonth: FieldFlag;    // Utility billing month
  reference: FieldFlag;       // Payment reference input
  bankCharges: FieldFlag;     // Utility bank charges
}

/**
 * Default = show Supplier, hide all specialised pickers, show reference.
 * Every category overrides only what it needs.
 */
const DEFAULT: CategoryFieldRules = {
  supplier:     'show',
  staff:        'hide',
  utility:      'hide',
  container:    'hide',
  brokerLines:  'hide',
  salaryMonth:  'hide',
  billingMonth: 'hide',
  reference:    'show',
  bankCharges:  'hide',
};

const STAFF_RULES: CategoryFieldRules = {
  ...DEFAULT,
  supplier:    'hide',
  staff:       'show',
  salaryMonth: 'show',
};

const UTILITY_RULES: CategoryFieldRules = {
  ...DEFAULT,
  supplier:     'hide',
  utility:      'show',
  billingMonth: 'show',
};

const IMPORT_BROKER_RULES: CategoryFieldRules = {
  ...DEFAULT,
  container:   'show',
  brokerLines: 'show',
};

/**
 * Categories that map to Staff Master.
 * salary / staff_overtime / staff_welfare / travel_conveyance are all
 * "employee-payable" — they hide the Supplier picker and show the Staff picker.
 */
const STAFF_CATEGORIES = new Set([
  'salary',
  'staff_overtime',
  'staff_welfare',
  'travel_conveyance',
  'staff_advance',
]);

/**
 * Categories that map to Utility Master.
 */
const UTILITY_CATEGORIES = new Set([
  'electricity',
  'water',
  'internet_phone',
]);

/**
 * Categories that use the broker / reimbursement flow.
 */
const IMPORT_BROKER_CATEGORIES = new Set([
  'import_broker',
]);

/**
 * Resolve the field-visibility rules for a given expense category.
 * Empty / unknown category returns DEFAULT so the form still renders.
 */
export function getCategoryFieldRules(category: string | null | undefined): CategoryFieldRules {
  const c = (category ?? '').trim();
  if (!c) return DEFAULT;
  if (STAFF_CATEGORIES.has(c)) return STAFF_RULES;
  if (UTILITY_CATEGORIES.has(c)) return UTILITY_RULES;
  if (IMPORT_BROKER_CATEGORIES.has(c)) return IMPORT_BROKER_RULES;
  return DEFAULT;
}
