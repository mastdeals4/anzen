import { useEffect, useState, useRef } from 'react';
import { supabase } from '../../lib/supabase';
import { Plus, Eye, Search, ArrowDownCircle, Check, Edit2, Trash2, X, Printer } from 'lucide-react';
import { Modal } from '../Modal';
import jsPDF from 'jspdf';
import html2canvas from 'html2canvas';

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
  created_at: string;
  customers?: { company_name: string };
  bank_accounts?: { account_name: string; bank_name: string; alias?: string };
  allocated_to?: string; // Display text like "SAPJ-008 (Invoice)" or "SO-2025-0004 (Advance)"
}

interface ReceiptVoucherManagerProps {
  canManage: boolean;
}

export function ReceiptVoucherManager({ canManage }: ReceiptVoucherManagerProps) {
  const printRef = useRef<HTMLDivElement>(null);
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
  const [searchTerm, setSearchTerm] = useState('');
  const [allocations, setAllocations] = useState<{ targetId: string; targetType: 'invoice' | 'salesorder'; amount: number }[]>([]);
  const [companyName, setCompanyName] = useState('');
  const [companyAddress, setCompanyAddress] = useState('');

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
    loadCompanySettings();
  }, []);

  const loadCompanySettings = async () => {
    const { data } = await supabase
      .from('app_settings')
      .select('company_name, company_address')
      .single();

    if (data) {
      setCompanyName(data.company_name || '');
      setCompanyAddress(data.company_address || '');
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
        .select('*, customers(company_name), bank_accounts(account_name, bank_name, alias)')
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
                return `${alloc.sales_invoices.invoice_number} (Invoice)`;
              } else if (alloc.sales_order_id && alloc.sales_orders) {
                return `${alloc.sales_orders.so_number} (Advance)`;
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
    const { data } = await supabase.from('customers').select('id, company_name').order('company_name');
    setCustomers(data || []);
  };

  const loadBankAccounts = async () => {
    const { data } = await supabase.from('bank_accounts').select('id, account_name, bank_name, account_number, alias').eq('is_active', true);
    setBankAccounts(data || []);
  };

  const loadAllocationTargets = async (customerId: string, keepExistingAllocations = false, voucherId?: string) => {
    try {
      // Load invoices with calculated balance using RPC function
      const { data: allInvoicesData } = await supabase
        .rpc('get_invoices_with_balance', { customer_uuid: customerId });

      // Filter for unpaid/partially paid invoices
      const invoices = (allInvoicesData || []).filter(inv => inv.balance_amount > 0);

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
            // Get all invoices with balance calculation, then filter for the linked ones
            const { data: allInvsData } = await supabase
              .rpc('get_invoices_with_balance', { customer_uuid: customerId });

            additionalInvoices = (allInvsData || []).filter(inv =>
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

      // Combine both into allocation targets
      const targets: AllocationTarget[] = [
        ...uniqueSOs.map(so => ({
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

  const generateVoucherNumber = async () => {
    const year = new Date().getFullYear().toString().slice(-2);
    const month = (new Date().getMonth() + 1).toString().padStart(2, '0');
    const { count } = await supabase
      .from('receipt_vouchers')
      .select('*', { count: 'exact', head: true })
      .like('voucher_number', `RV${year}${month}%`);
    
    return `RV${year}${month}-${String((count || 0) + 1).padStart(4, '0')}`;
  };

  const handleAllocationChange = (targetId: string, targetType: 'invoice' | 'salesorder', amount: number) => {
    setAllocations(prev => {
      const existing = prev.find(a => a.targetId === targetId);
      if (existing) {
        if (amount <= 0) {
          return prev.filter(a => a.targetId !== targetId);
        }
        return prev.map(a => a.targetId === targetId ? { ...a, amount } : a);
      }
      if (amount > 0) {
        return [...prev, { targetId, targetType, amount }];
      }
      return prev;
    });
  };

  const totalAllocated = allocations.reduce((sum, a) => sum + a.amount, 0);

  const handlePrint = async () => {
    if (!printRef.current || !selectedVoucher) return;

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
      alert('Error generating PDF. Please try again.');
    }
  };

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();

    if (allocations.length > 0 && totalAllocated > formData.amount) {
      alert('Total allocated amount cannot exceed payment amount');
      return;
    }

    try {
      const { data: { user } } = await supabase.auth.getUser();
      if (!user) throw new Error('Not authenticated');

      let voucher;

      if (editMode && selectedVoucher) {
        // UPDATE existing voucher
        const { data: updatedVoucher, error } = await supabase
          .from('receipt_vouchers')
          .update({
            voucher_date: formData.voucher_date,
            payment_method: formData.payment_method,
            bank_account_id: formData.bank_account_id || null,
            reference_number: formData.reference_number || null,
            amount: formData.amount,
            description: formData.description || null,
          })
          .eq('id', selectedVoucher.id)
          .select()
          .single();

        if (error) throw error;
        voucher = updatedVoucher;

        // Delete existing allocations
        await supabase
          .from('voucher_allocations')
          .delete()
          .eq('receipt_voucher_id', selectedVoucher.id);
      } else {
        // CREATE new voucher
        const voucherNumber = await generateVoucherNumber();

        const { data: newVoucher, error } = await supabase
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
        voucher = newVoucher;
      }

      for (const alloc of allocations) {
        if (alloc.targetType === 'invoice') {
          // Allocate to Sales Invoice
          await supabase.from('voucher_allocations').insert({
            voucher_type: 'receipt',
            receipt_voucher_id: voucher.id,
            sales_invoice_id: alloc.targetId,
            allocated_amount: alloc.amount,
          });

          const invoice = allocationTargets.find(t => t.type === 'invoice' && t.id === alloc.targetId) as (SalesInvoice & { type: 'invoice' });
          if (invoice) {
            const newPaidAmount = (invoice.paid_amount || 0) + alloc.amount;
            const newBalance = invoice.total_amount - newPaidAmount;
            await supabase
              .from('sales_invoices')
              .update({
                paid_amount: newPaidAmount,
                balance_amount: newBalance,
                payment_status: newBalance <= 0 ? 'paid' : 'partial',
              })
              .eq('id', alloc.targetId);
          }
        } else if (alloc.targetType === 'salesorder') {
          // Allocate to Sales Order (Advance Payment)
          await supabase.from('voucher_allocations').insert({
            voucher_type: 'receipt',
            receipt_voucher_id: voucher.id,
            sales_order_id: alloc.targetId,
            allocated_amount: alloc.amount,
          });
          // Note: SO advance status will be auto-updated by trigger
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
    setAllocationTargets([]);
    setEditMode(false);
    setSelectedVoucher(null);
  };

  const handleView = async (voucher: ReceiptVoucher) => {
    setSelectedVoucher(voucher);

    // Load allocations for this voucher
    const { data: allocs } = await supabase
      .from('voucher_allocations')
      .select(`
        *,
        sales_invoices(invoice_number, total_amount),
        sales_orders(so_number, total_amount)
      `)
      .eq('receipt_voucher_id', voucher.id);

    setVoucherAllocations(allocs || []);
    setViewModalOpen(true);
  };

  const handleEdit = async (voucher: ReceiptVoucher) => {
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
      description: voucher.description || '',
    });

    // Load allocation targets for this customer (pass voucher ID to include already-allocated docs)
    await loadAllocationTargets(voucher.customer_id, false, voucher.id);

    // THEN load existing allocations (after targets are loaded)
    const { data: allocs } = await supabase
      .from('voucher_allocations')
      .select('*')
      .eq('receipt_voucher_id', voucher.id);

    if (allocs) {
      const existingAllocs = allocs.map(a => ({
        targetId: a.sales_invoice_id || a.sales_order_id,
        targetType: (a.sales_invoice_id ? 'invoice' : 'salesorder') as 'invoice' | 'salesorder',
        amount: Number(a.allocated_amount)
      }));
      setAllocations(existingAllocs);
    }

    setModalOpen(true);
  };

  const handleDelete = async (voucher: ReceiptVoucher) => {
    if (!confirm(`Delete receipt voucher ${voucher.voucher_number}? This will remove all allocations and cannot be undone.`)) {
      return;
    }

    try {
      // Delete allocations first (cascade should handle this, but being explicit)
      await supabase
        .from('voucher_allocations')
        .delete()
        .eq('receipt_voucher_id', voucher.id);

      // Delete voucher
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
              <th className="px-4 py-3 text-left text-xs font-medium text-gray-500 uppercase">Bank</th>
              <th className="px-4 py-3 text-left text-xs font-medium text-gray-500 uppercase">Allocated To</th>
              <th className="px-4 py-3 text-right text-xs font-medium text-gray-500 uppercase">Amount</th>
              <th className="px-4 py-3 text-center text-xs font-medium text-gray-500 uppercase">Actions</th>
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
                <td className="px-4 py-3 text-sm">
                  {voucher.bank_accounts?.alias || voucher.bank_accounts?.account_name || '-'}
                </td>
                <td className="px-4 py-3 text-sm text-gray-600">{voucher.allocated_to}</td>
                <td className="px-4 py-3 text-right font-medium text-green-600">
                  Rp {voucher.amount.toLocaleString('id-ID', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}
                </td>
                <td className="px-4 py-3">
                  <div className="flex items-center justify-center gap-2">
                    <button
                      onClick={() => handleView(voucher)}
                      className="p-1 text-blue-600 hover:bg-blue-50 rounded"
                      title="View Details"
                    >
                      <Eye className="w-4 h-4" />
                    </button>
                    {canManage && (
                      <>
                        <button
                          onClick={() => handleEdit(voucher)}
                          className="p-1 text-amber-600 hover:bg-amber-50 rounded"
                          title="Edit"
                        >
                          <Edit2 className="w-4 h-4" />
                        </button>
                        <button
                          onClick={() => handleDelete(voucher)}
                          className="p-1 text-red-600 hover:bg-red-50 rounded"
                          title="Delete"
                        >
                          <Trash2 className="w-4 h-4" />
                        </button>
                      </>
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

      <Modal isOpen={modalOpen} onClose={() => { setModalOpen(false); resetForm(); }} title={editMode ? "Edit Receipt Voucher" : "New Receipt Voucher"}>
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
              {editMode ? (
                <div className="w-full px-3 py-2 border border-gray-200 rounded-lg bg-gray-50">
                  {customers.find(c => c.id === formData.customer_id)?.company_name || 'Unknown'}
                </div>
              ) : (
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
              )}
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
                    <option key={b.id} value={b.id}>{b.alias || `${b.bank_name} - ${b.account_name}`}</option>
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
                <div className="max-h-64 overflow-y-auto border rounded-lg">
                  <table className="w-full text-sm">
                    <thead className="bg-gray-50 sticky top-0">
                      <tr>
                        <th className="px-3 py-2 text-left">Document</th>
                        <th className="px-3 py-2 text-center">Type</th>
                        <th className="px-3 py-2 text-right">Balance Due</th>
                        <th className="px-3 py-2 text-right">Allocate (Rp)</th>
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

                      return (
                        <tr key={`${target.type}-${target.id}`}>
                          <td className="px-3 py-2">
                            <div className="font-mono text-xs">{docNumber}</div>
                            <div className="text-gray-500 text-xs">{new Date(docDate).toLocaleDateString('id-ID')}</div>
                          </td>
                          <td className="px-3 py-2 text-center">
                            <span className={`px-2 py-0.5 rounded text-xs font-medium ${
                              target.type === 'salesorder'
                                ? 'bg-purple-100 text-purple-700'
                                : 'bg-blue-100 text-blue-700'
                            }`}>
                              {target.type === 'salesorder' ? 'SO (Advance)' : 'Invoice'}
                            </span>
                          </td>
                          <td className="px-3 py-2 text-right text-red-600 font-medium">
                            Rp {balance.toLocaleString('id-ID', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}
                          </td>
                          <td className="px-3 py-2">
                            <input
                              type="number"
                              min={0}
                              max={balance}
                              value={allocations.find(a => a.targetId === target.id)?.amount || ''}
                              onChange={(e) => handleAllocationChange(target.id, target.type, parseFloat(e.target.value) || 0)}
                              className="w-28 px-2 py-1 border rounded text-right text-xs"
                              placeholder="0"
                            />
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
              <div className="mt-3 flex justify-between items-center text-sm">
                <div className="text-gray-600">
                  <span className="font-medium">{allocations.length}</span> allocation(s)
                </div>
                <div className="text-right">
                  <span className="text-gray-500">Total Allocated:</span>
                  <span className={`ml-2 font-bold text-lg ${totalAllocated > formData.amount ? 'text-red-600' : 'text-green-600'}`}>
                    Rp {totalAllocated.toLocaleString('id-ID', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}
                  </span>
                  <span className="text-gray-400 ml-1">/ Rp {formData.amount.toLocaleString('id-ID', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}</span>
                </div>
              </div>
            </div>
          )}

          <div className="flex justify-end gap-3 pt-4">
            <button type="button" onClick={() => { setModalOpen(false); resetForm(); }} className="px-4 py-2 text-gray-700 border rounded-lg hover:bg-gray-50">
              Cancel
            </button>
            <button type="submit" className="px-4 py-2 bg-green-600 text-white rounded-lg hover:bg-green-700">
              {editMode ? 'Update Receipt' : 'Save Receipt'}
            </button>
          </div>
        </form>
      </Modal>

      {/* View Details Modal */}
      <Modal
        isOpen={viewModalOpen}
        onClose={() => { setViewModalOpen(false); setSelectedVoucher(null); setVoucherAllocations([]); }}
        title="Receipt Voucher Details"
      >
        {selectedVoucher && (
          <div className="space-y-4">
            <div className="grid grid-cols-2 gap-4">
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
              <div className="col-span-2">
                <label className="block text-sm font-medium text-gray-500">Amount</label>
                <p className="text-2xl font-bold text-green-600">Rp {selectedVoucher.amount.toLocaleString('id-ID', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}</p>
              </div>
              {selectedVoucher.description && (
                <div className="col-span-2">
                  <label className="block text-sm font-medium text-gray-500">Description</label>
                  <p className="text-gray-700">{selectedVoucher.description}</p>
                </div>
              )}
            </div>

            <div className="border-t pt-4">
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
                      {voucherAllocations.map((alloc, idx) => (
                        <tr key={idx}>
                          <td className="px-3 py-2 font-mono text-xs">
                            {alloc.sales_invoices ? alloc.sales_invoices.invoice_number : alloc.sales_orders?.so_number}
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
                            Rp {alloc.allocated_amount.toLocaleString('id-ID', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              ) : (
                <p className="text-gray-500 text-sm">No allocations</p>
              )}
            </div>

            <div className="flex justify-between pt-4">
              <button
                onClick={handlePrint}
                className="px-4 py-2 bg-blue-600 text-white rounded-lg hover:bg-blue-700 flex items-center gap-2"
              >
                <Printer className="w-4 h-4" />
                Print PDF
              </button>
              <button
                onClick={() => { setViewModalOpen(false); setSelectedVoucher(null); setVoucherAllocations([]); }}
                className="px-4 py-2 bg-gray-600 text-white rounded-lg hover:bg-gray-700"
              >
                Close
              </button>
            </div>
          </div>
        )}
      </Modal>

      {/* Hidden Print Format */}
      {selectedVoucher && (
        <div ref={printRef} style={{ position: 'absolute', left: '-9999px', width: '210mm', padding: '15mm', backgroundColor: '#fff' }}>
          {/* Header */}
          <div style={{ textAlign: 'center', marginBottom: '20px', borderBottom: '2px solid #333', paddingBottom: '15px' }}>
            <h1 style={{ fontSize: '24px', fontWeight: 'bold', margin: '0 0 5px 0', color: '#1a1a1a' }}>
              {companyName || 'Company Name'}
            </h1>
            {companyAddress && (
              <p style={{ fontSize: '11px', margin: '0', color: '#666' }}>{companyAddress}</p>
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
              Rp {selectedVoucher.amount.toLocaleString('id-ID', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}
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
                        Rp {alloc.allocated_amount.toLocaleString('id-ID', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}
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
    </div>
  );
}
