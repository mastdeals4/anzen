import { useEffect, useState } from 'react';
import { supabase } from '../../lib/supabase';
import { DataTable } from '../DataTable';
import { Modal } from '../Modal';
import { TrendingUp, Plus } from 'lucide-react';
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

interface CustomerPayment {
  id: string;
  payment_number: string;
  payment_date: string;
  amount: number;
  payment_method: string;
  reference_number: string | null;
  notes: string | null;
  customers: { company_name: string } | null;
  sales_invoices: { invoice_number: string } | null;
  bank_accounts: { account_name: string } | null;
}

interface BankAccount {
  id: string;
  account_name: string;
  bank_name: string;
}

export function ReceivablesManager({ canManage }: { canManage: boolean }) {
  const { navigateTo } = useNavigation();
  const [view, setView] = useState<'invoices' | 'payments'>('invoices');
  const [invoices, setInvoices] = useState<SalesInvoice[]>([]);
  const [payments, setPayments] = useState<CustomerPayment[]>([]);
  const [bankAccounts, setBankAccounts] = useState<BankAccount[]>([]);
  const [loading, setLoading] = useState(true);
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

  useEffect(() => {
    loadData();
  }, [view]);

  const loadData = async () => {
    try {
      const [invoicesRes, paymentsRes, banksRes] = await Promise.all([
        supabase
          .from('sales_invoices')
          .select('*, customers(company_name)')
          .in('payment_status', ['pending', 'partial'])
          .order('due_date', { ascending: true }),
        supabase
          .from('customer_payments')
          .select('*, customers(company_name), sales_invoices(invoice_number), bank_accounts(account_name)')
          .order('payment_date', { ascending: false })
          .limit(50),
        supabase
          .from('bank_accounts')
          .select('id, account_name, bank_name')
          .eq('is_active', true)
          .order('account_name'),
      ]);

      if (invoicesRes.error) throw invoicesRes.error;
      if (paymentsRes.error) throw paymentsRes.error;
      if (banksRes.error) throw banksRes.error;

      const invoicesWithPaid = await Promise.all((invoicesRes.data || []).map(async (inv) => {
        const { data: paidData } = await supabase
          .rpc('get_invoice_paid_amount', { p_invoice_id: inv.id });
        const paidAmount = paidData || 0;
        return { ...inv, paid_amount: paidAmount };
      }));

      setInvoices(invoicesWithPaid);
      setPayments(paymentsRes.data || []);
      setBankAccounts(banksRes.data || []);
    } catch (error) {
      console.error('Error loading data:', error);
    } finally {
      setLoading(false);
    }
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

      if (error) throw error;

      // Calculate paid amounts
      const invoicesWithBalance = await Promise.all((custInvoices || []).map(async (inv) => {
        const { data: paidData } = await supabase
          .rpc('get_invoice_paid_amount', { p_invoice_id: inv.id });
        const paidAmount = paidData || 0;
        return { ...inv, paid_amount: paidAmount };
      }));

      setCustomerInvoices(invoicesWithBalance);

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

      // 1. Insert payment record
      const { data: payment, error: paymentError } = await supabase
        .from('customer_payments')
        .insert([{
          payment_number: formData.payment_number,
          customer_id: selectedInvoice.customer_id,
          invoice_id: null,
          payment_date: formData.payment_date,
          amount: formData.amount,
          payment_method: formData.payment_method,
          bank_account_id: formData.bank_account_id || null,
          reference_number: formData.reference_number || null,
          notes: formData.notes || null,
          created_by: user.id,
        }])
        .select()
        .single();

      if (paymentError) throw paymentError;

      // 2. Insert allocation records
      const allocations = Object.entries(selectedAllocations)
        .filter(([_, amount]) => amount > 0)
        .map(([invoiceId, amount]) => ({
          invoice_id: invoiceId,
          payment_id: payment.id,
          allocated_amount: amount,
          created_by: user.id,
        }));

      const { error: allocError } = await supabase
        .from('invoice_payment_allocations')
        .insert(allocations);

      if (allocError) throw allocError;

      setModalOpen(false);
      setSelectedInvoice(null);
      setCustomerInvoices([]);
      setSelectedAllocations({});
      resetForm();
      loadData();
      alert('Payment recorded and allocated successfully!');
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
          onClick={() => navigateTo('sales')}
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
      render: (inv: SalesInvoice) => `Rp ${inv.total_amount.toLocaleString('id-ID')}`
    },
    {
      key: 'paid',
      label: 'Paid',
      render: (inv: SalesInvoice) => (
        <span className="text-green-600">
          Rp {(inv.paid_amount || 0).toLocaleString('id-ID')}
        </span>
      )
    },
    {
      key: 'balance',
      label: 'Balance',
      render: (inv: SalesInvoice) => (
        <span className="font-semibold text-red-600">
          Rp {(inv.total_amount - (inv.paid_amount || 0)).toLocaleString('id-ID')}
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
      key: 'payment_number',
      label: 'Payment #',
      render: (pay: CustomerPayment) => pay.payment_number
    },
    {
      key: 'payment_date',
      label: 'Date',
      render: (pay: CustomerPayment) => new Date(pay.payment_date).toLocaleDateString()
    },
    {
      key: 'customer',
      label: 'Customer',
      render: (pay: CustomerPayment) => pay.customers?.company_name || 'N/A'
    },
    {
      key: 'invoice',
      label: 'Invoice',
      render: (pay: CustomerPayment) => pay.sales_invoices?.invoice_number || 'N/A'
    },
    {
      key: 'amount',
      label: 'Amount',
      render: (pay: CustomerPayment) => (
        <span className="font-semibold text-green-600">
          Rp {pay.amount.toLocaleString('id-ID')}
        </span>
      )
    },
    {
      key: 'method',
      label: 'Method',
      render: (pay: CustomerPayment) => (
        <span className="capitalize">{pay.payment_method.replace('_', ' ')}</span>
      )
    },
    {
      key: 'bank',
      label: 'Bank Account',
      render: (pay: CustomerPayment) => pay.bank_accounts?.account_name || 'Cash'
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
      </div>

      {view === 'invoices' ? (
        <>
          {invoices.length === 0 && !loading ? (
            <div className="text-center py-12 text-gray-500">
              <TrendingUp className="w-16 h-16 mx-auto mb-4 text-gray-400" />
              <p className="text-lg font-medium">All Caught Up!</p>
              <p className="text-sm mt-2">No outstanding invoices</p>
            </div>
          ) : (
            <DataTable
              columns={invoiceColumns}
              data={invoices}
              loading={loading}
              actions={canManage ? (invoice) => (
                <button
                  onClick={() => handleRecordPayment(invoice)}
                  className="px-3 py-1 bg-green-600 text-white text-sm rounded hover:bg-green-700 transition"
                >
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
        maxWidth="max-w-4xl"
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
                      {bank.account_name} - {bank.bank_name}
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
                          <div className="text-xs mt-1">Total: Rp {invoice.total_amount.toLocaleString('id-ID')}</div>
                          <div className="text-xs text-orange-600 font-medium">Balance: Rp {balance.toLocaleString('id-ID')}</div>
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
                  <span className="font-bold">Rp {formData.amount.toLocaleString('id-ID')}</span>
                </div>
                <div className="flex justify-between text-sm">
                  <span>Allocated:</span>
                  <span className={Object.values(selectedAllocations).reduce((a,b) => a+b, 0) > formData.amount ? 'text-red-600 font-bold' : 'text-green-600'}>
                    Rp {Object.values(selectedAllocations).reduce((a,b) => a+b, 0).toLocaleString('id-ID')}
                  </span>
                </div>
                <div className="flex justify-between text-sm">
                  <span>Unallocated:</span>
                  <span className="text-gray-600">
                    Rp {(formData.amount - Object.values(selectedAllocations).reduce((a,b) => a+b, 0)).toLocaleString('id-ID')}
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
