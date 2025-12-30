import { useEffect, useState } from 'react';
import { supabase } from '../../lib/supabase';
import { Plus, Search, ArrowUpCircle } from 'lucide-react';
import { Modal } from '../Modal';

interface Supplier {
  id: string;
  company_name: string;
}

interface BankAccount {
  id: string;
  account_name: string;
  bank_name: string;
}

interface PurchaseInvoice {
  id: string;
  invoice_number: string;
  invoice_date: string;
  total_amount: number;
  paid_amount: number;
  balance_amount: number;
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
  supplier_id: string;
  payment_method: string;
  bank_account_id: string | null;
  reference_number: string | null;
  amount: number;
  pph_amount: number;
  net_amount: number;
  description: string | null;
  suppliers?: { company_name: string };
  bank_accounts?: { account_name: string; bank_name: string };
}

interface PaymentVoucherManagerProps {
  canManage: boolean;
}

export function PaymentVoucherManager({ canManage }: PaymentVoucherManagerProps) {
  const [vouchers, setVouchers] = useState<PaymentVoucher[]>([]);
  const [suppliers, setSuppliers] = useState<Supplier[]>([]);
  const [bankAccounts, setBankAccounts] = useState<BankAccount[]>([]);
  const [pendingInvoices, setPendingInvoices] = useState<PurchaseInvoice[]>([]);
  const [taxCodes, setTaxCodes] = useState<TaxCode[]>([]);
  const [loading, setLoading] = useState(true);
  const [modalOpen, setModalOpen] = useState(false);
  const [searchTerm, setSearchTerm] = useState('');
  const [allocations, setAllocations] = useState<{ invoiceId: string; amount: number }[]>([]);

  const [formData, setFormData] = useState({
    voucher_date: new Date().toISOString().split('T')[0],
    supplier_id: '',
    payment_method: 'bank_transfer',
    bank_account_id: '',
    reference_number: '',
    amount: 0,
    pph_code_id: '',
    pph_amount: 0,
    description: '',
  });

  useEffect(() => {
    loadVouchers();
    loadSuppliers();
    loadBankAccounts();
    loadTaxCodes();
  }, []);

  useEffect(() => {
    if (formData.supplier_id) {
      loadPendingInvoices(formData.supplier_id);
    } else {
      setPendingInvoices([]);
      setAllocations([]);
    }
  }, [formData.supplier_id]);

  useEffect(() => {
    if (formData.pph_code_id && formData.amount > 0) {
      const tax = taxCodes.find(t => t.id === formData.pph_code_id);
      if (tax) {
        const pphAmount = formData.amount * (tax.rate / 100);
        setFormData(prev => ({ ...prev, pph_amount: Math.round(pphAmount) }));
      }
    } else {
      setFormData(prev => ({ ...prev, pph_amount: 0 }));
    }
  }, [formData.pph_code_id, formData.amount, taxCodes]);

  const loadVouchers = async () => {
    try {
      const { data, error } = await supabase
        .from('payment_vouchers')
        .select('*, suppliers(company_name), bank_accounts(account_name, bank_name)')
        .order('voucher_date', { ascending: false });

      if (error) throw error;
      setVouchers(data || []);
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

  const loadBankAccounts = async () => {
    const { data } = await supabase.from('bank_accounts').select('id, account_name, bank_name').eq('is_active', true);
    setBankAccounts(data || []);
  };

  const loadTaxCodes = async () => {
    const { data } = await supabase.from('tax_codes').select('id, code, name, rate').eq('is_withholding', true);
    setTaxCodes(data || []);
  };

  const loadPendingInvoices = async (supplierId: string) => {
    const { data } = await supabase
      .from('purchase_invoices')
      .select('id, invoice_number, invoice_date, total_amount, paid_amount, balance_amount')
      .eq('supplier_id', supplierId)
      .gt('balance_amount', 0)
      .order('invoice_date');
    
    setPendingInvoices(data || []);
    setAllocations([]);
  };

  const generateVoucherNumber = async () => {
    const year = new Date().getFullYear().toString().slice(-2);
    const month = (new Date().getMonth() + 1).toString().padStart(2, '0');
    const { count } = await supabase
      .from('payment_vouchers')
      .select('*', { count: 'exact', head: true })
      .like('voucher_number', `PV${year}${month}%`);
    
    return `PV${year}${month}-${String((count || 0) + 1).padStart(4, '0')}`;
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
  const netAmount = formData.amount - formData.pph_amount;

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();

    try {
      const { data: { user } } = await supabase.auth.getUser();
      if (!user) throw new Error('Not authenticated');

      const voucherNumber = await generateVoucherNumber();

      const { data: voucher, error } = await supabase
        .from('payment_vouchers')
        .insert([{
          voucher_number: voucherNumber,
          voucher_date: formData.voucher_date,
          supplier_id: formData.supplier_id,
          payment_method: formData.payment_method,
          bank_account_id: formData.bank_account_id || null,
          reference_number: formData.reference_number || null,
          amount: formData.amount,
          pph_amount: formData.pph_amount,
          pph_code_id: formData.pph_code_id || null,
          description: formData.description || null,
          created_by: user.id,
        }])
        .select()
        .single();

      if (error) throw error;

      for (const alloc of allocations) {
        await supabase.from('voucher_allocations').insert({
          voucher_type: 'payment',
          payment_voucher_id: voucher.id,
          purchase_invoice_id: alloc.invoiceId,
          allocated_amount: alloc.amount,
        });

        const invoice = pendingInvoices.find(i => i.id === alloc.invoiceId);
        if (invoice) {
          const newPaidAmount = (invoice.paid_amount || 0) + alloc.amount;
          const newBalance = invoice.total_amount - newPaidAmount;
          await supabase
            .from('purchase_invoices')
            .update({
              paid_amount: newPaidAmount,
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
      supplier_id: '',
      payment_method: 'bank_transfer',
      bank_account_id: '',
      reference_number: '',
      amount: 0,
      pph_code_id: '',
      pph_amount: 0,
      description: '',
    });
    setAllocations([]);
    setPendingInvoices([]);
  };

  const filteredVouchers = vouchers.filter(v =>
    v.voucher_number.toLowerCase().includes(searchTerm.toLowerCase()) ||
    v.suppliers?.company_name.toLowerCase().includes(searchTerm.toLowerCase())
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
            placeholder="Search payments..."
            value={searchTerm}
            onChange={(e) => setSearchTerm(e.target.value)}
            className="w-full pl-10 pr-4 py-2 border border-gray-300 rounded-lg"
          />
        </div>
        {canManage && (
          <button
            onClick={() => { resetForm(); setModalOpen(true); }}
            className="flex items-center gap-2 bg-red-600 text-white px-4 py-2 rounded-lg hover:bg-red-700"
          >
            <ArrowUpCircle className="w-5 h-5" />
            New Payment
          </button>
        )}
      </div>

      <div className="bg-white rounded-lg shadow overflow-hidden">
        <table className="w-full">
          <thead className="bg-gray-50">
            <tr>
              <th className="px-4 py-3 text-left text-xs font-medium text-gray-500 uppercase">Voucher No</th>
              <th className="px-4 py-3 text-left text-xs font-medium text-gray-500 uppercase">Date</th>
              <th className="px-4 py-3 text-left text-xs font-medium text-gray-500 uppercase">Supplier</th>
              <th className="px-4 py-3 text-left text-xs font-medium text-gray-500 uppercase">Method</th>
              <th className="px-4 py-3 text-right text-xs font-medium text-gray-500 uppercase">Gross</th>
              <th className="px-4 py-3 text-right text-xs font-medium text-gray-500 uppercase">PPh</th>
              <th className="px-4 py-3 text-right text-xs font-medium text-gray-500 uppercase">Net Paid</th>
            </tr>
          </thead>
          <tbody className="divide-y">
            {filteredVouchers.map(voucher => (
              <tr key={voucher.id} className="hover:bg-gray-50">
                <td className="px-4 py-3 font-mono text-sm">{voucher.voucher_number}</td>
                <td className="px-4 py-3">{new Date(voucher.voucher_date).toLocaleDateString('id-ID')}</td>
                <td className="px-4 py-3">{voucher.suppliers?.company_name}</td>
                <td className="px-4 py-3">
                  <span className="px-2 py-1 bg-blue-100 text-blue-700 rounded text-xs capitalize">
                    {voucher.payment_method.replace('_', ' ')}
                  </span>
                </td>
                <td className="px-4 py-3 text-right">Rp {voucher.amount.toLocaleString('id-ID')}</td>
                <td className="px-4 py-3 text-right text-orange-600">
                  {voucher.pph_amount > 0 ? `Rp ${voucher.pph_amount.toLocaleString('id-ID')}` : '-'}
                </td>
                <td className="px-4 py-3 text-right font-medium text-red-600">
                  Rp {voucher.net_amount.toLocaleString('id-ID')}
                </td>
              </tr>
            ))}
            {filteredVouchers.length === 0 && (
              <tr>
                <td colSpan={7} className="px-4 py-8 text-center text-gray-500">
                  No payment vouchers found
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>

      <Modal isOpen={modalOpen} onClose={() => setModalOpen(false)} title="New Payment Voucher">
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
              <label className="block text-sm font-medium text-gray-700 mb-1">Supplier *</label>
              <select
                required
                value={formData.supplier_id}
                onChange={(e) => setFormData({ ...formData, supplier_id: e.target.value })}
                className="w-full px-3 py-2 border border-gray-300 rounded-lg"
              >
                <option value="">Select supplier</option>
                {suppliers.map(s => (
                  <option key={s.id} value={s.id}>{s.company_name}</option>
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
              <label className="block text-sm font-medium text-gray-700 mb-1">Gross Amount (Rp) *</label>
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
                />
              </div>
            </div>
          )}

          <div className="border-t pt-4">
            <h4 className="font-medium text-gray-700 mb-3">PPh Withholding (Potong Pajak)</h4>
            <div className="grid grid-cols-2 gap-4">
              <div>
                <label className="block text-sm font-medium text-gray-700 mb-1">PPh Type</label>
                <select
                  value={formData.pph_code_id}
                  onChange={(e) => setFormData({ ...formData, pph_code_id: e.target.value })}
                  className="w-full px-3 py-2 border border-gray-300 rounded-lg"
                >
                  <option value="">No withholding</option>
                  {taxCodes.map(t => (
                    <option key={t.id} value={t.id}>{t.code} - {t.name} ({t.rate}%)</option>
                  ))}
                </select>
              </div>
              <div>
                <label className="block text-sm font-medium text-gray-700 mb-1">PPh Amount</label>
                <input
                  type="number"
                  value={formData.pph_amount}
                  onChange={(e) => setFormData({ ...formData, pph_amount: parseFloat(e.target.value) || 0 })}
                  className="w-full px-3 py-2 border border-gray-300 rounded-lg bg-orange-50"
                />
              </div>
            </div>
            <div className="mt-2 p-3 bg-gray-50 rounded-lg">
              <div className="flex justify-between text-sm">
                <span>Gross Amount:</span>
                <span>Rp {formData.amount.toLocaleString('id-ID')}</span>
              </div>
              <div className="flex justify-between text-sm text-orange-600">
                <span>Less: PPh Withholding:</span>
                <span>-Rp {formData.pph_amount.toLocaleString('id-ID')}</span>
              </div>
              <div className="flex justify-between font-medium text-lg border-t mt-2 pt-2">
                <span>Net Payment:</span>
                <span className="text-red-600">Rp {netAmount.toLocaleString('id-ID')}</span>
              </div>
            </div>
          </div>

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
              <h4 className="font-medium text-gray-700 mb-3">Allocate to Purchase Invoices</h4>
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
            </div>
          )}

          <div className="flex justify-end gap-3 pt-4">
            <button type="button" onClick={() => setModalOpen(false)} className="px-4 py-2 text-gray-700 border rounded-lg hover:bg-gray-50">
              Cancel
            </button>
            <button type="submit" className="px-4 py-2 bg-red-600 text-white rounded-lg hover:bg-red-700">
              Save Payment
            </button>
          </div>
        </form>
      </Modal>
    </div>
  );
}
