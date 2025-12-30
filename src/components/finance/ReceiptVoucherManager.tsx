import { useEffect, useState } from 'react';
import { supabase } from '../../lib/supabase';
import { Plus, Eye, Search, ArrowDownCircle, Check } from 'lucide-react';
import { Modal } from '../Modal';

interface Customer {
  id: string;
  company_name: string;
}

interface BankAccount {
  id: string;
  account_name: string;
  bank_name: string;
  account_number: string;
}

interface SalesInvoice {
  id: string;
  invoice_number: string;
  invoice_date: string;
  total_amount: number;
  paid_amount: number;
  balance_amount: number;
}

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
  created_at: string;
  customers?: { company_name: string };
  bank_accounts?: { account_name: string; bank_name: string };
}

interface ReceiptVoucherManagerProps {
  canManage: boolean;
}

export function ReceiptVoucherManager({ canManage }: ReceiptVoucherManagerProps) {
  const [vouchers, setVouchers] = useState<ReceiptVoucher[]>([]);
  const [customers, setCustomers] = useState<Customer[]>([]);
  const [bankAccounts, setBankAccounts] = useState<BankAccount[]>([]);
  const [pendingInvoices, setPendingInvoices] = useState<SalesInvoice[]>([]);
  const [loading, setLoading] = useState(true);
  const [modalOpen, setModalOpen] = useState(false);
  const [searchTerm, setSearchTerm] = useState('');
  const [allocations, setAllocations] = useState<{ invoiceId: string; amount: number }[]>([]);

  const [formData, setFormData] = useState({
    voucher_date: new Date().toISOString().split('T')[0],
    customer_id: '',
    payment_method: 'bank_transfer',
    bank_account_id: '',
    reference_number: '',
    amount: 0,
    description: '',
  });

  useEffect(() => {
    loadVouchers();
    loadCustomers();
    loadBankAccounts();
  }, []);

  useEffect(() => {
    if (formData.customer_id) {
      loadPendingInvoices(formData.customer_id);
    } else {
      setPendingInvoices([]);
      setAllocations([]);
    }
  }, [formData.customer_id]);

  const loadVouchers = async () => {
    try {
      const { data, error } = await supabase
        .from('receipt_vouchers')
        .select('*, customers(company_name), bank_accounts(account_name, bank_name)')
        .order('voucher_date', { ascending: false });

      if (error) throw error;
      setVouchers(data || []);
    } catch (error) {
      console.error('Error loading vouchers:', error);
    } finally {
      setLoading(false);
    }
  };

  const loadCustomers = async () => {
    const { data } = await supabase.from('customers').select('id, company_name').order('company_name');
    setCustomers(data || []);
  };

  const loadBankAccounts = async () => {
    const { data } = await supabase.from('bank_accounts').select('id, account_name, bank_name, account_number').eq('is_active', true);
    setBankAccounts(data || []);
  };

  const loadPendingInvoices = async (customerId: string) => {
    const { data } = await supabase
      .from('sales_invoices')
      .select('id, invoice_number, invoice_date, total_amount, paid_amount, balance_amount')
      .eq('customer_id', customerId)
      .gt('balance_amount', 0)
      .order('invoice_date');
    
    setPendingInvoices(data || []);
    setAllocations([]);
  };

  const generateVoucherNumber = async () => {
    const year = new Date().getFullYear().toString().slice(-2);
    const month = (new Date().getMonth() + 1).toString().padStart(2, '0');
    const { count } = await supabase
      .from('receipt_vouchers')
      .select('*', { count: 'exact', head: true })
      .like('voucher_number', `RV${year}${month}%`);
    
    return `RV${year}${month}-${String((count || 0) + 1).padStart(4, '0')}`;
  };

  const handleAllocationChange = (invoiceId: string, amount: number) => {
    setAllocations(prev => {
      const existing = prev.find(a => a.invoiceId === invoiceId);
      if (existing) {
        if (amount <= 0) {
          return prev.filter(a => a.invoiceId !== invoiceId);
        }
        return prev.map(a => a.invoiceId === invoiceId ? { ...a, amount } : a);
      }
      if (amount > 0) {
        return [...prev, { invoiceId, amount }];
      }
      return prev;
    });
  };

  const totalAllocated = allocations.reduce((sum, a) => sum + a.amount, 0);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();

    if (allocations.length > 0 && totalAllocated > formData.amount) {
      alert('Total allocated amount cannot exceed payment amount');
      return;
    }

    try {
      const { data: { user } } = await supabase.auth.getUser();
      if (!user) throw new Error('Not authenticated');

      const voucherNumber = await generateVoucherNumber();

      const { data: voucher, error } = await supabase
        .from('receipt_vouchers')
        .insert([{
          voucher_number: voucherNumber,
          voucher_date: formData.voucher_date,
          customer_id: formData.customer_id,
          payment_method: formData.payment_method,
          bank_account_id: formData.bank_account_id || null,
          reference_number: formData.reference_number || null,
          amount: formData.amount,
          description: formData.description || null,
          created_by: user.id,
        }])
        .select()
        .single();

      if (error) throw error;

      for (const alloc of allocations) {
        await supabase.from('voucher_allocations').insert({
          voucher_type: 'receipt',
          receipt_voucher_id: voucher.id,
          sales_invoice_id: alloc.invoiceId,
          allocated_amount: alloc.amount,
        });

        const invoice = pendingInvoices.find(i => i.id === alloc.invoiceId);
        if (invoice) {
          const newPaidAmount = (invoice.paid_amount || 0) + alloc.amount;
          const newBalance = invoice.total_amount - newPaidAmount;
          await supabase
            .from('sales_invoices')
            .update({
              paid_amount: newPaidAmount,
              balance_amount: newBalance,
              status: newBalance <= 0 ? 'paid' : 'partial',
            })
            .eq('id', alloc.invoiceId);
        }
      }

      setModalOpen(false);
      resetForm();
      loadVouchers();
    } catch (error: any) {
      console.error('Error saving voucher:', error);
      alert('Failed to save: ' + error.message);
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
      description: '',
    });
    setAllocations([]);
    setPendingInvoices([]);
  };

  const filteredVouchers = vouchers.filter(v =>
    v.voucher_number.toLowerCase().includes(searchTerm.toLowerCase()) ||
    v.customers?.company_name.toLowerCase().includes(searchTerm.toLowerCase())
  );

  if (loading) {
    return <div className="flex justify-center py-8"><div className="animate-spin rounded-full h-8 w-8 border-b-2 border-blue-600"></div></div>;
  }

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between">
        <div className="relative flex-1 max-w-md">
          <Search className="absolute left-3 top-1/2 transform -translate-y-1/2 text-gray-400 w-5 h-5" />
          <input
            type="text"
            placeholder="Search receipts..."
            value={searchTerm}
            onChange={(e) => setSearchTerm(e.target.value)}
            className="w-full pl-10 pr-4 py-2 border border-gray-300 rounded-lg"
          />
        </div>
        {canManage && (
          <button
            onClick={() => { resetForm(); setModalOpen(true); }}
            className="flex items-center gap-2 bg-green-600 text-white px-4 py-2 rounded-lg hover:bg-green-700"
          >
            <ArrowDownCircle className="w-5 h-5" />
            New Receipt
          </button>
        )}
      </div>

      <div className="bg-white rounded-lg shadow overflow-hidden">
        <table className="w-full">
          <thead className="bg-gray-50">
            <tr>
              <th className="px-4 py-3 text-left text-xs font-medium text-gray-500 uppercase">Voucher No</th>
              <th className="px-4 py-3 text-left text-xs font-medium text-gray-500 uppercase">Date</th>
              <th className="px-4 py-3 text-left text-xs font-medium text-gray-500 uppercase">Customer</th>
              <th className="px-4 py-3 text-left text-xs font-medium text-gray-500 uppercase">Method</th>
              <th className="px-4 py-3 text-left text-xs font-medium text-gray-500 uppercase">Reference</th>
              <th className="px-4 py-3 text-right text-xs font-medium text-gray-500 uppercase">Amount</th>
            </tr>
          </thead>
          <tbody className="divide-y">
            {filteredVouchers.map(voucher => (
              <tr key={voucher.id} className="hover:bg-gray-50">
                <td className="px-4 py-3 font-mono text-sm">{voucher.voucher_number}</td>
                <td className="px-4 py-3">{new Date(voucher.voucher_date).toLocaleDateString('id-ID')}</td>
                <td className="px-4 py-3">{voucher.customers?.company_name}</td>
                <td className="px-4 py-3">
                  <span className="px-2 py-1 bg-blue-100 text-blue-700 rounded text-xs capitalize">
                    {voucher.payment_method.replace('_', ' ')}
                  </span>
                </td>
                <td className="px-4 py-3 text-sm">{voucher.reference_number || '-'}</td>
                <td className="px-4 py-3 text-right font-medium text-green-600">
                  Rp {voucher.amount.toLocaleString('id-ID')}
                </td>
              </tr>
            ))}
            {filteredVouchers.length === 0 && (
              <tr>
                <td colSpan={6} className="px-4 py-8 text-center text-gray-500">
                  No receipt vouchers found
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>

      <Modal isOpen={modalOpen} onClose={() => setModalOpen(false)} title="New Receipt Voucher">
        <form onSubmit={handleSubmit} className="space-y-4">
          <div className="grid grid-cols-2 gap-4">
            <div>
              <label className="block text-sm font-medium text-gray-700 mb-1">Date *</label>
              <input
                type="date"
                required
                value={formData.voucher_date}
                onChange={(e) => setFormData({ ...formData, voucher_date: e.target.value })}
                className="w-full px-3 py-2 border border-gray-300 rounded-lg"
              />
            </div>
            <div>
              <label className="block text-sm font-medium text-gray-700 mb-1">Customer *</label>
              <select
                required
                value={formData.customer_id}
                onChange={(e) => setFormData({ ...formData, customer_id: e.target.value })}
                className="w-full px-3 py-2 border border-gray-300 rounded-lg"
              >
                <option value="">Select customer</option>
                {customers.map(c => (
                  <option key={c.id} value={c.id}>{c.company_name}</option>
                ))}
              </select>
            </div>
          </div>

          <div className="grid grid-cols-2 gap-4">
            <div>
              <label className="block text-sm font-medium text-gray-700 mb-1">Payment Method *</label>
              <select
                required
                value={formData.payment_method}
                onChange={(e) => setFormData({ ...formData, payment_method: e.target.value })}
                className="w-full px-3 py-2 border border-gray-300 rounded-lg"
              >
                <option value="cash">Cash</option>
                <option value="bank_transfer">Bank Transfer</option>
                <option value="check">Check</option>
                <option value="giro">Giro</option>
                <option value="other">Other</option>
              </select>
            </div>
            <div>
              <label className="block text-sm font-medium text-gray-700 mb-1">Amount (Rp) *</label>
              <input
                type="number"
                required
                value={formData.amount}
                onChange={(e) => setFormData({ ...formData, amount: parseFloat(e.target.value) || 0 })}
                className="w-full px-3 py-2 border border-gray-300 rounded-lg"
              />
            </div>
          </div>

          {formData.payment_method !== 'cash' && (
            <div className="grid grid-cols-2 gap-4">
              <div>
                <label className="block text-sm font-medium text-gray-700 mb-1">Bank Account</label>
                <select
                  value={formData.bank_account_id}
                  onChange={(e) => setFormData({ ...formData, bank_account_id: e.target.value })}
                  className="w-full px-3 py-2 border border-gray-300 rounded-lg"
                >
                  <option value="">Select account</option>
                  {bankAccounts.map(b => (
                    <option key={b.id} value={b.id}>{b.bank_name} - {b.account_name}</option>
                  ))}
                </select>
              </div>
              <div>
                <label className="block text-sm font-medium text-gray-700 mb-1">Reference No.</label>
                <input
                  type="text"
                  value={formData.reference_number}
                  onChange={(e) => setFormData({ ...formData, reference_number: e.target.value })}
                  className="w-full px-3 py-2 border border-gray-300 rounded-lg"
                  placeholder="Check/Transfer reference"
                />
              </div>
            </div>
          )}

          <div>
            <label className="block text-sm font-medium text-gray-700 mb-1">Description</label>
            <textarea
              value={formData.description}
              onChange={(e) => setFormData({ ...formData, description: e.target.value })}
              className="w-full px-3 py-2 border border-gray-300 rounded-lg"
              rows={2}
            />
          </div>

          {pendingInvoices.length > 0 && (
            <div className="border-t pt-4">
              <h4 className="font-medium text-gray-700 mb-3">Allocate to Invoices</h4>
              <div className="max-h-48 overflow-y-auto border rounded-lg">
                <table className="w-full text-sm">
                  <thead className="bg-gray-50 sticky top-0">
                    <tr>
                      <th className="px-3 py-2 text-left">Invoice</th>
                      <th className="px-3 py-2 text-right">Balance</th>
                      <th className="px-3 py-2 text-right">Allocate</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y">
                    {pendingInvoices.map(inv => (
                      <tr key={inv.id}>
                        <td className="px-3 py-2">
                          <div className="font-mono">{inv.invoice_number}</div>
                          <div className="text-gray-500 text-xs">{new Date(inv.invoice_date).toLocaleDateString('id-ID')}</div>
                        </td>
                        <td className="px-3 py-2 text-right text-red-600">
                          Rp {inv.balance_amount.toLocaleString('id-ID')}
                        </td>
                        <td className="px-3 py-2">
                          <input
                            type="number"
                            min={0}
                            max={inv.balance_amount}
                            value={allocations.find(a => a.invoiceId === inv.id)?.amount || ''}
                            onChange={(e) => handleAllocationChange(inv.id, parseFloat(e.target.value) || 0)}
                            className="w-24 px-2 py-1 border rounded text-right"
                            placeholder="0"
                          />
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
              <div className="mt-2 text-right text-sm">
                <span className="text-gray-500">Total Allocated:</span>
                <span className={`ml-2 font-medium ${totalAllocated > formData.amount ? 'text-red-600' : 'text-green-600'}`}>
                  Rp {totalAllocated.toLocaleString('id-ID')}
                </span>
                <span className="text-gray-400 ml-1">/ Rp {formData.amount.toLocaleString('id-ID')}</span>
              </div>
            </div>
          )}

          <div className="flex justify-end gap-3 pt-4">
            <button type="button" onClick={() => setModalOpen(false)} className="px-4 py-2 text-gray-700 border rounded-lg hover:bg-gray-50">
              Cancel
            </button>
            <button type="submit" className="px-4 py-2 bg-green-600 text-white rounded-lg hover:bg-green-700">
              Save Receipt
            </button>
          </div>
        </form>
      </Modal>
    </div>
  );
}
