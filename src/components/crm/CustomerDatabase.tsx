import { useEffect, useState } from 'react';
import { supabase } from '../../lib/supabase';
import { Users, Upload, Search, Edit, Trash2, Building, Mail, Phone, Globe, MapPin, Activity, Send } from 'lucide-react';
import { Modal } from '../Modal';
import { CustomerInteractionTimeline } from './CustomerInteractionTimeline';
import { BulkEmailComposer } from './BulkEmailComposer';

interface Contact {
  id: string;
  company_name: string;
  company_type: string | null;
  industry: string | null;
  country: string | null;
  city: string | null;
  address: string | null;
  website: string | null;
  contact_person: string | null;
  designation: string | null;
  email: string | null;
  phone: string | null;
  mobile: string | null;
  customer_type: string | null;
  tags: string[] | null;
  first_contact_date: string | null;
  last_contact_date: string | null;
  total_inquiries: number;
  total_orders: number;
  lifetime_value: number;
  notes: string | null;
  is_active: boolean;
  created_at: string;
}

interface CustomerDatabaseProps {
  canManage: boolean;
}

export function CustomerDatabase({ canManage }: CustomerDatabaseProps) {
  const [contacts, setContacts] = useState<Contact[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [searchTerm, setSearchTerm] = useState('');
  const [filterType, setFilterType] = useState<string>('all');
  const [modalOpen, setModalOpen] = useState(false);
  const [detailModalOpen, setDetailModalOpen] = useState(false);
  const [editingContact, setEditingContact] = useState<Contact | null>(null);
  const [selectedContact, setSelectedContact] = useState<Contact | null>(null);
  const [importModalOpen, setImportModalOpen] = useState(false);
  const [importing, setImporting] = useState(false);
  const [selectedContacts, setSelectedContacts] = useState<Set<string>>(new Set());
  const [bulkEmailModalOpen, setBulkEmailModalOpen] = useState(false);

  const [formData, setFormData] = useState({
    company_name: '',
    address: '',
    city: '',
    company_type: 'trader' as 'trader' | 'end_user',
    phone: '',
    contact_person: '',
    mobile: '',
    email: '',
    customer_type: 'prospect' as 'prospect' | 'active' | 'inactive' | 'vip',
    notes: '',
  });

  useEffect(() => {
    loadContacts();
  }, []);

  const loadContacts = async () => {
    try {
      setError(null);
      const { data, error } = await supabase
        .from('crm_contacts')
        .select('*')
        .order('company_name', { ascending: true });

      if (error) {
        console.error('Database error:', error);
        throw new Error(error.message || 'Failed to load contacts');
      }
      setContacts(data || []);
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : 'Failed to load contacts. Please try again.';
      console.error('Error loading contacts:', error);
      setError(errorMessage);
      setContacts([]);
    } finally {
      setLoading(false);
    }
  };

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();

    try {
      const { data: { user } } = await supabase.auth.getUser();
      if (!user) throw new Error('Not authenticated');

      if (editingContact) {
        const { error } = await supabase
          .from('crm_contacts')
          .update(formData)
          .eq('id', editingContact.id);

        if (error) throw error;
      } else {
        const { error } = await supabase
          .from('crm_contacts')
          .insert([{
            ...formData,
            created_by: user.id,
            first_contact_date: new Date().toISOString().split('T')[0],
          }]);

        if (error) throw error;
      }

      setModalOpen(false);
      resetForm();
      loadContacts();
    } catch (error) {
      console.error('Error saving contact:', error);
      alert('Failed to save contact. Please try again.');
    }
  };

  const handleEdit = (contact: Contact) => {
    setEditingContact(contact);
    setFormData({
      company_name: contact.company_name,
      address: contact.address || '',
      city: contact.city || '',
      company_type: (contact.company_type as any) || 'trader',
      phone: contact.phone || '',
      contact_person: contact.contact_person || '',
      mobile: contact.mobile || '',
      email: contact.email || '',
      customer_type: (contact.customer_type as any) || 'prospect',
      notes: contact.notes || '',
    });
    setModalOpen(true);
  };

  const handleDelete = async (id: string) => {
    if (!confirm('Are you sure you want to delete this contact?')) return;

    try {
      const { error } = await supabase
        .from('crm_contacts')
        .delete()
        .eq('id', id);

      if (error) throw error;
      loadContacts();
    } catch (error) {
      console.error('Error deleting contact:', error);
      alert('Failed to delete contact. Please try again.');
    }
  };

  const downloadSampleCSV = () => {
    const csvContent = `Company Name,Address,City,Category,Office Phone,Contact Person,Mobile No,Email Id
Acme Pharmaceuticals,"123 Main Street, Building A",Jakarta,TRADER,021-1234567,John Smith,08123456789,john@acme.com;purchasing@acme.com
Global Medtech Inc,"456 Business Park",Surabaya,END USER,031-9876543,Maria Garcia,08198765432,maria@globalmedtech.com
Bio Solutions Ltd,"789 Industrial Zone",Bandung,TRADER,022-5554321,David Chen,08187654321,david@biosolutions.com;sales@biosolutions.com;info@biosolutions.com`;

    const blob = new Blob([csvContent], { type: 'text/csv;charset=utf-8;' });
    const link = document.createElement('a');
    const url = URL.createObjectURL(blob);
    link.setAttribute('href', url);
    link.setAttribute('download', 'contacts_sample_template.csv');
    link.style.visibility = 'hidden';
    document.body.appendChild(link);
    link.click();
    document.body.removeChild(link);
  };

  const handleImport = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;

    setImporting(true);
    try {
      const text = await file.text();
      const lines = text.split('\n');
      const headers = lines[0].split(',').map(h => h.trim().replace(/"/g, ''));

      const { data: { user } } = await supabase.auth.getUser();
      if (!user) throw new Error('Not authenticated');

      const contactsToImport = [];

      for (let i = 1; i < lines.length; i++) {
        if (!lines[i].trim()) continue;

        const values = lines[i].split(',').map(v => v.trim().replace(/"/g, ''));
        const contact: any = {
          created_by: user.id,
          first_contact_date: new Date().toISOString().split('T')[0],
        };

        headers.forEach((header, index) => {
          const lowerHeader = header.toLowerCase().replace(/\s+/g, '');
          if (lowerHeader.includes('companyname')) {
            contact.company_name = values[index];
          } else if (lowerHeader.includes('address')) {
            contact.address = values[index];
          } else if (lowerHeader.includes('city')) {
            contact.city = values[index];
          } else if (lowerHeader.includes('category')) {
            const category = values[index].toLowerCase();
            contact.company_type = category.includes('end') ? 'end_user' : 'trader';
          } else if (lowerHeader.includes('officephone') || lowerHeader.includes('office')) {
            contact.phone = values[index];
          } else if (lowerHeader.includes('contactperson')) {
            contact.contact_person = values[index];
          } else if (lowerHeader.includes('mobileno') || lowerHeader.includes('mobile')) {
            contact.mobile = values[index];
          } else if (lowerHeader.includes('emailid') || lowerHeader.includes('email')) {
            contact.email = values[index];
          }
        });

        if (contact.company_name) {
          contact.customer_type = 'prospect';
          contactsToImport.push(contact);
        }
      }

      if (contactsToImport.length === 0) {
        throw new Error('No valid contacts found in CSV file');
      }

      const { error } = await supabase
        .from('crm_contacts')
        .insert(contactsToImport);

      if (error) throw error;

      alert(`Successfully imported ${contactsToImport.length} contacts!`);
      setImportModalOpen(false);
      loadContacts();
    } catch (error) {
      console.error('Error importing contacts:', error);
      alert('Failed to import contacts: ' + (error as Error).message);
    } finally {
      setImporting(false);
      if (e.target) e.target.value = '';
    }
  };

  const resetForm = () => {
    setEditingContact(null);
    setFormData({
      company_name: '',
      address: '',
      city: '',
      company_type: 'trader',
      phone: '',
      contact_person: '',
      mobile: '',
      email: '',
      customer_type: 'prospect',
      notes: '',
    });
  };

  const filteredContacts = contacts.filter(contact => {
    const matchesSearch = contact.company_name.toLowerCase().includes(searchTerm.toLowerCase()) ||
                         (contact.contact_person?.toLowerCase().includes(searchTerm.toLowerCase())) ||
                         (contact.email?.toLowerCase().includes(searchTerm.toLowerCase()));
    const matchesType = filterType === 'all' || contact.customer_type === filterType;
    return matchesSearch && matchesType;
  });

  const handleSelectContact = (contactId: string) => {
    const newSelected = new Set(selectedContacts);
    if (newSelected.has(contactId)) {
      newSelected.delete(contactId);
    } else {
      newSelected.add(contactId);
    }
    setSelectedContacts(newSelected);
  };

  const handleSelectAll = () => {
    if (selectedContacts.size === filteredContacts.length) {
      setSelectedContacts(new Set());
    } else {
      setSelectedContacts(new Set(filteredContacts.map(c => c.id)));
    }
  };

  const handleBulkEmail = () => {
    const contactsWithEmail = Array.from(selectedContacts)
      .map(id => contacts.find(c => c.id === id))
      .filter((c): c is Contact => !!c && !!c.email);

    if (contactsWithEmail.length === 0) {
      alert('Please select customers with email addresses');
      return;
    }

    setBulkEmailModalOpen(true);
  };

  const getSelectedCustomersForEmail = () => {
    return Array.from(selectedContacts)
      .map(id => contacts.find(c => c.id === id))
      .filter((c): c is Contact => !!c && !!c.email)
      .map(c => ({
        id: c.id,
        company_name: c.company_name,
        email: c.email,
        contact_person: c.contact_person,
      }));
  };

  const customerTypeConfig = {
    prospect: { label: 'Prospect', color: 'bg-gray-100 text-gray-800' },
    active: { label: 'Active', color: 'bg-green-100 text-green-800' },
    inactive: { label: 'Inactive', color: 'bg-red-100 text-red-800' },
    vip: { label: 'VIP', color: 'bg-purple-100 text-purple-800' },
  };

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-2">
          <Users className="w-5 h-5 text-blue-600" />
          <h3 className="text-lg font-semibold">Customer Database</h3>
          <span className="text-sm text-gray-500">({contacts.length} contacts)</span>
          {selectedContacts.size > 0 && (
            <span className="text-sm font-medium text-blue-600">
              ({selectedContacts.size} selected)
            </span>
          )}
        </div>
        {canManage && (
          <div className="flex gap-2">
            {selectedContacts.size > 0 && (
              <button
                onClick={handleBulkEmail}
                className="flex items-center gap-2 px-4 py-2 bg-green-600 text-white rounded-lg hover:bg-green-700 transition"
              >
                <Send className="w-4 h-4" />
                Send Bulk Email ({selectedContacts.size})
              </button>
            )}
            <button
              onClick={() => setImportModalOpen(true)}
              className="flex items-center gap-2 px-3 py-2 text-sm bg-gray-100 hover:bg-gray-200 rounded-lg transition"
            >
              <Upload className="w-4 h-4" />
              Import CSV
            </button>
            <button
              onClick={() => {
                resetForm();
                setModalOpen(true);
              }}
              className="flex items-center gap-2 px-4 py-2 bg-blue-600 text-white rounded-lg hover:bg-blue-700 transition"
            >
              <Users className="w-4 h-4" />
              Add Contact
            </button>
          </div>
        )}
      </div>

      <div className="flex gap-3">
        <div className="flex-1 relative">
          <Search className="w-4 h-4 absolute left-3 top-1/2 transform -translate-y-1/2 text-gray-400" />
          <input
            type="text"
            value={searchTerm}
            onChange={(e) => setSearchTerm(e.target.value)}
            placeholder="Search by company, contact person, or email..."
            className="w-full pl-10 pr-3 py-2 border border-gray-300 rounded-lg focus:ring-2 focus:ring-blue-500"
          />
        </div>
        <select
          value={filterType}
          onChange={(e) => setFilterType(e.target.value)}
          className="px-3 py-2 border border-gray-300 rounded-lg focus:ring-2 focus:ring-blue-500"
        >
          <option value="all">All Types</option>
          <option value="prospect">Prospect</option>
          <option value="active">Active</option>
          <option value="vip">VIP</option>
          <option value="inactive">Inactive</option>
        </select>
      </div>

      {error && (
        <div className="bg-red-50 border border-red-200 rounded-lg p-4 mb-4">
          <div className="flex items-start gap-3">
            <div className="text-red-600 mt-0.5">
              <svg className="w-5 h-5" fill="currentColor" viewBox="0 0 20 20">
                <path fillRule="evenodd" d="M10 18a8 8 0 100-16 8 8 0 000 16zM8.707 7.293a1 1 0 00-1.414 1.414L8.586 10l-1.293 1.293a1 1 0 101.414 1.414L10 11.414l1.293 1.293a1 1 0 001.414-1.414L11.414 10l1.293-1.293a1 1 0 00-1.414-1.414L10 8.586 8.707 7.293z" clipRule="evenodd" />
              </svg>
            </div>
            <div className="flex-1">
              <p className="text-sm font-medium text-red-900">Error Loading Contacts</p>
              <p className="text-sm text-red-700 mt-1">{error}</p>
              <button
                onClick={loadContacts}
                className="mt-3 text-sm font-medium text-red-700 hover:text-red-800 underline"
              >
                Try Again
              </button>
            </div>
          </div>
        </div>
      )}

      {loading ? (
        <div className="flex justify-center items-center py-12">
          <div className="animate-spin rounded-full h-8 w-8 border-b-2 border-blue-600" />
        </div>
      ) : (
        <div className="bg-white rounded-lg shadow overflow-hidden">
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead className="bg-gray-50 border-b border-gray-200">
                <tr>
                  {canManage && (
                    <th className="px-4 py-3 text-center font-semibold text-gray-700 w-12">
                      <input
                        type="checkbox"
                        checked={selectedContacts.size === filteredContacts.length && filteredContacts.length > 0}
                        onChange={handleSelectAll}
                        className="w-4 h-4 text-blue-600 rounded focus:ring-2 focus:ring-blue-500"
                      />
                    </th>
                  )}
                  <th className="px-4 py-3 text-left font-semibold text-gray-700">Company</th>
                  <th className="px-4 py-3 text-left font-semibold text-gray-700">City</th>
                  <th className="px-4 py-3 text-left font-semibold text-gray-700">Category</th>
                  <th className="px-4 py-3 text-left font-semibold text-gray-700">Contact Person</th>
                  <th className="px-4 py-3 text-left font-semibold text-gray-700">Mobile</th>
                  <th className="px-4 py-3 text-left font-semibold text-gray-700">Type</th>
                  <th className="px-4 py-3 text-center font-semibold text-gray-700">Inquiries</th>
                  {canManage && <th className="px-4 py-3 text-center font-semibold text-gray-700">Actions</th>}
                </tr>
              </thead>
              <tbody className="divide-y divide-gray-200">
                {filteredContacts.length === 0 ? (
                  <tr>
                    <td colSpan={canManage ? 9 : 7} className="px-4 py-8 text-center text-gray-500">
                      No contacts found
                    </td>
                  </tr>
                ) : (
                  filteredContacts.map((contact) => (
                    <tr key={contact.id} className="hover:bg-gray-50 transition">
                      {canManage && (
                        <td className="px-4 py-3 text-center">
                          <input
                            type="checkbox"
                            checked={selectedContacts.has(contact.id)}
                            onChange={() => handleSelectContact(contact.id)}
                            className="w-4 h-4 text-blue-600 rounded focus:ring-2 focus:ring-blue-500"
                          />
                        </td>
                      )}
                      <td className="px-4 py-3">
                        <button
                          onClick={() => {
                            setSelectedContact(contact);
                            setDetailModalOpen(true);
                          }}
                          className="font-medium text-blue-600 hover:text-blue-800"
                        >
                          {contact.company_name}
                        </button>
                        {contact.address && (
                          <div className="text-xs text-gray-500">{contact.address}</div>
                        )}
                      </td>
                      <td className="px-4 py-3 text-gray-600">{contact.city || '-'}</td>
                      <td className="px-4 py-3">
                        <span className={`inline-block px-2 py-1 rounded-full text-xs font-medium ${
                          contact.company_type === 'end_user' ? 'bg-green-100 text-green-800' : 'bg-blue-100 text-blue-800'
                        }`}>
                          {contact.company_type === 'end_user' ? 'END USER' : 'TRADER'}
                        </span>
                      </td>
                      <td className="px-4 py-3">{contact.contact_person || '-'}</td>
                      <td className="px-4 py-3 text-gray-600">{contact.mobile || '-'}</td>
                      <td className="px-4 py-3">
                        <span className={`inline-block px-2 py-1 rounded-full text-xs font-medium ${customerTypeConfig[contact.customer_type as keyof typeof customerTypeConfig]?.color || 'bg-gray-100 text-gray-800'}`}>
                          {customerTypeConfig[contact.customer_type as keyof typeof customerTypeConfig]?.label || contact.customer_type}
                        </span>
                      </td>
                      <td className="px-4 py-3 text-center font-medium">{contact.total_inquiries}</td>
                      {canManage && (
                        <td className="px-4 py-3">
                          <div className="flex gap-2 justify-center">
                            <button
                              onClick={() => handleEdit(contact)}
                              className="p-1 text-blue-600 hover:bg-blue-50 rounded"
                              title="Edit"
                            >
                              <Edit className="w-4 h-4" />
                            </button>
                            <button
                              onClick={() => handleDelete(contact.id)}
                              className="p-1 text-red-600 hover:bg-red-50 rounded"
                              title="Delete"
                            >
                              <Trash2 className="w-4 h-4" />
                            </button>
                          </div>
                        </td>
                      )}
                    </tr>
                  ))
                )}
              </tbody>
            </table>
          </div>
        </div>
      )}

      <Modal
        isOpen={modalOpen}
        onClose={() => {
          setModalOpen(false);
          resetForm();
        }}
        title={editingContact ? 'Edit Contact' : 'Add New Contact'}
      >
        <form onSubmit={handleSubmit} className="space-y-4">
          <div className="grid grid-cols-2 gap-4">
            <div className="col-span-2">
              <label className="block text-sm font-medium text-gray-700 mb-1">
                Company Name *
              </label>
              <input
                type="text"
                value={formData.company_name}
                onChange={(e) => setFormData({ ...formData, company_name: e.target.value })}
                className="w-full px-3 py-2 border border-gray-300 rounded-lg focus:ring-2 focus:ring-blue-500"
                required
              />
            </div>

            <div className="col-span-2">
              <label className="block text-sm font-medium text-gray-700 mb-1">
                Address *
              </label>
              <input
                type="text"
                value={formData.address}
                onChange={(e) => setFormData({ ...formData, address: e.target.value })}
                className="w-full px-3 py-2 border border-gray-300 rounded-lg focus:ring-2 focus:ring-blue-500"
                placeholder="Street address, building number, etc."
                required
              />
            </div>

            <div>
              <label className="block text-sm font-medium text-gray-700 mb-1">
                City *
              </label>
              <input
                type="text"
                value={formData.city}
                onChange={(e) => setFormData({ ...formData, city: e.target.value })}
                className="w-full px-3 py-2 border border-gray-300 rounded-lg focus:ring-2 focus:ring-blue-500"
                placeholder="e.g., Jakarta"
                required
              />
            </div>

            <div>
              <label className="block text-sm font-medium text-gray-700 mb-1">
                Category *
              </label>
              <select
                value={formData.company_type}
                onChange={(e) => setFormData({ ...formData, company_type: e.target.value as any })}
                className="w-full px-3 py-2 border border-gray-300 rounded-lg focus:ring-2 focus:ring-blue-500"
                required
              >
                <option value="trader">TRADER</option>
                <option value="end_user">END USER</option>
              </select>
            </div>

            <div>
              <label className="block text-sm font-medium text-gray-700 mb-1">
                Office Phone *
              </label>
              <input
                type="text"
                value={formData.phone}
                onChange={(e) => setFormData({ ...formData, phone: e.target.value })}
                className="w-full px-3 py-2 border border-gray-300 rounded-lg focus:ring-2 focus:ring-blue-500"
                placeholder="e.g., 021-1234567"
                required
              />
            </div>

            <div>
              <label className="block text-sm font-medium text-gray-700 mb-1">
                Contact Person *
              </label>
              <input
                type="text"
                value={formData.contact_person}
                onChange={(e) => setFormData({ ...formData, contact_person: e.target.value })}
                className="w-full px-3 py-2 border border-gray-300 rounded-lg focus:ring-2 focus:ring-blue-500"
                placeholder="Full name"
                required
              />
            </div>

            <div>
              <label className="block text-sm font-medium text-gray-700 mb-1">
                Mobile No *
              </label>
              <input
                type="text"
                value={formData.mobile}
                onChange={(e) => setFormData({ ...formData, mobile: e.target.value })}
                className="w-full px-3 py-2 border border-gray-300 rounded-lg focus:ring-2 focus:ring-blue-500"
                placeholder="e.g., 08123456789"
                required
              />
            </div>

            <div>
              <label className="block text-sm font-medium text-gray-700 mb-1">
                Email Id *
              </label>
              <input
                type="text"
                value={formData.email}
                onChange={(e) => setFormData({ ...formData, email: e.target.value })}
                className="w-full px-3 py-2 border border-gray-300 rounded-lg focus:ring-2 focus:ring-blue-500"
                placeholder="email@company.com; email2@company.com"
                required
              />
              <p className="text-xs text-gray-500 mt-1">Separate multiple emails with semicolon (;)</p>
            </div>

            <div>
              <label className="block text-sm font-medium text-gray-700 mb-1">
                Customer Type
              </label>
              <select
                value={formData.customer_type}
                onChange={(e) => setFormData({ ...formData, customer_type: e.target.value as any })}
                className="w-full px-3 py-2 border border-gray-300 rounded-lg focus:ring-2 focus:ring-blue-500"
              >
                <option value="prospect">Prospect</option>
                <option value="active">Active</option>
                <option value="vip">VIP</option>
                <option value="inactive">Inactive</option>
              </select>
            </div>

            <div className="col-span-2">
              <label className="block text-sm font-medium text-gray-700 mb-1">
                Notes
              </label>
              <textarea
                value={formData.notes}
                onChange={(e) => setFormData({ ...formData, notes: e.target.value })}
                className="w-full px-3 py-2 border border-gray-300 rounded-lg focus:ring-2 focus:ring-blue-500"
                rows={3}
              />
            </div>
          </div>

          <div className="flex justify-end gap-3 pt-4 border-t">
            <button
              type="button"
              onClick={() => {
                setModalOpen(false);
                resetForm();
              }}
              className="px-4 py-2 border border-gray-300 rounded-lg hover:bg-gray-50 transition"
            >
              Cancel
            </button>
            <button
              type="submit"
              className="px-4 py-2 bg-blue-600 text-white rounded-lg hover:bg-blue-700 transition"
            >
              {editingContact ? 'Update Contact' : 'Add Contact'}
            </button>
          </div>
        </form>
      </Modal>

      <Modal
        isOpen={importModalOpen}
        onClose={() => setImportModalOpen(false)}
        title="Import Contacts from CSV"
      >
        <div className="space-y-4">
          <div className="space-y-3">
            <div className="bg-blue-50 border border-blue-200 rounded-lg p-4">
              <p className="text-sm text-blue-900 font-medium mb-2">CSV Format Instructions:</p>
              <ul className="text-xs text-blue-800 space-y-1">
                <li>• Required columns: Company Name, Address, City, Category, Office Phone, Contact Person, Mobile No, Email Id</li>
                <li>• Category must be either "TRADER" or "END USER"</li>
                <li>• For multiple emails, separate with semicolon (;) - e.g., email1@company.com;email2@company.com</li>
                <li>• First row should contain column headers</li>
                <li>• All contacts will be imported as "Prospect" type</li>
              </ul>
            </div>

            <button
              onClick={downloadSampleCSV}
              className="w-full flex items-center justify-center gap-2 px-4 py-2 bg-green-600 text-white rounded-lg hover:bg-green-700 transition font-medium"
            >
              <Upload className="w-4 h-4" />
              Download Sample CSV Template
            </button>
          </div>

          <div>
            <label className="block text-sm font-medium text-gray-700 mb-2">
              Select CSV File
            </label>
            <input
              type="file"
              accept=".csv"
              onChange={handleImport}
              disabled={importing}
              className="w-full px-3 py-2 border border-gray-300 rounded-lg focus:ring-2 focus:ring-blue-500"
            />
          </div>

          {importing && (
            <div className="text-center py-4">
              <div className="animate-spin rounded-full h-8 w-8 border-b-2 border-blue-600 mx-auto mb-2" />
              <p className="text-sm text-gray-600">Importing contacts...</p>
            </div>
          )}
        </div>
      </Modal>

      <Modal
        isOpen={detailModalOpen}
        onClose={() => {
          setDetailModalOpen(false);
          setSelectedContact(null);
        }}
        title="Contact Details"
      >
        {selectedContact && (
          <div className="space-y-4">
            <div>
              <h3 className="text-lg font-semibold text-gray-900">{selectedContact.company_name}</h3>
              {selectedContact.industry && (
                <p className="text-sm text-gray-600">{selectedContact.industry}</p>
              )}
              <div className="mt-2">
                <span className={`inline-block px-3 py-1 rounded-full text-sm font-medium ${customerTypeConfig[selectedContact.customer_type as keyof typeof customerTypeConfig]?.color}`}>
                  {customerTypeConfig[selectedContact.customer_type as keyof typeof customerTypeConfig]?.label}
                </span>
              </div>
            </div>

            <div className="grid grid-cols-2 gap-4 pt-4 border-t">
              <div>
                <p className="text-sm text-gray-600">Total Inquiries</p>
                <p className="text-xl font-bold text-gray-900">{selectedContact.total_inquiries}</p>
              </div>
              <div>
                <p className="text-sm text-gray-600">Total Orders</p>
                <p className="text-xl font-bold text-gray-900">{selectedContact.total_orders}</p>
              </div>
            </div>

            {selectedContact.contact_person && (
              <div className="pt-4 border-t">
                <p className="text-sm font-medium text-gray-700 mb-2">Contact Person</p>
                <p className="text-gray-900">{selectedContact.contact_person}</p>
                {selectedContact.designation && (
                  <p className="text-sm text-gray-600">{selectedContact.designation}</p>
                )}
              </div>
            )}

            <div className="space-y-2 pt-4 border-t">
              {selectedContact.email && (
                <div className="flex items-center gap-2">
                  <Mail className="w-4 h-4 text-gray-400" />
                  <a href={`mailto:${selectedContact.email}`} className="text-sm text-blue-600 hover:underline">
                    {selectedContact.email}
                  </a>
                </div>
              )}
              {selectedContact.phone && (
                <div className="flex items-center gap-2">
                  <Phone className="w-4 h-4 text-gray-400" />
                  <span className="text-sm text-gray-900">{selectedContact.phone}</span>
                </div>
              )}
              {selectedContact.website && (
                <div className="flex items-center gap-2">
                  <Globe className="w-4 h-4 text-gray-400" />
                  <a href={selectedContact.website} target="_blank" rel="noopener noreferrer" className="text-sm text-blue-600 hover:underline">
                    {selectedContact.website}
                  </a>
                </div>
              )}
              {(selectedContact.country || selectedContact.city) && (
                <div className="flex items-center gap-2">
                  <MapPin className="w-4 h-4 text-gray-400" />
                  <span className="text-sm text-gray-900">
                    {[selectedContact.city, selectedContact.country].filter(Boolean).join(', ')}
                  </span>
                </div>
              )}
            </div>

            {selectedContact.notes && (
              <div className="pt-4 border-t">
                <p className="text-sm font-medium text-gray-700 mb-2">Notes</p>
                <p className="text-sm text-gray-600">{selectedContact.notes}</p>
              </div>
            )}

            <div className="pt-4 border-t">
              <div className="flex items-center gap-2 mb-4">
                <Activity className="w-5 h-5 text-gray-700" />
                <h4 className="text-sm font-semibold text-gray-900">Complete Interaction History</h4>
              </div>
              <div className="bg-gray-50 rounded-lg p-4 max-h-96 overflow-y-auto">
                <CustomerInteractionTimeline
                  customerId={selectedContact.id}
                  companyName={selectedContact.company_name}
                />
              </div>
              <p className="text-xs text-gray-500 mt-2">
                Showing all inquiries from Email, WhatsApp, Phone Calls, and other sources
              </p>
            </div>

            <div className="flex justify-end gap-3 pt-4 border-t">
              <button
                onClick={() => {
                  setDetailModalOpen(false);
                  setSelectedContact(null);
                }}
                className="px-4 py-2 border border-gray-300 rounded-lg hover:bg-gray-50 transition"
              >
                Close
              </button>
              {canManage && (
                <button
                  onClick={() => {
                    setDetailModalOpen(false);
                    handleEdit(selectedContact);
                  }}
                  className="px-4 py-2 bg-blue-600 text-white rounded-lg hover:bg-blue-700 transition"
                >
                  Edit Contact
                </button>
              )}
            </div>
          </div>
        )}
      </Modal>

      <Modal
        isOpen={bulkEmailModalOpen}
        onClose={() => {
          setBulkEmailModalOpen(false);
          setSelectedContacts(new Set());
        }}
        title="Bulk Email"
      >
        <BulkEmailComposer
          selectedCustomers={getSelectedCustomersForEmail()}
          onClose={() => {
            setBulkEmailModalOpen(false);
            setSelectedContacts(new Set());
          }}
          onComplete={() => {
            setBulkEmailModalOpen(false);
            setSelectedContacts(new Set());
            loadContacts();
          }}
        />
      </Modal>
    </div>
  );
}
