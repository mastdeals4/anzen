import { useEffect, useState } from 'react';
import { supabase } from '../../lib/supabase';
import { Plus, Edit, Trash2, Search, Building2 } from 'lucide-react';
import { Modal } from '../Modal';

interface Supplier {
  id: string;
  supplier_code: string | null;
  company_name: string;
  contact_person: string | null;
  email: string | null;
  phone: string | null;
  address: string | null;
  city: string | null;
  country: string;
  npwp: string | null;
  pkp_status: boolean;
  payment_terms_days: number;
  bank_name: string | null;
  bank_account_number: string | null;
  bank_account_name: string | null;
  is_active: boolean;
}

interface SuppliersManagerProps {
  canManage: boolean;
}

export function SuppliersManager({ canManage }: SuppliersManagerProps) {
  const [suppliers, setSuppliers] = useState<Supplier[]>([]);
  const [loading, setLoading] = useState(true);
  const [modalOpen, setModalOpen] = useState(false);
  const [editingSupplier, setEditingSupplier] = useState<Supplier | null>(null);
  const [searchTerm, setSearchTerm] = useState('');
  const [formData, setFormData] = useState({
    supplier_code: '',
    company_name: '',
    contact_person: '',
    email: '',
    phone: '',
    address: '',
    city: '',
    country: 'Indonesia',
    npwp: '',
    pkp_status: false,
    payment_terms_days: 30,
    bank_name: '',
    bank_account_number: '',
    bank_account_name: '',
  });

  useEffect(() => {
    loadSuppliers();
  }, []);

  const loadSuppliers = async () => {
    try {
      const { data, error } = await supabase
        .from('suppliers')
        .select('*')
        .order('company_name');

      if (error) throw error;
      setSuppliers(data || []);
    } catch (error) {
      console.error('Error loading suppliers:', error);
    } finally {
      setLoading(false);
    }
  };

  const generateSupplierCode = async () => {
    const year = new Date().getFullYear().toString().slice(-2);
    const { count } = await supabase
      .from('suppliers')
      .select('*', { count: 'exact', head: true });
    
    return `SUP${year}-${String((count || 0) + 1).padStart(4, '0')}`;
  };

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();

    try {
      const { data: { user } } = await supabase.auth.getUser();
      if (!user) throw new Error('Not authenticated');

      const payload = {
        ...formData,
        supplier_code: formData.supplier_code || await generateSupplierCode(),
        contact_person: formData.contact_person || null,
        email: formData.email || null,
        phone: formData.phone || null,
        address: formData.address || null,
        city: formData.city || null,
        npwp: formData.npwp || null,
        bank_name: formData.bank_name || null,
        bank_account_number: formData.bank_account_number || null,
        bank_account_name: formData.bank_account_name || null,
      };

      if (editingSupplier) {
        const { error } = await supabase
          .from('suppliers')
          .update(payload)
          .eq('id', editingSupplier.id);
        if (error) throw error;
      } else {
        const { error } = await supabase
          .from('suppliers')
          .insert([{ ...payload, created_by: user.id }]);
        if (error) throw error;
      }

      setModalOpen(false);
      resetForm();
      loadSuppliers();
    } catch (error: any) {
      console.error('Error saving supplier:', error);
      alert('Failed to save supplier: ' + error.message);
    }
  };

  const handleEdit = (supplier: Supplier) => {
    setEditingSupplier(supplier);
    setFormData({
      supplier_code: supplier.supplier_code || '',
      company_name: supplier.company_name,
      contact_person: supplier.contact_person || '',
      email: supplier.email || '',
      phone: supplier.phone || '',
      address: supplier.address || '',
      city: supplier.city || '',
      country: supplier.country,
      npwp: supplier.npwp || '',
      pkp_status: supplier.pkp_status,
      payment_terms_days: supplier.payment_terms_days,
      bank_name: supplier.bank_name || '',
      bank_account_number: supplier.bank_account_number || '',
      bank_account_name: supplier.bank_account_name || '',
    });
    setModalOpen(true);
  };

  const handleDelete = async (id: string) => {
    if (!confirm('Are you sure you want to delete this supplier?')) return;

    try {
      const { error } = await supabase.from('suppliers').delete().eq('id', id);
      if (error) throw error;
      loadSuppliers();
    } catch (error: any) {
      console.error('Error deleting supplier:', error);
      alert('Failed to delete supplier: ' + error.message);
    }
  };

  const resetForm = () => {
    setEditingSupplier(null);
    setFormData({
      supplier_code: '',
      company_name: '',
      contact_person: '',
      email: '',
      phone: '',
      address: '',
      city: '',
      country: 'Indonesia',
      npwp: '',
      pkp_status: false,
      payment_terms_days: 30,
      bank_name: '',
      bank_account_number: '',
      bank_account_name: '',
    });
  };

  const filteredSuppliers = suppliers.filter(s =>
    s.company_name.toLowerCase().includes(searchTerm.toLowerCase()) ||
    (s.supplier_code && s.supplier_code.toLowerCase().includes(searchTerm.toLowerCase())) ||
    (s.npwp && s.npwp.includes(searchTerm))
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
            placeholder="Search suppliers..."
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
            Add Supplier
          </button>
        )}
      </div>

      <div className="bg-white rounded-lg shadow overflow-hidden">
        <table className="w-full">
          <thead className="bg-gray-50">
            <tr>
              <th className="px-4 py-3 text-left text-xs font-medium text-gray-500 uppercase">Code</th>
              <th className="px-4 py-3 text-left text-xs font-medium text-gray-500 uppercase">Company Name</th>
              <th className="px-4 py-3 text-left text-xs font-medium text-gray-500 uppercase">Contact</th>
              <th className="px-4 py-3 text-left text-xs font-medium text-gray-500 uppercase">NPWP</th>
              <th className="px-4 py-3 text-center text-xs font-medium text-gray-500 uppercase">PKP</th>
              <th className="px-4 py-3 text-left text-xs font-medium text-gray-500 uppercase">Terms</th>
              {canManage && <th className="px-4 py-3 text-right text-xs font-medium text-gray-500 uppercase">Actions</th>}
            </tr>
          </thead>
          <tbody className="divide-y">
            {filteredSuppliers.map(supplier => (
              <tr key={supplier.id} className="hover:bg-gray-50">
                <td className="px-4 py-3 font-mono text-sm">{supplier.supplier_code || '-'}</td>
                <td className="px-4 py-3">
                  <div className="flex items-center gap-2">
                    <Building2 className="w-4 h-4 text-gray-400" />
                    <div>
                      <div className="font-medium">{supplier.company_name}</div>
                      {supplier.city && <div className="text-sm text-gray-500">{supplier.city}</div>}
                    </div>
                  </div>
                </td>
                <td className="px-4 py-3">
                  <div className="text-sm">{supplier.contact_person || '-'}</div>
                  {supplier.phone && <div className="text-sm text-gray-500">{supplier.phone}</div>}
                </td>
                <td className="px-4 py-3 font-mono text-sm">{supplier.npwp || '-'}</td>
                <td className="px-4 py-3 text-center">
                  {supplier.pkp_status ? (
                    <span className="px-2 py-1 bg-green-100 text-green-700 text-xs rounded">PKP</span>
                  ) : (
                    <span className="px-2 py-1 bg-gray-100 text-gray-600 text-xs rounded">Non-PKP</span>
                  )}
                </td>
                <td className="px-4 py-3 text-sm">{supplier.payment_terms_days} days</td>
                {canManage && (
                  <td className="px-4 py-3 text-right">
                    <button onClick={() => handleEdit(supplier)} className="text-blue-600 hover:text-blue-800 mr-2">
                      <Edit className="w-4 h-4" />
                    </button>
                    <button onClick={() => handleDelete(supplier.id)} className="text-red-600 hover:text-red-800">
                      <Trash2 className="w-4 h-4" />
                    </button>
                  </td>
                )}
              </tr>
            ))}
            {filteredSuppliers.length === 0 && (
              <tr>
                <td colSpan={7} className="px-4 py-8 text-center text-gray-500">
                  No suppliers found
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>

      <Modal isOpen={modalOpen} onClose={() => setModalOpen(false)} title={editingSupplier ? 'Edit Supplier' : 'Add Supplier'}>
        <form onSubmit={handleSubmit} className="space-y-4">
          <div className="grid grid-cols-2 gap-4">
            <div>
              <label className="block text-sm font-medium text-gray-700 mb-1">Supplier Code</label>
              <input
                type="text"
                value={formData.supplier_code}
                onChange={(e) => setFormData({ ...formData, supplier_code: e.target.value })}
                className="w-full px-3 py-2 border border-gray-300 rounded-lg"
                placeholder="Auto-generated if empty"
              />
            </div>
            <div>
              <label className="block text-sm font-medium text-gray-700 mb-1">Company Name *</label>
              <input
                type="text"
                required
                value={formData.company_name}
                onChange={(e) => setFormData({ ...formData, company_name: e.target.value })}
                className="w-full px-3 py-2 border border-gray-300 rounded-lg"
              />
            </div>
          </div>

          <div className="grid grid-cols-2 gap-4">
            <div>
              <label className="block text-sm font-medium text-gray-700 mb-1">Contact Person</label>
              <input
                type="text"
                value={formData.contact_person}
                onChange={(e) => setFormData({ ...formData, contact_person: e.target.value })}
                className="w-full px-3 py-2 border border-gray-300 rounded-lg"
              />
            </div>
            <div>
              <label className="block text-sm font-medium text-gray-700 mb-1">Phone</label>
              <input
                type="text"
                value={formData.phone}
                onChange={(e) => setFormData({ ...formData, phone: e.target.value })}
                className="w-full px-3 py-2 border border-gray-300 rounded-lg"
              />
            </div>
          </div>

          <div>
            <label className="block text-sm font-medium text-gray-700 mb-1">Email</label>
            <input
              type="email"
              value={formData.email}
              onChange={(e) => setFormData({ ...formData, email: e.target.value })}
              className="w-full px-3 py-2 border border-gray-300 rounded-lg"
            />
          </div>

          <div>
            <label className="block text-sm font-medium text-gray-700 mb-1">Address</label>
            <textarea
              value={formData.address}
              onChange={(e) => setFormData({ ...formData, address: e.target.value })}
              className="w-full px-3 py-2 border border-gray-300 rounded-lg"
              rows={2}
            />
          </div>

          <div className="grid grid-cols-2 gap-4">
            <div>
              <label className="block text-sm font-medium text-gray-700 mb-1">City</label>
              <input
                type="text"
                value={formData.city}
                onChange={(e) => setFormData({ ...formData, city: e.target.value })}
                className="w-full px-3 py-2 border border-gray-300 rounded-lg"
              />
            </div>
            <div>
              <label className="block text-sm font-medium text-gray-700 mb-1">Country</label>
              <input
                type="text"
                value={formData.country}
                onChange={(e) => setFormData({ ...formData, country: e.target.value })}
                className="w-full px-3 py-2 border border-gray-300 rounded-lg"
              />
            </div>
          </div>

          <div className="border-t pt-4">
            <h4 className="font-medium text-gray-700 mb-3">Tax Information</h4>
            <div className="grid grid-cols-2 gap-4">
              <div>
                <label className="block text-sm font-medium text-gray-700 mb-1">NPWP</label>
                <input
                  type="text"
                  value={formData.npwp}
                  onChange={(e) => setFormData({ ...formData, npwp: e.target.value })}
                  className="w-full px-3 py-2 border border-gray-300 rounded-lg"
                  placeholder="00.000.000.0-000.000"
                />
              </div>
              <div className="flex items-center gap-2 pt-6">
                <input
                  type="checkbox"
                  id="pkp_status"
                  checked={formData.pkp_status}
                  onChange={(e) => setFormData({ ...formData, pkp_status: e.target.checked })}
                  className="rounded"
                />
                <label htmlFor="pkp_status" className="text-sm text-gray-700">PKP (Pengusaha Kena Pajak)</label>
              </div>
            </div>
          </div>

          <div className="border-t pt-4">
            <h4 className="font-medium text-gray-700 mb-3">Bank Details</h4>
            <div className="grid grid-cols-3 gap-4">
              <div>
                <label className="block text-sm font-medium text-gray-700 mb-1">Bank Name</label>
                <input
                  type="text"
                  value={formData.bank_name}
                  onChange={(e) => setFormData({ ...formData, bank_name: e.target.value })}
                  className="w-full px-3 py-2 border border-gray-300 rounded-lg"
                />
              </div>
              <div>
                <label className="block text-sm font-medium text-gray-700 mb-1">Account Number</label>
                <input
                  type="text"
                  value={formData.bank_account_number}
                  onChange={(e) => setFormData({ ...formData, bank_account_number: e.target.value })}
                  className="w-full px-3 py-2 border border-gray-300 rounded-lg"
                />
              </div>
              <div>
                <label className="block text-sm font-medium text-gray-700 mb-1">Account Name</label>
                <input
                  type="text"
                  value={formData.bank_account_name}
                  onChange={(e) => setFormData({ ...formData, bank_account_name: e.target.value })}
                  className="w-full px-3 py-2 border border-gray-300 rounded-lg"
                />
              </div>
            </div>
          </div>

          <div>
            <label className="block text-sm font-medium text-gray-700 mb-1">Payment Terms (Days)</label>
            <input
              type="number"
              value={formData.payment_terms_days}
              onChange={(e) => setFormData({ ...formData, payment_terms_days: parseInt(e.target.value) || 30 })}
              className="w-full px-3 py-2 border border-gray-300 rounded-lg"
            />
          </div>

          <div className="flex justify-end gap-3 pt-4">
            <button type="button" onClick={() => setModalOpen(false)} className="px-4 py-2 text-gray-700 border rounded-lg hover:bg-gray-50">
              Cancel
            </button>
            <button type="submit" className="px-4 py-2 bg-blue-600 text-white rounded-lg hover:bg-blue-700">
              {editingSupplier ? 'Update' : 'Create'} Supplier
            </button>
          </div>
        </form>
      </Modal>
    </div>
  );
}
