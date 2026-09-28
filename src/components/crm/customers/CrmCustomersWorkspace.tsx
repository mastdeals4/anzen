import { useEffect, useMemo, useState } from 'react';
import { supabase } from '../../../lib/supabase';
import { showToast } from '../../ToastNotification';
import { CrmCustomerDrawer, CustomerDetail } from './CrmCustomerDrawer';
import {
  Users,
  Search,
  Plus,
  RefreshCw,
  Mail,
  Phone,
  Building,
  ExternalLink,
  Filter,
  CheckCircle2,
  Clock,
  ArrowUpDown,
  Send,
  MoreHorizontal,
  FolderOpen,
} from 'lucide-react';

interface CustomerRow extends CustomerDetail {
  openInquiriesCount: number;
  openOrdersCount: number;
  lastActivityDate: string | null;
  lastActivityLabel: string;
}

interface Props {
  onOpenInquiry?: (inquiryId: string) => void;
  onNavigateBulkEmail?: (recipients: Array<{ id: string; company_name: string; email: string; contact_person: string | null }>) => void;
}

export function CrmCustomersWorkspace({
  onOpenInquiry,
  onNavigateBulkEmail,
}: Props) {
  const [customers, setCustomers] = useState<CustomerRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [searchQuery, setSearchQuery] = useState('');
  const [filterType, setFilterType] = useState<'all' | 'active' | 'inquiries' | 'orders' | 'dormant'>('all');
  const [selectedCustomerId, setSelectedCustomerId] = useState<string | null>(null);
  const [selectedCustomerForDrawer, setSelectedCustomerForDrawer] = useState<CustomerDetail | null>(null);

  // Checkbox selections for bulk actions
  const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set());

  // New Customer Modal
  const [showNewModal, setShowNewModal] = useState(false);
  const [newCompany, setNewCompany] = useState('');
  const [newContact, setNewContact] = useState('');
  const [newEmail, setNewEmail] = useState('');
  const [newPhone, setNewPhone] = useState('');
  const [newCity, setNewCity] = useState('');
  const [newType, setNewType] = useState('Pharma Manufacturer');
  const [savingNew, setSavingNew] = useState(false);

  useEffect(() => {
    loadCustomers();
  }, []);

  const loadCustomers = async () => {
    setLoading(true);
    try {
      // 1. Fetch CRM contacts
      const { data: contactRows, error: contactErr } = await supabase
        .from('crm_contacts')
        .select('*')
        .order('company_name');

      if (contactErr) throw contactErr;
      const contacts = contactRows || [];

      // 2. Fetch all ERP customers to match and check open orders
      const { data: erpCustomers } = await supabase
        .from('customers')
        .select('id, company_name, is_active')
        .eq('is_active', true);

      const erpCustMap = new Map((erpCustomers || []).map((c: any) => [c.company_name.toLowerCase().trim(), c.id]));

      // 3. Fetch active inquiries summary
      const { data: inqSummary } = await supabase
        .from('crm_inquiries')
        .select('id, company_name, crm_contact_id, customer_id, created_at, status, pipeline_status')
        .order('created_at', { ascending: false });

      // Group inquiries by contact_id and normalized company_name
      const inquiriesByContact = new Map<string, any[]>();
      const inquiriesByName = new Map<string, any[]>();

      (inqSummary || []).forEach((inq: any) => {
        if (inq.crm_contact_id) {
          const list = inquiriesByContact.get(inq.crm_contact_id) || [];
          list.push(inq);
          inquiriesByContact.set(inq.crm_contact_id, list);
        }
        const normName = (inq.company_name || '').toLowerCase().trim();
        if (normName) {
          const list = inquiriesByName.get(normName) || [];
          list.push(inq);
          inquiriesByName.set(normName, list);
        }
      });

      // 4. Fetch open sales orders
      const { data: openOrders } = await supabase
        .from('sales_orders')
        .select('id, customer_id, status, so_date')
        .not('status', 'in', '(closed,cancelled,rejected)');

      const openOrdersByCust = new Map<string, number>();
      (openOrders || []).forEach((so: any) => {
        openOrdersByCust.set(so.customer_id, (openOrdersByCust.get(so.customer_id) || 0) + 1);
      });

      // Assemble CustomerRow
      const assembled: CustomerRow[] = contacts.map((c: any) => {
        const normName = (c.company_name || '').toLowerCase().trim();
        const contactInquiries = inquiriesByContact.get(c.id) || inquiriesByName.get(normName) || [];
        
        const openInquiries = contactInquiries.filter(
          (i: any) => !['won', 'lost', 'closed', 'rejected', 'archived'].includes((i.pipeline_status || i.status || '').toLowerCase())
        );

        const erpId = erpCustMap.get(normName) || null;
        const openOrdersCount = erpId ? (openOrdersByCust.get(erpId) || 0) : 0;

        const latestInqDate = contactInquiries[0]?.created_at || null;
        const lastActivityDate = latestInqDate || c.created_at;

        let lastActivityLabel = 'No recent activity';
        if (lastActivityDate) {
          const days = Math.max(0, Math.floor((Date.now() - new Date(lastActivityDate).getTime()) / 86400000));
          lastActivityLabel = days === 0 ? 'Today' : days === 1 ? 'Yesterday' : `${days}d ago`;
        }

        return {
          id: c.id,
          company_name: c.company_name,
          contact_person: c.contact_person,
          designation: c.designation,
          email: c.email,
          phone: c.phone,
          mobile: c.mobile,
          landline: c.landline,
          address: c.address,
          city: c.city,
          country: c.country,
          website: c.website,
          customer_type: c.customer_type,
          notes: c.notes,
          is_active: c.is_active,
          erp_customer_id: erpId,
          openInquiriesCount: openInquiries.length,
          openOrdersCount,
          lastActivityDate,
          lastActivityLabel,
        };
      });

      setCustomers(assembled);
    } catch (err: any) {
      console.error('Failed to load customers:', err);
      showToast({ type: 'error', title: 'Customer Database', message: err.message || 'Error loading customers.' });
    } finally {
      setLoading(false);
    }
  };

  const handleCreateCustomer = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!newCompany.trim()) {
      showToast({ type: 'error', title: 'Required Field', message: 'Company name is required.' });
      return;
    }
    setSavingNew(true);
    try {
      const { data: auth } = await supabase.auth.getUser();
      const { data, error } = await supabase.from('crm_contacts').insert({
        company_name: newCompany.trim(),
        contact_person: newContact.trim() || null,
        email: newEmail.trim() || null,
        phone: newPhone.trim() || null,
        city: newCity.trim() || null,
        customer_type: newType,
        is_active: true,
      }).select().single();

      if (error) throw error;

      showToast({ type: 'success', title: 'Customer Created', message: `${newCompany} added to customer database.` });
      setShowNewModal(false);
      setNewCompany('');
      setNewContact('');
      setNewEmail('');
      setNewPhone('');
      setNewCity('');
      loadCustomers();

      if (data) {
        setSelectedCustomerForDrawer(data as CustomerDetail);
      }
    } catch (err: any) {
      showToast({ type: 'error', title: 'Creation Failed', message: err.message });
    } finally {
      setSavingNew(false);
    }
  };

  const filteredCustomers = useMemo(() => {
    let list = customers;

    // Search query
    if (searchQuery.trim()) {
      const q = searchQuery.toLowerCase().trim();
      list = list.filter(
        c =>
          c.company_name.toLowerCase().includes(q) ||
          (c.contact_person && c.contact_person.toLowerCase().includes(q)) ||
          (c.email && c.email.toLowerCase().includes(q)) ||
          (c.phone && c.phone.includes(q)) ||
          (c.city && c.city.toLowerCase().includes(q))
      );
    }

    // Filter type
    if (filterType === 'active') {
      list = list.filter(c => c.is_active !== false);
    } else if (filterType === 'inquiries') {
      list = list.filter(c => c.openInquiriesCount > 0);
    } else if (filterType === 'orders') {
      list = list.filter(c => c.openOrdersCount > 0);
    } else if (filterType === 'dormant') {
      list = list.filter(c => c.openInquiriesCount === 0 && c.openOrdersCount === 0);
    }

    return list;
  }, [customers, searchQuery, filterType]);

  const handleSelectAll = (checked: boolean) => {
    if (checked) {
      setSelectedIds(new Set(filteredCustomers.map(c => c.id)));
    } else {
      setSelectedIds(new Set());
    }
  };

  const handleToggleSelect = (id: string, e: React.MouseEvent) => {
    e.stopPropagation();
    setSelectedIds(prev => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  };

  const handleStartBulkEmail = () => {
    const recipients = customers
      .filter(c => selectedIds.has(c.id) && c.email)
      .map(c => ({
        id: c.id,
        company_name: c.company_name,
        email: c.email!,
        contact_person: c.contact_person || null,
      }));

    if (recipients.length === 0) {
      showToast({ type: 'warning', title: 'No Valid Emails', message: 'None of the selected customers have a valid email address.' });
      return;
    }

    onNavigateBulkEmail?.(recipients);
  };

  return (
    <div className="space-y-4">
      {/* Top Workspace Controls */}
      <div className="flex flex-col sm:flex-row items-stretch sm:items-center justify-between gap-3 bg-white p-3.5 rounded-lg border border-gray-200 shadow-sm">
        <div className="flex items-center gap-2 flex-1 max-w-lg">
          <div className="relative flex-1">
            <Search className="w-4 h-4 absolute left-3 top-2.5 text-gray-400" />
            <input
              type="text"
              value={searchQuery}
              onChange={(e) => setSearchQuery(e.target.value)}
              placeholder="Search company, contact person, email, phone..."
              className="w-full pl-9 pr-3 py-1.5 text-xs bg-slate-50 border border-gray-300 rounded-md focus:outline-none focus:ring-1 focus:ring-blue-500 focus:bg-white transition"
            />
          </div>

          <button
            onClick={loadCustomers}
            disabled={loading}
            className="p-1.5 text-gray-500 hover:text-gray-800 hover:bg-gray-100 rounded border border-gray-200 transition"
            title="Refresh Customers"
          >
            <RefreshCw className={`w-3.5 h-3.5 ${loading ? 'animate-spin' : ''}`} />
          </button>
        </div>

        <div className="flex items-center gap-2 shrink-0">
          {selectedIds.size > 0 && (
            <button
              onClick={handleStartBulkEmail}
              className="inline-flex items-center gap-1.5 px-3 py-1.5 bg-indigo-50 text-indigo-700 border border-indigo-200 rounded-md text-xs font-semibold hover:bg-indigo-100 transition"
            >
              <Send className="w-3.5 h-3.5" />
              Send Bulk Email ({selectedIds.size})
            </button>
          )}

          <button
            onClick={() => setShowNewModal(true)}
            className="inline-flex items-center gap-1.5 px-3.5 py-1.5 bg-blue-600 text-white rounded-md text-xs font-semibold hover:bg-blue-700 shadow-sm transition"
          >
            <Plus className="w-4 h-4" />
            New Customer
          </button>
        </div>
      </div>

      {/* Quick Filters */}
      <div className="flex items-center gap-2 overflow-x-auto pb-1 text-xs">
        {(
          [
            ['all', `All Customers (${customers.length})`],
            ['active', `Active (${customers.filter(c => c.is_active !== false).length})`],
            ['inquiries', `With Open Inquiries (${customers.filter(c => c.openInquiriesCount > 0).length})`],
            ['orders', `With Open Orders (${customers.filter(c => c.openOrdersCount > 0).length})`],
            ['dormant', `Dormant / No Open Action (${customers.filter(c => c.openInquiriesCount === 0 && c.openOrdersCount === 0).length})`],
          ] as const
        ).map(([key, label]) => (
          <button
            key={key}
            onClick={() => setFilterType(key)}
            className={`px-3 py-1.5 rounded-full font-medium transition whitespace-nowrap ${
              filterType === key
                ? 'bg-blue-600 text-white shadow-sm'
                : 'bg-white text-gray-600 border border-gray-200 hover:bg-gray-50'
            }`}
          >
            {label}
          </button>
        ))}
      </div>

      {/* Master Customer Table */}
      <div className="bg-white rounded-lg border border-gray-200 shadow-sm overflow-hidden">
        <div className="overflow-x-auto">
          <table className="w-full text-left text-xs border-collapse">
            <thead>
              <tr className="bg-slate-50 border-b border-gray-200 text-gray-500 font-semibold uppercase tracking-wider">
                <th className="py-2.5 px-3 w-8 text-center">
                  <input
                    type="checkbox"
                    checked={filteredCustomers.length > 0 && selectedIds.size === filteredCustomers.length}
                    onChange={(e) => handleSelectAll(e.target.checked)}
                    className="rounded border-gray-300 text-blue-600 focus:ring-0"
                  />
                </th>
                <th className="py-2.5 px-3">Company</th>
                <th className="py-2.5 px-3">Contact</th>
                <th className="py-2.5 px-3">Email</th>
                <th className="py-2.5 px-3">Phone</th>
                <th className="py-2.5 px-3">Status</th>
                <th className="py-2.5 px-3">Last Activity</th>
                <th className="py-2.5 px-3 text-center">Open Inq</th>
                <th className="py-2.5 px-3 text-center">Open Orders</th>
                <th className="py-2.5 px-3 text-right">Actions</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-gray-100">
              {loading ? (
                <tr>
                  <td colSpan={10} className="py-12 text-center text-gray-400">
                    <RefreshCw className="w-5 h-5 animate-spin mx-auto mb-2 text-blue-600" />
                    Loading customer directory...
                  </td>
                </tr>
              ) : filteredCustomers.length === 0 ? (
                <tr>
                  <td colSpan={10} className="py-12 text-center text-gray-400">
                    No customers found matching current filters.
                  </td>
                </tr>
              ) : (
                filteredCustomers.map((cust) => {
                  const isSelected = selectedIds.has(cust.id);
                  return (
                    <tr
                      key={cust.id}
                      onClick={() => setSelectedCustomerForDrawer(cust)}
                      className={`hover:bg-blue-50/50 cursor-pointer transition ${
                        isSelected ? 'bg-blue-50/30' : ''
                      }`}
                    >
                      <td className="py-2.5 px-3 text-center" onClick={(e) => handleToggleSelect(cust.id, e)}>
                        <input
                          type="checkbox"
                          checked={isSelected}
                          onChange={() => {}}
                          className="rounded border-gray-300 text-blue-600 focus:ring-0"
                        />
                      </td>

                      {/* Company */}
                      <td className="py-2.5 px-3 font-semibold text-gray-900">
                        <div className="flex items-center gap-1.5">
                          <span className="hover:text-blue-600">{cust.company_name}</span>
                          {cust.erp_customer_id && (
                            <span className="px-1.5 py-0.2 text-[10px] font-semibold bg-emerald-50 text-emerald-700 border border-emerald-200 rounded">
                              ERP
                            </span>
                          )}
                        </div>
                        {cust.city && <div className="text-[11px] font-normal text-gray-400">{cust.city}</div>}
                      </td>

                      {/* Contact */}
                      <td className="py-2.5 px-3 text-gray-700">
                        <div>{cust.contact_person || '—'}</div>
                        {cust.designation && <div className="text-[11px] text-gray-400">{cust.designation}</div>}
                      </td>

                      {/* Email */}
                      <td className="py-2.5 px-3 text-gray-600">
                        {cust.email ? (
                          <a
                            href={`mailto:${cust.email}`}
                            onClick={(e) => e.stopPropagation()}
                            className="text-blue-600 hover:underline"
                          >
                            {cust.email}
                          </a>
                        ) : '—'}
                      </td>

                      {/* Phone */}
                      <td className="py-2.5 px-3 text-gray-600">
                        {cust.phone || cust.mobile ? (
                          <a
                            href={`tel:${cust.phone || cust.mobile}`}
                            onClick={(e) => e.stopPropagation()}
                            className="hover:text-emerald-600"
                          >
                            {cust.phone || cust.mobile}
                          </a>
                        ) : '—'}
                      </td>

                      {/* Status */}
                      <td className="py-2.5 px-3">
                        <span className={`inline-flex items-center px-2 py-0.5 rounded-full text-[11px] font-medium ${
                          cust.is_active !== false ? 'bg-emerald-50 text-emerald-700 border border-emerald-200' : 'bg-gray-100 text-gray-600'
                        }`}>
                          {cust.is_active !== false ? 'Active' : 'Inactive'}
                        </span>
                      </td>

                      {/* Last Activity */}
                      <td className="py-2.5 px-3 text-gray-500 whitespace-nowrap">
                        {cust.lastActivityLabel}
                      </td>

                      {/* Open Inquiries */}
                      <td className="py-2.5 px-3 text-center">
                        {cust.openInquiriesCount > 0 ? (
                          <span className="inline-flex items-center justify-center px-2 py-0.5 rounded-full bg-blue-100 text-blue-800 font-bold text-xs">
                            {cust.openInquiriesCount}
                          </span>
                        ) : (
                          <span className="text-gray-300">0</span>
                        )}
                      </td>

                      {/* Open Orders */}
                      <td className="py-2.5 px-3 text-center">
                        {cust.openOrdersCount > 0 ? (
                          <span className="inline-flex items-center justify-center px-2 py-0.5 rounded-full bg-purple-100 text-purple-800 font-bold text-xs">
                            {cust.openOrdersCount}
                          </span>
                        ) : (
                          <span className="text-gray-300">0</span>
                        )}
                      </td>

                      {/* Actions */}
                      <td className="py-2.5 px-3 text-right">
                        <button
                          onClick={(e) => {
                            e.stopPropagation();
                            setSelectedCustomerForDrawer(cust);
                          }}
                          className="px-2.5 py-1 text-xs font-semibold text-blue-600 hover:bg-blue-100 rounded transition inline-flex items-center gap-1"
                        >
                          <ExternalLink className="w-3.5 h-3.5" />
                          View
                        </button>
                      </td>
                    </tr>
                  );
                })
              )}
            </tbody>
          </table>
        </div>
      </div>

      {/* Customer Right-Side Drawer */}
      <CrmCustomerDrawer
        isOpen={!!selectedCustomerForDrawer}
        onClose={() => setSelectedCustomerForDrawer(null)}
        customer={selectedCustomerForDrawer}
        onOpenInquiry={(inqId) => {
          setSelectedCustomerForDrawer(null);
          onOpenInquiry?.(inqId);
        }}
        onRefresh={loadCustomers}
      />

      {/* New Customer Modal */}
      {showNewModal && (
        <div className="fixed inset-0 z-50 overflow-hidden bg-black/40 backdrop-blur-sm flex items-center justify-center p-4">
          <div className="bg-white rounded-lg shadow-xl w-full max-w-md p-6 border border-gray-200">
            <h3 className="text-base font-bold text-gray-900 mb-4">Add New Customer / Prospect</h3>
            <form onSubmit={handleCreateCustomer} className="space-y-3 text-xs">
              <div>
                <label className="block font-medium text-gray-700 mb-1">Company Name *</label>
                <input
                  type="text"
                  required
                  value={newCompany}
                  onChange={(e) => setNewCompany(e.target.value)}
                  placeholder="e.g. PT Kalbe Farma"
                  className="w-full px-3 py-1.5 border border-gray-300 rounded-md focus:ring-1 focus:ring-blue-500 focus:outline-none"
                />
              </div>

              <div>
                <label className="block font-medium text-gray-700 mb-1">Contact Person</label>
                <input
                  type="text"
                  value={newContact}
                  onChange={(e) => setNewContact(e.target.value)}
                  placeholder="e.g. Dr. Budi Santoso"
                  className="w-full px-3 py-1.5 border border-gray-300 rounded-md focus:ring-1 focus:ring-blue-500 focus:outline-none"
                />
              </div>

              <div className="grid grid-cols-2 gap-2">
                <div>
                  <label className="block font-medium text-gray-700 mb-1">Email</label>
                  <input
                    type="email"
                    value={newEmail}
                    onChange={(e) => setNewEmail(e.target.value)}
                    placeholder="contact@company.com"
                    className="w-full px-3 py-1.5 border border-gray-300 rounded-md focus:ring-1 focus:ring-blue-500 focus:outline-none"
                  />
                </div>
                <div>
                  <label className="block font-medium text-gray-700 mb-1">Phone</label>
                  <input
                    type="tel"
                    value={newPhone}
                    onChange={(e) => setNewPhone(e.target.value)}
                    placeholder="+62 21 ..."
                    className="w-full px-3 py-1.5 border border-gray-300 rounded-md focus:ring-1 focus:ring-blue-500 focus:outline-none"
                  />
                </div>
              </div>

              <div className="grid grid-cols-2 gap-2">
                <div>
                  <label className="block font-medium text-gray-700 mb-1">City</label>
                  <input
                    type="text"
                    value={newCity}
                    onChange={(e) => setNewCity(e.target.value)}
                    placeholder="Jakarta"
                    className="w-full px-3 py-1.5 border border-gray-300 rounded-md focus:ring-1 focus:ring-blue-500 focus:outline-none"
                  />
                </div>
                <div>
                  <label className="block font-medium text-gray-700 mb-1">Type</label>
                  <select
                    value={newType}
                    onChange={(e) => setNewType(e.target.value)}
                    className="w-full px-2.5 py-1.5 border border-gray-300 rounded-md focus:ring-1 focus:ring-blue-500 focus:outline-none bg-white"
                  >
                    <option value="Pharma Manufacturer">Pharma Manufacturer</option>
                    <option value="Food & Bev Manufacturer">Food & Bev Manufacturer</option>
                    <option value="Cosmetics Manufacturer">Cosmetics Manufacturer</option>
                    <option value="Distributor / Trader">Distributor / Trader</option>
                    <option value="Other">Other</option>
                  </select>
                </div>
              </div>

              <div className="flex justify-end gap-2 pt-3 border-t border-gray-200 mt-4">
                <button
                  type="button"
                  onClick={() => setShowNewModal(false)}
                  className="px-3 py-1.5 text-gray-600 hover:bg-gray-100 rounded-md text-xs font-semibold"
                >
                  Cancel
                </button>
                <button
                  type="submit"
                  disabled={savingNew}
                  className="px-4 py-1.5 bg-blue-600 text-white rounded-md text-xs font-semibold hover:bg-blue-700 disabled:opacity-50"
                >
                  {savingNew ? 'Saving...' : 'Create Customer'}
                </button>
              </div>
            </form>
          </div>
        </div>
      )}
    </div>
  );
}
