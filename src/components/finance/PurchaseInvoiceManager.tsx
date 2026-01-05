import { useEffect, useState } from 'react';
import { supabase } from '../../lib/supabase';
import { Plus, Edit, Trash2, Search, FileText, Eye, Link } from 'lucide-react';
import { Modal } from '../Modal';
import { FileUpload } from '../FileUpload';

interface Supplier {
  id: string;
  company_name: string;
  npwp: string | null;
  pkp_status: boolean;
}

interface Batch {
  id: string;
  batch_number: string;
  product_id: string;
  import_price: number;
  duty_charges: number;
  freight_charges: number;
  other_charges: number;
  import_quantity: number;
  supplier_id: string | null;
  purchase_invoice_id: string | null;
  products?: { product_name: string };
}

interface PurchaseInvoice {
  id: string;
  invoice_number: string;
  supplier_id: string;
  invoice_date: string;
  due_date: string | null;
  subtotal: number;
  tax_amount: number;
  total_amount: number;
  paid_amount: number;
  balance_amount: number;
  status: string;
  faktur_pajak_number: string | null;
  notes: string | null;
  document_urls: string[] | null;
  suppliers?: { company_name: string };
}

interface PurchaseInvoiceManagerProps {
  canManage: boolean;
}

export function PurchaseInvoiceManager({ canManage }: PurchaseInvoiceManagerProps) {
  const [invoices, setInvoices] = useState<PurchaseInvoice[]>([]);
  const [suppliers, setSuppliers] = useState<Supplier[]>([]);
  const [unlinkedBatches, setUnlinkedBatches] = useState<Batch[]>([]);
  const [loading, setLoading] = useState(true);
  const [modalOpen, setModalOpen] = useState(false);
  const [linkBatchesModal, setLinkBatchesModal] = useState(false);
  const [selectedInvoice, setSelectedInvoice] = useState<PurchaseInvoice | null>(null);
  const [selectedBatches, setSelectedBatches] = useState<string[]>([]);
  const [searchTerm, setSearchTerm] = useState('');

  const [formData, setFormData] = useState({
    invoice_number: '',
    supplier_id: '',
    invoice_date: new Date().toISOString().split('T')[0],
    due_date: '',
    subtotal: 0,
    tax_amount: 0,
    faktur_pajak_number: '',
    notes: '',
    document_urls: [] as string[],
  });

  useEffect(() => {
    loadInvoices();
    loadSuppliers();
  }, []);

  const loadInvoices = async () => {
    try {
      const { data, error } = await supabase
        .from('purchase_invoices')
        .select('*, suppliers(company_name)')
        .order('invoice_date', { ascending: false });

      if (error) throw error;
      setInvoices(data || []);
    } catch (error) {
      console.error('Error loading invoices:', error);
    } finally {
      setLoading(false);
    }
  };

  const loadSuppliers = async () => {
    const { data } = await supabase.from('suppliers').select('id, company_name, npwp, pkp_status').order('company_name');
    setSuppliers(data || []);
  };

  const loadUnlinkedBatches = async (supplierId: string) => {
    const { data } = await supabase
      .from('batches')
      .select('*, products(product_name)')
      .eq('supplier_id', supplierId)
      .is('purchase_invoice_id', null)
      .order('import_date', { ascending: false });
    
    setUnlinkedBatches(data || []);
  };

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();

    try {
      const { data: { user } } = await supabase.auth.getUser();
      if (!user) throw new Error('Not authenticated');

      const totalAmount = formData.subtotal + formData.tax_amount;

      const payload = {
        invoice_number: formData.invoice_number,
        supplier_id: formData.supplier_id,
        invoice_date: formData.invoice_date,
        due_date: formData.due_date || null,
        subtotal: formData.subtotal,
        tax_amount: formData.tax_amount,
        total_amount: totalAmount,
        faktur_pajak_number: formData.faktur_pajak_number || null,
        notes: formData.notes || null,
        document_urls: formData.document_urls.length > 0 ? formData.document_urls : null,
        created_by: user.id,
      };

      const { error } = await supabase
        .from('purchase_invoices')
        .insert([payload]);

      if (error) throw error;

      setModalOpen(false);
      resetForm();
      loadInvoices();
    } catch (error: any) {
      console.error('Error saving invoice:', error);
      alert('Failed to save: ' + error.message);
    }
  };

  const handleLinkBatches = async () => {
    if (!selectedInvoice || selectedBatches.length === 0) return;

    try {
      const { error } = await supabase
        .from('batches')
        .update({ purchase_invoice_id: selectedInvoice.id })
        .in('id', selectedBatches);

      if (error) throw error;

      setLinkBatchesModal(false);
      setSelectedBatches([]);
      setSelectedInvoice(null);
      alert('Batches linked successfully!');
    } catch (error: any) {
      console.error('Error linking batches:', error);
      alert('Failed to link: ' + error.message);
    }
  };

  const openLinkBatchesModal = async (invoice: PurchaseInvoice) => {
    setSelectedInvoice(invoice);
    await loadUnlinkedBatches(invoice.supplier_id);
    setLinkBatchesModal(true);
  };

  const handleDelete = async (id: string) => {
    if (!confirm('Are you sure you want to delete this invoice?')) return;

    try {
      await supabase.from('batches').update({ purchase_invoice_id: null }).eq('purchase_invoice_id', id);
      const { error } = await supabase.from('purchase_invoices').delete().eq('id', id);
      if (error) throw error;
      loadInvoices();
    } catch (error: any) {
      console.error('Error deleting invoice:', error);
      alert('Failed to delete: ' + error.message);
    }
  };

  const resetForm = () => {
    setFormData({
      invoice_number: '',
      supplier_id: '',
      invoice_date: new Date().toISOString().split('T')[0],
      due_date: '',
      subtotal: 0,
      tax_amount: 0,
      faktur_pajak_number: '',
      notes: '',
      document_urls: [],
    });
  };

  const calculatePPN = () => {
    const supplier = suppliers.find(s => s.id === formData.supplier_id);
    if (supplier?.pkp_status) {
      const ppn = formData.subtotal * 0.11;
      setFormData(prev => ({ ...prev, tax_amount: Math.round(ppn) }));
    }
  };

  const getStatusColor = (status: string) => {
    switch (status) {
      case 'paid': return 'bg-green-100 text-green-700';
      case 'partial': return 'bg-yellow-100 text-yellow-700';
      case 'unpaid': return 'bg-red-100 text-red-700';
      default: return 'bg-gray-100 text-gray-700';
    }
  };

  const filteredInvoices = invoices.filter(inv =>
    inv.invoice_number.toLowerCase().includes(searchTerm.toLowerCase()) ||
    inv.suppliers?.company_name.toLowerCase().includes(searchTerm.toLowerCase())
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
            placeholder="Search invoices..."
            value={searchTerm}
            onChange={(e) => setSearchTerm(e.target.value)}
            className="w-full pl-10 pr-4 py-2 border border-gray-300 rounded-lg"
          />
        </div>
        {canManage && (
          <button
            onClick={() => { resetForm(); setModalOpen(true); }}
            className="flex items-center gap-2 bg-blue-600 text-white px-4 py-2 rounded-lg hover:bg-blue-700"
          >
            <Plus className="w-5 h-5" />
            New Purchase Invoice
          </button>
        )}
      </div>

      <div className="bg-white rounded-lg shadow overflow-hidden">
        <table className="w-full">
          <thead className="bg-gray-50">
            <tr>
              <th className="px-4 py-3 text-left text-xs font-medium text-gray-500 uppercase">Invoice No</th>
              <th className="px-4 py-3 text-left text-xs font-medium text-gray-500 uppercase">Date</th>
              <th className="px-4 py-3 text-left text-xs font-medium text-gray-500 uppercase">Supplier</th>
              <th className="px-4 py-3 text-left text-xs font-medium text-gray-500 uppercase">Faktur Pajak</th>
              <th className="px-4 py-3 text-right text-xs font-medium text-gray-500 uppercase">Total</th>
              <th className="px-4 py-3 text-right text-xs font-medium text-gray-500 uppercase">Balance</th>
              <th className="px-4 py-3 text-center text-xs font-medium text-gray-500 uppercase">Status</th>
              {canManage && <th className="px-4 py-3 text-right text-xs font-medium text-gray-500 uppercase">Actions</th>}
            </tr>
          </thead>
          <tbody className="divide-y">
            {filteredInvoices.map(invoice => (
              <tr key={invoice.id} className="hover:bg-gray-50">
                <td className="px-4 py-3 font-mono text-sm">{invoice.invoice_number}</td>
                <td className="px-4 py-3">{new Date(invoice.invoice_date).toLocaleDateString('id-ID')}</td>
                <td className="px-4 py-3">{invoice.suppliers?.company_name}</td>
                <td className="px-4 py-3 text-sm text-gray-500">{invoice.faktur_pajak_number || '-'}</td>
                <td className="px-4 py-3 text-right">Rp {invoice.total_amount.toLocaleString('id-ID')}</td>
                <td className="px-4 py-3 text-right text-red-600">
                  Rp {invoice.balance_amount.toLocaleString('id-ID')}
                </td>
                <td className="px-4 py-3 text-center">
                  <span className={`px-2 py-1 rounded text-xs capitalize ${getStatusColor(invoice.status)}`}>
                    {invoice.status}
                  </span>
                </td>
                {canManage && (
                  <td className="px-4 py-3 text-right">
                    <button
                      onClick={() => openLinkBatchesModal(invoice)}
                      className="text-purple-600 hover:text-purple-800 mr-2"
                      title="Link Batches"
                    >
                      <Link className="w-4 h-4" />
                    </button>
                    <button onClick={() => handleDelete(invoice.id)} className="text-red-600 hover:text-red-800">
                      <Trash2 className="w-4 h-4" />
                    </button>
                  </td>
                )}
              </tr>
            ))}
            {filteredInvoices.length === 0 && (
              <tr>
                <td colSpan={8} className="px-4 py-8 text-center text-gray-500">
                  No purchase invoices found
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>

      <Modal isOpen={modalOpen} onClose={() => setModalOpen(false)} title="New Purchase Invoice">
        <form onSubmit={handleSubmit} className="space-y-4">
          <div className="grid grid-cols-2 gap-4">
            <div>
              <label className="block text-sm font-medium text-gray-700 mb-1">Invoice Number *</label>
              <input
                type="text"
                required
                value={formData.invoice_number}
                onChange={(e) => setFormData({ ...formData, invoice_number: e.target.value })}
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
                  <option key={s.id} value={s.id}>
                    {s.company_name} {s.pkp_status ? '(PKP)' : ''}
                  </option>
                ))}
              </select>
            </div>
          </div>

          <div className="grid grid-cols-2 gap-4">
            <div>
              <label className="block text-sm font-medium text-gray-700 mb-1">Invoice Date *</label>
              <input
                type="date"
                required
                value={formData.invoice_date}
                onChange={(e) => setFormData({ ...formData, invoice_date: e.target.value })}
                className="w-full px-3 py-2 border border-gray-300 rounded-lg"
              />
            </div>
            <div>
              <label className="block text-sm font-medium text-gray-700 mb-1">Due Date</label>
              <input
                type="date"
                value={formData.due_date}
                onChange={(e) => setFormData({ ...formData, due_date: e.target.value })}
                className="w-full px-3 py-2 border border-gray-300 rounded-lg"
              />
            </div>
          </div>

          <div className="grid grid-cols-2 gap-4">
            <div>
              <label className="block text-sm font-medium text-gray-700 mb-1">Subtotal (Rp) *</label>
              <input
                type="number"
                required
                value={formData.subtotal}
                onChange={(e) => setFormData({ ...formData, subtotal: parseFloat(e.target.value) || 0 })}
                onBlur={calculatePPN}
                className="w-full px-3 py-2 border border-gray-300 rounded-lg"
              />
            </div>
            <div>
              <label className="block text-sm font-medium text-gray-700 mb-1">PPN (Rp)</label>
              <input
                type="number"
                value={formData.tax_amount}
                onChange={(e) => setFormData({ ...formData, tax_amount: parseFloat(e.target.value) || 0 })}
                className="w-full px-3 py-2 border border-gray-300 rounded-lg"
              />
            </div>
          </div>

          <div className="p-3 bg-gray-50 rounded-lg">
            <div className="flex justify-between font-medium text-lg">
              <span>Total:</span>
              <span>Rp {(formData.subtotal + formData.tax_amount).toLocaleString('id-ID')}</span>
            </div>
          </div>

          <div>
            <label className="block text-sm font-medium text-gray-700 mb-1">Faktur Pajak Number</label>
            <input
              type="text"
              value={formData.faktur_pajak_number}
              onChange={(e) => setFormData({ ...formData, faktur_pajak_number: e.target.value })}
              className="w-full px-3 py-2 border border-gray-300 rounded-lg"
              placeholder="000-00.00000000"
            />
          </div>

          <div>
            <label className="block text-sm font-medium text-gray-700 mb-1">Notes</label>
            <textarea
              value={formData.notes}
              onChange={(e) => setFormData({ ...formData, notes: e.target.value })}
              className="w-full px-3 py-2 border border-gray-300 rounded-lg"
              rows={2}
            />
          </div>

          <div>
            <label className="block text-sm font-medium text-gray-700 mb-1">Attach Documents</label>
            <FileUpload
              currentUrls={formData.document_urls}
              onUploadComplete={(urls) => setFormData({ ...formData, document_urls: urls })}
              folder="purchase-invoices"
            />
          </div>

          <div className="flex justify-end gap-3 pt-4">
            <button type="button" onClick={() => setModalOpen(false)} className="px-4 py-2 text-gray-700 border rounded-lg hover:bg-gray-50">
              Cancel
            </button>
            <button type="submit" className="px-4 py-2 bg-blue-600 text-white rounded-lg hover:bg-blue-700">
              Save Invoice
            </button>
          </div>
        </form>
      </Modal>

      <Modal isOpen={linkBatchesModal} onClose={() => { setLinkBatchesModal(false); setSelectedBatches([]); }} title="Link Batches to Invoice">
        <div className="space-y-4">
          <p className="text-sm text-gray-600">
            Select batches from this supplier to link to invoice: <strong>{selectedInvoice?.invoice_number}</strong>
          </p>

          {unlinkedBatches.length === 0 ? (
            <div className="text-center py-8 text-gray-500">
              No unlinked batches found for this supplier
            </div>
          ) : (
            <div className="max-h-64 overflow-y-auto border rounded-lg">
              <table className="w-full text-sm">
                <thead className="bg-gray-50 sticky top-0">
                  <tr>
                    <th className="px-3 py-2 text-left w-8"></th>
                    <th className="px-3 py-2 text-left">Batch</th>
                    <th className="px-3 py-2 text-left">Product</th>
                    <th className="px-3 py-2 text-right">Amount</th>
                  </tr>
                </thead>
                <tbody className="divide-y">
                  {unlinkedBatches.map(batch => {
                    const total = batch.import_price + batch.duty_charges + batch.freight_charges + batch.other_charges;
                    return (
                      <tr key={batch.id} className="hover:bg-gray-50">
                        <td className="px-3 py-2">
                          <input
                            type="checkbox"
                            checked={selectedBatches.includes(batch.id)}
                            onChange={(e) => {
                              if (e.target.checked) {
                                setSelectedBatches([...selectedBatches, batch.id]);
                              } else {
                                setSelectedBatches(selectedBatches.filter(id => id !== batch.id));
                              }
                            }}
                            className="rounded"
                          />
                        </td>
                        <td className="px-3 py-2 font-mono">{batch.batch_number}</td>
                        <td className="px-3 py-2">{batch.products?.product_name}</td>
                        <td className="px-3 py-2 text-right">Rp {total.toLocaleString('id-ID')}</td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          )}

          <div className="flex justify-end gap-3 pt-4">
            <button
              type="button"
              onClick={() => { setLinkBatchesModal(false); setSelectedBatches([]); }}
              className="px-4 py-2 text-gray-700 border rounded-lg hover:bg-gray-50"
            >
              Cancel
            </button>
            <button
              onClick={handleLinkBatches}
              disabled={selectedBatches.length === 0}
              className="px-4 py-2 bg-purple-600 text-white rounded-lg hover:bg-purple-700 disabled:opacity-50"
            >
              Link {selectedBatches.length} Batch(es)
            </button>
          </div>
        </div>
      </Modal>
    </div>
  );
}
