import { useEffect, useMemo, useState } from 'react';
import { supabase } from '../../lib/supabase';
import { Plus, Package, Truck, Pencil as Edit, Trash2, FileText, X, Download, Eye, CheckCircle, XCircle, Clipboard, ClipboardCheck, Lock, RotateCcw, UserPlus, AlertCircle, Banknote, Link2, Search } from 'lucide-react';
import { FinanceModal as Modal } from './FinanceModal';
import { MoneyInput } from '../MoneyInput';
import { SearchableSelect } from '../SearchableSelect';
import { FinanceModal } from './FinanceModal';
import { F_BTN_PRIMARY, F_BTN_SECONDARY } from './FinanceForm';
import { FinanceActionButton } from './FinanceUI';
import { getCategoryFieldRules } from './categoryFieldRules';
import { SapRow, SapField, SAP_INPUT } from './SapLayout';
import { useExpenseCategories } from './useExpenseCategories';
import { BankTransactionLinkField } from './BankTransactionLinkField';
import {
  approveFinanceExpense,
  editApprovedFinanceExpense,
  getReportingUsdRate,
  saveAndLinkFinanceExpense,
  saveFinanceExpense,
  unlinkFinanceExpenseBankLink,
} from '../../services/financeCommands';
import {
  getEffectiveExpensePostingState,
  getEffectiveExpensePostingStates,
  type EffectiveExpensePostingState,
  type ExpensePostingState,
} from '../../services/expensePostingLifecycle';
import {
  FINANCE_RECONCILIATION_REFRESH_EVENT,
  notifyFinanceReconciliationRefresh,
  unlinkBankTransaction,
} from './bankTransactionLinking';
import { FinanceDocumentAttachments, uploadFinanceDocuments } from './FinanceDocumentAttachments';
import { getPostedJournalsForExport, writeReconciliationWorkbook, type ReconciliationSummaryRow } from './reconciliationExport';
import { ExpenseCategorySelect, groupExpenseCategories } from './ExpenseCategorySelect';

// Tiny inline helper used inside the SAP header PPN cell — a 3-state
// selector rendered as a right-side chip so it doesn't consume a column.
function PpnModeToggle({ value, onChange }: {
  value: 'standard' | 'dpp_nilai_lain' | 'manual' | undefined;
  onChange: (mode: 'standard' | 'dpp_nilai_lain' | 'manual') => void;
}) {
  return (
    <select
      value={value || 'standard'}
      onChange={(e) => onChange(e.target.value as 'standard' | 'dpp_nilai_lain' | 'manual')}
      title="PPN calculation mode"
      className="h-6 px-1 text-[9px] font-semibold border border-gray-200 bg-white rounded-none"
    >
      <option value="standard">STD</option>
      <option value="dpp_nilai_lain">DPP</option>
      <option value="manual">MAN</option>
    </select>
  );
}

// Broker Invoice PPN % selector — Indonesian tax practice: 0 / 11 / 12 / Custom.
// - 0/11/12: PPN Amount is auto-calculated from Invoice DPP × rate (read-only).
// - Custom: user types both rate (optional) and PPN Amount manually.
function BrokerPpnRateSelector({ rate, isCustom, onChange }: {
  rate: number;
  isCustom: boolean;
  onChange: (v: { rate: number; custom: boolean }) => void;
}) {
  // Preset only reflects the selector when NOT in Custom mode and the rate is a known preset.
  const preset: string = isCustom ? 'custom'
    : rate === 0 ? '0'
    : rate === 11 ? '11'
    : rate === 12 ? '12'
    : 'custom';
  return (
    <div className="flex items-center gap-1 w-full">
      <select
        value={preset}
        onChange={(e) => {
          const v = e.target.value;
          if (v === 'custom')      onChange({ rate: rate || 0, custom: true });
          else if (v === '0')      onChange({ rate: 0,  custom: false });
          else if (v === '11')     onChange({ rate: 11, custom: false });
          else if (v === '12')     onChange({ rate: 12, custom: false });
        }}
        className={SAP_INPUT + ' !flex-none !w-20'}
        title="PPN rate — 0 / 11 / 12 / Custom"
      >
        <option value="0">0%</option>
        <option value="11">11%</option>
        <option value="12">12%</option>
        <option value="custom">Custom</option>
      </select>
      {isCustom && (
        <input
          type="number" min="0" max="100" step="0.5"
          value={rate === 0 ? '' : rate}
          onChange={(e) => {
            const r = e.target.value === '' ? 0 : parseFloat(e.target.value) || 0;
            onChange({ rate: r, custom: true });
          }}
          className={SAP_INPUT + ' !flex-1 !text-right !font-mono'}
          placeholder="Custom %"
        />
      )}
    </div>
  );
}
import { useFinance } from '../../contexts/FinanceContext';
import { useAuth } from '../../contexts/AuthContext';
import { useLanguage } from '../../contexts/LanguageContext';
import { downloadStorageDocument, openStorageDocument, resolveStorageUrlCached } from '../../utils/signedUrlCache';
import { currentFinancePeriod, formatFinancePeriodValue, normalizeSalaryPeriod, salaryPeriodOptions } from '../../utils/financePeriod';
import { supabaseErrorMessage } from '../../utils/supabaseError';
import { formatCurrency, normalizeCurrency, resolveTransactionCurrency } from '../../utils/currency';
import { useSupabaseRealtimeChannel } from '../../hooks/useSupabaseRealtimeChannel';
import {
  DOCUMENT_TYPE_GROUPS,
  DOCUMENT_TYPE_TAX_CONFIG,
  SUPPLIER_TYPES,
  type BrokerItem,
  type DocumentType,
  calculatePPN,
  calculateExpenseTotals,
  calculateCanonicalExpenseTotal,
  calculateCanonicalCashPayable,
  calculateBrokerExpenseTotals,
  brokerLineTotal,
  computeBrokerLinePpn,
  getDueDateFromTerms,
} from '../../utils/taxCalculations';

const SALARY_PERIOD_OPTIONS = salaryPeriodOptions();

interface FinanceExpense {
  id: string;
  expense_category: string;
  amount: number;
  expense_date: string;
  description: string | null;
  batch_id: string | null;
  import_container_id: string | null;
  delivery_challan_id: string | null;
  expense_type: string | null;
  document_urls: string[] | null;
  payment_method: string | null;
  bank_account_id: string | null;
  payment_reference: string | null;
  voucher_number: string | null;
  currency_code?: string | null;
  transaction_currency?: string | null;
  functional_currency?: string | null;
  exchange_rate?: number | null;
  bank_account_currency?: string | null;
  payment_currency?: string | null;
  approval_status: 'pending_approval' | 'approved' | 'rejected';
  approved_by: string | null;
  approved_at: string | null;
  rejection_reason: string | null;
  created_at: string;
  // New supplier invoice fields
  supplier_id?: string | null;
  staff_id?: string | null;
  invoice_number?: string | null;
  due_date?: string | null;
  paid_amount?: number | null;
  broker_items?: BrokerItem[] | null;
  // PIB Import breakdown columns (non-null only when expense_category = 'pib_import')
  pib_bm_amount?: number | null;
  pib_ppn_amount?: number | null;
  pib_pph_amount?: number | null;
  // Tax fields for non-PIB expenses
  ppn_amount?: number | null;
  ppn_manual_override?: boolean | null;
  ppn_calc_mode?: 'standard' | 'dpp_nilai_lain' | 'manual' | null;
  dpp_amount?: number | null;
  ppn_rate?: number | null;
  pph_amount?: number | null;
  pph_code_id?: string | null;
  stamp_duty_amount?: number | null;
  fixed_asset_account_id?: string | null;
  // Utility-only optional bank charges
  bank_charges_amount?: number | null;
  batches?: { batch_number: string } | null;
  import_containers?: { container_ref: string } | null;
  delivery_challans?: { challan_number: string } | null;
  bank_accounts?: { bank_name: string; account_number: string; alias: string | null; currency: string } | null;
  bank_statement_lines?: Array<{
    id: string;
    transaction_date: string;
    description: string | null;
    debit_amount: number;
    credit_amount: number;
    bank_account_id: string;
    payment_kind?: string | null;
    allocation_amount?: number | null;
    allocation_id?: string | null;
    bank_accounts?: { bank_name: string; account_number: string; alias: string | null; currency: string } | null;
  }> | null;
  pph_paid_amount?: number | null;
  voucher_allocations?: Array<{
    id: string;
    allocated_amount: number;
    payment_kind?: string | null;
    payment_vouchers?: { voucher_number: string; payment_date: string } | null;
  }> | null;
  suppliers?: { id: string; company_name: string } | null;
  posting_lifecycle?: EffectiveExpensePostingState | null;
  effective_posting_state?: ExpensePostingState;
}

const getExpenseCurrency = (expense: FinanceExpense): string =>
  resolveTransactionCurrency({
    ...expense,
    bank_accounts: expense.bank_accounts
      ?? expense.bank_statement_lines?.[0]?.bank_accounts,
  });

async function hydrateExpensePostingLifecycle<T extends FinanceExpense>(expenses: T[]): Promise<T[]> {
  const states = await getEffectiveExpensePostingStates(expenses.map(expense => expense.id));
  return expenses.map(expense => {
    const lifecycle = states.get(expense.id) || null;
    return {
      ...expense,
      posting_lifecycle: lifecycle,
      effective_posting_state: lifecycle?.effective_posting_state || 'AMBIGUOUS',
    };
  });
}

const SETTLED_EXPENSE_CANCELLATION_MESSAGE =
  'This expense is already paid/reconciled. Reverse or unlink the payment/bank reconciliation first.';

type ExpenseCancellationBlock = {
  kind: 'settled' | 'closed_period' | 'already_reversed' | 'no_active_journal' | 'not_approved' | 'verification_failed';
  message: string;
  bankStatementLineId?: string;
  paymentVoucherId?: string;
};

type ExpenseCancellationPreflight = {
  block: ExpenseCancellationBlock | null;
};

async function preflightExpenseCancellation(expenseId: string): Promise<ExpenseCancellationPreflight> {
  const lifecycle = await getEffectiveExpensePostingState(expenseId);
  if (!lifecycle) {
    return { block: { kind: 'verification_failed', message: 'Unable to resolve the effective accounting state for this expense.' } };
  }
  if (lifecycle.effective_posting_state === 'REVERSED' || lifecycle.effective_posting_state === 'REPLACED') {
    return {
      block: {
        kind: 'already_reversed',
        message: lifecycle.effective_posting_state === 'REPLACED'
          ? 'This expense already has a current effective posting. Refresh and work with the current transaction; the obsolete posting cannot be cancelled.'
          : 'This expense is already cancelled. It cannot be cancelled again.',
      },
    };
  }
  if (lifecycle.effective_posting_state !== 'ACTIVE') {
    return {
      block: {
        kind: lifecycle.effective_posting_state === 'REJECTED' || lifecycle.effective_posting_state === 'PENDING'
          ? 'not_approved'
          : 'verification_failed',
        message: lifecycle.effective_posting_state === 'AMBIGUOUS'
          ? `This expense has inconsistent posting evidence (${lifecycle.ambiguity_reason || 'manual review required'}). Cancellation was not sent.`
          : 'This expense has no active posting to cancel.',
      },
    };
  }

  const [expenseResult, journalResult, voucherResult, expenseAllocationResult, legacyBankResult] = await Promise.all([
    supabase
      .from('finance_expenses')
      .select('id, voucher_number, approval_status, paid_amount, pph_paid_amount')
      .eq('id', expenseId)
      .maybeSingle(),
    supabase
      .from('journal_entries')
      .select('id, entry_date, is_posted, is_reversed, created_at')
      .in('source_module', ['expense', 'expenses'])
      .or(`reference_id.eq.${expenseId},reference_number.eq.EXP-${expenseId}`)
      .eq('is_posted', true)
      .order('created_at', { ascending: false }),
    supabase
      .from('voucher_allocations')
      .select('id, payment_voucher_id')
      .eq('finance_expense_id', expenseId)
      .limit(1),
    supabase
      .from('bank_statement_allocations')
      .select('id, bank_statement_line_id')
      .eq('document_type', 'expense')
      .eq('document_id', expenseId)
      .limit(1),
    supabase
      .from('bank_statement_lines')
      .select('id')
      .eq('matched_expense_id', expenseId)
      .limit(1),
  ]);

  const firstError = [expenseResult, journalResult, voucherResult, expenseAllocationResult, legacyBankResult]
    .find(result => result.error)?.error;
  if (firstError) throw firstError;

  const expense = expenseResult.data;
  if (!expense) {
    return { block: { kind: 'verification_failed', message: 'Unable to verify this expense because it no longer exists.' } };
  }
  if (expense.approval_status !== 'approved') {
    return { block: { kind: 'not_approved', message: 'This expense is not currently posted, so there is no posting to cancel.' } };
  }

  const journals = journalResult.data || [];
  const activeJournal = journals.find(journal => journal.id === lifecycle.effective_journal_id && !journal.is_reversed);
  if (!activeJournal) {
    const alreadyReversed = journals.some(journal => journal.is_reversed);
    return {
      block: {
        kind: alreadyReversed ? 'already_reversed' : 'no_active_journal',
        message: alreadyReversed
          ? 'This expense posting has already been reversed.'
          : 'No active journal exists for this expense. Cancellation cannot continue.',
      },
    };
  }

  const [journalAllocationResult, reconciliationResult, periodResult] = await Promise.all([
    supabase
      .from('bank_statement_allocations')
      .select('id, bank_statement_line_id')
      .eq('journal_entry_id', activeJournal.id)
      .limit(1),
    supabase
      .from('bank_reconciliation_items')
      .select('id')
      .eq('journal_entry_id', activeJournal.id)
      .limit(1),
    supabase
      .from('accounting_periods')
      .select('status')
      .lte('start_date', activeJournal.entry_date)
      .gte('end_date', activeJournal.entry_date)
      .order('start_date', { ascending: false })
      .limit(1),
  ]);
  const dependentError = [journalAllocationResult, reconciliationResult, periodResult]
    .find(result => result.error)?.error;
  if (dependentError) throw dependentError;

  const voucherAllocation = voucherResult.data?.[0];
  const expenseAllocation = expenseAllocationResult.data?.[0];
  const journalAllocation = journalAllocationResult.data?.[0];
  const legacyBankLine = legacyBankResult.data?.[0];
  const isSettled = Number(expense.paid_amount || 0) > 0.01
    || Number(expense.pph_paid_amount || 0) > 0.01
    || Boolean(voucherAllocation)
    || Boolean(expenseAllocation)
    || Boolean(journalAllocation)
    || Boolean(legacyBankLine)
    || Boolean(reconciliationResult.data?.length);
  if (isSettled) {
    return {
      block: {
        kind: 'settled',
        message: SETTLED_EXPENSE_CANCELLATION_MESSAGE,
        bankStatementLineId: expenseAllocation?.bank_statement_line_id
          || journalAllocation?.bank_statement_line_id
          || legacyBankLine?.id,
        paymentVoucherId: voucherAllocation?.payment_voucher_id || undefined,
      },
    };
  }

  const period = periodResult.data?.[0];
  if (period && period.status !== 'open') {
    return {
      block: {
        kind: 'closed_period',
        message: 'This expense is in a closed accounting period. Reopen the period before cancelling its posting.',
      },
    };
  }
  return { block: null };
}

interface Supplier {
  id: string;
  company_name: string;
  pkp_status: boolean;
  payment_terms_days: number | null;
  default_expense_category: string | null;
  default_pph_code_id: string | null;
  tax_preference: 'none' | 'ppn_only' | 'ppn_pph' | 'pph_only' | null;
  supplier_type?: string | null;
}

interface Batch {
  id: string;
  batch_number: string;
}

interface ImportContainer {
  id: string;
  container_ref: string;
}

interface DeliveryChallan {
  id: string;
  challan_number: string;
  challan_date: string;
  customers?: {
    company_name: string;
  } | null;
}

interface BankAccount {
  id: string;
  bank_name: string;
  account_number: string;
  alias: string | null;
  currency: string;
}

interface TaxCode {
  id: string;
  code: string;
  name: string;
  rate: number;
  tax_type: string;
}

interface COAAccount {
  id: string;
  code: string;
  name: string;
}

interface ExpenseExportAccount {
  expense_id: string;
  coa_code: string | null;
  coa_name: string | null;
}

interface ExpenseManagerProps {
  canManage: boolean;
  initialViewExpenseId?: string | null;
  onInitialViewHandled?: () => void;
  onSettleBill?: (bill: { id: string; supplier_id: string | null; staff_id: string | null; balance_amount: number }) => void;
  onViewPaymentVoucher?: (paymentVoucherId: string) => void;
}

export function ExpenseManager({ canManage, initialViewExpenseId, onInitialViewHandled, onSettleBill, onViewPaymentVoucher }: ExpenseManagerProps) {
  const { profile } = useAuth();
  const { t } = useLanguage();
  const isAdmin = profile?.role === 'admin';
  // The database Expense Category master is the selector and posting source.
  // A newly-created active master row is available here without a deploy.
  const { categories: expenseCategories } = useExpenseCategories();
  const [rejectionModalOpen, setRejectionModalOpen] = useState(false);
  const [rejectionTarget, setRejectionTarget] = useState<{ id: string; type: 'expense' } | null>(null);
  const [rejectionReason, setRejectionReason] = useState('');
  const [approvalLoading, setApprovalLoading] = useState<string | null>(null);
  const [cancelPostingModalOpen, setCancelPostingModalOpen] = useState(false);
  const [cancelPostingTarget, setCancelPostingTarget] = useState<FinanceExpense | null>(null);
  const [cancelPostingReason, setCancelPostingReason] = useState('');
  const [cancelPostingLoading, setCancelPostingLoading] = useState(false);
  const [cancelPostingBlock, setCancelPostingBlock] = useState<ExpenseCancellationBlock | null>(null);
  const [expenses, setExpenses] = useState<FinanceExpense[]>([]);
  const [, setBatches] = useState<Batch[]>([]);
  const [containers, setContainers] = useState<ImportContainer[]>([]);
  const [challans, setChallans] = useState<DeliveryChallan[]>([]);
  const [bankAccounts, setBankAccounts] = useState<BankAccount[]>([]);
  const [reconciledExpenseIds, setReconciledExpenseIds] = useState<Set<string>>(new Set());
  const [selectedBankTransactionId, setSelectedBankTransactionId] = useState<string>('');
  const [selectedBankAllocationAmount, setSelectedBankAllocationAmount] = useState<number | undefined>();
  const [loading, setLoading] = useState(true);
  const [modalOpen, setModalOpen] = useState(false);
  const [editingExpense, setEditingExpense] = useState<FinanceExpense | null>(null);
  const [viewingExpense, setViewingExpense] = useState<FinanceExpense | null>(null);
  const [salaryAdvanceApplications, setSalaryAdvanceApplications] = useState<Array<{
    application_id: string;
    advance_payment_voucher_id: string;
    advance_voucher_number: string | null;
    settlement_payment_voucher_id: string;
    settlement_voucher_number: string | null;
    applied_amount: number;
    applied_at: string;
  }>>([]);
  const [viewModalOpen, setViewModalOpen] = useState(false);
  const [linkedDCQuickView, setLinkedDCQuickView] = useState<{ challan: any; items: any[] } | null>(null);
  const [linkedDCQuickViewLoading, setLinkedDCQuickViewLoading] = useState(false);
  const [accountingExpanded, setAccountingExpanded] = useState(false);
  const [signedUrlCache, setSignedUrlCache] = useState<Record<string, string>>({});
  const [filterType, setFilterType] = useState<'all' | 'import' | 'sales' | 'staff' | 'operations' | 'admin'>('all');
  const [reconFilter, setReconFilter] = useState<'all' | 'reconciled' | 'not_reconciled'>('all');
  const [approvalFilter, setApprovalFilter] = useState<'all' | 'approved' | 'pending_approval'>('all');
  const [categoryFilter, setCategoryFilter] = useState<string>('all');
  const [searchQuery, setSearchQuery] = useState('');
  const [uploadingFiles, setUploadingFiles] = useState<File[]>([]);
  const [sortConfig, setSortConfig] = useState<{ key: string; direction: 'asc' | 'desc' } | null>(null);
  const [taxCodes, setTaxCodes] = useState<TaxCode[]>([]);
  const [coaAssets, setCoaAssets] = useState<COAAccount[]>([]);
  // Supplier state
  const [suppliers, setSuppliers] = useState<Supplier[]>([]);
  const [selectedSupplier, setSelectedSupplier] = useState<Supplier | null>(null);
  const [selectedDocType, setSelectedDocType] = useState<DocumentType | ''>('');
  const [brokerItems, setBrokerItems] = useState<BrokerItem[]>([]);
  // Category-driven pickers (2026-07-08) — Staff Master + Utility Master.
  // These are pure UI selectors; the underlying finance_expenses.supplier_id
  // column stays as-is (utilities resolve through the linked supplier;
  // staff rows leave supplier_id null and prefix the description with the
  // staff name for traceability).
  const [staffRoster, setStaffRoster] = useState<Array<{
    id: string;
    full_name: string;
    department: string | null;
    default_gl_code: string | null;
    monthly_salary: number;
  }>>([]);
  const [utilityRoster, setUtilityRoster] = useState<Array<{ id: string; provider_name: string; utility_type: string; supplier_id: string | null; default_gl_code: string | null }>>([]);
  const [selectedStaffId, setSelectedStaffId] = useState<string>('');
  const [salaryAdvances, setSalaryAdvances] = useState<Array<{
    advance_id: string;
    voucher_number: string;
    voucher_date: string;
    amount: number;
    applied_amount: number;
    available_amount: number;
  }>>([]);
  const [applySalaryAdvance, setApplySalaryAdvance] = useState(true);
  const [salaryCalculation, setSalaryCalculation] = useState<{
    gross_salary: number;
    outstanding_salary_advances: number;
    pph21_amount: number;
    bpjs_amount: number;
    net_salary_payable: number;
    pph21_method: 'percentage' | 'manual';
    pph21_applicable: boolean;
    default_payment_method: string;
  } | null>(null);
  // Applied advances are persisted settlement facts. They are not returned by
  // the outstanding-advance query, so retain their total while editing.
  const [persistedSalaryAdvanceApplied, setPersistedSalaryAdvanceApplied] = useState(0);
  const [selectedUtilityId, setSelectedUtilityId] = useState<string>('');
  const [periodLabel, setPeriodLabel] = useState<string>('');   // Salary Month / Billing Month
  const [supplierFilter, setSupplierFilter] = useState<string>('all');
  // Quick Add Supplier modal
  const [showQuickAddSupplier, setShowQuickAddSupplier] = useState(false);
  const [quickAddSupplierName, setQuickAddSupplierName] = useState('');
  const [quickAddSupplierLoading, setQuickAddSupplierLoading] = useState(false);
  const [quickAddSupplierType, setQuickAddSupplierType] = useState('General');
  const [quickAddSupplierPKP, setQuickAddSupplierPKP] = useState(false);
  const [quickAddSupplierTerms, setQuickAddSupplierTerms] = useState(30);
  // Health Check panel
  const [healthCheckOpen, setHealthCheckOpen] = useState(false);
  const [healthLoading, setHealthLoading] = useState(false);
  interface HealthIssue { key: string; label: string; count: number; severity: 'error' | 'warning' | 'info' }
  const [healthIssues, setHealthIssues] = useState<HealthIssue[]>([]);

  // Use master date range from Finance context
  const { dateRange } = useFinance();
  const startDate = dateRange.startDate;
  const endDate = dateRange.endDate;

  const [formData, setFormData] = useState({
    expense_category: 'other',
    amount: 0,
    transaction_currency: 'IDR' as 'IDR' | 'USD',
    exchange_rate: 1,
    expense_date: new Date().toISOString().split('T')[0],
    description: '',
    batch_id: '',
    import_container_id: '',
    delivery_challan_id: '',
    payment_method: 'bank_transfer' as string | null,
    bank_account_id: '',
    payment_reference: '',
    document_urls: [] as string[],
    // New supplier invoice fields
    supplier_id: '',
    invoice_number: '',
    due_date: getDueDateFromTerms(new Date().toISOString().split('T')[0], 30),
    // PIB Import breakdown (only used when expense_category = 'pib_import')
    pib_bm_amount: 0,
    pib_ppn_amount: 0,
    pib_pph_amount: 0,
    // Non-PIB tax fields
    ppn_amount: 0,
    // Task 2 (2026-07-06): TRUE once the user has manually edited ppn_amount.
    // Kept for backward compat — new logic below uses ppn_calc_mode instead.
    ppn_manual_override: false,
    // Indonesian PPN calc mode (2026-07-07): standard | dpp_nilai_lain | manual
    ppn_calc_mode: 'standard' as 'standard' | 'dpp_nilai_lain' | 'manual',
    dpp_amount: 0,
    ppn_rate: 11,
    pph_amount: 0,
    pph_code_id: '',
    stamp_duty_amount: 0,
    fixed_asset_account_id: '',
    // Task 5: Utility-only optional bank charges paid alongside the utility bill.
    bank_charges_amount: 0,
  });

  useEffect(() => {
    if (!linkedDCQuickView) return;

    const handleEscapeForLinkedDC = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        event.preventDefault();
        event.stopPropagation();
        setLinkedDCQuickView(null);
      }
    };

    document.addEventListener('keydown', handleEscapeForLinkedDC, true);
    return () => document.removeEventListener('keydown', handleEscapeForLinkedDC, true);
  }, [linkedDCQuickView]);

  useEffect(() => {
    if (!viewModalOpen) return;
    const handleEscape = (event: KeyboardEvent) => {
      if (event.key === 'Escape' && !linkedDCQuickView) {
        event.preventDefault();
        setViewModalOpen(false);
        setViewingExpense(null);
        setLinkedDCQuickView(null);
      }
    };
    document.addEventListener('keydown', handleEscape);
    return () => document.removeEventListener('keydown', handleEscape);
  }, [viewModalOpen, linkedDCQuickView]);

  const openLinkedDCQuickView = async () => {
    if (!viewingExpense?.delivery_challan_id) return;

    setLinkedDCQuickViewLoading(true);
    try {
      const { data: challan, error: challanError } = await supabase
        .from('delivery_challans')
        .select(`*, customers(company_name, address, city, phone, npwp, pharmacy_license, gst_vat_type)`)
        .eq('id', viewingExpense.delivery_challan_id)
        .maybeSingle();

      if (challanError) throw challanError;
      if (!challan) throw new Error('Linked delivery challan not found');

      const { data: items, error: itemsError } = await supabase
        .from('delivery_challan_items')
        .select(`*, products(product_name, product_code, unit), batches(batch_number)`)
        .eq('challan_id', challan.id);

      if (itemsError) throw itemsError;

      setLinkedDCQuickView({ challan, items: items || [] });
    } catch (error) {
      console.error('Error loading linked DC quick view:', error);
      alert('Failed to open Delivery Challan details');
    } finally {
      setLinkedDCQuickViewLoading(false);
    }
  };

  // Initial load + reload when date range changes (loadData itself has no server-side
  // date filter, so reload is only meaningful when other loaders depend on state,
  // but we preserve the original behavior).
  useEffect(() => {
    loadData();
  }, [dateRange]);

  useEffect(() => {
    if (formData.expense_category !== 'salary' || !selectedStaffId) {
      setSalaryAdvances([]);
      setSalaryCalculation(null);
      setApplySalaryAdvance(true);
      return;
    }
    let cancelled = false;
    void Promise.all([
      supabase.rpc('get_outstanding_salary_advances', {
        p_staff_id: selectedStaffId,
        p_as_of_date: formData.expense_date,
      }),
      supabase.rpc('calculate_staff_salary', {
        p_staff_id: selectedStaffId,
        p_salary_date: formData.expense_date,
        // Amount is prefilled from Staff Master on selection, but remains the
        // authoritative gross value after the user edits it.
        p_gross_override: formData.amount,
      }),
    ]).then(async ([advancesResult, calculationResult]) => {
      if (cancelled) return;
      if (advancesResult.error || calculationResult.error) {
        console.error('Unable to load canonical salary calculation:', advancesResult.error?.message || calculationResult.error?.message);
        setSalaryAdvances([]);
        setSalaryCalculation(null);
        return;
      }
      const calculation = calculationResult.data as typeof salaryCalculation;
      setSalaryAdvances((advancesResult.data || []) as typeof salaryAdvances);
      const existingApplied = editingExpense?.id
        ? Number((await supabase.rpc('get_salary_advance_applications', { p_salary_expense_id: editingExpense.id })).data?.reduce((sum: number, item: { applied_amount: number }) => sum + Number(item.applied_amount || 0), 0) ?? 0)
        : 0;
      const advanceApplied = existingApplied || Number(calculation?.outstanding_salary_advances || 0);
      setPersistedSalaryAdvanceApplied(existingApplied);
      setSalaryCalculation(calculation ? {
        ...calculation,
        outstanding_salary_advances: advanceApplied,
        net_salary_payable: Math.max(calculation.gross_salary - advanceApplied - calculation.pph21_amount - calculation.bpjs_amount, 0),
      } : null);
      // Saving a reopened settlement must not create another FIFO application.
      setApplySalaryAdvance(!editingExpense || existingApplied === 0);
      if (calculation) {
        const pph21Code = taxCodes.find((code) => code.code.toUpperCase() === 'PPH21');
        setFormData((previous) => ({
          ...previous,
          pph_amount: calculation.pph21_method === 'percentage' ? calculation.pph21_amount : previous.pph_amount,
          pph_code_id: calculation.pph21_applicable && pph21Code ? pph21Code.id : previous.pph_code_id,
          payment_method: ['cash','bank_transfer'].includes(calculation.default_payment_method)
            ? calculation.default_payment_method
            : previous.payment_method,
        }));
      }
    });
    return () => {
      cancelled = true;
    };
  }, [formData.expense_category, formData.expense_date, formData.amount, selectedStaffId, taxCodes, editingExpense?.id]);

  // A deliberate PPh21 edit is a UI override, not a new payroll calculation.
  // Keep the canonical advances/BPJS result and update only the displayed
  // deduction/net so the panel immediately reflects the value that will save.
  useEffect(() => {
    if (formData.expense_category !== 'salary') return;
    setSalaryCalculation(current => current ? {
      ...current,
      pph21_amount: formData.pph_amount,
      net_salary_payable: Math.max(
        current.gross_salary
          - current.outstanding_salary_advances
          - formData.pph_amount
          - current.bpjs_amount,
        0,
      ),
    } : current);
  }, [formData.expense_category, formData.pph_amount]);

  useEffect(() => {
    if (!viewingExpense || viewingExpense.expense_category !== 'salary') {
      setSalaryAdvanceApplications([]);
      return;
    }
    void supabase.rpc('get_salary_advance_applications', {
      p_salary_expense_id: viewingExpense.id,
    }).then(({ data, error }) => {
      if (error) {
        console.error('Unable to load salary advance applications:', error.message);
        setSalaryAdvanceApplications([]);
        return;
      }
      setSalaryAdvanceApplications((data || []) as typeof salaryAdvanceApplications);
    });
  }, [viewingExpense]);

  // Retry the Staff / Utility load-back after the rosters arrive.
  // handleEdit runs immediately on click; if the rosters were still loading
  // at that moment the picker lookup misses. This effect re-resolves it once
  // the roster fetch settles, without re-parsing the tag.
  useEffect(() => {
    if (!editingExpense) return;
    const rules = getCategoryFieldRules(editingExpense.expense_category);
    const desc = editingExpense.description || '';
    const tagMatch = desc.match(/^\[([^·\]]+?)(?:\s*·\s*([^\]]+))?\]\s*/);
    if (!tagMatch) return;
    const name = tagMatch[1].trim();
    if (rules.staff === 'show' && !selectedStaffId) {
      const s = staffRoster.find(x => x.full_name === name);
      if (s) setSelectedStaffId(s.id);
    } else if (rules.utility === 'show' && !selectedUtilityId) {
      const u = utilityRoster.find(x => x.provider_name === name);
      if (u) setSelectedUtilityId(u.id);
    }
    // Intentional deps: react to roster arrival, not to editingExpense identity churn.
  }, [staffRoster, utilityRoster, editingExpense]);

  // Realtime subscriptions via shared hook. Patch state from payload instead of
  // reloading the entire list.
  const patchExpense = (payload: any) => {
    const evt = payload.eventType;
    if (evt === 'INSERT') {
      // Row is missing joined relations; fall back to a targeted refetch of the row.
      const id = payload.new?.id;
      if (!id) return;
      supabase
        .from('finance_expenses')
        .select(`
          *,
          suppliers(id, company_name),
          batches(batch_number),
          import_containers(container_ref),
          delivery_challans(challan_number),
          bank_accounts(bank_name, account_number, alias, currency),
          bank_statement_lines!bsl_matched_expense_fk(
            id,
            transaction_date,
            description,
            debit_amount,
            credit_amount,
            bank_account_id,
            bank_accounts(bank_name, account_number, alias, currency)
          )
        `)
        .eq('id', id)
        .maybeSingle()
        .then(({ data }) => {
          if (!data) return;
          void hydrateExpensePostingLifecycle([data as FinanceExpense]).then(([hydrated]) => {
            setExpenses(prev => (prev.some(e => e.id === id) ? prev : [hydrated, ...prev]));
          });
        });
    } else if (evt === 'UPDATE') {
      setExpenses(prev => prev.map(e => (e.id === payload.new.id ? { ...e, ...payload.new } : e)));
    } else if (evt === 'DELETE') {
      setExpenses(prev => prev.filter(e => e.id !== payload.old.id));
    }
  };

  // The canonical reconciliation relationship is owned by
  // bank_statement_lines.matched_expense_id.  Detail and edit views keep a
  // joined copy of those rows, so updating only reconciledExpenseIds leaves
  // them stale after a link made from Bank Reconciliation.
  const syncExpenseBankLinks = async (candidateIds: Array<string | null | undefined>) => {
    const expenseIds = [...new Set(candidateIds.filter((id): id is string => Boolean(id)))];
    if (expenseIds.length === 0) return;

    const [{ data, error }, { data: canonicalAllocations, error: allocationError }] = await Promise.all([
      supabase
      .from('bank_statement_lines')
      .select(`
        id,
        transaction_date,
        description,
        debit_amount,
        credit_amount,
        bank_account_id,
        payment_kind,
        matched_expense_id,
        bank_accounts(bank_name, account_number, alias, currency)
      `)
      .in('matched_expense_id', expenseIds),
      supabase
        .from('bank_statement_allocations')
        .select(`
          id,
          document_id,
          allocation_amount,
          payment_kind,
          bank_statement_lines!inner(
            id,
            transaction_date,
            description,
            debit_amount,
            credit_amount,
            bank_account_id,
            bank_accounts(bank_name, account_number, alias, currency)
          )
        `)
        .eq('document_type', 'expense')
        .in('document_id', expenseIds),
    ]);

    if (error || allocationError) {
      console.error('Unable to synchronize expense bank links:', error?.message || allocationError?.message);
      return;
    }

    const linksByExpenseId = new Map<string, FinanceExpense['bank_statement_lines']>();
    expenseIds.forEach(id => linksByExpenseId.set(id, []));
    (data || []).forEach((line: any) => {
      // matched_expense_id is deliberately omitted from the UI row shape, but
      // is needed here to group the canonical rows by Expense.
      const expenseId = line.matched_expense_id;
      if (!expenseId) return;
      const links = linksByExpenseId.get(expenseId) || [];
      links.push(line);
      linksByExpenseId.set(expenseId, links);
    });

    (canonicalAllocations || []).forEach((allocation: any) => {
      const expenseId = allocation.document_id;
      const line = allocation.bank_statement_lines;
      if (!expenseId || !line) return;
      const links = linksByExpenseId.get(expenseId) || [];
      if (links.some(existing => existing.id === line.id)) return;
      links.push({
        ...line,
        allocation_id: allocation.id,
        allocation_amount: Number(allocation.allocation_amount || 0),
        payment_kind: allocation.payment_kind,
      });
      linksByExpenseId.set(expenseId, links);
    });

    const patchLinks = (expense: FinanceExpense): FinanceExpense => {
      const links = linksByExpenseId.get(expense.id);
      return links === undefined ? expense : { ...expense, bank_statement_lines: links };
    };

    setExpenses(prev => prev.map(patchLinks));
    setViewingExpense(prev => (prev ? patchLinks(prev) : prev));
    setEditingExpense(prev => (prev ? patchLinks(prev) : prev));
    setReconciledExpenseIds(prev => {
      const next = new Set(prev);
      expenseIds.forEach(id => {
        if ((linksByExpenseId.get(id) || []).length > 0) next.add(id);
        else next.delete(id);
      });
      return next;
    });
  };

  const patchBankLine = (payload: any) => {
    // A match can move from one Expense to another, so refresh both sides.
    // Replica identity may omit the old matched_expense_id; the local joined
    // snapshots still identify the previous owner in that case.
    const lineId = payload.new?.id || payload.old?.id;
    const previouslyLinkedExpenseIds = [
      ...expenses
        .filter(expense => expense.bank_statement_lines?.some(line => line.id === lineId))
        .map(expense => expense.id),
      viewingExpense?.bank_statement_lines?.some(line => line.id === lineId) ? viewingExpense.id : null,
      editingExpense?.bank_statement_lines?.some(line => line.id === lineId) ? editingExpense.id : null,
    ];
    void syncExpenseBankLinks([
      payload.new?.matched_expense_id,
      payload.old?.matched_expense_id,
      ...previouslyLinkedExpenseIds,
    ]);
  };

  useSupabaseRealtimeChannel({
    channelName: 'expense_changes_expmgr',
    table: 'finance_expenses',
    onEvent: patchExpense,
  });
  useSupabaseRealtimeChannel({
    channelName: 'bank_lines_expmgr',
    table: 'bank_statement_lines',
    onEvent: patchBankLine,
  });

  // Realtime supplies the immediate path. The shared event is the fallback
  // for a link/unlink initiated elsewhere in this SPA, and also keeps the
  // list, detail and edit snapshots in agreement when realtime delivery is
  // delayed.
  useEffect(() => {
    const synchronizeVisibleExpenses = () => {
      void syncExpenseBankLinks([
        ...expenses.map(expense => expense.id),
        viewingExpense?.id,
        editingExpense?.id,
      ]);
    };
    window.addEventListener(FINANCE_RECONCILIATION_REFRESH_EVENT, synchronizeVisibleExpenses);
    return () => window.removeEventListener(FINANCE_RECONCILIATION_REFRESH_EVENT, synchronizeVisibleExpenses);
  }, [expenses, viewingExpense, editingExpense]);

  useEffect(() => {
    if (!initialViewExpenseId) return;

    const openExpense = async () => {
      const existing = expenses.find(expense => expense.id === initialViewExpenseId);
      if (existing) {
        setViewingExpense(existing);
        setViewModalOpen(true);
        onInitialViewHandled?.();
        return;
      }

      const { data, error } = await supabase
        .from('finance_expenses')
        .select(`
          *,
          suppliers(id, company_name),
          batches(batch_number),
          import_containers(container_ref),
          delivery_challans(challan_number),
          bank_accounts(bank_name, account_number, alias, currency),
          bank_statement_lines!bsl_matched_expense_fk(
            id,
            transaction_date,
            description,
            debit_amount,
            credit_amount,
            bank_account_id,
            bank_accounts(bank_name, account_number, alias, currency)
          )
        `)
        .eq('id', initialViewExpenseId)
        .maybeSingle();

      if (!error && data) {
        const [hydrated] = await hydrateExpensePostingLifecycle([data as FinanceExpense]);
        setViewingExpense(hydrated);
        setViewModalOpen(true);
      }
      onInitialViewHandled?.();
    };

    openExpense();
  }, [initialViewExpenseId, expenses, onInitialViewHandled]);

  const loadData = async () => {
    try {
      setLoading(true);
      // perf: server-side date filter (was client-side .filter in filteredExpenses).
      let expensesQuery = supabase
        .from('finance_expenses')
        .select(`
          *,
          suppliers(id, company_name),
          batches(batch_number),
          import_containers(container_ref),
          delivery_challans(challan_number),
          bank_accounts(bank_name, account_number, alias, currency),
          bank_statement_lines!bsl_matched_expense_fk(
            id,
            transaction_date,
            description,
            debit_amount,
            credit_amount,
            bank_account_id,
            bank_accounts(bank_name, account_number, alias, currency)
          )
        `)
        .order('expense_date', { ascending: false })
        .order('created_at', { ascending: false });
      if (startDate) expensesQuery = expensesQuery.gte('expense_date', startDate);
      if (endDate) expensesQuery = expensesQuery.lte('expense_date', endDate);

      const [expensesRes, batchesRes, containersRes, challansRes, banksRes, bankStmtRes] = await Promise.all([
        expensesQuery,
        supabase
          .from('batches')
          .select('id, batch_number')
          .order('batch_number'),
        supabase
          .from('import_containers')
          .select('id, container_ref')
          .order('container_ref'),
        supabase
          .from('delivery_challans')
          .select('id, challan_number, challan_date, customers(company_name)')
          .order('challan_number', { ascending: false })
          .limit(50),
        supabase
          .from('bank_accounts')
          .select('id, bank_name, account_number, alias, currency')
          .order('bank_name'),
        supabase
          .from('bank_statement_lines')
          .select('matched_expense_id')
          .not('matched_expense_id', 'is', null),
      ]);

      if (expensesRes.error) throw expensesRes.error;
      const loadedExpenses = await hydrateExpensePostingLifecycle((expensesRes.data || []) as FinanceExpense[]);
      setExpenses(loadedExpenses);
      // Legacy matched_* joins intentionally disappear for split allocations;
      // hydrate the canonical allocation relationships for payment breakdowns.
      void syncExpenseBankLinks(loadedExpenses.map((expense: any) => expense.id));
      setBatches(batchesRes.data || []);
      setContainers(containersRes.data || []);
      setChallans((challansRes.data || []).map(challan => ({
        ...challan,
        customers: Array.isArray(challan.customers) ? challan.customers[0] || null : challan.customers,
      })));
      setBankAccounts(banksRes.data || []);

      // Build set of reconciled expense IDs
      const reconciledIds = new Set<string>();
      if (bankStmtRes.data) {
        bankStmtRes.data.forEach(line => {
          if (line.matched_expense_id) {
            reconciledIds.add(line.matched_expense_id);
          }
        });
      }
      setReconciledExpenseIds(reconciledIds);

      // Load tax codes (withholding PPh) and asset COA accounts once
      if (taxCodes.length === 0) {
        const { data: tc } = await supabase.from('tax_codes').select('id, code, name, rate, tax_type').eq('is_withholding', true).order('code');
        setTaxCodes(tc || []);
      }
      if (coaAssets.length === 0) {
        const { data: coa } = await supabase.from('chart_of_accounts').select('id, code, name').in('account_type', ['asset', 'Asset']).order('code');
        setCoaAssets(coa || []);
      }
      if (suppliers.length === 0) {
        const { data: sup } = await supabase
          .from('suppliers')
          .select('id, company_name, pkp_status, payment_terms_days, default_expense_category, default_pph_code_id, tax_preference, supplier_type')
          .order('company_name');
        setSuppliers((sup as Supplier[]) || []);
      }
      // Staff Master + Utility Master (dynamic form pickers).
      // Non-blocking — if the tables aren't deployed yet we degrade gracefully.
      if (staffRoster.length === 0) {
        const { data: staff } = await supabase
          .from('finance_staff_master')
          .select('id, full_name, department, default_gl_code, monthly_salary')
          .eq('status', 'active')
          .order('full_name');
        if (staff) setStaffRoster(staff);
      }
      if (utilityRoster.length === 0) {
        const { data: utl } = await supabase
          .from('finance_utility_master')
          .select('id, provider_name, utility_type, supplier_id, default_gl_code')
          .eq('status', 'active')
          .order('provider_name');
        if (utl) setUtilityRoster(utl);
      }
    } catch (error: any) {
      console.error('Error loading data:', error.message);
      alert('Failed to load expenses');
    } finally {
      setLoading(false);
    }
  };

  const getSignedUrl = (fileUrl: string): Promise<string> =>
    resolveStorageUrlCached(fileUrl, 3600);

  const openDocument = async (url: string) => {
    await openStorageDocument(url);
  };

  const downloadDocument = async (url: string, filename: string) => {
    await downloadStorageDocument(url, filename);
  };

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();

    console.log('=== EXPENSE FORM SUBMIT ===');
    console.log('Editing:', !!editingExpense);
    console.log('Files to upload:', uploadingFiles.length);
    console.log('Existing URLs:', formData.document_urls);

    try {
      // Dynamic-form validation — Staff / Utility categories require their
      // respective master row to be picked. Supplier categories keep the
      // existing behaviour (supplier is optional at the DB level).
      const preRules = getCategoryFieldRules(formData.expense_category);
      if (formData.expense_category === 'non_permanent_employee_fee' && selectedSupplier
          && !['employee', 'non-permanent individual', 'freelancer', 'casual worker', 'honorarium recipient']
            .includes((selectedSupplier.supplier_type || '').trim().toLowerCase())) {
        alert('Non-Permanent Employee Fee is intended for an individual subject to PPh 21. Select an Employee, Freelancer, Casual Worker, or Honorarium supplier.');
        return;
      }
      if (preRules.staff === 'show' && !selectedStaffId) {
        alert('Please pick a Staff member for this salary / staff expense.');
        return;
      }
      if (formData.expense_category === 'staff_advance' && !formData.payment_method) {
        alert('A staff advance is money paid out — select how it was paid (it cannot be recorded as an outstanding bill).');
        return;
      }
      if (preRules.utility === 'show' && !selectedUtilityId) {
        alert('Please pick a Utility Provider for this utility expense.');
        return;
      }
      const category = expenseCategories.find(c => c.value === formData.expense_category);

      // PIB Import: validate that the breakdown sums to the payment amount
      if (formData.expense_category === 'pib_import') {
        const breakdown = (formData.pib_bm_amount || 0) + (formData.pib_ppn_amount || 0) + (formData.pib_pph_amount || 0);
        if (Math.abs(breakdown - (formData.amount || 0)) > 1) {
          alert(
            `❌ PIB Breakdown Mismatch\n\n` +
            `BM + PPN + PPh = Rp ${breakdown.toLocaleString('id-ID')}\n` +
            `Payment Amount = Rp ${(formData.amount || 0).toLocaleString('id-ID')}\n\n` +
            `The three components must equal the total payment amount.`
          );
          return;
        }
        if (breakdown === 0) {
          alert('❌ PIB Import requires a breakdown. Please enter BM, PPN, and/or PPh amounts.');
          return;
        }
      }

      // Fixed Asset: account selection is mandatory before save.
      if (formData.expense_category === 'fixed_asset' && !formData.fixed_asset_account_id) {
        alert(
          '❌ Fixed Asset Account Required\n\n' +
          'This expense is categorised as Fixed Asset.\n\n' +
          'Select the Fixed Asset GL account (e.g. Equipment, Furniture, Machinery) ' +
          'before saving. The Journal Entry cannot be generated without it.'
        );
        return;
      }

      // Validate: PPh code is required whenever a PPh amount is entered.
      // pib_import expenses use the pib_pph_amount breakdown field instead.
      if (formData.expense_category !== 'pib_import'
          && (formData.pph_amount || 0) > 0
          && !formData.pph_code_id) {
        alert(
          '❌ PPh Code Required\n\n' +
          'A PPh code must be selected when PPh Withheld is greater than zero.\n\n' +
          'Select the applicable PPh code (e.g. PPh21 Employee, PPh23 Services) ' +
          'so the amount flows correctly into the PPh Register.'
        );
        return;
      }

      // Upload new files first
      const uploadedUrls = uploadingFiles.length > 0
        ? await uploadFinanceDocuments(uploadingFiles, `expenses/${formData.expense_category}`)
        : [];

      // Combine existing URLs with newly uploaded ones
      const allDocumentUrls = [...formData.document_urls, ...uploadedUrls];
      console.log('Combined document URLs:', allDocumentUrls);

      // 2026-07 refactor — Broker Invoice amount and reimbursement lines are
      // independent by design (Indonesian brokers issue their own invoice for
      // their fee; reimbursement lines are pass-through sub-supplier invoices).
      // Do NOT validate that lines must sum to invoice amount.

      const isBrokerInvoice = formData.expense_category === 'import_broker';
      const isPib = formData.expense_category === 'pib_import';
      const isFixedAsset = formData.expense_category === 'fixed_asset';
      const isImportCategory = category?.type === 'import';
      // Broker invoices behave like any other supplier invoice at the header
      // level: they own their own PPN / PPh / stamp / DPP-mode. Only pure
      // import cost categories (freight, duty, etc.) still zero out those
      // header tax fields — that logic is unchanged.
      const persistHeaderTax = !isPib && (!isImportCategory || isBrokerInvoice);
      // Dynamic-form prefix — inject Staff / Utility name and period into
      // description for ledger traceability. Prefix is added ONLY when the
      // category dictates and only if the user has not already typed the same
      // value at the start of description.
      const rules = getCategoryFieldRules(formData.expense_category);
      let composedDescription = (formData.description || '').trim();
      if (rules.staff === 'show' && selectedStaffId) {
        const s = staffRoster.find(x => x.id === selectedStaffId);
        if (s) {
          const tag = `[${s.full_name}${periodLabel ? ' · ' + formatFinancePeriodValue(periodLabel) : ''}]`;
          if (!composedDescription.startsWith(tag)) composedDescription = `${tag} ${composedDescription}`.trim();
        }
      } else if (rules.utility === 'show' && selectedUtilityId) {
        const u = utilityRoster.find(x => x.id === selectedUtilityId);
        if (u) {
          const tag = `[${u.provider_name}${periodLabel ? ' · ' + formatFinancePeriodValue(periodLabel) : ''}]`;
          if (!composedDescription.startsWith(tag)) composedDescription = `${tag} ${composedDescription}`.trim();
        }
      }
      const selectedExpenseBank = bankAccounts.find(bank => bank.id === formData.bank_account_id);
      const transactionCurrency = normalizeCurrency(
        formData.payment_method !== null ? selectedExpenseBank?.currency : formData.transaction_currency,
      ) as 'IDR' | 'USD';
      const exchangeRate = transactionCurrency === 'IDR'
        ? 1
        : (formData.exchange_rate > 1 ? formData.exchange_rate : await getReportingUsdRate());
      const expenseData = {
        expense_category: formData.expense_category,
        // finance_expenses.expense_type is the legacy transaction context,
        // distinct from the broader Expense Category Master category_type.
        // The database derives this again so every write path stays canonical.
        expense_type: category?.type === 'import' ? 'import' : category?.type === 'sales' ? 'sales' : 'general',
        amount: formData.amount,
        expense_date: formData.expense_date,
        description: composedDescription || null,
        batch_id: formData.batch_id || null,
        import_container_id: formData.import_container_id || null,
        delivery_challan_id: formData.delivery_challan_id || null,
        payment_method: formData.payment_method || null,
        bank_account_id: formData.payment_method && formData.payment_method !== 'outstanding' ? (formData.bank_account_id || null) : null,
        payment_reference: formData.payment_reference || null,
        paid_by: formData.payment_method === null || formData.payment_method === 'outstanding' ? null : 'bank',
        // save_finance_expense expects document_urls to always be a JSON array;
        // null causes jsonb_array_elements_text to fail in the RPC.
        document_urls: allDocumentUrls,
        // Main invoice supplier. NEVER derived from broker_items[i].supplier_id
        // — broker line suppliers are used ONLY for tax invoice / PPN register.
        supplier_id: formData.supplier_id || null,
        // Staff FK (salary / overtime / welfare / advance) — the description
        // prefix stays for ledger traceability, but the FK is authoritative.
        staff_id: rules.staff === 'show' ? (selectedStaffId || null) : null,
        invoice_number: formData.invoice_number || null,
        due_date: formData.due_date || null,
        // Broker items (only for import_broker). Per-line supplier_id inside these
        // items feeds vw_input_ppn_report Branch 5 — the main supplier above is untouched.
        broker_items: isBrokerInvoice && brokerItems.length > 0 ? brokerItems : null,
        // PIB breakdown — only persisted for pib_import category
        pib_bm_amount:  isPib ? (formData.pib_bm_amount  || 0) : null,
        pib_ppn_amount: isPib ? (formData.pib_ppn_amount || 0) : null,
        pib_pph_amount: isPib ? (formData.pib_pph_amount || 0) : null,
        // Non-PIB header tax fields. Broker invoices own their own header tax
        // (independent of reimbursement lines), so persistHeaderTax includes
        // import_broker but excludes pure import cost categories.
        ppn_amount:             persistHeaderTax ? (formData.ppn_amount || 0) : 0,
        ppn_manual_override:    persistHeaderTax ? (formData.ppn_calc_mode === 'manual' || !!formData.ppn_manual_override) : false,
        ppn_calc_mode:          persistHeaderTax ? (formData.ppn_calc_mode || 'standard') : 'standard',
        // Persist header DDP whenever set — used both as the DPP Nilai Lain
        // taxable base AND, for broker invoices, as an independent additive
        // component of Total Payable. Nulled only when the field is empty.
        dpp_amount:             persistHeaderTax && (formData.dpp_amount || 0) > 0 ? (formData.dpp_amount || 0) : null,
        ppn_rate:               persistHeaderTax ? (formData.ppn_rate || 11) : 11,
        pph_amount:             persistHeaderTax ? (formData.pph_amount || 0) : 0,
        pph_code_id:            (persistHeaderTax && formData.pph_code_id) ? formData.pph_code_id : null,
        stamp_duty_amount:      persistHeaderTax ? (formData.stamp_duty_amount || 0) : 0,
        fixed_asset_account_id: isFixedAsset ? (formData.fixed_asset_account_id || null) : null,
        bank_charges_amount:    rules.bankCharges === 'show' ? (formData.bank_charges_amount || 0) : 0,
        currency_code: transactionCurrency,
        transaction_currency: transactionCurrency,
        functional_currency: 'IDR' as const,
        exchange_rate: exchangeRate,
        bank_account_currency: selectedExpenseBank?.currency || transactionCurrency,
        payment_currency: transactionCurrency,
      };

      console.log('=== EXPENSE DATA TO SAVE ===');
      console.log('document_urls:', expenseData.document_urls);
      console.log('Full expense data:', expenseData);

      if (editingExpense) {
        // Regular update - bank expenses only (cash expenses go to Petty Cash Manager)
        console.log('=== UPDATING EXPENSE ===');
        console.log('Expense ID:', editingExpense.id);

        const editingApprovedExpense = editingExpense.approval_status === 'approved';
        if (editingApprovedExpense) {
          await editApprovedFinanceExpense(
            editingExpense.id,
            expenseData,
            selectedBankTransactionId || null,
            selectedBankAllocationAmount,
          );
        } else if (selectedBankTransactionId) {
          await saveAndLinkFinanceExpense(
            editingExpense.id,
            expenseData,
            selectedBankTransactionId,
            selectedBankAllocationAmount,
            profile?.id,
            formData.expense_category === 'salary' && !!selectedStaffId && applySalaryAdvance && persistedSalaryAdvanceApplied === 0,
          );
        } else {
          await saveFinanceExpense(editingExpense.id, expenseData);
        }

        if (!selectedBankTransactionId && formData.expense_category === 'salary' && selectedStaffId && applySalaryAdvance && persistedSalaryAdvanceApplied === 0) {
          const { error: advanceError } = await supabase.rpc('apply_salary_advances_to_expense', {
            p_salary_expense_id: editingExpense.id,
            p_apply: true,
          });
          if (advanceError) throw advanceError;
        }

        console.log('Update successful! Fetching updated data...');

        // Fetch the updated expense with relations
        const { data: updatedExpense, error: fetchError } = await supabase
          .from('finance_expenses')
          .select(`
            *,
            batches (batch_number),
            import_containers (container_ref),
            delivery_challans (challan_number),
            bank_accounts (bank_name, account_number),
            bank_statement_lines!bsl_matched_expense_fk (
              id,
              transaction_date,
              description,
              debit_amount,
              credit_amount,
              bank_account_id,
              bank_accounts (bank_name, account_number)
            )
          `)
          .eq('id', editingExpense.id)
          .single();

        if (fetchError) {
          console.error('Fetch error:', fetchError);
          throw fetchError;
        }

        console.log('=== FETCHED UPDATED EXPENSE ===');
        console.log('document_urls from DB:', updatedExpense.document_urls);
        console.log('Full updated expense:', updatedExpense);

        const [hydratedUpdatedExpense] = await hydrateExpensePostingLifecycle([updatedExpense as FinanceExpense]);

        // Update in local state
        setExpenses(prev => prev.map(exp =>
          exp.id === editingExpense.id ? hydratedUpdatedExpense : exp
        ));
        void syncExpenseBankLinks([editingExpense.id]);

        if (selectedBankTransactionId && !editingApprovedExpense) {
          setReconciledExpenseIds(prev => new Set(prev).add(editingExpense.id));
          notifyFinanceReconciliationRefresh();
        }

        alert('Expense updated successfully');
      } else {
        // Create new bank expense - cash expenses should be recorded in Petty Cash Manager
        const { data: { user } } = await supabase.auth.getUser();
        if (!user) throw new Error('Not authenticated');

        console.log('=== CREATING NEW EXPENSE ===');

        const newExpensePayload = { ...expenseData, created_by: user.id };
        const newExpenseId = selectedBankTransactionId
          ? await saveAndLinkFinanceExpense(
              null,
              newExpensePayload,
              selectedBankTransactionId,
              selectedBankAllocationAmount,
              profile?.id || user.id,
              formData.expense_category === 'salary' && !!selectedStaffId && applySalaryAdvance,
            )
          : await saveFinanceExpense(null, newExpensePayload);
        if (!selectedBankTransactionId && formData.expense_category === 'salary' && selectedStaffId && applySalaryAdvance) {
          const { error: advanceError } = await supabase.rpc('apply_salary_advances_to_expense', {
            p_salary_expense_id: newExpenseId,
            p_apply: true,
          });
          if (advanceError) throw advanceError;
        }
        const selectClause = `
            *,
            batches (batch_number),
            import_containers (container_ref),
            delivery_challans (challan_number),
            bank_accounts (bank_name, account_number),
            bank_statement_lines!bsl_matched_expense_fk (
              id,
              transaction_date,
              description,
              debit_amount,
              credit_amount,
              bank_account_id,
              bank_accounts (bank_name, account_number)
            )
          `;

        const { data: newExpense, error: insertErr } = await supabase
          .from('finance_expenses').select(selectClause).eq('id', newExpenseId).single();
        if (insertErr) throw insertErr;

        console.log('=== NEW EXPENSE CREATED ===');
        console.log('document_urls from DB:', newExpense?.document_urls);
        console.log('Full new expense:', newExpense);

        const finalExpense = newExpense;

        if (selectedBankTransactionId && newExpense) {
          setReconciledExpenseIds(prev => new Set(prev).add(newExpense.id));
          notifyFinanceReconciliationRefresh();
        }

        // Add to local state (with bank link if applicable)
        setExpenses(prev => [finalExpense, ...prev]);
        alert('Expense recorded successfully');
      }

      setModalOpen(false);
      resetForm();
    } catch (error: any) {
      console.error('Error saving expense:', error.message);
      // Show clear error message from backend validation
      const errorMessage = error.message || 'Unknown error occurred';
      if (errorMessage.includes('Import expenses must be linked')) {
        alert('❌ Context Required\n\nImport expenses must be linked to an Import Container.\nPlease select a container before saving.');
      } else {
        alert('Failed to save expense:\n\n' + errorMessage);
      }
    }
  };

  const handleEdit = async (expense: FinanceExpense) => {
    if (expense.effective_posting_state === 'REVERSED' || expense.effective_posting_state === 'AMBIGUOUS') {
      alert(expense.effective_posting_state === 'REVERSED'
        ? 'This expense is cancelled and cannot be edited.'
        : 'This expense requires accounting review before it can be edited.');
      return;
    }
    setEditingExpense(expense);
    if (expense.expense_category === 'salary') {
      const { data, error } = await supabase.rpc('get_salary_advance_applications', { p_salary_expense_id: expense.id });
      if (error) {
        alert(`Unable to load salary advance settlement: ${error.message}`);
        setEditingExpense(null);
        return;
      }
      setPersistedSalaryAdvanceApplied((data || []).reduce((sum: number, item: { applied_amount: number }) => sum + Number(item.applied_amount || 0), 0));
    } else {
      setPersistedSalaryAdvanceApplied(0);
    }

    // Check if expense is reconciled to a bank statement
    const reconciledBankInfo = expense.bank_statement_lines && expense.bank_statement_lines.length > 0
      ? expense.bank_statement_lines[0]
      : null;

    // Use reconciled bank info if available, otherwise use expense's own payment info
    const effectiveBankAccountId = reconciledBankInfo?.bank_account_id || expense.bank_account_id || '';
    const effectivePaymentMethod = reconciledBankInfo?.bank_account_id
      ? 'bank_transfer'
      : expense.payment_method;

    // Determine document type from category
    const docType = (Object.entries(DOCUMENT_TYPE_GROUPS) as [DocumentType, string[]][])
      .find(([, cats]) => cats.includes(expense.expense_category))?.[0] ?? '' as DocumentType | '';
    setSelectedDocType(docType);

    // Set supplier
    const sup = expense.supplier_id ? suppliers.find(s => s.id === expense.supplier_id) ?? null : null;
    setSelectedSupplier(sup);

    // Set broker items
    setBrokerItems(expense.broker_items ?? []);

    // Dynamic-form load-back — if the expense was saved as Staff or Utility,
    // reconstruct the picker selection + period from the "[Name · Period]"
    // description prefix so the form re-opens in the same state.
    const rules = getCategoryFieldRules(expense.expense_category);
    const desc = expense.description || '';
    const tagMatch = desc.match(/^\[([^·\]]+?)(?:\s*·\s*([^\]]+))?\]\s*/);
    let cleanedDesc = desc;
    let loadedStaffId = '';
    let loadedUtilityId = '';
    let loadedPeriod = '';
    if (tagMatch) {
      const [full, name, period] = tagMatch;
      cleanedDesc = desc.slice(full.length);
      loadedPeriod = (period ?? '').trim();
      if (rules.staff === 'show') {
        const s = staffRoster.find(x => x.full_name === name.trim());
        if (s) loadedStaffId = s.id;
      } else if (rules.utility === 'show') {
        const u = utilityRoster.find(x => x.provider_name === name.trim());
        if (u) loadedUtilityId = u.id;
      }
    }
    // staff_id FK (Phase 2) is authoritative over the description-prefix match
    if (rules.staff === 'show' && expense.staff_id) loadedStaffId = expense.staff_id;
    setSelectedStaffId(loadedStaffId);
    setSelectedUtilityId(loadedUtilityId);
    setPeriodLabel(rules.salaryMonth === 'show' ? normalizeSalaryPeriod(loadedPeriod, new Date(expense.expense_date).getFullYear()) : loadedPeriod);

    setFormData({
      expense_category: expense.expense_category,
      amount: expense.amount,
      transaction_currency: normalizeCurrency(expense.transaction_currency ?? expense.currency_code) as 'IDR' | 'USD',
      exchange_rate: expense.exchange_rate ?? 1,
      expense_date: expense.expense_date,
      description: cleanedDesc,
      batch_id: expense.batch_id || '',
      import_container_id: expense.import_container_id || '',
      delivery_challan_id: expense.delivery_challan_id || '',
      payment_method: effectivePaymentMethod,
      bank_account_id: effectiveBankAccountId,
      payment_reference: expense.payment_reference || '',
      document_urls: expense.document_urls || [],
      supplier_id: expense.supplier_id ?? '',
      invoice_number: expense.invoice_number ?? '',
      due_date: expense.due_date ?? '',
      pib_bm_amount:  expense.pib_bm_amount  ?? 0,
      pib_ppn_amount: expense.pib_ppn_amount ?? 0,
      pib_pph_amount: expense.pib_pph_amount ?? 0,
      ppn_amount: expense.ppn_amount ?? 0,
      ppn_manual_override: expense.ppn_manual_override ?? false,
      // Derive mode when loading pre-existing rows: manual_override was true → 'manual';
      // otherwise fall back to whatever the server tells us, defaulting to 'standard'.
      ppn_calc_mode: (expense.ppn_calc_mode ?? (expense.ppn_manual_override ? 'manual' : 'standard')) as 'standard' | 'dpp_nilai_lain' | 'manual',
      dpp_amount: expense.dpp_amount ?? 0,
      ppn_rate: expense.ppn_rate ?? 11,
      pph_amount: expense.pph_amount ?? 0,
      pph_code_id: expense.pph_code_id ?? '',
      stamp_duty_amount: expense.stamp_duty_amount ?? 0,
      fixed_asset_account_id: expense.fixed_asset_account_id ?? '',
      bank_charges_amount: expense.bank_charges_amount ?? 0,
    });

    // An existing allocation is displayed by BankTransactionLinkField; it is
    // not a newly selected bank line. Preloading it here made Update call the
    // allocation RPC again and correctly fail on the duplicate allocation.
    setSelectedBankTransactionId('');
    setSelectedBankAllocationAmount(undefined);

    setModalOpen(true);
  };

  const handleDelete = async (id: string) => {
    const expense = expenses.find(candidate => candidate.id === id);
    if (!expense || !['PENDING', 'REJECTED'].includes(expense.effective_posting_state || 'AMBIGUOUS')) {
      alert('This expense is not deletable through the normal workflow. Reversed, replaced, active, or ambiguous accounting history must be preserved.');
      return;
    }
    if (!confirm('Are you sure you want to delete this expense?')) return;

    try {
      const { error } = await supabase.rpc('delete_expense_safe', { p_expense_id: id });

      if (error) throw error;

      // Remove from local state
      setExpenses(prev => prev.filter(exp => exp.id !== id));
      alert('Expense deleted successfully');
    } catch (error: any) {
      console.error('Error deleting expense:', error.message);
      alert('Failed to delete expense: ' + error.message);
    }
  };


  const handleApproveExpense = async (id: string) => {
    if (!isAdmin) return;

    // Block approval if this is a fixed_asset expense with no account selected.
    const target = expenses.find(e => e.id === id);
    if (target?.expense_category === 'fixed_asset' && !target.fixed_asset_account_id) {
      alert(
        '❌ Cannot Approve — Fixed Asset Account Missing\n\n' +
        'This expense is categorised as Fixed Asset but no GL account has been selected.\n\n' +
        'Open the expense, select the Fixed Asset Account, save it, then approve.'
      );
      return;
    }

    setApprovalLoading(id);
    try {
      await approveFinanceExpense(id, profile?.id);
      const lifecycle = await getEffectiveExpensePostingState(id);
      setExpenses(prev => prev.map(e => e.id === id ? {
        ...e,
        approval_status: 'approved',
        approved_by: profile?.id ?? null,
        approved_at: new Date().toISOString(),
        posting_lifecycle: lifecycle,
        effective_posting_state: lifecycle?.effective_posting_state || 'AMBIGUOUS',
      } : e));
    } catch (err: any) {
      alert('Failed to approve: ' + err.message);
    } finally {
      setApprovalLoading(null);
    }
  };

  const handleRejectExpenseConfirm = async () => {
    if (!rejectionTarget || !rejectionReason.trim()) return;
    setApprovalLoading(rejectionTarget.id);
    try {
      const { error } = await supabase
        .from('finance_expenses')
        .update({ approval_status: 'rejected', approved_by: profile?.id, approved_at: new Date().toISOString(), rejection_reason: rejectionReason })
        .eq('id', rejectionTarget.id);
      if (error) throw error;
      const lifecycle = await getEffectiveExpensePostingState(rejectionTarget.id);
      setExpenses(prev => prev.map(e => e.id === rejectionTarget.id ? {
        ...e,
        approval_status: 'rejected',
        rejection_reason: rejectionReason,
        posting_lifecycle: lifecycle,
        effective_posting_state: lifecycle?.effective_posting_state || 'AMBIGUOUS',
      } : e));
      setRejectionModalOpen(false);
      setRejectionTarget(null);
      setRejectionReason('');
    } catch (err: any) {
      alert('Failed to reject: ' + err.message);
    } finally {
      setApprovalLoading(null);
    }
  };

  const closeCancelPostingModal = () => {
    setCancelPostingModalOpen(false);
    setCancelPostingTarget(null);
    setCancelPostingReason('');
    setCancelPostingBlock(null);
  };

  const handleCancelPostingRequest = async (expense: FinanceExpense) => {
    setCancelPostingLoading(true);
    setCancelPostingTarget(expense);
    setCancelPostingReason('');
    try {
      const { block } = await preflightExpenseCancellation(expense.id);
      setCancelPostingBlock(block);
      setCancelPostingModalOpen(true);
    } catch (err) {
      setCancelPostingBlock({
        kind: 'verification_failed',
        message: `Cancellation safety checks could not be completed: ${supabaseErrorMessage(err)}. No cancellation request was sent.`,
      });
      setCancelPostingModalOpen(true);
    } finally {
      setCancelPostingLoading(false);
    }
  };

  const handleCancelPostingConfirm = async () => {
    if (!cancelPostingTarget || !cancelPostingReason.trim()) return;
    setCancelPostingLoading(true);
    try {
      // Repeat the read-only guard immediately before the RPC so a payment or
      // reconciliation added while the dialog was open cannot race cancellation.
      const { block } = await preflightExpenseCancellation(cancelPostingTarget.id);
      if (block) {
        setCancelPostingBlock(block);
        return;
      }
      const { error } = await supabase.rpc('cancel_expense_posting', {
        p_exp_id:       cancelPostingTarget.id,
        p_cancelled_by: profile?.id,
        p_reason:       cancelPostingReason,
      });
      if (error) throw error;
      closeCancelPostingModal();
      loadData();
    } catch (err) {
      const msg = supabaseErrorMessage(err);
      const lower = msg.toLowerCase();
      if (lower.includes('paid') || lower.includes('settled') || lower.includes('allocation')) {
        setCancelPostingBlock({ kind: 'settled', message: SETTLED_EXPENSE_CANCELLATION_MESSAGE });
      } else if (lower.includes('closed')) {
        setCancelPostingBlock({ kind: 'closed_period', message: `Period closed: ${msg}` });
      } else if (lower.includes('already reversed') || lower.includes('not approved')) {
        setCancelPostingBlock({ kind: 'already_reversed', message: 'This expense posting has already been reversed or cancelled.' });
      } else if (lower.includes('no active journal')) {
        setCancelPostingBlock({ kind: 'no_active_journal', message: 'No active journal exists for this expense. Cancellation cannot continue.' });
      } else {
        alert(`Failed to cancel posting: ${msg}`);
      }
    } finally {
      setCancelPostingLoading(false);
    }
  };

  const handleCancelPostingBankUnlink = async () => {
    if (!cancelPostingTarget || !cancelPostingBlock?.bankStatementLineId) return;
    if (!confirm(
      'Open the safe unlink workflow for this bank reconciliation?\n\n' +
      'This removes the reconciliation relationship but does not delete the bank statement, expense, or journal.'
    )) return;
    setCancelPostingLoading(true);
    try {
      await unlinkBankTransaction(cancelPostingBlock.bankStatementLineId);
      await supabase.rpc('recalculate_expense_payment_state', { p_expense_id: cancelPostingTarget.id });
      notifyFinanceReconciliationRefresh();
      const { block } = await preflightExpenseCancellation(cancelPostingTarget.id);
      setCancelPostingBlock(block);
      await loadData();
    } catch (err) {
      alert(`Failed to unlink bank reconciliation: ${supabaseErrorMessage(err)}`);
    } finally {
      setCancelPostingLoading(false);
    }
  };

  const handleUnlinkFromBankStatement = async (expenseId: string) => {
    if (!confirm(
      'Are you sure you want to unlink this expense from the bank statement?\n\n' +
      'The bank statement line will be set back to "Unmatched" status.'
    )) return;

    try {
      await unlinkFinanceExpenseBankLink(expenseId);

      // Fetch the updated expense with relations
      const { data: updatedExpense, error: fetchError } = await supabase
        .from('finance_expenses')
        .select(`
          *,
          batches (batch_number),
          import_containers (container_ref),
          delivery_challans (challan_number),
          bank_accounts (bank_name, account_number),
          bank_statement_lines!bsl_matched_expense_fk (
            id,
            transaction_date,
            description,
            debit_amount,
            credit_amount,
            bank_account_id,
            bank_accounts (bank_name, account_number)
          )
        `)
        .eq('id', expenseId)
        .single();

      if (fetchError) throw fetchError;

      // Update in local state
      setExpenses(prev => prev.map(exp =>
        exp.id === expenseId ? updatedExpense : exp
      ));
      notifyFinanceReconciliationRefresh();

      alert('Expense unlinked from bank statement successfully');
      setModalOpen(false);
      setEditingExpense(null);
      resetForm();
    } catch (error: any) {
      console.error('Error unlinking expense:', error.message);
      alert('Failed to unlink expense: ' + error.message);
    }
  };

  const resetForm = () => {
    setEditingExpense(null);
    setSelectedBankTransactionId('');
    setSelectedBankAllocationAmount(undefined);
    setUploadingFiles([]);
    setSelectedSupplier(null);
    setSelectedDocType('');
    setBrokerItems([]);
    setSelectedStaffId('');
    setSalaryAdvances([]);
    setSalaryCalculation(null);
    setApplySalaryAdvance(true);
    setSelectedUtilityId('');
    setPeriodLabel('');
    setFormData({
      expense_category: 'other',
      amount: 0,
      transaction_currency: 'IDR',
      exchange_rate: 1,
      expense_date: new Date().toISOString().split('T')[0],
      description: '',
      batch_id: '',
      import_container_id: '',
      delivery_challan_id: '',
      payment_method: 'bank_transfer',
      bank_account_id: '',
      payment_reference: '',
      document_urls: [],
      supplier_id: '',
      invoice_number: '',
      due_date: getDueDateFromTerms(new Date().toISOString().split('T')[0], 30),
      pib_bm_amount: 0,
      pib_ppn_amount: 0,
      pib_pph_amount: 0,
      ppn_amount: 0,
      ppn_manual_override: false,
      ppn_calc_mode: 'standard',
      dpp_amount: 0,
      ppn_rate: 11,
      pph_amount: 0,
      pph_code_id: '',
      stamp_duty_amount: 0,
      fixed_asset_account_id: '',
      bank_charges_amount: 0,
    });
  };

  // Handle supplier selection — auto-fills category, due_date, tax fields
  const handleSupplierSelect = (supplierId: string) => {
    const sup = suppliers.find(s => s.id === supplierId) ?? null;
    setSelectedSupplier(sup);
    setFormData(prev => {
      const updates: Partial<typeof prev> = { supplier_id: supplierId };
      if (sup) {
        // Auto-fill category if supplier has a default
        if (sup.default_expense_category) {
          updates.expense_category = sup.default_expense_category;
          // Also update docType
          const docType = (Object.entries(DOCUMENT_TYPE_GROUPS) as [DocumentType, string[]][])
            .find(([, cats]) => cats.includes(sup.default_expense_category!))?.[0];
          if (docType) setSelectedDocType(docType);
        }
        // Auto-fill PPh code
        if (sup.default_pph_code_id && (sup.tax_preference === 'pph_only' || sup.tax_preference === 'ppn_pph')) {
          updates.pph_code_id = sup.default_pph_code_id;
        }
        // Auto-fill PPN only for PKP suppliers AND when we're in STANDARD calc mode.
        // DPP Nilai Lain and MANUAL modes keep whatever the user has entered.
        const mode = prev.ppn_calc_mode || 'standard';
        if (mode === 'standard' && sup.pkp_status && (sup.tax_preference === 'ppn_only' || sup.tax_preference === 'ppn_pph') && !prev.ppn_manual_override) {
          updates.ppn_amount = calculatePPN(prev.amount, true);
        }
        // Auto-fill due_date from payment terms (default 30 days)
        if (prev.expense_date) {
          updates.due_date = getDueDateFromTerms(prev.expense_date, sup.payment_terms_days ?? 30);
        }
      }
      return { ...prev, ...updates };
    });
  };

  // Quick Add Supplier handler
  const handleQuickAddSupplier = async () => {
    if (!quickAddSupplierName.trim()) return;
    setQuickAddSupplierLoading(true);
    try {
      const typeConfig = SUPPLIER_TYPES.find(t => t.value === quickAddSupplierType);
      const { data: newSupplier, error } = await supabase
        .from('suppliers')
        .insert([{
          company_name: quickAddSupplierName.trim(),
          supplier_type: quickAddSupplierType || null,
          pkp_status: quickAddSupplierPKP,
          payment_terms_days: quickAddSupplierTerms,
          tax_preference: typeConfig?.taxPreference ?? 'none',
          default_expense_category: typeConfig?.defaultCategory ?? null,
          country: 'Indonesia',
          is_active: true,
        }])
        .select('id, company_name, pkp_status, payment_terms_days, default_expense_category, default_pph_code_id, tax_preference, supplier_type')
        .single();
      if (error) throw error;
      const sup = newSupplier as Supplier;
      setSuppliers(prev => [...prev, sup].sort((a, b) => a.company_name.localeCompare(b.company_name)));
      setShowQuickAddSupplier(false);
      setQuickAddSupplierName('');
      setQuickAddSupplierType('General');
      setQuickAddSupplierPKP(false);
      setQuickAddSupplierTerms(30);
      // Auto-select the new supplier
      handleSupplierSelect(sup.id);
    } catch (err: any) {
      alert('Failed to add supplier: ' + err.message);
    } finally {
      setQuickAddSupplierLoading(false);
    }
  };

  // Finance Health Check
  const loadHealthCheck = async () => {
    setHealthLoading(true);
    try {
      const today = new Date().toISOString().split('T')[0];
      const [r1, r2, r3, r4, r5, r6, r7] = await Promise.all([
        supabase.from('finance_expenses').select('id', { count: 'exact', head: true }).is('payment_method', null).is('supplier_id', null),
        supabase.from('finance_expenses').select('id', { count: 'exact', head: true }).is('payment_method', null).is('due_date', null),
        supabase.from('finance_expenses').select('id', { count: 'exact', head: true }).or('document_urls.is.null,document_urls.eq.{}').gte('created_at', new Date(Date.now() - 90 * 86400000).toISOString()),
        supabase.from('finance_expenses').select('id', { count: 'exact', head: true }).eq('expense_category', 'fixed_asset').is('fixed_asset_account_id', null),
        supabase.from('finance_expenses').select('id', { count: 'exact', head: true }).eq('expense_category', 'import_broker').is('import_container_id', null),
        supabase.from('suppliers').select('id', { count: 'exact', head: true }).is('default_expense_category', null).eq('is_active', true),
        supabase.rpc('get_outstanding_expense_bills', { p_as_of_date: today }),
      ]);
      const issues: HealthIssue[] = [
        { key: 'outstanding_no_supplier', label: 'Outstanding bills without supplier', count: r1.count ?? 0, severity: 'warning' },
        { key: 'outstanding_no_due', label: 'Outstanding bills missing due date', count: r2.count ?? 0, severity: 'error' },
        { key: 'no_attachment', label: 'Expenses without attachment (last 90d)', count: r3.count ?? 0, severity: 'info' },
        { key: 'fa_no_account', label: 'Fixed assets without asset account', count: r4.count ?? 0, severity: 'error' },
        { key: 'broker_no_container', label: 'Broker invoices not linked to container', count: r5.count ?? 0, severity: 'warning' },
        { key: 'supplier_no_defaults', label: 'Active suppliers without expense defaults', count: r6.count ?? 0, severity: 'info' },
        { key: 'all_outstanding', label: 'Total outstanding expense bills', count: (r7.data ?? []).length, severity: 'info' },
      ].filter(i => i.count > 0) as HealthIssue[];
      setHealthIssues(issues);
    } catch (err) {
      console.error('Health check failed:', err);
    } finally {
      setHealthLoading(false);
    }
  };

  const selectedCategory = expenseCategories.find(c => c.value === formData.expense_category);
  const requiresContainer = selectedCategory?.type === 'import';
  const requiresDC = selectedCategory?.type === 'sales';
  const normalizedSearch = searchQuery.trim().toLocaleLowerCase();

  const filteredExpenses = expenses.filter(exp => {
    // Filter by type
    if (filterType !== 'all') {
      const cat = expenseCategories.find(c => c.value === exp.expense_category);
      if (cat?.type !== filterType) return false;
    }

    // Filter by specific category
    if (categoryFilter !== 'all' && exp.expense_category !== categoryFilter) {
      return false;
    }

    // Filter by supplier
    if (supplierFilter !== 'all') {
      if (supplierFilter === 'no_supplier') {
        if (exp.supplier_id) return false;
      } else {
        if (exp.supplier_id !== supplierFilter) return false;
      }
    }

    // Filter by reconciliation status
    if (reconFilter === 'reconciled') {
      if (!reconciledExpenseIds.has(exp.id)) return false;
    } else if (reconFilter === 'not_reconciled') {
      if (reconciledExpenseIds.has(exp.id)) return false;
    }

    // Filter by approval status
    if (approvalFilter === 'approved') {
      if (exp.effective_posting_state !== 'ACTIVE' && exp.effective_posting_state !== 'REPLACED') return false;
    } else if (approvalFilter === 'pending_approval') {
      if (exp.approval_status !== 'pending_approval') return false;
    }

    if (normalizedSearch) {
      const category = expenseCategories.find(c => c.value === exp.expense_category);
      const searchableValues = [
        exp.voucher_number,
        exp.description,
        exp.suppliers?.company_name,
        exp.invoice_number,
        exp.payment_reference,
        exp.expense_category,
        category?.label,
        category?.group,
      ];
      if (!searchableValues.some(value => String(value ?? '').toLocaleLowerCase().includes(normalizedSearch))) {
        return false;
      }
    }

    // perf: date range filtered server-side in loadData().

    return true;
  });

  // Sorting function
  const handleSort = (key: string) => {
    let direction: 'asc' | 'desc' = 'asc';
    if (sortConfig && sortConfig.key === key && sortConfig.direction === 'asc') {
      direction = 'desc';
    }
    setSortConfig({ key, direction });
  };

  // Accountant-priority sort: Pending Approval → Approved+Outstanding → Partial → Paid+Unlinked → Paid+Linked.
  // Only applies when no explicit user sort is active.
  const accountantPriorityRank = (exp: FinanceExpense): number => {
    const isReconciled = exp.bank_statement_lines && exp.bank_statement_lines.length > 0;
    if (exp.approval_status === 'pending_approval') return 0;
    if (exp.approval_status === 'rejected') return 1;
    if (exp.payment_method === null) {
      const balance = calculateCanonicalCashPayable(exp) - (exp.paid_amount ?? 0);
      if (balance > 0.01 && (exp.paid_amount ?? 0) > 0) return 2; // Partial
      if (balance > 0.01) return 2; // Approved but Outstanding
      return 3; // Paid (A/P settled)
    }
    if (!isReconciled) return 4; // Paid but Unlinked
    return 5; // Paid & Linked
  };

  const sortedExpenses = [...filteredExpenses].sort((a, b) => {
    if (!sortConfig) {
      const rankA = accountantPriorityRank(a);
      const rankB = accountantPriorityRank(b);
      if (rankA !== rankB) return rankA - rankB;
      // Secondary: newest first within the same rank
      return new Date(b.expense_date).getTime() - new Date(a.expense_date).getTime();
    }

    const { key, direction } = sortConfig;
    let aValue: any;
    let bValue: any;

    if (key === 'date') {
      aValue = new Date(a.expense_date).getTime();
      bValue = new Date(b.expense_date).getTime();
    } else if (key === 'category') {
      const aCat = expenseCategories.find(c => c.value === a.expense_category);
      const bCat = expenseCategories.find(c => c.value === b.expense_category);
      aValue = aCat?.label?.toLowerCase() || '';
      bValue = bCat?.label?.toLowerCase() || '';
    } else if (key === 'amount') {
      aValue = calculateCanonicalExpenseTotal(a);
      bValue = calculateCanonicalExpenseTotal(b);
    } else if (key === 'description') {
      aValue = (a.description || '').toLowerCase();
      bValue = (b.description || '').toLowerCase();
    } else if (key === 'payment_method') {
      // Sort by payment method (bank expenses only - cash expenses are in Petty Cash)
      aValue = (a.payment_method || 'unknown').toLowerCase();
      bValue = (b.payment_method || 'unknown').toLowerCase();
    } else if (key === 'reconciliation') {
      // Sort by reconciliation status
      const aReconciled = a.bank_statement_lines && a.bank_statement_lines.length > 0;
      const bReconciled = b.bank_statement_lines && b.bank_statement_lines.length > 0;
      aValue = aReconciled ? 1 : 0;
      bValue = bReconciled ? 1 : 0;
    } else if (key === 'payment_status') {
      // Sort by payment status: Outstanding(0) < Partial(1) < Paid(2)
      const payRank = (e: FinanceExpense) => {
        if (e.payment_method !== null) return 2;
        const bal = calculateCanonicalCashPayable(e) - (e.paid_amount ?? 0);
        if (bal <= 0.01) return 2;
        if ((e.paid_amount ?? 0) > 0) return 1;
        return 0;
      };
      aValue = payRank(a);
      bValue = payRank(b);
    } else {
      aValue = a[key as keyof FinanceExpense];
      bValue = b[key as keyof FinanceExpense];
      if (typeof aValue === 'string') aValue = aValue.toLowerCase();
      if (typeof bValue === 'string') bValue = bValue.toLowerCase();
    }

    if (aValue < bValue) return direction === 'asc' ? -1 : 1;
    if (aValue > bValue) return direction === 'asc' ? 1 : -1;
    return 0;
  });

  const exportToCSV = async () => {
    if (filteredExpenses.length === 0) {
      alert('No expenses to export');
      return;
    }

    let exportAccountRows: ExpenseExportAccount[] = [];
    try {
      const { data, error } = await supabase.rpc('get_expense_export_accounts', {
        p_expense_ids: filteredExpenses.map(expense => expense.id),
      });
      if (error) throw error;
      exportAccountRows = (data || []) as ExpenseExportAccount[];
    } catch (error) {
      console.error('Error resolving Expense export accounts:', error);
      alert('Unable to resolve Chart of Account details. Please try again after the accounting export setup is available.');
      return;
    }

    const exportAccounts = Object.fromEntries(
      exportAccountRows.map(account => [account.expense_id, account]),
    );

    const documentNumbers = Object.fromEntries(filteredExpenses.map((expense) => [expense.id, expense.voucher_number || expense.invoice_number || expense.id]));
    const bankAccounts = Object.fromEntries(filteredExpenses.map((expense) => [
      expense.id,
      expense.bank_accounts
        ? (expense.bank_accounts.alias || expense.bank_accounts.bank_name)
        : (expense.bank_statement_lines?.[0]?.bank_accounts?.alias || expense.bank_statement_lines?.[0]?.bank_accounts?.bank_name || ''),
    ]));
    let postedJournals;
    try {
      postedJournals = await getPostedJournalsForExport(
        filteredExpenses.map((expense) => expense.id), ['expense', 'expenses'], documentNumbers, 'Expenses', bankAccounts,
      );
    } catch (error) {
      console.error('Error resolving Expense journal lines:', error);
      alert('Unable to resolve posted journal lines for this export.');
      return;
    }

    const rows: ReconciliationSummaryRow[] = filteredExpenses.map(exp => {
      const category = expenseCategories.find(c => c.value === exp.expense_category);
      const linkedTo =
        exp.import_containers?.container_ref ||
        exp.delivery_challans?.challan_number ||
        '';
      const bankInfo = exp.bank_accounts
        ? (exp.bank_accounts.alias || exp.bank_accounts.bank_name)
        : (exp.bank_statement_lines?.[0]?.bank_accounts?.alias ||
           exp.bank_statement_lines?.[0]?.bank_accounts?.bank_name ||
           '');
      // Payment status (independent of reconciliation)
      let paymentStatus = 'Paid';
      if (exp.payment_method === null) {
        const balance = calculateCanonicalCashPayable(exp) - (exp.paid_amount ?? 0);
        if (balance > 0.01 && (exp.paid_amount ?? 0) > 0) paymentStatus = 'Partial';
        else if (balance > 0.01) paymentStatus = 'Outstanding';
      }
      // Recon status (independent of payment)
      const isReconciled = exp.bank_statement_lines && exp.bank_statement_lines.length > 0;
      const reconStatus = isReconciled ? 'Linked' : 'Unlinked';
      const account = exportAccounts[exp.id];
      const journal = postedJournals.get(exp.id);
      const totals = calculateExpenseTotals(exp);
      const pphCode = taxCodes.find((code) => code.id === exp.pph_code_id)?.code || '';
      const pphColumn = pphCode.toUpperCase().replace(/[^A-Z0-9]/g, '');
      const partyName = exp.staff_id
        ? staffRoster.find(s => s.id === exp.staff_id)?.full_name || ''
        : exp.suppliers?.company_name || '';
      const actualBankAmount = exp.bank_statement_lines?.reduce((sum, line) => sum + Math.abs(Number(line.debit_amount || 0) - Number(line.credit_amount || 0)), 0) || 0;
      return {
        'Source Module': 'Expenses',
        'Document Type': exp.expense_type || 'Expense',
        'Document Number': documentNumbers[exp.id],
        'Document Date': exp.expense_date,
        'Posting Date': journal?.date || '',
        'Journal Number': journal?.number || '',
        'Journal Status': exp.effective_posting_state === 'REVERSED'
          ? 'Cancelled'
          : exp.effective_posting_state === 'REPLACED'
            ? (journal?.status || 'Posted')
            : journal?.status || 'Not posted',
        'Approval Status': exp.effective_posting_state === 'REVERSED'
          ? 'Cancelled'
          : exp.effective_posting_state === 'REPLACED'
            ? 'Approved'
            : exp.effective_posting_state || exp.approval_status || '',
        'Payment Status': exp.effective_posting_state === 'REVERSED' ? 'Cancelled' : paymentStatus,
        'Reconciliation Status': exp.effective_posting_state === 'REVERSED' ? 'Unlinked' : reconStatus,
        'Party Type': exp.staff_id ? 'Employee' : exp.suppliers ? 'Supplier' : '',
        'Party Name': partyName,
        'Category Parent': category?.group || '',
        'Leaf Category': category?.label || exp.expense_category,
        Currency: getExpenseCurrency(exp),
        'Exchange Rate': Number(exp.exchange_rate || 1),
        'Gross Amount': calculateCanonicalExpenseTotal(exp),
        Discount: '',
        'DPP / Tax Base': Number(exp.dpp_amount ?? exp.amount ?? 0),
        PPN: Number(exp.ppn_amount || 0),
        PPh21: pphColumn.includes('PPH21') ? Number(exp.pph_amount || 0) : '',
        PPh22: pphColumn.includes('PPH22') ? Number(exp.pph_amount || 0) : '',
        PPh23: pphColumn.includes('PPH23') ? Number(exp.pph_amount || 0) : '',
        'PPh4(2)': pphColumn.includes('PPH42') ? Number(exp.pph_amount || 0) : '',
        'Other Taxes': pphCode && !/PPH(21|22|23|42)/.test(pphColumn) ? Number(exp.pph_amount || 0) : Number(exp.stamp_duty_amount || 0) || '',
        'Bank Charges': totals.bankChargesAmount || '',
        'Salary Advance': '',
        'Other Deductions': '',
        'Net Settlement Amount': totals.settlementAmount,
        'Actual Bank Amount': actualBankAmount || '',
        'Settlement Difference': actualBankAmount ? actualBankAmount - totals.settlementAmount : '',
        'Primary COA Code': account?.coa_code || category?.coaCode || '',
        'Primary COA Name': account?.coa_name || category?.coaName || '',
        'Bank Account': bankInfo,
        'Bank Statement Reference': exp.bank_statement_lines?.[0]?.description || '',
        'Tax Period': '',
        'Tax Reference / NTPN (where applicable)': exp.invoice_number || '',
        Remarks: [linkedTo, exp.description || ''].filter(Boolean).join(' — '),
      };
    });
    writeReconciliationWorkbook(rows, [...postedJournals.values()].flatMap((journal) => journal.lines), `expenses_reconciliation_${startDate || 'all'}_to_${endDate || 'all'}.xlsx`);
  };

  const getTypeColor = (type: string) => {
    switch (type) {
      case 'import': return 'bg-blue-100 text-blue-800 border-blue-300';
      case 'sales': return 'bg-green-100 text-green-800 border-green-300';
      case 'staff': return 'bg-purple-100 text-purple-800 border-purple-300';
      case 'operations': return 'bg-orange-100 text-orange-800 border-orange-300';
      case 'admin': return 'bg-gray-100 text-gray-800 border-gray-300';
      default: return 'bg-gray-100 text-gray-800 border-gray-300';
    }
  };

  const formatExpenseTotals = (expensesToTotal: FinanceExpense[]) => {
    const totals = expensesToTotal.reduce<Record<string, number>>((result, expense) => {
      const currency = getExpenseCurrency(expense);
      result[currency] = (result[currency] || 0) + calculateCanonicalExpenseTotal(expense);
      return result;
    }, {});
    return Object.entries(totals)
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([currency, amount]) => formatCurrency(amount, currency, {
        minimumFractionDigits: currency === 'IDR' ? 0 : 2,
        maximumFractionDigits: currency === 'IDR' ? 0 : 2,
      }))
      .join(' · ');
  };

  const expenseFormCurrency = normalizeCurrency(
    bankAccounts.find((bank) => bank.id === formData.bank_account_id)?.currency ?? formData.transaction_currency,
  );

  const formatDate = (dateString: string) => {
    if (!dateString) return '—';
    const [year, month, day] = dateString.slice(0, 10).split('-');
    return `${day}/${month}/${year?.slice(-2)}`;
  };

  return (
    <div className="space-y-4">
      {/* Compact single-strip header — KPIs + primary actions */}
      <div className="bg-gradient-to-r from-blue-600 to-blue-700 rounded px-2 py-1 text-white shadow-sm flex items-center justify-between gap-2">
        <div className="flex items-center gap-2">
          <h2 className="text-sm font-semibold text-gray-800 whitespace-nowrap">Expenses</h2>
          <div className="flex gap-1.5">
            <div className="bg-white/20 rounded px-1.5 py-0.5">
            <span className="text-blue-100 text-[9px] mr-1">EXPENSE TOTAL</span>
              <span className="text-[11px] font-bold">
                {formatExpenseTotals(filteredExpenses.filter(expense => expense.effective_posting_state === 'ACTIVE' || expense.effective_posting_state === 'REPLACED')) || formatCurrency(0)}
              </span>
            </div>
            <div className="bg-white/20 rounded px-1.5 py-0.5">
              <span className="text-blue-100 text-[9px] mr-1">LINKED</span>
              <span className="text-[11px] font-bold">
                {expenses.filter(e => reconciledExpenseIds.has(e.id)).length} / {expenses.length}
              </span>
            </div>
          </div>
        </div>
        <div className="flex items-center gap-1">
          <button
            onClick={() => {
              setHealthCheckOpen(o => !o);
              if (!healthCheckOpen && healthIssues.length === 0) loadHealthCheck();
            }}
            className={`relative inline-flex items-center gap-1 h-6 px-2 rounded font-medium text-[11px] border transition-colors ${healthCheckOpen ? 'bg-orange-50 border-orange-300 text-orange-700' : 'bg-white/95 border-transparent text-gray-700 hover:bg-white'}`}
            title="Finance Health Check"
          >
            <AlertCircle className="w-3 h-3" />
            Health
            {healthIssues.length > 0 && (
              <span className="absolute -top-1 -right-1 bg-red-500 text-white text-[9px] font-bold rounded-full w-3.5 h-3.5 flex items-center justify-center">
                {healthIssues.length}
              </span>
            )}
          </button>
          {canManage && (
            <button
              onClick={() => { resetForm(); setModalOpen(true); }}
              className="inline-flex items-center gap-1 h-6 px-2 bg-white text-blue-700 rounded font-semibold text-[11px] hover:bg-blue-50"
            >
              <Plus className="w-3 h-3" /> New
            </button>
          )}
        </div>
      </div>

      {/* Compact filter bar (single row) */}
      <div className="bg-white rounded border border-gray-200 px-2 py-1 flex items-center gap-2 flex-wrap">
        <div className="flex gap-0.5">
          {[
            { value: 'all', label: 'All' },
            { value: 'import', label: 'Import' },
            { value: 'sales', label: 'Sales' },
            { value: 'staff', label: 'Staff' },
            { value: 'operations', label: 'Ops' },
            { value: 'admin', label: 'Admin' },
          ].map((tab) => (
            <button
              key={tab.value}
              onClick={() => setFilterType(tab.value as any)}
              className={`h-6 px-2 rounded text-[11px] font-medium transition-colors ${
                filterType === tab.value ? 'bg-blue-600 text-white' : 'bg-gray-100 text-gray-600 hover:bg-gray-200'
              }`}
            >
              {tab.label}
            </button>
          ))}
        </div>

        <div className="h-4 w-px bg-gray-300"></div>

        <div className="flex gap-0.5">
          {[
            { value: 'all', label: 'All' },
            { value: 'reconciled', label: 'Linked' },
            { value: 'not_reconciled', label: 'Unlinked' },
          ].map((filter) => (
            <button
              key={filter.value}
              onClick={() => setReconFilter(filter.value as any)}
              className={`h-6 px-2 rounded text-[11px] font-medium transition-colors ${
                reconFilter === filter.value ? 'bg-green-600 text-white' : 'bg-gray-100 text-gray-600 hover:bg-gray-200'
              }`}
            >
              {filter.label}
            </button>
          ))}
        </div>

        <div className="h-4 w-px bg-gray-300"></div>

        <div className="flex gap-0.5">
          {[
            { value: 'all', label: 'All' },
            { value: 'pending_approval', label: 'Pending' },
            { value: 'approved', label: 'Approved' },
          ].map((filter) => (
            <button
              key={filter.value}
              onClick={() => setApprovalFilter(filter.value as any)}
              className={`h-6 px-2 rounded text-[11px] font-medium transition-colors ${
                approvalFilter === filter.value ? 'bg-amber-600 text-white' : 'bg-gray-100 text-gray-600 hover:bg-gray-200'
              }`}
            >
              {filter.label}
            </button>
          ))}
        </div>

        <select
          value={categoryFilter}
          onChange={(e) => setCategoryFilter(e.target.value)}
          className="h-6 px-1.5 border border-gray-300 rounded text-[11px] bg-white"
        >
          <option value="all">All Categories</option>
          {groupExpenseCategories(expenseCategories).map(([parent, categories]) => (
            <optgroup key={parent} label={parent}>
              {categories.map((category) => (
                <option key={category.value} value={category.value}>{category.label}</option>
              ))}
            </optgroup>
          ))}
        </select>

        {suppliers.length > 0 && (
          <select
            value={supplierFilter}
            onChange={(e) => setSupplierFilter(e.target.value)}
            className="h-6 px-1.5 border border-gray-300 rounded text-[11px] bg-white"
          >
            <option value="all">All Suppliers</option>
            <option value="no_supplier">— No Supplier —</option>
            {suppliers.map(s => (
              <option key={s.id} value={s.id}>{s.company_name}</option>
            ))}
          </select>
        )}

        <div className="relative">
          <Search className="absolute left-1.5 top-1/2 h-3 w-3 -translate-y-1/2 text-gray-400" />
          <input
            type="search"
            value={searchQuery}
            onChange={(event) => setSearchQuery(event.target.value)}
            placeholder="Search expenses"
            aria-label="Search expenses"
            className="h-6 w-44 rounded border border-gray-300 bg-white pl-6 pr-2 text-[11px]"
          />
        </div>

        <button
          onClick={exportToCSV}
          disabled={filteredExpenses.length === 0}
          className="ml-auto inline-flex items-center gap-1 h-6 px-2 bg-green-600 text-white rounded text-[11px] font-medium hover:bg-green-700 disabled:bg-gray-300 disabled:cursor-not-allowed"
        >
          <Download className="w-3 h-3" /> Export ({filteredExpenses.length})
        </button>
      </div>

      <div className="bg-white rounded-lg shadow-sm border border-gray-200 overflow-x-auto">
        <table className="min-w-full">
          <thead className="bg-gray-50 border-b border-gray-200">
            <tr>
              <th className="px-2 py-1.5 text-left text-xs font-semibold text-gray-600">No.</th>
              <th
                onClick={() => handleSort('date')}
                className="px-2 py-1.5 text-left text-xs font-semibold text-gray-600 cursor-pointer hover:bg-gray-100 select-none"
              >
                <div className="flex items-center gap-1">
                  Date
                  {sortConfig?.key === 'date' && (
                    <span className="text-blue-600 text-sm">{sortConfig.direction === 'asc' ? '↑' : '↓'}</span>
                  )}
                </div>
              </th>
              <th
                onClick={() => handleSort('category')}
                className="px-2 py-1.5 text-left text-xs font-semibold text-gray-600 cursor-pointer hover:bg-gray-100 select-none"
              >
                <div className="flex items-center gap-1">
                  Category
                  {sortConfig?.key === 'category' && (
                    <span className="text-blue-600 text-sm">{sortConfig.direction === 'asc' ? '↑' : '↓'}</span>
                  )}
                </div>
              </th>
              <th className="px-2 py-1.5 text-left text-xs font-semibold text-gray-600">Context</th>
              <th
                onClick={() => handleSort('description')}
                className="px-2 py-1.5 text-left text-xs font-semibold text-gray-600 cursor-pointer hover:bg-gray-100 select-none"
              >
                <div className="flex items-center gap-1">
                  Description
                  {sortConfig?.key === 'description' && (
                    <span className="text-blue-600 text-sm">{sortConfig.direction === 'asc' ? '↑' : '↓'}</span>
                  )}
                </div>
              </th>
              <th
                onClick={() => handleSort('amount')}
                className="px-2 py-1.5 text-right text-xs font-semibold text-gray-600 cursor-pointer hover:bg-gray-100 select-none"
              >
                <div className="flex items-center justify-end gap-1">
                  Expense Total
                  {sortConfig?.key === 'amount' && (
                    <span className="text-blue-600 text-sm">{sortConfig.direction === 'asc' ? '↑' : '↓'}</span>
                  )}
                </div>
              </th>
              <th className="px-2 py-1.5 text-center text-xs font-semibold text-gray-600">Type</th>
              <th
                onClick={() => handleSort('payment_status')}
                className="px-2 py-1.5 text-center text-xs font-semibold text-gray-600 cursor-pointer hover:bg-gray-100 transition-colors"
              >
                <div className="flex items-center justify-center gap-1">
                  Payment
                  {sortConfig?.key === 'payment_status' && (
                    <span className="text-blue-600 text-sm">{sortConfig.direction === 'asc' ? '↑' : '↓'}</span>
                  )}
                </div>
              </th>
              <th
                onClick={() => handleSort('reconciliation')}
                className="px-2 py-1.5 text-center text-xs font-semibold text-gray-600 cursor-pointer hover:bg-gray-100 transition-colors"
              >
                <div className="flex items-center justify-center gap-1">
                  Recon
                  {sortConfig?.key === 'reconciliation' && (
                    <span className="text-blue-600 text-sm">{sortConfig.direction === 'asc' ? '↑' : '↓'}</span>
                  )}
                </div>
              </th>
              <th className="px-2 py-1.5 text-center text-xs font-semibold text-gray-600">Approval</th>
              {canManage && <th className="px-2 py-1.5 text-center text-xs font-semibold text-gray-600">Actions</th>}
            </tr>
          </thead>
          <tbody className="divide-y divide-gray-100">
            {loading ? (
              <tr>
                <td colSpan={canManage ? 11 : 10} className="px-6 py-8 text-center text-gray-500">
                  Loading...
                </td>
              </tr>
            ) : filteredExpenses.length === 0 ? (
              <tr>
                <td colSpan={canManage ? 11 : 10} className="px-6 py-8 text-center text-gray-500">
                  No expenses found
                </td>
              </tr>
            ) : (
              sortedExpenses.map((expense) => {
                const category = expenseCategories.find(c => c.value === expense.expense_category);
                const postingState = expense.effective_posting_state || 'AMBIGUOUS';
                const isCancelledPosting = postingState === 'REVERSED';

                // Fix: Check reconciliation from actual bank_statement_lines relationship
                const isReconciled = expense.bank_statement_lines && expense.bank_statement_lines.length > 0;

                return (
                  <tr key={expense.id} className="hover:bg-blue-50/50 transition-colors">
                    <td className="px-2 py-1.5 whitespace-nowrap">
                      <div className="font-mono text-xs text-gray-500">
                        {expense.voucher_number || '—'}
                      </div>
                    </td>
                    <td className="px-2 py-1.5 whitespace-nowrap">
                      <div className="text-xs text-gray-900 font-medium">
                        {formatDate(expense.expense_date)}
                      </div>
                    </td>
                    <td className="px-2 py-1.5">
                      <div className="text-xs font-medium text-gray-900">
                        {category?.label || expense.expense_category}
                      </div>
                    </td>
                    <td className="px-2 py-1.5">
                      {expense.import_container_id && expense.import_containers ? (
                        <div className="flex items-center gap-1.5 text-xs">
                          <Package className="w-3.5 h-3.5 text-blue-600 flex-shrink-0" />
                          <span className="text-blue-700 font-medium">
                            {expense.import_containers.container_ref}
                          </span>
                        </div>
                      ) : expense.delivery_challan_id && expense.delivery_challans ? (
                        <div className="flex items-center gap-1.5 text-xs">
                          <Truck className="w-3.5 h-3.5 text-green-600 flex-shrink-0" />
                          <span className="text-green-700 font-medium">
                            {expense.delivery_challans.challan_number}
                          </span>
                        </div>
                      ) : category?.requiresContainer ? (
                        <span className="inline-flex items-center gap-1 px-1.5 py-0.5 text-[10px] font-medium text-red-700 bg-red-50 border border-red-200 rounded">
                          ⚠️ Missing
                        </span>
                      ) : (
                        <span className="text-gray-400 text-xs">—</span>
                      )}
                    </td>
                    <td className="px-2 py-1.5">
                      <div className="text-xs text-gray-700 line-clamp-1">
                        {(() => {
                          const rules = getCategoryFieldRules(expense.expense_category);
                          let partyName = '';
                          if (rules.staff === 'show' && expense.staff_id) {
                            partyName = staffRoster.find(s => s.id === expense.staff_id)?.full_name || '';
                          } else if (expense.suppliers) {
                            partyName = expense.suppliers.company_name;
                          }
                          const desc = expense.description || '';
                          if (partyName && desc) return `[${partyName}] ${desc}`;
                          if (partyName) return `[${partyName}]`;
                          return desc || '—';
                        })()}
                      </div>
                    </td>
                    <td className="px-2 py-1.5 whitespace-nowrap text-right">
                      <div className="text-xs font-semibold text-gray-900">
                        {formatCurrency(calculateCanonicalExpenseTotal(expense), getExpenseCurrency(expense), {
                          minimumFractionDigits: getExpenseCurrency(expense) === 'IDR' ? 0 : 2,
                          maximumFractionDigits: getExpenseCurrency(expense) === 'IDR' ? 0 : 2,
                        })}
                      </div>
                    </td>
                    <td className="px-2 py-1.5 whitespace-nowrap text-center">
                      <span className={`inline-flex px-1.5 py-0.5 text-[10px] font-bold rounded ${getTypeColor(category?.type || 'admin')}`}>
                        {category?.type === 'import' && 'CAP'}
                        {category?.type === 'sales' && 'EXP'}
                        {category?.type === 'staff' && 'EXP'}
                        {category?.type === 'operations' && 'EXP'}
                        {category?.type === 'admin' && 'EXP'}
                      </span>
                    </td>
                    <td className="px-2 py-1.5 whitespace-nowrap text-center">
                      {(() => {
                        if (postingState === 'REVERSED') {
                          return <span className="inline-flex items-center justify-center w-5 h-5 rounded-full bg-gray-100 text-gray-500" title="Cancelled"><Banknote className="w-3 h-3" /></span>;
                        }
                        // Payment status — Banknote icon colored by status
                        if (expense.payment_method !== null) {
                          return (
                            <span
                              className="inline-flex items-center justify-center w-5 h-5 rounded-full bg-green-100 text-green-700"
                              title="Paid"
                            >
                              <Banknote className="w-3 h-3" />
                            </span>
                          );
                        }
                        const billBalance = calculateCanonicalCashPayable(expense) - (expense.paid_amount ?? 0);
                        if (billBalance <= 0.01) {
                          return (
                            <span
                              className="inline-flex items-center justify-center w-5 h-5 rounded-full bg-green-100 text-green-700"
                              title="Paid"
                            >
                              <Banknote className="w-3 h-3" />
                            </span>
                          );
                        }
                        if ((expense.paid_amount ?? 0) > 0) {
                          return (
                            <span
                              className="inline-flex items-center justify-center w-5 h-5 rounded-full bg-yellow-100 text-yellow-700"
                              title={`Partial · Paid ${formatCurrency(expense.paid_amount ?? 0, getExpenseCurrency(expense))} of ${formatCurrency(calculateCanonicalCashPayable(expense), getExpenseCurrency(expense))} · ${formatCurrency(billBalance, getExpenseCurrency(expense))} left`}
                            >
                              <Banknote className="w-3 h-3" />
                            </span>
                          );
                        }
                        return (
                          <span
                            className="inline-flex items-center justify-center w-5 h-5 rounded-full bg-red-100 text-red-700"
                            title="Outstanding"
                          >
                            <Banknote className="w-3 h-3" />
                          </span>
                        );
                      })()}
                    </td>
                    <td className="px-2 py-1.5 whitespace-nowrap text-center">
                      {isReconciled ? (
                        <span
                          className={`inline-flex items-center justify-center w-5 h-5 rounded-full ${isCancelledPosting ? 'bg-gray-100 text-gray-500' : 'bg-green-100 text-green-700'}`}
                          title={isCancelledPosting ? 'Cancelled' : 'Linked'}
                        >
                          <Link2 className="w-3 h-3" />
                        </span>
                      ) : (
                        <span
                          className="inline-flex items-center justify-center w-5 h-5 rounded-full bg-gray-100 text-gray-400"
                          title="Unlinked"
                        >
                          <Link2 className="w-3 h-3" />
                        </span>
                      )}
                    </td>
                    <td className="px-2 py-1.5 whitespace-nowrap text-center">
                      {postingState === 'ACTIVE' ? (
                        <span
                          className="inline-flex items-center justify-center w-5 h-5 rounded-full bg-green-100 text-green-700"
                          title="Approved · Active posting"
                        >
                          <ClipboardCheck className="w-3 h-3" />
                        </span>
                      ) : postingState === 'REPLACED' ? (
                        <span className="inline-flex items-center justify-center w-5 h-5 rounded-full bg-green-100 text-green-700" title="Approved · Current posting">
                          <ClipboardCheck className="w-3 h-3" />
                        </span>
                      ) : postingState === 'REVERSED' ? (
                        <span className="inline-flex items-center justify-center w-5 h-5 rounded-full bg-gray-200 text-gray-600" title="Cancelled">
                          <RotateCcw className="w-3 h-3" />
                        </span>
                      ) : postingState === 'REJECTED' ? (
                        <span
                          className="inline-flex items-center justify-center w-5 h-5 rounded-full bg-red-100 text-red-700"
                          title={`Rejected${expense.rejection_reason ? ': ' + expense.rejection_reason : ''}`}
                        >
                          <ClipboardCheck className="w-3 h-3" />
                        </span>
                      ) : postingState === 'AMBIGUOUS' ? (
                        <span className="inline-flex items-center justify-center w-5 h-5 rounded-full bg-orange-100 text-orange-700" title={`Review required · ${expense.posting_lifecycle?.ambiguity_reason || 'inconsistent accounting evidence'}`}>
                          <AlertCircle className="w-3 h-3" />
                        </span>
                      ) : (
                        <span
                          className="inline-flex items-center justify-center w-5 h-5 rounded-full bg-yellow-100 text-yellow-700"
                          title="Pending"
                        >
                          <ClipboardCheck className="w-3 h-3" />
                        </span>
                      )}
                    </td>
                    {canManage && (
                      <td className="px-2 py-1.5 whitespace-nowrap text-center">
                        <div className="flex items-center justify-center gap-0.5">
                          <FinanceActionButton
                            action="view"
                            onClick={async () => {
                              setViewingExpense(expense);
                              setViewModalOpen(true);
                              if (expense.document_urls?.length) {
                                const entries = await Promise.all(
                                  expense.document_urls.map(async (url) => [url, await getSignedUrl(url)] as [string, string])
                                );
                                setSignedUrlCache(prev => ({ ...prev, ...Object.fromEntries(entries) }));
                              }
                            }}
                          />
                          {(postingState === 'ACTIVE' || postingState === 'PENDING' || postingState === 'REJECTED') && (
                            <FinanceActionButton action="edit" onClick={() => handleEdit(expense)} />
                          )}
                          {onSettleBill &&
                            expense.payment_method === null &&
                            postingState === 'ACTIVE' &&
                            (expense.supplier_id || expense.staff_id) &&
                            (expense.amount || 0) - (expense.paid_amount ?? 0) > 0.01 && (
                            <button
                              onClick={() => onSettleBill({
                                id: expense.id,
                                supplier_id: expense.supplier_id ?? null,
                                staff_id: expense.staff_id ?? null,
                                balance_amount: (expense.amount || 0) - (expense.paid_amount ?? 0),
                              })}
                              className="p-1 text-emerald-600 hover:bg-emerald-50 rounded transition-colors"
                              title="Settle via Payment Voucher"
                            >
                              <Banknote className="w-3.5 h-3.5" />
                            </button>
                          )}
                          {isAdmin && postingState === 'PENDING' && (
                            <>
                              <span className="w-px h-4 bg-gray-200 mx-0.5" aria-hidden="true" />
                              <FinanceActionButton
                                action="approve"
                                onClick={() => handleApproveExpense(expense.id)}
                                disabled={approvalLoading === expense.id}
                              />
                              <FinanceActionButton
                                action="reject"
                                onClick={() => { setRejectionTarget({ id: expense.id, type: 'expense' }); setRejectionModalOpen(true); }}
                                disabled={approvalLoading === expense.id}
                              />
                            </>
                          )}
                          {isAdmin && postingState === 'ACTIVE' && (
                            <>
                              <span className="w-px h-4 bg-gray-200 mx-0.5" aria-hidden="true" />
                              <FinanceActionButton
                                action="reverse"
                                label="Cancel Posting"
                                onClick={() => void handleCancelPostingRequest(expense)}
                                disabled={cancelPostingLoading && cancelPostingTarget?.id === expense.id}
                              />
                            </>
                          )}
                          {(postingState === 'PENDING' || postingState === 'REJECTED') && (
                            <>
                              <span className="w-px h-4 bg-gray-200 mx-0.5" aria-hidden="true" />
                              <FinanceActionButton action="delete" onClick={() => handleDelete(expense.id)} />
                            </>
                          )}
                        </div>
                      </td>
                    )}
                  </tr>
                );
              })
            )}
            {/* Totals Row */}
            {!loading && sortedExpenses.length > 0 && (
              <tr className="bg-gradient-to-r from-blue-50 to-blue-100 border-t-2 border-blue-200 font-bold">
                <td colSpan={5} className="px-2 py-1.5 text-right text-xs text-gray-900">
                  TOTAL ({sortedExpenses.length} expenses):
                </td>
                <td className="px-2 py-1.5 text-right text-sm text-blue-900 font-bold">
                  {formatExpenseTotals(sortedExpenses.filter(expense => expense.effective_posting_state === 'ACTIVE' || expense.effective_posting_state === 'REPLACED'))}
                </td>
                <td colSpan={canManage ? 5 : 4}></td>
              </tr>
            )}
          </tbody>
        </table>
      </div>

      {modalOpen && (
        <FinanceModal
          isOpen={modalOpen}
          onClose={() => { setModalOpen(false); resetForm(); }}
          title={editingExpense ? 'Edit Expense' : 'Record New Expense'}
          subtitle={editingExpense?.voucher_number || undefined}
          size="2xl"
          footer={
            <>
              <button type="button" onClick={() => { setModalOpen(false); resetForm(); }} className={F_BTN_SECONDARY}>
                Cancel
              </button>
              <button type="submit" form="expense-form" className={F_BTN_PRIMARY}>
                {editingExpense ? 'Update' : 'Save'} Expense
              </button>
            </>
          }
        >
          <form id="expense-form" onSubmit={handleSubmit}>
            {/* ══════════════════════════════════════════════════════════════
                 SAP Business One – style header
                 Horizontal-label 3-column grid. Every field is `label | input`
                 on ONE line. Fields flow left-to-right in the 12-col grid.
                 Same handlers as before — pure layout change (STEP 4).
                 ══════════════════════════════════════════════════════════════ */}
            {(() => {
              const rules   = getCategoryFieldRules(formData.expense_category);
              const taxCfg  = selectedDocType ? DOCUMENT_TYPE_TAX_CONFIG[selectedDocType as DocumentType] : null;
              const category = expenseCategories.find(c => c.value === formData.expense_category);
              const isBroker = formData.expense_category === 'import_broker';
              // Tax is an invoice attribute, not a document-type/category lock.
              // Only PIB (its own tax breakdown) and staff advances are excluded.
              // This lets an operating service such as fumigation carry PPN and
              // any supported PPh code on the same invoice.
              const isPib = category?.taxBehavior === 'pib_import';
              const supportsPpn = !!category && !isPib && category.taxBehavior !== 'advance' && category.taxBehavior !== 'salary';
              const supportsPph = !!category && !isPib && category.taxBehavior !== 'advance';
              return (
                <div className="pb-2 mb-1 border-b border-gray-200 flex flex-col gap-1">
                  <p className="text-[10px] font-bold text-gray-400 uppercase tracking-widest">Basic Information</p>
                  {/* ── Row A: Date · Invoice No · Category · Supplier ── */}
                  <SapRow>
                    <SapField
                      label={rules.billingMonth === 'show' ? 'Billing Date' : 'Date'}
                      required span={3}
                    >
                      <input type="date" value={formData.expense_date}
                        onChange={(e) => {
                          const d = e.target.value;
                          setFormData(prev => ({
                            ...prev, expense_date: d,
                            due_date: getDueDateFromTerms(d, selectedSupplier?.payment_terms_days ?? 30),
                          }));
                        }}
                        className={SAP_INPUT} required
                        title={rules.billingMonth === 'show' ? 'Date printed on the utility bill' : undefined} />
                    </SapField>
                    <SapField
                      label={rules.billingMonth === 'show' ? 'Billing Reference' : 'Supplier Invoice Number'}
                      span={3}
                    >
                      <input type="text" value={formData.invoice_number}
                        onChange={(e) => setFormData({ ...formData, invoice_number: e.target.value })}
                        className={SAP_INPUT}
                        placeholder={rules.billingMonth === 'show' ? 'Bill number / account ref' : 'Enter invoice number'} />
                    </SapField>
                    <SapField label="Category" required span={3}>
                      <ExpenseCategorySelect
                        value={formData.expense_category}
                        onChange={(val) => {
                          const cat = val || '';
                          let dt: DocumentType | '' = '';
                          for (const [docType, cats] of Object.entries(DOCUMENT_TYPE_GROUPS) as [DocumentType, string[]][]) {
                            if (cats.includes(cat)) { dt = docType; break; }
                          }
                          setSelectedDocType(dt);
                          if (
                            getCategoryFieldRules(cat).salaryMonth === 'show'
                            && getCategoryFieldRules(formData.expense_category).salaryMonth !== 'show'
                          ) {
                            setPeriodLabel(currentFinancePeriod());
                          }
                          setFormData(prev => ({
                            ...prev,
                            expense_category: cat,
                            ...(cat === 'non_permanent_employee_fee'
                              ? { pph_code_id: taxCodes.find(tc => tc.code === 'PPH21')?.id || prev.pph_code_id }
                              : {}),
                          }));
                        }}
                        categories={expenseCategories}
                      />
                    </SapField>
                    <SapField
                      label={rules.staff === 'show' ? 'Staff' : rules.utility === 'show' ? 'Utility' : (isBroker ? 'Broker' : 'Supplier')}
                      required={rules.staff === 'show' || rules.utility === 'show' || rules.supplier === 'show'}
                      span={3}
                      right={selectedSupplier && rules.staff !== 'show' && rules.utility !== 'show' ? (
                        <div className="flex gap-1 text-[9px] shrink-0">
                          {selectedSupplier.pkp_status && <span className="px-1 py-0.5 bg-green-100 text-green-700 rounded font-medium">PKP</span>}
                          {selectedSupplier.payment_terms_days ? <span className="px-1 py-0.5 bg-blue-100 text-blue-700 rounded font-medium">N{selectedSupplier.payment_terms_days}</span> : null}
                        </div>
                      ) : null}>
                      {rules.staff === 'show' ? (
                        <SearchableSelect
                          value={selectedStaffId}
                          onChange={(val) => {
                            setSelectedStaffId(val);
                            const staff = staffRoster.find((item) => item.id === val);
                            setFormData(prev => ({
                              ...prev,
                              supplier_id: '',
                              ...(prev.expense_category === 'salary' && staff
                                // Fresh staff selection: gross from Staff Master and a
                                // clean PPh21 override so the canonical calculator
                                // repopulates from the new staff's configuration
                                // instead of carrying the previous staff's value.
                                ? { amount: Number(staff.monthly_salary) || 0, pph_amount: 0 }
                                : {}),
                            }));
                            setSelectedSupplier(null);
                          }}
                          options={[{ value: '', label: '— None —' }, ...staffRoster.map(s => ({ value: s.id, label: `${s.full_name}${s.department ? ' · ' + s.department : ''}` }))]}
                          placeholder="Search staff..."
                        />
                      ) : rules.utility === 'show' ? (
                        <SearchableSelect
                          value={selectedUtilityId}
                          onChange={(val) => {
                            setSelectedUtilityId(val);
                            const util = utilityRoster.find(u => u.id === val);
                            if (util?.supplier_id) handleSupplierSelect(util.supplier_id);
                            else { setFormData(prev => ({ ...prev, supplier_id: '' })); setSelectedSupplier(null); }
                          }}
                          options={[{ value: '', label: '— None —' }, ...utilityRoster.map(u => ({ value: u.id, label: `${u.provider_name} · ${u.utility_type}` }))]}
                          placeholder="Search utility..."
                        />
                      ) : (
                        <SearchableSelect
                          value={formData.supplier_id}
                          onChange={(val) => handleSupplierSelect(val)}
                          options={[{ value: '', label: '— None —' }, ...suppliers.map((s) => ({ value: s.id, label: `${s.company_name}${s.pkp_status ? ' ✓PKP' : ''}` }))]}
                          placeholder="Search supplier..."
                          onCreateNew={(name) => { setQuickAddSupplierName(name); setShowQuickAddSupplier(true); }}
                        />
                      )}
                    </SapField>
                  </SapRow>

                  {/* ── Row B: Period (conditional — salary / billing month only) ── */}
                  {(rules.salaryMonth === 'show' || rules.billingMonth === 'show') && (
                    <SapRow>
                      {rules.salaryMonth === 'show' ? (
                        <SapField label="Salary Month" required span={3}>
                          <select value={normalizeSalaryPeriod(periodLabel || currentFinancePeriod())}
                            onChange={(e) => setPeriodLabel(e.target.value)}
                            className={SAP_INPUT}>
                            {SALARY_PERIOD_OPTIONS.map(({ value, label }) => (
                              <option key={value} value={value}>{label}</option>
                            ))}
                          </select>
                        </SapField>
                      ) : (
                        <SapField label="Billing Month" required span={3}>
                          <select value={normalizeSalaryPeriod(periodLabel || currentFinancePeriod())}
                            onChange={(e) => setPeriodLabel(e.target.value)}
                            className={SAP_INPUT} title="The month this bill covers">
                            {SALARY_PERIOD_OPTIONS.map(({ value, label }) => (
                              <option key={value} value={value}>{label}</option>
                            ))}
                          </select>
                        </SapField>
                      )}
                    </SapRow>
                  )}

                  {rules.staff === 'show' && formData.expense_category === 'salary' && selectedStaffId && salaryCalculation && (
                    <div className="rounded border border-amber-200 bg-amber-50 px-3 py-2">
                      <div className="flex items-center justify-between gap-3">
                        <div>
                          <div className="text-xs font-semibold text-amber-900">Canonical Salary Calculation</div>
                          <div className="text-[10px] text-amber-700">Outstanding advances are applied automatically, oldest first.</div>
                        </div>
                        <span className="text-[10px] font-semibold text-emerald-700">Automatic FIFO</span>
                      </div>
                      {salaryAdvances.length > 0 && <div className="mt-2 space-y-1 text-xs">
                        {salaryAdvances.map((advance) => (
                          <div key={advance.advance_id} className="flex items-center justify-between border-t border-amber-100 pt-1 text-amber-900">
                            <span>{advance.voucher_number} · {new Date(advance.voucher_date).toLocaleDateString('en-GB')}</span>
                            <span className="font-mono">Available {formatCurrency(advance.available_amount, expenseFormCurrency)}</span>
                          </div>
                        ))}
                      </div>}
                      <div className="mt-2 grid grid-cols-5 gap-2 border-t border-amber-200 pt-2 text-xs">
                        <div><span className="text-amber-700">Gross Salary</span><div className="font-mono font-semibold text-amber-950">{formatCurrency(salaryCalculation.gross_salary, expenseFormCurrency)}</div></div>
                        <div><span className="text-amber-700">Less Advance</span><div className="font-mono font-semibold text-amber-950">−{formatCurrency(salaryCalculation.outstanding_salary_advances, expenseFormCurrency)}</div></div>
                        <div><span className="text-amber-700">Less PPh21</span><div className="font-mono font-semibold text-amber-950">−{formatCurrency(salaryCalculation.pph21_amount, expenseFormCurrency)}</div></div>
                        <div><span className="text-amber-700">Less BPJS</span><div className="font-mono font-semibold text-amber-950">−{formatCurrency(salaryCalculation.bpjs_amount, expenseFormCurrency)}</div></div>
                        <div><span className="text-amber-700">Net Payable</span><div className="font-mono font-bold text-emerald-800">{formatCurrency(salaryCalculation.net_salary_payable, expenseFormCurrency)}</div></div>
                      </div>
                    </div>
                  )}

                  {/* ── Row C: Amount · DPP · PPN · PPh · PPh Code · Stamp · Bank Chg · Container · DC · Asset ── */}
                  <SapRow>
                    <SapField label={`${isBroker ? 'Broker Invoice Amount' : formData.expense_category === 'salary' ? 'Gross Salary Amount' : 'Amount'} (${expenseFormCurrency})`} required span={3}>
                      <MoneyInput value={formData.amount} required placeholder="0.00"
                        onChange={(amt) => {
                          setFormData(prev => {
                            const mode = prev.ppn_calc_mode || 'standard';
                            const rate = prev.ppn_rate || 11;
                            const ppn = !isBroker && mode === 'standard' && selectedSupplier?.pkp_status
                              ? Math.round(amt * rate / 100) : prev.ppn_amount;
                            const tc = prev.pph_code_id ? taxCodes.find(t => t.id === prev.pph_code_id) : null;
                            const pph = tc ? Math.round(amt * tc.rate / 100) : prev.pph_amount;
                            return { ...prev, amount: amt, ppn_amount: ppn, pph_amount: pph };
                          });
                        }}
                        className={SAP_INPUT + ' !text-right !font-mono !font-semibold'} />
                    </SapField>
                    {isBroker && (
                      <SapField label="Invoice DPP (Tax Base)" span={3}>
                        <MoneyInput value={formData.dpp_amount} placeholder="0.00"
                          onChange={(dpp) => setFormData(prev => {
                            const rate = prev.ppn_rate ?? 11;
                            const isManual = prev.ppn_calc_mode === 'manual';
                            const ppn = isManual ? prev.ppn_amount : Math.round(dpp * rate / 100);
                            return { ...prev, dpp_amount: dpp, ppn_amount: ppn };
                          })}
                          className={SAP_INPUT + ' !text-right !font-mono'} />
                      </SapField>
                    )}
                    {supportsPpn && !isBroker && formData.ppn_calc_mode === 'dpp_nilai_lain' && (
                      <>
                        <SapField label="DPP (Nilai Lain)" span={3}>
                          <MoneyInput value={formData.dpp_amount} placeholder="0"
                            onChange={(dpp) => setFormData(prev => ({ ...prev, dpp_amount: dpp, ppn_amount: Math.round(dpp * (prev.ppn_rate || 11) / 100) }))}
                            className={SAP_INPUT + ' !text-right !font-mono'} />
                        </SapField>
                        <SapField label="PPN" span={3}
                          right={<PpnModeToggle value={formData.ppn_calc_mode} onChange={(mode) => setFormData(prev => {
                            const rate = prev.ppn_rate || 11;
                            let ppn = prev.ppn_amount;
                            if (mode === 'standard') ppn = selectedSupplier?.pkp_status ? Math.round((prev.amount || 0) * rate / 100) : 0;
                            else if (mode === 'dpp_nilai_lain') ppn = Math.round((prev.dpp_amount || 0) * rate / 100);
                            return { ...prev, ppn_calc_mode: mode, ppn_amount: ppn, ppn_manual_override: mode === 'manual', dpp_amount: mode === 'dpp_nilai_lain' ? (prev.dpp_amount || prev.amount || 0) : 0 };
                          })} />}>
                          <MoneyInput value={formData.ppn_amount} placeholder="0"
                            onChange={(v) => setFormData(prev => ({ ...prev, ppn_amount: v }))}
                            className={SAP_INPUT + ' !text-right !font-mono text-blue-700'} />
                        </SapField>
                      </>
                    )}
                    {supportsPpn && !(formData.ppn_calc_mode === 'dpp_nilai_lain' && !isBroker) && (
                      <>
                        {isBroker && (
                          <SapField label="PPN %" span={3}>
                            <BrokerPpnRateSelector
                              rate={formData.ppn_rate ?? 11}
                              isCustom={formData.ppn_calc_mode === 'manual'}
                              onChange={({ rate, custom }) => setFormData(prev => {
                                const dpp = prev.dpp_amount || 0;
                                if (custom) {
                                  return {
                                    ...prev,
                                    ppn_rate: rate,
                                    ppn_calc_mode: 'manual',
                                    ppn_manual_override: true,
                                  };
                                }
                                return {
                                  ...prev,
                                  ppn_rate: rate,
                                  ppn_calc_mode: 'standard',
                                  ppn_manual_override: false,
                                  ppn_amount: Math.round(dpp * rate / 100),
                                };
                              })}
                            />
                          </SapField>
                        )}
                        <SapField label={isBroker ? 'Invoice PPN' : 'PPN'} span={3}
                          right={!isBroker ? <PpnModeToggle value={formData.ppn_calc_mode} onChange={(mode) => setFormData(prev => {
                            const rate = prev.ppn_rate || 11;
                            let ppn = prev.ppn_amount;
                            if (mode === 'standard') ppn = selectedSupplier?.pkp_status ? Math.round((prev.amount || 0) * rate / 100) : 0;
                            else if (mode === 'dpp_nilai_lain') ppn = Math.round((prev.dpp_amount || 0) * rate / 100);
                            return { ...prev, ppn_calc_mode: mode, ppn_amount: ppn, ppn_manual_override: mode === 'manual', dpp_amount: mode === 'dpp_nilai_lain' ? (prev.dpp_amount || prev.amount || 0) : 0 };
                          })} /> : null}>
                          <MoneyInput value={formData.ppn_amount} placeholder="0.00"
                            readOnly={isBroker && formData.ppn_calc_mode !== 'manual'}
                            onChange={(v) => setFormData(prev => {
                              if (prev.expense_category === 'import_broker') {
                                return { ...prev, ppn_amount: v };
                              }
                              return {
                                ...prev,
                                ppn_amount: v,
                                ppn_calc_mode: 'manual',
                                ppn_manual_override: true,
                              };
                            })}
                            className={SAP_INPUT + ' !text-right !font-mono text-blue-700'
                              + (isBroker && formData.ppn_calc_mode !== 'manual' ? ' !bg-gray-100 !text-gray-600' : '')} />
                        </SapField>
                      </>
                    )}
                    {supportsPph && (
                      <SapField label={category?.taxBehavior === 'salary' ? 'PPh 21' : 'PPh Withheld'} span={3}>
                        <MoneyInput value={formData.pph_amount} placeholder="0.00"
                          onChange={(v) => setFormData({ ...formData, pph_amount: v })}
                          className={SAP_INPUT + ' !text-right !font-mono text-orange-700'} />
                      </SapField>
                    )}
                    {supportsPph && (
                      <SapField label="PPh Code" span={3}>
                        <SearchableSelect
                          value={formData.pph_code_id}
                          onChange={(val) => {
                            const tc = taxCodes.find(t => t.id === val);
                            setFormData(prev => ({
                              ...prev,
                              pph_code_id: val,
                              pph_amount: !val ? 0 : (tc && tc.rate > 0) ? Math.round(prev.amount * tc.rate / 100) : prev.pph_amount,
                            }));
                          }}
                          options={[{ value: '', label: 'None' }, ...taxCodes.map(tc => ({
                            value: tc.id,
                            label: tc.tax_type === 'PPh21' ? `${tc.code} (Manual)` : `${tc.code} — ${tc.rate}%`,
                          }))]}
                          placeholder="None"
                        />
                      </SapField>
                    )}
                    {taxCfg?.stamp && (
                      <SapField label="Stamp Duty" span={3}>
                        <MoneyInput value={formData.stamp_duty_amount} placeholder="0"
                          onChange={(v) => setFormData({ ...formData, stamp_duty_amount: v })}
                          className={SAP_INPUT + ' !text-right !font-mono'} />
                      </SapField>
                    )}
                    {rules.bankCharges === 'show' && (
                      <SapField label="Bank Charges" span={3}>
                        <MoneyInput value={formData.bank_charges_amount} placeholder="0.00"
                          onChange={(v) => setFormData({ ...formData, bank_charges_amount: v })}
                          className={SAP_INPUT + ' !text-right !font-mono'} />
                      </SapField>
                    )}
                    {(requiresContainer || isBroker) && (
                      <SapField label="Import Container" required={requiresContainer} span={3}>
                        <SearchableSelect
                          value={formData.import_container_id}
                          onChange={(val) => setFormData({ ...formData, import_container_id: val })}
                          options={[{ value: '', label: 'Select import container' }, ...containers.map(c => ({ value: c.id, label: c.container_ref }))]}
                          placeholder="Select import container"
                        />
                      </SapField>
                    )}
                    {requiresDC && (
                      <SapField label="DC" span={3}>
                        <SearchableSelect
                          value={formData.delivery_challan_id}
                          onChange={(val) => setFormData({ ...formData, delivery_challan_id: val })}
                          options={[{ value: '', label: 'None' }, ...challans.map(ch => ({ value: ch.id, label: `${ch.challan_number} — ${new Date(ch.challan_date).toLocaleDateString('en-GB')} — ${ch.customers?.company_name || ''}` }))]}
                          placeholder="None"
                        />
                      </SapField>
                    )}
                    {formData.expense_category === 'fixed_asset' && (
                      <SapField label="Asset Acct" required span={3}>
                        <SearchableSelect
                          value={formData.fixed_asset_account_id}
                          onChange={(val) => setFormData({ ...formData, fixed_asset_account_id: val })}
                          options={[{ value: '', label: 'Select account' }, ...coaAssets.map(a => ({ value: a.id, label: `${a.code} — ${a.name}` }))]}
                          placeholder="Select account"
                        />
                      </SapField>
                    )}
                  </SapRow>

                  {/* ── Row E: Description (full width) ── */}
                  <SapRow>
                    <SapField label="Invoice Description" span={12}>
                      <input type="text" value={formData.description}
                        onChange={(e) => setFormData({ ...formData, description: e.target.value })}
                        className={SAP_INPUT} placeholder="Describe what this invoice covers..." />
                    </SapField>
                  </SapRow>
                </div>
              );
            })()}

            {/* ── Tax Section (conditional, full width) ── */}
            {(() => {
              const category = expenseCategories.find(c => c.value === formData.expense_category);
              const taxCfg = selectedDocType ? DOCUMENT_TYPE_TAX_CONFIG[selectedDocType as DocumentType] : null;
              const isPib = category?.taxBehavior === 'pib_import';
              const supportsPpn = !!category && !isPib && category.taxBehavior !== 'advance' && category.taxBehavior !== 'salary';
              const supportsPph = !!category && !isPib && category.taxBehavior !== 'advance';
              const supportsStamp = !!category && !isPib && category.taxBehavior !== 'advance' && category.taxBehavior !== 'salary';
              if (!category || (!supportsPpn && !supportsPph && !supportsStamp && !isPib && !taxCfg?.brokerItems)) return null;
              return (
                <div className="py-1.5 border-b">
                  <p className="text-[10px] font-bold text-gray-400 uppercase tracking-widest mb-1.5">Tax</p>

                  {/* PIB Breakdown */}
                  {isPib && (() => {
                    const pibSum = (formData.pib_bm_amount || 0) + (formData.pib_ppn_amount || 0) + (formData.pib_pph_amount || 0);
                    const pibOk = Math.abs(pibSum - (formData.amount || 0)) < 1 && pibSum > 0;
                    return (
                      <div className="bg-amber-50 border border-amber-200 rounded p-3 mb-2.5">
                        <div className="text-xs font-semibold text-amber-800 mb-2">PIB Tax Breakdown — must sum to invoice amount</div>
                        <div className="grid grid-cols-3 gap-2 mb-2">
                          {([
                            { key: 'pib_bm_amount' as const, label: 'Import Duty (BM)', hint: 'DR 5200 Landed Cost' },
                            { key: 'pib_ppn_amount' as const, label: 'PPN Import', hint: 'DR 1150 Input VAT' },
                            { key: 'pib_pph_amount' as const, label: 'PPh 22 Import', hint: 'DR 1155 Prepaid Tax' },
                          ] as const).map(({ key, label, hint }) => (
                            <div key={key}>
                              <label className="block text-[10px] font-semibold text-amber-900 mb-0.5">{label}</label>
                              <MoneyInput value={formData[key]} placeholder="0"
                                onChange={(v) => setFormData({ ...formData, [key]: v })}
                                className="w-full px-2 py-1 border border-amber-300 rounded text-xs bg-white text-right font-mono" />
                              <p className="text-[9px] text-amber-700 mt-0.5">{hint}</p>
                            </div>
                          ))}
                        </div>
                        <div className={`flex items-center justify-between px-2 py-1 rounded text-xs font-medium ${pibOk ? 'bg-green-50 border border-green-300 text-green-800' : pibSum > 0 ? 'bg-red-50 border border-red-300 text-red-800' : 'bg-amber-100 border border-amber-300 text-amber-800'}`}>
                          <span>BM + PPN + PPh = Rp {pibSum.toLocaleString('id-ID')}</span>
                          <span>{pibOk ? '✓ Matches' : formData.amount > 0 ? `Diff: Rp ${Math.abs(pibSum - formData.amount).toLocaleString('id-ID')}` : ''}</span>
                        </div>
                      </div>
                    );
                  })()}

                  {/* ══════════════════════════════════════════════════════════════
                       BROKER CALCULATION ENGINE — 2026-07-08 spec
                       ══════════════════════════════════════════════════════════════
                       Broker Invoice and every Reimbursement Line are independent
                       payables. DPP and PPN are independent tax-reporting inputs.

                       Line columns (per user brief):
                         # | Supplier | Invoice No | Tax Inv # | Inv Date |
                         Amount | DDP | PPN% | PPN Amount | Total | Delete

                       Per-line formulas:
                         PPN Amount (Auto)  = round(DDP × PPN%)
                         PPN Amount (Manual) = user-typed value; NOT overwritten
                         Line Total          = Amount

                       Auto vs Manual (Excel semantics, per row):
                         • Editing DDP or PPN%   → Auto (recompute PPN Amount).
                         • Editing PPN Amount    → Manual (freeze PPN Amount).
                         • ppn_mode: 'auto' | 'manual' — persisted per line via a
                           dedicated `ppn_treatment` alias to avoid a schema change.

                       Total Payable:
                         Broker Invoice          (actual header payable)
                         + Σ Line.Amount         (actual reimbursement payable)
                         − Broker PPh            (header withholding)
                         + Broker Stamp Duty     (header, independent)

                       DPP and PPN remain independent reporting values and are
                       never added to Invoice Amount.
                     ══════════════════════════════════════════════════════════════ */}
                  {taxCfg?.brokerItems && (() => {
                    // ─── updateLine — pure line mutator, NEVER touches header state.
                    const updateLine = (idx: number, patch: Partial<BrokerItem>) => {
                      setBrokerItems(prev => prev.map((it, i) => {
                        if (i !== idx) return it;
                        // Any user edit promotes the line to the corrected
                        // model. Its stored Invoice Amount (including zero) is
                        // authoritative from this point onward.
                        const merged = { ...it, ...patch, invoice_amount_authoritative: true };
                        const inManualMode = merged.ppn_treatment === 'included'; // 'included' = manual PPN flag (repurposed to avoid new schema field)
                        const explicitPpn = 'ppn_amount' in patch;
                        const dppChanged  = 'dpp_amount' in patch;
                        const rateChanged = 'ppn_rate' in patch;
                        // Rule 1: user typed a PPN Amount directly → flip row to manual.
                        if (explicitPpn) {
                          merged.ppn_treatment = 'included';
                        }
                        // Rule 2: user edited DDP or % → flip row BACK to auto and recompute.
                        else if (dppChanged || rateChanged) {
                          merged.ppn_treatment = 'excluded';
                          const dpp = merged.dpp_amount ?? 0;
                          const rate = merged.ppn_rate ?? 0;
                          merged.ppn_amount = Math.round(dpp * rate / 100);
                        }
                        // Rule 3: auto-mode row with no explicit patch → keep formula alive
                        // if amount changes. We do NOT auto-seed DDP from Amount (they're
                        // independent per the user's brief). Legacy fallback preserved.
                        else if (!inManualMode && 'amount' in patch && merged.dpp_amount == null && merged.ppn_rate == null) {
                          merged.ppn_amount = computeBrokerLinePpn(merged.amount, merged.ppn_treatment);
                        }
                        return merged;
                      }));
                      // NO setFormData here. Header stays put by construction.
                    };
                    const addLine = () => setBrokerItems(prev => [...prev, {
                      type: 'other', description: '', amount: 0,
                      invoice_amount_authoritative: true,
                      supplier_id: null, invoice_number: '',
                      tax_invoice_number: '', invoice_date: '',
                      ppn_treatment: 'excluded', ppn_amount: 0,
                      dpp_amount: 0, ppn_rate: 11,
                    } as BrokerItem]);
                    const removeLine = (idx: number) => setBrokerItems(prev => prev.filter((_, i) => i !== idx));

                    // ─── Read-only derivations — never written back to state ───
                    const brokerTotals = calculateBrokerExpenseTotals({ ...formData, broker_items: brokerItems });
                    const {
                      brokerInvoiceAmount,
                      reimbursementTotal: reimbAmount, reimbursementDpp: reimbDpp,
                      reimbursementPpn: reimbPpn,
                      pphWithheld: parentPph, stampDuty: parentStamp,
                    } = brokerTotals;
                    const fmt = (n: number) => formatCurrency(n, expenseFormCurrency, {
                      minimumFractionDigits: expenseFormCurrency === 'IDR' ? 0 : 2,
                      maximumFractionDigits: expenseFormCurrency === 'IDR' ? 0 : 2,
                    });
                    // Excel density — 10 data cells per row + delete.
                    const cellInputCls = 'w-full h-[26px] px-1 border-0 focus:ring-1 focus:ring-blue-400 focus:outline-none rounded-none text-[10px] bg-transparent';
                    // # | Supplier | Inv# | Tax Inv# | Inv Date | Amount | DDP | PPN% | PPN Amt | Total | Del
                    const grid = 'grid grid-cols-[24px_minmax(0,2.5fr)_minmax(0,1.2fr)_minmax(0,1.2fr)_minmax(0,1.2fr)_minmax(0,1.3fr)_minmax(0,1.3fr)_52px_minmax(0,1.3fr)_minmax(0,1.3fr)_28px]';
                    return (
                      <div className="mb-2">
                        <div className="flex items-center justify-between mb-1">
                          <div className="text-[10px] text-gray-500">
                            <span className="font-semibold text-gray-800 text-xs">Reimbursement Lines</span>
                            <span className="ml-1.5">Sub-suppliers only affect Input PPN report</span>
                          </div>
                          <button type="button" onClick={addLine}
                            className="inline-flex items-center gap-1 px-2.5 py-1 text-xs font-semibold text-blue-700 hover:text-blue-900">
                            <Plus className="w-3.5 h-3.5" /> Add Line
                          </button>
                        </div>

                        {brokerItems.length > 0 && (
                          <div className="border border-gray-300 rounded-md bg-white shadow-sm overflow-x-auto">
                            {/* Header row */}
                            <div className={`${grid} bg-gray-100 border-b border-gray-300 text-[10px] font-semibold text-gray-600 uppercase tracking-wide`}>
                              <div className="px-1 py-1 border-r border-gray-300 text-center">#</div>
                              <div className="px-1.5 py-1 border-r border-gray-300">Supplier</div>
                              <div className="px-1.5 py-1 border-r border-gray-300">Invoice Number</div>
                              <div className="px-1.5 py-1 border-r border-gray-300">Tax Invoice #</div>
                              <div className="px-1.5 py-1 border-r border-gray-300 text-[9px]">Invoice Date</div>
                              <div className="px-1.5 py-1 border-r border-gray-300 text-right">Amount</div>
                              <div className="px-1.5 py-1 border-r border-gray-300 text-right">DPP</div>
                              <div className="px-1 py-1 border-r border-gray-300 text-center">PPN %</div>
                              <div className="px-1.5 py-1 border-r border-gray-300 text-right">PPN Amount</div>
                              <div className="px-1.5 py-1 border-r border-gray-300 text-right">Line Total</div>
                              <div className="px-0.5 py-1 text-center">✕</div>
                            </div>
                            {brokerItems.map((item, idx) => {
                              // Line Total = Invoice Amount. DPP and PPN remain
                              // independent tax-reporting values.
                              const lineTotal = brokerLineTotal(item);
                              const taxBreakdownExceedsAmount = item.invoice_amount_authoritative === true
                                && (Number(item.amount) || 0) < (Number(item.dpp_amount) || 0) + (Number(item.ppn_amount) || 0);
                              const rateDisplay = item.ppn_rate ?? 0;
                              const isManual = item.ppn_treatment === 'included';
                              return (
                                <div key={idx}
                                  className={`${grid} items-stretch border-b border-gray-200 last:border-b-0 hover:bg-blue-50/40 group`}>
                                  <div className="border-r border-gray-200 flex items-center justify-center h-[26px] text-[10px] text-gray-500 font-medium">
                                    {idx + 1}
                                  </div>
                                  {/* Supplier */}
                                  <div className="border-r border-gray-200 [&_button]:!rounded-none [&_button]:!border-0 [&_button]:!shadow-none [&_button]:!bg-transparent [&_button]:!h-[30px] [&_button]:!py-0 [&_button]:!px-2 [&_button]:!text-[11px]">
                                    <SearchableSelect
                                      value={item.supplier_id || ''}
                                      onChange={(val) => updateLine(idx, { supplier_id: val || null })}
                                      options={[
                                        { value: '', label: '— None —' },
                                        ...suppliers.map(s => ({ value: s.id, label: `${s.company_name}${s.pkp_status ? ' ✓PKP' : ''}` })),
                                      ]}
                                      placeholder="Search..."
                                    />
                                  </div>
                                  {/* Invoice No */}
                                  <div className="border-r border-gray-200">
                                    <input type="text" value={item.invoice_number || ''}
                                      onChange={(e) => updateLine(idx, { invoice_number: e.target.value })}
                                      className={cellInputCls} placeholder="Enter invoice number" />
                                  </div>
                                  {/* Tax Invoice # (Faktur Pajak) */}
                                  <div className="border-r border-gray-200">
                                    <input type="text" value={item.tax_invoice_number || ''}
                                      onChange={(e) => updateLine(idx, { tax_invoice_number: e.target.value })}
                                      className={cellInputCls} placeholder="Faktur Pajak #" title="Faktur Pajak number" />
                                  </div>
                                  {/* Invoice Date */}
                                  <div className="border-r border-gray-200">
                                    <input type="date" value={item.invoice_date || ''}
                                      onChange={(e) => updateLine(idx, { invoice_date: e.target.value })}
                                      className={cellInputCls + ' font-mono'} title="Select invoice date" />
                                  </div>
                                  {/* Amount — independent input */}
                                  <div className="border-r border-gray-200">
                                    <MoneyInput value={item.amount} placeholder="0.00"
                                      onChange={(amt) => updateLine(idx, { amount: amt })}
                                      className={cellInputCls + ' text-right font-mono'} />
                                  </div>
                                  {/* DPP — independent input; Auto mode PPN recomputes from this */}
                                  <div className="border-r border-gray-200">
                                    <MoneyInput value={item.dpp_amount ?? 0} placeholder="0.00"
                                      onChange={(v) => updateLine(idx, { dpp_amount: v })}
                                      className={cellInputCls + ' text-right font-mono text-gray-700'} />
                                  </div>
                                  {/* PPN % — typing 11 → PPN Amt = DPP × 11% (Auto) */}
                                  <div className="border-r border-gray-200">
                                    <input type="number" min="0" max="100" step="0.5"
                                      value={rateDisplay === 0 ? '' : rateDisplay}
                                      onChange={(e) => {
                                        const rate = e.target.value === '' ? 0 : parseFloat(e.target.value) || 0;
                                        updateLine(idx, { ppn_rate: rate });
                                      }}
                                      className={cellInputCls + ' text-center font-mono'} placeholder="0" />
                                  </div>
                                  {/* PPN Amount — editing this flips row to Manual mode */}
                                  <div className="border-r border-gray-200 relative">
                                    <MoneyInput value={item.ppn_amount} placeholder="0.00"
                                      onChange={(v) => updateLine(idx, { ppn_amount: v })}
                                      className={cellInputCls + ` text-right font-mono ${isManual ? 'text-amber-700' : 'text-blue-700'}`}
                                      title={isManual ? 'Manual mode — edit DPP or PPN% to return to Auto' : 'Auto = DPP × PPN%'} />
                                    {isManual && (
                                      <span className="absolute right-1 top-0.5 text-[8px] font-bold text-amber-600 uppercase tracking-wide pointer-events-none">M</span>
                                    )}
                                  </div>
                                  {/* Total = Invoice Amount; mismatch is warning-only. */}
                                  <div
                                    className={`border-r border-gray-200 flex items-center justify-end gap-1 px-1 h-[26px] font-mono text-[10px] font-semibold ${taxBreakdownExceedsAmount ? 'text-amber-700' : 'text-gray-900'}`}
                                    title={taxBreakdownExceedsAmount ? 'Warning: Invoice Amount is lower than DPP + PPN. Values are preserved without adjustment.' : 'Line Total equals Invoice Amount'}
                                  >
                                    {taxBreakdownExceedsAmount && <AlertCircle className="w-3 h-3 flex-none" />}
                                    {lineTotal ? lineTotal.toLocaleString('id-ID') : ''}
                                  </div>
                                  {/* Delete */}
                                  <div className="flex items-center justify-center h-[26px]">
                                    <button type="button" onClick={() => removeLine(idx)}
                                      className="text-red-500 hover:text-red-700 p-0.5" title="Remove line" tabIndex={-1}>
                                      <Trash2 className="w-3 h-3" />
                                    </button>
                                  </div>
                                </div>
                              );
                            })}
                            {/* Footer totals row */}
                            <div className={`${grid} bg-gray-50 border-t border-gray-300 text-[11px] font-semibold text-gray-700`}>
                              <div className="border-r border-gray-300 px-1 py-1 text-center"></div>
                              <div className="border-r border-gray-300 px-1.5 py-1">Reimbursement Total ({brokerItems.length})</div>
                              <div className="border-r border-gray-300 px-1.5 py-1"></div>
                              <div className="border-r border-gray-300 px-1.5 py-1"></div>
                              <div className="border-r border-gray-300 px-1.5 py-1"></div>
                              <div className="border-r border-gray-300 px-1.5 py-1 text-right font-mono text-gray-900">{reimbAmount.toLocaleString('id-ID')}</div>
                              <div className="border-r border-gray-300 px-1.5 py-1 text-right font-mono text-gray-900">{reimbDpp.toLocaleString('id-ID')}</div>
                              <div className="border-r border-gray-300 px-1 py-1"></div>
                              <div className="border-r border-gray-300 px-1.5 py-1 text-right font-mono text-blue-700">{reimbPpn.toLocaleString('id-ID')}</div>
                              <div className="border-r border-gray-300 px-1.5 py-1 text-right font-mono text-gray-900">{reimbAmount.toLocaleString('id-ID')}</div>
                              <div></div>
                            </div>
                          </div>
                        )}

                        {/* Payment Summary */}
                        {(() => {
                          type FormulaCell = { label: string; value: number; valueColor: string; op?: string };
                          const cells: FormulaCell[] = [
                            { label: 'Broker Invoice Amount', value: brokerInvoiceAmount, valueColor: 'text-gray-900', op: '+' },
                            { label: 'Reimbursement Total',   value: reimbAmount,         valueColor: 'text-gray-900', op: '+' },
                            { label: 'Stamp Duty',            value: parentStamp,         valueColor: 'text-gray-900', op: '−' },
                            { label: 'PPh Withheld',          value: parentPph,           valueColor: 'text-orange-700' },
                          ];
                          return (
                            <div className="mt-2">
                              <div className="flex items-stretch border border-gray-200 rounded-lg bg-white overflow-hidden">
                                {cells.map((cell, i) => (
                                  <div key={cell.label} className="flex items-stretch min-w-0">
                                    <div className={`flex flex-col justify-center px-3 py-2 min-w-[90px] ${i < cells.length - 1 ? 'border-r border-gray-200' : ''}`}>
                                      <span className="text-[9px] text-gray-400 font-medium whitespace-nowrap">{cell.label}</span>
                                      <span className={`text-xs font-bold font-mono mt-0.5 ${cell.valueColor}`}>{fmt(cell.value)}</span>
                                    </div>
                                    {cell.op && (
                                      <div className="flex items-center px-1.5 text-xs font-bold text-gray-400 border-r border-gray-200 bg-gray-50 select-none">{cell.op}</div>
                                    )}
                                  </div>
                                ))}
                                <div className="flex items-center px-1.5 text-xs font-bold text-gray-400 bg-gray-50 select-none">=</div>
                                <div className="flex flex-col justify-center px-4 py-2 bg-emerald-50 border-l-2 border-emerald-400 min-w-[110px]">
                                  <span className="text-[9px] font-bold text-emerald-700 uppercase tracking-wide">FINAL CASH PAYABLE</span>
                                  <span className="text-sm font-bold font-mono text-emerald-900 mt-0.5">{fmt(brokerTotals.finalCashPayable)}</span>
                                </div>
                              </div>
                            </div>
                          );
                        })()}
                      </div>
                    );
                  })()}

                  {/* Non-broker payment summary — horizontal formula bar */}
                  {formData.expense_category !== 'import_broker' && !isPib && (formData.amount > 0 || formData.ppn_amount > 0 || formData.pph_amount > 0 || formData.stamp_duty_amount > 0) && (() => {
                    const totals = calculateExpenseTotals(formData);
                    const bc = totals.bankChargesAmount;
                    const payable = totals.netPayable;
                    const settlementAmount = totals.settlementAmount;
                    const fmt = (n: number) => formatCurrency(n, expenseFormCurrency, {
                      minimumFractionDigits: expenseFormCurrency === 'IDR' ? 0 : 2,
                      maximumFractionDigits: expenseFormCurrency === 'IDR' ? 0 : 2,
                    });
                    type FormulaCell = { label: string; value: number; valueColor: string; op?: string; show: boolean };
                    const cells: FormulaCell[] = [
                      { label: 'Invoice Amount', value: formData.amount || 0, valueColor: 'text-gray-900', op: '+', show: true },
                      { label: 'PPN', value: formData.ppn_amount || 0, valueColor: 'text-blue-700', op: '−', show: (formData.ppn_amount || 0) > 0 },
                      { label: 'PPh Withheld', value: formData.pph_amount || 0, valueColor: 'text-orange-700', op: '+', show: (formData.pph_amount || 0) > 0 },
                      { label: 'Stamp Duty', value: formData.stamp_duty_amount || 0, valueColor: 'text-gray-900', op: '+', show: (formData.stamp_duty_amount || 0) > 0 },
                    ].filter(c => c.show);
                    return (
                      <div className="mt-2 flex items-stretch border border-gray-200 rounded-lg bg-white overflow-hidden">
                        {cells.map((cell, i) => (
                          <div key={cell.label} className="flex items-stretch min-w-0">
                            <div className={`flex flex-col justify-center px-3 py-2 min-w-[90px] ${i < cells.length - 1 ? 'border-r border-gray-200' : ''}`}>
                              <span className="text-[9px] text-gray-400 font-medium whitespace-nowrap">{cell.label}</span>
                              <span className={`text-xs font-bold font-mono mt-0.5 ${cell.valueColor}`}>{fmt(cell.value)}</span>
                            </div>
                            {cell.op && i < cells.length - 1 && (
                              <div className="flex items-center px-1.5 text-xs font-bold text-gray-400 border-r border-gray-200 bg-gray-50 select-none">{cell.op}</div>
                            )}
                          </div>
                        ))}
                        <div className="flex items-center px-1.5 text-xs font-bold text-gray-400 bg-gray-50 select-none">=</div>
                        <div className="flex flex-col justify-center px-4 py-2 bg-emerald-50 border-l-2 border-emerald-400 min-w-[110px]">
                          <span className="text-[9px] font-bold text-emerald-700 uppercase tracking-wide">NET PAYABLE</span>
                          <span className="text-sm font-bold font-mono text-emerald-900 mt-0.5">{fmt(payable)}</span>
                        </div>
                        {bc > 0 && (
                          <div className="flex flex-col justify-center px-4 py-2 bg-blue-50 border-l-2 border-blue-400 min-w-[130px]">
                            <span className="text-[9px] font-bold text-blue-700 uppercase tracking-wide">ACTUAL BANK SETTLEMENT</span>
                            <span className="text-sm font-bold font-mono text-blue-900 mt-0.5">{fmt(settlementAmount)}</span>
                          </div>
                        )}
                      </div>
                    );
                  })()}
                </div>
              );
            })()}

            {/* ── Bottom two-column: Payment (L) + Attachments (R) ── */}
            <div className="grid grid-cols-2 gap-x-4 pt-1.5">
              {/* LEFT: Payment */}
              <div className="space-y-1.5">
                <p className="text-[10px] font-bold text-gray-400 uppercase tracking-widest">Payment</p>

                <div>
                  <label className="block text-[10px] font-semibold text-gray-500 uppercase tracking-wide mb-0.5">Method <span className="text-red-500">*</span></label>
                  <select value={formData.payment_method ?? 'outstanding'}
                    onChange={(e) => {
                      const val = e.target.value === 'outstanding' ? null : e.target.value;
                      setFormData(prev => ({ ...prev, payment_method: val, bank_account_id: val ? prev.bank_account_id : '' }));
                      if (!e.target.value || e.target.value === 'outstanding') {
                        setSelectedBankTransactionId('');
                        setSelectedBankAllocationAmount(undefined);
                      }
                    }}
                    className="w-full px-2.5 py-1.5 border border-gray-300 rounded text-xs" required>
                    <option value="bank_transfer">🏦 Bank Transfer</option>
                    <option value="check">📝 Cheque</option>
                    <option value="giro">📋 Giro</option>
                    <option value="other">📌 Other</option>
                    <option value="outstanding">📋 Outstanding (A/P)</option>
                  </select>
                  {formData.payment_method === null && (
                    <p className="text-[9px] text-amber-700 mt-0.5 font-medium">Posted as A/P 2110 — appears in Payables</p>
                  )}
                </div>

                {formData.payment_method !== null && (
                  <div>
                    <label className="block text-[10px] font-semibold text-gray-500 uppercase tracking-wide mb-0.5">Bank Account <span className="text-red-500">*</span></label>
                    <select value={formData.bank_account_id}
                      onChange={(e) => {
                        const bank = bankAccounts.find(item => item.id === e.target.value);
                        const currency = normalizeCurrency(bank?.currency) as 'IDR' | 'USD';
                        setFormData({ ...formData, bank_account_id: e.target.value, transaction_currency: currency,
                          exchange_rate: currency === 'IDR' ? 1 : formData.exchange_rate });
                        setSelectedBankTransactionId('');
                        setSelectedBankAllocationAmount(undefined);
                      }}
                      className="w-full px-2.5 py-1.5 border border-gray-300 rounded text-xs" required={formData.payment_method !== null}>
                      <option value="">Select account</option>
                      {bankAccounts.map(bank => <option key={bank.id} value={bank.id}>{bank.bank_name} — {bank.alias || bank.account_number}</option>)}
                    </select>
                  </div>
                )}

                {formData.payment_method === null && (
                  <div>
                    <label className="block text-[10px] font-semibold text-gray-500 uppercase tracking-wide mb-0.5">Transaction Currency <span className="text-red-500">*</span></label>
                    <select value={formData.transaction_currency}
                      onChange={(e) => setFormData({ ...formData,
                        transaction_currency: e.target.value as 'IDR' | 'USD',
                        exchange_rate: e.target.value === 'IDR' ? 1 : formData.exchange_rate })}
                      className="w-full px-2.5 py-1.5 border border-gray-300 rounded text-xs">
                      <option value="IDR">IDR</option>
                      <option value="USD">USD</option>
                    </select>
                  </div>
                )}

                {formData.payment_method !== null && formData.bank_account_id && (
                  <BankTransactionLinkField
                    bankAccountId={formData.bank_account_id}
                    selectedTransactionId={selectedBankTransactionId}
                    linkedTransaction={editingExpense?.bank_statement_lines?.[0] || null}
                    currentExpenseId={editingExpense?.id}
                    documentDate={formData.expense_date}
                    documentOutstanding={Math.max(
                      0,
                      calculateCanonicalCashPayable(formData)
                        - Number(editingExpense?.paid_amount || 0)
                        + Number(editingExpense?.bank_statement_lines?.reduce(
                          (sum, line) => sum + Number(line.payment_kind === 'pph23' ? 0 : line.allocation_amount || 0),
                          0,
                        ) || 0),
                    )}
                    documentLabel={editingExpense?.voucher_number || 'Expense'}
                    canUnlink={canManage}
                    onSelect={(transaction) => {
                      setSelectedBankTransactionId(transaction.id);
                      setSelectedBankAllocationAmount(Math.min(
                        Number(transaction.remainingAmount ?? transaction.debit_amount ?? transaction.credit_amount ?? 0),
                        Math.max(
                          0,
                          calculateCanonicalCashPayable(formData)
                            - Number(editingExpense?.paid_amount || 0)
                            + Number(editingExpense?.bank_statement_lines?.reduce(
                              (sum, line) => sum + Number(line.payment_kind === 'pph23' ? 0 : line.allocation_amount || 0),
                              0,
                            ) || 0),
                        ),
                      ));
                    }}
                    onUnlink={() => handleUnlinkFromBankStatement(editingExpense!.id)}
                  />
                )}

                {formData.payment_method === null && formData.due_date && (
                  <div className="p-2 bg-amber-50 border border-amber-200 rounded text-xs">
                    <span className="font-semibold text-amber-800">Due: </span>
                    <span className="text-amber-900">{formatDate(formData.due_date)}</span>
                    <span className="ml-1.5 text-[9px] text-amber-600">Settle via Payment Voucher</span>
                  </div>
                )}

              </div>

              {/* RIGHT: Attachments */}
              <FinanceDocumentAttachments
                documentUrls={formData.document_urls}
                pendingFiles={uploadingFiles}
                onDocumentUrlsChange={(document_urls) => setFormData((previous) => ({ ...previous, document_urls }))}
                onPendingFilesChange={setUploadingFiles}
                active={modalOpen}
                compact
              />
            </div>

          </form>
        </FinanceModal>
      )}

      {/* Quick Add Supplier Modal — redesigned with type, PKP, terms */}
      {showQuickAddSupplier && (
        <Modal isOpen={showQuickAddSupplier} onClose={() => { setShowQuickAddSupplier(false); setQuickAddSupplierName(''); }} title="Quick Add Supplier" size="sm">
          <div className="space-y-3">
            <p className="text-xs text-gray-500">Minimum info. Fill full details in Suppliers Master later.</p>
            <div>
              <label className="block text-[10px] font-semibold text-gray-500 uppercase tracking-wide mb-0.5">Company Name <span className="text-red-500">*</span></label>
              <input type="text" value={quickAddSupplierName} autoFocus
                onChange={(e) => setQuickAddSupplierName(e.target.value)}
                onKeyDown={(e) => { if (e.key === 'Enter') { e.preventDefault(); handleQuickAddSupplier(); } }}
                className="w-full px-2.5 py-1.5 border border-gray-300 rounded text-sm"
                placeholder="e.g. PT. Mitra Logistik Indonesia" />
            </div>
            <div>
              <label className="block text-[10px] font-semibold text-gray-500 uppercase tracking-wide mb-0.5">Supplier Type</label>
              <select value={quickAddSupplierType}
                onChange={(e) => {
                  const st = e.target.value;
                  setQuickAddSupplierType(st);
                  const cfg = SUPPLIER_TYPES.find(t => t.value === st);
                  if (cfg) setQuickAddSupplierTerms(cfg.paymentTerms);
                }}
                className="w-full px-2.5 py-1.5 border border-gray-300 rounded text-sm">
                {SUPPLIER_TYPES.map(st => <option key={st.value} value={st.value}>{st.label}</option>)}
              </select>
              {quickAddSupplierType && (() => {
                const cfg = SUPPLIER_TYPES.find(t => t.value === quickAddSupplierType);
                return cfg ? (
                  <p className="text-[9px] text-gray-500 mt-0.5">→ Tax: {cfg.taxPreference.replace(/_/g,' ')} · Category: {cfg.defaultCategory}</p>
                ) : null;
              })()}
            </div>
            <div className="grid grid-cols-2 gap-2">
              <div>
                <label className="block text-[10px] font-semibold text-gray-500 uppercase tracking-wide mb-0.5">PKP Registered</label>
                <div className="flex gap-2 mt-1.5">
                  <label className="flex items-center gap-1.5 text-xs cursor-pointer">
                    <input type="radio" name="qs_pkp" checked={quickAddSupplierPKP} onChange={() => setQuickAddSupplierPKP(true)} /> Yes
                  </label>
                  <label className="flex items-center gap-1.5 text-xs cursor-pointer">
                    <input type="radio" name="qs_pkp" checked={!quickAddSupplierPKP} onChange={() => setQuickAddSupplierPKP(false)} /> No
                  </label>
                </div>
              </div>
              <div>
                <label className="block text-[10px] font-semibold text-gray-500 uppercase tracking-wide mb-0.5">Payment Terms (days)</label>
                <input type="number" min="0" value={quickAddSupplierTerms}
                  onChange={(e) => setQuickAddSupplierTerms(parseInt(e.target.value) || 0)}
                  className="w-full px-2.5 py-1.5 border border-gray-300 rounded text-sm" />
              </div>
            </div>
            <div className="flex justify-end gap-2 pt-2 border-t">
              <button type="button" onClick={() => { setShowQuickAddSupplier(false); setQuickAddSupplierName(''); }}
                className="px-3 py-1.5 text-sm border border-gray-300 rounded hover:bg-gray-50">Cancel</button>
              <button type="button" onClick={handleQuickAddSupplier}
                disabled={!quickAddSupplierName.trim() || quickAddSupplierLoading}
                className="px-3 py-1.5 text-sm bg-green-600 text-white rounded hover:bg-green-700 disabled:opacity-50 flex items-center gap-1.5">
                <UserPlus className="w-3.5 h-3.5" />
                {quickAddSupplierLoading ? 'Adding...' : 'Add Supplier'}
              </button>
            </div>
          </div>
        </Modal>
      )}

      {/* Finance Health Check slide-over panel */}
      {healthCheckOpen && (
        <div className="fixed right-0 top-0 h-full w-80 bg-white shadow-2xl border-l border-gray-200 z-50 flex flex-col">
          <div className="flex items-center justify-between px-4 py-3 border-b bg-gray-50">
            <div className="flex items-center gap-2">
              <AlertCircle className="w-4 h-4 text-orange-600" />
              <span className="text-sm font-semibold text-gray-800">Finance Health Check</span>
            </div>
            <div className="flex items-center gap-2">
              <button onClick={loadHealthCheck} className="text-xs text-blue-600 hover:text-blue-800" title="Refresh">
                <RotateCcw className="w-3.5 h-3.5" />
              </button>
              <button onClick={() => setHealthCheckOpen(false)} className="text-gray-400 hover:text-gray-600">
                <X className="w-4 h-4" />
              </button>
            </div>
          </div>
          <div className="flex-1 overflow-y-auto p-4">
            {healthLoading ? (
              <div className="text-sm text-gray-500 text-center py-8">Checking...</div>
            ) : healthIssues.length === 0 ? (
              <div className="text-center py-8">
                <CheckCircle className="w-8 h-8 text-green-500 mx-auto mb-2" />
                <p className="text-sm text-green-700 font-medium">No issues found</p>
                <p className="text-xs text-gray-400 mt-1">Finance data looks healthy</p>
              </div>
            ) : (
              <div className="space-y-2">
                {healthIssues.map(issue => (
                  <div key={issue.key} className={`flex items-start gap-3 p-2.5 rounded border text-xs ${
                    issue.severity === 'error' ? 'bg-red-50 border-red-200' :
                    issue.severity === 'warning' ? 'bg-amber-50 border-amber-200' :
                    'bg-blue-50 border-blue-200'
                  }`}>
                    <span className={`font-bold text-base leading-none ${
                      issue.severity === 'error' ? 'text-red-600' :
                      issue.severity === 'warning' ? 'text-amber-600' : 'text-blue-600'
                    }`}>{issue.count}</span>
                    <span className={`leading-tight ${
                      issue.severity === 'error' ? 'text-red-800' :
                      issue.severity === 'warning' ? 'text-amber-800' : 'text-blue-800'
                    }`}>{issue.label}</span>
                  </div>
                ))}
              </div>
            )}
          </div>
          <div className="px-4 py-3 border-t text-[10px] text-gray-400 text-center">
            Read-only — no data is modified
          </div>
        </div>
      )}

      {viewModalOpen && viewingExpense && (() => {
        const currency = getExpenseCurrency(viewingExpense);
        const fmtMoney = (n: number | null | undefined, decimals: 0 | 2 = 0) => {
          return formatCurrency(n, currency, {
            minimumFractionDigits: decimals,
            maximumFractionDigits: decimals,
          });
        };
        const canonicalExpenseTotal = calculateCanonicalExpenseTotal(viewingExpense);
        const canonicalCashPayable = calculateCanonicalCashPayable(viewingExpense);
        const isBroker = viewingExpense.expense_category === 'import_broker';
        const isSalary = viewingExpense.expense_category === 'salary';
        const salaryAdvanceApplied = isSalary
          ? salaryAdvanceApplications.reduce((sum, application) => sum + Number(application.applied_amount || 0), 0)
          : 0;
        const salaryPaidAmount = Number(viewingExpense.paid_amount || 0);
        const salaryCashPaid = Math.max(salaryPaidAmount - salaryAdvanceApplied, 0);
        const salaryOutstanding = Math.max(canonicalCashPayable - salaryPaidAmount, 0);
        const staffName = (() => {
          const rules = getCategoryFieldRules(viewingExpense.expense_category);
          if (rules.staff !== 'show' || !viewingExpense.staff_id) return null;
          const staff = staffRoster.find(s => s.id === viewingExpense.staff_id);
          return staff?.full_name ?? null;
        })();
        const approvalBadge = () => {
          const s = viewingExpense.effective_posting_state || 'AMBIGUOUS';
          if (s === 'ACTIVE') return <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-[10px] font-semibold bg-green-50 text-green-700 border border-green-200"><CheckCircle className="w-3 h-3" /> Approved · Active</span>;
          if (s === 'REPLACED') return <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-[10px] font-semibold bg-green-50 text-green-700 border border-green-200"><CheckCircle className="w-3 h-3" /> Approved · Active</span>;
          if (s === 'REVERSED') return <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-[10px] font-semibold bg-gray-100 text-gray-700 border border-gray-300"><RotateCcw className="w-3 h-3" /> Cancelled</span>;
          if (s === 'REJECTED') return <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-[10px] font-semibold bg-red-50 text-red-700 border border-red-200"><XCircle className="w-3 h-3" /> Rejected</span>;
          if (s === 'AMBIGUOUS') return <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-[10px] font-semibold bg-orange-50 text-orange-700 border border-orange-200"><AlertCircle className="w-3 h-3" /> Review required</span>;
          return <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-[10px] font-semibold bg-amber-50 text-amber-700 border border-amber-200"><AlertCircle className="w-3 h-3" /> Pending</span>;
        };

        // Tax rows (non-broker)
        const taxRows: Array<{ label: string; value: number; tint: string }> = [];
        if (!isBroker) {
          const pphCode = viewingExpense.pph_code_id ? taxCodes.find(t => t.id === viewingExpense.pph_code_id) : null;
          const pphLabel = pphCode ? `PPh Withheld · ${pphCode.tax_type}${pphCode.rate ? ` @ ${pphCode.rate}%` : ''}` : 'PPh Withheld';
          if ((viewingExpense.ppn_amount || 0) > 0) taxRows.push({ label: 'PPN', value: viewingExpense.ppn_amount || 0, tint: 'text-blue-700' });
          if ((viewingExpense.pph_amount || 0) > 0) taxRows.push({ label: pphLabel, value: -(viewingExpense.pph_amount || 0), tint: 'text-orange-700' });
          if ((viewingExpense.stamp_duty_amount || 0) > 0) taxRows.push({ label: 'Stamp Duty', value: viewingExpense.stamp_duty_amount || 0, tint: 'text-gray-700' });
          if ((viewingExpense.bank_charges_amount || 0) > 0) taxRows.push({ label: 'Bank Charges', value: viewingExpense.bank_charges_amount || 0, tint: 'text-gray-700' });
          if ((viewingExpense.pib_bm_amount || 0) > 0) taxRows.push({ label: 'Import Duty (BM)', value: viewingExpense.pib_bm_amount || 0, tint: 'text-gray-700' });
          if ((viewingExpense.pib_ppn_amount || 0) > 0) taxRows.push({ label: 'PPN Import', value: viewingExpense.pib_ppn_amount || 0, tint: 'text-blue-700' });
          if ((viewingExpense.pib_pph_amount || 0) > 0) taxRows.push({ label: 'PPh 22 Import', value: viewingExpense.pib_pph_amount || 0, tint: 'text-orange-700' });
        }
        const expenseTotals = !isBroker ? calculateExpenseTotals(viewingExpense) : null;
        const netPayable = expenseTotals?.netPayable || 0;

        // Broker totals
        const brokerTotals = isBroker ? calculateBrokerExpenseTotals(viewingExpense) : null;

        // Payment breakdown
        const allocs = viewingExpense.voucher_allocations || [];
        const bslLines = viewingExpense.bank_statement_lines || [];
        const hasPaymentBreakdown = allocs.length > 0 || bslLines.length > 0;
        const supplierPaid = viewingExpense.paid_amount ?? 0;
        const pphTarget = viewingExpense.pph_amount || 0;
        const pphPaid = viewingExpense.pph_paid_amount ?? 0;
        const balance = canonicalCashPayable - supplierPaid;

        // Related records
        const hasRelated = viewingExpense.batches || viewingExpense.import_containers || viewingExpense.delivery_challans;

        return (
        <div className="fixed inset-0 z-50 overflow-y-auto">
          <div className="flex min-h-screen items-center justify-center p-4">
            <div className="fixed inset-0 bg-gray-900/50" onClick={() => { setViewModalOpen(false); setViewingExpense(null); setLinkedDCQuickView(null); }} />
            <div className="relative bg-white rounded-lg shadow-xl w-full max-w-6xl max-h-[92vh] flex flex-col overflow-hidden">
              {/* Floating close button — no header bar */}
              <button
                type="button"
                onClick={() => { setViewModalOpen(false); setViewingExpense(null); setLinkedDCQuickView(null); }}
                className="absolute top-3 right-3 z-10 inline-flex h-8 w-8 items-center justify-center rounded-full bg-white/90 border border-gray-200 shadow-sm hover:bg-gray-100 transition"
                title="Close"
                aria-label="Close"
              >
                <X className="w-4 h-4 text-gray-600" />
              </button>

              <div className="flex-1 overflow-y-auto">
          {/* ═══ ONE UNIFIED CONTAINER ═══ */}
          <div className="rounded-lg border border-gray-200 bg-white shadow-sm overflow-hidden">

            {/* ── HEADER (document header — first card) ── */}
            <div className="px-4 pt-4 pb-2.5 bg-gray-50 border-b border-gray-200">
              <div className="flex items-start justify-between gap-3">
                <div className="flex items-center gap-2.5">
                  <div className="flex items-center justify-center w-8 h-8 rounded-lg bg-blue-600 text-white">
                    <FileText className="w-4 h-4" />
                  </div>
                  <div>
                    <h2 className="text-[17px] font-semibold text-gray-900 leading-tight">
                      {viewingExpense.voucher_number || 'Expense'}
                    </h2>
                    <p className="text-[11px] text-gray-500 mt-0">
                      {expenseCategories.find(c => c.value === viewingExpense.expense_category)?.label || viewingExpense.expense_category}
                      {viewingExpense.invoice_number && (
                        <span className="ml-1.5 text-gray-400">·</span>
                      )}
                      {viewingExpense.invoice_number && (
                        <span className="ml-1.5 font-mono text-gray-600">{viewingExpense.invoice_number}</span>
                      )}
                    </p>
                  </div>
                </div>
                <div className="flex items-start gap-3">
                  <div className="text-right">
                    <div className="text-[9px] uppercase font-medium text-gray-400 tracking-wide">{isSalary ? 'Gross Salary' : 'Total'}</div>
                    <div className="text-[19px] font-bold text-gray-900 font-mono leading-tight">{fmtMoney(canonicalExpenseTotal, 2)}</div>
                    <div className="mt-0.5">{approvalBadge()}</div>
                  </div>
                </div>
              </div>
              {/* Header meta row */}
              <div className="mt-2 grid grid-cols-2 md:grid-cols-4 gap-x-4 gap-y-0.5">
                <div>
                  <span className="text-[9px] uppercase font-medium text-gray-400">Invoice Date</span>
                  <span className="ml-1.5 text-[12px] font-medium text-gray-800">{formatDate(viewingExpense.expense_date)}</span>
                </div>
                {viewingExpense.due_date && (
                  <div>
                    <span className="text-[9px] uppercase font-medium text-gray-400">Due</span>
                    <span className="ml-1.5 text-[12px] font-medium text-gray-800">{formatDate(viewingExpense.due_date)}</span>
                  </div>
                )}
                {viewingExpense.suppliers && (
                  <div>
                    <span className="text-[9px] uppercase font-medium text-gray-400">Supplier</span>
                    <span className="ml-1.5 text-[12px] font-medium text-gray-800">{viewingExpense.suppliers.company_name}</span>
                  </div>
                )}
                {staffName && (
                  <div>
                    <span className="text-[9px] uppercase font-medium text-gray-400">Employee</span>
                    <span className="ml-1.5 text-[12px] font-medium text-gray-800">{staffName}</span>
                  </div>
                )}
              </div>
              {viewingExpense.posting_lifecycle && (
                <div className="mt-2 rounded border border-gray-200 bg-white px-2.5 py-2 text-[10px] text-gray-600">
                  <div className="font-semibold text-gray-700">Journal / reversal history</div>
                  <div className="mt-1 flex flex-wrap gap-x-4 gap-y-1 font-mono">
                    {viewingExpense.posting_lifecycle.active_journal_number && <span>Active: {viewingExpense.posting_lifecycle.active_journal_number}</span>}
                    {viewingExpense.posting_lifecycle.original_journal_number && <span>Original: {viewingExpense.posting_lifecycle.original_journal_number}</span>}
                    {viewingExpense.posting_lifecycle.reversal_journal_id && <span>Reversal ID: {viewingExpense.posting_lifecycle.reversal_journal_id}</span>}
                    {viewingExpense.posting_lifecycle.replacement_journal_number && <span className="text-indigo-700">Effective replacement: {viewingExpense.posting_lifecycle.replacement_journal_number}</span>}
                    {viewingExpense.posting_lifecycle.ambiguity_reason && <span className="text-orange-700">Review: {viewingExpense.posting_lifecycle.ambiguity_reason}</span>}
                  </div>
                </div>
              )}
            </div>

            {/* ── SUMMARY ── */}
            <div className="px-4 py-2 border-b border-gray-100">
              <h3 className="text-[11px] font-semibold text-gray-500 uppercase tracking-wide mb-1.5">Summary</h3>
              <div className="grid grid-cols-2 md:grid-cols-4 gap-x-4 gap-y-1">
                <div>
                  <div className="text-[9px] uppercase font-medium text-gray-400">Category</div>
                  <div className="text-[12px] font-medium text-gray-800">
                    {expenseCategories.find(c => c.value === viewingExpense.expense_category)?.label || viewingExpense.expense_category}
                  </div>
                </div>
                {viewingExpense.suppliers && (
                  <div>
                    <div className="text-[9px] uppercase font-medium text-gray-400">Supplier</div>
                    <div className="text-[12px] font-medium text-gray-800">{viewingExpense.suppliers.company_name}</div>
                  </div>
                )}
                {staffName && (
                  <div>
                    <div className="text-[9px] uppercase font-medium text-gray-400">Employee</div>
                    <div className="text-[12px] font-medium text-gray-800">{staffName}</div>
                  </div>
                )}
                <div>
                  <div className="text-[9px] uppercase font-medium text-gray-400">{isSalary ? 'Gross Salary Amount' : 'Expense Amount'}</div>
                  <div className="text-[12px] font-medium text-gray-800 font-mono">{fmtMoney(viewingExpense.amount, 2)}</div>
                </div>
                {viewingExpense.payment_reference && (
                  <div>
                    <div className="text-[9px] uppercase font-medium text-gray-400">Reference</div>
                    <div className="text-[12px] font-medium text-gray-800 font-mono">{viewingExpense.payment_reference}</div>
                  </div>
                )}
                {viewingExpense.description && (
                  <div className="col-span-2 md:col-span-4">
                    <div className="text-[9px] uppercase font-medium text-gray-400">Description</div>
                    <div className="text-[11px] text-gray-600 whitespace-pre-wrap leading-snug">{viewingExpense.description}</div>
                  </div>
                )}
              </div>
            </div>

            {/* ── BROKER SUMMARY (only for broker) ── */}
            {isBroker && brokerTotals && (() => {
              const rows: Array<[string, number, string]> = [
                ['Broker Invoice', brokerTotals.brokerInvoiceAmount, 'text-gray-900'],
                ['Reimbursements', brokerTotals.reimbursementTotal, 'text-gray-900'],
                ['Reimbursement DPP', brokerTotals.reimbursementDpp, 'text-gray-700'],
                ['Recoverable PPN', brokerTotals.recoverableInputPpn, 'text-blue-700'],
                ['PPh23', brokerTotals.pph23Withheld, 'text-orange-700'],
                ['Stamp Duty', brokerTotals.stampDuty, 'text-gray-700'],
                ['Accounting Expense', brokerTotals.accountingExpenseTotal, 'text-gray-900'],
              ];
              return (
                <div className="px-4 py-2 border-b border-gray-100">
                  <h3 className="text-[11px] font-semibold text-gray-500 uppercase tracking-wide mb-1.5">Broker Invoice Summary</h3>
                  <div className="grid grid-cols-2 md:grid-cols-4 gap-x-4 gap-y-1">
                    {rows.map(([label, value, tint]) => (
                      <div key={label}>
                        <div className="text-[9px] uppercase font-medium text-gray-400">{label}</div>
                        <div className={`text-[12px] font-medium font-mono ${tint}`}>{fmtMoney(value)}</div>
                      </div>
                    ))}
                  </div>
                  <div className="mt-1.5 flex items-center justify-between border-t border-gray-100 pt-1.5">
                    <span className="text-[10px] font-semibold text-green-700 uppercase tracking-wide">Final Cash Payable</span>
                    <span className="text-[15px] font-bold font-mono text-green-800">{fmtMoney(brokerTotals.finalCashPayable, 2)}</span>
                  </div>
                </div>
              );
            })()}

            {isSalary && (
              <div className="px-4 py-2 border-b border-gray-100">
                <h3 className="text-[11px] font-semibold text-gray-500 uppercase tracking-wide mb-1.5">Salary Settlement Summary</h3>
                <div className="grid grid-cols-2 md:grid-cols-4 gap-x-4 gap-y-1">
                  {[
                    ['Gross Salary', Number(viewingExpense.amount || 0)],
                    ['Salary Advance Applied', salaryAdvanceApplied],
                    ['PPh21', Number(viewingExpense.pph_amount || 0)],
                    ['BPJS', 0],
                    ['Net Payable', Math.max(canonicalCashPayable - salaryAdvanceApplied, 0)],
                    ['Paid Amount', salaryCashPaid],
                    ['Outstanding Balance', salaryOutstanding],
                  ].map(([label, value]) => (
                    <div key={String(label)}>
                      <div className="text-[9px] uppercase font-medium text-gray-400">{label}</div>
                      <div className="text-[12px] font-medium font-mono text-gray-800">{fmtMoney(Number(value))}</div>
                    </div>
                  ))}
                </div>
              </div>
            )}

            {/* ── TAX SECTION (only if tax rows exist) ── */}
            {taxRows.length > 0 && !isSalary && (
              <div className="px-4 py-2 border-b border-gray-100">
                <h3 className="text-[11px] font-semibold text-gray-500 uppercase tracking-wide mb-1.5">Tax Summary</h3>
                <div className="flex flex-wrap items-center gap-x-4 gap-y-1">
                  <div className="flex items-center gap-1">
                    <span className="text-[9px] uppercase font-medium text-gray-400">Invoice</span>
                    <span className="text-[12px] font-medium font-mono text-gray-800">{fmtMoney(viewingExpense.amount)}</span>
                  </div>
                  {taxRows.map((row) => (
                    <div key={row.label} className="flex items-center gap-1">
                      <span className="text-gray-300 text-sm font-light">{row.value < 0 ? '−' : '+'}</span>
                      <span className="text-[9px] uppercase font-medium text-gray-400">{row.label}</span>
                      <span className={`text-[12px] font-medium font-mono ${row.tint}`}>{fmtMoney(Math.abs(row.value))}</span>
                    </div>
                  ))}
                  <span className="text-gray-300 text-sm font-light">=</span>
                  <div className="ml-auto flex items-center gap-1.5 px-2 py-0.5 border border-green-200 bg-green-50 rounded">
                    <span className="text-[9px] font-semibold text-green-700 uppercase">Net Payable</span>
                    <span className="text-[12px] font-bold font-mono text-green-800">{fmtMoney(netPayable, 2)}</span>
                  </div>
                  {expenseTotals && expenseTotals.bankChargesAmount > 0 && (
                    <div className="flex items-center gap-1.5 px-2 py-0.5 border border-blue-200 bg-blue-50 rounded">
                      <span className="text-[9px] font-semibold text-blue-700 uppercase">Actual Bank Settlement Amount</span>
                      <span className="text-[12px] font-bold font-mono text-blue-800">{fmtMoney(expenseTotals.settlementAmount, 2)}</span>
                    </div>
                  )}
                </div>
              </div>
            )}

            {/* ── SALARY ADVANCE APPLICATIONS (only for salary with advances) ── */}
            {isSalary && salaryAdvanceApplications.length > 0 && (
              <div className="px-4 py-2 border-b border-gray-100">
                <h3 className="text-[11px] font-semibold text-gray-500 uppercase tracking-wide mb-1.5">Salary Advance Applications</h3>
                <div className="space-y-1">
                  {salaryAdvanceApplications.map((application) => (
                    <div key={application.application_id} className="flex flex-wrap items-center justify-between gap-2 px-2 py-1 bg-amber-50 border border-amber-200 rounded text-[11px]">
                      <span className="text-gray-700">
                        Advance {application.advance_voucher_number || application.advance_payment_voucher_id} → Settlement {application.settlement_voucher_number || application.settlement_payment_voucher_id}
                      </span>
                      <span className="flex items-center gap-2">
                        <span className="font-mono font-semibold text-gray-900">{fmtMoney(application.applied_amount)}</span>
                        {onViewPaymentVoucher && (
                          <button type="button" onClick={() => onViewPaymentVoucher(application.settlement_payment_voucher_id)} className="text-blue-600 hover:underline text-[11px] font-medium">View Payment</button>
                        )}
                      </span>
                    </div>
                  ))}
                </div>
              </div>
            )}

            {/* ── BROKER REIMBURSEMENT TABLE ── */}
            {viewingExpense.broker_items && viewingExpense.broker_items.length > 0 && (
              <div className="px-4 py-2 border-b border-gray-100">
                <h3 className="text-[11px] font-semibold text-gray-500 uppercase tracking-wide mb-1.5">Reimbursement Lines</h3>
                <div className="overflow-x-auto rounded border border-gray-200">
                  <table className="w-full text-[11px]">
                    <thead className="bg-gray-50 text-[9px] uppercase text-gray-500">
                      <tr>
                        <th className="px-2 py-1 text-left font-medium">Supplier</th>
                        <th className="px-2 py-1 text-left font-medium">Invoice No</th>
                        <th className="px-2 py-1 text-left font-medium">Tax Invoice</th>
                        <th className="px-2 py-1 text-left font-medium">Date</th>
                        <th className="px-2 py-1 text-right font-medium">Invoice Amount</th>
                        <th className="px-2 py-1 text-right font-medium">DPP</th>
                        <th className="px-2 py-1 text-right font-medium">PPN %</th>
                        <th className="px-2 py-1 text-right font-medium">PPN Amount</th>
                        <th className="px-2 py-1 text-right font-medium">Payable Amount</th>
                      </tr>
                    </thead>
                    <tbody>
                      {viewingExpense.broker_items.map((item, i) => {
                        const total = brokerLineTotal(item);
                        const supplierName = item.supplier_id ? suppliers.find(s => s.id === item.supplier_id)?.company_name : null;
                        return (
                          <tr key={i} className="border-t border-gray-100 hover:bg-gray-50">
                            <td className="px-2 py-1 text-gray-700 truncate max-w-[120px]">{supplierName || '—'}</td>
                            <td className="px-2 py-1 text-gray-600 font-mono">{item.invoice_number || '—'}</td>
                            <td className="px-2 py-1 text-gray-600 font-mono">{item.tax_invoice_number || '—'}</td>
                            <td className="px-2 py-1 text-gray-600 font-mono">{formatDate(item.invoice_date || '')}</td>
                            <td className="px-2 py-1 text-right font-mono text-gray-900">{fmtMoney(item.amount || 0)}</td>
                            <td className="px-2 py-1 text-right font-mono text-gray-700">{fmtMoney(item.dpp_amount ?? 0)}</td>
                            <td className="px-2 py-1 text-right font-mono text-gray-600">{Number(item.ppn_rate || 0).toLocaleString('id-ID')}%</td>
                            <td className="px-2 py-1 text-right font-mono text-blue-700">{fmtMoney(item.ppn_amount || 0)}</td>
                            <td className="px-2 py-1 text-right font-mono text-gray-900 font-medium">{fmtMoney(total)}</td>
                          </tr>
                        );
                      })}
                    </tbody>
                    <tfoot>
                      <tr className="border-t-2 border-gray-200 bg-gray-50">
                        <td colSpan={8} className="px-2 py-1 text-right text-[10px] font-semibold text-gray-600 uppercase">Total Payable</td>
                        <td className="px-2 py-1 text-right font-mono font-bold text-gray-900">
                          {fmtMoney(viewingExpense.broker_items.reduce((sum, item) => sum + brokerLineTotal(item), 0))}
                        </td>
                      </tr>
                    </tfoot>
                  </table>
                </div>
              </div>
            )}

            {/* ── PAYMENT + BANK RECONCILIATION (2-col on desktop) ── */}
            <div className="grid grid-cols-1 md:grid-cols-2 border-b border-gray-100">
              {/* Payment */}
              <div className="px-4 py-2 md:border-r border-gray-100">
                <h3 className="text-[11px] font-semibold text-gray-500 uppercase tracking-wide mb-1.5">Payment</h3>
                <div className="space-y-0.5">
                  <div className="flex items-center justify-between">
                    <span className="text-[9px] uppercase font-medium text-gray-400">Method</span>
                    {viewingExpense.payment_method === null ? (
                      <span className="px-1.5 py-0.5 text-[10px] font-semibold text-amber-700 bg-amber-50 border border-amber-200 rounded">A/P Outstanding</span>
                    ) : (
                      <span className="text-[12px] font-medium text-gray-800 capitalize">{viewingExpense.payment_method?.replace('_', ' ')}</span>
                    )}
                  </div>
                  {viewingExpense.bank_accounts && (
                    <div className="flex items-center justify-between">
                      <span className="text-[9px] uppercase font-medium text-gray-400">Bank</span>
                      <span className="text-[11px] font-medium text-gray-800">
                        {viewingExpense.bank_accounts.alias || viewingExpense.bank_accounts.bank_name} · {viewingExpense.bank_accounts.account_number}
                        {viewingExpense.bank_accounts.currency && viewingExpense.bank_accounts.currency !== 'IDR' && (
                          <span className="ml-1 text-[10px] text-gray-500 font-semibold">({viewingExpense.bank_accounts.currency})</span>
                        )}
                      </span>
                    </div>
                  )}
                  <div className="flex items-center justify-between">
                    <span className="text-[9px] uppercase font-medium text-gray-400">Paid</span>
                    <span className="text-[12px] font-medium font-mono text-gray-800">{fmtMoney(supplierPaid)}</span>
                  </div>
                  {canonicalCashPayable > 0 && (
                    <div className="flex items-center justify-between">
                      <span className="text-[9px] uppercase font-medium text-gray-400">Balance</span>
                      <span className={`text-[12px] font-bold font-mono ${balance > 0 ? 'text-red-600' : 'text-green-700'}`}>{fmtMoney(balance)}</span>
                    </div>
                  )}
                </div>

                {/* Payment breakdown lines */}
                {hasPaymentBreakdown && (
                  <div className="mt-1.5 pt-1.5 border-t border-gray-100 space-y-0.5">
                    {(() => {
                      const badge = (paid: number, target: number) => {
                        if (target <= 0) return null;
                        if (paid <= 0) return <span className="text-[9px] px-1 py-0.5 rounded bg-gray-100 text-gray-600">Pending</span>;
                        if (paid >= target - 1) return <span className="text-[9px] px-1 py-0.5 rounded bg-green-50 text-green-700 border border-green-200">Paid</span>;
                        return <span className="text-[9px] px-1 py-0.5 rounded bg-amber-50 text-amber-700 border border-amber-200">Partial</span>;
                      };
                      return (
                        <>
                          {(canonicalCashPayable > 0 || supplierPaid > 0) && (
                            <div className="flex items-center justify-between text-[11px]">
                              <span className="text-gray-600">Supplier</span>
                              <div className="flex items-center gap-1.5">
                                <span className="font-mono text-gray-800">{fmtMoney(supplierPaid)} / {fmtMoney(canonicalCashPayable)}</span>
                                {badge(supplierPaid, canonicalCashPayable)}
                              </div>
                            </div>
                          )}
                          {(pphTarget > 0 || pphPaid > 0) && (
                            <div className="flex items-center justify-between text-[11px]">
                              <span className="text-gray-600">PPh Withholding</span>
                              <div className="flex items-center gap-1.5">
                                <span className="font-mono text-gray-800">{fmtMoney(pphPaid)} / {fmtMoney(pphTarget)}</span>
                                {badge(pphPaid, pphTarget)}
                              </div>
                            </div>
                          )}
                          {(allocs.length + bslLines.length) > 1 && (
                            <div className="mt-1 overflow-x-auto">
                              <table className="w-full text-[10px]">
                                <thead className="text-gray-500 text-[9px] uppercase">
                                  <tr className="border-t border-gray-100">
                                    <th className="text-left font-medium py-0.5">Date</th>
                                    <th className="text-left font-medium py-0.5">Ref</th>
                                    <th className="text-right font-medium py-0.5">Amount</th>
                                    <th className="text-right font-medium py-0.5">Kind</th>
                                  </tr>
                                </thead>
                                <tbody>
                                  {allocs.map((a) => (
                                    <tr key={`va-${a.id}`} className="border-t border-gray-100">
                                      <td className="py-0.5 text-gray-700">{a.payment_vouchers?.payment_date ? formatDate(a.payment_vouchers.payment_date) : '—'}</td>
                                      <td className="py-0.5 text-gray-700 font-mono">{a.payment_vouchers?.voucher_number || 'PV'}</td>
                                      <td className="py-0.5 text-right font-mono">{fmtMoney(a.allocated_amount)}</td>
                                      <td className="py-0.5 text-right text-gray-500 capitalize">{a.payment_kind || 'supplier'}</td>
                                    </tr>
                                  ))}
                                  {bslLines.map((b) => {
                                    const lineCurrency = b.bank_accounts?.currency ?? currency;
                                    const lineAmount = (b.debit_amount || 0) + (b.credit_amount || 0);
                                    const fmtLine = (n: number) => formatCurrency(n, lineCurrency, { minimumFractionDigits: lineCurrency === 'IDR' ? 0 : 2, maximumFractionDigits: lineCurrency === 'IDR' ? 0 : 2 });
                                    return (
                                      <tr key={`bsl-${b.id}`} className="border-t border-gray-100">
                                        <td className="py-0.5 text-gray-700">{formatDate(b.transaction_date)}</td>
                                        <td className="py-0.5 text-gray-700 truncate max-w-[100px]">{b.description || 'Bank'}</td>
                                        <td className="py-0.5 text-right font-mono">{fmtLine(lineAmount)}</td>
                                        <td className="py-0.5 text-right text-gray-500 capitalize">{b.payment_kind || 'supplier'}</td>
                                      </tr>
                                    );
                                  })}
                                </tbody>
                              </table>
                            </div>
                          )}
                        </>
                      );
                    })()}
                  </div>
                )}
              </div>

              {/* Bank Reconciliation */}
              <div className="px-4 py-2 bg-gray-50/50">
                <h3 className="text-[11px] font-semibold text-gray-500 uppercase tracking-wide mb-1.5">Bank Reconciliation</h3>
                {bslLines.length > 0 ? (
                  <div className="space-y-1">
                    {bslLines.map((line) => {
                      const lineCurrency = line.bank_accounts?.currency ?? currency;
                      const fmtLine = (n: number) => formatCurrency(n, lineCurrency);
                      const bankAmount = line.debit_amount || line.credit_amount || 0;
                      const diff = bankAmount - viewingExpense.amount;
                      return (
                        <div key={line.id} className="px-2 py-1.5 bg-white border border-gray-200 rounded">
                          <div className="flex items-center gap-1.5 mb-1">
                            <span className="inline-flex items-center gap-0.5 px-1.5 py-0.5 rounded-full text-[9px] font-semibold bg-green-50 text-green-700 border border-green-200">
                              <CheckCircle className="w-2.5 h-2.5" /> Linked
                            </span>
                          </div>
                          <div className="grid grid-cols-2 gap-x-3 gap-y-0.5 text-[11px]">
                            <div className="flex items-center justify-between">
                              <span className="text-[9px] uppercase font-medium text-gray-400">Date</span>
                              <span className="text-gray-800">{formatDate(line.transaction_date)}</span>
                            </div>
                            <div className="flex items-center justify-between">
                              <span className="text-[9px] uppercase font-medium text-gray-400">Ref</span>
                              <span className="text-gray-800 truncate max-w-[80px]">{line.description?.slice(0, 20) || '—'}</span>
                            </div>
                            <div className="flex items-center justify-between">
                              <span className="text-[9px] uppercase font-medium text-gray-400">Bank Txn</span>
                              <span className="font-mono font-semibold text-gray-900">{fmtLine(bankAmount)}</span>
                            </div>
                            <div className="flex items-center justify-between">
                              <span className="text-[9px] uppercase font-medium text-gray-400">Matched</span>
                              <span className="font-mono font-semibold text-gray-900">{fmtMoney(viewingExpense.amount, 2)}</span>
                            </div>
                            <div className="flex items-center justify-between">
                              <span className="text-[9px] uppercase font-medium text-gray-400">Diff</span>
                              <span className={`font-mono font-medium ${Math.abs(diff) < 1 ? 'text-green-700' : 'text-orange-600'}`}>{fmtLine(diff)}</span>
                            </div>
                          </div>
                        </div>
                      );
                    })}
                  </div>
                ) : (
                  <div className="flex items-center gap-1.5 px-2 py-1.5 bg-white border border-gray-200 rounded text-[11px] text-gray-500">
                    <Link2 className="w-3.5 h-3.5 text-gray-400" />
                    Not linked to a bank transaction
                  </div>
                )}
              </div>
            </div>

            {/* ── DOCUMENTS + RELATED RECORDS (2-col on desktop) ── */}
            <div className="grid grid-cols-1 md:grid-cols-2 border-b border-gray-100">
              {/* Documents */}
              <div className="px-4 py-2 md:border-r border-gray-100">
                <h3 className="text-[11px] font-semibold text-gray-500 uppercase tracking-wide mb-1.5">
                  Documents {viewingExpense.document_urls && viewingExpense.document_urls.length > 0 && `(${viewingExpense.document_urls.length})`}
                </h3>
                {viewingExpense.document_urls && viewingExpense.document_urls.length > 0 ? (
                  <div className="grid grid-cols-2 gap-2">
                    {viewingExpense.document_urls.map((url, index) => {
                      const isImage = /\.(jpg|jpeg|png|gif|bmp|webp)$/i.test(url);
                      const fileName = url.split('/').pop()?.split('?')[0] || `Document ${index + 1}`;
                      return (
                        <div key={index} className="border border-gray-200 rounded overflow-hidden hover:border-blue-300 hover:shadow-sm transition-all">
                          {isImage ? (
                            <div className="cursor-pointer" onClick={() => openDocument(url)}>
                              <img
                                src={signedUrlCache[url] || url}
                                alt={fileName}
                                className="w-full h-16 object-cover border-b border-gray-200"
                              />
                            </div>
                          ) : (
                            <div className="h-16 flex items-center justify-center bg-gray-50 border-b border-gray-200">
                              <FileText className="w-6 h-6 text-gray-400" />
                            </div>
                          )}
                          <div className="px-1.5 py-1">
                            <p className="text-[10px] text-gray-700 font-medium truncate" title={fileName}>{fileName}</p>
                            <div className="mt-0.5 flex items-center gap-0.5">
                              <button
                                type="button"
                                onClick={() => openDocument(url)}
                                className="flex items-center gap-0.5 px-1.5 py-0.5 text-[9px] font-medium text-blue-600 hover:bg-blue-50 rounded"
                              >
                                <Eye className="w-2.5 h-2.5" /> View
                              </button>
                              <button
                                type="button"
                                onClick={() => downloadDocument(url, fileName)}
                                className="flex items-center gap-0.5 px-1.5 py-0.5 text-[9px] font-medium text-gray-600 hover:bg-gray-100 rounded"
                              >
                                <Download className="w-2.5 h-2.5" /> DL
                              </button>
                            </div>
                          </div>
                        </div>
                      );
                    })}
                  </div>
                ) : (
                  <div className="flex items-center gap-1.5 px-2 py-1.5 bg-gray-50 border border-gray-200 rounded text-[11px] text-gray-500">
                    <FileText className="w-3.5 h-3.5 text-gray-400" />
                    No documents attached
                  </div>
                )}
              </div>

              {/* Related Records */}
              <div className="px-4 py-2 bg-gray-50/50">
                <h3 className="text-[11px] font-semibold text-gray-500 uppercase tracking-wide mb-1.5">Related Records</h3>
                {hasRelated ? (
                  <div className="flex flex-wrap gap-1.5">
                    {viewingExpense.batches && (
                      <span className="inline-flex items-center gap-1 px-2 py-1 rounded bg-white border border-gray-200 text-[11px] text-gray-700">
                        <Package className="w-3 h-3 text-gray-500" /> Batch {viewingExpense.batches.batch_number}
                      </span>
                    )}
                    {viewingExpense.import_containers && (
                      <span className="inline-flex items-center gap-1 px-2 py-1 rounded bg-white border border-gray-200 text-[11px] text-gray-700">
                        <Package className="w-3 h-3 text-gray-500" /> {viewingExpense.import_containers.container_ref}
                      </span>
                    )}
                    {viewingExpense.delivery_challans && (
                      <button
                        type="button"
                        onClick={openLinkedDCQuickView}
                        disabled={linkedDCQuickViewLoading}
                        className="inline-flex items-center gap-1 px-2 py-1 rounded bg-white border border-gray-200 text-[11px] text-blue-600 hover:bg-blue-50 hover:border-blue-300 disabled:opacity-50"
                      >
                        <Truck className="w-3 h-3" /> DC {viewingExpense.delivery_challans.challan_number}
                        {linkedDCQuickViewLoading && ' …'}
                      </button>
                    )}
                    {viewingExpense.voucher_number && (
                      <span className="inline-flex items-center gap-1 px-2 py-1 rounded bg-white border border-gray-200 text-[11px] text-gray-700">
                        <Clipboard className="w-3 h-3 text-gray-500" /> {viewingExpense.voucher_number}
                      </span>
                    )}
                  </div>
                ) : (
                  <div className="flex items-center gap-1.5 px-2 py-1.5 bg-white border border-gray-200 rounded text-[11px] text-gray-500">
                    <Link2 className="w-3.5 h-3.5 text-gray-400" />
                    No related records
                  </div>
                )}
              </div>
            </div>

            {/* ── ACCOUNTING SUMMARY (collapsible, hidden by default) ── */}
            <div className="border-b border-gray-100">
                  <button
                    type="button"
                    onClick={() => setAccountingExpanded(!accountingExpanded)}
                    className="w-full px-4 py-1.5 flex items-center justify-between hover:bg-gray-50 transition-colors"
                  >
                    <span className="text-[11px] font-semibold text-gray-500 uppercase tracking-wide flex items-center gap-1.5">
                      <Banknote className="w-3.5 h-3.5 text-gray-400" />
                      Accounting Impact
                    </span>
                    <span className="text-gray-400 text-[10px]">{accountingExpanded ? 'Collapse' : 'Expand'}</span>
                  </button>
                  {accountingExpanded && (
                    (viewingExpense.effective_posting_state === 'ACTIVE' || viewingExpense.effective_posting_state === 'REPLACED') ? (
                    <div className="px-4 pb-2 grid grid-cols-2 md:grid-cols-4 gap-x-4 gap-y-1">
                      <div>
                        <div className="text-[9px] uppercase font-medium text-gray-400">Expenses (P&L)</div>
                        <div className="text-[12px] font-medium font-mono text-gray-800">{fmtMoney(canonicalExpenseTotal)}</div>
                      </div>
                      <div>
                        <div className="text-[9px] uppercase font-medium text-gray-400">Cash Paid</div>
                        <div className="text-[12px] font-medium font-mono text-gray-800">{fmtMoney(supplierPaid)}</div>
                      </div>
                      <div>
                        <div className="text-[9px] uppercase font-medium text-gray-400">Liabilities (A/P)</div>
                        <div className="text-[12px] font-medium font-mono text-gray-800">{fmtMoney(Math.max(0, balance))}</div>
                      </div>
                      <div>
                        <div className="text-[9px] uppercase font-medium text-gray-400">Assets (Recoverable)</div>
                        <div className="text-[12px] font-medium font-mono text-gray-800">{fmtMoney(viewingExpense.ppn_amount || 0)}</div>
                      </div>
                    </div>
                    ) : (
                      <div className="px-4 pb-2 text-[11px] text-gray-600">
                        {viewingExpense.effective_posting_state === 'REVERSED'
                            ? 'This expense is cancelled and has no current accounting effect. Journal history remains available in the audit views.'
                            : 'Accounting impact is not presented because the effective posting state requires review.'}
                      </div>
                    )
                  )}
                </div>

            {/* ── FOOTER ── */}
            <div className="px-4 py-2 flex justify-end gap-2">
              {canManage && (viewingExpense.effective_posting_state === 'ACTIVE' || viewingExpense.effective_posting_state === 'REPLACED' || viewingExpense.effective_posting_state === 'PENDING' || viewingExpense.effective_posting_state === 'REJECTED') && (
                <button
                  onClick={() => { handleEdit(viewingExpense); setViewModalOpen(false); setViewingExpense(null); }}
                  className="px-2.5 py-1 text-[11px] font-medium text-blue-700 bg-white border border-blue-300 rounded hover:bg-blue-50"
                >
                  Edit
                </button>
              )}
              <button
                onClick={() => { setViewModalOpen(false); setViewingExpense(null); setLinkedDCQuickView(null); }}
                className="px-2.5 py-1 text-[11px] font-medium bg-gray-700 text-white rounded hover:bg-gray-800"
              >
                Close
              </button>
            </div>
          </div>

          {/* Linked DC Quick View overlay */}
          {linkedDCQuickView && (
            <div className="fixed inset-0 z-[60] flex items-center justify-center bg-black/40 p-4">
              <div className="w-full max-w-2xl max-h-[80vh] overflow-hidden rounded-xl bg-white shadow-2xl">
                <div className="flex items-center justify-between border-b px-5 py-3">
                  <h4 className="text-[16px] font-semibold text-gray-900">
                    Delivery Challan {linkedDCQuickView.challan.challan_number}
                  </h4>
                  <button
                    type="button"
                    onClick={() => setLinkedDCQuickView(null)}
                    className="rounded-lg p-1 text-gray-500 hover:bg-gray-100"
                  >
                    <X className="w-5 h-5" />
                  </button>
                </div>
                <div className="space-y-4 overflow-y-auto p-5 text-sm">
                  <div className="grid grid-cols-2 gap-4">
                    <div>
                      <div className="text-[11px] uppercase font-medium text-gray-400">Date</div>
                      <div className="text-[15px] font-medium text-gray-800">{formatDate(linkedDCQuickView.challan.challan_date)}</div>
                    </div>
                    <div>
                      <div className="text-[11px] uppercase font-medium text-gray-400">Customer</div>
                      <div className="text-[15px] font-medium text-gray-800">{linkedDCQuickView.challan.customers?.company_name || '—'}</div>
                    </div>
                  </div>
                  <div>
                    <div className="text-[11px] uppercase font-medium text-gray-400 mb-2">Items</div>
                    {linkedDCQuickView.items.length === 0 ? (
                      <div className="text-gray-500 text-sm">No items found.</div>
                    ) : (
                      <div className="overflow-x-auto rounded-lg border border-gray-200">
                        <table className="min-w-full text-sm">
                          <thead className="bg-gray-50">
                            <tr>
                              <th className="px-3 py-2 text-left font-semibold text-gray-600">Product</th>
                              <th className="px-3 py-2 text-left font-semibold text-gray-600">Batch</th>
                              <th className="px-3 py-2 text-right font-semibold text-gray-600">Qty</th>
                            </tr>
                          </thead>
                          <tbody>
                            {linkedDCQuickView.items.map((item) => (
                              <tr key={item.id} className="border-t border-gray-100">
                                <td className="px-3 py-2 text-gray-700">{item.products?.product_name || '—'}</td>
                                <td className="px-3 py-2 text-gray-700">{item.batches?.batch_number || '—'}</td>
                                <td className="px-3 py-2 text-right font-mono text-gray-800">{Number(item.quantity || 0).toLocaleString('id-ID')}</td>
                              </tr>
                            ))}
                          </tbody>
                        </table>
                      </div>
                    )}
                  </div>
                </div>
              </div>
            </div>
          )}
          </div>
            </div>
          </div>
        </div>
        );
      })()}

      {/* Cancel Posting modal */}
      {cancelPostingModalOpen && cancelPostingTarget && (
        <Modal isOpen={cancelPostingModalOpen} onClose={closeCancelPostingModal} title="Cancel Expense Posting" size="sm">
          <div className="space-y-4">
            <div className={`${cancelPostingBlock ? 'bg-red-50 border-red-200 text-red-800' : 'bg-orange-50 border-orange-200 text-orange-800'} border rounded-lg p-3 text-sm`}>
              <p className="font-semibold mb-1">{cancelPostingTarget.expense_category} — {formatCurrency(calculateCanonicalExpenseTotal(cancelPostingTarget), getExpenseCurrency(cancelPostingTarget))}</p>
              {cancelPostingBlock ? (
                <p>{cancelPostingBlock.message}</p>
              ) : (
                <>
                  <p>This preserves the original journal, creates its auditable reversal, and returns the expense to Pending Approval.</p>
                  <p className="mt-1 text-xs flex items-center gap-1"><Lock className="w-3 h-3" /> Available only for unpaid expenses in an open accounting period.</p>
                </>
              )}
            </div>
            {!cancelPostingBlock && (
              <div>
                <label className="block text-sm font-medium text-gray-700 mb-1">Reason <span className="text-red-500">*</span></label>
                <textarea
                  value={cancelPostingReason}
                  onChange={e => setCancelPostingReason(e.target.value)}
                  rows={3}
                  placeholder="Reason for cancelling posting..."
                  className="w-full px-3 py-2 border border-gray-300 rounded-lg text-sm focus:ring-2 focus:ring-orange-500"
                />
              </div>
            )}
            <div className="flex justify-end gap-2">
              <button onClick={closeCancelPostingModal} className="h-7 px-2 text-xs border border-gray-300 rounded hover:bg-gray-50">Back</button>
              {cancelPostingBlock?.paymentVoucherId && onViewPaymentVoucher && (
                <button
                  type="button"
                  onClick={() => { const id = cancelPostingBlock.paymentVoucherId!; closeCancelPostingModal(); onViewPaymentVoucher(id); }}
                  className="h-7 px-2 text-xs border border-blue-300 text-blue-700 rounded hover:bg-blue-50"
                >
                  Open Payment Voucher
                </button>
              )}
              {cancelPostingBlock?.bankStatementLineId && (
                <button
                  type="button"
                  onClick={() => void handleCancelPostingBankUnlink()}
                  disabled={cancelPostingLoading}
                  className="h-7 px-2 text-xs border border-blue-300 text-blue-700 rounded hover:bg-blue-50 disabled:opacity-50"
                >
                  {cancelPostingLoading ? 'Checking...' : 'Unlink Bank Reconciliation'}
                </button>
              )}
              {!cancelPostingBlock && (
                <button
                  onClick={handleCancelPostingConfirm}
                  disabled={!cancelPostingReason.trim() || cancelPostingLoading}
                  className="h-7 px-2 text-xs bg-orange-600 text-white rounded hover:bg-orange-700 disabled:opacity-50 flex items-center gap-1.5"
                >
                  <RotateCcw className="w-3.5 h-3.5" />
                  {cancelPostingLoading ? 'Cancelling...' : 'Cancel Posting'}
                </button>
              )}
            </div>
          </div>
        </Modal>
      )}

      {/* Rejection reason modal */}
      {rejectionModalOpen && (
        <Modal isOpen={rejectionModalOpen} onClose={() => { setRejectionModalOpen(false); setRejectionReason(''); }} title="Reject Expense" size="sm">
          <div className="space-y-4">
            <p className="text-sm text-gray-600">Please provide a reason for rejecting this expense entry.</p>
            <textarea
              value={rejectionReason}
              onChange={e => setRejectionReason(e.target.value)}
              rows={3}
              placeholder="Reason for rejection..."
              className="w-full px-3 py-2 border border-gray-300 rounded-lg text-sm focus:ring-2 focus:ring-red-500 focus:border-red-500"
            />
            <div className="flex justify-end gap-2">
              <button onClick={() => { setRejectionModalOpen(false); setRejectionReason(''); }} className="h-7 px-2 text-xs border border-gray-300 rounded hover:bg-gray-50">Cancel</button>
              <button
                onClick={handleRejectExpenseConfirm}
                disabled={!rejectionReason.trim() || !!approvalLoading}
                className="h-7 px-2 text-xs bg-red-600 text-white rounded hover:bg-red-700 disabled:opacity-50"
              >
                Reject
              </button>
            </div>
          </div>
        </Modal>
      )}
    </div>
  );
}
