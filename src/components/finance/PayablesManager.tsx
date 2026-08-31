import { useEffect, useState } from 'react';
import { supabase } from '../../lib/supabase';
import { useAuth } from '../../contexts/AuthContext';
import { DataTable } from '../DataTable';
import { FinanceModal as Modal } from './FinanceModal';
import { MoneyInput } from '../MoneyInput';
import { Plus, Pencil as Edit, Trash2, FileText, DollarSign, Calendar, AlertCircle } from 'lucide-react';
import { formatDate } from '../../utils/dateFormat';
import { useExpenseCategories } from './useExpenseCategories';
import { useFinance } from '../../contexts/FinanceContext';
import { useSupabaseRealtimeChannel } from '../../hooks/useSupabaseRealtimeChannel';
import * as XLSX from 'xlsx';

interface VendorBill {
  id: string;
  bill_number: string;
  vendor_name: string;
  vendor_id: string | null;
  bill_date: string;
  due_date: string | null;
  amount: number;
  tax_amount: number;
  total_amount: number;
  payment_status: 'pending' | 'partial' | 'paid';
  category: 'inventory' | 'expense' | 'asset' | 'other' | null;
  description: string | null;
  created_at: string;
}

interface VendorPayment {
  id: string;
  payment_number: string;
  bill_id: string;
  payment_date: string;
  amount: number;
  payment_method: string;
  bank_account_id: string | null;
  reference_number: string | null;
  notes: string | null;
  vendor_bills?: {
    bill_number: string;
    vendor_name: string;
  };
  bank_accounts?: {
    account_name: string;
    bank_name: string;
    alias: string | null;
  } | null;
}

interface BankAccount {
  id: string;
  account_name: string;
  bank_name: string;
  alias: string | null;
  currency: string;
}

// Outstanding expense bill from get_outstanding_expense_bills() RPC
interface OutstandingExpenseBill {
  id: string;
  supplier_id: string | null;
  supplier_name: string | null;
  staff_id: string | null;
  staff_name: string | null;
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

interface OutstandingPurchaseInvoice {
  id: string;
  invoice_number: string;
  invoice_date: string;
  due_date: string | null;
  total_amount: number;
  paid_amount: number;
  balance_amount: number;
  currency: string;
  suppliers?: { company_name: string } | null;
}

interface OutstandingPurchaseInvoiceRpcRow extends OutstandingPurchaseInvoice {
  supplier_name?: string | null;
}

interface PayablesManagerProps {
  canManage: boolean;
}

type ViewMode = 'bills' | 'payments' | 'expense_bills';

export function PayablesManager({ canManage }: PayablesManagerProps) {
  const { profile } = useAuth();
  const { dateRange } = useFinance();
  const { categories: expenseCategories } = useExpenseCategories();
  const [viewMode, setViewMode] = useState<ViewMode>('expense_bills');
  const [bills, setBills] = useState<VendorBill[]>([]);
  const [payments, setPayments] = useState<VendorPayment[]>([]);
  const [bankAccounts, setBankAccounts] = useState<BankAccount[]>([]);
  const [outstandingExpenseBills, setOutstandingExpenseBills] = useState<OutstandingExpenseBill[]>([]);
  const [outstandingPurchaseInvoices, setOutstandingPurchaseInvoices] = useState<OutstandingPurchaseInvoice[]>([]);
  const [loading, setLoading] = useState(true);
  const [billModalOpen, setBillModalOpen] = useState(false);
  const [paymentModalOpen, setPaymentModalOpen] = useState(false);
  const [editingBill, setEditingBill] = useState<VendorBill | null>(null);
  const [editingPayment, setEditingPayment] = useState<VendorPayment | null>(null);
  const [billFormData, setBillFormData] = useState({
    bill_number: '',
    vendor_name: '',
    vendor_id: '',
    bill_date: new Date().toISOString().split('T')[0],
    due_date: '',
    amount: 0,
    tax_amount: 0,
    category: 'expense' as VendorBill['category'],
    description: '',
  });
  const [paymentFormData, setPaymentFormData] = useState({
    bill_id: '',
    payment_date: new Date().toISOString().split('T')[0],
    amount: 0,
    payment_method: 'bank_transfer',
    bank_account_id: '',
    reference_number: '',
    notes: '',
  });

  useEffect(() => {
    loadData();
  }, [dateRange.startDate, dateRange.endDate]);

  const loadData = async () => {
    setLoading(true);
    await Promise.all([loadBills(), loadPayments(), loadBankAccounts(), loadOutstandingExpenseBills(), loadOutstandingPurchaseInvoices()]);
    setLoading(false);
  };

  const loadOutstandingExpenseBills = async () => {
    try {
      const { data, error } = await supabase.rpc('get_outstanding_expense_bills', { p_as_of_date: dateRange.endDate });
      if (error) throw error;
      setOutstandingExpenseBills(data || []);
    } catch (error) {
      console.error('Error loading outstanding expense bills:', error);
    }
  };

  const loadOutstandingPurchaseInvoices = async () => {
    try {
      const { data, error } = await supabase.rpc('get_outstanding_purchase_invoices', { p_as_of_date: dateRange.endDate });
      if (error) throw error;
      setOutstandingPurchaseInvoices(((data || []) as OutstandingPurchaseInvoiceRpcRow[]).map((invoice: OutstandingPurchaseInvoiceRpcRow) => ({
        ...invoice,
        suppliers: invoice.supplier_name ? { company_name: invoice.supplier_name } : null,
      })) as OutstandingPurchaseInvoice[]);
    } catch (error) {
      console.error('Error loading outstanding purchase invoices:', error);
    }
  };

  const loadBills = async () => {
    try {
      const { data, error } = await supabase
        .from('vendor_bills')
        .select('*')
        .gte('bill_date', dateRange.startDate)
        .lte('bill_date', dateRange.endDate)
        .order('bill_date', { ascending: false });

      if (error) throw error;
      setBills(data || []);
    } catch (error) {
      console.error('Error loading bills:', error);
    }
  };

  const loadPayments = async () => {
    try {
      const { data, error } = await supabase
        .from('vendor_payments')
        .select(`
          *,
          vendor_bills (
            bill_number,
            vendor_name
          ),
          bank_accounts (
            account_name,
            bank_name,
            alias
          )
        `)
        .gte('payment_date', dateRange.startDate)
        .lte('payment_date', dateRange.endDate)
        .order('payment_date', { ascending: false });

      if (error) throw error;
      setPayments(data || []);
    } catch (error) {
      console.error('Error loading payments:', error);
    }
  };

  const loadBankAccounts = async () => {
    try {
      const { data, error } = await supabase
        .from('bank_accounts')
        .select('id, account_name, bank_name, alias, currency')
        .eq('is_active', true)
        .order('account_name');

      if (error) throw error;
      setBankAccounts(data || []);
    } catch (error) {
      console.error('Error loading bank accounts:', error);
    }
  };

  useSupabaseRealtimeChannel({
    channelName: 'payables-expenses',
    table: 'finance_expenses',
    onEvent: () => { void loadOutstandingExpenseBills(); },
  });
  useSupabaseRealtimeChannel({
    channelName: 'payables-voucher-allocations',
    table: 'voucher_allocations',
    onEvent: () => { void loadOutstandingExpenseBills(); },
  });
  useSupabaseRealtimeChannel({
    channelName: 'payables-bank-allocations',
    table: 'bank_statement_allocations',
    onEvent: () => { void loadOutstandingExpenseBills(); },
  });
  useSupabaseRealtimeChannel({
    channelName: 'payables-bank-lines',
    table: 'bank_statement_lines',
    onEvent: () => { void loadOutstandingExpenseBills(); },
  });
  useSupabaseRealtimeChannel({
    channelName: 'payables-purchase-invoices',
    table: 'purchase_invoices',
    onEvent: () => { void loadOutstandingPurchaseInvoices(); },
  });
  useSupabaseRealtimeChannel({
    channelName: 'payables-purchase-payment-allocations',
    table: 'voucher_allocations',
    onEvent: () => {
      void loadOutstandingExpenseBills();
      void loadOutstandingPurchaseInvoices();
    },
  });
  useSupabaseRealtimeChannel({
    channelName: 'payables-purchase-payments',
    table: 'payment_vouchers',
    onEvent: () => {
      void loadOutstandingExpenseBills();
      void loadOutstandingPurchaseInvoices();
    },
  });

  const generateBillNumber = async () => {
    const prefix = 'BILL';
    const year = new Date().getFullYear();

    const { data } = await supabase
      .from('vendor_bills')
      .select('bill_number')
      .like('bill_number', `${prefix}-${year}%`)
      .order('created_at', { ascending: false })
      .limit(1)
      .maybeSingle();

    if (data?.bill_number) {
      const lastNumber = parseInt(data.bill_number.split('-')[2]);
      return `${prefix}-${year}-${String(lastNumber + 1).padStart(5, '0')}`;
    }

    return `${prefix}-${year}-00001`;
  };

  const generatePaymentNumber = async () => {
    const prefix = 'VPAY';
    const year = new Date().getFullYear();

    const { data } = await supabase
      .from('vendor_payments')
      .select('payment_number')
      .like('payment_number', `${prefix}-${year}%`)
      .order('created_at', { ascending: false })
      .limit(1)
      .maybeSingle();

    if (data?.payment_number) {
      const lastNumber = parseInt(data.payment_number.split('-')[2]);
      return `${prefix}-${year}-${String(lastNumber + 1).padStart(5, '0')}`;
    }

    return `${prefix}-${year}-00001`;
  };

  const handleBillSubmit = async (e: React.FormEvent) => {
    e.preventDefault();

    try {
      const { data: { user } } = await supabase.auth.getUser();
      if (!user) throw new Error('Not authenticated');

      const totalAmount = billFormData.amount + billFormData.tax_amount;

      if (editingBill) {
        const { error } = await supabase
          .from('vendor_bills')
          .update({
            vendor_name: billFormData.vendor_name,
            vendor_id: billFormData.vendor_id || null,
            bill_date: billFormData.bill_date,
            due_date: billFormData.due_date || null,
            amount: billFormData.amount,
            tax_amount: billFormData.tax_amount,
            total_amount: totalAmount,
            category: billFormData.category,
            description: billFormData.description || null,
          })
          .eq('id', editingBill.id);

        if (error) throw error;
      } else {
        const billNumber = await generateBillNumber();

        const { error } = await supabase
          .from('vendor_bills')
          .insert([{
            bill_number: billNumber,
            vendor_name: billFormData.vendor_name,
            vendor_id: billFormData.vendor_id || null,
            bill_date: billFormData.bill_date,
            due_date: billFormData.due_date || null,
            amount: billFormData.amount,
            tax_amount: billFormData.tax_amount,
            total_amount: totalAmount,
            category: billFormData.category,
            description: billFormData.description || null,
            created_by: user.id,
          }]);

        if (error) throw error;
      }

      setBillModalOpen(false);
      resetBillForm();
      loadBills();
    } catch (error) {
      console.error('Error saving bill:', error);
      alert('Failed to save bill. Please try again.');
    }
  };

  const handlePaymentSubmit = async (e: React.FormEvent) => {
    e.preventDefault();

    try {
      const { data: { user } } = await supabase.auth.getUser();
      if (!user) throw new Error('Not authenticated');

      if (editingPayment) {
        const { error } = await supabase
          .from('vendor_payments')
          .update({
            payment_date: paymentFormData.payment_date,
            amount: paymentFormData.amount,
            payment_method: paymentFormData.payment_method,
            bank_account_id: paymentFormData.bank_account_id || null,
            reference_number: paymentFormData.reference_number || null,
            notes: paymentFormData.notes || null,
          })
          .eq('id', editingPayment.id);

        if (error) throw error;
      } else {
        const paymentNumber = await generatePaymentNumber();

        const { error } = await supabase
          .from('vendor_payments')
          .insert([{
            payment_number: paymentNumber,
            bill_id: paymentFormData.bill_id,
            payment_date: paymentFormData.payment_date,
            amount: paymentFormData.amount,
            payment_method: paymentFormData.payment_method,
            bank_account_id: paymentFormData.bank_account_id || null,
            reference_number: paymentFormData.reference_number || null,
            notes: paymentFormData.notes || null,
            created_by: user.id,
          }]);

        if (error) throw error;
      }

      setPaymentModalOpen(false);
      resetPaymentForm();
      loadPayments();
      loadBills();
    } catch (error) {
      console.error('Error saving payment:', error);
      alert('Failed to save payment. Please try again.');
    }
  };

  const handleEditBill = (bill: VendorBill) => {
    setEditingBill(bill);
    setBillFormData({
      bill_number: bill.bill_number,
      vendor_name: bill.vendor_name,
      vendor_id: bill.vendor_id || '',
      bill_date: bill.bill_date,
      due_date: bill.due_date || '',
      amount: bill.amount,
      tax_amount: bill.tax_amount,
      category: bill.category,
      description: bill.description || '',
    });
    setBillModalOpen(true);
  };

  const handleEditPayment = (payment: VendorPayment) => {
    setEditingPayment(payment);
    setPaymentFormData({
      bill_id: payment.bill_id,
      payment_date: payment.payment_date,
      amount: payment.amount,
      payment_method: payment.payment_method,
      bank_account_id: payment.bank_account_id || '',
      reference_number: payment.reference_number || '',
      notes: payment.notes || '',
    });
    setPaymentModalOpen(true);
  };

  const handleDeleteBill = async (id: string) => {
    if (!confirm('Are you sure you want to delete this bill?')) return;

    try {
      const { error } = await supabase
        .from('vendor_bills')
        .delete()
        .eq('id', id);

      if (error) throw error;
      loadBills();
    } catch (error) {
      console.error('Error deleting bill:', error);
      alert('Failed to delete bill. Please try again.');
    }
  };

  const handleDeletePayment = async (id: string) => {
    if (!confirm('Are you sure you want to delete this payment?')) return;

    try {
      const { error } = await supabase
        .from('vendor_payments')
        .delete()
        .eq('id', id);

      if (error) throw error;
      loadPayments();
      loadBills();
    } catch (error) {
      console.error('Error deleting payment:', error);
      alert('Failed to delete payment. Please try again.');
    }
  };

  const resetBillForm = () => {
    setEditingBill(null);
    setBillFormData({
      bill_number: '',
      vendor_name: '',
      vendor_id: '',
      bill_date: new Date().toISOString().split('T')[0],
      due_date: '',
      amount: 0,
      tax_amount: 0,
      category: 'expense',
      description: '',
    });
  };

  const resetPaymentForm = () => {
    setEditingPayment(null);
    setPaymentFormData({
      bill_id: '',
      payment_date: new Date().toISOString().split('T')[0],
      amount: 0,
      payment_method: 'bank_transfer',
      bank_account_id: '',
      reference_number: '',
      notes: '',
    });
  };

  const getPaymentStatusColor = (status: string) => {
    switch (status) {
      case 'paid':
        return 'bg-green-100 text-green-800';
      case 'partial':
        return 'bg-yellow-100 text-yellow-800';
      case 'pending':
        return 'bg-red-100 text-red-800';
      default:
        return 'bg-gray-100 text-gray-800';
    }
  };

  const getCategoryLabel = (category: string | null) => {
    const labels: Record<string, string> = {
      inventory: 'Inventory',
      expense: 'Expense',
      asset: 'Asset',
      other: 'Other',
    };
    return category ? labels[category] || category : 'N/A';
  };

  const getPaymentMethodLabel = (method: string) => {
    const labels: Record<string, string> = {
      cash: 'Cash',
      bank_transfer: 'Bank Transfer',
      cheque: 'Cheque',
      credit_card: 'Credit Card',
      other: 'Other',
    };
    return labels[method] || method;
  };

  const totalPayable = bills
    .filter(b => b.payment_status !== 'paid')
    .reduce((sum, b) => sum + b.total_amount, 0);

  const totalExpenseBillsPayable = outstandingExpenseBills.reduce((sum, b) => sum + b.balance_amount, 0);
  const totalPurchaseInvoicesPayable = outstandingPurchaseInvoices.reduce((sum, invoice) => sum + invoice.balance_amount, 0);

  // The AP headline is the canonical as-of view: purchase invoices plus
  // expense bills. Legacy vendor_bills remain available separately and are
  // intentionally not mixed into this accounting answer.
  const totalCombinedPayable = totalExpenseBillsPayable + totalPurchaseInvoicesPayable;

  const exportPayables = () => {
    const rows = [
      ...outstandingPurchaseInvoices.map(i => ({
        Supplier: i.suppliers?.company_name || '', 'Invoice / Expense No.': i.invoice_number,
        'Document Type': 'Purchase Invoice', 'Invoice Date': i.invoice_date, 'Due Date': i.due_date || '',
        'Original Amount': Number(i.total_amount), 'Paid Amount': Number(i.paid_amount), 'Outstanding Balance': Number(i.balance_amount),
        Currency: i.currency || 'IDR', 'Payment Status': Number(i.balance_amount) > 0 && Number(i.paid_amount) > 0 ? 'Partial' : 'Unpaid',
        'Related Purchase Invoice': i.invoice_number, Reference: i.id,
      })),
      ...outstandingExpenseBills.map(e => ({
        Supplier: e.supplier_name || e.staff_name || '', 'Invoice / Expense No.': e.invoice_number || e.id,
        'Document Type': 'Supplier Expense', 'Invoice Date': e.invoice_date, 'Due Date': e.due_date || '',
        Category: categoryLabel(e.expense_category), Description: e.description || '', 'Original Amount': Number(e.amount),
        'Paid Amount': Number(e.paid_amount), 'Outstanding Balance': Number(e.balance_amount), Currency: 'IDR',
        'Payment Status': Number(e.paid_amount) > 0 ? 'Partial' : 'Unpaid', 'Days Overdue': Number(e.days_overdue || 0),
        Reference: e.id,
      })),
    ];
    const ws = XLSX.utils.json_to_sheet(rows);
    ws['!freeze'] = { xSplit: 0, ySplit: 1 };
    ws['!autofilter'] = { ref: ws['!ref'] || 'A1' };
    ws['!cols'] = Object.keys(rows[0] || {}).map(k => ({ wch: Math.min(32, Math.max(14, k.length + 2)) }));
    const wb = XLSX.utils.book_new(); XLSX.utils.book_append_sheet(wb, ws, 'Payables');
    XLSX.writeFile(wb, `Payables_${dateRange.startDate}_${dateRange.endDate}.xlsx`);
  };

  const overdueExpenseBills = outstandingExpenseBills.filter(b => b.days_overdue > 0);
  const overduePurchaseInvoices = outstandingPurchaseInvoices.filter(invoice => invoice.due_date && new Date(invoice.due_date) < new Date(`${dateRange.endDate}T00:00:00`));

  const categoryLabel = (cat: string) =>
    expenseCategories.find(category => category.value === cat)?.label
    || cat.replace(/_/g, ' ').replace(/\b\w/g, c => c.toUpperCase());

  const billColumns = [
    {
      key: 'bill_number',
      label: 'Bill Number',
      render: (bill: VendorBill) => (
        <span className="font-medium text-gray-900">{bill.bill_number}</span>
      )
    },
    {
      key: 'vendor_name',
      label: 'Vendor',
      render: (bill: VendorBill) => bill.vendor_name
    },
    {
      key: 'bill_date',
      label: 'Bill Date',
      render: (bill: VendorBill) => formatDate(bill.bill_date)
    },
    {
      key: 'due_date',
      label: 'Due Date',
      render: (bill: VendorBill) => {
        if (!bill.due_date) return 'N/A';
        const dueDate = new Date(bill.due_date);
        const isOverdue = dueDate < new Date() && bill.payment_status !== 'paid';
        return (
          <span className={isOverdue ? 'text-red-600 font-medium' : ''}>
            {formatDate(bill.due_date)}
            {isOverdue && <AlertCircle className="w-3 h-3 inline ml-1" />}
          </span>
        );
      }
    },
    {
      key: 'category',
      label: 'Category',
      render: (bill: VendorBill) => getCategoryLabel(bill.category)
    },
    {
      key: 'total_amount',
      label: 'Total Amount',
      render: (bill: VendorBill) => (
        <span className="font-semibold text-red-600">
          Rp {bill.total_amount.toLocaleString('id-ID', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}
        </span>
      )
    },
    {
      key: 'payment_status',
      label: 'Status',
      render: (bill: VendorBill) => (
        <span className={`inline-block px-2 py-1 rounded-full text-xs font-medium ${getPaymentStatusColor(bill.payment_status)}`}>
          {bill.payment_status.toUpperCase()}
        </span>
      )
    },
  ];

  const paymentColumns = [
    {
      key: 'payment_number',
      label: 'Payment Number',
      render: (payment: VendorPayment) => (
        <span className="font-medium text-gray-900">{payment.payment_number}</span>
      )
    },
    {
      key: 'bill',
      label: 'Bill Number',
      render: (payment: VendorPayment) => payment.vendor_bills?.bill_number || 'N/A'
    },
    {
      key: 'vendor',
      label: 'Vendor',
      render: (payment: VendorPayment) => payment.vendor_bills?.vendor_name || 'N/A'
    },
    {
      key: 'payment_date',
      label: 'Payment Date',
      render: (payment: VendorPayment) => formatDate(payment.payment_date)
    },
    {
      key: 'amount',
      label: 'Amount',
      render: (payment: VendorPayment) => (
        <span className="font-semibold text-green-600">
          Rp {payment.amount.toLocaleString('id-ID', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}
        </span>
      )
    },
    {
      key: 'payment_method',
      label: 'Method',
      render: (payment: VendorPayment) => getPaymentMethodLabel(payment.payment_method)
    },
    {
      key: 'bank_account',
      label: 'Bank Account',
      render: (payment: VendorPayment) =>
        payment.bank_accounts
          ? (payment.bank_accounts.alias || `${payment.bank_accounts.account_name} - ${payment.bank_accounts.bank_name}`)
          : 'N/A'
    },
  ];

  const unpaidBills = bills.filter(b => b.payment_status !== 'paid');

  return (
    <div className="space-y-2">
      {/* Compact KPI strip — one row */}
      <div className="grid grid-cols-2 md:grid-cols-4 gap-1.5">
        <div className="bg-gradient-to-br from-red-500 to-red-600 rounded px-2 py-1.5 text-white">
          <div className="flex items-center justify-between gap-1">
            <div>
              <p className="text-[9px] text-red-100 uppercase tracking-wide">AP Outstanding</p>
              <p className="text-sm font-bold font-mono">Rp {totalCombinedPayable.toLocaleString('id-ID', { maximumFractionDigits: 0 })}</p>
            </div>
            <DollarSign className="w-4 h-4 text-red-200 shrink-0" />
          </div>
        </div>
        <div className="bg-orange-50 border border-orange-200 rounded px-2 py-1.5">
          <div className="flex items-center justify-between gap-1">
            <div>
              <p className="text-[9px] text-orange-600 uppercase tracking-wide">Overdue</p>
              <p className="text-sm font-bold text-orange-700 font-mono">{overdueExpenseBills.length + overduePurchaseInvoices.length}</p>
            </div>
            <AlertCircle className="w-4 h-4 text-orange-400 shrink-0" />
          </div>
        </div>
        <div className="bg-purple-50 border border-purple-200 rounded px-2 py-1.5">
          <div className="flex items-center justify-between gap-1">
            <div>
              <p className="text-[9px] text-purple-600 uppercase tracking-wide">Expense Bills</p>
              <p className="text-sm font-bold text-purple-700 font-mono">Rp {totalExpenseBillsPayable.toLocaleString('id-ID', { maximumFractionDigits: 0 })}</p>
            </div>
            <FileText className="w-4 h-4 text-purple-400 shrink-0" />
          </div>
        </div>
        <div className="bg-blue-50 border border-blue-200 rounded px-2 py-1.5">
          <div className="flex items-center justify-between gap-1">
            <div>
              <p className="text-[9px] text-blue-600 uppercase tracking-wide">Legacy Bills</p>
              <p className="text-sm font-bold text-blue-700 font-mono">Rp {totalPayable.toLocaleString('id-ID', { maximumFractionDigits: 0 })}</p>
            </div>
            <FileText className="w-4 h-4 text-blue-400 shrink-0" />
          </div>
        </div>
      </div>

      {/* Compact tab strip */}
      <div className="flex items-center justify-between gap-2 flex-wrap">
        <div className="flex gap-0.5">
          <button
            onClick={() => setViewMode('expense_bills')}
            className={`inline-flex items-center gap-1 h-7 px-2 rounded text-[11px] font-medium transition-colors ${
              viewMode === 'expense_bills' ? 'bg-purple-600 text-white' : 'bg-gray-100 text-gray-700 hover:bg-gray-200'
            }`}
          >
            <FileText className="w-3 h-3" />
            Outstanding (AP)
            {(outstandingExpenseBills.length + outstandingPurchaseInvoices.length) > 0 && (
              <span className={`ml-1 px-1 py-0 rounded text-[10px] font-semibold ${viewMode === 'expense_bills' ? 'bg-purple-800 text-purple-50' : 'bg-purple-200 text-purple-800'}`}>
                {outstandingExpenseBills.length + outstandingPurchaseInvoices.length}
              </span>
            )}
          </button>
          <button
            onClick={() => setViewMode('bills')}
            className={`inline-flex items-center gap-1 h-7 px-2 rounded text-[11px] font-medium transition-colors ${
              viewMode === 'bills' ? 'bg-blue-600 text-white' : 'bg-gray-100 text-gray-700 hover:bg-gray-200'
            }`}
          >
            <FileText className="w-3 h-3" />
            Legacy Bills
          </button>
          <button
            onClick={() => setViewMode('payments')}
            className={`inline-flex items-center gap-1 h-7 px-2 rounded text-[11px] font-medium transition-colors ${
              viewMode === 'payments' ? 'bg-blue-600 text-white' : 'bg-gray-100 text-gray-700 hover:bg-gray-200'
            }`}
          >
            <DollarSign className="w-3 h-3" />
            Payments
          </button>
        </div>

        {canManage && (
          <div className="flex gap-1">
            <button onClick={exportPayables} disabled={totalCombinedPayable <= 0} className="inline-flex items-center gap-1 h-7 px-2 bg-emerald-600 text-white rounded text-[11px] font-semibold hover:bg-emerald-700 disabled:opacity-50">Export Excel</button>
            {viewMode === 'bills' && (
              <button
                onClick={() => { resetBillForm(); setBillModalOpen(true); }}
                className="inline-flex items-center gap-1 h-7 px-2 bg-blue-600 text-white rounded text-[11px] font-semibold hover:bg-blue-700"
              >
                <Plus className="w-3 h-3" /> Add Bill
              </button>
            )}
            {viewMode === 'payments' && (
              <button
                onClick={() => { resetPaymentForm(); setPaymentModalOpen(true); }}
                className="inline-flex items-center gap-1 h-7 px-2 bg-green-600 text-white rounded text-[11px] font-semibold hover:bg-green-700"
              >
                <Plus className="w-3 h-3" /> Record Payment
              </button>
            )}
          </div>
        )}
      </div>

      {viewMode === 'expense_bills' ? (
        <div className="bg-white rounded-lg shadow-sm border border-gray-200 overflow-x-auto">
          {!loading && outstandingPurchaseInvoices.length > 0 && (
            <div className="border-b border-gray-200">
              <div className="px-3 py-2 bg-blue-50 text-xs font-semibold text-blue-800">
                Purchase Invoices outstanding as of {dateRange.endDate}
              </div>
              <table className="min-w-full text-sm">
                <thead className="bg-gray-50 border-b border-gray-200">
                  <tr>
                    <th className="px-1.5 py-1 text-left text-xs font-semibold text-gray-600">Supplier</th>
                    <th className="px-1.5 py-1 text-left text-xs font-semibold text-gray-600">Invoice #</th>
                    <th className="px-1.5 py-1 text-left text-xs font-semibold text-gray-600">Invoice Date</th>
                    <th className="px-1.5 py-1 text-left text-xs font-semibold text-gray-600">Due Date</th>
                    <th className="px-1.5 py-1 text-right text-xs font-semibold text-gray-600">Total</th>
                    <th className="px-1.5 py-1 text-right text-xs font-semibold text-gray-600">Paid</th>
                    <th className="px-1.5 py-1 text-right text-xs font-semibold text-gray-600">Balance</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-gray-100">
                  {outstandingPurchaseInvoices.map(invoice => (
                    <tr key={invoice.id} className="hover:bg-blue-50/40">
                      <td className="px-1.5 py-1 text-xs text-gray-900">{invoice.suppliers?.company_name || '—'}</td>
                      <td className="px-1.5 py-1 text-xs font-mono text-gray-700">{invoice.invoice_number}</td>
                      <td className="px-1.5 py-1 text-xs text-gray-700">{formatDate(invoice.invoice_date)}</td>
                      <td className="px-1.5 py-1 text-xs text-gray-700">{invoice.due_date ? formatDate(invoice.due_date) : '—'}</td>
                      <td className="px-1.5 py-1 text-right text-xs text-gray-700">{invoice.total_amount.toLocaleString('id-ID')}</td>
                      <td className="px-1.5 py-1 text-right text-xs text-green-700">{invoice.paid_amount.toLocaleString('id-ID')}</td>
                      <td className="px-1.5 py-1 text-right text-xs font-semibold text-red-600">{invoice.balance_amount.toLocaleString('id-ID')}</td>
                    </tr>
                  ))}
                </tbody>
                <tfoot className="bg-blue-50 border-t border-blue-200">
                  <tr><td colSpan={6} className="px-1.5 py-1 text-right text-xs font-bold">Purchase invoice balance:</td><td className="px-1.5 py-1 text-right text-xs font-bold text-red-700">{totalPurchaseInvoicesPayable.toLocaleString('id-ID')}</td></tr>
                </tfoot>
              </table>
            </div>
          )}
          {loading ? (
            <div className="px-6 py-8 text-center text-gray-500">Loading...</div>
          ) : outstandingExpenseBills.length === 0 && outstandingPurchaseInvoices.length === 0 ? (
            <div className="px-6 py-8 text-center text-gray-500">
              <FileText className="w-10 h-10 mx-auto text-gray-300 mb-3" />
              <p className="text-sm font-medium text-gray-600">No outstanding purchase invoices or expense bills</p>
              <p className="text-xs text-gray-500 mt-1">
                Expense bills recorded as "Outstanding (A/P)" in the Expense module will appear here.
              </p>
            </div>
          ) : (
            <table className="min-w-full text-sm">
              <thead className="bg-gray-50 border-b border-gray-200">
                <tr>
                  <th className="px-1.5 py-1 text-left text-xs font-semibold text-gray-600">Supplier</th>
                  <th className="px-1.5 py-1 text-left text-xs font-semibold text-gray-600">Invoice #</th>
                  <th className="px-1.5 py-1 text-left text-xs font-semibold text-gray-600">Category</th>
                  <th className="px-1.5 py-1 text-left text-xs font-semibold text-gray-600">Description</th>
                  <th className="px-1.5 py-1 text-left text-xs font-semibold text-gray-600">Invoice Date</th>
                  <th className="px-1.5 py-1 text-left text-xs font-semibold text-gray-600">Due Date</th>
                  <th className="px-1.5 py-1 text-right text-xs font-semibold text-gray-600">Amount</th>
                  <th className="px-1.5 py-1 text-right text-xs font-semibold text-gray-600">Paid</th>
                  <th className="px-1.5 py-1 text-right text-xs font-semibold text-gray-600">Balance</th>
                  <th className="px-1.5 py-1 text-center text-xs font-semibold text-gray-600">Aging</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-gray-100">
                {outstandingExpenseBills.map(bill => {
                  const isOverdue = bill.days_overdue > 0;
                  return (
                    <tr key={bill.id} className={`hover:bg-purple-50/40 ${isOverdue ? 'bg-red-50/30' : ''}`}>
                      <td className="px-1.5 py-1">
                        <span className="font-medium text-gray-900 text-xs">
                          {bill.supplier_name || bill.staff_name || <span className="text-gray-400 italic">Payee not recorded</span>}
                        </span>
                      </td>
                      <td className="px-1.5 py-1">
                        <span className="font-mono text-xs text-gray-600">
                          {bill.invoice_number || '—'}
                        </span>
                      </td>
                      <td className="px-1.5 py-1">
                        <span className="text-xs text-gray-700">{categoryLabel(bill.expense_category)}</span>
                      </td>
                      <td className="px-1.5 py-1">
                        <span className="text-xs text-gray-600 line-clamp-1">{bill.description || '—'}</span>
                      </td>
                      <td className="px-1.5 py-1 whitespace-nowrap">
                        <span className="text-xs text-gray-700">
                          {new Date(bill.invoice_date).toLocaleDateString('en-GB')}
                        </span>
                      </td>
                      <td className="px-1.5 py-1 whitespace-nowrap">
                        {bill.due_date ? (
                          <span className={`text-xs font-medium ${isOverdue ? 'text-red-600' : 'text-gray-700'}`}>
                            {new Date(bill.due_date).toLocaleDateString('en-GB')}
                            {isOverdue && <AlertCircle className="w-3 h-3 inline ml-1" />}
                          </span>
                        ) : (
                          <span className="text-xs text-gray-400">—</span>
                        )}
                      </td>
                      <td className="px-1.5 py-1 text-right whitespace-nowrap">
                        <span className="text-xs text-gray-700">Rp {bill.amount.toLocaleString('id-ID')}</span>
                      </td>
                      <td className="px-1.5 py-1 text-right whitespace-nowrap">
                        <span className="text-xs text-green-700">Rp {bill.paid_amount.toLocaleString('id-ID')}</span>
                      </td>
                      <td className="px-1.5 py-1 text-right whitespace-nowrap">
                        <span className="text-xs font-semibold text-red-600">Rp {bill.balance_amount.toLocaleString('id-ID')}</span>
                      </td>
                      <td className="px-1.5 py-1 text-center">
                        {isOverdue ? (
                          <span className="inline-flex items-center px-2 py-0.5 text-[10px] font-bold text-red-700 bg-red-100 border border-red-200 rounded">
                            {bill.days_overdue}d overdue
                          </span>
                        ) : bill.due_date ? (
                          <span className="inline-flex items-center px-2 py-0.5 text-[10px] font-medium text-green-700 bg-green-50 border border-green-200 rounded">
                            Current
                          </span>
                        ) : (
                          <span className="text-xs text-gray-400">No due date</span>
                        )}
                      </td>
                    </tr>
                  );
                })}
                {/* Totals row */}
                <tr className="bg-purple-50 border-t-2 border-purple-200 font-bold">
                  <td colSpan={6} className="px-1.5 py-1 text-right text-xs text-gray-700">
                    TOTAL ({outstandingExpenseBills.length} bills):
                  </td>
                  <td className="px-1.5 py-1 text-right text-xs text-gray-700">
                    Rp {outstandingExpenseBills.reduce((s, b) => s + b.amount, 0).toLocaleString('id-ID')}
                  </td>
                  <td className="px-1.5 py-1 text-right text-xs text-green-700">
                    Rp {outstandingExpenseBills.reduce((s, b) => s + b.paid_amount, 0).toLocaleString('id-ID')}
                  </td>
                  <td className="px-1.5 py-1 text-right text-sm text-red-700 font-bold">
                    Rp {totalExpenseBillsPayable.toLocaleString('id-ID')}
                  </td>
                  <td />
                </tr>
              </tbody>
            </table>
          )}
        </div>
      ) : viewMode === 'bills' ? (
        <DataTable
          columns={billColumns}
          data={bills}
          loading={loading}
          actions={canManage ? (bill) => (
            <div className="flex items-center gap-2">
              <button
                onClick={() => handleEditBill(bill)}
                className="p-1 text-blue-600 hover:bg-blue-50 rounded"
              >
                <Edit className="w-4 h-4" />
              </button>
              <button
                onClick={() => handleDeleteBill(bill.id)}
                className="p-1 text-red-600 hover:bg-red-50 rounded"
              >
                <Trash2 className="w-4 h-4" />
              </button>
            </div>
          ) : undefined}
        />
      ) : (
        <DataTable
          columns={paymentColumns}
          data={payments}
          loading={loading}
          actions={canManage ? (payment) => (
            <div className="flex items-center gap-2">
              <button
                onClick={() => handleEditPayment(payment)}
                className="p-1 text-blue-600 hover:bg-blue-50 rounded"
              >
                <Edit className="w-4 h-4" />
              </button>
              <button
                onClick={() => handleDeletePayment(payment.id)}
                className="p-1 text-red-600 hover:bg-red-50 rounded"
              >
                <Trash2 className="w-4 h-4" />
              </button>
            </div>
          ) : undefined}
        />
      )}

      <Modal
        isOpen={billModalOpen}
        onClose={() => {
          setBillModalOpen(false);
          resetBillForm();
        }}
        title={editingBill ? 'Edit Vendor Bill' : 'Add Vendor Bill'}
      >
        <form onSubmit={handleBillSubmit} className="space-y-4">
          <div className="grid grid-cols-2 gap-4">
            <div className="col-span-2">
              <label className="block text-sm font-medium text-gray-700 mb-1">
                Vendor Name *
              </label>
              <input
                type="text"
                value={billFormData.vendor_name}
                onChange={(e) => setBillFormData({ ...billFormData, vendor_name: e.target.value })}
                className="w-full px-3 py-2 border border-gray-300 rounded-lg focus:ring-2 focus:ring-blue-500"
                required
              />
            </div>

            <div>
              <label className="block text-sm font-medium text-gray-700 mb-1">
                Vendor ID (Optional)
              </label>
              <input
                type="text"
                value={billFormData.vendor_id}
                onChange={(e) => setBillFormData({ ...billFormData, vendor_id: e.target.value })}
                className="w-full px-3 py-2 border border-gray-300 rounded-lg focus:ring-2 focus:ring-blue-500"
              />
            </div>

            <div>
              <label className="block text-sm font-medium text-gray-700 mb-1">
                Category *
              </label>
              <select
                value={billFormData.category || ''}
                onChange={(e) => setBillFormData({ ...billFormData, category: e.target.value as VendorBill['category'] })}
                className="w-full px-3 py-2 border border-gray-300 rounded-lg focus:ring-2 focus:ring-blue-500"
                required
              >
                <option value="expense">Expense</option>
                <option value="inventory">Inventory</option>
                <option value="asset">Asset</option>
                <option value="other">Other</option>
              </select>
            </div>

            <div>
              <label className="block text-sm font-medium text-gray-700 mb-1">
                Bill Date *
              </label>
              <input
                type="date"
                value={billFormData.bill_date}
                onChange={(e) => setBillFormData({ ...billFormData, bill_date: e.target.value })}
                className="w-full px-3 py-2 border border-gray-300 rounded-lg focus:ring-2 focus:ring-blue-500"
                required
              />
            </div>

            <div>
              <label className="block text-sm font-medium text-gray-700 mb-1">
                Due Date
              </label>
              <input
                type="date"
                value={billFormData.due_date}
                onChange={(e) => setBillFormData({ ...billFormData, due_date: e.target.value })}
                className="w-full px-3 py-2 border border-gray-300 rounded-lg focus:ring-2 focus:ring-blue-500"
              />
            </div>

            <div>
              <label className="block text-sm font-medium text-gray-700 mb-1">
                Amount (Rp) *
              </label>
              <MoneyInput
                decimal
                value={billFormData.amount}
                onChange={(n) => setBillFormData({ ...billFormData, amount: n })}
                className="w-full px-3 py-2 border border-gray-300 rounded-lg focus:ring-2 focus:ring-blue-500"
                required
              />
            </div>

            <div>
              <label className="block text-sm font-medium text-gray-700 mb-1">
                Tax Amount (Rp)
              </label>
              <MoneyInput
                decimal
                value={billFormData.tax_amount}
                onChange={(n) => setBillFormData({ ...billFormData, tax_amount: n })}
                className="w-full px-3 py-2 border border-gray-300 rounded-lg focus:ring-2 focus:ring-blue-500"
              />
            </div>

            <div className="col-span-2">
              <label className="block text-sm font-medium text-gray-700 mb-1">
                Total Amount
              </label>
              <div className="text-2xl font-bold text-gray-900">
                Rp {(billFormData.amount + billFormData.tax_amount).toLocaleString('id-ID', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}
              </div>
            </div>

            <div className="col-span-2">
              <label className="block text-sm font-medium text-gray-700 mb-1">
                Description
              </label>
              <textarea
                value={billFormData.description}
                onChange={(e) => setBillFormData({ ...billFormData, description: e.target.value })}
                className="w-full px-3 py-2 border border-gray-300 rounded-lg focus:ring-2 focus:ring-blue-500"
                rows={3}
              />
            </div>
          </div>

          <div className="flex justify-end gap-3 pt-4">
            <button
              type="button"
              onClick={() => {
                setBillModalOpen(false);
                resetBillForm();
              }}
              className="px-4 py-2 border border-gray-300 rounded-lg hover:bg-gray-50 transition"
            >
              Cancel
            </button>
            <button
              type="submit"
              className="h-7 px-2 text-xs bg-blue-600 text-white rounded hover:bg-blue-700 transition"
            >
              {editingBill ? 'Update Bill' : 'Add Bill'}
            </button>
          </div>
        </form>
      </Modal>

      <Modal
        isOpen={paymentModalOpen}
        onClose={() => {
          setPaymentModalOpen(false);
          resetPaymentForm();
        }}
        title={editingPayment ? 'Edit Payment' : 'Record Payment'}
      >
        <form onSubmit={handlePaymentSubmit} className="space-y-4">
          <div className="grid grid-cols-2 gap-4">
            <div className="col-span-2">
              <label className="block text-sm font-medium text-gray-700 mb-1">
                Bill *
              </label>
              <select
                value={paymentFormData.bill_id}
                onChange={(e) => {
                  const billId = e.target.value;
                  const bill = unpaidBills.find(b => b.id === billId);
                  setPaymentFormData({
                    ...paymentFormData,
                    bill_id: billId,
                    amount: bill ? bill.total_amount : 0
                  });
                }}
                className="w-full px-3 py-2 border border-gray-300 rounded-lg focus:ring-2 focus:ring-blue-500"
                required
                disabled={!!editingPayment}
              >
                <option value="">Select a bill</option>
                {unpaidBills.map((bill) => (
                  <option key={bill.id} value={bill.id}>
                    {bill.bill_number} - {bill.vendor_name} (Rp {bill.total_amount.toLocaleString('id-ID', { minimumFractionDigits: 2, maximumFractionDigits: 2 })})
                  </option>
                ))}
              </select>
            </div>

            <div>
              <label className="block text-sm font-medium text-gray-700 mb-1">
                Payment Date *
              </label>
              <input
                type="date"
                value={paymentFormData.payment_date}
                onChange={(e) => setPaymentFormData({ ...paymentFormData, payment_date: e.target.value })}
                className="w-full px-3 py-2 border border-gray-300 rounded-lg focus:ring-2 focus:ring-blue-500"
                required
              />
            </div>

            <div>
              <label className="block text-sm font-medium text-gray-700 mb-1">
                Amount (Rp) *
              </label>
              <MoneyInput
                decimal
                value={paymentFormData.amount}
                onChange={(n) => setPaymentFormData({ ...paymentFormData, amount: n })}
                className="w-full px-3 py-2 border border-gray-300 rounded-lg focus:ring-2 focus:ring-blue-500"
                required
              />
            </div>

            <div>
              <label className="block text-sm font-medium text-gray-700 mb-1">
                Payment Method *
              </label>
              <select
                value={paymentFormData.payment_method}
                onChange={(e) => setPaymentFormData({ ...paymentFormData, payment_method: e.target.value })}
                className="w-full px-3 py-2 border border-gray-300 rounded-lg focus:ring-2 focus:ring-blue-500"
                required
              >
                <option value="bank_transfer">Bank Transfer</option>
                <option value="cash">Cash</option>
                <option value="cheque">Cheque</option>
                <option value="credit_card">Credit Card</option>
                <option value="other">Other</option>
              </select>
            </div>

            <div>
              <label className="block text-sm font-medium text-gray-700 mb-1">
                Bank Account
              </label>
              <select
                value={paymentFormData.bank_account_id}
                onChange={(e) => setPaymentFormData({ ...paymentFormData, bank_account_id: e.target.value })}
                className="w-full px-3 py-2 border border-gray-300 rounded-lg focus:ring-2 focus:ring-blue-500"
              >
                <option value="">Select bank account</option>
                {bankAccounts.map((account) => (
                  <option key={account.id} value={account.id}>
                    {account.alias || `${account.account_name} - ${account.bank_name}`} ({account.currency || 'IDR'})
                  </option>
                ))}
              </select>
            </div>

            <div className="col-span-2">
              <label className="block text-sm font-medium text-gray-700 mb-1">
                Reference Number
              </label>
              <input
                type="text"
                value={paymentFormData.reference_number}
                onChange={(e) => setPaymentFormData({ ...paymentFormData, reference_number: e.target.value })}
                className="w-full px-3 py-2 border border-gray-300 rounded-lg focus:ring-2 focus:ring-blue-500"
                placeholder="Transaction/Check number"
              />
            </div>

            <div className="col-span-2">
              <label className="block text-sm font-medium text-gray-700 mb-1">
                Notes
              </label>
              <textarea
                value={paymentFormData.notes}
                onChange={(e) => setPaymentFormData({ ...paymentFormData, notes: e.target.value })}
                className="w-full px-3 py-2 border border-gray-300 rounded-lg focus:ring-2 focus:ring-blue-500"
                rows={3}
              />
            </div>
          </div>

          <div className="flex justify-end gap-3 pt-4">
            <button
              type="button"
              onClick={() => {
                setPaymentModalOpen(false);
                resetPaymentForm();
              }}
              className="px-4 py-2 border border-gray-300 rounded-lg hover:bg-gray-50 transition"
            >
              Cancel
            </button>
            <button
              type="submit"
              className="px-4 py-2 bg-green-600 text-white rounded-lg hover:bg-green-700 transition"
            >
              {editingPayment ? 'Update Payment' : 'Record Payment'}
            </button>
          </div>
        </form>
      </Modal>
    </div>
  );
}
