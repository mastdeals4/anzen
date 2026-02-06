import { useEffect, useState, useCallback } from 'react';
import { supabase } from '../../lib/supabase';
import { DataTable } from '../DataTable';
import { Modal } from '../Modal';
import { TrendingUp, RefreshCw } from 'lucide-react';
import { useNavigation } from '../../contexts/NavigationContext';

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

export function ReceivablesManager({ canManage }: { canManage: boolean }) {
  const { setCurrentPage } = useNavigation();
  const [view, setView] = useState<'invoices' | 'payments'>('invoices');
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
          .select('*, customers(company_name)')
          .in('payment_status', ['pending', 'partial'])
          .order('due_date', { ascending: true }),
        supabase
          .from('receipt_vouchers')
          .select(`
            *,
            customers(company_name),
            bank_accounts(account_name, alias)
          `)
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

      // Calculate paid_amount for each invoice
      const invoicesWithPaidAmount = await Promise.all((invoicesRes.data || []).map(async (invoice) => {
        try {
          const { data: allocations, error: allocError } = await supabase
            .from('voucher_allocations')
            .select('allocated_amount')
            .eq('sales_invoice_id', invoice.id)
            .eq('voucher_type', 'receipt');

          if (allocError) {
            console.error('Error loading allocations for invoice:', invoice.id, allocError);
          }

          const paid_amount = allocations?.reduce((sum, alloc) => sum + (Number(alloc.allocated_amount) || 0), 0) || 0;
          return {
            ...invoice,
            paid_amount,
            customers: invoice.customers || null
          };
        } catch (err) {
          console.error('Error processing invoice:', invoice.id, err);
          return {
            ...invoice,
            paid_amount: 0,
            customers: invoice.customers || null
          };
        }
      }));

      // Get allocations for each receipt voucher
      const paymentsWithAllocations = await Promise.all((paymentsRes.data || []).map(async (voucher) => {
        try {
          const { data: allocations, error: allocError } = await supabase
            .from('voucher_allocations')
            .select('allocated_amount, sales_invoices(invoice_number)')
            .eq('receipt_voucher_id', voucher.id)
            .eq('voucher_type', 'receipt');

          if (allocError) {
            console.error('Error loading allocations for voucher:', voucher.id, allocError);
          }

          return {
            ...voucher,
            allocations: allocations || [],
            customers: voucher.customers || null,
            bank_accounts: voucher.bank_accounts || null
          };
        } catch (err) {
          console.error('Error processing voucher:', voucher.id, err);
          return {
            ...voucher,
            allocations: [],
            customers: voucher.customers || null,
            bank_accounts: voucher.bank_accounts || null
          };
        }
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
  }, []);

  useEffect(() => {
    loadData();
    // Auto-refresh every 30 seconds
    const interval = setInterval(loadData, 30000);
    return () => clearInterval(interval);
  }, [loadData]);

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

      // 1. Generate voucher number
      const year = new Date().getFullYear().toString().slice(-2);
      const month = (new Date().getMonth() + 1).toString().padStart(2, '0');
      const { count } = await supabase
        .from('receipt_vouchers')
        .select('*', { count: 'exact', head: true })
        .like('voucher_number', `RV${year}${month}%`);

      const voucherNumber = `RV${year}${month}-${String((count || 0) + 1).padStart(4, '0')}`;

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

  const invoiceColumns = [
    {
      key: 'invoice_number',
      label: 'Invoice #',
      render: (inv: SalesInvoice) => (
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
      render: (inv: SalesInvoice) => inv.customers?.company_name || 'N/A'
    },
    {
      key: 'invoice_date',
      label: 'Date',
      render: (inv: SalesInvoice) => new Date(inv.invoice_date).toLocaleDateString()
    },
    {
      key: 'due_date',
      label: 'Due Date',
      render: (inv: SalesInvoice) => {
        const dueDate = new Date(inv.due_date);
        const today = new Date();
        const isOverdue = dueDate < today && inv.payment_status !== 'paid';
        return (
          <span className={isOverdue ? 'text-red-600 font-semibold' : ''}>
            {dueDate.toLocaleDateString()}
          </span>
        );
      }
    },
    {
      key: 'total_amount',
      label: 'Amount',
      render: (inv: SalesInvoice) => `Rp ${inv.total_amount.toLocaleString('id-ID', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`
    },
    {
      key: 'paid',
      label: 'Paid',
      render: (inv: SalesInvoice) => (
        <span className="text-green-600">
          Rp {(inv.paid_amount || 0).toLocaleString('id-ID', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}
        </span>
      )
    },
    {
      key: 'balance',
      label: 'Balance',
      render: (inv: SalesInvoice) => (
        <span className="font-semibold text-red-600">
          Rp {(inv.total_amount - (inv.paid_amount || 0)).toLocaleString('id-ID', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}
        </span>
      )
    },
    {
      key: 'status',
      label: 'Status',
      render: (inv: SalesInvoice) => (
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
      render: (pay: ReceiptVoucher) => pay.voucher_number
    },
    {
      key: 'voucher_date',
      label: 'Date',
      render: (pay: ReceiptVoucher) => new Date(pay.voucher_date).toLocaleDateString()
    },
    {
      key: 'customer',
      label: 'Customer',
      render: (pay: ReceiptVoucher) => pay.customers?.company_name || 'N/A'
    },
    {
      key: 'invoices',
      label: 'Invoices',
      render: (pay: ReceiptVoucher) => {
        if (!pay.allocations || pay.allocations.length === 0) return 'Unallocated';
        return pay.allocations.map(a => a.sales_invoices?.invoice_number || 'N/A').join(', ');
      }
    },
    {
      key: 'amount',
      label: 'Amount',
      render: (pay: ReceiptVoucher) => (
        <span className="font-semibold text-green-600">
          Rp {pay.amount.toLocaleString('id-ID', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}
        </span>
      )
    },
    {
      key: 'method',
      label: 'Method',
      render: (pay: ReceiptVoucher) => (
        <span className="capitalize">{pay.payment_method.replace('_', ' ')}</span>
      )
    },
    {
      key: 'bank',
      label: 'Bank Account',
      render: (pay: ReceiptVoucher) => {
        if (pay.bank_accounts) {
          return pay.bank_accounts.alias || pay.bank_accounts.account_name;
        }
        return 'Cash';
      }
    },
  ];

  return (
    <div className="space-y-6">
      <div className="flex justify-between items-center">
        <div className="flex gap-2">
          <button
            onClick={() => setView('invoices')}
            className={`px-4 py-2 rounded-lg font-medium transition ${
              view === 'invoices'
                ? 'bg-blue-600 text-white'
                : 'bg-gray-100 text-gray-700 hover:bg-gray-200'
            }`}
          >
            Outstanding Invoices ({invoices.length})
          </button>
          <button
            onClick={() => setView('payments')}
            className={`px-4 py-2 rounded-lg font-medium transition ${
              view === 'payments'
                ? 'bg-blue-600 text-white'
                : 'bg-gray-100 text-gray-700 hover:bg-gray-200'
            }`}
          >
            Payment History
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
      ) : (
        <DataTable
          columns={paymentColumns}
          data={payments}
          loading={loading}
        />
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
        <form onSubmit={handleSubmit} className="space-y-4">
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
              <input
                type="number"
                value={formData.amount === 0 ? '' : formData.amount}
                onChange={(e) => setFormData({ ...formData, amount: e.target.value === '' ? 0 : Number(e.target.value) })}
                className="w-full px-3 py-2 border border-gray-300 rounded-lg focus:ring-2 focus:ring-blue-500"
                required
                min="0"
                step="0.01"
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
                          <div className="text-xs text-gray-600">Date: {new Date(invoice.invoice_date).toLocaleDateString()}</div>
                          <div className="text-xs mt-1">Total: Rp {invoice.total_amount.toLocaleString('id-ID', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}</div>
                          <div className="text-xs text-orange-600 font-medium">Balance: Rp {balance.toLocaleString('id-ID', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}</div>
                        </div>
                      </div>
                      {isSelected && (
                        <div className="ml-3 w-32">
                          <input
                            type="number"
                            value={allocatedAmount || ''}
                            onChange={(e) => {
                              const value = parseFloat(e.target.value) || 0;
                              if (value > balance) {
                                alert('Cannot allocate more than balance');
                                return;
                              }
                              setSelectedAllocations(prev => ({
                                ...prev,
                                [invoice.id]: value
                              }));
                            }}
                            className="w-full px-2 py-1 border rounded text-sm"
                            placeholder="Amount"
                            min="0"
                            max={balance}
                            step="0.01"
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
              className="px-4 py-2 bg-blue-600 text-white rounded-lg hover:bg-blue-700 transition"
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
