import { useEffect, useState } from 'react';
import { supabase } from '../../lib/supabase';
import { useAuth } from '../../contexts/AuthContext';
import { Search, ArrowUpCircle, Printer, Lock, RotateCcw, CheckCircle, X, ExternalLink, Info, Link2 } from 'lucide-react';
import { FinanceModal as Modal } from './FinanceModal';
import { SearchableSelect } from '../SearchableSelect';
import { MoneyInput } from '../MoneyInput';
import { FinancePage } from './FinancePage';
import { FinanceTable } from './FinanceTable';
import { FinanceModal } from './FinanceModal';
import { F_BTN_PRIMARY, F_BTN_SECONDARY } from './FinanceForm';
import { supabaseErrorMessage } from '../../utils/supabaseError';
import { formatCurrency } from '../../utils/currency';
import { linkBankStatementLine, savePaymentVoucher, applySettlementAdjustment } from '../../services/financeCommands';
import { BankTransactionLinkField } from './BankTransactionLinkField';
import { FinanceActionButton, FinanceBadge } from './FinanceUI';
import {
  type BankTransactionLine,
  FINANCE_RECONCILIATION_REFRESH_EVENT,
  linkBankTransaction,
  notifyFinanceReconciliationRefresh,
  unlinkBankTransaction,
} from './bankTransactionLinking';
import { FinanceDocumentAttachments, uploadFinanceDocuments } from './FinanceDocumentAttachments';
import { useFinance } from '../../contexts/FinanceContext';
import { VoucherBankLinkIndicator } from './VoucherBankLinkIndicator';
import { FloatingField, FLOAT_INPUT, FLOAT_TEXTAREA } from './FloatingField';
import { SapRow } from './SapLayout';
import {
  evaluateVoucherBankLink,
  type VoucherBankLinkEvaluation,
  type CanonicalAllocationDetail,
  type LegacyLinkDetail,
} from '../../utils/voucherBankLinks';

interface Supplier {
  id: string;
  company_name: string;
}

interface StaffMember {
  id: string;
  full_name: string;
  employee_code: string | null;
  default_payment_method?: string | null;
}

interface BankAccount {
  id: string;
  account_name: string;
  bank_name: string;
  alias: string | null;
  currency: string;
}

interface PurchaseInvoice {
  id: string;
  invoice_number: string;
  invoice_date: string;
  total_amount: number;
  paid_amount: number;
  balance_amount: number;
  currency: string;
}

interface TaxCode {
  id: string;
  code: string;
  name: string;
  rate: number;
}

interface PaymentVoucher {
  id: string;
  voucher_number: string;
  voucher_date: string;
  supplier_id: string | null;
  staff_id: string | null;
  payment_method: string;
  payment_purpose: 'general' | 'salary_advance' | 'salary_advance_settlement';
  salary_advance_status?: 'not_applicable' | 'outstanding' | 'partially_settled' | 'settled';
  salary_advance_applied_amount?: number;
  bank_account_id: string | null;
  reference_number: string | null;
  amount: number;
  invoice_amount?: number | null;
  payment_amount?: number | null;
  pph_amount: number;
  pph_code_id: string | null;
  net_amount: number;
  payment_currency: string | null;
  exchange_rate: number | null;
  bank_amount: number | null;
  bank_charge: number | null;
  bank_currency?: string | null;
  converted_amount?: number | null;
  actual_bank_debit?: number | null;
  description: string | null;
  document_urls: string[] | null;
  is_posted: boolean;
  journal_entry_id: string | null;
  bank_statement_line_id?: string | null;
  bank_link_status?: 'linked' | 'partial' | 'unlinked' | 'needs_review' | 'unknown';
  bank_linked_amount?: number;
  bank_link_evaluation?: VoucherBankLinkEvaluation;
  bank_statement_line?: BankTransactionLine | null;
  bank_statement_lines?: BankTransactionLine[];
  suppliers?: { company_name: string };
  finance_staff_master?: { full_name: string };
  bank_accounts?: { account_name: string; bank_name: string; alias: string | null; currency: string | null };
  // derived
  invoice_currency: string;
  invoice_numbers: { id: string; number: string }[];
  salary_advance_applications?: Array<{
    salary_expense_id: string;
    salary_voucher_number: string | null;
    applied_amount: number;
  }>;
}

interface PrefillInvoice {
  id: string;
  invoice_number: string;
  supplier_id: string;
  balance_amount: number;
  currency?: string;
}

interface PrefillExpenseBill {
  id: string;
  supplier_id: string | null;
  staff_id?: string | null;
  balance_amount: number;
}

interface PaymentVoucherManagerProps {
  canManage: boolean;
  initialViewVoucherId?: string | null;
  onInitialViewHandled?: () => void;
  prefillInvoice?: PrefillInvoice | null;
  onPrefillConsumed?: () => void;
  prefillExpenseBill?: PrefillExpenseBill | null;
  onPrefillExpenseBillConsumed?: () => void;
  onViewInvoice?: (invoiceId: string) => void;
  onViewExpense?: (expenseId: string) => void;
  prefillFromBankReconciliation?: {
    bankAccountId: string; statementLineId: string; date: string; amount: number; currency: 'IDR' | 'USD'; reference: string; description: string;
  } | null;
  onBankReconciliationPrefillConsumed?: () => void;
  onPaymentSavedFromBankReconciliation?: (voucherId: string, statementLineId: string) => void;
  onOpenBankReconciliation?: (bankAccountId?: string, statementLineId?: string) => void;
  embeddedModalOnly?: boolean;
  onCloseEmbedded?: () => void;
}

interface PaymentAllocationRow {
  payment_voucher_id: string | null;
  allocated_currency: string | null;
  purchase_invoices?: { id: string; invoice_number: string } | null;
  finance_expenses?: { id: string; voucher_number: string | null } | null;
}

export interface InvoiceAllocationItem {
  invoiceId: string;
  amount: number;
  currency: string;
  roundOffAmount?: number;
  discountAmount?: number;
  adjustmentType?: 'rounding' | 'discount' | 'write_off';
  adjustmentReason?: string;
}


interface ViewAllocationRow {
  purchase_invoice_id?: string | null;
  allocated_amount: number | null;
  allocated_currency: string | null;
  purchase_invoices?: { id: string; invoice_number: string; invoice_date: string } | { id: string; invoice_number: string; invoice_date: string }[] | null;
  finance_expenses?: {
    id: string;
    voucher_number: string | null;
    invoice_number: string | null;
    expense_date?: string;
    expense_category?: string;
    amount?: number;
    pph_amount?: number | null;
  } | {
    id: string;
    voucher_number: string | null;
    invoice_number: string | null;
    expense_date?: string;
    expense_category?: string;
    amount?: number;
    pph_amount?: number | null;
  }[] | null;
}

type PaymentPurpose = 'general' | 'salary_advance' | 'salary_advance_settlement';

// Outstanding expense bill for allocation in PV
interface OutstandingExpenseBillForPV {
  id: string;
  supplier_id: string | null;
  supplier_name: string | null;
  staff_id?: string | null;
  staff_name?: string | null;
  invoice_number: string | null;
  invoice_date: string;
  due_date: string | null;
  expense_category: string;
  description: string | null;
  amount: number;
  paid_amount: number;
  balance_amount: number;
  days_overdue: number;
}

function fmt(amount: number, currency: string) {
  return formatCurrency(amount, currency, {
    minimumFractionDigits: currency === 'IDR' ? 0 : 2,
    maximumFractionDigits: currency === 'IDR' ? 0 : 2,
  });
}


export function PaymentVoucherManager({
  canManage,
  initialViewVoucherId,
  onInitialViewHandled,
  prefillInvoice,
  onPrefillConsumed,
  prefillExpenseBill,
  onPrefillExpenseBillConsumed,
  onViewInvoice,
  onViewExpense,
  prefillFromBankReconciliation,
  onBankReconciliationPrefillConsumed,
  onPaymentSavedFromBankReconciliation,
  onOpenBankReconciliation,
  embeddedModalOnly,
  onCloseEmbedded,
}: PaymentVoucherManagerProps) {
  const { profile } = useAuth();
  const { dateRange } = useFinance();
  const isAdmin = profile?.role === 'admin';
  const [cancelPostingTarget, setCancelPostingTarget] = useState<PaymentVoucher | null>(null);
  const [cancelPostingReason, setCancelPostingReason] = useState('');
  const [cancelPostingLoading, setCancelPostingLoading] = useState(false);
  const [postingLoading, setPostingLoading] = useState<string | null>(null);
  const [vouchers, setVouchers] = useState<PaymentVoucher[]>([]);
  const [suppliers, setSuppliers] = useState<Supplier[]>([]);
  const [staffList, setStaffList] = useState<StaffMember[]>([]);
  const [bankAccounts, setBankAccounts] = useState<BankAccount[]>([]);
  const [pendingInvoices, setPendingInvoices] = useState<PurchaseInvoice[]>([]);
  const [taxCodes, setTaxCodes] = useState<TaxCode[]>([]);
  const [loading, setLoading] = useState(true);
  const [modalOpen, setModalOpen] = useState(false);
  const [searchTerm, setSearchTerm] = useState('');
  const [voucherView, setVoucherView] = useState<'payments' | 'settlements' | 'all'>('payments');
  const [allocations, setAllocations] = useState<InvoiceAllocationItem[]>([]);
  const [roundingTolerance, setRoundingTolerance] = useState<number>(100);
  const [expenseBillAllocations, setExpenseBillAllocations] = useState<{ expenseId: string; amount: number }[]>([]);
  const [outstandingExpenseBills, setOutstandingExpenseBills] = useState<OutstandingExpenseBillForPV[]>([]);
  const [selectedBank, setSelectedBank] = useState<BankAccount | null>(null);
  const [editingVoucher, setEditingVoucher] = useState<PaymentVoucher | null>(null);
  const [viewingVoucher, setViewingVoucher] = useState<PaymentVoucher | null>(null);
  const [bankReconStatementLineId, setBankReconStatementLineId] = useState<string | null>(null);
  // A Bank Reconciliation-created voucher must settle the exact statement
  // amount and the exact bank master selected on the statement line.
  const [bankReconExpectedAmount, setBankReconExpectedAmount] = useState<number | null>(null);
  const [bankReconBankAccountId, setBankReconBankAccountId] = useState<string | null>(null);
  const [uploadingFiles, setUploadingFiles] = useState<File[]>([]);
  const [activeInvoicePopoverId, setActiveInvoicePopoverId] = useState<string | null>(null);
  const [viewAllocations, setViewAllocations] = useState<Array<{ invoice_id: string; invoice_number: string; invoice_date: string; allocated_amount: number; allocated_currency: string; is_expense_bill?: boolean; expense_id?: string; expense_category?: string; gross_salary?: number; advance_applied?: number; pph21?: number; settlement_adjustment?: number; adjustment_type?: string }>>([]);

  const [formData, setFormData] = useState({
    voucher_date: new Date().toISOString().split('T')[0],
    payee_type: 'supplier' as 'supplier' | 'staff',
    supplier_id: '',
    staff_id: '',
    payment_method: 'bank_transfer',
    payment_purpose: 'general' as PaymentPurpose,
    bank_account_id: '',
    reference_number: '',
    amount: 0,
    bank_charge: 0,
    pph_code_id: '',
    pph_amount: 0,
    description: '',
    document_urls: [] as string[],
    payment_currency: 'IDR',
    exchange_rate: 1,
  });

  useEffect(() => {
    if (!activeInvoicePopoverId) return;
    const handleOutsideClick = () => setActiveInvoicePopoverId(null);
    document.addEventListener('click', handleOutsideClick);
    return () => document.removeEventListener('click', handleOutsideClick);
  }, [activeInvoicePopoverId]);

  useEffect(() => {
    loadVouchers();
  }, [dateRange.startDate, dateRange.endDate]);

  useEffect(() => {
    const handleReconRefresh = () => {
      void loadVouchers();
    };
    window.addEventListener(FINANCE_RECONCILIATION_REFRESH_EVENT, handleReconRefresh);
    return () => window.removeEventListener(FINANCE_RECONCILIATION_REFRESH_EVENT, handleReconRefresh);
  }, []);

  useEffect(() => {
    loadSuppliers();
    loadStaff();
    loadBankAccounts();
    loadTaxCodes();
    supabase
      .from('app_settings')
      .select('rounding_tolerance_amount')
      .limit(1)
      .maybeSingle()
      .then(({ data }) => {
        if (data && data.rounding_tolerance_amount !== undefined && data.rounding_tolerance_amount !== null) {
          setRoundingTolerance(Number(data.rounding_tolerance_amount));
        }
      });
  }, []);

  useEffect(() => {
    if (prefillInvoice && !loading) {
      setFormData(prev => ({ ...prev, supplier_id: prefillInvoice.supplier_id, amount: prefillInvoice.balance_amount }));
      setModalOpen(true);
      onPrefillConsumed?.();
    }
  }, [prefillInvoice, loading]);

  useEffect(() => {
    // "Settle" from ExpenseManager: open a new voucher pre-allocated to the
    // outstanding expense bill (same engine as manual expense allocation).
    // Works for supplier bills and staff bills (salary/advance).
    if (prefillExpenseBill && !loading) {
      const isStaff = !!prefillExpenseBill.staff_id;
      setFormData(prev => ({
        ...prev,
        payee_type: isStaff ? 'staff' : 'supplier',
        supplier_id: isStaff ? '' : (prefillExpenseBill.supplier_id || ''),
        staff_id: isStaff ? (prefillExpenseBill.staff_id || '') : '',
        amount: prefillExpenseBill.balance_amount,
      }));
      loadOutstandingExpenseBillsForPayee(
        isStaff ? null : prefillExpenseBill.supplier_id,
        isStaff ? prefillExpenseBill.staff_id || null : null,
      );
      setExpenseBillAllocations([{ expenseId: prefillExpenseBill.id, amount: prefillExpenseBill.balance_amount }]);
      setModalOpen(true);
      onPrefillExpenseBillConsumed?.();
    }
  }, [prefillExpenseBill, loading]);

  useEffect(() => {
    if (!prefillFromBankReconciliation || loading) return;
    setEditingVoucher(null);
    setBankReconStatementLineId(prefillFromBankReconciliation.statementLineId);
    setBankReconExpectedAmount(prefillFromBankReconciliation.amount);
    setBankReconBankAccountId(prefillFromBankReconciliation.bankAccountId);
    setAllocations([]);
    setExpenseBillAllocations([]);
    setFormData(prev => ({
      ...prev,
      voucher_date: prefillFromBankReconciliation.date,
      bank_account_id: prefillFromBankReconciliation.bankAccountId,
      reference_number: prefillFromBankReconciliation.reference,
      amount: prefillFromBankReconciliation.amount,
      description: prefillFromBankReconciliation.description,
      payment_method: 'bank_transfer',
      payment_currency: prefillFromBankReconciliation.currency,
      exchange_rate: prefillFromBankReconciliation.currency === 'IDR' ? 1 : 0,
    }));
    setSelectedBank(bankAccounts.find(bank => bank.id === prefillFromBankReconciliation.bankAccountId) || null);
    setModalOpen(true);
    onBankReconciliationPrefillConsumed?.();
  }, [prefillFromBankReconciliation, loading, bankAccounts]);

  useEffect(() => {
    // In edit mode handleEdit manages invoice loading — skip this effect entirely
    if (editingVoucher) return;
    if (formData.payee_type === 'staff') {
      // Staff payee: no purchase invoices, only the staff member's outstanding bills
      setPendingInvoices([]);
      setAllocations([]);
      if (formData.staff_id) {
        loadOutstandingExpenseBillsForPayee(null, formData.staff_id);
      } else {
        setOutstandingExpenseBills([]);
        setExpenseBillAllocations([]);
      }
      return;
    }
    if (formData.supplier_id) {
      const isPrefill = prefillInvoice && prefillInvoice.supplier_id === formData.supplier_id;
      loadPendingInvoices(
        formData.supplier_id,
        isPrefill ? prefillInvoice.id : undefined,
        isPrefill ? prefillInvoice.balance_amount : undefined,
        isPrefill ? (prefillInvoice.currency || 'IDR') : undefined,
      );
    } else {
      setPendingInvoices([]);
      setAllocations([]);
    }
  }, [formData.supplier_id, formData.staff_id, formData.payee_type, editingVoucher]);

  useEffect(() => {
    if (formData.bank_account_id) {
      const bank = bankAccounts.find(b => b.id === formData.bank_account_id);
      if (bank) {
        setSelectedBank(bank);
        if (!editingVoucher) {
          setFormData(prev => {
            const invoiceCcy = pendingInvoices[0]?.currency || 'IDR';
            const bankCcy = bank.currency || 'IDR';
            const nextRate = invoiceCcy === bankCcy ? 1 : 0;
            if (prev.payment_currency === bankCcy && prev.exchange_rate === nextRate) return prev;
            return { ...prev, payment_currency: bankCcy, exchange_rate: nextRate };
          });
        }
      }
    } else {
      setSelectedBank(null);
    }
  }, [formData.bank_account_id, bankAccounts, editingVoucher, pendingInvoices]);

  useEffect(() => {
    if (formData.pph_code_id && formData.amount > 0) {
      const tax = taxCodes.find(t => t.id === formData.pph_code_id);
      if (tax) {
        setFormData(prev => ({ ...prev, pph_amount: Math.round(formData.amount * (tax.rate / 100)) }));
      }
    } else {
      setFormData(prev => ({ ...prev, pph_amount: 0 }));
    }
  }, [formData.pph_code_id, formData.amount, taxCodes]);

  const loadVouchers = async () => {
    try {
      // finance_staff_master embed requires the staff-accounting migration;
      // fall back to the supplier-only select on a DB that predates it.
      let { data, error } = await supabase
        .from('payment_vouchers')
        .select('*, suppliers(company_name), finance_staff_master(full_name), bank_accounts(account_name, bank_name, alias, currency)')
        .gte('voucher_date', dateRange.startDate)
        .lte('voucher_date', dateRange.endDate)
        .order('voucher_date', { ascending: false })
        .order('voucher_number', { ascending: false });
      if (error && /finance_staff_master|staff_id/i.test(error.message || '')) {
        ({ data, error } = await supabase
          .from('payment_vouchers')
          .select('*, suppliers(company_name), bank_accounts(account_name, bank_name, alias, currency)')
          .gte('voucher_date', dateRange.startDate)
          .lte('voucher_date', dateRange.endDate)
          .order('voucher_date', { ascending: false })
          .order('voucher_number', { ascending: false }));
      }
      if (error) throw error;

      const voucherIds = (data || []).map((v: PaymentVoucher) => v.id);
      const journalEntryIds = (data || [])
        .map((v: PaymentVoucher) => v.journal_entry_id)
        .filter((id): id is string => !!id);
      const allocCcyMap: Record<string, string> = {};
      const invoicesMap: Record<string, { id: string; number: string }[]> = {};
      const bankLineMap = new Map<string, BankTransactionLine>();
      const bankLinesByPaymentId = new Map<string, BankTransactionLine[]>();
      const advanceApplicationsMap: Record<string, PaymentVoucher['salary_advance_applications']> = {};
      if (voucherIds.length > 0) {
        const { data: allocs } = await supabase
          .from('voucher_allocations')
          .select('payment_voucher_id, allocated_currency, purchase_invoices(id, invoice_number)')
          .in('payment_voucher_id', voucherIds);
        for (const a of (allocs || []) as unknown as PaymentAllocationRow[]) {
          if (!a.payment_voucher_id) continue;
          if (!allocCcyMap[a.payment_voucher_id]) {
            allocCcyMap[a.payment_voucher_id] = a.allocated_currency || '';
          }
          if (a.purchase_invoices) {
            invoicesMap[a.payment_voucher_id] = invoicesMap[a.payment_voucher_id] || [];
            invoicesMap[a.payment_voucher_id].push({
              id: a.purchase_invoices.id,
              number: a.purchase_invoices.invoice_number,
            });
          }
        }

        const { data: advanceApplications } = await supabase
          .from('salary_advance_applications')
          .select('advance_payment_voucher_id, salary_expense_id, applied_amount, finance_expenses(voucher_number)')
          .in('advance_payment_voucher_id', voucherIds);
        for (const application of (advanceApplications || []) as unknown as Array<{
          advance_payment_voucher_id: string;
          salary_expense_id: string;
          applied_amount: number;
          finance_expenses?: { voucher_number: string | null } | null;
        }>) {
          const rows = advanceApplicationsMap[application.advance_payment_voucher_id] || [];
          rows.push({
            salary_expense_id: application.salary_expense_id,
            salary_voucher_number: application.finance_expenses?.voucher_number || null,
            applied_amount: application.applied_amount,
          });
          advanceApplicationsMap[application.advance_payment_voucher_id] = rows;
        }
      }

      const legacyByJournalMap = new Map<string, LegacyLinkDetail[]>();
      const legacyByPaymentMap = new Map<string, LegacyLinkDetail[]>();

      if (journalEntryIds.length > 0) {
        const { data: bankLines, error: bankLineError } = await supabase
          .from('bank_statement_lines')
          .select(`
            id,
            transaction_date,
            description,
            reference,
            debit_amount,
            credit_amount,
            bank_account_id,
            matched_entry_id,
            manually_unlinked,
            bank_accounts(bank_name, account_name, account_number, alias, currency)
          `)
          .in('matched_entry_id', journalEntryIds);
        if (bankLineError) throw bankLineError;
        for (const line of (bankLines || []) as unknown as any[]) {
          if (line.matched_entry_id) {
            bankLineMap.set(line.matched_entry_id, line);
            const list = legacyByJournalMap.get(line.matched_entry_id) || [];
            list.push({
              bank_statement_line_id: line.id,
              debit_amount: line.debit_amount,
              credit_amount: line.credit_amount,
              transaction_date: line.transaction_date,
              description: line.description,
              reference: line.reference,
              bank_account_id: line.bank_account_id,
              manually_unlinked: line.manually_unlinked,
            });
            legacyByJournalMap.set(line.matched_entry_id, list);
          }
        }
      }

      if (voucherIds.length > 0) {
        const { data: directPaymentLines } = await supabase
          .from('bank_statement_lines')
          .select(`
            id,
            transaction_date,
            description,
            reference,
            debit_amount,
            credit_amount,
            bank_account_id,
            matched_payment_id,
            manually_unlinked
          `)
          .in('matched_payment_id', voucherIds);
        for (const line of (directPaymentLines || []) as unknown as any[]) {
          if (line.matched_payment_id) {
            const list = legacyByPaymentMap.get(line.matched_payment_id) || [];
            list.push({
              bank_statement_line_id: line.id,
              debit_amount: line.debit_amount,
              credit_amount: line.credit_amount,
              transaction_date: line.transaction_date,
              description: line.description,
              reference: line.reference,
              bank_account_id: line.bank_account_id,
              manually_unlinked: line.manually_unlinked,
            });
            legacyByPaymentMap.set(line.matched_payment_id, list);
          }
        }
      }

      // Canonical bank allocations are authoritative and support one bank
      // event settling many vouchers/documents. Legacy journal links remain a
      // compatibility fallback checked for conflicts.
      const canonicalAllocationsByVoucher = new Map<string, CanonicalAllocationDetail[]>();
      let linkStatusFailed = false;

      if (voucherIds.length > 0) {
        try {
          const { data: canonicalBankAllocations, error: canonicalBankError } = await supabase
            .from('bank_statement_allocations')
            .select(`
              id,
              document_id,
              document_type,
              allocation_amount,
              bank_statement_line_id,
              bank_statement_lines (
                id,
                transaction_date,
                description,
                reference,
                debit_amount,
                credit_amount,
                bank_account_id,
                bank_accounts(bank_name, account_name, account_number, alias, currency)
              )
            `)
            .eq('document_type', 'payment')
            .in('document_id', voucherIds);
          if (canonicalBankError) throw canonicalBankError;
          for (const allocation of (canonicalBankAllocations || []) as any[]) {
            const line = Array.isArray(allocation.bank_statement_lines)
              ? allocation.bank_statement_lines[0]
              : allocation.bank_statement_lines;
            if (line) {
              const lines = bankLinesByPaymentId.get(allocation.document_id) || [];
              if (!lines.some(existing => existing.id === line.id)) lines.push(line as BankTransactionLine);
              bankLinesByPaymentId.set(allocation.document_id, lines);
            }
            if (allocation.document_id) {
              const allocList = canonicalAllocationsByVoucher.get(allocation.document_id) || [];
              allocList.push({
                id: allocation.id,
                bank_statement_line_id: line?.id || allocation.bank_statement_line_id,
                allocation_amount: Number(allocation.allocation_amount || 0),
                document_id: allocation.document_id,
                document_type: 'payment',
                bank_statement_lines: line || null,
              });
              canonicalAllocationsByVoucher.set(allocation.document_id, allocList);
            }
          }
        } catch (linkError) {
          console.error('Could not load payment bank allocations:', linkError);
          linkStatusFailed = true;
        }
      }

      const enriched = (data || []).map((v: PaymentVoucher) => {
        const bankCcy = v.bank_accounts?.currency || 'IDR';
        const isCross = (v.invoice_currency || allocCcyMap[v.id] || bankCcy) !== bankCcy;
        const invCcy = v.invoice_currency || allocCcyMap[v.id] || (isCross ? 'USD' : bankCcy);
        const canonicalBankLines = bankLinesByPaymentId.get(v.id) || [];
        const legacyBankLine = v.journal_entry_id ? bankLineMap.get(v.journal_entry_id) : null;
        const bankLinesForVoucher = canonicalBankLines.length > 0
          ? canonicalBankLines
          : (legacyBankLine ? [legacyBankLine] : []);
        const bankLine = bankLinesForVoucher[0] || null;

        const debitRequired = v.payment_purpose === 'salary_advance_settlement'
          ? 0
          : (isCross ? (v.bank_amount || 0) : (v.amount || 0) + (v.bank_charge || 0));

        const canonicalList = canonicalAllocationsByVoucher.get(v.id) || [];
        const legacyList: LegacyLinkDetail[] = [
          ...(legacyByPaymentMap.get(v.id) || []),
          ...(v.journal_entry_id ? (legacyByJournalMap.get(v.journal_entry_id) || []) : []),
        ];
        const uniqueLegacyMap = new Map<string, LegacyLinkDetail>();
        for (const l of legacyList) {
          uniqueLegacyMap.set(l.bank_statement_line_id, l);
        }

        const evaluation = evaluateVoucherBankLink({
          expectedAmount: debitRequired,
          canonicalAllocations: canonicalList,
          legacyLinks: Array.from(uniqueLegacyMap.values()),
          currency: bankCcy,
          isInternalSettlement: v.payment_purpose === 'salary_advance_settlement',
          isCash: v.payment_method === 'cash',
        });

        return {
          ...v,
          invoice_currency: invCcy,
          invoice_numbers: invoicesMap[v.id] || [],
          salary_advance_applications: advanceApplicationsMap[v.id] || [],
          bank_statement_line_id: bankLine?.id || null,
          bank_statement_line: bankLine,
          bank_statement_lines: bankLinesForVoucher,
          bank_link_status: (linkStatusFailed ? 'unknown' : evaluation.status) as PaymentVoucher['bank_link_status'],
          bank_linked_amount: evaluation.canonicalAmount,
          bank_link_evaluation: evaluation,
        };
      });
      setVouchers(enriched);
    } catch (error) {
      console.error('Error loading vouchers:', error);
    } finally {
      setLoading(false);
    }
  };

  const loadSuppliers = async () => {
    const { data } = await supabase.from('suppliers').select('id, company_name').order('company_name');
    setSuppliers(data || []);
  };

  const loadStaff = async () => {
    const { data } = await supabase
      .from('finance_staff_master')
      .select('id, full_name, employee_code, default_payment_method')
      .eq('status', 'active')
      .order('full_name');
    setStaffList(data || []);
  };

  const loadBankAccounts = async () => {
    const { data } = await supabase.from('bank_accounts').select('id, account_name, bank_name, alias, currency').eq('is_active', true);
    setBankAccounts(data || []);
  };

  const loadTaxCodes = async () => {
    const { data } = await supabase.from('tax_codes').select('id, code, name, rate').eq('is_withholding', true);
    setTaxCodes(data || []);
  };

  const loadPendingInvoices = async (supplierId: string, preSelectId?: string, preSelectAmount?: number, preSelectCurrency?: string) => {
    const { data } = await supabase
      .from('purchase_invoices')
      .select('id, invoice_number, invoice_date, total_amount, paid_amount, balance_amount, currency')
      .eq('supplier_id', supplierId)
      .gt('balance_amount', 0)
      .order('invoice_date');
    setPendingInvoices(data || []);
    if (preSelectId && preSelectAmount) {
      setAllocations([{ invoiceId: preSelectId, amount: preSelectAmount, currency: preSelectCurrency || 'IDR' }]);
    } else {
      setAllocations([]);
    }

    // Also load outstanding expense bills for this supplier
    await loadOutstandingExpenseBillsForPayee(supplierId, null);
    setExpenseBillAllocations([]);
  };

  const loadOutstandingExpenseBillsForPayee = async (supplierId: string | null, staffId: string | null) => {
    try {
      const today = new Date().toISOString().split('T')[0];
      const { data } = await supabase.rpc('get_outstanding_expense_bills', { p_as_of_date: today });
      const filtered = (data || []).filter((b: OutstandingExpenseBillForPV) =>
        staffId ? b.staff_id === staffId
        : supplierId ? b.supplier_id === supplierId
        : true
      );
      setOutstandingExpenseBills(filtered);
    } catch (err) {
      console.error('Error loading outstanding expense bills:', err);
    }
  };

  const handleExpenseBillAllocationChange = (bill: OutstandingExpenseBillForPV, amount: number) => {
    setExpenseBillAllocations(prev => {
      const existing = prev.find(a => a.expenseId === bill.id);
      if (existing) {
        if (amount <= 0) return prev.filter(a => a.expenseId !== bill.id);
        return prev.map(a => a.expenseId === bill.id ? { ...a, amount } : a);
      }
      if (amount > 0) return [...prev, { expenseId: bill.id, amount }];
      return prev;
    });
  };

  const handleAllocationChange = (
    invoice: PurchaseInvoice,
    amount: number,
    patch?: Partial<InvoiceAllocationItem>,
  ) => {
    setAllocations(prev => {
      const existing = prev.find(a => a.invoiceId === invoice.id);
      const safeAmount = Math.max(0, Math.round(amount * 100) / 100);
      const availableBalance = editingVoucher
        ? Math.round((invoice.balance_amount + (existing?.amount || 0)) * 100) / 100
        : invoice.balance_amount;
      const residual = Math.max(0, Math.round((availableBalance - safeAmount) * 100) / 100);

      let roundOff = existing?.roundOffAmount ?? 0;
      let discount = existing?.discountAmount ?? 0;
      let adjType = existing?.adjustmentType || 'rounding';
      let adjReason = existing?.adjustmentReason || '';

      if (patch) {
        if (patch.roundOffAmount !== undefined) roundOff = patch.roundOffAmount;
        if (patch.discountAmount !== undefined) discount = patch.discountAmount;
        if (patch.adjustmentType !== undefined) adjType = patch.adjustmentType;
        if (patch.adjustmentReason !== undefined) adjReason = patch.adjustmentReason;
      } else if (!existing || existing.discountAmount === undefined || existing.discountAmount === 0) {
        if (safeAmount > 0 && residual > 0 && residual <= roundingTolerance) {
          roundOff = residual;
          adjType = 'rounding';
          adjReason = 'invoice_rounding_tolerance';
        } else if (residual > roundingTolerance && roundOff > 0) {
          roundOff = 0;
        }
      }

      if (safeAmount <= 0 && roundOff <= 0 && discount <= 0) {
        return prev.filter(a => a.invoiceId !== invoice.id);
      }

      const updated: InvoiceAllocationItem = {
        invoiceId: invoice.id,
        amount: safeAmount,
        currency: invoice.currency || 'IDR',
        roundOffAmount: roundOff,
        discountAmount: discount,
        adjustmentType: adjType,
        adjustmentReason: adjReason,
      };

      if (existing) {
        return prev.map(a => a.invoiceId === invoice.id ? updated : a);
      }
      return [...prev, updated];
    });
  };

  const invoiceCurrency = pendingInvoices.length > 0 ? (pendingInvoices[0].currency || 'IDR') : 'IDR';
  const bankCurrency = selectedBank?.currency || formData.payment_currency || 'IDR';
  const isCrossCurrency = pendingInvoices.length > 0 && invoiceCurrency !== bankCurrency;

  // Bank accounts split by whether they match the invoice currency
  const matchingBankAccounts = bankAccounts.filter(b => (b.currency || 'IDR') === invoiceCurrency);
  const otherBankAccounts   = bankAccounts.filter(b => (b.currency || 'IDR') !== invoiceCurrency);

  // True when user picked a mismatched bank but hasn't set an exchange rate
  const currencyMismatchWithoutRate =
    isCrossCurrency &&
    selectedBank !== null &&
    formData.exchange_rate <= 0;
  const effectiveRate = isCrossCurrency ? formData.exchange_rate : 1;
  const invoiceInBankCurrency = formData.amount * effectiveRate;
  const bankCharge = formData.bank_charge || 0;
  const netInvoiceAmount = formData.amount - formData.pph_amount;
  const convertedPaymentAmount = netInvoiceAmount * effectiveRate;
  const totalBankDebit = convertedPaymentAmount + bankCharge;
  const netBankDebit = totalBankDebit;
  const totalAllocated = allocations.reduce((sum, a) => sum + a.amount, 0);
  const totalRoundOff = allocations.reduce((sum, a) => sum + (a.roundOffAmount || 0), 0);
  const totalDiscount = allocations.reduce((sum, a) => sum + (a.discountAmount || 0), 0);
  const totalExpenseBillAllocated = expenseBillAllocations.reduce((sum, a) => sum + a.amount, 0);

  const resetForm = () => {
    setFormData({
      voucher_date: new Date().toISOString().split('T')[0],
      payee_type: 'supplier',
      supplier_id: '',
      staff_id: '',
      payment_method: 'bank_transfer',
      payment_purpose: 'general',
      bank_account_id: '',
      reference_number: '',
      amount: 0,
      bank_charge: 0,
      pph_code_id: '',
      pph_amount: 0,
      description: '',
      document_urls: [],
      payment_currency: 'IDR',
      exchange_rate: 1,
    });
    setAllocations([]);
    setExpenseBillAllocations([]);
    setOutstandingExpenseBills([]);
    setPendingInvoices([]);
    setSelectedBank(null);
    setEditingVoucher(null);
    setBankReconStatementLineId(null);
    setBankReconExpectedAmount(null);
    setBankReconBankAccountId(null);
    setUploadingFiles([]);
  };

  const handlePostVoucher = async (v: PaymentVoucher) => {
    if (!profile?.id) return;
    setPostingLoading(v.id);
    try {
      const { error } = await supabase.rpc('post_payment_voucher', {
        p_pv_id: v.id,
        p_posted_by: profile.id,
      });
      if (error) throw error;
      loadVouchers();
    } catch (err) {
      alert('Failed to post: ' + supabaseErrorMessage(err));
    } finally {
      setPostingLoading(null);
    }
  };

  const openCancelPostingModal = (v: PaymentVoucher) => {
    setCancelPostingTarget(v);
    setCancelPostingReason('');
  };

  const handleCancelPostingConfirm = async () => {
    if (!cancelPostingTarget || !profile?.id) return;
    setCancelPostingLoading(true);
    try {
      const { error } = await supabase.rpc('cancel_payment_voucher_posting', {
        p_pv_id: cancelPostingTarget.id,
        p_cancelled_by: profile.id,
        p_reason: cancelPostingReason || null,
      });
      if (error) {
        if (error.message?.includes('period') && error.message?.includes('closed')) {
          alert('Cannot cancel posting: the accounting period for this voucher is closed.');
          return;
        }
        throw error;
      }
      setCancelPostingTarget(null);
      setCancelPostingReason('');
      loadVouchers();
    } catch (err) {
      alert('Failed to cancel posting: ' + supabaseErrorMessage(err));
    } finally {
      setCancelPostingLoading(false);
    }
  };

  const handleEdit = async (v: PaymentVoucher) => {
    if (v.is_posted) {
      alert('This payment voucher has been posted to the GL. Cancel posting first to edit it.');
      return;
    }
    setEditingVoucher(v);
    setFormData({
      voucher_date: v.voucher_date,
      payee_type: v.staff_id ? 'staff' : 'supplier',
      supplier_id: v.supplier_id || '',
      staff_id: v.staff_id || '',
      payment_method: v.payment_method,
      payment_purpose: v.payment_purpose || 'general',
      bank_account_id: v.bank_account_id || '',
      reference_number: v.reference_number || '',
      amount: v.amount,
      bank_charge: v.bank_charge || 0,
      pph_code_id: v.pph_code_id || '',
      pph_amount: v.pph_amount || 0,
      description: v.description || '',
      document_urls: v.document_urls || [],
      payment_currency: v.payment_currency || 'IDR',
      exchange_rate: v.exchange_rate || 1,
    });
    if (v.bank_account_id) {
      const bank = bankAccounts.find(b => b.id === v.bank_account_id);
      if (bank) setSelectedBank(bank);
    }
    // Load all invoices for this supplier (including paid ones so we can re-allocate).
    // Staff vouchers have no purchase invoices.
    const { data: invData } = v.supplier_id
      ? await supabase
          .from('purchase_invoices')
          .select('id, invoice_number, invoice_date, total_amount, paid_amount, balance_amount, currency')
          .eq('supplier_id', v.supplier_id)
          .order('invoice_date')
      : { data: [] as PurchaseInvoice[] };
    setPendingInvoices(invData || []);
    // Load existing allocations for this voucher — both invoice and expense-bill
    // kinds, so updating the voucher doesn't silently drop expense allocations.
    const { data: allocs } = await supabase
      .from('voucher_allocations')
      .select('purchase_invoice_id, finance_expense_id, allocated_amount, allocated_currency')
      .eq('payment_voucher_id', v.id);

    const { data: adjData } = await supabase
      .from('invoice_rounding_adjustments')
      .select('purchase_invoice_id, adjustment_amount, adjustment_type, reason')
      .eq('payment_voucher_id', v.id);
    const adjMap = (adjData || []).reduce<Record<string, { amount: number; type: 'rounding' | 'discount' | 'write_off'; reason: string }>>((acc, adj) => {
      if (adj.purchase_invoice_id) {
        acc[adj.purchase_invoice_id] = {
          amount: Number(adj.adjustment_amount),
          type: (adj.adjustment_type as 'rounding' | 'discount' | 'write_off') || 'rounding',
          reason: adj.reason || '',
        };
      }
      return acc;
    }, {});

    setAllocations((allocs || []).filter(a => a.purchase_invoice_id).map(a => {
      // Always use invoice currency for allocation amounts.
      // If stored currency doesn't match the invoice currency (e.g. IDR bank debit was
      // accidentally stored instead of the USD invoice amount), normalise to invoice currency
      // and cap at invoice total to prevent false Over! warnings.
      const matchedInv = (invData || []).find(inv => inv.id === a.purchase_invoice_id);
      const invCurrency = matchedInv?.currency || a.allocated_currency || 'IDR';
      const currencyMismatch = a.allocated_currency && matchedInv?.currency &&
        a.allocated_currency !== matchedInv.currency;
      const safeAmount = currencyMismatch
        ? Math.min(a.allocated_amount, matchedInv!.total_amount)
        : a.allocated_amount;
      const adj = adjMap[a.purchase_invoice_id];
      return {
        invoiceId: a.purchase_invoice_id,
        amount: safeAmount,
        currency: invCurrency,
        roundOffAmount: adj?.type === 'rounding' ? adj.amount : 0,
        discountAmount: adj?.type === 'discount' || adj?.type === 'write_off' ? adj.amount : 0,
        adjustmentType: adj?.type || 'rounding',
        adjustmentReason: adj?.reason || '',
      };
    }));
    // Expense-bill allocations: restore them and show the payee's bills so
    // they remain editable (previously they were dropped on edit).
    const expenseAllocs = (allocs || []).filter(a => a.finance_expense_id);
    setExpenseBillAllocations(expenseAllocs.map(a => ({
      expenseId: a.finance_expense_id as string,
      amount: a.allocated_amount,
    })));
    await loadOutstandingExpenseBillsForPayee(v.supplier_id, v.staff_id);
    if (expenseAllocs.length > 0) {
      // Bills fully paid by THIS voucher won't be in the outstanding list —
      // fetch them so their allocation rows stay visible/editable.
      const { data: allocBills } = await supabase
        .from('finance_expenses')
        .select('id, supplier_id, staff_id, invoice_number, expense_date, due_date, expense_category, description, amount, paid_amount')
        .in('id', expenseAllocs.map(a => a.finance_expense_id as string));
      setOutstandingExpenseBills(prev => {
        const have = new Set(prev.map(b => b.id));
        const extra = (allocBills || [])
          .filter(b => !have.has(b.id))
          .map(b => ({
            id: b.id,
            supplier_id: b.supplier_id,
            supplier_name: null,
            staff_id: b.staff_id,
            staff_name: null,
            invoice_number: b.invoice_number,
            invoice_date: b.expense_date,
            due_date: b.due_date,
            expense_category: b.expense_category,
            description: b.description,
            amount: b.amount,
            paid_amount: b.paid_amount ?? 0,
            balance_amount: (b.amount || 0) - (b.paid_amount ?? 0),
            days_overdue: 0,
          }));
        return [...prev, ...extra];
      });
    }
    setModalOpen(true);
  };

  const handleView = async (v: PaymentVoucher) => {
    setViewingVoucher(v);
    const { data } = await supabase
      .from('voucher_allocations')
      .select('purchase_invoice_id, allocated_amount, allocated_currency, purchase_invoices(id, invoice_number, invoice_date), finance_expenses(id, voucher_number, invoice_number, expense_date, expense_category, amount, pph_amount)')
      .eq('payment_voucher_id', v.id);
    const rawAllocs = ((data || []) as any[]);
    const salaryExpenseIds = rawAllocs
      .map(a => Array.isArray(a.finance_expenses) ? a.finance_expenses[0] : a.finance_expenses)
      .filter(fe => fe?.expense_category === 'salary')
      .map(fe => fe.id);
    const { data: salaryApplications } = salaryExpenseIds.length > 0
      ? await supabase.from('salary_advance_applications').select('salary_expense_id, applied_amount').in('salary_expense_id', salaryExpenseIds)
      : { data: [] as Array<{ salary_expense_id: string; applied_amount: number }> };
    const appliedBySalary = (salaryApplications || []).reduce<Record<string, number>>((totals, application) => {
      totals[application.salary_expense_id] = (totals[application.salary_expense_id] || 0) + Number(application.applied_amount || 0);
      return totals;
    }, {});

    const invoiceIds = rawAllocs
      .map(a => a.purchase_invoice_id || (Array.isArray(a.purchase_invoices) ? a.purchase_invoices[0]?.id : a.purchase_invoices?.id))
      .filter(Boolean);

    const adjData: any[] = [];
    try {
      const { data: pvAdjs, error: pvErr } = await supabase
        .from('invoice_rounding_adjustments')
        .select('purchase_invoice_id, adjustment_amount, adjustment_type, reason')
        .eq('payment_voucher_id', v.id);
      if (!pvErr && pvAdjs) {
        adjData.push(...pvAdjs);
      }
    } catch {
      // Safe fallback if payment_voucher_id is missing
    }

    if (invoiceIds.length > 0) {
      try {
        const { data: piAdjs, error: piErr } = await supabase
          .from('invoice_rounding_adjustments')
          .select('purchase_invoice_id, adjustment_amount, adjustment_type, reason')
          .in('purchase_invoice_id', invoiceIds);
        if (!piErr && piAdjs) {
          for (const adj of piAdjs) {
            if (!adjData.some(existing => existing.purchase_invoice_id === adj.purchase_invoice_id)) {
              adjData.push(adj);
            }
          }
        }
      } catch {
        // Safe fallback if purchase_invoice_id is missing
      }
    }

    const adjMap = adjData.reduce<Record<string, { amount: number; type: string; reason: string }>>((acc, adj) => {
      if (adj.purchase_invoice_id) {
        acc[adj.purchase_invoice_id] = {
          amount: Number(adj.adjustment_amount),
          type: adj.adjustment_type || 'rounding',
          reason: adj.reason || '',
        };
      }
      return acc;
    }, {});

    setViewAllocations(
      rawAllocs.map((a) => {
        const inv = Array.isArray(a.purchase_invoices) ? a.purchase_invoices[0] : a.purchase_invoices;
        const exp = Array.isArray(a.finance_expenses) ? a.finance_expenses[0] : a.finance_expenses;
        const invId = a.purchase_invoice_id || inv?.id || '';
        const adj = invId ? adjMap[invId] : undefined;
        return {
          invoice_id: invId || exp?.id || '',
          invoice_number: inv?.invoice_number
            || (exp ? `${exp.invoice_number || exp.voucher_number || 'Expense Bill'}` : '—'),
          invoice_date: inv?.invoice_date || exp?.expense_date || '',
          allocated_amount: a.allocated_amount || 0,
          allocated_currency: a.allocated_currency || 'IDR',
          is_expense_bill: !!exp,
          expense_id: exp?.id,
          expense_category: exp?.expense_category,
          gross_salary: exp?.amount,
          advance_applied: exp ? (appliedBySalary[exp.id] || 0) : 0,
          pph21: exp?.pph_amount || 0,
          settlement_adjustment: adj?.amount,
          adjustment_type: adj?.type,
        };
      }),
    );
  };

  useEffect(() => {
    if (!initialViewVoucherId || loading) return;
    const voucher = vouchers.find(item => item.id === initialViewVoucherId);
    if (voucher) void handleView(voucher);
    onInitialViewHandled?.();
  }, [initialViewVoucherId, loading, vouchers, onInitialViewHandled]);

  const handleDelete = async (v: PaymentVoucher) => {
    if (v.is_posted) {
      alert('This payment voucher has been posted to the GL. Cancel posting first to delete it.');
      return;
    }
    if (!confirm(`Delete payment ${v.voucher_number}? This will reverse all invoice allocations.`)) return;
    try {
      const { error } = await supabase.rpc('delete_payment_voucher_with_allocations', {
        p_voucher_id: v.id,
      });
      if (error) throw error;

      loadVouchers();
    } catch (err) {
      alert('Delete failed: ' + supabaseErrorMessage(err));
    }
  };

  const handleLinkBankTransaction = async (voucher: PaymentVoucher, transaction: BankTransactionLine) => {
    if (!voucher.is_posted || !voucher.journal_entry_id) {
      throw new Error('Post the payment voucher before linking a bank transaction.');
    }

    try {
      await linkBankTransaction({
        bankStatementLineId: transaction.id,
        matchedPaymentId: voucher.id,
        note: `Linked to supplier payment ${voucher.voucher_number}`,
      });

      const updatedVoucher = {
        ...voucher,
        bank_statement_line_id: transaction.id,
        bank_statement_line: transaction,
      };
      setVouchers((prev) => prev.map((item) => item.id === voucher.id ? updatedVoucher : item));
      setViewingVoucher(updatedVoucher);
      notifyFinanceReconciliationRefresh();
    } catch (error) {
      console.error('Error linking payment voucher to bank transaction:', error);
      alert('Failed to link bank transaction: ' + supabaseErrorMessage(error));
      throw error;
    }
  };

  const handleUnlinkBankTransaction = async (voucher: PaymentVoucher) => {
    if (!voucher.bank_statement_line_id) return;
    if (!confirm(
      `Unlink ${voucher.voucher_number} from this bank transaction?\n\n` +
      'The bank statement line will return to Unmatched.'
    )) return;

    try {
      await unlinkBankTransaction(voucher.bank_statement_line_id);
      const updatedVoucher = {
        ...voucher,
        bank_statement_line_id: null,
        bank_statement_line: null,
      };
      setVouchers((prev) => prev.map((item) => item.id === voucher.id ? updatedVoucher : item));
      setViewingVoucher(updatedVoucher);
      notifyFinanceReconciliationRefresh();
    } catch (error) {
      console.error('Error unlinking payment voucher from bank transaction:', error);
      alert('Failed to unlink bank transaction: ' + supabaseErrorMessage(error));
    }
  };

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();

    const isStaffPayee = formData.payee_type === 'staff';
    if (isStaffPayee ? !formData.staff_id : !formData.supplier_id) {
      alert(isStaffPayee ? 'Please select a staff member.' : 'Please select a supplier.');
      return;
    }
    if (formData.payment_method === 'advance_adjustment' && !isStaffPayee) {
      alert('Advance Adjustment is only available for staff payees.');
      return;
    }
    if (formData.payment_purpose === 'salary_advance' && !isStaffPayee) {
      alert('Salary Advance requires a staff payee.');
      return;
    }

    if (bankReconStatementLineId) {
      if (formData.payment_method === 'cash' || formData.payment_method === 'advance_adjustment') {
        alert('A reconciled bank payment must use the bank transfer payment method.');
        return;
      }
      if (!bankReconBankAccountId || formData.bank_account_id !== bankReconBankAccountId) {
        alert('The payment bank account must remain the bank account on the selected statement line.');
        return;
      }
      if (bankReconExpectedAmount == null || Math.abs(totalBankDebit - bankReconExpectedAmount) > 0.01) {
        alert(
          `Actual bank debit (${fmt(totalBankDebit, bankCurrency)}) must exactly equal the selected bank statement amount (${fmt(bankReconExpectedAmount || 0, bankCurrency)}). ` +
          'Adjust the gross amount, PPh, or bank charge so the existing payment voucher settles the statement exactly.',
        );
        return;
      }
    }

    // ── Currency / bank account guard ──────────────────────────────
    if (currencyMismatchWithoutRate) {
      alert(
        `Currency mismatch: the invoice is in ${invoiceCurrency} but the selected bank account is ${selectedBank?.currency || 'IDR'}.\n\n` +
        `Either select a ${invoiceCurrency} bank account, or enter the exchange rate in the Currency Conversion panel.`
      );
      return;
    }
      if (isCrossCurrency && formData.exchange_rate <= 0) {
        alert(`Cross-currency payment requires a positive exchange rate. Please enter the rate in the Currency Conversion panel.`);
        return;
      }

      // Validate discount reasons
      for (const alloc of allocations) {
        const discount = alloc.discountAmount || 0;
        if (discount > 0 && (!alloc.adjustmentReason || alloc.adjustmentReason.trim() === '')) {
          alert('A reason is required for discount/write-off adjustments on invoice allocations.');
          return;
        }
      }

    try {
      const { data: { user } } = await supabase.auth.getUser();
      if (!user) throw new Error('Not authenticated');
      const effectiveExchangeRate = isCrossCurrency ? formData.exchange_rate : 1;
      const uploadedUrls = uploadingFiles.length > 0
        ? await uploadFinanceDocuments(uploadingFiles, `payments/${editingVoucher?.id || 'new'}`)
        : [];

      const payload = {
        voucher_date: formData.voucher_date,
        supplier_id: isStaffPayee ? null : formData.supplier_id,
        staff_id: isStaffPayee ? formData.staff_id : null,
        payment_method: formData.payment_method,
        payment_purpose: formData.payment_purpose,
        bank_account_id: formData.bank_account_id || null,
        reference_number: formData.reference_number || null,
        amount: formData.amount,
        invoice_currency: invoiceCurrency as 'IDR' | 'USD',
        invoice_amount: formData.amount,
        payment_amount: netInvoiceAmount,
        bank_currency: bankCurrency as 'IDR' | 'USD',
        converted_amount: convertedPaymentAmount,
        actual_bank_debit: totalBankDebit,
        pph_amount: formData.pph_amount,
        pph_code_id: formData.pph_code_id || null,
        description: formData.description || null,
        document_urls: [...formData.document_urls, ...uploadedUrls],
        payment_currency: formData.payment_currency,
        exchange_rate: effectiveExchangeRate,
        bank_amount: isCrossCurrency ? totalBankDebit : null,
        bank_charge: formData.bank_charge || 0,
      };

      const savedVoucher = await savePaymentVoucher(editingVoucher?.id || null, {
        ...payload,
        payment_currency: payload.payment_currency as 'IDR' | 'USD',
        created_by: user.id,
      }, [
          // Purchase invoice allocations
          ...allocations.map(alloc => ({
            invoice_id: alloc.invoiceId,
            amount: alloc.amount,
            currency: alloc.currency,
          })),
          // Expense bill allocations (finance_expense_id key, handled by extended RPC)
          ...expenseBillAllocations.map(alloc => ({
            finance_expense_id: alloc.expenseId,
            amount: alloc.amount,
            currency: 'IDR',
          })),
        ]);

      // Persist settlement round-off or commercial discount adjustments
      for (const alloc of allocations) {
        const roundOff = alloc.roundOffAmount || 0;
        const discount = alloc.discountAmount || 0;
        const totalAdj = Math.round((roundOff + discount) * 100) / 100;
        if (totalAdj > 0) {
          const adjType = discount > 0 ? (alloc.adjustmentType || 'discount') : 'rounding';
          const reason = discount > 0
            ? (alloc.adjustmentReason?.trim() || 'Commercial discount')
            : 'invoice_rounding_tolerance';
          await applySettlementAdjustment({
            documentType: 'purchase',
            invoiceId: alloc.invoiceId,
            voucherId: savedVoucher.id,
            amount: totalAdj,
            adjustmentType: adjType,
            reason,
          });
        }
      }

      if (bankReconStatementLineId && !editingVoucher) {
        const { data: lineCheck, error: checkErr } = await supabase
          .from('bank_statement_lines')
          .select('id, matched_payment_id, matching_status')
          .eq('id', bankReconStatementLineId)
          .single();
        if (checkErr) throw checkErr;
        if (lineCheck?.matched_payment_id) {
          throw new Error(`This bank statement line is already linked to a payment (ID: ${lineCheck.matched_payment_id}).`);
        }

        const { error: postError } = await supabase.rpc('post_payment_voucher', {
          p_pv_id: savedVoucher.id,
          p_posted_by: user.id,
        });
        if (postError) throw postError;
        await linkBankStatementLine(bankReconStatementLineId, 'payment', savedVoucher.id);
        const lineId = bankReconStatementLineId;
        setBankReconStatementLineId(null);
        notifyFinanceReconciliationRefresh();
        onPaymentSavedFromBankReconciliation?.(savedVoucher.id, lineId);
      }

      setModalOpen(false);
      resetForm();
      onCloseEmbedded?.();
      await loadVouchers();
    } catch (error: unknown) {
      console.error('Error saving voucher:', error);
      const msg = (error instanceof Error ? error.message : null)
        ?? (error && typeof error === 'object' && 'message' in error ? String((error as { message: unknown }).message) : null)
        ?? 'Unknown error';
      alert('Failed to save: ' + msg);
    }
  };

  const search = searchTerm.trim().toLowerCase();
  const paymentVoucherCount = vouchers.filter(v => v.payment_purpose !== 'salary_advance_settlement').length;
  const settlementVoucherCount = vouchers.filter(v => v.payment_purpose === 'salary_advance_settlement').length;
  const filteredVouchers = vouchers.filter(v => {
    const isSettlement = v.payment_purpose === 'salary_advance_settlement';
    const matchesView =
      voucherView === 'all' ||
      (voucherView === 'settlements' ? isSettlement : !isSettlement);
    if (!matchesView) return false;
    if (!search) return true;
    return (
      v.voucher_number?.toLowerCase().includes(search) ||
      v.suppliers?.company_name?.toLowerCase().includes(search) ||
      v.finance_staff_master?.full_name?.toLowerCase().includes(search) ||
      v.description?.toLowerCase().includes(search)
    );
  });

  if (loading) return <div className="flex justify-center py-8"><div className="animate-spin rounded-full h-8 w-8 border-b-2 border-blue-600" /></div>;

  return (
    <>
      {!embeddedModalOnly && (
        <FinancePage
        title="Payment Vouchers"
        actions={canManage && (
          <button
            type="button"
            onClick={() => { resetForm(); setModalOpen(true); }}
            className="inline-flex items-center gap-1.5 h-8 px-3 bg-red-600 text-white rounded-md text-xs font-medium hover:bg-red-700 transition-colors shadow-xs whitespace-nowrap"
          >
            <ArrowUpCircle className="w-3.5 h-3.5" />
            <span>New Payment</span>
          </button>
        )}
        toolbar={
          <div className="flex flex-1 min-w-0 flex-wrap items-center gap-2.5">
            <div className="relative w-full max-w-xs">
              <Search className="absolute left-2.5 top-1/2 -translate-y-1/2 text-gray-400 w-3.5 h-3.5" />
              <input
                name="search_term"
                aria-label="Search payments..."
                type="text"
                placeholder="Search voucher, supplier, or staff..."
                value={searchTerm}
                onChange={(e) => setSearchTerm(e.target.value)}
                className="w-full h-8 pl-8 pr-2.5 text-xs border border-gray-300 rounded-md bg-white focus:outline-none focus:ring-1 focus:ring-blue-500"
              />
            </div>
            <div className="inline-flex items-center bg-gray-100 p-0.5 rounded-md" role="group" aria-label="Payment voucher type">
              <button
                type="button"
                onClick={() => setVoucherView('payments')}
                aria-pressed={voucherView === 'payments'}
                className={`h-7 px-2.5 rounded text-xs font-medium transition-colors ${
                  voucherView === 'payments' ? 'bg-white text-blue-700 font-semibold shadow-xs' : 'text-gray-600 hover:text-gray-900'
                }`}
              >
                Payments ({paymentVoucherCount})
              </button>
              <button
                type="button"
                onClick={() => setVoucherView('settlements')}
                aria-pressed={voucherView === 'settlements'}
                className={`h-7 px-2.5 rounded text-xs font-medium transition-colors ${
                  voucherView === 'settlements' ? 'bg-white text-purple-700 font-semibold shadow-xs' : 'text-gray-600 hover:text-gray-900'
                }`}
              >
                Advance Settlements ({settlementVoucherCount})
              </button>
              <button
                type="button"
                onClick={() => setVoucherView('all')}
                aria-pressed={voucherView === 'all'}
                className={`h-7 px-2.5 rounded text-xs font-medium transition-colors ${
                  voucherView === 'all' ? 'bg-white text-gray-900 font-semibold shadow-xs' : 'text-gray-600 hover:text-gray-900'
                }`}
              >
                All
              </button>
            </div>
            {voucherView === 'settlements' && (
              <span className="text-[10px] text-purple-700 font-medium hidden lg:inline">Internal salary deductions — no bank/cash payment</span>
            )}
          </div>
        }
      >
        <FinanceTable
          rows={filteredVouchers}
          rowKey={(v) => v.id}
          empty="No payment vouchers found"
          columns={[
            { header: 'Voucher No', cell: (v) => <span className="font-mono font-medium">{v.voucher_number}</span> },
            { header: 'Date',       cell: (v) => new Date(v.voucher_date).toLocaleDateString('id-ID') },
            { header: 'Payee',      cell: (v) => v.suppliers?.company_name
              ?? (v.finance_staff_master ? <span>{v.finance_staff_master.full_name} <span className="text-[9px] text-teal-600 font-semibold">STAFF</span></span> : '—') },
            { header: 'Method',     cell: (v) => (
              <span className="px-1.5 py-0.5 bg-blue-100 text-blue-700 rounded text-[10px] capitalize">
                {v.payment_method.replace(/_/g, ' ')}
              </span>
            ) },
            { header: 'Purpose',    cell: (v) => v.payment_purpose === 'salary_advance' ? (
              <span className="px-1.5 py-0.5 bg-amber-100 text-amber-800 rounded text-[10px] font-semibold">Salary Advance</span>
            ) : v.payment_purpose === 'salary_advance_settlement' ? (
              <span className="px-1.5 py-0.5 bg-purple-100 text-purple-800 rounded text-[10px] font-semibold">Advance Settlement</span>
            ) : <span className="text-gray-400">—</span> },
            { header: 'Invoice',    cell: (v) => {
              const invs = v.invoice_numbers || [];
              if (invs.length === 0) return <span className="text-gray-400">—</span>;
              const first = invs[0];
              if (invs.length === 1) {
                return (
                  <button
                    type="button"
                    onClick={(e) => { e.stopPropagation(); onViewInvoice?.(first.id); }}
                    className="text-blue-600 hover:text-blue-800 hover:underline font-mono text-xs"
                    title="View purchase invoice"
                  >
                    {first.number}
                  </button>
                );
              }
              const isPopoverOpen = activeInvoicePopoverId === v.id;
              return (
                <div className="relative inline-flex items-center gap-1.5">
                  <button
                    type="button"
                    onClick={(e) => { e.stopPropagation(); onViewInvoice?.(first.id); }}
                    className="text-blue-600 hover:text-blue-800 hover:underline font-mono text-xs"
                    title="View primary purchase invoice"
                  >
                    {first.number}
                  </button>
                  <button
                    type="button"
                    onClick={(e) => {
                      e.stopPropagation();
                      setActiveInvoicePopoverId(isPopoverOpen ? null : v.id);
                    }}
                    className={`inline-flex items-center gap-0.5 px-1.5 py-0.5 rounded text-[10px] font-medium border transition-colors ${
                      isPopoverOpen
                        ? 'bg-blue-600 text-white border-blue-600 shadow-xs'
                        : 'bg-blue-50 text-blue-700 border-blue-200 hover:bg-blue-100'
                    }`}
                    title="Show all linked invoices"
                  >
                    +{invs.length - 1} more
                  </button>
                  {isPopoverOpen && (
                    <div
                      onClick={(e) => e.stopPropagation()}
                      className="absolute left-0 top-full mt-1 z-30 min-w-[210px] max-w-xs bg-white rounded-lg shadow-xl border border-gray-200 p-2 text-left"
                    >
                      <div className="flex items-center justify-between border-b border-gray-100 pb-1 mb-1.5">
                        <span className="text-[10px] font-bold text-gray-500 uppercase tracking-wide">
                          Paid Invoices ({invs.length})
                        </span>
                        <button
                          type="button"
                          onClick={() => setActiveInvoicePopoverId(null)}
                          className="text-gray-400 hover:text-gray-600 p-0.5 rounded hover:bg-gray-100"
                          title="Close"
                        >
                          <X className="w-3.5 h-3.5" />
                        </button>
                      </div>
                      <div className="flex flex-col gap-1 max-h-48 overflow-y-auto">
                        {invs.map((inv) => (
                          <button
                            key={inv.id}
                            type="button"
                            onClick={() => {
                              setActiveInvoicePopoverId(null);
                              onViewInvoice?.(inv.id);
                            }}
                            className="flex items-center justify-between px-2 py-1 rounded text-xs font-mono text-blue-600 hover:bg-blue-50 hover:text-blue-800 transition-colors text-left"
                          >
                            <span>{inv.number}</span>
                            <ExternalLink className="w-3 h-3 text-blue-400 ml-1.5 shrink-0" />
                          </button>
                        ))}
                      </div>
                    </div>
                  )}
                </div>
              );
            } },
            { header: 'Bank', cell: (v) => v.payment_purpose === 'salary_advance_settlement'
              ? <span className="text-purple-700 text-[10px] font-semibold">Internal settlement</span>
              : v.bank_accounts
                ? `${v.bank_accounts.alias || v.bank_accounts.account_name} (${v.bank_accounts.currency})`
                : <span className="text-gray-400">—</span> },
            { header: 'Bank Debit', align: 'right', cell: (v) => {
              if (v.payment_purpose === 'salary_advance_settlement') {
                return <span className="text-gray-500 text-[10px]">No bank payment</span>;
              }
              const bankCcy = v.bank_accounts?.currency || v.payment_currency || 'IDR';
              const invCcy = v.invoice_currency || 'IDR';
              const isCross = invCcy !== bankCcy && v.bank_amount != null && v.bank_amount > 0;
              const debit = isCross ? (v.bank_amount || 0) : (v.amount || 0) + (v.bank_charge || 0);
              return <span className="font-medium text-blue-700">{fmt(debit, bankCcy)}</span>;
            } },
            { header: 'Net Paid', align: 'right', cell: (v) => v.payment_purpose === 'salary_advance_settlement'
              ? <span className="text-gray-500 text-[10px]">Salary deduction</span>
              : <span className="font-medium text-red-600">{fmt(v.net_amount, v.invoice_currency || 'IDR')}</span> },
            {
              header: 'Actions',
              align: 'center' as const,
              cell: (v: PaymentVoucher) => {
                return (
                  <div className="flex items-center justify-center gap-0.5 whitespace-nowrap">
                    <VoucherBankLinkIndicator
                      voucherNumber={v.voucher_number}
                      evaluation={v.bank_link_evaluation}
                      bankAccountId={v.bank_account_id}
                      onOpenBankReconciliation={onOpenBankReconciliation}
                    />
                    <FinanceActionButton action="view" onClick={(e) => { e.stopPropagation(); handleView(v); }} />
                    {canManage && !v.is_posted && (
                      <>
                        <FinanceActionButton action="edit" onClick={(e) => { e.stopPropagation(); handleEdit(v); }} />
                        <FinanceActionButton action="approve" label="Post to GL" onClick={(e) => { e.stopPropagation(); handlePostVoucher(v); }} disabled={postingLoading === v.id} />
                      </>
                    )}
                    {v.is_posted && (
                      <FinanceBadge status="posted"><Lock className="mr-0.5 h-3 w-3" /> Posted</FinanceBadge>
                    )}
                    {canManage && v.is_posted && isAdmin && (
                      <FinanceActionButton action="reverse" label="Cancel Posting" onClick={(e) => { e.stopPropagation(); openCancelPostingModal(v); }} />
                    )}
                    {canManage && !v.is_posted && (
                      <FinanceActionButton action="delete" onClick={(e) => { e.stopPropagation(); handleDelete(v); }} />
                    )}
                  </div>
                );
              },
            },
          ]}
        />
      </FinancePage>
      )}

      <FinanceModal
        isOpen={modalOpen}
        onClose={() => { setModalOpen(false); resetForm(); onCloseEmbedded?.(); }}
        title={editingVoucher ? `Edit ${editingVoucher.voucher_number}` : 'New Payment Voucher'}
        size="lg"
        footer={
          <>
            <button type="button" onClick={() => { setModalOpen(false); resetForm(); onCloseEmbedded?.(); }} className={F_BTN_SECONDARY}>
              Cancel
            </button>
            <button type="submit" form="payment-voucher-form" className={`${F_BTN_PRIMARY} bg-red-600 hover:bg-red-700`}>
              {editingVoucher ? 'Update Payment' : 'Save Payment'}
            </button>
          </>
        }
      >
        <form id="payment-voucher-form" onSubmit={handleSubmit} className="flex flex-col gap-3">
          {/* Row 1 — Transaction details (4 columns) */}
          <SapRow>
            <FloatingField label="Date" required span={3} filled={!!formData.voucher_date}>
              <input
                name="voucher_date"
                aria-label="Voucher Date"
                type="date"
                required
                value={formData.voucher_date}
                onChange={(e) => setFormData({ ...formData, voucher_date: e.target.value })}
                className={FLOAT_INPUT}
              />
            </FloatingField>
            <FloatingField label="Pay To" required span={3} filled={!!formData.payee_type}>
              <select
                name="payee_type"
                aria-label="Payee Type"
                value={formData.payee_type}
                onChange={(e) => {
                  const payeeType = e.target.value as 'supplier' | 'staff';
                  setFormData({
                    ...formData,
                    payee_type: payeeType,
                    supplier_id: '',
                    staff_id: '',
                    payment_purpose: payeeType === 'staff' ? formData.payment_purpose : 'general',
                    payment_method: formData.payment_method === 'advance_adjustment' ? 'bank_transfer' : formData.payment_method,
                  });
                  setExpenseBillAllocations([]);
                  setOutstandingExpenseBills([]);
                }}
                className={FLOAT_INPUT}
              >
                <option value="supplier">Supplier</option>
                <option value="staff">Staff</option>
              </select>
            </FloatingField>
            <FloatingField
              label={formData.payee_type === 'staff' ? 'Staff Member' : 'Supplier'}
              required
              span={3}
              filled={formData.payee_type === 'staff' ? !!formData.staff_id : !!formData.supplier_id}
            >
              {formData.payee_type === 'staff' ? (
                <SearchableSelect
                  value={formData.staff_id}
                  onChange={(val) => {
                    const staff = staffList.find((item) => item.id === val);
                    setFormData({
                      ...formData,
                      staff_id: val,
                      payment_method: staff?.default_payment_method || formData.payment_method,
                    });
                  }}
                  options={staffList.map(s => ({ value: s.id, label: s.employee_code ? `${s.full_name} (${s.employee_code})` : s.full_name }))}
                  placeholder="Select staff"
                  className="!h-9 !rounded-md text-xs"
                />
              ) : (
                <SearchableSelect
                  value={formData.supplier_id}
                  onChange={(val) => setFormData({ ...formData, supplier_id: val })}
                  options={suppliers.map(s => ({ value: s.id, label: s.company_name }))}
                  placeholder="Select supplier"
                  className="!h-9 !rounded-md text-xs"
                />
              )}
            </FloatingField>
            <FloatingField label="Payment Method" required span={3} filled={!!formData.payment_method}>
              <select
                name="payment_method"
                aria-label="Payment Method"
                required
                value={formData.payment_method}
                onChange={(e) => setFormData({ ...formData, payment_method: e.target.value })}
                className={FLOAT_INPUT}
              >
                <option value="cash">Cash</option>
                <option value="bank_transfer">Bank Transfer</option>
                <option value="check">Check</option>
                <option value="giro">Giro</option>
                <option value="other">Other</option>
                {formData.payee_type === 'staff' && (
                  <option value="advance_adjustment">Adjust Against Staff Advance</option>
                )}
              </select>
            </FloatingField>
          </SapRow>

          {/* Row 2 — Payment details (4 columns) */}
          <SapRow>
            {formData.payee_type === 'staff' && (
              <FloatingField
                label="Payment Purpose"
                required
                span={['cash', 'advance_adjustment'].includes(formData.payment_method) ? 6 : 3}
                filled={!!formData.payment_purpose}
              >
                <select
                  name="payment_purpose"
                  aria-label="Payment Purpose"
                  value={formData.payment_purpose}
                  onChange={(e) => setFormData({ ...formData, payment_purpose: e.target.value as PaymentPurpose })}
                  className={FLOAT_INPUT}
                  disabled={!!editingVoucher?.is_posted}
                >
                  <option value="general">General Staff Payment</option>
                  <option value="salary_advance">Salary Advance</option>
                  {formData.payment_purpose === 'salary_advance_settlement' && (
                    <option value="salary_advance_settlement">Salary Advance Settlement</option>
                  )}
                </select>
              </FloatingField>
            )}

            <FloatingField
              label={`Amount${pendingInvoices.length > 0 ? ` (${invoiceCurrency})` : ''}`}
              required
              span={['cash', 'advance_adjustment'].includes(formData.payment_method) ? 6 : 3}
              filled={!!formData.amount}
            >
              <MoneyInput
                required
                decimal
                value={formData.amount}
                onChange={(n) => setFormData({ ...formData, amount: n })}
                className={`${FLOAT_INPUT} !text-right !font-mono !font-semibold`}
              />
            </FloatingField>

            {!['cash', 'advance_adjustment'].includes(formData.payment_method) && (
              <>
                <FloatingField
                  label="Bank Account"
                  span={formData.payee_type === 'staff' ? 3 : 6}
                  filled={!!formData.bank_account_id}
                  right={selectedBank && (
                    <span className={`px-1.5 py-0.5 text-[9px] font-bold rounded ${
                      isCrossCurrency ? 'bg-amber-100 text-amber-700' : 'bg-blue-100 text-blue-700'
                    }`}>
                      {selectedBank.currency || 'IDR'}
                    </span>
                  )}
                >
                  <select
                    name="bank_account_id"
                    aria-label="Bank Account Id"
                    value={formData.bank_account_id}
                    onChange={(e) => setFormData({ ...formData, bank_account_id: e.target.value })}
                    className={FLOAT_INPUT}
                  >
                    <option value="">Select account</option>
                    {pendingInvoices.length > 0 ? (
                      <>
                        {matchingBankAccounts.length > 0 && (
                          <optgroup label={`✓ ${invoiceCurrency} accounts (recommended)`}>
                            {matchingBankAccounts.map(b => (
                              <option key={b.id} value={b.id}>
                                {b.alias || `${b.bank_name} - ${b.account_name}`} ({b.currency || 'IDR'})
                              </option>
                            ))}
                          </optgroup>
                        )}
                        {otherBankAccounts.length > 0 && (
                          <optgroup label="⚠ Other currency — exchange rate required">
                            {otherBankAccounts.map(b => (
                              <option key={b.id} value={b.id}>
                                {b.alias || `${b.bank_name} - ${b.account_name}`} ({b.currency || 'IDR'})
                              </option>
                            ))}
                          </optgroup>
                        )}
                      </>
                    ) : (
                      bankAccounts.map(b => (
                        <option key={b.id} value={b.id}>
                          {b.alias || `${b.bank_name} - ${b.account_name}`} ({b.currency || 'IDR'})
                        </option>
                      ))
                    )}
                  </select>
                </FloatingField>
                <FloatingField label="Reference No" span={3} filled={!!formData.reference_number}>
                  <input
                    name="reference_number"
                    aria-label="Reference Number"
                    type="text"
                    value={formData.reference_number}
                    onChange={(e) => setFormData({ ...formData, reference_number: e.target.value })}
                    className={FLOAT_INPUT}
                    placeholder="Ref / Cheque #"
                  />
                </FloatingField>
              </>
            )}

            {formData.payee_type === 'supplier' && ['cash', 'advance_adjustment'].includes(formData.payment_method) && (
              <FloatingField label="Reference / Memo" span={6} filled={!!formData.reference_number}>
                <input
                  name="reference_number"
                  aria-label="Reference Number"
                  type="text"
                  value={formData.reference_number}
                  onChange={(e) => setFormData({ ...formData, reference_number: e.target.value })}
                  className={FLOAT_INPUT}
                  placeholder="Receipt / Voucher Ref #"
                />
              </FloatingField>
            )}
          </SapRow>

          {/* Conditional notes / warnings */}
          {formData.payee_type === 'staff' && formData.payment_purpose === 'salary_advance' && (
            <div className="flex items-center gap-2 rounded-md border border-amber-200 bg-amber-50 px-3 py-2 text-xs text-amber-800">
              <Info className="w-4 h-4 shrink-0 text-amber-600" />
              <span>This posted payment will remain as an outstanding Salary Advance for the selected staff member.</span>
            </div>
          )}

          {!['cash', 'advance_adjustment'].includes(formData.payment_method) && (
            <>
              {currencyMismatchWithoutRate && (
                <p className="text-xs text-red-600 font-medium bg-red-50 border border-red-200 rounded-md p-2">
                  ✗ {selectedBank?.currency} account selected for a {invoiceCurrency} invoice — enter an exchange rate below, or choose a {invoiceCurrency} account.
                </p>
              )}
              {isCrossCurrency && !currencyMismatchWithoutRate && (
                <p className="text-xs text-amber-700 bg-amber-50 border border-amber-200 rounded-md p-2">
                  Cross-currency: enter exchange rate in the panel below.
                </p>
              )}
            </>
          )}

          {/* Cross-currency panel */}
          {isCrossCurrency && (
            <div className="bg-amber-50/70 border border-amber-200 rounded-lg p-3">
              <div className="flex items-center justify-between mb-2">
                <span className="text-xs font-semibold text-amber-900">Currency Conversion</span>
                <span className="text-[11px] text-amber-700 font-mono">{invoiceCurrency} invoice → {bankCurrency} bank debit</span>
              </div>
              <div className="grid grid-cols-1 sm:grid-cols-3 gap-2.5 mb-2.5">
                <div>
                  <label className="block text-[10px] font-semibold text-gray-500 uppercase tracking-wide mb-1">Invoice ({invoiceCurrency})</label>
                  <input
                    name="invoice_invoicecurrency"
                    aria-label="Invoice ({invoiceCurrency})"
                    readOnly
                    value={formData.amount.toLocaleString('en-US', { minimumFractionDigits: 2 })}
                    className="w-full h-9 px-2.5 text-xs border border-gray-200 rounded-md bg-gray-50 text-gray-700 font-mono text-right"
                  />
                </div>
                <div>
                  <label className="block text-[10px] font-semibold text-gray-500 uppercase tracking-wide mb-1">Rate (1 {invoiceCurrency} = {bankCurrency})</label>
                  <input
                    name="rate_1_invoicecurrency_bankcur"
                    aria-label="Rate (1 {invoiceCurrency} = {bankCurrency})"
                    type="number"
                    required={isCrossCurrency}
                    step="0.000001"
                    min="0.000001"
                    value={formData.exchange_rate || ''}
                    onChange={(e) => setFormData({ ...formData, exchange_rate: parseFloat(e.target.value) || 0 })}
                    className="w-full h-9 px-2.5 text-xs border border-amber-300 rounded-md bg-white font-mono text-right focus:ring-1 focus:ring-amber-500"
                    placeholder="e.g. 16200"
                  />
                </div>
                <div>
                  <label className="block text-[10px] font-semibold text-gray-500 uppercase tracking-wide mb-1">Converted ({bankCurrency})</label>
                  <input
                    name="converted_bankcurrency"
                    aria-label="Converted ({bankCurrency})"
                    readOnly
                    value={invoiceInBankCurrency.toLocaleString('id-ID', { minimumFractionDigits: 0 })}
                    className="w-full h-9 px-2.5 text-xs border border-green-200 rounded-md bg-green-50 text-green-800 font-mono font-medium text-right"
                  />
                </div>
              </div>
              <div className="grid grid-cols-1 sm:grid-cols-3 gap-2.5">
                <div className="sm:col-span-2">
                  <label className="block text-[10px] font-semibold text-gray-500 uppercase tracking-wide mb-1">
                    Bank Transfer Charge ({bankCurrency}) — added to bank debit
                  </label>
                  <MoneyInput
                    decimal
                    value={formData.bank_charge}
                    onChange={(n) => setFormData({ ...formData, bank_charge: n })}
                    className="w-full h-9 px-2.5 text-xs border border-gray-300 rounded-md bg-white font-mono text-right"
                    placeholder="e.g. 50000"
                  />
                </div>
                <div>
                  <label className="block text-[10px] font-semibold text-gray-500 uppercase tracking-wide mb-1">Total Bank Debit ({bankCurrency})</label>
                  <input
                    name="total_bank_debit_bankcurrency"
                    aria-label="Total Bank Debit ({bankCurrency})"
                    readOnly
                    value={totalBankDebit.toLocaleString('id-ID', { minimumFractionDigits: 0 })}
                    className="w-full h-9 px-2.5 text-xs border border-gray-200 rounded-md bg-blue-50 text-blue-900 font-bold font-mono text-right"
                  />
                </div>
              </div>
            </div>
          )}

          {/* Row 3 — Tax details (4 columns) */}
          <div className="border-t border-gray-100 pt-3">
            <SapRow>
              <FloatingField label="PPh Type" span={6} filled={!!formData.pph_code_id}>
                <select
                  name="pph_code_id"
                  aria-label="Pph Code Id"
                  value={formData.pph_code_id}
                  onChange={(e) => setFormData({ ...formData, pph_code_id: e.target.value })}
                  className={FLOAT_INPUT}
                >
                  <option value="">No withholding</option>
                  {taxCodes.map(t => (
                    <option key={t.id} value={t.id}>{t.code} - {t.name} ({t.rate}%)</option>
                  ))}
                </select>
              </FloatingField>
              <FloatingField
                label={`PPh Amount${pendingInvoices.length > 0 ? ` (${invoiceCurrency})` : ''}`}
                span={6}
                filled={!!formData.pph_amount}
              >
                <MoneyInput
                  decimal
                  value={formData.pph_amount}
                  onChange={(n) => setFormData({ ...formData, pph_amount: n })}
                  className={`${FLOAT_INPUT} !text-right !font-mono text-orange-700`}
                />
              </FloatingField>
            </SapRow>
          </div>

          {/* Row 4 — Financial Summary (compact aligned strip) */}
          <div className="bg-gray-50/90 border border-gray-200 rounded-lg p-2.5">
            <div className={`grid grid-cols-2 ${isCrossCurrency ? 'lg:grid-cols-4' : 'lg:grid-cols-3'} gap-2.5`}>
              <div className="bg-white border border-gray-200 rounded-md px-3 py-2 flex flex-col justify-between">
                <span className="text-[10px] font-semibold text-gray-500 uppercase tracking-wider">Gross Amount</span>
                <span className="font-mono text-sm font-semibold text-gray-800 text-right mt-0.5">
                  {fmt(formData.amount, invoiceCurrency)}
                </span>
              </div>
              <div className="bg-white border border-gray-200 rounded-md px-3 py-2 flex flex-col justify-between">
                <span className="text-[10px] font-semibold text-orange-600 uppercase tracking-wider">Less PPh</span>
                <span className="font-mono text-sm font-semibold text-orange-600 text-right mt-0.5">
                  {formData.pph_amount > 0 ? `−${fmt(formData.pph_amount, invoiceCurrency)}` : '—'}
                </span>
              </div>
              <div className="bg-red-50/70 border border-red-200 rounded-md px-3 py-2 flex flex-col justify-between">
                <span className="text-[10px] font-bold text-red-700 uppercase tracking-wider">Net Payment</span>
                <span className="font-mono text-base font-bold text-red-600 text-right mt-0.5">
                  {fmt(netInvoiceAmount, invoiceCurrency)}
                </span>
              </div>
              {isCrossCurrency && (
                <div className="bg-blue-50/70 border border-blue-200 rounded-md px-3 py-2 flex flex-col justify-between">
                  <span className="text-[10px] font-bold text-blue-700 uppercase tracking-wider">Bank Debit</span>
                  <span className="font-mono text-sm font-bold text-blue-800 text-right mt-0.5">
                    {fmt(netBankDebit, bankCurrency)}
                  </span>
                </div>
              )}
            </div>
          </div>

          {/* Row 5 — Description */}
          <SapRow>
            <FloatingField label="Description" span={12} filled={!!formData.description} textarea>
              <textarea
                name="description"
                aria-label="Payment description..."
                rows={2}
                value={formData.description}
                onChange={(e) => setFormData({ ...formData, description: e.target.value })}
                className={FLOAT_TEXTAREA}
                placeholder="Payment description..."
              />
            </FloatingField>
          </SapRow>

          {/* Attachments (compact & unobtrusive) */}
          <div className="border-t border-gray-100 pt-1">
            <FinanceDocumentAttachments
              documentUrls={formData.document_urls}
              pendingFiles={uploadingFiles}
              onDocumentUrlsChange={(document_urls) => setFormData((previous) => ({ ...previous, document_urls }))}
              onPendingFilesChange={setUploadingFiles}
              active={modalOpen}
              compact
            />
          </div>

          {/* ── Expense Bill Allocations ──────────────────────────────── */}
          {outstandingExpenseBills.length > 0 && (
            <div className="border-t pt-3">
              <h4 className="text-xs font-semibold text-purple-700 mb-2 uppercase tracking-wide flex items-center gap-1">
                Allocate to Expense Bills (A/P)
                <span className="text-[10px] bg-purple-100 text-purple-600 px-1.5 py-0.5 rounded font-normal">
                  {outstandingExpenseBills.length} outstanding
                </span>
              </h4>
              <div className="max-h-40 overflow-y-auto border border-purple-200 rounded-lg">
                <table className="w-full text-xs">
                  <thead className="bg-purple-50 sticky top-0">
                    <tr>
                      <th className="px-3 py-1.5 text-left font-medium text-purple-700">Expense / Invoice #</th>
                      <th className="px-3 py-1.5 text-left font-medium text-purple-700">Category</th>
                      <th className="px-3 py-1.5 text-right font-medium text-purple-700">Balance</th>
                      <th className="px-3 py-1.5 text-right font-medium text-purple-700">Allocate</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-purple-100">
                    {outstandingExpenseBills.map(bill => {
                      const thisAlloc = expenseBillAllocations.find(a => a.expenseId === bill.id)?.amount || 0;
                      return (
                        <tr key={bill.id} className={bill.days_overdue > 0 ? 'bg-red-50/50' : ''}>
                          <td className="px-3 py-1.5">
                            <div className="font-mono">{bill.invoice_number || bill.id.slice(0, 8)}</div>
                            <div className="text-gray-400">{new Date(bill.invoice_date).toLocaleDateString('id-ID')}</div>
                          </td>
                          <td className="px-3 py-1.5 text-gray-600">
                            {bill.expense_category.replace(/_/g, ' ')}
                          </td>
                          <td className="px-3 py-1.5 text-right font-medium text-red-600">
                            Rp {bill.balance_amount.toLocaleString('id-ID')}
                            {bill.days_overdue > 0 && (
                              <div className="text-[10px] text-red-500">{bill.days_overdue}d overdue</div>
                            )}
                          </td>
                          <td className="px-3 py-1.5 text-right">
                            <MoneyInput
                              decimal
                              min={0}
                              max={bill.balance_amount}
                              value={thisAlloc || 0}
                              onChange={(n) => handleExpenseBillAllocationChange(bill, Math.min(n, bill.balance_amount))}
                              className="w-24 px-2 py-1 border border-purple-200 rounded text-right focus:border-purple-400 outline-none"
                              placeholder="0"
                            />
                          </td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              </div>
              {totalExpenseBillAllocated > 0 && (
                <div className="mt-1.5 flex justify-between text-xs font-medium">
                  <span className="text-purple-600">Expense Bill Allocated (IDR):</span>
                  <span className="text-purple-700">
                    Rp {totalExpenseBillAllocated.toLocaleString('id-ID')}
                  </span>
                </div>
              )}
            </div>
          )}

          {pendingInvoices.length > 0 && (
            <div className="border-t pt-3">
              <div className="flex justify-between items-center mb-2">
                <h4 className="text-xs font-semibold text-gray-600 uppercase tracking-wide">Allocate to Invoices</h4>
                <span className="text-[11px] text-gray-500">
                  Rounding tolerance: <span className="font-semibold text-gray-700">Rp {roundingTolerance.toLocaleString('id-ID')}</span>
                </span>
              </div>
              <div className="max-h-60 overflow-y-auto border rounded-lg">
                <table className="w-full text-xs">
                  <thead className="bg-gray-50 sticky top-0">
                    <tr>
                      <th className="px-3 py-1.5 text-left font-medium text-gray-500">Invoice</th>
                      <th className="px-1.5 py-1.5 text-center font-medium text-gray-500">CCY</th>
                      <th className="px-2 py-1.5 text-right font-medium text-gray-500">Outstanding</th>
                      <th className="px-2 py-1.5 text-right font-medium text-gray-500">Pay Allocated</th>
                      <th className="px-2 py-1.5 text-right font-medium text-gray-500">Round-Off</th>
                      <th className="px-2 py-1.5 text-right font-medium text-gray-500">Discount</th>
                      <th className="px-3 py-1.5 text-right font-medium text-gray-500">Final Balance</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y">
                    {pendingInvoices
                      // In edit mode show invoices that have an existing allocation OR still have balance
                      .filter(inv => editingVoucher
                        ? (inv.balance_amount > 0 || allocations.some(a => a.invoiceId === inv.id))
                        : true)
                      .map(inv => {
                        const invCcy = inv.currency || 'IDR';
                        const thisAlloc = allocations.find(a => a.invoiceId === inv.id);
                        const allocatedAmount = thisAlloc?.amount || 0;
                        const availableBalance = editingVoucher
                          ? Math.round((inv.balance_amount + allocatedAmount) * 100) / 100
                          : inv.balance_amount;
                        const roundOff = thisAlloc?.roundOffAmount || 0;
                        const discount = thisAlloc?.discountAmount || 0;
                        const finalRemaining = Math.max(0, Math.round((availableBalance - allocatedAmount - roundOff - discount) * 100) / 100);
                        const isSettled = finalRemaining <= 0 && (allocatedAmount > 0 || roundOff > 0 || discount > 0);

                        return (
                          <tr key={inv.id} className="hover:bg-gray-50/50">
                            <td className="px-3 py-1.5">
                              <div className="font-mono">{inv.invoice_number}</div>
                              <div className="text-gray-400 text-[10px]">{new Date(inv.invoice_date).toLocaleDateString('id-ID')}</div>
                            </td>
                            <td className="px-1.5 py-1.5 text-center">
                              <span className={`px-1 py-0.5 rounded text-[10px] font-bold ${invCcy === 'USD' ? 'bg-green-100 text-green-700' : 'bg-gray-100 text-gray-600'}`}>
                                {invCcy}
                              </span>
                            </td>
                            <td className="px-2 py-1.5 text-right font-medium text-red-600">
                              {fmt(availableBalance, invCcy)}
                            </td>
                            <td className="px-2 py-1.5 text-right">
                              <MoneyInput
                                decimal
                                min={0}
                                max={availableBalance}
                                value={allocatedAmount}
                                onChange={(n) => handleAllocationChange(inv, Math.min(n, availableBalance))}
                                className="w-24 px-2 py-1 border rounded text-right"
                                placeholder="0"
                              />
                            </td>
                            <td className="px-2 py-1.5 text-right">
                              <MoneyInput
                                decimal
                                min={0}
                                max={Math.min(roundingTolerance, Math.max(0, availableBalance - allocatedAmount))}
                                value={roundOff}
                                onChange={(r) => handleAllocationChange(inv, allocatedAmount, { roundOffAmount: r, adjustmentType: 'rounding' })}
                                className="w-20 px-1.5 py-1 border rounded text-right text-amber-700 bg-amber-50/30"
                                placeholder="0"
                              />
                            </td>
                            <td className="px-2 py-1.5 text-right">
                              <div className="flex flex-col items-end gap-1">
                                <MoneyInput
                                  decimal
                                  min={0}
                                  max={Math.max(0, availableBalance - allocatedAmount - roundOff)}
                                  value={discount}
                                  onChange={(d) => handleAllocationChange(inv, allocatedAmount, { discountAmount: d, adjustmentType: 'discount' })}
                                  className="w-20 px-1.5 py-1 border rounded text-right text-purple-700 bg-purple-50/30"
                                  placeholder="0"
                                />
                                {discount > 0 && (
                                  <input
                                    type="text"
                                    placeholder="Reason (req)*"
                                    value={thisAlloc?.adjustmentReason || ''}
                                    onChange={(e) => handleAllocationChange(inv, allocatedAmount, { adjustmentReason: e.target.value })}
                                    className="w-28 text-[10px] px-1 py-0.5 border border-purple-300 rounded bg-white text-gray-800"
                                    title="Approved reason for discount/write-off"
                                  />
                                )}
                              </div>
                            </td>
                            <td className="px-3 py-1.5 text-right">
                              <div className={`font-semibold ${finalRemaining === 0 ? 'text-green-700' : 'text-gray-700'}`}>
                                {fmt(finalRemaining, invCcy)}
                              </div>
                              <span className={`inline-block px-1.5 py-0.2 rounded text-[10px] font-medium ${isSettled ? 'bg-green-100 text-green-700' : 'bg-gray-100 text-gray-500'}`}>
                                {isSettled ? 'Settled' : 'Partial'}
                              </span>
                            </td>
                          </tr>
                        );
                      })}
                  </tbody>
                </table>
              </div>
              <div className="mt-2 flex flex-wrap justify-between items-center text-xs gap-2">
                <div className="flex gap-3 text-gray-600">
                  <span>Pay Allocated: <strong className={totalAllocated > formData.amount ? 'text-red-600' : 'text-green-700'}>{fmt(totalAllocated, invoiceCurrency)}</strong></span>
                  {totalRoundOff > 0 && <span>Round-off: <strong className="text-amber-700">{fmt(totalRoundOff, invoiceCurrency)}</strong></span>}
                  {totalDiscount > 0 && <span>Discount: <strong className="text-purple-700">{fmt(totalDiscount, invoiceCurrency)}</strong></span>}
                </div>
                {totalAllocated > formData.amount && (
                  <span className="text-red-500 font-medium">Over allocated by {fmt(totalAllocated - formData.amount, invoiceCurrency)}!</span>
                )}
              </div>
            </div>
          )}

        </form>
      </FinanceModal>

      {!embeddedModalOnly && (
        <>
          {cancelPostingTarget && (
        <Modal
          isOpen={!!cancelPostingTarget}
          onClose={() => { setCancelPostingTarget(null); setCancelPostingReason(''); }}
          title={`Cancel GL Posting — ${cancelPostingTarget.voucher_number}`}
        >
          <div className="space-y-2">
            <div className="bg-amber-50 border border-amber-200 rounded-lg p-3 text-sm text-amber-800">
              This will delete the journal entry for this payment voucher and reset it to Draft. The voucher will need to be re-posted after any edits.
            </div>
            <div>
              <label className="block text-[10px] font-semibold text-gray-500 uppercase tracking-wide mb-0.5">Reason (optional)</label>
              <textarea name="reason_optional" aria-label="Reason (optional)"
                value={cancelPostingReason}
                onChange={(e) => setCancelPostingReason(e.target.value)}
                rows={3}
                className="w-full h-8 px-2 text-[11px] border border-gray-300 rounded bg-white"
                placeholder="Reason for cancelling the GL posting..."
              />
            </div>
            <div className="flex justify-end gap-2">
              <button
                onClick={() => { setCancelPostingTarget(null); setCancelPostingReason(''); }}
                className="px-3 py-1.5 text-sm text-gray-600 border rounded-lg hover:bg-gray-50"
              >
                Back
              </button>
              <button
                onClick={handleCancelPostingConfirm}
                disabled={cancelPostingLoading}
                className="px-4 py-1.5 text-sm bg-amber-600 text-white rounded-lg hover:bg-amber-700 disabled:opacity-50"
              >
                {cancelPostingLoading ? 'Cancelling...' : 'Cancel Posting'}
              </button>
            </div>
          </div>
        </Modal>
      )}

      {viewingVoucher && (
        <Modal isOpen={!!viewingVoucher} onClose={() => setViewingVoucher(null)} title={`Payment Voucher ${viewingVoucher.voucher_number}`}>
          <div className="space-y-2 text-xs">
            <div className="flex items-center justify-between pb-3 border-b border-gray-200">
              <div>
                <div className="text-xs text-gray-500">Voucher No.</div>
                <div className="text-sm font-semibold text-gray-900">{viewingVoucher.voucher_number}</div>
              </div>
              <div className="text-right">
                <div className="text-xs text-gray-500">Date</div>
                <div className="font-medium text-gray-900">{new Date(viewingVoucher.voucher_date).toLocaleDateString('en-GB')}</div>
              </div>
              <div className="flex items-center gap-2">
                {viewingVoucher.is_posted ? (
                  <span className="flex items-center gap-1 px-2 py-1 bg-green-100 text-green-700 rounded text-xs font-medium">
                    <Lock className="w-3 h-3" /> Posted
                  </span>
                ) : (
                  <span className="px-2 py-1 bg-yellow-100 text-yellow-700 rounded text-xs font-medium">Draft</span>
                )}
                {viewingVoucher.is_posted && isAdmin && (
                  <button
                    onClick={() => { setViewingVoucher(null); openCancelPostingModal(viewingVoucher); }}
                    className="flex items-center gap-1.5 px-2 py-1 text-xs font-medium border border-amber-300 text-amber-700 rounded hover:bg-amber-50"
                  >
                    <RotateCcw className="w-3 h-3" /> Cancel Posting
                  </button>
                )}
                {!viewingVoucher.is_posted && canManage && (
                  <button
                    onClick={() => { setViewingVoucher(null); handlePostVoucher(viewingVoucher); }}
                    className="flex items-center gap-1.5 px-2 py-1 text-xs font-medium border border-green-300 text-green-700 rounded hover:bg-green-50"
                  >
                    <CheckCircle className="w-3 h-3" /> Post to GL
                  </button>
                )}
                <button
                  onClick={() => window.print()}
                  className="flex items-center gap-1.5 px-3 py-1.5 text-xs font-medium border border-gray-200 rounded hover:bg-gray-50 print:hidden"
                >
                  <Printer className="w-3.5 h-3.5" /> Print
                </button>
              </div>
            </div>

            <div className="grid grid-cols-2 gap-4">
              <div>
                <div className="text-xs text-gray-500 mb-0.5">Payee</div>
                <div className="font-medium text-gray-900">{viewingVoucher.suppliers?.company_name || viewingVoucher.finance_staff_master?.full_name || '—'}</div>
              </div>
              <div>
                <div className="text-xs text-gray-500 mb-0.5">Payment Method</div>
                <div className="font-medium text-gray-900 capitalize">{viewingVoucher.payment_method.replace(/_/g, ' ')}</div>
              </div>
              {viewingVoucher.payment_purpose !== 'general' && (
                <div>
                  <div className="text-xs text-gray-500 mb-0.5">Purpose</div>
                  <div className="font-medium text-amber-800 capitalize">{viewingVoucher.payment_purpose.replace(/_/g, ' ')}</div>
                </div>
              )}
              <div>
                <div className="text-xs text-gray-500 mb-0.5">Bank Account</div>
                <div className="font-medium text-gray-900">
                  {viewingVoucher.bank_accounts
                    ? `${viewingVoucher.bank_accounts.alias || viewingVoucher.bank_accounts.bank_name || viewingVoucher.bank_accounts.account_name} (${viewingVoucher.bank_accounts.currency})`
                    : '—'}
                </div>
                {viewingVoucher.bank_account_id && (
                  <div className="mt-2">
                    <BankTransactionLinkField
                      bankAccountId={viewingVoucher.bank_account_id}
                      linkedTransaction={viewingVoucher.bank_statement_line || null}
                      selectedTransactionId={viewingVoucher.bank_statement_line_id || ''}
                      currentJournalEntryId={viewingVoucher.journal_entry_id}
                      disabled={!viewingVoucher.is_posted || !viewingVoucher.journal_entry_id}
                      disabledMessage="Post this voucher to create its journal entry before linking a bank transaction."
                      canUnlink={canManage}
                      onSelect={(transaction) => handleLinkBankTransaction(viewingVoucher, transaction)}
                      onUnlink={() => handleUnlinkBankTransaction(viewingVoucher)}
                    />
                  </div>
                )}
              </div>
              <div>
                <div className="text-xs text-gray-500 mb-0.5">Reference No.</div>
                <div className="font-medium text-gray-900">{viewingVoucher.reference_number || '—'}</div>
              </div>
            </div>

            {(() => {
              const invCcy = viewAllocations[0]?.allocated_currency || viewingVoucher.invoice_currency || 'IDR';
              const bankCcy = viewingVoucher.bank_accounts?.currency || 'IDR';
              const isCross = invCcy !== bankCcy;
              const isAdvanceSettlement = viewingVoucher.payment_method === 'advance_adjustment';
              return (
                <div className="rounded border border-gray-200 bg-gray-50 p-3">
                  <div className="grid grid-cols-2 gap-3">
                    <div>
                      <div className="text-xs text-gray-500">Invoice Amount ({invCcy})</div>
                      <div className="font-semibold text-gray-900">{fmt(viewingVoucher.invoice_amount ?? viewingVoucher.amount ?? 0, invCcy)}</div>
                    </div>
                    {isCross && viewingVoucher.exchange_rate && viewingVoucher.exchange_rate !== 1 && (
                      <div>
                        <div className="text-xs text-gray-500">Exchange Rate (1 {invCcy} = {bankCcy})</div>
                        <div className="font-semibold text-gray-900">{viewingVoucher.exchange_rate.toLocaleString()}</div>
                      </div>
                    )}
                    {viewingVoucher.bank_charge ? (
                      <div>
                        <div className="text-xs text-gray-500">Bank Charge ({bankCcy})</div>
                        <div className="font-semibold text-gray-900">{fmt(viewingVoucher.bank_charge, bankCcy)}</div>
                      </div>
                    ) : null}
                    <div>
                      <div className="text-xs text-gray-500">{isAdvanceSettlement ? `Non-cash Settlement (${invCcy})` : `Bank Debit (${bankCcy})`}</div>
                      <div className="font-semibold text-blue-700">
                        {fmt(
                          isAdvanceSettlement
                            ? viewingVoucher.amount || 0
                            : viewingVoucher.actual_bank_debit && viewingVoucher.actual_bank_debit > 0
                            ? viewingVoucher.actual_bank_debit
                            : viewingVoucher.bank_amount && viewingVoucher.bank_amount > 0
                            ? viewingVoucher.bank_amount
                            : (viewingVoucher.amount || 0) + (viewingVoucher.bank_charge || 0),
                          isAdvanceSettlement ? invCcy : bankCcy,
                        )}
                      </div>
                    </div>
                    {viewingVoucher.pph_amount ? (
                      <div>
                        <div className="text-xs text-gray-500">PPh Withholding ({invCcy})</div>
                        <div className="font-semibold text-gray-900">{fmt(viewingVoucher.pph_amount, invCcy)}</div>
                      </div>
                    ) : null}
                    {!isAdvanceSettlement && (
                      <div>
                        <div className="text-xs text-gray-500">Net Paid ({invCcy})</div>
                        <div className="font-semibold text-red-600">{fmt(viewingVoucher.net_amount || 0, invCcy)}</div>
                      </div>
                    )}
                  </div>
                </div>
              );
            })()}

            {viewAllocations.length > 0 && (
              <div>
                <div className="text-xs font-medium text-gray-500 uppercase tracking-wide mb-2">Allocated to Invoices</div>
                <div className="border border-gray-200 rounded overflow-hidden">
                  <table className="w-full text-xs">
                    <thead className="bg-gray-50">
                      <tr>
                        <th className="px-3 py-2 text-left font-medium text-gray-600">Invoice No.</th>
                        <th className="px-3 py-2 text-left font-medium text-gray-600">Invoice Date</th>
                        <th className="px-3 py-2 text-right font-medium text-gray-600">Allocated</th>
                        <th className="px-3 py-2 text-right font-medium text-gray-600">Adjustment</th>
                      </tr>
                    </thead>
                    <tbody>
                      {viewAllocations.map((a, i) => (
                        <tr key={i} className="border-t border-gray-100">
                          <td className="px-3 py-2">
                            {a.is_expense_bill && onViewExpense && a.expense_id ? (
                              <button
                                onClick={() => { setViewingVoucher(null); onViewExpense(a.expense_id!); }}
                                className="text-blue-600 hover:text-blue-800 hover:underline font-medium"
                              >
                                {a.invoice_number}
                              </button>
                            ) : onViewInvoice && a.invoice_id && !a.is_expense_bill ? (
                              <button
                                onClick={() => { setViewingVoucher(null); onViewInvoice(a.invoice_id); }}
                                className="text-blue-600 hover:text-blue-800 hover:underline font-medium"
                              >
                                {a.invoice_number}
                              </button>
                            ) : (
                              <span className="text-gray-900 font-medium">{a.invoice_number}</span>
                            )}
                          </td>
                          <td className="px-3 py-2 text-gray-600">{a.invoice_date ? new Date(a.invoice_date).toLocaleDateString('en-GB') : '—'}</td>
                          <td className="px-3 py-2 text-right font-medium text-gray-900">
                            {fmt(a.allocated_amount, a.allocated_currency)}
                          </td>
                          <td className="px-3 py-2 text-right">
                            {Number(a.settlement_adjustment) > 0 ? (
                              <span className="text-amber-700 font-medium">
                                {fmt(Number(a.settlement_adjustment), a.allocated_currency)} ({a.adjustment_type || 'adj'})
                              </span>
                            ) : (
                              <span className="text-gray-400">—</span>
                            )}
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              </div>
            )}

            {viewAllocations.some(a => a.expense_category === 'salary') && (() => {
              const salary = viewAllocations.find(a => a.expense_category === 'salary')!;
              const gross = Number(salary.gross_salary || 0);
              const advance = Number(salary.advance_applied || 0);
              const pph21 = Number(salary.pph21 || 0);
              const netPayable = Math.max(gross - advance - pph21, 0);
              const finalBankPayment = viewingVoucher.payment_method === 'advance_adjustment'
                ? 0
                : Number(viewingVoucher.actual_bank_debit || viewingVoucher.bank_amount || viewingVoucher.amount || 0);
              return (
                <div className="rounded border border-emerald-200 bg-emerald-50 p-3">
                  <div className="text-xs font-semibold uppercase tracking-wide text-emerald-800">Salary Payment Summary</div>
                  <div className="mt-2 grid grid-cols-2 md:grid-cols-4 gap-3 text-sm">
                    <div><div className="text-xs text-gray-500">Gross Salary</div><div className="font-mono font-semibold">{fmt(gross, salary.allocated_currency)}</div></div>
                    <div><div className="text-xs text-gray-500">Advance Applied</div><div className="font-mono font-semibold">{fmt(advance, salary.allocated_currency)}</div></div>
                    <div><div className="text-xs text-gray-500">Net Payable</div><div className="font-mono font-semibold">{fmt(netPayable, salary.allocated_currency)}</div></div>
                    <div><div className="text-xs text-gray-500">Final Bank Payment</div><div className="font-mono font-bold text-emerald-800">{fmt(finalBankPayment, viewingVoucher.payment_currency || 'IDR')}</div></div>
                  </div>
                </div>
              );
            })()}

            {viewingVoucher.payment_purpose === 'salary_advance' && (
              <div className="rounded border border-amber-200 bg-amber-50 p-3">
                <div className="text-xs font-semibold uppercase tracking-wide text-amber-800">Salary Advance Status</div>
                <div className="mt-1 flex flex-wrap items-center gap-x-4 gap-y-1 text-sm">
                  <span className="font-medium capitalize text-amber-900">{(viewingVoucher.salary_advance_status || 'outstanding').replace(/_/g, ' ')}</span>
                  <span>Applied: <span className="font-mono font-semibold">{fmt(viewingVoucher.salary_advance_applied_amount || 0, viewingVoucher.payment_currency || 'IDR')}</span></span>
                  <span>Outstanding: <span className="font-mono font-semibold">{fmt(Math.max((viewingVoucher.amount || 0) - (viewingVoucher.salary_advance_applied_amount || 0), 0), viewingVoucher.payment_currency || 'IDR')}</span></span>
                </div>
                {(viewingVoucher.salary_advance_applications || []).length > 0 && (
                  <div className="mt-2 border-t border-amber-200 pt-2 text-xs text-amber-900">
                    {(viewingVoucher.salary_advance_applications || []).map((application) => (
                      <div key={`${application.salary_expense_id}:${application.applied_amount}`} className="flex justify-between gap-3 py-0.5">
                        {onViewExpense ? (
                          <button type="button" onClick={() => { setViewingVoucher(null); onViewExpense(application.salary_expense_id); }} className="text-blue-700 hover:underline">
                            Salary Expense {application.salary_voucher_number || application.salary_expense_id}
                          </button>
                        ) : (
                          <span>Applied to Salary Expense {application.salary_voucher_number || application.salary_expense_id}</span>
                        )}
                        <span className="font-mono">{fmt(application.applied_amount, viewingVoucher.payment_currency || 'IDR')}</span>
                      </div>
                    ))}
                  </div>
                )}
              </div>
            )}

            {viewingVoucher.description && (
              <div>
                <div className="text-xs text-gray-500 mb-0.5">Description</div>
                <div className="text-gray-700 whitespace-pre-wrap">{viewingVoucher.description}</div>
              </div>
            )}
            <FinanceDocumentAttachments
              documentUrls={viewingVoucher.document_urls || []}
              readOnly
            />
          </div>
        </Modal>
      )}
        </>
      )}
    </>
  );
}
