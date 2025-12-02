import { useEffect, useState } from 'react';
import { supabase } from '../../lib/supabase';
import { useAuth } from '../../contexts/AuthContext';
import { DataTable } from '../DataTable';
import { Modal } from '../Modal';
import { Plus, Edit, Trash2, FileText, DollarSign, Calendar, AlertCircle } from 'lucide-react';

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
  } | null;
}

interface BankAccount {
  id: string;
  account_name: string;
  bank_name: string;
}

interface PayablesManagerProps {
  canManage: boolean;
}

type ViewMode = 'bills' | 'payments';

export function PayablesManager({ canManage }: PayablesManagerProps) {
  const { profile } = useAuth();
  const [viewMode, setViewMode] = useState<ViewMode>('bills');
  const [bills, setBills] = useState<VendorBill[]>([]);
  const [payments, setPayments] = useState<VendorPayment[]>([]);
  const [bankAccounts, setBankAccounts] = useState<BankAccount[]>([]);
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
  }, []);

  const loadData = async () => {
    setLoading(true);
    await Promise.all([loadBills(), loadPayments(), loadBankAccounts()]);
    setLoading(false);
  };

  const loadBills = async () => {
    try {
      const { data, error } = await supabase
        .from('vendor_bills')
        .select('*')
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
            bank_name
          )
        `)
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
        .select('id, account_name, bank_name')
        .eq('is_active', true)
        .order('account_name');

      if (error) throw error;
      setBankAccounts(data || []);
    } catch (error) {
      console.error('Error loading bank accounts:', error);
    }
  };

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

  const overdueBills = bills.filter(b => {
    if (!b.due_date || b.payment_status === 'paid') return false;
    return new Date(b.due_date) < new Date();
  });

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
      render: (bill: VendorBill) => new Date(bill.bill_date).toLocaleDateString()
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
            {dueDate.toLocaleDateString()}
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
          Rp {bill.total_amount.toLocaleString('id-ID')}
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
      render: (payment: VendorPayment) => new Date(payment.payment_date).toLocaleDateString()
    },
    {
      key: 'amount',
      label: 'Amount',
      render: (payment: VendorPayment) => (
        <span className="font-semibold text-green-600">
          Rp {payment.amount.toLocaleString('id-ID')}
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
          ? `${payment.bank_accounts.account_name} - ${payment.bank_accounts.bank_name}`
          : 'N/A'
    },
  ];

  const unpaidBills = bills.filter(b => b.payment_status !== 'paid');

  return (
    <div className="space-y-6">
      <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
        <div className="bg-gradient-to-br from-red-500 to-red-600 rounded-lg shadow p-6 text-white">
          <div className="flex items-center justify-between">
            <div>
              <p className="text-sm text-red-100">Total Payable</p>
              <p className="text-2xl font-bold mt-1">Rp {totalPayable.toLocaleString('id-ID')}</p>
            </div>
            <DollarSign className="w-8 h-8 text-red-200" />
          </div>
        </div>

        <div className="bg-orange-50 rounded-lg shadow p-6">
          <div className="flex items-center justify-between">
            <div>
              <p className="text-sm text-orange-600">Overdue Bills</p>
              <p className="text-2xl font-bold text-orange-600 mt-1">{overdueBills.length}</p>
            </div>
            <AlertCircle className="w-8 h-8 text-orange-400" />
          </div>
        </div>

        <div className="bg-blue-50 rounded-lg shadow p-6">
          <div className="flex items-center justify-between">
            <div>
              <p className="text-sm text-blue-600">Total Bills</p>
              <p className="text-2xl font-bold text-blue-600 mt-1">{bills.length}</p>
            </div>
            <FileText className="w-8 h-8 text-blue-400" />
          </div>
        </div>
      </div>

      <div className="flex items-center justify-between">
        <div className="flex gap-2">
          <button
            onClick={() => setViewMode('bills')}
            className={`px-4 py-2 rounded-lg transition ${
              viewMode === 'bills'
                ? 'bg-blue-600 text-white'
                : 'bg-gray-100 text-gray-700 hover:bg-gray-200'
            }`}
          >
            <FileText className="w-4 h-4 inline mr-2" />
            Bills
          </button>
          <button
            onClick={() => setViewMode('payments')}
            className={`px-4 py-2 rounded-lg transition ${
              viewMode === 'payments'
                ? 'bg-blue-600 text-white'
                : 'bg-gray-100 text-gray-700 hover:bg-gray-200'
            }`}
          >
            <DollarSign className="w-4 h-4 inline mr-2" />
            Payments
          </button>
        </div>

        {canManage && (
          <div className="flex gap-2">
            {viewMode === 'bills' && (
              <button
                onClick={() => {
                  resetBillForm();
                  setBillModalOpen(true);
                }}
                className="flex items-center gap-2 bg-blue-600 text-white px-4 py-2 rounded-lg hover:bg-blue-700 transition"
              >
                <Plus className="w-5 h-5" />
                Add Bill
              </button>
            )}
            {viewMode === 'payments' && (
              <button
                onClick={() => {
                  resetPaymentForm();
                  setPaymentModalOpen(true);
                }}
                className="flex items-center gap-2 bg-green-600 text-white px-4 py-2 rounded-lg hover:bg-green-700 transition"
              >
                <Plus className="w-5 h-5" />
                Record Payment
              </button>
            )}
          </div>
        )}
      </div>

      {viewMode === 'bills' ? (
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
              <input
                type="number"
                value={billFormData.amount === 0 ? '' : billFormData.amount}
                onChange={(e) => setBillFormData({ ...billFormData, amount: e.target.value === '' ? 0 : Number(e.target.value) })}
                className="w-full px-3 py-2 border border-gray-300 rounded-lg focus:ring-2 focus:ring-blue-500"
                required
                min="0"
                step="0.01"
              />
            </div>

            <div>
              <label className="block text-sm font-medium text-gray-700 mb-1">
                Tax Amount (Rp)
              </label>
              <input
                type="number"
                value={billFormData.tax_amount === 0 ? '' : billFormData.tax_amount}
                onChange={(e) => setBillFormData({ ...billFormData, tax_amount: e.target.value === '' ? 0 : Number(e.target.value) })}
                className="w-full px-3 py-2 border border-gray-300 rounded-lg focus:ring-2 focus:ring-blue-500"
                min="0"
                step="0.01"
              />
            </div>

            <div className="col-span-2">
              <label className="block text-sm font-medium text-gray-700 mb-1">
                Total Amount
              </label>
              <div className="text-2xl font-bold text-gray-900">
                Rp {(billFormData.amount + billFormData.tax_amount).toLocaleString('id-ID')}
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
              className="px-4 py-2 bg-blue-600 text-white rounded-lg hover:bg-blue-700 transition"
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
                    {bill.bill_number} - {bill.vendor_name} (Rp {bill.total_amount.toLocaleString('id-ID')})
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
              <input
                type="number"
                value={paymentFormData.amount === 0 ? '' : paymentFormData.amount}
                onChange={(e) => setPaymentFormData({ ...paymentFormData, amount: e.target.value === '' ? 0 : Number(e.target.value) })}
                className="w-full px-3 py-2 border border-gray-300 rounded-lg focus:ring-2 focus:ring-blue-500"
                required
                min="0"
                step="0.01"
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
                    {account.account_name} - {account.bank_name}
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
