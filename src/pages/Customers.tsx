import { useEffect, useState } from 'react';
import { Layout } from '../components/Layout';
import { DataTable } from '../components/DataTable';
import { Modal } from '../components/Modal';
import { SearchableSelect } from '../components/SearchableSelect';
import { useLanguage } from '../contexts/LanguageContext';
import { useAuth } from '../contexts/AuthContext';
import { supabase } from '../lib/supabase';
import { Plus, Edit, Trash2, Mail, Phone, MessageCircle } from 'lucide-react';
import { showToast } from '../components/ToastNotification';
import { showConfirm } from '../components/ConfirmDialog';
import { indonesiaCities, paymentTermsOptions } from '../data/indonesiaCities';
import {
  DUPLICATE_CUSTOMER_MESSAGE,
  ensureUniqueCustomerName,
  isDuplicateCustomerError,
  findPossibleCustomerMatches,
  type PossibleCustomerMatch,
} from '../utils/customerValidation';

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
  const [possibleMatches, setPossibleMatches] = useState<PossibleCustomerMatch[]>([]);
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
      await ensureUniqueCustomerName(formData.company_name, editingCustomer?.id);

      if (!editingCustomer) {
        const { data: existing, error: matchError } = await supabase
          .from('customers')
          .select('id, company_name, npwp, email, phone, address')
          .eq('is_active', true)
          .limit(10000);
        if (matchError) throw matchError;
        const matches = findPossibleCustomerMatches(formData, (existing || []) as PossibleCustomerMatch[]);
        if (matches.length > 0) {
          setPossibleMatches(matches);
          return;
        }
      }

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
      setPossibleMatches([]);
      setEditingCustomer(null);
      resetForm();
      loadCustomers();
    } catch (error: any) {
      console.error('Error saving customer:', error);
      showToast({
        type: 'error',
        title: 'Error',
        message: error?.message === DUPLICATE_CUSTOMER_MESSAGE || isDuplicateCustomerError(error)
          ? DUPLICATE_CUSTOMER_MESSAGE
          : t('errors.failedToSaveCustomer')
      });
    }
  };

  const resetForm = () => {
    setPossibleMatches([]);
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

  const handleUseExistingCustomer = (match: PossibleCustomerMatch) => {
    const customer = customers.find(c => c.id === match.id);
    if (!customer) return;
    setEditingCustomer(customer);
    setFormData({
      company_name: customer.company_name,
      npwp: customer.npwp || '',
      address: customer.address || '',
      city: customer.city || '',
      country: customer.country || 'Indonesia',
      contact_person: customer.contact_person || '',
      email: customer.email || '',
      phone: customer.phone || '',
      pbf_license: customer.pbf_license || '',
      gst_vat_type: customer.gst_vat_type || '',
      payment_terms: customer.payment_terms || '',
    });
    setPossibleMatches([]);
  };

  const handleDelete = async (customer: Customer) => {
    if (!await showConfirm({ title: 'Confirm', message: t('confirm.deleteCustomer'), variant: 'danger', confirmLabel: 'Delete' })) return;

    try {
      const { error } = await supabase
        .from('customers')
        .update({ is_active: false })
        .eq('id', customer.id);

      if (error) throw error;
      setCustomers(prev => prev.filter(c => c.id !== customer.id));
      loadCustomers();
    } catch (error) {
      console.error('Error deleting customer:', error);
      showToast({ type: 'error', title: 'Error', message: t('errors.failedToDeleteCustomer') });
    }
  };

  const columns = [
    { key: 'company_name', label: t('customers.companyName'), sortable: true },
    {
      key: 'contact_person',
      label: t('customers.contactPerson'),
      sortable: true,
      render: (_value: unknown, customer: Customer) => (
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
                <a
                  href={`https://wa.me/${customer.phone.replace(/\D/g, '').replace(/^0/, '62')}?text=${encodeURIComponent(`Hello ${customer.company_name},`)}`}
                  target="_blank"
                  rel="noopener noreferrer"
                  onClick={(e) => e.stopPropagation()}
                  className="flex items-center gap-0.5 px-1.5 py-0.5 text-[10px] bg-green-50 text-green-700 rounded hover:bg-green-100 border border-green-200"
                  title="Open WhatsApp"
                >
                  <MessageCircle className="w-2.5 h-2.5" />
                  WA
                </a>
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
          {possibleMatches.length > 0 && (
            <div className="rounded border border-amber-300 bg-amber-50 p-3 text-sm text-amber-900">
              <div className="font-semibold">Possible existing customer found</div>
              <div className="mt-1">Review the evidence and select the existing master if this is the same legal entity.</div>
              <div className="mt-2 space-y-2">
                {possibleMatches.map(match => (
                  <div key={match.id} className="flex items-center justify-between gap-3 rounded bg-white p-2 border border-amber-200">
                    <div><div className="font-medium">{match.company_name}</div><div className="text-xs text-gray-600">{match.evidence.join(', ')}</div></div>
                    <button type="button" onClick={() => handleUseExistingCustomer(match)} className="px-2 py-1 text-xs bg-amber-600 text-white rounded">Use existing</button>
                  </div>
                ))}
              </div>
            </div>
          )}
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
                {t('customers.pbfLicense')}
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
              <SearchableSelect
                value={formData.city}
                onChange={(value) => setFormData({ ...formData, city: value })}
                options={[
                  { value: '', label: 'Select City' },
                  ...indonesiaCities.map(city => ({ value: city, label: city }))
                ]}
                placeholder="Select City"
                className="text-sm"
              />
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
