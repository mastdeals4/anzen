import { useEffect, useState, useRef } from 'react';
import { supabase } from '../../lib/supabase';
import { useAuth } from '../../contexts/AuthContext';
import { useLanguage } from '../../contexts/LanguageContext';
import { Search, ArrowDownCircle, Printer, Lock, RotateCcw, CheckCircle, Download, Link2, FileText, Banknote } from 'lucide-react';
import * as XLSX from 'xlsx';
import { FinanceModal as Modal } from './FinanceModal';
import { SearchableSelect } from '../SearchableSelect';
import { MoneyInput } from '../MoneyInput';
import { FinanceModal } from './FinanceModal';
import { F_BTN_PRIMARY, F_BTN_SECONDARY } from './FinanceForm';
import { SapRow, SapField, SAP_INPUT } from './SapLayout';
import jsPDF from 'jspdf';
import html2canvas from 'html2canvas';
import { showToast } from '../ToastNotification';
import { showConfirm } from '../ConfirmDialog';
import { FinanceActionButton, FinanceBadge } from './FinanceUI';
import { supabaseErrorMessage } from '../../utils/supabaseError';
import { type CompanySnapshot } from '../../types/company';
import { waitForImages } from '../../utils/companyLogoUrl';
import { formatCurrency } from '../../utils/currency';
import { getReportingUsdRate, saveReceiptVoucher, applySettlementAdjustment, linkBankStatementLine, unlinkBankStatementAllocation } from '../../services/financeCommands';
import { loadUnmatchedDebitBankTransactions, notifyFinanceReconciliationRefresh, unlinkBankTransaction } from './bankTransactionLinking';
import { useFinance } from '../../contexts/FinanceContext';

interface Customer {
  id: string;
  company_name: string;
}

interface BankAccount {
  id: string;
  account_name: string;
  bank_name: string;
  account_number: string;
  alias?: string;
  currency: string;
}

interface SalesInvoice {
  id: string;
  invoice_number: string;
  invoice_date: string;
  total_amount: number;
  paid_amount: number;
  balance_amount: number;
}

interface SalesOrder {
  id: string;
  so_number: string;
  so_date: string;
  total_amount: number;
  advance_payment_amount: number;
  advance_payment_status: string;
  balance_due: number;
  status?: string;
}

type AllocationTarget = (SalesInvoice & { type: 'invoice' }) | (SalesOrder & { type: 'salesorder' });

interface ReceiptVoucher {
  id: string;
  voucher_number: string;
  voucher_date: string;
  customer_id: string;
  payment_method: string;
  bank_account_id: string | null;
  reference_number: string | null;
  amount: number;
  description: string | null;
  is_posted: boolean;
  journal_entry_id: string | null;
  transaction_currency?: 'IDR' | 'USD' | null;
  exchange_rate?: number | null;
  created_at: string;
  customers?: { company_name: string };
  bank_accounts?: { account_name: string; bank_name: string; alias?: string; currency: string };
  allocated_to?: string;
  company_snapshot?: CompanySnapshot | null;
}
 
interface ReceiptAllocationItem {
  targetId: string;
  targetType: 'invoice' | 'salesorder';
  amount: number;
  roundOffAmount?: number;
  discountAmount?: number;
  adjustmentType?: 'rounding' | 'discount' | 'write_off';
  adjustmentReason?: string;
}

export interface BankReconciliationReceiptPrefill {
  statementLineId: string;
  bankAccountId: string;
  date: string;
  amount: number;
  description: string;
  currency?: 'IDR' | 'USD';
  reference?: string;
}

export interface ReceiptVoucherManagerProps {
  canManage: boolean;
  initialViewVoucherId?: string | null;
  onInitialViewHandled?: () => void;
  prefillFromBankReconciliation?: BankReconciliationReceiptPrefill | null;
  onBankReconciliationPrefillConsumed?: () => void;
  onReceiptSavedFromBankReconciliation?: (voucherId: string, statementLineId: string) => void;
  embeddedModalOnly?: boolean;
  onCloseEmbedded?: () => void;
}

export function ReceiptVoucherManager({
  canManage,
  initialViewVoucherId,
  onInitialViewHandled,
  prefillFromBankReconciliation,
  onBankReconciliationPrefillConsumed,
  onReceiptSavedFromBankReconciliation,
  embeddedModalOnly,
  onCloseEmbedded,
}: ReceiptVoucherManagerProps) {
  const { t } = useLanguage();
  const { profile } = useAuth();
  const { dateRange } = useFinance();
  const isAdmin = profile?.role === 'admin';
  const printRef = useRef<HTMLDivElement>(null);
  const [cancelPostingTarget, setCancelPostingTarget] = useState<ReceiptVoucher | null>(null);
  const [cancelPostingReason, setCancelPostingReason] = useState('');
  const [cancelPostingLoading, setCancelPostingLoading] = useState(false);
  const [postingLoading, setPostingLoading] = useState<string | null>(null);
  const [vouchers, setVouchers] = useState<ReceiptVoucher[]>([]);
  const [customers, setCustomers] = useState<Customer[]>([]);
  const [bankAccounts, setBankAccounts] = useState<BankAccount[]>([]);
  const [allocationTargets, setAllocationTargets] = useState<AllocationTarget[]>([]);
  const [loading, setLoading] = useState(true);
  const [modalOpen, setModalOpen] = useState(false);
  const [viewModalOpen, setViewModalOpen] = useState(false);
  const [editMode, setEditMode] = useState(false);
  const [selectedVoucher, setSelectedVoucher] = useState<ReceiptVoucher | null>(null);
  const [voucherAllocations, setVoucherAllocations] = useState<any[]>([]);
  const [receiptBankLines, setReceiptBankLines] = useState<any[]>([]);
  const [availableReceiptBankLines, setAvailableReceiptBankLines] = useState<any[]>([]);
  const [selectedReceiptBankLineId, setSelectedReceiptBankLineId] = useState('');
  const [receiptBankLinkLoading, setReceiptBankLinkLoading] = useState(false);
  const [receiptBankCandidatesLoading, setReceiptBankCandidatesLoading] = useState(false);
  const [receiptJournalLines, setReceiptJournalLines] = useState<any[]>([]);
  const [searchTerm, setSearchTerm] = useState('');
  const [allocations, setAllocations] = useState<ReceiptAllocationItem[]>([]);
  const [roundingTolerance, setRoundingTolerance] = useState(100);
  const [receiptAdjustments, setReceiptAdjustments] = useState<any[]>([]);
  const [bankReconStatementLineId, setBankReconStatementLineId] = useState<string | null>(null);
  const [bankReconExpectedAmount, setBankReconExpectedAmount] = useState<number | null>(null);
  const [bankReconBankAccountId, setBankReconBankAccountId] = useState<string | null>(null);

  const [formData, setFormData] = useState({
    voucher_date: new Date().toISOString().split('T')[0],
    customer_id: '',
    payment_method: 'bank_transfer',
    bank_account_id: '',
    reference_number: '',
    amount: 0,
    exchange_rate: 1,
    description: '',
  });

  useEffect(() => {
    loadVouchers();
  }, [dateRange.startDate, dateRange.endDate]);

  useEffect(() => {
    loadCustomers();
    loadBankAccounts();
    loadCompanySettings();
  }, []);

  useEffect(() => {
    if (!prefillFromBankReconciliation || loading) return;
    setBankReconStatementLineId(prefillFromBankReconciliation.statementLineId);
    setBankReconExpectedAmount(prefillFromBankReconciliation.amount);
    setBankReconBankAccountId(prefillFromBankReconciliation.bankAccountId);

    resetForm();
    const bank = bankAccounts.find(b => b.id === prefillFromBankReconciliation.bankAccountId);
    const currency = prefillFromBankReconciliation.currency || (bank?.currency as 'IDR' | 'USD') || 'IDR';

    setFormData(prev => ({
      ...prev,
      voucher_date: prefillFromBankReconciliation.date,
      bank_account_id: prefillFromBankReconciliation.bankAccountId,
      amount: prefillFromBankReconciliation.amount,
      description: prefillFromBankReconciliation.description,
      reference_number: prefillFromBankReconciliation.reference || '',
      payment_method: 'bank_transfer',
      exchange_rate: currency === 'IDR' ? 1 : 1,
    }));
    setModalOpen(true);
    onBankReconciliationPrefillConsumed?.();
  }, [prefillFromBankReconciliation, loading, bankAccounts, onBankReconciliationPrefillConsumed]);

  const loadCompanySettings = async () => {
    const { data } = await supabase
      .from('app_settings')
      .select('rounding_tolerance_amount')
      .limit(1)
      .maybeSingle();

    if (data) {
      setRoundingTolerance(Number(data.rounding_tolerance_amount ?? 100));
    }
  };

  useEffect(() => {
    if (formData.customer_id) {
      loadAllocationTargets(formData.customer_id);
    } else {
      setAllocationTargets([]);
      setAllocations([]);
    }
  }, [formData.customer_id]);

  const loadVouchers = async () => {
    try {
      const { data, error } = await supabase
        .from('receipt_vouchers')
        .select('*, customers(company_name), bank_accounts(account_name, bank_name, alias, currency), is_posted, journal_entry_id, company_snapshot')
        .gte('voucher_date', dateRange.startDate)
        .lte('voucher_date', dateRange.endDate)
        .order('voucher_date', { ascending: false });

      if (error) throw error;

      // Load allocations for each voucher
      const vouchersWithAllocations = await Promise.all(
        (data || []).map(async (voucher) => {
          const { data: allocations } = await supabase
            .from('voucher_allocations')
            .select(`
              allocated_amount,
              sales_invoice_id,
              sales_order_id,
              sales_invoices(invoice_number),
              sales_orders(so_number)
            `)
            .eq('receipt_voucher_id', voucher.id);

          // Build display text
          let allocated_to = '-';
          if (allocations && allocations.length > 0) {
            const displays = allocations.map(alloc => {
              if (alloc.sales_invoice_id && alloc.sales_invoices) {
                const invoice = Array.isArray(alloc.sales_invoices) ? alloc.sales_invoices[0] : alloc.sales_invoices;
                return `${invoice?.invoice_number} (Invoice)`;
              } else if (alloc.sales_order_id && alloc.sales_orders) {
                const order = Array.isArray(alloc.sales_orders) ? alloc.sales_orders[0] : alloc.sales_orders;
                return `${order?.so_number} (Advance)`;
              }
              return null;
            }).filter(Boolean);

            allocated_to = displays.length > 0 ? displays.join(', ') : '-';
          }

          return { ...voucher, allocated_to };
        })
      );

      setVouchers(vouchersWithAllocations);
    } catch (error) {
      console.error('Error loading vouchers:', error);
    } finally {
      setLoading(false);
    }
  };

  const loadCustomers = async () => {
    const { data } = await supabase
      .from('customers')
      .select('id, company_name')
      .eq('is_active', true)
      .order('company_name');
    setCustomers(data || []);
  };

  const loadBankAccounts = async () => {
    const { data } = await supabase.from('bank_accounts').select('id, account_name, bank_name, account_number, alias, currency').eq('is_active', true);
    setBankAccounts(data || []);
  };

  const loadAllocationTargets = async (customerId: string, keepExistingAllocations = false, voucherId?: string) => {
    try {
      // Load invoices with calculated balance using RPC function
      // When editing (voucherId provided), exclude current voucher's allocations so balance shows correctly
      const { data: allInvoicesData } = await supabase
        .rpc('get_invoices_with_balance', {
          customer_uuid: customerId,
          exclude_voucher_uuid: voucherId || null
        });

      // Filter for unpaid/partially paid invoices
      const invoices = (allInvoicesData || []).filter((inv: SalesInvoice) => inv.balance_amount > 0);

      // Load sales orders (any active status - exclude cancelled/closed)
      const { data: salesOrders } = await supabase
        .from('sales_orders')
        .select('id, so_number, so_date, total_amount, advance_payment_amount, advance_payment_status, status')
        .eq('customer_id', customerId)
        .not('status', 'in', '(cancelled,closed)')
        .order('so_date');

      let additionalInvoices: any[] = [];
      let additionalSOs: any[] = [];

      // If editing, also load already-allocated invoices/SOs (even if fully paid)
      if (voucherId) {
        const { data: existingAllocs } = await supabase
          .from('voucher_allocations')
          .select('sales_invoice_id, sales_order_id')
          .eq('receipt_voucher_id', voucherId);

        if (existingAllocs) {
          const invoiceIds = existingAllocs.filter(a => a.sales_invoice_id).map(a => a.sales_invoice_id);
          const soIds = existingAllocs.filter(a => a.sales_order_id).map(a => a.sales_order_id);

          if (invoiceIds.length > 0) {
            // Get all invoices with balance calculation excluding current voucher, filter for linked ones
            const { data: allInvsData } = await supabase
              .rpc('get_invoices_with_balance', {
                customer_uuid: customerId,
                exclude_voucher_uuid: voucherId || null
              });

            additionalInvoices = (allInvsData || []).filter((inv: SalesInvoice) =>
              invoiceIds.includes(inv.id)
            );
          }

          if (soIds.length > 0) {
            const { data: linkedSOs } = await supabase
              .from('sales_orders')
              .select('id, so_number, so_date, total_amount, advance_payment_amount, advance_payment_status, status')
              .in('id', soIds);
            additionalSOs = linkedSOs || [];
          }
        }
      }

      // Merge and deduplicate
      const allInvoices = [...(invoices || []), ...additionalInvoices];
      const uniqueInvoices = Array.from(new Map(allInvoices.map(inv => [inv.id, inv])).values());

      const allSOs = [...(salesOrders || []), ...additionalSOs];
      const uniqueSOs = Array.from(new Map(allSOs.map(so => [so.id, so])).values())
        .filter(so => so.advance_payment_status !== 'full');

      // A Sales Order is an advance-payment target only until an invoice exists.
      // Once invoiced, collect against the invoice balance instead of showing
      // the same commercial transaction a second time as "SO (Advance)".
      // Preserve SOs already allocated to this receipt so legacy allocations
      // remain visible/editable and are not silently discarded.
      const existingAllocatedSoIds = new Set(additionalSOs.map(so => so.id));
      const { data: invoicedOrderRows, error: invoicedOrderError } = await supabase
        .from('sales_invoices')
        .select('sales_order_id')
        .eq('customer_id', customerId)
        .not('sales_order_id', 'is', null);
      if (invoicedOrderError) throw invoicedOrderError;
      const invoicedOrderIds = new Set((invoicedOrderRows || []).map((row: any) => row.sales_order_id).filter(Boolean));
      const eligibleSOs = uniqueSOs.filter(so => !invoicedOrderIds.has(so.id) || existingAllocatedSoIds.has(so.id));

      // Combine both into allocation targets
      const targets: AllocationTarget[] = [
        ...eligibleSOs.map(so => ({
          ...so,
          balance_due: so.total_amount - (so.advance_payment_amount || 0),
          type: 'salesorder' as const
        })),
        ...uniqueInvoices.map(inv => ({
          ...inv,
          type: 'invoice' as const
        }))
      ];

      setAllocationTargets(targets);
      if (!keepExistingAllocations) {
        setAllocations([]);
      }
    } catch (error) {
      console.error('Error loading allocation targets:', error);
    }
  };

  const handleAllocationChange = (
    targetId: string,
    targetType: 'invoice' | 'salesorder',
    amount: number,
    patch?: {
      roundOffAmount?: number;
      discountAmount?: number;
      adjustmentType?: 'rounding' | 'discount' | 'write_off';
      adjustmentReason?: string;
    }
  ) => {
    const target = allocationTargets.find(t => t.id === targetId);
    const balance = target
      ? (target.type === 'invoice' ? (target as SalesInvoice & { type: 'invoice' }).balance_amount : (target as SalesOrder & { type: 'salesorder' }).balance_due)
      : amount;

    setAllocations(prev => {
      const existing = prev.find(a => a.targetId === targetId);
      const allocated = amount;
      let roundOff = patch?.roundOffAmount !== undefined ? patch.roundOffAmount : (existing?.roundOffAmount || 0);
      let discount = patch?.discountAmount !== undefined ? patch.discountAmount : (existing?.discountAmount || 0);
      let adjType = patch?.adjustmentType !== undefined ? patch.adjustmentType : (existing?.adjustmentType || 'rounding');
      const adjReason = patch?.adjustmentReason !== undefined ? patch.adjustmentReason : (existing?.adjustmentReason || '');

      if ((targetType === 'invoice' || targetType === 'salesorder') && patch?.roundOffAmount === undefined && patch?.discountAmount === undefined) {
        const residual = Math.round((balance - allocated) * 100) / 100;
        if (allocated > 0 && Math.abs(residual) > 0 && Math.abs(residual) <= roundingTolerance && discount === 0) {
          roundOff = residual;
          adjType = 'rounding';
        } else if (residual === 0) {
          roundOff = 0;
          discount = 0;
        }
      }

      if (allocated <= 0 && roundOff <= 0 && discount <= 0) {
        return prev.filter(a => a.targetId !== targetId);
      }

      const item: ReceiptAllocationItem = {
        targetId,
        targetType,
        amount: allocated,
        roundOffAmount: roundOff,
        discountAmount: discount,
        adjustmentType: adjType,
        adjustmentReason: adjReason,
      };

      if (existing) {
        return prev.map(a => a.targetId === targetId ? item : a);
      }
      return [...prev, item];
    });
  };

  const totalAllocated = allocations.reduce((sum, a) => sum + a.amount, 0);
  const totalRoundOff = allocations.reduce((sum, a) => sum + (a.roundOffAmount || 0), 0);
  const totalDiscount = allocations.reduce((sum, a) => sum + (a.discountAmount || 0), 0);
  const formCurrency = bankAccounts.find(bank => bank.id === formData.bank_account_id)?.currency || 'IDR';
  const voucherCurrency = (voucher: ReceiptVoucher) => voucher.bank_accounts?.currency || 'IDR';

  const getInvoiceAllocationPreview = (target: AllocationTarget) => {
    const balance = target.type === 'invoice'
      ? (target as SalesInvoice & { type: 'invoice' }).balance_amount
      : (target as SalesOrder & { type: 'salesorder' }).balance_due;

    const alloc = allocations.find(a => a.targetId === target.id);
    const allocated = alloc?.amount || 0;
    const roundOff = alloc?.roundOffAmount || 0;
    const discount = alloc?.discountAmount || 0;
    const residual = Math.round((balance - allocated) * 100) / 100;
    const withinTolerance = allocated > 0 && Math.abs(residual) > 0 && Math.abs(residual) <= roundingTolerance;
    const effectiveRoundOff = alloc ? roundOff : (withinTolerance ? residual : 0);
    const finalBalance = Math.max(0, Math.round((balance - allocated - effectiveRoundOff - discount) * 100) / 100);

    return {
      roundingAdjustment: effectiveRoundOff,
      discountAdjustment: discount,
      finalBalance,
      invoiceClosed: (finalBalance === 0 && (allocated > 0 || effectiveRoundOff > 0 || discount > 0)) || (allocated >= balance && balance > 0),
    };
  };

  const handlePrint = async () => {
    if (!printRef.current || !selectedVoucher) return;
    if (!selectedVoucher.company_snapshot) {
      alert('Cannot print: this voucher has no company_snapshot. Ask an admin to run the snapshot backfill migration.');
      return;
    }
    await waitForImages(printRef.current);

    try {
      const canvas = await html2canvas(printRef.current, {
        scale: 2,
        useCORS: true,
        logging: false,
      });

      const imgData = canvas.toDataURL('image/png');
      const pdf = new jsPDF('p', 'mm', 'a4');
      const pdfWidth = pdf.internal.pageSize.getWidth();
      const pdfHeight = (canvas.height * pdfWidth) / canvas.width;

      pdf.addImage(imgData, 'PNG', 0, 0, pdfWidth, pdfHeight);
      pdf.save(`Receipt-${selectedVoucher.voucher_number}.pdf`);
    } catch (error) {
      console.error('Error generating PDF:', error);
      showToast({ type: 'error', title: 'Error', message: 'Error generating PDF. Please try again.' });
    }
  };

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();

    if (allocations.length > 0 && totalAllocated > formData.amount) {
      showToast({ type: 'error', title: 'Error', message: 'Total allocated amount cannot exceed payment amount' });
      return;
    }

    const unallocatedDifference = Math.round((formData.amount - totalAllocated) * 100) / 100;
    if (allocations.length > 0 && unallocatedDifference > roundingTolerance) {
      showToast({
        type: 'error',
        title: 'Rounding Tolerance Exceeded',
        message: `Unallocated receipt difference of ${formatCurrency(unallocatedDifference, formCurrency)} exceeds configured rounding tolerance of ${formatCurrency(roundingTolerance, formCurrency)}.`,
      });
      return;
    }

    const missingReason = allocations.find(a => (a.discountAmount || 0) > 0 && !a.adjustmentReason?.trim());
    if (missingReason) {
      showToast({ type: 'error', title: 'Reason Required', message: 'A valid reason is required for discount or write-off settlement adjustments.' });
      return;
    }

    if (bankReconStatementLineId) {
      if (formData.payment_method === 'cash') {
        showToast({ type: 'error', title: 'Invalid Method', message: 'A reconciled bank receipt must use the bank transfer payment method.' });
        return;
      }
      if (bankReconBankAccountId && formData.bank_account_id !== bankReconBankAccountId) {
        showToast({ type: 'error', title: 'Invalid Bank Account', message: 'The receipt bank account must remain the bank account on the selected statement line.' });
        return;
      }
      if (bankReconExpectedAmount != null && Math.abs(formData.amount - bankReconExpectedAmount) > 0.01) {
        showToast({ type: 'error', title: 'Amount Mismatch', message: 'Receipt amount must equal the selected bank statement amount.' });
        return;
      }
    }

    try {
      const { data: { user } } = await supabase.auth.getUser();
      if (!user) throw new Error('Not authenticated');

      if (editMode && selectedVoucher?.is_posted) {
        showToast({ type: 'error', title: 'Posted', message: 'Cannot edit a posted receipt voucher. Cancel posting first.' });
        return;
      }

      if (bankReconStatementLineId) {
        const { data: lineCheck, error: checkErr } = await supabase
          .from('bank_statement_lines')
          .select('id, matched_receipt_id, matching_status')
          .eq('id', bankReconStatementLineId)
          .single();
        if (checkErr) throw checkErr;
        if (lineCheck?.matched_receipt_id) {
          throw new Error(`This bank statement line is already linked to a receipt (ID: ${lineCheck.matched_receipt_id}).`);
        }
      }

      const currency = (bankAccounts.find(bank => bank.id === formData.bank_account_id)?.currency || 'IDR') as 'IDR' | 'USD';
      const exchangeRate = currency === 'IDR'
        ? 1
        : (formData.exchange_rate > 1 ? formData.exchange_rate : await getReportingUsdRate());
      const savedVoucherId = await saveReceiptVoucher(
        editMode && selectedVoucher ? selectedVoucher.id : null,
        {
          voucher_date: formData.voucher_date,
          customer_id: formData.customer_id,
          payment_method: formData.payment_method,
          bank_account_id: formData.bank_account_id || null,
          reference_number: formData.reference_number || null,
          amount: formData.amount,
          description: formData.description || null,
          transaction_currency: currency,
          exchange_rate: exchangeRate,
          created_by: user.id,
        },
        allocations.map(alloc => ({
          sales_invoice_id: alloc.targetType === 'invoice' ? alloc.targetId : null,
          sales_order_id: alloc.targetType === 'salesorder' ? alloc.targetId : null,
          amount: alloc.amount,
        })),
      );

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
            documentType: alloc.targetType === 'salesorder' ? 'sales_order' : 'sales',
            invoiceId: alloc.targetId,
            voucherId: savedVoucherId,
            amount: totalAdj,
            adjustmentType: adjType,
            reason,
          });
        }
      }

      if (bankReconStatementLineId && !editMode) {
        const { error: postError } = await supabase.rpc('post_receipt_voucher', {
          p_rv_id: savedVoucherId,
          p_posted_by: user.id,
        });
        if (postError) throw postError;
        await linkBankStatementLine(bankReconStatementLineId, 'receipt', savedVoucherId);
        setBankReconStatementLineId(null);
        notifyFinanceReconciliationRefresh();
        onReceiptSavedFromBankReconciliation?.(savedVoucherId, bankReconStatementLineId);
      }

      setModalOpen(false);
      resetForm();
      onCloseEmbedded?.();
      await loadVouchers();
    } catch (error: any) {
      console.error('Error saving voucher:', error);
      showToast({ type: 'error', title: 'Error', message: 'Failed to save: ' + error.message });
    }
  };

  const resetForm = () => {
    setFormData({
      voucher_date: new Date().toISOString().split('T')[0],
      customer_id: '',
      payment_method: 'bank_transfer',
      bank_account_id: '',
      reference_number: '',
      amount: 0,
      exchange_rate: 1,
      description: '',
    });
    setAllocations([]);
    setAllocationTargets([]);
    setEditMode(false);
    setSelectedVoucher(null);
    setBankReconStatementLineId(null);
    setBankReconExpectedAmount(null);
    setBankReconBankAccountId(null);
  };

  const handlePostVoucher = async (v: ReceiptVoucher) => {
    if (!profile?.id) return;
    setPostingLoading(v.id);
    try {
      const { error } = await supabase.rpc('post_receipt_voucher', {
        p_rv_id: v.id,
        p_posted_by: profile.id,
      });
      if (error) throw error;
      loadVouchers();
    } catch (err) {
      showToast({ type: 'error', title: 'Error', message: 'Failed to post: ' + supabaseErrorMessage(err) });
    } finally {
      setPostingLoading(null);
    }
  };

  const openCancelPostingModal = (v: ReceiptVoucher) => {
    setCancelPostingTarget(v);
    setCancelPostingReason('');
  };

  const handleCancelPostingConfirm = async () => {
    if (!cancelPostingTarget || !profile?.id) return;
    setCancelPostingLoading(true);
    try {
      const { error } = await supabase.rpc('cancel_receipt_voucher_posting', {
        p_rv_id: cancelPostingTarget.id,
        p_cancelled_by: profile.id,
        p_reason: cancelPostingReason || null,
      });
      if (error) {
        if (error.message?.includes('period') && error.message?.includes('closed')) {
          showToast({ type: 'error', title: 'Period Closed', message: 'Cannot cancel posting: the accounting period for this voucher is closed.' });
          return;
        }
        throw error;
      }
      setCancelPostingTarget(null);
      setCancelPostingReason('');
      loadVouchers();
    } catch (err) {
      showToast({ type: 'error', title: 'Error', message: 'Failed to cancel posting: ' + supabaseErrorMessage(err) });
    } finally {
      setCancelPostingLoading(false);
    }
  };

  const handleView = async (voucher: ReceiptVoucher) => {
    setSelectedVoucher(voucher);

    // Detail presentation uses the same canonical linked records as Bank
    // Reconciliation and GL; this is read-only UI enrichment.
    const [{ data: allocs }, { data: bankLines }, { data: canonicalBankAllocations }, { data: journalLines }, { data: adjustments }] = await Promise.all([
      supabase
      .from('voucher_allocations')
      .select(`
        *,
        sales_invoices(invoice_number, invoice_date, total_amount),
        sales_orders(so_number, so_date, total_amount)
      `)
      .eq('receipt_voucher_id', voucher.id),
      supabase.from('bank_statement_lines')
        .select('id, transaction_date, description, reference, debit_amount, credit_amount, reconciliation_status, bank_accounts(bank_name, account_name, alias, currency)')
        .eq('matched_receipt_id', voucher.id),
      supabase.from('bank_statement_allocations')
        .select('id, allocation_amount, bank_statement_lines(id, transaction_date, description, reference, debit_amount, credit_amount, reconciliation_status, bank_accounts(bank_name, account_name, alias, currency))')
        .eq('document_type', 'receipt')
        .eq('document_id', voucher.id),
      voucher.journal_entry_id
        ? supabase.from('journal_entry_lines').select('line_number, debit, credit, description, chart_of_accounts(code, name)').eq('journal_entry_id', voucher.journal_entry_id).order('line_number')
        : Promise.resolve({ data: [] as any[] }),
      (async () => {
        try {
          const { data, error } = await supabase
            .from('invoice_rounding_adjustments')
            .select('id, sales_invoice_id, adjustment_amount, adjustment_type, reason, journal_entry_id')
            .eq('receipt_voucher_id', voucher.id);
          if (!error && data) return { data };
          const fallback = await supabase
            .from('invoice_rounding_adjustments')
            .select('id, sales_invoice_id, adjustment_amount, reason, journal_entry_id')
            .eq('receipt_voucher_id', voucher.id);
          return fallback;
        } catch {
          return { data: [] as any[] };
        }
      })(),
    ]);

    setVoucherAllocations(allocs || []);
    setReceiptAdjustments(adjustments || []);
    const canonicalLines = (canonicalBankAllocations || []).map((allocation: any) => {
      const line = Array.isArray(allocation.bank_statement_lines)
        ? allocation.bank_statement_lines[0]
        : allocation.bank_statement_lines;
      return line ? { ...line, allocation_id: allocation.id, allocation_amount: allocation.allocation_amount } : null;
    }).filter(Boolean);
    const mergedBankLines = [...(bankLines || []), ...canonicalLines]
      .filter((line: any, index: number, rows: any[]) => rows.findIndex(candidate => candidate.id === line.id) === index);
    setReceiptBankLines(mergedBankLines);
    setReceiptJournalLines(journalLines || []);
    setViewModalOpen(true);
  };

  const loadReceiptBankCandidates = async () => {
    if (!selectedVoucher?.bank_account_id) {
      showToast({ type: 'error', title: 'Bank Account Required', message: 'This receipt has no bank account selected.' });
      return;
    }
    setReceiptBankCandidatesLoading(true);
    try {
      const candidates = await loadUnmatchedDebitBankTransactions({
        bankAccountId: selectedVoucher.bank_account_id,
        direction: 'credit',
      });
      setAvailableReceiptBankLines(candidates);
      setSelectedReceiptBankLineId(candidates.find((line: any) =>
        Math.abs(Number(line.credit_amount || 0) - Number(selectedVoucher.amount)) <= 0.01
      )?.id || '');
      if (!candidates.length) {
        showToast({ type: 'info', title: 'No Unmatched Transactions', message: 'No unmatched deposit transactions were found for this bank account.' });
      }
    } catch (error: any) {
      showToast({ type: 'error', title: 'Could Not Load Bank Lines', message: supabaseErrorMessage(error) });
    } finally {
      setReceiptBankCandidatesLoading(false);
    }
  };

  const handleLinkReceiptToBankLine = async () => {
    if (!selectedVoucher || !selectedReceiptBankLineId) return;
    const line = availableReceiptBankLines.find((item: any) => item.id === selectedReceiptBankLineId);
    if (!line) return;
    const lineAmount = Number(line.remainingAmount ?? (line.credit_amount || 0));
    if (Math.abs(lineAmount - Number(selectedVoucher.amount)) > 0.01) {
      showToast({ type: 'error', title: 'Amount Mismatch', message: 'The selected bank transaction amount must match the receipt amount. Choose the exact matching transaction.' });
      return;
    }
    const confirmed = await showConfirm({
      title: 'Link Receipt to Bank Statement',
      message: `Link ${selectedVoucher.voucher_number} to the bank transaction dated ${line.transaction_date}, amount ${formatCurrency(lineAmount, voucherCurrency(selectedVoucher))}? The posted journal will not be changed.`,
      confirmLabel: 'Link Transaction',
      cancelLabel: 'Cancel',
    });
    if (!confirmed) return;
    setReceiptBankLinkLoading(true);
    try {
      await linkBankStatementLine(line.id, 'receipt', selectedVoucher.id);
      showToast({ type: 'success', title: 'Bank Transaction Linked', message: `${selectedVoucher.voucher_number} was linked to the selected bank statement line.` });
      setAvailableReceiptBankLines([]);
      setSelectedReceiptBankLineId('');
      await handleView(selectedVoucher);
      await loadVouchers();
      notifyFinanceReconciliationRefresh();
    } catch (error: any) {
      showToast({ type: 'error', title: 'Could Not Link Bank Transaction', message: supabaseErrorMessage(error) });
    } finally {
      setReceiptBankLinkLoading(false);
    }
  };

  const handleUnlinkReceiptBankLine = async (line: any) => {
    if (!selectedVoucher) return;
    const confirmed = await showConfirm({
      title: 'Unlink Bank Statement Transaction',
      message: `Unlink bank transaction ${line.reference || line.description || line.id} from this receipt voucher? The voucher and its posted journal will remain intact, and the bank transaction will become available to match again.`,
      confirmLabel: 'Unlink',
      cancelLabel: 'Cancel',
    });
    if (!confirmed) return;
    setReceiptBankLinkLoading(true);
    try {
      if (line.allocation_id) {
        await unlinkBankStatementAllocation(line.allocation_id);
      } else {
        await unlinkBankTransaction(line.id);
      }
      showToast({ type: 'success', title: 'Bank Transaction Unlinked', message: 'The bank statement line was unlinked from this receipt voucher.' });
      await handleView(selectedVoucher);
      await loadVouchers();
      notifyFinanceReconciliationRefresh();
    } catch (error: any) {
      showToast({ type: 'error', title: 'Could Not Unlink Bank Transaction', message: supabaseErrorMessage(error) });
    } finally {
      setReceiptBankLinkLoading(false);
    }
  };

  const exportExcel = async () => {
    const ids = vouchers.map(voucher => voucher.id);
    const [{ data: allocations }, { data: journalLines }, { data: bankLines }] = await Promise.all([
      supabase.from('voucher_allocations').select('receipt_voucher_id, amount, sales_invoices(invoice_number, invoice_date), sales_orders(so_number, so_date)').in('receipt_voucher_id', ids),
      supabase.from('journal_entry_lines').select('journal_entry_id, debit, credit, chart_of_accounts(code, name)').in('journal_entry_id', vouchers.map(v => v.journal_entry_id).filter(Boolean) as string[]),
      supabase.from('bank_statement_lines').select('matched_receipt_id, reference').in('matched_receipt_id', ids),
    ]);
    const allocationByVoucher = new Map<string, any[]>();
    (allocations ?? []).forEach((row: any) => allocationByVoucher.set(row.receipt_voucher_id, [...(allocationByVoucher.get(row.receipt_voucher_id) ?? []), row]));
    const coaByJournal = new Map<string, any>();
    (journalLines ?? []).forEach((line: any) => { if (!coaByJournal.has(line.journal_entry_id) && line.chart_of_accounts) coaByJournal.set(line.journal_entry_id, line.chart_of_accounts); });
    const bankByVoucher = new Map<string, string>();
    (bankLines ?? []).forEach((line: any) => bankByVoucher.set(line.matched_receipt_id, line.reference || 'Linked'));
    const rows = vouchers.flatMap(voucher => {
      const linked = allocationByVoucher.get(voucher.id) ?? [null];
      const coa = voucher.journal_entry_id ? coaByJournal.get(voucher.journal_entry_id) : null;
      return linked.map((allocation: any) => ({
        'Receipt Voucher No.': voucher.voucher_number,
        Date: voucher.voucher_date,
        Customer: voucher.customers?.company_name || '',
        'Payment Method': voucher.payment_method,
        Bank: voucher.bank_accounts?.alias || (voucher.bank_accounts ? `${voucher.bank_accounts.bank_name} - ${voucher.bank_accounts.account_name}` : ''),
        Amount: Number(voucher.amount),
        'Allocated Invoice': allocation?.amount ?? 0,
        'Invoice Number': allocation?.sales_invoices?.invoice_number || allocation?.sales_orders?.so_number || '',
        'Invoice Date': allocation?.sales_invoices?.invoice_date || allocation?.sales_orders?.so_date || '',
        'Allocation Status': allocation ? 'Allocated' : 'Unallocated',
        'Posting Status': voucher.is_posted ? 'Posted' : 'Draft',
        'Chart of Accounts Number': coa?.code || '',
        'Chart of Accounts Name': coa?.name || '',
        'Bank Transaction Reference': bankByVoucher.get(voucher.id) || voucher.reference_number || '',
      }));
    });
    const workbook = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(workbook, XLSX.utils.json_to_sheet(rows), 'Receipt Vouchers');
    XLSX.writeFile(workbook, `Receipt_Vouchers_${new Date().toISOString().slice(0, 10)}.xlsx`);
  };

  useEffect(() => {
    if (!initialViewVoucherId || loading) return;
    const voucher = vouchers.find(item => item.id === initialViewVoucherId);
    if (voucher) void handleView(voucher);
    onInitialViewHandled?.();
  }, [initialViewVoucherId, loading, vouchers, onInitialViewHandled]);

  const handleEdit = async (voucher: ReceiptVoucher) => {
    if (voucher.is_posted) {
      showToast({ type: 'error', title: 'Posted', message: 'This receipt voucher has been posted to the GL. Cancel posting first to edit it.' });
      return;
    }
    setSelectedVoucher(voucher);
    setEditMode(true);

    // Populate form with existing data
    setFormData({
      voucher_date: voucher.voucher_date,
      customer_id: voucher.customer_id,
      payment_method: voucher.payment_method,
      bank_account_id: voucher.bank_account_id || '',
      reference_number: voucher.reference_number || '',
      amount: voucher.amount,
      exchange_rate: voucher.exchange_rate || 1,
      description: voucher.description || '',
    });

    // Load allocation targets for this customer (pass voucher ID to include already-allocated docs)
    await loadAllocationTargets(voucher.customer_id, false, voucher.id);

    // THEN load existing allocations (after targets are loaded)
    const { data: allocs } = await supabase
      .from('voucher_allocations')
      // perf: projected columns (was select('*'))
      .select('id, sales_invoice_id, sales_order_id, allocated_amount')
      .eq('receipt_voucher_id', voucher.id);

    if (allocs) {
      const invoiceIds = allocs.filter(a => a.sales_invoice_id).map(a => a.sales_invoice_id!);
      const adjustmentsMap = new Map<string, any>();
      if (invoiceIds.length > 0) {
        let adjs: any[] | null = null;
        try {
          const res = await supabase
            .from('invoice_rounding_adjustments')
            .select('sales_invoice_id, adjustment_amount, adjustment_type, reason')
            .in('sales_invoice_id', invoiceIds);
          if (!res.error && res.data) {
            adjs = res.data;
          } else {
            const fallback = await supabase
              .from('invoice_rounding_adjustments')
              .select('sales_invoice_id, adjustment_amount, reason')
              .in('sales_invoice_id', invoiceIds);
            adjs = fallback.data || [];
          }
        } catch {
          adjs = [];
        }
        if (adjs) {
          for (const adj of adjs) {
            if (adj.sales_invoice_id) adjustmentsMap.set(adj.sales_invoice_id, adj);
          }
        }
      }

      const existingAllocs: ReceiptAllocationItem[] = allocs.map(a => {
        const adj = a.sales_invoice_id ? adjustmentsMap.get(a.sales_invoice_id) : undefined;
        const isDiscount = adj && (adj.adjustment_type === 'discount' || adj.adjustment_type === 'write_off');
        return {
          targetId: a.sales_invoice_id || a.sales_order_id,
          targetType: (a.sales_invoice_id ? 'invoice' : 'salesorder') as 'invoice' | 'salesorder',
          amount: Number(a.allocated_amount),
          roundOffAmount: adj && !isDiscount ? Number(adj.adjustment_amount) : 0,
          discountAmount: adj && isDiscount ? Number(adj.adjustment_amount) : 0,
          adjustmentType: adj?.adjustment_type || 'rounding',
          adjustmentReason: adj?.reason || '',
        };
      });
      setAllocations(existingAllocs);
    }

    setModalOpen(true);
  };

  const handleDelete = async (voucher: ReceiptVoucher) => {
    if (voucher.is_posted) {
      showToast({ type: 'error', title: 'Posted', message: 'This receipt voucher has been posted to the GL. Cancel posting first to delete it.' });
      return;
    }
    if (!await showConfirm({ title: 'Confirm', message: `Delete receipt voucher ${voucher.voucher_number}? This will remove all allocations and cannot be undone.`, variant: 'danger', confirmLabel: 'Delete' })) {
      return;
    }

    try {
      await supabase
        .from('voucher_allocations')
        .delete()
        .eq('receipt_voucher_id', voucher.id);

      const { data: linkedBankLines } = await supabase
        .from('bank_statement_lines')
        .select('id')
        .eq('matched_receipt_id', voucher.id);

      if (linkedBankLines && linkedBankLines.length > 0) {
        await supabase
          .from('bank_statement_lines')
          .update({
            matched_receipt_id: null,
            reconciliation_status: 'unmatched',
            matched_at: null,
            matched_by: null,
          })
          .eq('matched_receipt_id', voucher.id);
      }

      const { error } = await supabase
        .from('receipt_vouchers')
        .delete()
        .eq('id', voucher.id);

      if (error) throw error;

      alert('Receipt voucher deleted successfully');
      loadVouchers();
    } catch (error: any) {
      console.error('Error deleting voucher:', error);
      alert('Failed to delete: ' + error.message);
    }
  };

  // HARDENING FIX #6: Add null-safety to prevent crashes
  const filteredVouchers = vouchers.filter(v =>
    v.voucher_number.toLowerCase().includes(searchTerm.toLowerCase()) ||
    v.customers?.company_name?.toLowerCase().includes(searchTerm.toLowerCase())
  );

  if (loading) {
    return <div className="flex justify-center py-8"><div className="animate-spin rounded-full h-8 w-8 border-b-2 border-blue-600"></div></div>;
  }

  return (
    <div className={embeddedModalOnly ? undefined : "flex flex-col gap-2"}>
      {!embeddedModalOnly && (
        <>
          <div className="flex items-center justify-between gap-3 px-3 py-1.5 bg-white border border-gray-200 rounded-lg min-h-[42px] flex-wrap sm:flex-nowrap">
            <div className="flex items-center gap-2 shrink-0">
              <h1 className="text-sm font-semibold text-gray-900 whitespace-nowrap">Receipt Vouchers</h1>
            </div>
            <div className="relative flex-1 max-w-md min-w-[200px]">
              <Search className="absolute left-2.5 top-1/2 -translate-y-1/2 text-gray-400 w-3.5 h-3.5" />
              <input
                name="search_term"
                aria-label="Search receipts..."
                type="text"
                placeholder="Search receipts by voucher, customer..."
                value={searchTerm}
                onChange={(e) => setSearchTerm(e.target.value)}
                className="w-full h-8 pl-8 pr-2.5 text-xs border border-gray-300 rounded-md bg-white focus:outline-none focus:ring-1 focus:ring-blue-500"
              />
            </div>
            <div className="flex items-center gap-2 shrink-0 ml-auto">
              {canManage && (
                <>
                  <button
                    type="button"
                    onClick={() => void exportExcel()}
                    className="inline-flex items-center gap-1.5 h-8 px-3 border border-gray-300 rounded-md text-xs font-medium text-gray-700 bg-white hover:bg-gray-50 transition-colors shadow-xs whitespace-nowrap"
                  >
                    <Download className="w-3.5 h-3.5 text-gray-500" />
                    <span>Excel</span>
                  </button>
                  <button
                    type="button"
                    onClick={() => { resetForm(); setModalOpen(true); }}
                    className="inline-flex items-center gap-1.5 h-8 px-3 bg-green-600 text-white rounded-md text-xs font-medium hover:bg-green-700 transition-colors shadow-xs whitespace-nowrap"
                  >
                    <ArrowDownCircle className="w-3.5 h-3.5" />
                    <span>New Receipt</span>
                  </button>
                </>
              )}
            </div>
          </div>

      <div className="bg-white rounded border border-gray-200 overflow-hidden">
        <table className="w-full">
          <thead className="bg-gray-50">
            <tr>
              <th className="px-2 py-1.5 text-left text-xs font-medium text-gray-500 uppercase">Voucher No</th>
              <th className="px-2 py-1.5 text-left text-xs font-medium text-gray-500 uppercase">Date</th>
              <th className="px-2 py-1.5 text-left text-xs font-medium text-gray-500 uppercase">Customer</th>
              <th className="px-2 py-1.5 text-left text-xs font-medium text-gray-500 uppercase">Method</th>
              <th className="px-2 py-1.5 text-left text-xs font-medium text-gray-500 uppercase">Bank</th>
              <th className="px-2 py-1.5 text-left text-xs font-medium text-gray-500 uppercase">Allocated To</th>
              <th className="px-2 py-1.5 text-right text-xs font-medium text-gray-500 uppercase">Amount</th>
              <th className="px-2 py-1.5 text-center text-xs font-medium text-gray-500 uppercase">Actions</th>
            </tr>
          </thead>
          <tbody className="divide-y">
            {filteredVouchers.map(voucher => (
              <tr key={voucher.id} className="hover:bg-gray-50">
                <td className="px-2 py-1.5 font-mono text-sm">{voucher.voucher_number}</td>
                <td className="px-2 py-1.5">{new Date(voucher.voucher_date).toLocaleDateString('id-ID')}</td>
                <td className="px-2 py-1.5">{voucher.customers?.company_name}</td>
                <td className="px-2 py-1.5">
                  <span className="px-2 py-1 bg-blue-100 text-blue-700 rounded text-xs capitalize">
                    {voucher.payment_method.replace('_', ' ')}
                  </span>
                </td>
                <td className="px-2 py-1.5 text-sm">
                  {voucher.bank_accounts?.alias || voucher.bank_accounts?.account_name || '-'}
                </td>
                <td className="px-2 py-1.5 text-sm text-gray-600">{voucher.allocated_to}</td>
                <td className="px-2 py-1.5 text-right font-medium text-green-600">
                  {formatCurrency(voucher.amount, voucherCurrency(voucher))}
                </td>
                <td className="px-2 py-1.5 align-middle">
                  <div className="flex h-7 items-center justify-center gap-0.5 whitespace-nowrap">
                    <FinanceActionButton action="view" label="View Details" onClick={() => handleView(voucher)} />
                    {canManage && !voucher.is_posted && (
                      <>
                        <FinanceActionButton action="edit" onClick={() => handleEdit(voucher)} />
                        <FinanceActionButton action="approve" label="Post to GL" onClick={() => handlePostVoucher(voucher)} disabled={postingLoading === voucher.id} />
                      </>
                    )}
                    {voucher.is_posted && (
                      <FinanceBadge status="posted"><Lock className="mr-0.5 h-3 w-3" /> Posted</FinanceBadge>
                    )}
                    {voucher.is_posted && isAdmin && (
                      <FinanceActionButton action="reverse" label="Cancel Posting" onClick={() => openCancelPostingModal(voucher)} />
                    )}
                    {canManage && !voucher.is_posted && (
                      <FinanceActionButton action="delete" onClick={() => handleDelete(voucher)} />
                    )}
                  </div>
                </td>
              </tr>
            ))}
            {filteredVouchers.length === 0 && (
              <tr>
                <td colSpan={7} className="px-4 py-8 text-center text-gray-500">
                  No receipt vouchers found
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>
        </>
      )}

      <FinanceModal
        isOpen={modalOpen}
        onClose={() => { setModalOpen(false); resetForm(); onCloseEmbedded?.(); }}
        title={editMode ? "Edit Receipt Voucher" : "New Receipt Voucher"}
        size="lg"
        footer={
          <>
            <button type="button" onClick={() => { setModalOpen(false); resetForm(); onCloseEmbedded?.(); }} className={F_BTN_SECONDARY}>
              Cancel
            </button>
            <button type="submit" form="receipt-voucher-form" className={`${F_BTN_PRIMARY} bg-green-600 hover:bg-green-700`}>
              {editMode ? 'Update Receipt' : 'Save Receipt'}
            </button>
          </>
        }
      >
        <form id="receipt-voucher-form" onSubmit={handleSubmit} className="flex flex-col gap-1.5">
          <SapRow>
            <SapField label="Date" required span={4}>
              <input name="voucher_date" aria-label="Voucher Date" type="date" required value={formData.voucher_date}
                onChange={(e) => setFormData({ ...formData, voucher_date: e.target.value })}
                className={SAP_INPUT} />
            </SapField>
            <SapField label="Customer" required span={4}>
              {editMode ? (
                <div className={SAP_INPUT + ' !bg-gray-50 flex items-center'}>
                  {customers.find(c => c.id === formData.customer_id)?.company_name || 'Unknown'}
                </div>
              ) : (
                <SearchableSelect
                  value={formData.customer_id}
                  onChange={(val) => setFormData({ ...formData, customer_id: val })}
                  options={customers.map(c => ({ value: c.id, label: c.company_name }))}
                  placeholder="Select customer"
                />
              )}
            </SapField>
            <SapField label="Method" required span={4}>
              <select name="payment_method" aria-label="Payment Method" required value={formData.payment_method}
                onChange={(e) => setFormData({ ...formData, payment_method: e.target.value })}
                className={SAP_INPUT}>
                <option value="cash">Cash</option>
                <option value="bank_transfer">Bank Transfer</option>
                <option value="check">Check</option>
                <option value="giro">Giro</option>
                <option value="other">Other</option>
              </select>
            </SapField>
          </SapRow>

          <SapRow>
            <SapField label={`Amount (${formCurrency})`} required span={formData.payment_method === 'cash' ? 12 : 4}>
              <MoneyInput required decimal value={formData.amount}
                onChange={(n) => setFormData({ ...formData, amount: n })}
                className={SAP_INPUT + ' !text-right !font-mono !font-semibold'} />
            </SapField>
            {formData.payment_method !== 'cash' && (
              <>
                <SapField label="Bank Account" span={4}>
                  <select name="bank_account_id" aria-label="Bank Account Id" value={formData.bank_account_id}
                    onChange={(e) => setFormData({ ...formData, bank_account_id: e.target.value })}
                    className={SAP_INPUT}>
                    <option value="">Select account</option>
                    {bankAccounts.map(b => (
                      <option key={b.id} value={b.id}>
                        {b.alias || `${b.bank_name} - ${b.account_name}`} ({b.currency || 'IDR'})
                      </option>
                    ))}
                  </select>
                </SapField>
                <SapField label="Reference" span={4}>
                  <input name="reference_number" aria-label="Check/Transfer reference" type="text" value={formData.reference_number}
                    onChange={(e) => setFormData({ ...formData, reference_number: e.target.value })}
                    className={SAP_INPUT} placeholder="Check/Transfer reference" />
                </SapField>
              </>
            )}
          </SapRow>

          <SapRow>
            <SapField label="Description" span={12}>
              <input name="description" aria-label="Receipt description..." type="text" value={formData.description}
                onChange={(e) => setFormData({ ...formData, description: e.target.value })}
                className={SAP_INPUT} placeholder="Receipt description..." />
            </SapField>
          </SapRow>

          {(allocationTargets.length > 0 || allocations.length > 0 || editMode) && (
            <div className="border-t pt-4">
              <h4 className="font-medium text-gray-700 mb-2">Allocate Payment</h4>
              <div className="bg-blue-50 border border-blue-200 rounded-lg p-3 mb-3">
                <p className="text-sm text-blue-900 font-medium mb-1">How to allocate:</p>
                <ul className="text-xs text-blue-800 space-y-1 ml-4 list-disc">
                  <li><strong className="text-purple-700">SO (Advance)</strong> = Record advance payment against Sales Order</li>
                  <li><strong className="text-blue-700">Invoice</strong> = Record payment against Sales Invoice</li>
                  <li>Enter amount in "Allocate (Rp)" column to link payment to document</li>
                  <li>You can allocate partial amounts to multiple documents</li>
                </ul>
              </div>
              {allocationTargets.length > 0 ? (
                <div className="max-h-72 overflow-y-auto border rounded-lg">
                  <table className="w-full text-xs">
                    <thead className="bg-gray-50 sticky top-0">
                      <tr>
                        <th className="px-3 py-2 text-left font-medium text-gray-500">Document</th>
                        <th className="px-2 py-2 text-center font-medium text-gray-500">Type</th>
                        <th className="px-3 py-2 text-right font-medium text-gray-500">Balance Due</th>
                        <th className="px-3 py-2 text-right font-medium text-gray-500">Receipt Amount</th>
                        <th className="px-2 py-2 text-right font-medium text-gray-500">Round-Off</th>
                        <th className="px-2 py-2 text-right font-medium text-gray-500">Discount</th>
                        <th className="px-3 py-2 text-right font-medium text-gray-500">Final Balance</th>
                      </tr>
                    </thead>
                    <tbody className="divide-y">
                      {allocationTargets.map(target => {
                      const balance = target.type === 'invoice'
                        ? (target as SalesInvoice & { type: 'invoice' }).balance_amount
                        : (target as SalesOrder & { type: 'salesorder' }).balance_due;
                      const docNumber = target.type === 'invoice'
                        ? (target as SalesInvoice & { type: 'invoice' }).invoice_number
                        : (target as SalesOrder & { type: 'salesorder' }).so_number;
                      const docDate = target.type === 'invoice'
                        ? (target as SalesInvoice & { type: 'invoice' }).invoice_date
                        : (target as SalesOrder & { type: 'salesorder' }).so_date;
                      const preview = getInvoiceAllocationPreview(target);
                      const thisAlloc = allocations.find(a => a.targetId === target.id);
                      const allocatedAmount = thisAlloc?.amount || 0;
                      const roundOff = thisAlloc?.roundOffAmount || 0;
                      const discount = thisAlloc?.discountAmount || 0;
                      const finalBalance = preview.finalBalance;
                      const isSettled = preview.invoiceClosed;

                      return (
                        <tr key={`${target.type}-${target.id}`} className="hover:bg-gray-50/50">
                          <td className="px-3 py-2">
                            <div className="font-mono text-xs">{docNumber}</div>
                            <div className="text-gray-500 text-[10px]">{new Date(docDate).toLocaleDateString('id-ID')}</div>
                          </td>
                          <td className="px-2 py-2 text-center">
                            <span className={`px-2 py-0.5 rounded text-[10px] font-medium ${
                              target.type === 'salesorder'
                                ? 'bg-purple-100 text-purple-700'
                                : 'bg-blue-100 text-blue-700'
                            }`}>
                              {target.type === 'salesorder' ? 'SO (Advance)' : 'Invoice'}
                            </span>
                          </td>
                          <td className="px-3 py-2 text-right text-red-600 font-medium">
                            {formatCurrency(balance, formCurrency)}
                          </td>
                          <td className="px-3 py-2 text-right">
                            <MoneyInput
                              decimal
                              min={0}
                              max={balance}
                              value={allocatedAmount}
                              onChange={(n) => handleAllocationChange(target.id, target.type, Math.min(n, balance))}
                              className="w-24 px-2 py-1 border rounded text-right text-xs"
                              placeholder="0"
                            />
                          </td>
                          <td className="px-2 py-2 text-right">
                            <MoneyInput
                              decimal
                              min={0}
                              max={Math.min(roundingTolerance, Math.max(0, balance - allocatedAmount))}
                              value={roundOff}
                              onChange={(r) => handleAllocationChange(target.id, target.type, allocatedAmount, { roundOffAmount: r, adjustmentType: 'rounding' })}
                              className="w-20 px-1.5 py-1 border rounded text-right text-xs text-amber-700 bg-amber-50/30"
                              placeholder="0"
                            />
                          </td>
                          <td className="px-2 py-2 text-right">
                            <div className="flex flex-col items-end gap-1">
                              <MoneyInput
                                decimal
                                min={0}
                                max={Math.max(0, balance - allocatedAmount - roundOff)}
                                value={discount}
                                onChange={(d) => handleAllocationChange(target.id, target.type, allocatedAmount, { discountAmount: d, adjustmentType: 'discount' })}
                                className="w-20 px-1.5 py-1 border rounded text-right text-xs text-purple-700 bg-purple-50/30"
                                placeholder="0"
                              />
                              {discount > 0 && (
                                <input
                                  type="text"
                                  placeholder="Reason (req)*"
                                  value={thisAlloc?.adjustmentReason || ''}
                                  onChange={(e) => handleAllocationChange(target.id, target.type, allocatedAmount, { adjustmentReason: e.target.value })}
                                  className="w-28 text-[10px] px-1 py-0.5 border border-purple-300 rounded bg-white text-gray-800"
                                  title="Approved reason for commercial discount/write-off"
                                />
                              )}
                            </div>
                          </td>
                          <td className="px-3 py-2 text-right">
                            <div>
                              <div className={`font-semibold text-xs ${finalBalance === 0 ? 'text-green-700' : 'text-gray-700'}`}>
                                {formatCurrency(finalBalance, formCurrency)}
                              </div>
                              <span className={`inline-block px-1.5 py-0.2 rounded text-[10px] font-medium ${isSettled ? 'bg-green-100 text-green-700' : 'bg-gray-100 text-gray-500'}`}>
                                {isSettled ? 'Settled' : 'Partial'}
                              </span>
                            </div>
                          </td>
                        </tr>
                      );
                    })}
                    </tbody>
                  </table>
                </div>
              ) : (
                <div className="border rounded-lg p-4 text-center text-gray-500 text-sm">
                  <p>No unpaid invoices or sales orders found for this customer.</p>
                  {editMode && allocations.length > 0 && (
                    <p className="mt-2 text-xs">This voucher had allocations that are now fully paid or no longer available.</p>
                  )}
                </div>
              )}
              {(() => {
                const diff = Math.round((formData.amount - totalAllocated) * 100) / 100;
                const isResidualWithinTol = allocations.length > 0 && diff > 0 && diff <= roundingTolerance;
                const isResidualExceeding = allocations.length > 0 && diff > roundingTolerance;

                return (
                  <>
                    <div className="mt-3 flex flex-wrap justify-between items-center text-sm gap-2">
                      <div className="flex flex-wrap items-center gap-2 text-xs text-gray-600">
                        <span><strong className="text-gray-900">{allocations.length}</strong> allocation(s)</span>
                        {totalRoundOff > 0 && <span>Doc Round-off: <strong className="text-amber-700">{formatCurrency(totalRoundOff, formCurrency)}</strong></span>}
                        {totalDiscount > 0 && <span>Discount: <strong className="text-purple-700">{formatCurrency(totalDiscount, formCurrency)}</strong></span>}
                        {isResidualWithinTol && (
                          <span className="inline-flex items-center px-2 py-0.5 rounded text-xs bg-amber-50 border border-amber-300 text-amber-800 font-medium">
                            +{formatCurrency(diff, formCurrency)} Round-off Gain
                          </span>
                        )}
                        {isResidualExceeding && (
                          <span className="inline-flex items-center px-2 py-0.5 rounded text-xs bg-red-50 border border-red-300 text-red-700 font-medium">
                            Unallocated {formatCurrency(diff, formCurrency)} exceeds tolerance ({formatCurrency(roundingTolerance, formCurrency)})
                          </span>
                        )}
                      </div>
                      <div className="text-right">
                        <span className="text-gray-500 text-xs">Total Allocated:</span>
                        <span className={`ml-2 font-bold text-base ${totalAllocated > formData.amount ? 'text-red-600' : (isResidualWithinTol || totalAllocated === formData.amount ? 'text-green-600' : 'text-gray-800')}`}>
                          {formatCurrency(totalAllocated, formCurrency)}
                        </span>
                        <span className="text-gray-400 ml-1 text-xs">/ {formatCurrency(formData.amount, formCurrency)}</span>
                      </div>
                    </div>
                    <div className="mt-2 flex flex-wrap items-center justify-between text-xs text-gray-500 gap-1">
                      <span>Rounding tolerance: Rp {roundingTolerance.toLocaleString('id-ID', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}</span>
                      {isResidualWithinTol && (
                        <span className="text-green-700 font-medium">
                          Residual difference within tolerance will be recorded as Rounding Gain.
                        </span>
                      )}
                    </div>
                  </>
                );
              })()}
            </div>
          )}

        </form>
      </FinanceModal>

      {!embeddedModalOnly && (
        <>
          {/* View Details Modal */}
          <Modal
            isOpen={viewModalOpen}
        onClose={() => { setViewModalOpen(false); setSelectedVoucher(null); setVoucherAllocations([]); }}
        title="Receipt Voucher Details"
        size="xl"
      >
        {selectedVoucher && (
          <div className="space-y-4">
            <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-x-5 gap-y-3">
              <div>
                <label className="block text-sm font-medium text-gray-500">Voucher Number</label>
                <p className="font-mono font-medium">{selectedVoucher.voucher_number}</p>
              </div>
              <div>
                <label className="block text-sm font-medium text-gray-500">Date</label>
                <p>{new Date(selectedVoucher.voucher_date).toLocaleDateString('id-ID')}</p>
              </div>
              <div>
                <label className="block text-sm font-medium text-gray-500">Customer</label>
                <p>{selectedVoucher.customers?.company_name}</p>
              </div>
              <div>
                <label className="block text-sm font-medium text-gray-500">Payment Method</label>
                <p className="capitalize">{selectedVoucher.payment_method.replace('_', ' ')}</p>
              </div>
              <div>
                <label className="block text-sm font-medium text-gray-500">Bank Account</label>
                <p>{selectedVoucher.bank_accounts?.alias || (selectedVoucher.bank_accounts ? `${selectedVoucher.bank_accounts.bank_name} - ${selectedVoucher.bank_accounts.account_name}` : '-')}</p>
              </div>
              <div>
                <label className="block text-sm font-medium text-gray-500">Reference</label>
                <p>{selectedVoucher.reference_number || '-'}</p>
              </div>
              <div>
                <label className="block text-sm font-medium text-gray-500">Amount</label>
                <p className="text-sm font-bold text-green-600">{formatCurrency(selectedVoucher.amount, voucherCurrency(selectedVoucher))}</p>
              </div>
              {selectedVoucher.description && (
                <div className="sm:col-span-2 lg:col-span-3">
                  <label className="block text-sm font-medium text-gray-500">Description</label>
                  <p className="text-gray-700">{selectedVoucher.description}</p>
                </div>
              )}
            </div>

            <div className="border-t pt-3">
              <h4 className="font-medium text-gray-700 mb-3">Allocations</h4>
              {voucherAllocations.length > 0 ? (
                <div className="border rounded-lg overflow-hidden">
                  <table className="w-full text-sm">
                    <thead className="bg-gray-50">
                      <tr>
                        <th className="px-3 py-2 text-left">Document</th>
                        <th className="px-3 py-2 text-center">Type</th>
                        <th className="px-3 py-2 text-right">Amount</th>
                      </tr>
                    </thead>
                    <tbody className="divide-y">
                      {voucherAllocations.map((alloc: any, idx) => {
                        const inv = Array.isArray(alloc.sales_invoices) ? alloc.sales_invoices[0] : alloc.sales_invoices;
                        const so = Array.isArray(alloc.sales_orders) ? alloc.sales_orders[0] : alloc.sales_orders;
                        const adj = receiptAdjustments.find(a => a.sales_invoice_id === alloc.sales_invoice_id);
                        return (
                        <tr key={idx}>
                          <td className="px-3 py-2 font-mono text-xs">
                            <div>{inv ? inv.invoice_number : so?.so_number}</div>
                            <div className="mt-0.5 text-[10px] text-gray-400">{inv?.invoice_date || so?.so_date || '—'}</div>
                          </td>
                          <td className="px-3 py-2 text-center">
                            <span className={`px-2 py-0.5 rounded text-xs font-medium ${
                              alloc.sales_order_id
                                ? 'bg-purple-100 text-purple-700'
                                : 'bg-blue-100 text-blue-700'
                            }`}>
                              {alloc.sales_order_id ? 'SO (Advance)' : 'Invoice'}
                            </span>
                          </td>
                          <td className="px-3 py-2 text-right font-medium">
                            <div>{formatCurrency(alloc.allocated_amount, voucherCurrency(selectedVoucher))}</div>
                            {adj && Number(adj.adjustment_amount) > 0 && (
                              <div className="text-[10px] text-amber-700">
                                + {formatCurrency(adj.adjustment_amount, voucherCurrency(selectedVoucher))} ({adj.adjustment_type || 'rounding'})
                              </div>
                            )}
                          </td>
                        </tr>
                        );
                      })}
                    </tbody>
                  </table>
                </div>
              ) : (
                <p className="text-gray-500 text-sm">No allocations</p>
              )}
            </div>

            <div className="grid grid-cols-1 md:grid-cols-2 border-t border-gray-100">
              <div className="py-3 md:pr-4 md:border-r border-gray-100">
                <h4 className="text-[11px] font-semibold text-gray-500 uppercase tracking-wide mb-2">Bank Reconciliation</h4>
                {receiptBankLines.length ? receiptBankLines.map(line => {
                  const bank = line.bank_accounts;
                  const amount = Number(line.allocation_amount || line.credit_amount || line.debit_amount || 0);
                  return <div key={line.id} className="rounded border border-gray-200 bg-white px-2 py-1.5 text-xs space-y-1">
                    <div className="flex items-center justify-between">
                      <span className="inline-flex items-center gap-1 text-green-700"><CheckCircle className="w-3 h-3" /> Reconciled</span>
                      <div className="flex items-center gap-2">
                        <span className="font-mono font-semibold">{formatCurrency(amount, bank?.currency || voucherCurrency(selectedVoucher))}</span>
                        {canManage && (
                          <button
                            type="button"
                            onClick={() => handleUnlinkReceiptBankLine(line)}
                            disabled={receiptBankLinkLoading}
                            className="text-red-600 hover:text-red-800 text-[11px] underline ml-1"
                            title="Unlink this bank transaction"
                          >
                            Unlink
                          </button>
                        )}
                      </div>
                    </div>
                    <div className="text-gray-600">{new Date(line.transaction_date).toLocaleDateString('id-ID')} · {bank?.alias || (bank ? `${bank.bank_name} - ${bank.account_name}` : 'Bank')}</div>
                    <div className="text-gray-800 break-words">{line.description || '—'}</div>
                    {line.reference && <div className="font-mono text-gray-500">Ref: {line.reference}</div>}
                  </div>;
                }) : <div className="flex items-center gap-1.5 rounded border border-gray-200 bg-gray-50 px-2 py-1.5 text-xs text-gray-500"><Link2 className="w-3.5 h-3.5" /> Not linked to a bank transaction</div>}
                {!receiptBankLines.length && selectedVoucher.is_posted && canManage && (
                  <div className="mt-2 space-y-2">
                    <button type="button" onClick={loadReceiptBankCandidates} disabled={receiptBankCandidatesLoading}
                      className="inline-flex items-center gap-1.5 rounded border border-blue-300 px-2.5 py-1.5 text-xs font-medium text-blue-700 hover:bg-blue-50 disabled:opacity-50">
                      <Link2 className="w-3.5 h-3.5" /> {receiptBankCandidatesLoading ? 'Loading bank transactions…' : 'Link Bank Statement'}
                    </button>
                    {availableReceiptBankLines.length > 0 && (
                      <div className="rounded border border-gray-200 bg-white p-2 space-y-2">
                        <label className="block text-[11px] font-semibold text-gray-600">Select unmatched transaction from this bank account</label>
                        <select value={selectedReceiptBankLineId} onChange={e => setSelectedReceiptBankLineId(e.target.value)}
                          className="w-full rounded border border-gray-300 bg-white px-2 py-2 text-xs">
                          <option value="">Choose bank transaction…</option>
                          {availableReceiptBankLines.map((line: any) => {
                            const bank = line.bank_accounts;
                            const amount = Number(line.remainingAmount ?? (line.credit_amount || 0));
                            return <option key={line.id} value={line.id}>
                              {line.transaction_date} · {formatCurrency(amount, bank?.currency || voucherCurrency(selectedVoucher))} · {line.reference || line.description || line.id}
                            </option>;
                          })}
                        </select>
                        {selectedReceiptBankLineId && (() => {
                          const line = availableReceiptBankLines.find((item: any) => item.id === selectedReceiptBankLineId);
                          const amount = Number(line?.remainingAmount ?? (line?.credit_amount || 0));
                          const matches = Math.abs(amount - Number(selectedVoucher.amount)) <= 0.01;
                          return (
                            <>
                              <p className={`text-[11px] ${matches ? 'text-green-700' : 'text-amber-700'}`}>
                                {matches ? 'Amount matches this receipt.' : `Amount differs from receipt (${formatCurrency(Number(selectedVoucher.amount), voucherCurrency(selectedVoucher))}); linking is disabled until the correct transaction is selected.`}
                              </p>
                              <button type="button" onClick={handleLinkReceiptToBankLine}
                                disabled={receiptBankLinkLoading || !matches}
                                className="inline-flex items-center gap-1.5 rounded bg-blue-600 px-3 py-1.5 text-xs font-medium text-white hover:bg-blue-700 disabled:opacity-50">
                                <Link2 className="w-3.5 h-3.5" /> {receiptBankLinkLoading ? 'Linking…' : 'Link Selected Transaction'}
                              </button>
                            </>
                          );
                        })()}
                      </div>
                    )}
                  </div>
                )}
              </div>
              <div className="py-3 md:pl-4">
                <h4 className="text-[11px] font-semibold text-gray-500 uppercase tracking-wide mb-2">Related Records</h4>
                <div className="flex flex-wrap gap-1.5">
                  <span className="inline-flex items-center gap-1 rounded border border-gray-200 bg-white px-2 py-1 text-[11px]"><FileText className="w-3 h-3 text-gray-500" /> {selectedVoucher.voucher_number}</span>
                  {voucherAllocations.map((alloc, index) => <span key={index} className="inline-flex items-center gap-1 rounded border border-gray-200 bg-white px-2 py-1 text-[11px]"><Link2 className="w-3 h-3 text-gray-500" /> {alloc.sales_invoices?.invoice_number || alloc.sales_orders?.so_number}</span>)}
                  {!voucherAllocations.length && <span className="text-xs text-gray-500">No allocated invoice or sales order</span>}
                </div>
              </div>
            </div>

            <div className="border-t border-gray-100 py-3">
              <h4 className="text-[11px] font-semibold text-gray-500 uppercase tracking-wide mb-2 flex items-center gap-1"><Banknote className="w-3.5 h-3.5" /> Accounting Impact</h4>
              {receiptJournalLines.length ? <div className="overflow-x-auto border rounded"><table className="w-full text-xs"><thead className="bg-gray-50"><tr><th className="px-2 py-1.5 text-left">COA</th><th className="px-2 py-1.5 text-left">Description</th><th className="px-2 py-1.5 text-right">Debit</th><th className="px-2 py-1.5 text-right">Credit</th></tr></thead><tbody className="divide-y">{receiptJournalLines.map(line => <tr key={line.line_number}><td className="px-2 py-1.5 font-mono">{line.chart_of_accounts?.code || '—'} · {line.chart_of_accounts?.name || ''}</td><td className="px-2 py-1.5">{line.description || '—'}</td><td className="px-2 py-1.5 text-right font-mono">{Number(line.debit || 0) ? formatCurrency(line.debit, voucherCurrency(selectedVoucher)) : '—'}</td><td className="px-2 py-1.5 text-right font-mono">{Number(line.credit || 0) ? formatCurrency(line.credit, voucherCurrency(selectedVoucher)) : '—'}</td></tr>)}</tbody></table></div> : <div className="text-xs text-gray-500">No posted journal entry.</div>}
            </div>

            <div className="flex items-center justify-between pt-4 border-t border-gray-100">
              <div className="flex items-center gap-2">
                {selectedVoucher.is_posted ? (
                  <span className="flex items-center gap-1 px-2 py-1 bg-green-100 text-green-700 rounded text-xs font-medium">
                    <Lock className="w-3 h-3" /> Posted
                  </span>
                ) : (
                  <span className="px-2 py-1 bg-yellow-100 text-yellow-700 rounded text-xs font-medium">Draft</span>
                )}
                {selectedVoucher.is_posted && isAdmin && (
                  <button
                    onClick={() => { setViewModalOpen(false); openCancelPostingModal(selectedVoucher); }}
                    className="flex items-center gap-1.5 px-2 py-1 text-xs font-medium border border-amber-300 text-amber-700 rounded hover:bg-amber-50"
                  >
                    <RotateCcw className="w-3 h-3" /> Cancel Posting
                  </button>
                )}
                {!selectedVoucher.is_posted && canManage && (
                  <button
                    onClick={() => { setViewModalOpen(false); handlePostVoucher(selectedVoucher); }}
                    className="flex items-center gap-1.5 px-2 py-1 text-xs font-medium border border-green-300 text-green-700 rounded hover:bg-green-50"
                  >
                    <CheckCircle className="w-3 h-3" /> Post to GL
                  </button>
                )}
              </div>
              <div className="flex items-center gap-2">
                <button
                  onClick={handlePrint}
                  className="px-3 py-1.5 text-xs bg-blue-600 text-white rounded-lg hover:bg-blue-700 flex items-center gap-1.5"
                >
                  <Printer className="w-3.5 h-3.5" />
                  Print PDF
                </button>
                <button
                  onClick={() => { setViewModalOpen(false); setSelectedVoucher(null); setVoucherAllocations([]); }}
                  className="px-3 py-1.5 text-xs bg-gray-600 text-white rounded-lg hover:bg-gray-700"
                >
                  Close
                </button>
              </div>
            </div>
          </div>
        )}
      </Modal>

      {cancelPostingTarget && (
        <Modal
          isOpen={!!cancelPostingTarget}
          onClose={() => { setCancelPostingTarget(null); setCancelPostingReason(''); }}
          title={`Cancel GL Posting — ${cancelPostingTarget.voucher_number}`}
        >
          <div className="space-y-2">
            <div className="bg-amber-50 border border-amber-200 rounded-lg p-3 text-sm text-amber-800">
              This will delete the journal entry for this receipt voucher and reset it to Draft. The voucher will need to be re-posted after any edits.
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

      {/* Hidden Print Format */}
      {selectedVoucher && (
        <div ref={printRef} style={{ position: 'absolute', left: '-9999px', width: '210mm', padding: '15mm', backgroundColor: '#fff' }}>
          {/* Header */}
          <div style={{ textAlign: 'center', marginBottom: '20px', borderBottom: '2px solid #333', paddingBottom: '15px' }}>
            {/* selectedVoucher.company_snapshot is guaranteed non-null here — handlePrint refuses to run without it. */}
            <h1 style={{ fontSize: '24px', fontWeight: 'bold', margin: '0 0 5px 0', color: '#1a1a1a' }}>
              {selectedVoucher.company_snapshot?.company_name ?? '—'}
            </h1>
            {selectedVoucher.company_snapshot?.company_address && (
              <p style={{ fontSize: '11px', margin: '0', color: '#666' }}>{selectedVoucher.company_snapshot.company_address}</p>
            )}
            <h2 style={{ fontSize: '18px', fontWeight: 'bold', margin: '15px 0 0 0', color: '#2563eb' }}>
              RECEIPT VOUCHER
            </h2>
          </div>

          {/* Voucher Details */}
          <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '15px', marginBottom: '20px' }}>
            <div>
              <p style={{ fontSize: '11px', fontWeight: '600', color: '#666', margin: '0 0 3px 0' }}>Voucher No:</p>
              <p style={{ fontSize: '14px', fontWeight: 'bold', margin: '0', fontFamily: 'monospace' }}>
                {selectedVoucher.voucher_number}
              </p>
            </div>
            <div>
              <p style={{ fontSize: '11px', fontWeight: '600', color: '#666', margin: '0 0 3px 0' }}>Date:</p>
              <p style={{ fontSize: '14px', fontWeight: 'bold', margin: '0' }}>
                {new Date(selectedVoucher.voucher_date).toLocaleDateString('id-ID', {
                  day: '2-digit',
                  month: 'long',
                  year: 'numeric'
                })}
              </p>
            </div>
          </div>

          {/* Received From */}
          <div style={{ marginBottom: '20px', padding: '12px', backgroundColor: '#f3f4f6', borderRadius: '6px' }}>
            <p style={{ fontSize: '11px', fontWeight: '600', color: '#666', margin: '0 0 5px 0' }}>Received From:</p>
            <p style={{ fontSize: '15px', fontWeight: 'bold', margin: '0', color: '#1a1a1a' }}>
              {selectedVoucher.customers?.company_name}
            </p>
          </div>

          {/* Amount */}
          <div style={{ marginBottom: '20px', padding: '15px', backgroundColor: '#dbeafe', borderRadius: '8px', border: '2px solid #2563eb' }}>
            <p style={{ fontSize: '11px', fontWeight: '600', color: '#1e40af', margin: '0 0 5px 0' }}>Amount Received:</p>
            <p style={{ fontSize: '24px', fontWeight: 'bold', margin: '0', color: '#1e40af' }}>
              {formatCurrency(selectedVoucher.amount, voucherCurrency(selectedVoucher))}
            </p>
          </div>

          {/* Payment Details */}
          <div style={{ marginBottom: '20px' }}>
            <table style={{ width: '100%', fontSize: '12px', borderCollapse: 'collapse' }}>
              <tbody>
                <tr>
                  <td style={{ padding: '8px 0', fontWeight: '600', color: '#666', width: '35%' }}>Payment Method:</td>
                  <td style={{ padding: '8px 0', textTransform: 'capitalize' }}>
                    {selectedVoucher.payment_method.replace('_', ' ')}
                  </td>
                </tr>
                <tr>
                  <td style={{ padding: '8px 0', fontWeight: '600', color: '#666' }}>Bank Account:</td>
                  <td style={{ padding: '8px 0' }}>
                    {selectedVoucher.bank_accounts?.alias ||
                     (selectedVoucher.bank_accounts ?
                      `${selectedVoucher.bank_accounts.bank_name} - ${selectedVoucher.bank_accounts.account_name}` :
                      '-')}
                  </td>
                </tr>
                {selectedVoucher.reference_number && (
                  <tr>
                    <td style={{ padding: '8px 0', fontWeight: '600', color: '#666' }}>Reference:</td>
                    <td style={{ padding: '8px 0', fontFamily: 'monospace' }}>{selectedVoucher.reference_number}</td>
                  </tr>
                )}
              </tbody>
            </table>
          </div>

          {/* Allocations */}
          {voucherAllocations.length > 0 && (
            <div style={{ marginBottom: '20px' }}>
              <p style={{ fontSize: '13px', fontWeight: 'bold', margin: '0 0 10px 0', color: '#1a1a1a' }}>
                Allocation Details:
              </p>
              <table style={{ width: '100%', fontSize: '11px', borderCollapse: 'collapse', border: '1px solid #d1d5db' }}>
                <thead>
                  <tr style={{ backgroundColor: '#f3f4f6' }}>
                    <th style={{ padding: '8px', textAlign: 'left', borderBottom: '1px solid #d1d5db' }}>Document</th>
                    <th style={{ padding: '8px', textAlign: 'center', borderBottom: '1px solid #d1d5db' }}>Type</th>
                    <th style={{ padding: '8px', textAlign: 'right', borderBottom: '1px solid #d1d5db' }}>Amount</th>
                  </tr>
                </thead>
                <tbody>
                  {voucherAllocations.map((alloc, idx) => (
                    <tr key={idx}>
                      <td style={{ padding: '8px', borderBottom: idx < voucherAllocations.length - 1 ? '1px solid #e5e7eb' : 'none', fontFamily: 'monospace' }}>
                        {alloc.sales_invoices ? alloc.sales_invoices.invoice_number : alloc.sales_orders?.so_number}
                      </td>
                      <td style={{ padding: '8px', textAlign: 'center', borderBottom: idx < voucherAllocations.length - 1 ? '1px solid #e5e7eb' : 'none' }}>
                        {alloc.sales_order_id ? 'SO (Advance)' : 'Invoice'}
                      </td>
                      <td style={{ padding: '8px', textAlign: 'right', borderBottom: idx < voucherAllocations.length - 1 ? '1px solid #e5e7eb' : 'none', fontWeight: '600' }}>
                        {formatCurrency(alloc.allocated_amount, voucherCurrency(selectedVoucher))}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}

          {/* Description */}
          {selectedVoucher.description && (
            <div style={{ marginBottom: '20px' }}>
              <p style={{ fontSize: '11px', fontWeight: '600', color: '#666', margin: '0 0 5px 0' }}>Description:</p>
              <p style={{ fontSize: '12px', margin: '0', color: '#1a1a1a' }}>{selectedVoucher.description}</p>
            </div>
          )}

          {/* Signature Section */}
          <div style={{ marginTop: '40px', display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '40px' }}>
            <div style={{ textAlign: 'center' }}>
              <div style={{ height: '60px' }}></div>
              <div style={{ borderTop: '1px solid #333', paddingTop: '5px' }}>
                <p style={{ fontSize: '11px', fontWeight: '600', margin: '0' }}>Received By</p>
              </div>
            </div>
            <div style={{ textAlign: 'center' }}>
              <div style={{ height: '60px' }}></div>
              <div style={{ borderTop: '1px solid #333', paddingTop: '5px' }}>
                <p style={{ fontSize: '11px', fontWeight: '600', margin: '0' }}>Approved By</p>
              </div>
            </div>
          </div>

          {/* Footer */}
          <div style={{ marginTop: '30px', textAlign: 'center', paddingTop: '15px', borderTop: '1px solid #e5e7eb' }}>
            <p style={{ fontSize: '10px', color: '#999', margin: '0' }}>
              This is a computer-generated document. No signature required.
            </p>
          </div>
        </div>
      )}
        </>
      )}
    </div>
  );
}
