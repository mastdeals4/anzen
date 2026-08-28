import { useEffect, useState, useCallback, useMemo, useRef } from 'react';
import { supabase } from '../../lib/supabase';
import { DataTable } from '../DataTable';
import { FinanceModal as Modal } from './FinanceModal';
import { MoneyInput } from '../MoneyInput';
import { TrendingUp, RefreshCw, BarChart2 } from 'lucide-react';
import { useNavigation } from '../../contexts/NavigationContext';
import { formatDate } from '../../utils/dateFormat';
import { useSupabaseRealtimeChannel } from '../../hooks/useSupabaseRealtimeChannel';
import { useFinance } from '../../contexts/FinanceContext';
import * as XLSX from 'xlsx';

interface SalesInvoice {
  id: string;
  invoice_number: string;
  customer_id: string;
  invoice_date: string;
  due_date: string;
  total_amount: number;
  payment_status: 'pending' | 'partial' | 'paid';
  customers: { company_name: string } | null;
  paid_amount?: number;
}

interface ReceiptVoucher {
  id: string;
  voucher_number: string;
  voucher_date: string;
  amount: number;
  payment_method: string;
  reference_number: string | null;
  description: string | null;
  customers: { company_name: string } | null;
  bank_accounts: { account_name: string; alias: string | null } | null;
  allocations?: { allocated_amount: number; sales_invoices: { invoice_number: string } | null }[];
}

interface BankAccount {
  id: string;
  account_name: string;
  bank_name: string;
  alias: string | null;
}

const firstRelation = <T,>(value: T | T[] | null | undefined): T | null =>
  Array.isArray(value) ? value[0] ?? null : value ?? null;

export function ReceivablesManager({ canManage }: { canManage: boolean }) {
  const { setCurrentPage } = useNavigation();
  const { dateRange } = useFinance();
  const [view, setView] = useState<'invoices' | 'payments' | 'ageing'>('invoices');
  const [invoices, setInvoices] = useState<SalesInvoice[]>([]);
  const [payments, setPayments] = useState<ReceiptVoucher[]>([]);
  const [bankAccounts, setBankAccounts] = useState<BankAccount[]>([]);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [modalOpen, setModalOpen] = useState(false);
  const [selectedInvoice, setSelectedInvoice] = useState<SalesInvoice | null>(null);
  const [customerInvoices, setCustomerInvoices] = useState<SalesInvoice[]>([]);
  const [selectedAllocations, setSelectedAllocations] = useState<{[key: string]: number}>({});
  const [formData, setFormData] = useState({
    payment_number: '',
    payment_date: new Date().toISOString().split('T')[0],
    amount: 0,
    payment_method: 'bank_transfer' as 'cash' | 'bank_transfer' | 'cheque' | 'credit_card' | 'other',
    bank_account_id: '',
    reference_number: '',
    notes: '',
  });

  const loadData = useCallback(async () => {
    try {
      const [invoicesRes, paymentsRes, banksRes] = await Promise.all([
        supabase
          .from('sales_invoices')
          // perf: projected columns (was select('*'))
          .select('id, invoice_number, customer_id, invoice_date, due_date, total_amount, payment_status, customers(company_name)')
          .in('payment_status', ['pending', 'partial'])
          .lte('invoice_date', dateRange.endDate)
          .order('due_date', { ascending: true }),
        supabase
          .from('receipt_vouchers')
          // perf: projected columns (was select('*'))
          .select(`
            id,
            voucher_number,
            voucher_date,
            amount,
            payment_method,
            reference_number,
            description,
            customer_id,
            bank_account_id,
            customers(company_name),
            bank_accounts(account_name, alias)
          `)
          .gte('voucher_date', dateRange.startDate)
          .lte('voucher_date', dateRange.endDate)
          .order('voucher_date', { ascending: false })
          .limit(50),
        supabase
          .from('bank_accounts')
          .select('id, account_name, bank_name, alias')
          .eq('is_active', true)
          .order('account_name'),
      ]);

      if (invoicesRes.error) {
        console.error('Error loading invoices:', invoicesRes.error);
        throw invoicesRes.error;
      }
      if (paymentsRes.error) {
        console.error('Error loading payments:', paymentsRes.error);
        throw paymentsRes.error;
      }
      if (banksRes.error) {
        console.error('Error loading banks:', banksRes.error);
        throw banksRes.error;
      }

      // Bulk fetch allocations for both invoices and vouchers, then aggregate client-side.
      const invoiceIds = (invoicesRes.data || []).map((inv) => inv.id);
      const voucherIds = (paymentsRes.data || []).map((v) => v.id);

      const paidByInvoice = new Map<string, number>();
      if (invoiceIds.length > 0) {
        const { data: invAllocs, error: invAllocErr } = await supabase
          .from('voucher_allocations')
          .select('sales_invoice_id, allocated_amount')
          .in('sales_invoice_id', invoiceIds)
          .eq('voucher_type', 'receipt');
        if (invAllocErr) {
          console.error('Error loading invoice allocations:', invAllocErr);
        }
        for (const a of invAllocs || []) {
          paidByInvoice.set(
            a.sales_invoice_id,
            (paidByInvoice.get(a.sales_invoice_id) || 0) + (Number(a.allocated_amount) || 0),
          );
        }
      }

      const allocationsByVoucher = new Map<string, { allocated_amount: number; sales_invoices: { invoice_number: string } | null }[]>();
      if (voucherIds.length > 0) {
        const { data: vAllocs, error: vAllocErr } = await supabase
          .from('voucher_allocations')
          .select('receipt_voucher_id, allocated_amount, sales_invoices(invoice_number)')
          .in('receipt_voucher_id', voucherIds)
          .eq('voucher_type', 'receipt');
        if (vAllocErr) {
          console.error('Error loading voucher allocations:', vAllocErr);
        }
        for (const a of (vAllocs || []) as any[]) {
          const list = allocationsByVoucher.get(a.receipt_voucher_id) || [];
          list.push({
            allocated_amount: a.allocated_amount,
            sales_invoices: a.sales_invoices || null,
          });
          allocationsByVoucher.set(a.receipt_voucher_id, list);
        }
      }

      const invoicesWithPaidAmount = (invoicesRes.data || []).map((invoice) => ({
        ...invoice,
        paid_amount: paidByInvoice.get(invoice.id) || 0,
        customers: firstRelation(invoice.customers),
      }));

      const paymentsWithAllocations = (paymentsRes.data || []).map((voucher) => ({
        ...voucher,
        allocations: allocationsByVoucher.get(voucher.id) || [],
        customers: firstRelation(voucher.customers),
        bank_accounts: firstRelation(voucher.bank_accounts),
      }));

      setInvoices(invoicesWithPaidAmount);
      setPayments(paymentsWithAllocations);
      setBankAccounts(banksRes.data || []);
    } catch (error) {
      console.error('Error loading data:', error);
    } finally {
      setLoading(false);
      setRefreshing(false);
    }
  }, [dateRange.startDate, dateRange.endDate]);

  const loadDataRef = useRef(loadData);
  useEffect(() => {
    loadDataRef.current = loadData;
  }, [loadData]);

  useEffect(() => {
    loadDataRef.current();
  }, [loadData]);

  // Realtime subscriptions replace the 30s polling. Coalesce refreshes shared
  // across the three hooks below via a module-scoped scheduler ref.
  const receivablesScheduledRef = useRef(false);
  const scheduleReceivablesRefresh = () => {
    if (receivablesScheduledRef.current) return;
    receivablesScheduledRef.current = true;
    setTimeout(() => {
      receivablesScheduledRef.current = false;
      loadDataRef.current();
    }, 400);
  };

  useSupabaseRealtimeChannel({
    channelName: 'receivables_sales_invoices',
    table: 'sales_invoices',
    onEvent: scheduleReceivablesRefresh,
  });
  useSupabaseRealtimeChannel({
    channelName: 'receivables_voucher_allocations',
    table: 'voucher_allocations',
    onEvent: scheduleReceivablesRefresh,
  });
  useSupabaseRealtimeChannel({
    channelName: 'receivables_receipt_vouchers',
    table: 'receipt_vouchers',
    onEvent: scheduleReceivablesRefresh,
  });

  const handleRefresh = () => {
    setRefreshing(true);
    loadData();
  };

  const handleRecordPayment = async (invoice: SalesInvoice) => {
    setSelectedInvoice(invoice);
    const remainingAmount = invoice.total_amount - (invoice.paid_amount || 0);
    setFormData({
      ...formData,
      payment_number: `PAY-${Date.now()}`,
      amount: remainingAmount,
    });

    // Load all unpaid invoices for this customer
    try {
      const { data: custInvoices, error } = await supabase
        .from('sales_invoices')
        .select('*')
        .eq('customer_id', invoice.customer_id)
        .in('payment_status', ['pending', 'partial'])
        .order('invoice_date', { ascending: true });

      if (error) {
        console.error('Error loading customer invoices:', error);
        throw error;
      }

      // Calculate paid_amount for each invoice
      const invoicesWithPaidAmount = await Promise.all((custInvoices || []).map(async (inv) => {
        try {
          const { data: allocations, error: allocError } = await supabase
            .from('voucher_allocations')
            .select('allocated_amount')
            .eq('sales_invoice_id', inv.id)
            .eq('voucher_type', 'receipt');

          if (allocError) {
            console.error('Error loading allocations for invoice:', inv.id, allocError);
          }

          const paid_amount = allocations?.reduce((sum, alloc) => sum + (Number(alloc.allocated_amount) || 0), 0) || 0;
          return {
            ...inv,
            paid_amount,
            customers: inv.customers || null
          };
        } catch (err) {
          console.error('Error processing invoice:', inv.id, err);
          return {
            ...inv,
            paid_amount: 0,
            customers: inv.customers || null
          };
        }
      }));

      setCustomerInvoices(invoicesWithPaidAmount);

      // Pre-select the clicked invoice
      setSelectedAllocations({
        [invoice.id]: remainingAmount
      });
    } catch (error) {
      console.error('Error loading customer invoices:', error);
    }

    setModalOpen(true);
  };

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!selectedInvoice) return;

    // Validation
    const totalAllocated = Object.values(selectedAllocations).reduce((sum, amount) => sum + amount, 0);
    if (totalAllocated > formData.amount) {
      alert('Total allocated amount cannot exceed payment amount');
      return;
    }

    if (totalAllocated === 0) {
      alert('Please allocate the payment to at least one invoice');
      return;
    }

    try {
      const { data: { user } } = await supabase.auth.getUser();
      if (!user) throw new Error('Not authenticated');

      const { data: voucherNumber, error: numError } = await supabase.rpc('generate_voucher_number', { p_prefix: 'RV' });
      if (numError) throw numError;

      // 2. Insert receipt voucher
      const { data: voucher, error: voucherError } = await supabase
        .from('receipt_vouchers')
        .insert([{
          voucher_number: voucherNumber,
          voucher_date: formData.payment_date,
          customer_id: selectedInvoice.customer_id,
          payment_method: formData.payment_method,
          bank_account_id: formData.bank_account_id || null,
          reference_number: formData.reference_number || null,
          amount: formData.amount,
          description: formData.notes || null,
          created_by: user.id,
        }])
        .select()
        .single();

      if (voucherError) throw voucherError;

      // 3. Insert invoice payment allocations using voucher_allocations table
      for (const [invoiceId, amount] of Object.entries(selectedAllocations)) {
        if (amount <= 0) continue;

        // Create allocation in voucher_allocations table (this will trigger auto-update of invoice)
        await supabase.from('voucher_allocations').insert({
          voucher_type: 'receipt',
          receipt_voucher_id: voucher.id,
          sales_invoice_id: invoiceId,
          allocated_amount: amount,
        });

        // Note: Invoice payment status is automatically updated by database trigger
        // No need to manually update payment_status, paid_amount, or balance_amount
      }

      setModalOpen(false);
      setSelectedInvoice(null);
      setCustomerInvoices([]);
      setSelectedAllocations({});
      resetForm();
      loadData();
      alert(`Receipt voucher ${voucherNumber} created and allocated successfully!`);
    } catch (error: any) {
      console.error('Error recording payment:', error);
      alert(`Failed to record payment: ${error.message}`);
    }
  };

  const resetForm = () => {
    setFormData({
      payment_number: '',
      payment_date: new Date().toISOString().split('T')[0],
      amount: 0,
      payment_method: 'bank_transfer',
      bank_account_id: '',
      reference_number: '',
      notes: '',
    });
  };

  const ageingRows = useMemo(() => {
    const asOfDate = new Date(`${dateRange.endDate}T00:00:00`);

    return invoices.map((inv) => {
      const balance = inv.total_amount - (inv.paid_amount || 0);
      const due = new Date(inv.due_date);
      due.setHours(0, 0, 0, 0);
      const daysOverdue = Math.max(0, Math.floor((asOfDate.getTime() - due.getTime()) / 86400000));

      return {
        ...inv,
        balance,
        daysOverdue,
        bucket0_30:  daysOverdue <= 30  ? balance : 0,
        bucket31_60: daysOverdue >= 31 && daysOverdue <= 60 ? balance : 0,
        bucket61_90: daysOverdue >= 61 && daysOverdue <= 90 ? balance : 0,
        bucket90plus: daysOverdue > 90 ? balance : 0,
      };
    }).sort((a, b) => b.daysOverdue - a.daysOverdue);
  }, [invoices, dateRange.endDate]);

  const ageingTotals = useMemo(() => ageingRows.reduce(
    (acc, r) => ({
      balance:      acc.balance      + r.balance,
      bucket0_30:   acc.bucket0_30   + r.bucket0_30,
      bucket31_60:  acc.bucket31_60  + r.bucket31_60,
      bucket61_90:  acc.bucket61_90  + r.bucket61_90,
      bucket90plus: acc.bucket90plus + r.bucket90plus,
    }),
    { balance: 0, bucket0_30: 0, bucket31_60: 0, bucket61_90: 0, bucket90plus: 0 }
  ), [ageingRows]);

  const exportReceivables = () => {
    const rows = ageingRows.map(r => ({
      Customer: r.customers?.company_name || '', 'Invoice No.': r.invoice_number,
      'Invoice Date': r.invoice_date, 'Due Date': r.due_date, 'Invoice Amount': Number(r.total_amount),
      'Paid Amount': Number(r.paid_amount || 0), 'Outstanding Balance': Number(r.balance), Currency: 'IDR',
      'Payment Status': Number(r.balance) <= 0 ? 'Paid' : Number(r.paid_amount || 0) > 0 ? 'Partial' : 'Unpaid',
      'Days Overdue': Number(r.daysOverdue), 'Ageing Bucket': r.daysOverdue <= 30 ? '0–30 Days' : r.daysOverdue <= 60 ? '31–60 Days' : r.daysOverdue <= 90 ? '61–90 Days' : '>90 Days',
    }));
    const ws = XLSX.utils.json_to_sheet(rows);
    ws['!freeze'] = { xSplit: 0, ySplit: 1 }; ws['!autofilter'] = { ref: ws['!ref'] || 'A1' };
    ws['!cols'] = Object.keys(rows[0] || {}).map(k => ({ wch: Math.min(32, Math.max(14, k.length + 2)) }));
    const wb = XLSX.utils.book_new(); XLSX.utils.book_append_sheet(wb, ws, 'Receivables');
    XLSX.writeFile(wb, `Receivables_${dateRange.startDate}_${dateRange.endDate}.xlsx`);
  };

  const invoiceColumns = [
    {
      key: 'invoice_number',
      label: 'Invoice #',
      render: (_val: any, inv: SalesInvoice) => (
        <button
          onClick={() => setCurrentPage('sales')}
          className="text-blue-600 hover:underline font-medium"
        >
          {inv.invoice_number}
        </button>
      )
    },
    {
      key: 'customer',
      label: 'Customer',
      render: (_val: any, inv: SalesInvoice) => inv.customers?.company_name || 'N/A'
    },
    {
      key: 'invoice_date',
      label: 'Date',
      render: (_val: any, inv: SalesInvoice) => formatDate(inv.invoice_date)
    },
    {
      key: 'due_date',
      label: 'Due Date',
      render: (_val: any, inv: SalesInvoice) => {
        const dueDate = new Date(`${inv.due_date}T00:00:00`);
        const asOfDate = new Date(`${dateRange.endDate}T00:00:00`);
        const isOverdue = dueDate < asOfDate && inv.payment_status !== 'paid';
        return (
          <span className={isOverdue ? 'text-red-600 font-semibold' : ''}>
            {formatDate(inv.due_date)}
          </span>
        );
      }
    },
    {
      key: 'total_amount',
      label: 'Amount',
      render: (_val: any, inv: SalesInvoice) => `Rp ${inv.total_amount.toLocaleString('id-ID', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`
    },
    {
      key: 'paid',
      label: 'Paid',
      render: (_val: any, inv: SalesInvoice) => (
        <span className="text-green-600">
          Rp {(inv.paid_amount || 0).toLocaleString('id-ID', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}
        </span>
      )
    },
    {
      key: 'balance',
      label: 'Balance',
      render: (_val: any, inv: SalesInvoice) => (
        <span className="font-semibold text-red-600">
          Rp {(inv.total_amount - (inv.paid_amount || 0)).toLocaleString('id-ID', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}
        </span>
      )
    },
    {
      key: 'status',
      label: 'Status',
      render: (_val: any, inv: SalesInvoice) => (
        <span className={`inline-block px-2 py-1 rounded-full text-xs font-medium ${
          inv.payment_status === 'partial' ? 'bg-yellow-100 text-yellow-800' : 'bg-red-100 text-red-800'
        }`}>
          {inv.payment_status}
        </span>
      )
    },
  ];

  const paymentColumns = [
    {
      key: 'voucher_number',
      label: 'Voucher #',
      render: (_val: any, pay: ReceiptVoucher) => pay.voucher_number
    },
    {
      key: 'voucher_date',
      label: 'Date',
      render: (_val: any, pay: ReceiptVoucher) => formatDate(pay.voucher_date)
    },
    {
      key: 'customer',
      label: 'Customer',
      render: (_val: any, pay: ReceiptVoucher) => pay.customers?.company_name || 'N/A'
    },
    {
      key: 'invoices',
      label: 'Invoices',
      render: (_val: any, pay: ReceiptVoucher) => {
        if (!pay.allocations || pay.allocations.length === 0) return 'Unallocated';
        return pay.allocations.map(a => a.sales_invoices?.invoice_number || 'N/A').join(', ');
      }
    },
    {
      key: 'amount',
      label: 'Amount',
      render: (_val: any, pay: ReceiptVoucher) => (
        <span className="font-semibold text-green-600">
          Rp {pay.amount.toLocaleString('id-ID', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}
        </span>
      )
    },
    {
      key: 'method',
      label: 'Method',
      render: (_val: any, pay: ReceiptVoucher) => (
        <span className="capitalize">{pay.payment_method.replace('_', ' ')}</span>
      )
    },
    {
      key: 'bank',
      label: 'Bank Account',
      render: (_val: any, pay: ReceiptVoucher) => {
        if (pay.bank_accounts) {
          return pay.bank_accounts.alias || pay.bank_accounts.account_name;
        }
        return 'Cash';
      }
    },
  ];

  return (
    <div className="space-y-2">
      <div className="flex justify-between items-center">
        <div className="flex gap-2">
          <button
            onClick={() => setView('invoices')}
            className={`h-7 px-2 rounded font-medium transition ${
              view === 'invoices'
                ? 'bg-blue-600 text-white'
                : 'bg-gray-100 text-gray-700 hover:bg-gray-200'
            }`}
          >
            Outstanding Invoices ({invoices.length})
          </button>
          <button
            onClick={() => setView('payments')}
            className={`h-7 px-2 rounded font-medium transition ${
              view === 'payments'
                ? 'bg-blue-600 text-white'
                : 'bg-gray-100 text-gray-700 hover:bg-gray-200'
            }`}
          >
            Payment History
          </button>
          <button
            onClick={() => setView('ageing')}
            className={`h-7 px-2 rounded font-medium transition flex items-center gap-1.5 ${
              view === 'ageing'
                ? 'bg-blue-600 text-white'
                : 'bg-gray-100 text-gray-700 hover:bg-gray-200'
            }`}
          >
            <BarChart2 className="w-4 h-4" />
            AR Ageing
          </button>
        </div>
        <button
          onClick={handleRefresh}
          disabled={refreshing}
          className="flex items-center gap-2 px-3 py-2 text-gray-600 hover:bg-gray-100 rounded-lg transition"
          title="Refresh data"
        >
          <RefreshCw className={`w-4 h-4 ${refreshing ? 'animate-spin' : ''}`} />
          <span className="text-sm">Refresh</span>
        </button>
        <button onClick={exportReceivables} disabled={ageingRows.length === 0} className="inline-flex items-center gap-1 px-2.5 py-1.5 text-xs bg-emerald-600 text-white rounded hover:bg-emerald-700 disabled:opacity-50">Export Excel</button>
      </div>

      {/* Help Banner */}
      {view === 'invoices' && invoices.length > 0 && (
        <div className="bg-blue-50 border border-blue-200 rounded-lg p-4 flex items-start gap-3">
          <div className="bg-blue-100 rounded-full p-2">
            <TrendingUp className="w-5 h-5 text-blue-600" />
          </div>
          <div>
            <p className="font-medium text-blue-900">Recording Customer Payments</p>
            <p className="text-sm text-blue-700 mt-1">
              Click the green <span className="font-semibold">"Record Payment"</span> button next to any invoice to record payment received from customers.
              The invoice status will automatically change from "pending" to "paid" once full payment is allocated.
            </p>
          </div>
        </div>
      )}

      {view === 'invoices' ? (
        <>
          {invoices.length === 0 && !loading ? (
            <div className="text-center py-12 text-gray-500">
              <TrendingUp className="w-16 h-16 mx-auto mb-4 text-gray-400" />
              <p className="text-lg font-medium">All Caught Up!</p>
              <p className="text-sm mt-2">No outstanding invoices - all payments received!</p>
            </div>
          ) : (
            <DataTable
              columns={invoiceColumns}
              data={invoices}
              loading={loading}
              actions={canManage ? (invoice) => (
                <button
                  onClick={() => handleRecordPayment(invoice)}
                  className="flex items-center gap-1.5 px-4 py-2 bg-green-600 text-white text-sm font-medium rounded-lg hover:bg-green-700 transition shadow-sm"
                >
                  <span className="text-lg">+</span>
                  Record Payment
                </button>
              ) : undefined}
            />
          )}
        </>
      ) : view === 'payments' ? (
        <DataTable
          columns={paymentColumns}
          data={payments}
          loading={loading}
        />
      ) : (
        /* AR Ageing Schedule */
        <div className="space-y-2">
          {/* Summary cards */}
          <div className="grid grid-cols-1 gap-2 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-5">
            {[
              { label: 'Total Outstanding', value: ageingTotals.balance, color: 'bg-gray-50 border-gray-200 text-gray-900' },
              { label: '0 – 30 Days', value: ageingTotals.bucket0_30, color: 'bg-green-50 border-green-200 text-green-800' },
              { label: '31 – 60 Days', value: ageingTotals.bucket31_60, color: 'bg-yellow-50 border-yellow-200 text-yellow-800' },
              { label: '61 – 90 Days', value: ageingTotals.bucket61_90, color: 'bg-orange-50 border-orange-200 text-orange-800' },
              { label: '> 90 Days', value: ageingTotals.bucket90plus, color: 'bg-red-50 border-red-200 text-red-800' },
            ].map(({ label, value, color }) => (
              <div key={label} className={`border rounded-lg p-3 ${color}`}>
                <div className="text-xs font-medium mb-1">{label}</div>
                <div className="text-sm font-bold">
                  Rp {value.toLocaleString('id-ID', { minimumFractionDigits: 0, maximumFractionDigits: 0 })}
                </div>
              </div>
            ))}
          </div>

          {/* Ageing detail table */}
          {ageingRows.length === 0 && !loading ? (
            <div className="text-center py-12 text-gray-500">
              <TrendingUp className="w-16 h-16 mx-auto mb-4 text-gray-400" />
              <p className="text-lg font-medium">No Outstanding Receivables</p>
            </div>
          ) : (
            <div className="overflow-x-auto rounded-lg border border-gray-200">
              <table className="w-full text-sm">
                <thead className="bg-gray-50 border-b border-gray-200">
                  <tr>
                    <th className="text-left px-3 py-2 font-medium text-gray-700">Customer</th>
                    <th className="text-left px-3 py-2 font-medium text-gray-700">Invoice #</th>
                    <th className="text-left px-3 py-2 font-medium text-gray-700">Invoice Date</th>
                    <th className="text-left px-3 py-2 font-medium text-gray-700">Due Date</th>
                    <th className="text-right px-3 py-2 font-medium text-gray-700">Days Overdue</th>
                    <th className="text-right px-3 py-2 font-medium text-green-700">0–30</th>
                    <th className="text-right px-3 py-2 font-medium text-yellow-700">31–60</th>
                    <th className="text-right px-3 py-2 font-medium text-orange-700">61–90</th>
                    <th className="text-right px-3 py-2 font-medium text-red-700">&gt;90</th>
                    <th className="text-right px-3 py-2 font-medium text-gray-700">Balance</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-gray-100">
                  {ageingRows.map((row) => (
                    <tr key={row.id} className="hover:bg-gray-50">
                      <td className="px-1.5 py-1">{row.customers?.company_name || 'N/A'}</td>
                      <td className="px-1.5 py-1 font-medium">{row.invoice_number}</td>
                      <td className="px-1.5 py-1 text-gray-600">{formatDate(row.invoice_date)}</td>
                      <td className="px-1.5 py-1 text-gray-600">{formatDate(row.due_date)}</td>
                      <td className={`px-3 py-2 text-right font-semibold ${
                        row.daysOverdue > 90 ? 'text-red-600' :
                        row.daysOverdue > 60 ? 'text-orange-600' :
                        row.daysOverdue > 30 ? 'text-yellow-600' : 'text-green-600'
                      }`}>
                        {row.daysOverdue === 0 ? 'Current' : `${row.daysOverdue}d`}
                      </td>
                      <td className="px-1.5 py-1 text-right text-green-700">
                        {row.bucket0_30 > 0 ? `Rp ${row.bucket0_30.toLocaleString('id-ID', { minimumFractionDigits: 0 })}` : '—'}
                      </td>
                      <td className="px-1.5 py-1 text-right text-yellow-700">
                        {row.bucket31_60 > 0 ? `Rp ${row.bucket31_60.toLocaleString('id-ID', { minimumFractionDigits: 0 })}` : '—'}
                      </td>
                      <td className="px-1.5 py-1 text-right text-orange-700">
                        {row.bucket61_90 > 0 ? `Rp ${row.bucket61_90.toLocaleString('id-ID', { minimumFractionDigits: 0 })}` : '—'}
                      </td>
                      <td className="px-1.5 py-1 text-right text-red-700 font-medium">
                        {row.bucket90plus > 0 ? `Rp ${row.bucket90plus.toLocaleString('id-ID', { minimumFractionDigits: 0 })}` : '—'}
                      </td>
                      <td className="px-1.5 py-1 text-right font-semibold text-gray-900">
                        Rp {row.balance.toLocaleString('id-ID', { minimumFractionDigits: 0 })}
                      </td>
                    </tr>
                  ))}
                </tbody>
                <tfoot className="bg-gray-50 border-t-2 border-gray-300 font-bold">
                  <tr>
                    <td colSpan={5} className="px-1.5 py-1 text-gray-700">Total</td>
                    <td className="px-1.5 py-1 text-right text-green-700">
                      Rp {ageingTotals.bucket0_30.toLocaleString('id-ID', { minimumFractionDigits: 0 })}
                    </td>
                    <td className="px-1.5 py-1 text-right text-yellow-700">
                      Rp {ageingTotals.bucket31_60.toLocaleString('id-ID', { minimumFractionDigits: 0 })}
                    </td>
                    <td className="px-1.5 py-1 text-right text-orange-700">
                      Rp {ageingTotals.bucket61_90.toLocaleString('id-ID', { minimumFractionDigits: 0 })}
                    </td>
                    <td className="px-1.5 py-1 text-right text-red-700">
                      Rp {ageingTotals.bucket90plus.toLocaleString('id-ID', { minimumFractionDigits: 0 })}
                    </td>
                    <td className="px-1.5 py-1 text-right text-gray-900">
                      Rp {ageingTotals.balance.toLocaleString('id-ID', { minimumFractionDigits: 0 })}
                    </td>
                  </tr>
                </tfoot>
              </table>
            </div>
          )}
        </div>
      )}

      <Modal
        isOpen={modalOpen}
        onClose={() => {
          setModalOpen(false);
          setSelectedInvoice(null);
          setCustomerInvoices([]);
          setSelectedAllocations({});
          resetForm();
        }}
        title="Record Customer Payment"
        size="lg"
      >
        <form onSubmit={handleSubmit} className="space-y-2">
          {selectedInvoice && (
            <div className="bg-blue-50 p-4 rounded-lg">
              <div className="text-sm">
                <div className="font-medium text-lg mb-2">{selectedInvoice.customers?.company_name}</div>
                <div className="text-gray-600">Recording payment for customer invoices</div>
              </div>
            </div>
          )}

          <div className="grid grid-cols-2 gap-4">
            <div>
              <label className="block text-sm font-medium text-gray-700 mb-1">Payment Number *</label>
              <input
                type="text"
                value={formData.payment_number}
                onChange={(e) => setFormData({ ...formData, payment_number: e.target.value })}
                className="w-full px-3 py-2 border border-gray-300 rounded-lg focus:ring-2 focus:ring-blue-500"
                required
              />
            </div>

            <div>
              <label className="block text-sm font-medium text-gray-700 mb-1">Payment Date *</label>
              <input
                type="date"
                value={formData.payment_date}
                onChange={(e) => setFormData({ ...formData, payment_date: e.target.value })}
                className="w-full px-3 py-2 border border-gray-300 rounded-lg focus:ring-2 focus:ring-blue-500"
                required
              />
            </div>

            <div>
              <label className="block text-sm font-medium text-gray-700 mb-1">Amount (Rp) *</label>
              <MoneyInput
                decimal
                value={formData.amount}
                onChange={(n) => setFormData({ ...formData, amount: n })}
                className="w-full px-3 py-2 border border-gray-300 rounded-lg focus:ring-2 focus:ring-blue-500"
                required
              />
            </div>

            <div>
              <label className="block text-sm font-medium text-gray-700 mb-1">Payment Method *</label>
              <select
                value={formData.payment_method}
                onChange={(e) => setFormData({ ...formData, payment_method: e.target.value as any })}
                className="w-full px-3 py-2 border border-gray-300 rounded-lg focus:ring-2 focus:ring-blue-500"
                required
              >
                <option value="cash">Cash</option>
                <option value="bank_transfer">Bank Transfer</option>
                <option value="cheque">Cheque</option>
                <option value="credit_card">Credit Card</option>
                <option value="other">Other</option>
              </select>
            </div>

            {formData.payment_method !== 'cash' && (
              <div>
                <label className="block text-sm font-medium text-gray-700 mb-1">Bank Account</label>
                <select
                  value={formData.bank_account_id}
                  onChange={(e) => setFormData({ ...formData, bank_account_id: e.target.value })}
                  className="w-full px-3 py-2 border border-gray-300 rounded-lg focus:ring-2 focus:ring-blue-500"
                >
                  <option value="">Select Bank Account</option>
                  {bankAccounts.map((bank) => (
                    <option key={bank.id} value={bank.id}>
                      {bank.alias || `${bank.account_name} - ${bank.bank_name}`}
                    </option>
                  ))}
                </select>
              </div>
            )}

            <div>
              <label className="block text-sm font-medium text-gray-700 mb-1">Reference Number</label>
              <input
                type="text"
                value={formData.reference_number}
                onChange={(e) => setFormData({ ...formData, reference_number: e.target.value })}
                className="w-full px-3 py-2 border border-gray-300 rounded-lg focus:ring-2 focus:ring-blue-500"
                placeholder="Bank reference or cheque number"
              />
            </div>

            <div className="col-span-2">
              <label className="block text-sm font-medium text-gray-700 mb-1">Notes</label>
              <textarea
                value={formData.notes}
                onChange={(e) => setFormData({ ...formData, notes: e.target.value })}
                className="w-full px-3 py-2 border border-gray-300 rounded-lg focus:ring-2 focus:ring-blue-500"
                rows={2}
              />
            </div>
          </div>

          {/* Invoice Allocation Section */}
          {customerInvoices.length > 0 && (
            <div className="border rounded-lg p-4 space-y-3 max-h-96 overflow-y-auto">
              <h3 className="font-medium text-gray-900">Allocate Payment to Invoices</h3>
              <p className="text-sm text-gray-600">Select invoices and enter amount to allocate to each</p>

              {customerInvoices.map((invoice) => {
                const balance = invoice.total_amount - (invoice.paid_amount || 0);
                const isSelected = selectedAllocations[invoice.id] !== undefined;
                const allocatedAmount = selectedAllocations[invoice.id] || 0;

                return (
                  <div key={invoice.id} className="border rounded p-3 space-y-2">
                    <div className="flex items-start justify-between">
                      <div className="flex items-start gap-3 flex-1">
                        <input
                          type="checkbox"
                          checked={isSelected}
                          onChange={(e) => {
                            if (e.target.checked) {
                              setSelectedAllocations(prev => ({
                                ...prev,
                                [invoice.id]: Math.min(balance, formData.amount - Object.values(selectedAllocations).reduce((a,b) => a+b, 0))
                              }));
                            } else {
                              const newAllocations = {...selectedAllocations};
                              delete newAllocations[invoice.id];
                              setSelectedAllocations(newAllocations);
                            }
                          }}
                          className="mt-1"
                        />
                        <div className="flex-1">
                          <div className="font-medium text-sm">{invoice.invoice_number}</div>
                          <div className="text-xs text-gray-600">Date: {formatDate(invoice.invoice_date)}</div>
                          <div className="text-xs mt-1">Total: Rp {invoice.total_amount.toLocaleString('id-ID', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}</div>
                          <div className="text-xs text-orange-600 font-medium">Balance: Rp {balance.toLocaleString('id-ID', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}</div>
                        </div>
                      </div>
                      {isSelected && (
                        <div className="ml-3 w-32">
                          <MoneyInput
                            decimal
                            min={0}
                            max={balance}
                            value={allocatedAmount || 0}
                            onChange={(n) => {
                              if (n > balance) {
                                alert('Cannot allocate more than balance');
                                return;
                              }
                              setSelectedAllocations(prev => ({
                                ...prev,
                                [invoice.id]: n
                              }));
                            }}
                            className="w-full px-2 py-1 border rounded text-sm"
                            placeholder="Amount"
                          />
                        </div>
                      )}
                    </div>
                  </div>
                );
              })}

              {/* Allocation Summary */}
              <div className="border-t pt-3 space-y-1">
                <div className="flex justify-between text-sm">
                  <span className="font-medium">Payment Amount:</span>
                  <span className="font-bold">Rp {formData.amount.toLocaleString('id-ID', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}</span>
                </div>
                <div className="flex justify-between text-sm">
                  <span>Allocated:</span>
                  <span className={Object.values(selectedAllocations).reduce((a,b) => a+b, 0) > formData.amount ? 'text-red-600 font-bold' : 'text-green-600'}>
                    Rp {Object.values(selectedAllocations).reduce((a,b) => a+b, 0).toLocaleString('id-ID', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}
                  </span>
                </div>
                <div className="flex justify-between text-sm">
                  <span>Unallocated:</span>
                  <span className="text-gray-600">
                    Rp {(formData.amount - Object.values(selectedAllocations).reduce((a,b) => a+b, 0)).toLocaleString('id-ID', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}
                  </span>
                </div>
              </div>
            </div>
          )}

          <div className="flex justify-end gap-3 pt-4">
            <button
              type="button"
              onClick={() => {
                setModalOpen(false);
                setSelectedInvoice(null);
                setCustomerInvoices([]);
                setSelectedAllocations({});
                resetForm();
              }}
              className="px-4 py-2 border border-gray-300 rounded-lg hover:bg-gray-50 transition"
            >
              Cancel
            </button>
            <button
              type="submit"
              className="h-7 px-2 text-xs bg-blue-600 text-white rounded hover:bg-blue-700 transition"
              disabled={Object.values(selectedAllocations).reduce((a,b) => a+b, 0) === 0}
            >
              Record Payment
            </button>
          </div>
        </form>
      </Modal>
    </div>
  );
}
