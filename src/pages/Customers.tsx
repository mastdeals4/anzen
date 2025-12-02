import { useEffect, useState } from 'react';
import { Layout } from '../components/Layout';
import { DataTable } from '../components/DataTable';
import { Modal } from '../components/Modal';
import { useLanguage } from '../contexts/LanguageContext';
import { useAuth } from '../contexts/AuthContext';
import { supabase } from '../lib/supabase';
import { Plus, Edit, Trash2, Mail, Phone } from 'lucide-react';
import { indonesiaCities, paymentTermsOptions } from '../data/indonesiaCities';

interface Customer {
  id: string;
  company_name: string;
  npwp: string;
  address: string;
  city: string;
  country: string;
  contact_person: string;
  email: string;
  phone: string;
  pbf_license: string;
  gst_vat_type: string;
  payment_terms: string;
  is_active: boolean;
}

export function Customers() {
  const { t } = useLanguage();
  const { profile } = useAuth();
  const [customers, setCustomers] = useState<Customer[]>([]);
  const [loading, setLoading] = useState(true);
  const [modalOpen, setModalOpen] = useState(false);
  const [editingCustomer, setEditingCustomer] = useState<Customer | null>(null);
  const [formData, setFormData] = useState({
    company_name: '',
    npwp: '',
    address: '',
    city: 'Jakarta Pusat',
    country: 'Indonesia',
    contact_person: '',
    email: '',
    phone: '',
    pbf_license: '',
    gst_vat_type: '',
    payment_terms: '',
  });

  useEffect(() => {
    loadCustomers();
  }, []);

  const loadCustomers = async () => {
    try {
      const { data, error } = await supabase
        .from('customers')
        .select('*')
        .eq('is_active', true)
        .order('created_at', { ascending: false });

      if (error) throw error;
      setCustomers(data || []);
    } catch (error) {
      console.error('Error loading customers:', error);
    } finally {
      setLoading(false);
    }
  };

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();

    try {
      if (editingCustomer) {
        const { error } = await supabase
          .from('customers')
          .update(formData)
          .eq('id', editingCustomer.id);

        if (error) throw error;
      } else {
        const { error } = await supabase
          .from('customers')
          .insert([{ ...formData, created_by: profile?.id }]);

        if (error) throw error;
      }

      setModalOpen(false);
      setEditingCustomer(null);
      resetForm();
      loadCustomers();
    } catch (error) {
      console.error('Error saving customer:', error);
      alert('Failed to save customer');
    }
  };

  const resetForm = () => {
    setFormData({
      company_name: '',
      npwp: '',
      address: '',
      city: 'Jakarta Pusat',
      country: 'Indonesia',
      contact_person: '',
      email: '',
      phone: '',
      pbf_license: '',
      gst_vat_type: '',
      payment_terms: '',
    });
  };

  const handleEdit = (customer: Customer) => {
    setEditingCustomer(customer);
    setFormData({
      company_name: customer.company_name,
      npwp: customer.npwp,
      address: customer.address,
      city: customer.city,
      country: customer.country,
      contact_person: customer.contact_person,
      email: customer.email,
      phone: customer.phone,
      pbf_license: customer.pbf_license || '',
      gst_vat_type: customer.gst_vat_type,
      payment_terms: customer.payment_terms,
    });
    setModalOpen(true);
  };

  const handleDelete = async (customer: Customer) => {
    if (!confirm('Are you sure you want to delete this customer?')) return;

    try {
      const { error } = await supabase
        .from('customers')
        .update({ is_active: false })
        .eq('id', customer.id);

      if (error) throw error;
      loadCustomers();
    } catch (error) {
      console.error('Error deleting customer:', error);
      alert('Failed to delete customer');
    }
  };

  const columns = [
    { key: 'company_name', label: t('customers.companyName'), sortable: true },
    {
      key: 'contact_person',
      label: t('customers.contactPerson'),
      sortable: true,
      render: (customer: Customer) => (
        <div>
          <div>{customer.contact_person}</div>
          <div className="flex items-center gap-2 text-xs text-gray-500 mt-1">
            {customer.email && (
              <span className="flex items-center gap-1">
                <Mail className="w-3 h-3" />
                {customer.email}
              </span>
            )}
            {customer.phone && (
              <span className="flex items-center gap-1">
                <Phone className="w-3 h-3" />
                {customer.phone}
              </span>
            )}
          </div>
        </div>
      ),
    },
    { key: 'city', label: t('customers.city'), sortable: true },
    { key: 'payment_terms', label: t('customers.paymentTerms'), sortable: true },
  ];

  return (
    <Layout>
      <div className="space-y-6">
        <div className="flex items-center justify-between">
          <div>
            <h1 className="text-3xl font-bold text-gray-900">{t('customers.title')}</h1>
            <p className="text-gray-600 mt-1">Manage your customer relationships</p>
          </div>
          <button
            onClick={() => {
              setEditingCustomer(null);
              resetForm();
              setModalOpen(true);
            }}
            className="flex items-center gap-2 px-4 py-2 bg-blue-600 text-white rounded-lg hover:bg-blue-700 transition"
          >
            <Plus className="w-5 h-5" />
            {t('customers.addCustomer')}
          </button>
        </div>

        <DataTable
          data={customers}
          columns={columns}
          loading={loading}
          actions={(customer) => (
            <div className="flex items-center gap-2">
              <button
                onClick={() => handleEdit(customer)}
                className="p-1 text-blue-600 hover:bg-blue-50 rounded transition"
              >
                <Edit className="w-4 h-4" />
              </button>
              <button
                onClick={() => handleDelete(customer)}
                className="p-1 text-red-600 hover:bg-red-50 rounded transition"
              >
                <Trash2 className="w-4 h-4" />
              </button>
            </div>
          )}
        />
      </div>

      <Modal
        isOpen={modalOpen}
        onClose={() => setModalOpen(false)}
        title={editingCustomer ? t('customers.editCustomer') : t('customers.addCustomer')}
        size="xl"
      >
        <form onSubmit={handleSubmit} className="space-y-3">
          <div className="grid grid-cols-2 gap-3">
            <div>
              <label className="block text-xs font-medium text-gray-700 mb-1">
                {t('customers.companyName')} *
              </label>
              <input
                type="text"
                required
                value={formData.company_name}
                onChange={(e) =>
                  setFormData({ ...formData, company_name: e.target.value })
                }
                className="w-full px-2 py-1.5 text-sm border border-gray-300 rounded focus:ring-1 focus:ring-blue-500"
              />
            </div>

            <div>
              <label className="block text-xs font-medium text-gray-700 mb-1">
                {t('customers.npwp')}
              </label>
              <input
                type="text"
                value={formData.npwp}
                onChange={(e) =>
                  setFormData({ ...formData, npwp: e.target.value })
                }
                className="w-full px-2 py-1.5 text-sm border border-gray-300 rounded focus:ring-1 focus:ring-blue-500"
              />
            </div>

            <div>
              <label className="block text-xs font-medium text-gray-700 mb-1">
                {t('customers.contactPerson')} *
              </label>
              <input
                type="text"
                required
                value={formData.contact_person}
                onChange={(e) =>
                  setFormData({ ...formData, contact_person: e.target.value })
                }
                className="w-full px-2 py-1.5 text-sm border border-gray-300 rounded focus:ring-1 focus:ring-blue-500"
              />
            </div>

            <div>
              <label className="block text-xs font-medium text-gray-700 mb-1">
                {t('customers.email')}
              </label>
              <input
                type="email"
                value={formData.email}
                onChange={(e) =>
                  setFormData({ ...formData, email: e.target.value })
                }
                className="w-full px-2 py-1.5 text-sm border border-gray-300 rounded focus:ring-1 focus:ring-blue-500"
              />
            </div>

            <div>
              <label className="block text-xs font-medium text-gray-700 mb-1">
                {t('customers.phone')}
              </label>
              <input
                type="tel"
                value={formData.phone}
                onChange={(e) =>
                  setFormData({ ...formData, phone: e.target.value })
                }
                className="w-full px-2 py-1.5 text-sm border border-gray-300 rounded focus:ring-1 focus:ring-blue-500"
              />
            </div>

            <div>
              <label className="block text-xs font-medium text-gray-700 mb-1">
                PBF License (No.Izin PBF)
              </label>
              <input
                type="text"
                value={formData.pbf_license}
                onChange={(e) =>
                  setFormData({ ...formData, pbf_license: e.target.value })
                }
                className="w-full px-2 py-1.5 text-sm border border-gray-300 rounded focus:ring-1 focus:ring-blue-500"
                placeholder="e.g., 01.001.722.9-411.000"
              />
            </div>

            <div>
              <label className="block text-xs font-medium text-gray-700 mb-1">
                {t('customers.city')}
              </label>
              <select
                value={formData.city}
                onChange={(e) =>
                  setFormData({ ...formData, city: e.target.value })
                }
                className="w-full px-2 py-1.5 text-sm border border-gray-300 rounded focus:ring-1 focus:ring-blue-500"
              >
                <option value="">Select City</option>
                {indonesiaCities.map((city) => (
                  <option key={city} value={city}>
                    {city}
                  </option>
                ))}
              </select>
            </div>

            <div>
              <label className="block text-xs font-medium text-gray-700 mb-1">
                {t('customers.country')}
              </label>
              <input
                type="text"
                value={formData.country}
                readOnly
                className="w-full px-2 py-1.5 text-sm border border-gray-200 rounded bg-gray-50 text-gray-600"
              />
            </div>

            <div>
              <label className="block text-xs font-medium text-gray-700 mb-1">
                {t('customers.gstVatType')}
              </label>
              <input
                type="text"
                value={formData.gst_vat_type}
                onChange={(e) =>
                  setFormData({ ...formData, gst_vat_type: e.target.value })
                }
                className="w-full px-2 py-1.5 text-sm border border-gray-300 rounded focus:ring-1 focus:ring-blue-500"
              />
            </div>

            <div>
              <label className="block text-xs font-medium text-gray-700 mb-1">
                {t('customers.paymentTerms')}
              </label>
              <select
                value={formData.payment_terms}
                onChange={(e) =>
                  setFormData({ ...formData, payment_terms: e.target.value })
                }
                className="w-full px-2 py-1.5 text-sm border border-gray-300 rounded focus:ring-1 focus:ring-blue-500"
              >
                <option value="">Select Payment Terms</option>
                {paymentTermsOptions.map((term) => (
                  <option key={term} value={term}>
                    {term}
                  </option>
                ))}
              </select>
            </div>
          </div>

          <div className="col-span-2">
            <label className="block text-xs font-medium text-gray-700 mb-1">
              {t('customers.address')}
            </label>
            <textarea
              value={formData.address}
              onChange={(e) =>
                setFormData({ ...formData, address: e.target.value })
              }
              rows={2}
              className="w-full px-2 py-1.5 text-sm border border-gray-300 rounded focus:ring-1 focus:ring-blue-500"
            />
          </div>

          <div className="flex justify-end gap-2 pt-2 border-t">
            <button
              type="button"
              onClick={() => setModalOpen(false)}
              className="px-3 py-1.5 text-sm text-gray-700 bg-gray-100 rounded hover:bg-gray-200 transition"
            >
              {t('common.cancel')}
            </button>
            <button
              type="submit"
              className="px-3 py-1.5 text-sm bg-blue-600 text-white rounded hover:bg-blue-700 transition"
            >
              {t('common.save')}
            </button>
          </div>
        </form>
      </Modal>
    </Layout>
  );
}
