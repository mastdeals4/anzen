/**
 * taxCalculations.ts
 * Shared utilities for the Finance / Expense module.
 *
 * Key design constraints:
 *   - Document Type is a UI-only grouping concept (no DB column).
 *   - PPN Import and PPh Import ONLY appear inside the PIB workflow.
 *     They must NEVER be shown as standalone expense categories.
 *   - PIB (pib_import) is completely separate from the Import/Customs Broker invoice.
 *   - All amounts in IDR; no currency conversion here.
 */

// ---------------------------------------------------------------------------
// Document Type definitions
// ---------------------------------------------------------------------------

/** All document types visible in the Expense form. */
export const DOCUMENT_TYPES = [
  'Operating Expense',
  'Utility',
  'Staff Expense',
  'Sales & Distribution',
  'Professional Services',
  'Import / Customs Broker Invoice',
  'Fixed Asset',
  'PIB',
] as const;

export type DocumentType = typeof DOCUMENT_TYPES[number];

// ---------------------------------------------------------------------------
// Document Type → expense_category mapping
// ---------------------------------------------------------------------------
// These are the expense_category values that appear under each Document Type.
// PPN Import (ppn_import) and PPh Import (pph_import) are intentionally
// omitted — they belong exclusively inside the PIB workflow.

export const DOCUMENT_TYPE_GROUPS: Record<DocumentType, string[]> = {
  'Operating Expense':                ['warehouse_rent', 'bank_charges', 'office_admin', 'office_shifting_renovation', 'other'],
  'Utility':                          ['utilities'],
  'Staff Expense':                    ['salary', 'staff_overtime', 'staff_welfare', 'travel_conveyance', 'non_permanent_employee_fee'],
  'Sales & Distribution':             ['delivery_sales', 'loading_sales', 'other_sales'],
  'Professional Services':            ['professional_services'],
  'Import / Customs Broker Invoice':  ['import_broker'],
  'Fixed Asset':                      ['fixed_asset'],
  'PIB':                              ['pib_import'],
};

/** Returns the Document Type that owns a given expense_category. */
export function getDocTypeForCategory(category: string): DocumentType | null {
  for (const [docType, cats] of Object.entries(DOCUMENT_TYPE_GROUPS) as [DocumentType, string[]][]) {
    if (cats.includes(category)) return docType;
  }
  return null;
}

/** Auto-selects category when a Document Type has exactly one. */
export function getSingleCategoryForDocType(docType: DocumentType): string | null {
  const cats = DOCUMENT_TYPE_GROUPS[docType];
  return cats.length === 1 ? cats[0] : null;
}

// ---------------------------------------------------------------------------
// Tax field visibility per Document Type
// ---------------------------------------------------------------------------

export interface TaxFieldConfig {
  /** Show PPN Input field */
  ppn: boolean;
  /** Show PPh 23 fields */
  pph23: boolean;
  /** Show PPh 21 fields */
  pph21: boolean;
  /** Show Bea Meterai (Stamp Duty) field */
  stamp: boolean;
  /** Show PIB breakdown fields (BM, PPN Import, PPh 22) */
  pib: boolean;
  /** Show broker item sub-cost breakdown */
  brokerItems: boolean;
}

export const DOCUMENT_TYPE_TAX_CONFIG: Record<DocumentType, TaxFieldConfig> = {
  'Operating Expense':               { ppn: true,  pph23: false, pph21: false, stamp: true,  pib: false, brokerItems: false },
  'Utility':                         { ppn: true,  pph23: true,  pph21: false, stamp: false, pib: false, brokerItems: false },
  'Staff Expense':                   { ppn: false, pph23: false, pph21: true,  stamp: false, pib: false, brokerItems: false },
  'Sales & Distribution':            { ppn: false, pph23: false, pph21: false, stamp: false, pib: false, brokerItems: false },
  'Professional Services':           { ppn: true,  pph23: true,  pph21: false, stamp: true,  pib: false, brokerItems: false },
  'Import / Customs Broker Invoice': { ppn: true,  pph23: true,  pph21: false, stamp: true,  pib: false, brokerItems: true  },
  'Fixed Asset':                     { ppn: true,  pph23: false, pph21: false, stamp: false, pib: false, brokerItems: false },
  'PIB':                             { ppn: false, pph23: false, pph21: false, stamp: false, pib: true,  brokerItems: false },
};

// ---------------------------------------------------------------------------
// Broker item types (for Import / Customs Broker Invoice breakdown)
// ---------------------------------------------------------------------------

export const BROKER_ITEM_TYPES = [
  { value: 'do_charges',         label: 'D/O Charges' },
  { value: 'port_charges',       label: 'Port Charges' },
  { value: 'clearing_forwarding',label: 'Clearing & Forwarding' },
  { value: 'handling',           label: 'Handling' },
  { value: 'truck',              label: 'Trucking' },
  { value: 'freight',            label: 'Freight' },
  { value: 'administration',     label: 'Administration' },
  { value: 'other',              label: 'Other' },
] as const;

export type BrokerItemType = typeof BROKER_ITEM_TYPES[number]['value'];

export type BrokerPpnTreatment = 'none' | 'excluded' | 'included';

export interface BrokerItem {
  type: BrokerItemType;
  description: string;
  amount: number;
  // Present on every line created or edited by the corrected calculation
  // engine. Unmarked rows are historical and may use the legacy empty-amount
  // compatibility fallback.
  invoice_amount_authoritative?: boolean;
  // ── Optional multi-supplier / PPN fields (added 2026-07-03) ──
  // NOTE: this per-line supplier_id is used ONLY for tax-invoice display and the
  // PPN register (vw_input_ppn_report Branch 5). It NEVER replaces or overrides
  // finance_expenses.supplier_id (the main invoice supplier used by AP, Aging,
  // Supplier Ledger, Expense Listing, Trial Balance, etc).
  supplier_id?: string | null;
  invoice_number?: string | null;
  invoice_date?: string | null;
  // Faktur Pajak (Indonesian tax invoice) number — separate from commercial
  // invoice_number since a supplier's tax invoice # differs from their
  // commercial invoice #. Both are captured for the Input PPN report.
  tax_invoice_number?: string | null;
  ppn_treatment?: BrokerPpnTreatment;
  ppn_amount?: number;
  // ── Indonesian tax invoice fields (added 2026-07-07) ──
  // dpp_amount   = Dasar Pengenaan Pajak (taxable base). If NULL, treated as
  //                = line.amount for legacy rows.
  // ppn_rate     = tax rate as percentage (0, 11, 12, custom). NULL for legacy.
  // Line PPN Amount = round(dpp_amount * ppn_rate / 100) unless manually overridden.
  dpp_amount?: number;
  ppn_rate?: number;
  npwp?: string | null;
  container_reference?: string | null;
  attachment_path?: string | null;
}

/** For an amount that ALREADY includes 11% PPN, return {dpp, ppn}. */
export function extractPpnFromInclusive(amountInclusive: number): { dpp: number; ppn: number } {
  const dpp = Math.round(amountInclusive / 1.11);
  return { dpp, ppn: amountInclusive - dpp };
}

/** Compute per-line PPN based on treatment (excluded/included/none). */
export function computeBrokerLinePpn(
  amount: number,
  treatment: BrokerPpnTreatment | undefined,
): number {
  if (!amount || amount <= 0) return 0;
  if (treatment === 'excluded') return Math.round(amount * 0.11);
  if (treatment === 'included') return extractPpnFromInclusive(amount).ppn;
  return 0;
}

/** Returns the sum of all broker item amounts. */
export function sumBrokerItems(items: BrokerItem[]): number {
  return items.reduce((sum, item) => sum + (item.amount || 0), 0);
}

/**
 * The broker invoice calculation is intentionally separate from the generic
 * finance_expenses total. Broker invoices contain an independent header
 * invoice plus pass-through reimbursement lines.
 */
export interface BrokerExpenseTotalsInput {
  amount?: number | null;
  dpp_amount?: number | null;
  ppn_amount?: number | null;
  pph_amount?: number | null;
  stamp_duty_amount?: number | null;
  broker_items?: BrokerItem[] | null;
}

export interface BrokerExpenseTotals {
  brokerInvoiceAmount: number;
  brokerInvoiceDpp: number;
  reimbursementTotal: number;
  reimbursementDpp: number;
  reimbursementPpn: number;
  totalPpn: number;
  recoverableInputPpn: number;
  pphWithheld: number;
  pph23Withheld: number;
  stampDuty: number;
  accountingExpenseTotal: number;
  expenseTotal: number;
  finalCashPayable: number;
  totalPayable: number;
}

/**
 * Actual reimbursement payable used by every broker presentation/AP view.
 *
 * Invoice Amount is authoritative. DPP and PPN are independent tax-reporting
 * values and must never be added to a populated Invoice Amount. The fallback
 * preserves historical rows created before Invoice Amount became mandatory.
 */
export function brokerLineTotal(item: BrokerItem): number {
  const amount = Number(item.amount) || 0;
  const dpp = Number(item.dpp_amount) || 0;
  const ppn = Number(item.ppn_amount) || 0;
  if (item.invoice_amount_authoritative === true) return amount;
  return amount !== 0 ? amount : dpp + ppn;
}

/** Expense base for a reimbursement line; recoverable PPN is never expensed. */
export function brokerLineExpenseBase(item: BrokerItem): number {
  return brokerLineTotal(item) - (Number(item.ppn_amount) || 0);
}

export function calculateBrokerReimbursementTotal(items: BrokerItem[] | null | undefined): number {
  return (Array.isArray(items) ? items : []).reduce((sum, item) => sum + brokerLineTotal(item), 0);
}

export function calculateBrokerExpenseTotals(exp: BrokerExpenseTotalsInput): BrokerExpenseTotals {
  const items = Array.isArray(exp.broker_items) ? exp.broker_items : [];
  const brokerInvoiceAmount = Number(exp.amount) || 0;
  const brokerInvoiceDpp = Number(exp.dpp_amount) || 0;
  const reimbursementTotal = calculateBrokerReimbursementTotal(items);
  const reimbursementDpp = items.reduce((sum, item) => sum + (Number(item.dpp_amount) || 0), 0);
  const reimbursementPpn = items.reduce((sum, item) => sum + (Number(item.ppn_amount) || 0), 0);
  const headerPpn = Number(exp.ppn_amount) || 0;
  const totalPpn = headerPpn + reimbursementPpn;
  const pphWithheld = Number(exp.pph_amount) || 0;
  const stampDuty = Number(exp.stamp_duty_amount) || 0;
  const accountingExpenseTotal = brokerInvoiceAmount - headerPpn
    + items.reduce((sum, item) => sum + brokerLineExpenseBase(item), 0)
    + stampDuty;
  const expenseTotal = brokerInvoiceAmount + reimbursementTotal + stampDuty;
  // Invoice Amount already represents the supplier payable. DPP and PPN are
  // reporting values only and never increase the cash target.
  const finalCashPayable = expenseTotal - pphWithheld;

  return {
    brokerInvoiceAmount,
    brokerInvoiceDpp,
    reimbursementTotal,
    reimbursementDpp,
    reimbursementPpn,
    totalPpn,
    recoverableInputPpn: totalPpn,
    pphWithheld,
    pph23Withheld: pphWithheld,
    stampDuty,
    accountingExpenseTotal,
    expenseTotal,
    finalCashPayable,
    totalPayable: finalCashPayable,
  };
}

// ---------------------------------------------------------------------------
// Tax calculations
// ---------------------------------------------------------------------------

/** Indonesian PPN (VAT) — 11% on DPP (taxable base). Returns 0 if not PKP. */
export function calculatePPN(
  dppAmount: number,
  isSupplierPKP: boolean,
  rate = 11,
): number {
  if (!isSupplierPKP || dppAmount <= 0) return 0;
  // Round to nearest rupiah
  return Math.round(dppAmount * rate / 100);
}

/**
 * PPh amount calculation.
 * rate is the withholding rate as a percentage (e.g. 2 for PPh 23 at 2%).
 * DPP for PPh 23 = gross expense (before PPN) = `amount`.
 */
export function calculatePPh(
  dppAmount: number,
  ratePercent: number,
): number {
  if (dppAmount <= 0 || ratePercent <= 0) return 0;
  return Math.round(dppAmount * ratePercent / 100);
}

// ---------------------------------------------------------------------------
// Expense totals — single source of truth
// ---------------------------------------------------------------------------
// This is the ONLY place the "net payable" formula for a finance_expenses row
// is defined on the client. Every screen (Expense form, Payment Voucher, Bank
// Reconciliation, Payables, Party Ledger) must call this so the numbers stay
// consistent across the ERP.
//
// The formula mirrors the DB trigger auto_post_expense_accounting
// (supabase/migrations/20260721123642_...sql line 222-226) which is the
// authoritative posting engine. Do not diverge from that formula.
//
//   net_payable = amount + ppn − pph + stamp_duty + bank_charges
//
// bank_charges_amount is an additional cash component whenever it is present
// on a paid expense. The journal/payment workflow is authoritative for whether
// a charge was actually posted; the display must not omit it based on a stale
// or legacy category label.

/** Input shape — accepts any object with finance_expenses-style fields. */
export interface ExpenseTotalsInput {
  amount?: number | null;
  ppn_amount?: number | null;
  pph_amount?: number | null;
  stamp_duty_amount?: number | null;
  bank_charges_amount?: number | null;
  expense_category?: string | null;
}

export interface ExpenseTotals {
  amount: number;
  ppnAmount: number;
  pphAmount: number;
  stampDutyAmount: number;
  /** Additional bank charges included in the actual cash payment. */
  bankChargesAmount: number;
  /** Supplier/employee payable before bank-owned charges. */
  netPayable: number;
  /** Actual bank movement: net payable plus bank-owned charges. */
  settlementAmount: number;
}

/**
 * Returns the canonical financial totals for a finance_expenses row.
 * Every displayed "total payable" in the ERP should come from here.
 */
export function calculateExpenseTotals(exp: ExpenseTotalsInput): ExpenseTotals {
  const amount = Number(exp.amount) || 0;
  const ppn = Number(exp.ppn_amount) || 0;
  const pph = Number(exp.pph_amount) || 0;
  const stamp = Number(exp.stamp_duty_amount) || 0;
  const rawBank = Number(exp.bank_charges_amount) || 0;
  const bank = rawBank;
  return {
    amount,
    ppnAmount: ppn,
    pphAmount: pph,
    stampDutyAmount: stamp,
    bankChargesAmount: bank,
    netPayable: amount + ppn - pph + stamp + bank,
    settlementAmount: amount + ppn - pph + stamp + bank,
  };
}

/**
 * Canonical expense value for expense-facing screens.
 * Customs broker rows use the derived expense total; all other rows retain
 * their normal expense amount. Broker invoice amount is a breakdown value,
 * never the main expense-list amount.
 */
export function calculateCanonicalExpenseTotal(
  exp: ExpenseTotalsInput & BrokerExpenseTotalsInput,
): number {
  if (exp.expense_category === 'import_broker') {
    return calculateBrokerExpenseTotals(exp).accountingExpenseTotal;
  }
  return Number(exp.amount) || 0;
}

/** Cash target used by payment status and settlement displays. */
export function calculateCanonicalCashPayable(
  exp: ExpenseTotalsInput & BrokerExpenseTotalsInput,
): number {
  if (exp.expense_category === 'import_broker') {
    return calculateBrokerExpenseTotals(exp).finalCashPayable;
  }
  return calculateExpenseTotals(exp).settlementAmount;
}

/**
 * Read-only warning for reconciliation screens. Dates are business dates
 * (YYYY-MM-DD), so parsing them as UTC avoids timezone shifts at midnight.
 */
export function paymentDateGapWarning(
  bankDate?: string | null,
  voucherDate?: string | null,
  thresholdDays = 3,
): string | null {
  if (!bankDate || !voucherDate) return null;
  const toDay = (value: string) => {
    const match = value.slice(0, 10).match(/^(\d{4})-(\d{2})-(\d{2})$/);
    return match ? Date.UTC(Number(match[1]), Number(match[2]) - 1, Number(match[3])) : NaN;
  };
  const bankDay = toDay(bankDate);
  const voucherDay = toDay(voucherDate);
  if (!Number.isFinite(bankDay) || !Number.isFinite(voucherDay)) return null;
  const days = Math.abs(bankDay - voucherDay) / 86_400_000;
  return days > thresholdDays
    ? 'Payment date differs from voucher date by more than 3 days. Please verify the transaction date.'
    : null;
}

/** Input for outstanding calculation — same as totals plus paid_amount. */
export interface OutstandingInput extends ExpenseTotalsInput {
  paid_amount?: number | null;
}

export interface Outstanding {
  netPayable: number;
  paidAmount: number;
  /** max(0, netPayable − paidAmount). */
  outstandingAmount: number;
  isFullyPaid: boolean;
}

/**
 * Returns the outstanding balance for an expense.
 * Kept separate from calculateExpenseTotals() because outstanding depends on
 * payment state (paid_amount) while totals depend only on the expense itself.
 */
export function calculateOutstanding(exp: OutstandingInput): Outstanding {
  const { settlementAmount: netPayable } = calculateExpenseTotals(exp);
  const paid = Number(exp.paid_amount) || 0;
  const outstanding = Math.max(0, netPayable - paid);
  return {
    netPayable,
    paidAmount: paid,
    outstandingAmount: outstanding,
    isFullyPaid: outstanding === 0 && netPayable > 0,
  };
}

// ---------------------------------------------------------------------------
// Date utilities
// ---------------------------------------------------------------------------

/**
 * Computes a due date given an invoice/expense date and payment terms in days.
 * Returns ISO date string (YYYY-MM-DD) or '' if inputs are invalid.
 */
export function getDueDateFromTerms(
  invoiceDate: string,
  paymentTermsDays: number | null | undefined,
): string {
  if (!invoiceDate || !paymentTermsDays || paymentTermsDays <= 0) return '';
  const d = new Date(invoiceDate);
  if (isNaN(d.getTime())) return '';
  d.setDate(d.getDate() + paymentTermsDays);
  return d.toISOString().split('T')[0];
}

// ---------------------------------------------------------------------------
// Display helpers
// ---------------------------------------------------------------------------

/** Formats an IDR amount as a human-readable string, e.g. "Rp 1.500.000". */
export function formatIDR(amount: number | null | undefined): string {
  if (amount == null) return 'Rp 0';
  return 'Rp ' + Math.round(amount).toLocaleString('id-ID');
}

/** Returns a human-readable label for an expense_category slug. */
export function categoryLabel(category: string): string {
  return category
    .replace(/_/g, ' ')
    .replace(/\b\w/g, (c) => c.toUpperCase());
}

// ---------------------------------------------------------------------------
// Supplier Types — drives Quick Add defaults and Supplier Master categorisation
// ---------------------------------------------------------------------------

export interface SupplierTypeConfig {
  readonly value: string;
  readonly label: string;
  readonly taxPreference: 'none' | 'ppn_only' | 'ppn_pph' | 'pph_only';
  readonly defaultCategory: string;
  readonly defaultDocType: DocumentType;
  readonly paymentTerms: number;
}

export const SUPPLIER_TYPES: readonly SupplierTypeConfig[] = [
  { value: 'Import Broker',         label: 'Import / Customs Broker',    taxPreference: 'ppn_pph',   defaultCategory: 'import_broker',        defaultDocType: 'Import / Customs Broker Invoice', paymentTerms: 30 },
  { value: 'Utility',               label: 'Utility Provider',           taxPreference: 'ppn_only',  defaultCategory: 'utilities',            defaultDocType: 'Utility',                         paymentTerms: 15 },
  { value: 'Transport',             label: 'Transport / Freight',        taxPreference: 'none',      defaultCategory: 'transport_import',     defaultDocType: 'Import / Customs Broker Invoice', paymentTerms: 14 },
  { value: 'Employee',              label: 'Employee / Staff',           taxPreference: 'pph_only',  defaultCategory: 'salary',               defaultDocType: 'Staff Expense',                   paymentTerms: 0  },
  { value: 'Non-Permanent Individual', label: 'Freelancer / Casual Worker / Honorarium', taxPreference: 'pph_only', defaultCategory: 'non_permanent_employee_fee', defaultDocType: 'Staff Expense', paymentTerms: 0 },
  { value: 'Government',            label: 'Government Agency',          taxPreference: 'none',      defaultCategory: 'duty_customs',         defaultDocType: 'PIB',                             paymentTerms: 0  },
  { value: 'Professional Services', label: 'Professional Services',      taxPreference: 'ppn_pph',   defaultCategory: 'professional_services', defaultDocType: 'Professional Services',          paymentTerms: 14 },
  { value: 'General',              label: 'General Supplier',           taxPreference: 'none',      defaultCategory: 'other',                defaultDocType: 'Operating Expense',               paymentTerms: 30 },
] as const;
export const EXPENSE_CATEGORY_LABELS: Record<string, string> = {
  duty_customs:               'Import Duty / Bea Masuk',
  ppn_import:                 'PPN Import (PIB only)',
  pph_import:                 'PPh 22 Import (PIB only)',
  freight_import:             'Freight Import',
  clearing_forwarding:        'Clearing & Forwarding',
  port_charges:               'Port Charges',
  container_handling:         'Container Handling',
  transport_import:           'Transport Import',
  loading_import:             'Loading Import',
  bpom_ski_fees:              'BPOM / SKI Fees',
  other_import:               'Other Import Cost',
  pib_import:                 'PIB (Import Declaration)',
  import_broker:              'Customs Broker Invoice',
  delivery_sales:             'Delivery / Sales Dist.',
  loading_sales:              'Loading (Sales)',
  other_sales:                'Other Sales Cost',
  salary:                     'Salary / Gaji',
  staff_overtime:             'Staff Overtime',
  staff_welfare:              'Staff Welfare / Kesejahteraan',
  non_permanent_employee_fee: 'Non-Permanent Employee Fee (PPh 21)',
  travel_conveyance:          'Travel & Conveyance',
  warehouse_rent:             'Warehouse Rent / Sewa Gudang',
  utilities:                  'Utilities (Listrik, Air, dll)',
  bank_charges:               'Bank Charges',
  office_admin:               'Office Administration',
  office_shifting_renovation: 'Office Shifting / Renovation',
  duty:                       'Duty / Bea',
  freight:                    'Freight',
  office:                     'Office Expense',
  other:                      'Other / Lainnya',
  fixed_asset:                'Fixed Asset Purchase',
  professional_services:      'Professional Services / Jasa Profesi',
};
