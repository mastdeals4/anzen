import { useState, useEffect, useRef } from 'react';
import { supabase } from '../../lib/supabase';
import { Plus, X, Search } from 'lucide-react';

interface Customer {
  id: string;
  company_name: string;
  contact_person: string | null;
  email: string | null;
  phone: string | null;
  mobile: string | null;
  landline: string | null;
  country: string | null;
}

interface CompactInquiryFormProps {
  onSubmit: (data: any) => Promise<void>;
  onCancel: () => void;
  initialData?: any;
  isEditing?: boolean;
}

export function CompactInquiryForm({ onSubmit, onCancel, initialData, isEditing = false }: CompactInquiryFormProps) {
  const [customers, setCustomers] = useState<Customer[]>([]);
  const [filteredCustomers, setFilteredCustomers] = useState<Customer[]>([]);
  const [customerSearch, setCustomerSearch] = useState('');
  const [showCustomerDropdown, setShowCustomerDropdown] = useState(false);
  const [showAddCustomerModal, setShowAddCustomerModal] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const dropdownRef = useRef<HTMLDivElement>(null);

  const [formData, setFormData] = useState({
    product_name: initialData?.product_name || '',
    specification: initialData?.specification || '',
    quantity: initialData?.quantity || '',
    priority: initialData?.priority || 'medium',
    inquiry_source: initialData?.inquiry_source || 'email',
    supplier_name: initialData?.supplier_name || '',
    supplier_country: initialData?.supplier_country || '',
    customer_id: initialData?.customer_id || '',
    company_name: initialData?.company_name || '',
    contact_person: initialData?.contact_person || '',
    contact_email: initialData?.contact_email || '',
    contact_phone: initialData?.contact_phone || '',
    price_required: initialData?.price_required || false,
    coa_required: initialData?.coa_required || false,
    sample_required: initialData?.sample_required || false,
    agency_letter_required: initialData?.agency_letter_required || false,
    others_required: initialData?.others_required || false,
    purchase_price: initialData?.purchase_price || '',
    purchase_price_currency: initialData?.purchase_price_currency || 'USD',
    offered_price: initialData?.offered_price || '',
    offered_price_currency: initialData?.offered_price_currency || 'USD',
    delivery_date: initialData?.delivery_date || '',
    delivery_terms: initialData?.delivery_terms || '',
    aceerp_no: initialData?.aceerp_no || '',
    mail_subject: initialData?.mail_subject || '',
    pipeline_status: initialData?.pipeline_status || 'new',
    remarks: initialData?.remarks || '',
    internal_notes: initialData?.internal_notes || '',
  });

  const [newCustomer, setNewCustomer] = useState({
    company_name: '',
    contact_person: '',
    email: '',
    phone: '',
    mobile: '',
    landline: '',
    country: '',
    address: '',
  });

  useEffect(() => {
    loadCustomers();
  }, []);

  useEffect(() => {
    const handleClickOutside = (event: MouseEvent) => {
      if (dropdownRef.current && !dropdownRef.current.contains(event.target as Node)) {
        setShowCustomerDropdown(false);
      }
    };

    if (showCustomerDropdown) {
      document.addEventListener('mousedown', handleClickOutside);
    }

    return () => {
      document.removeEventListener('mousedown', handleClickOutside);
    };
  }, [showCustomerDropdown]);

  useEffect(() => {
    if (customerSearch) {
      const filtered = customers.filter(c =>
        c.company_name.toLowerCase().includes(customerSearch.toLowerCase())
      );
      setFilteredCustomers(filtered);
    } else {
      setFilteredCustomers(customers);
    }
  }, [customerSearch, customers]);

  const loadCustomers = async () => {
    try {
      const { data, error } = await supabase
        .from('crm_contacts')
        .select('id, company_name, contact_person, email, phone, mobile, landline, country')
        .eq('is_active', true)
        .order('company_name');

      if (error) throw error;
      setCustomers(data || []);
      setFilteredCustomers(data || []);
    } catch (error) {
      console.error('Error loading customers:', error);
    }
  };

  const handleCustomerSelect = (customer: Customer) => {
    setFormData({
      ...formData,
      customer_id: customer.id,
      company_name: customer.company_name,
      contact_person: customer.contact_person || '',
      contact_email: customer.email || '',
      contact_phone: customer.phone || '',
    });
    setCustomerSearch(customer.company_name);
    setShowCustomerDropdown(false);
  };

  const handleAddCustomer = async () => {
    if (!newCustomer.company_name) {
      alert('Customer name is required');
      return;
    }

    try {
      const { data: { user } } = await supabase.auth.getUser();
      if (!user) throw new Error('Not authenticated');

      const { data, error } = await supabase
        .from('crm_contacts')
        .insert({
          ...newCustomer,
          is_active: true,
          created_by: user.id,
        })
        .select()
        .single();

      if (error) throw error;

      await loadCustomers();
      handleCustomerSelect(data);
      setShowAddCustomerModal(false);
      setNewCustomer({
        company_name: '',
        contact_person: '',
        email: '',
        phone: '',
        mobile: '',
        landline: '',
        country: '',
        address: '',
      });
    } catch (error) {
      console.error('Error adding customer:', error);
      alert('Failed to add customer');
    }
  };

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();

    if (!formData.product_name || !formData.quantity || !formData.company_name) {
      alert('Please fill in all required fields: Product Name, Quantity, and Customer');
      return;
    }

    setSubmitting(true);
    try {
      await onSubmit(formData);
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <>
      <form onSubmit={handleSubmit} className="space-y-3">
        {/* Row: Product Name | Specification */}
        <div className="grid grid-cols-2 gap-3">
          <div>
            <label className="block text-xs font-medium text-gray-700 mb-1">
              Product Name <span className="text-red-500">*</span>
            </label>
            <input
              type="text"
              value={formData.product_name}
              onChange={(e) => setFormData({ ...formData, product_name: e.target.value })}
              className="w-full h-9 px-3 py-1 text-sm border border-gray-300 rounded-lg focus:ring-2 focus:ring-blue-500"
              placeholder="Enter product name"
              required
            />
          </div>
          <div>
            <label className="block text-xs font-medium text-gray-700 mb-1">
              Specification
            </label>
            <input
              type="text"
              value={formData.specification}
              onChange={(e) => setFormData({ ...formData, specification: e.target.value })}
              className="w-full h-9 px-3 py-1 text-sm border border-gray-300 rounded-lg focus:ring-2 focus:ring-blue-500"
              placeholder="BP / USP / EP"
            />
          </div>
        </div>

        {/* Row: Quantity | Priority | Inquiry Source */}
        <div className="grid grid-cols-3 gap-3">
          <div>
            <label className="block text-xs font-medium text-gray-700 mb-1">
              Quantity <span className="text-red-500">*</span>
            </label>
            <input
              type="text"
              value={formData.quantity}
              onChange={(e) => setFormData({ ...formData, quantity: e.target.value })}
              className="w-full h-9 px-3 py-1 text-sm border border-gray-300 rounded-lg focus:ring-2 focus:ring-blue-500"
              placeholder="e.g., 500 KG"
              required
            />
          </div>
          <div>
            <label className="block text-xs font-medium text-gray-700 mb-1">
              Priority <span className="text-red-500">*</span>
            </label>
            <select
              value={formData.priority}
              onChange={(e) => setFormData({ ...formData, priority: e.target.value })}
              className="w-full h-9 px-3 py-1 text-sm border border-gray-300 rounded-lg focus:ring-2 focus:ring-blue-500"
            >
              <option value="low">Low</option>
              <option value="medium">Medium</option>
              <option value="high">High</option>
              <option value="urgent">Urgent</option>
            </select>
          </div>
          <div>
            <label className="block text-xs font-medium text-gray-700 mb-1">
              Inquiry Source
            </label>
            <select
              value={formData.inquiry_source}
              onChange={(e) => setFormData({ ...formData, inquiry_source: e.target.value })}
              className="w-full h-9 px-3 py-1 text-sm border border-gray-300 rounded-lg focus:ring-2 focus:ring-blue-500"
            >
              <option value="email">Email</option>
              <option value="phone">Phone</option>
              <option value="whatsapp">WhatsApp</option>
              <option value="website">Website</option>
              <option value="referral">Referral</option>
              <option value="other">Other</option>
            </select>
          </div>
        </div>

        {/* Row: Supplier Name | Country of Origin | Customer Dropdown */}
        <div className="grid grid-cols-3 gap-3">
          <div>
            <label className="block text-xs font-medium text-gray-700 mb-1">
              Supplier Name
            </label>
            <input
              type="text"
              value={formData.supplier_name}
              onChange={(e) => setFormData({ ...formData, supplier_name: e.target.value })}
              className="w-full h-9 px-3 py-1 text-sm border border-gray-300 rounded-lg focus:ring-2 focus:ring-blue-500"
              placeholder="Manufacturer/Supplier"
            />
          </div>
          <div>
            <label className="block text-xs font-medium text-gray-700 mb-1">
              Country of Origin
            </label>
            <input
              type="text"
              value={formData.supplier_country}
              onChange={(e) => setFormData({ ...formData, supplier_country: e.target.value })}
              className="w-full h-9 px-3 py-1 text-sm border border-gray-300 rounded-lg focus:ring-2 focus:ring-blue-500"
              placeholder="Supplier country"
            />
          </div>
          <div ref={dropdownRef} className="relative">
            <label className="block text-xs font-medium text-gray-700 mb-1">
              Customer <span className="text-red-500">*</span>
            </label>
            <div className="relative">
              <input
                type="text"
                value={customerSearch || formData.company_name}
                onChange={(e) => {
                  setCustomerSearch(e.target.value);
                  setShowCustomerDropdown(true);
                }}
                onFocus={() => setShowCustomerDropdown(true)}
                className="w-full h-9 px-3 py-1 text-sm border border-gray-300 rounded-lg focus:ring-2 focus:ring-blue-500 pr-8"
                placeholder="Search customer..."
                required
              />
              <Search className="absolute right-2 top-2 w-4 h-4 text-gray-400" />
            </div>
            {showCustomerDropdown && (
              <div className="absolute z-50 w-full mt-1 bg-white border border-gray-300 rounded-lg shadow-lg max-h-48 overflow-y-auto">
                {filteredCustomers.map((customer) => (
                  <div
                    key={customer.id}
                    onClick={() => handleCustomerSelect(customer)}
                    className="px-3 py-2 hover:bg-blue-50 cursor-pointer text-sm"
                  >
                    <div className="font-medium">{customer.company_name}</div>
                    {customer.contact_person && (
                      <div className="text-xs text-gray-500">{customer.contact_person}</div>
                    )}
                  </div>
                ))}
                {filteredCustomers.length === 0 && (
                  <div className="px-3 py-2 text-sm text-gray-500">No customers found</div>
                )}
              </div>
            )}
            <button
              type="button"
              onClick={() => setShowAddCustomerModal(true)}
              className="mt-1 text-xs text-blue-600 hover:text-blue-700 flex items-center gap-1"
            >
              <Plus className="w-3 h-3" />
              Add New Customer
            </button>
          </div>
        </div>

        {/* Row: Contact Person | Email | Phone */}
        <div className="grid grid-cols-3 gap-3">
          <div>
            <label className="block text-xs font-medium text-gray-700 mb-1">
              Contact Person
            </label>
            <input
              type="text"
              value={formData.contact_person}
              onChange={(e) => setFormData({ ...formData, contact_person: e.target.value })}
              className="w-full h-9 px-3 py-1 text-sm border border-gray-300 rounded-lg focus:ring-2 focus:ring-blue-500"
              placeholder="Name"
            />
          </div>
          <div>
            <label className="block text-xs font-medium text-gray-700 mb-1">
              Email
            </label>
            <input
              type="email"
              value={formData.contact_email}
              onChange={(e) => setFormData({ ...formData, contact_email: e.target.value })}
              className="w-full h-9 px-3 py-1 text-sm border border-gray-300 rounded-lg focus:ring-2 focus:ring-blue-500"
              placeholder="email@example.com"
            />
          </div>
          <div>
            <label className="block text-xs font-medium text-gray-700 mb-1">
              Phone
            </label>
            <input
              type="tel"
              value={formData.contact_phone}
              onChange={(e) => setFormData({ ...formData, contact_phone: e.target.value })}
              className="w-full h-9 px-3 py-1 text-sm border border-gray-300 rounded-lg focus:ring-2 focus:ring-blue-500"
              placeholder="+62 xxx"
            />
          </div>
        </div>

        {/* Mail Subject - Full Width */}
        <div>
          <label className="block text-xs font-medium text-gray-700 mb-1">
            Mail Subject
          </label>
          <input
            type="text"
            value={formData.mail_subject}
            onChange={(e) => setFormData({ ...formData, mail_subject: e.target.value })}
            className="w-full h-9 px-3 py-1 text-sm border border-gray-300 rounded-lg focus:ring-2 focus:ring-blue-500"
            placeholder="Email subject line"
          />
        </div>

        {/* Customer Requested - 5 checkboxes in one row */}
        <div>
          <label className="block text-xs font-medium text-gray-700 mb-2">
            Customer Requested
          </label>
          <div className="grid grid-cols-5 gap-3">
            <label className="flex items-center gap-2 cursor-pointer">
              <input
                type="checkbox"
                checked={formData.price_required}
                onChange={(e) => setFormData({ ...formData, price_required: e.target.checked })}
                className="w-4 h-4 rounded border-gray-300"
              />
              <span className="text-xs text-gray-700">Price</span>
            </label>
            <label className="flex items-center gap-2 cursor-pointer">
              <input
                type="checkbox"
                checked={formData.coa_required}
                onChange={(e) => setFormData({ ...formData, coa_required: e.target.checked })}
                className="w-4 h-4 rounded border-gray-300"
              />
              <span className="text-xs text-gray-700">COA</span>
            </label>
            <label className="flex items-center gap-2 cursor-pointer">
              <input
                type="checkbox"
                checked={formData.sample_required}
                onChange={(e) => setFormData({ ...formData, sample_required: e.target.checked })}
                className="w-4 h-4 rounded border-gray-300"
              />
              <span className="text-xs text-gray-700">Sample</span>
            </label>
            <label className="flex items-center gap-2 cursor-pointer">
              <input
                type="checkbox"
                checked={formData.agency_letter_required}
                onChange={(e) => setFormData({ ...formData, agency_letter_required: e.target.checked })}
                className="w-4 h-4 rounded border-gray-300"
              />
              <span className="text-xs text-gray-700">Agency Letter</span>
            </label>
            <label className="flex items-center gap-2 cursor-pointer">
              <input
                type="checkbox"
                checked={formData.others_required}
                onChange={(e) => setFormData({ ...formData, others_required: e.target.checked })}
                className="w-4 h-4 rounded border-gray-300"
              />
              <span className="text-xs text-gray-700">Others</span>
            </label>
          </div>
        </div>

        <div className="border-t border-gray-200 pt-3">
          <h3 className="text-xs font-semibold text-gray-700 mb-2">Pricing</h3>

          {/* Row: Purchase Price | Currency | Offered Price | Currency */}
          <div className="grid grid-cols-6 gap-2">
            <div className="col-span-2">
              <label className="block text-xs font-medium text-gray-700 mb-1">
                Purchase Price
              </label>
              <input
                type="text"
                value={formData.purchase_price}
                onChange={(e) => setFormData({ ...formData, purchase_price: e.target.value })}
                className="w-full h-9 px-3 py-1 text-sm border border-gray-300 rounded-lg focus:ring-2 focus:ring-blue-500"
                placeholder="100.00"
              />
            </div>
            <div className="col-span-1">
              <label className="block text-xs font-medium text-gray-700 mb-1">
                Currency
              </label>
              <select
                value={formData.purchase_price_currency}
                onChange={(e) => setFormData({ ...formData, purchase_price_currency: e.target.value })}
                className="w-full h-9 px-3 py-1 text-sm border border-gray-300 rounded-lg focus:ring-2 focus:ring-blue-500"
              >
                <option value="USD">USD</option>
                <option value="IDR">IDR</option>
              </select>
            </div>
            <div className="col-span-2">
              <label className="block text-xs font-medium text-gray-700 mb-1">
                Offered Price
              </label>
              <input
                type="text"
                value={formData.offered_price}
                onChange={(e) => setFormData({ ...formData, offered_price: e.target.value })}
                className="w-full h-9 px-3 py-1 text-sm border border-gray-300 rounded-lg focus:ring-2 focus:ring-blue-500"
                placeholder="150.00"
              />
            </div>
            <div className="col-span-1">
              <label className="block text-xs font-medium text-gray-700 mb-1">
                Currency
              </label>
              <select
                value={formData.offered_price_currency}
                onChange={(e) => setFormData({ ...formData, offered_price_currency: e.target.value })}
                className="w-full h-9 px-3 py-1 text-sm border border-gray-300 rounded-lg focus:ring-2 focus:ring-blue-500"
              >
                <option value="USD">USD</option>
                <option value="IDR">IDR</option>
              </select>
            </div>
          </div>
        </div>

        {/* Row: Delivery Date | Delivery Terms */}
        <div className="grid grid-cols-2 gap-3">
          <div>
            <label className="block text-xs font-medium text-gray-700 mb-1">
              Delivery Date
            </label>
            <input
              type="date"
              value={formData.delivery_date}
              onChange={(e) => setFormData({ ...formData, delivery_date: e.target.value })}
              className="w-full h-9 px-3 py-1 text-sm border border-gray-300 rounded-lg focus:ring-2 focus:ring-blue-500"
            />
          </div>
          <div>
            <label className="block text-xs font-medium text-gray-700 mb-1">
              Delivery Terms
            </label>
            <select
              value={formData.delivery_terms}
              onChange={(e) => setFormData({ ...formData, delivery_terms: e.target.value })}
              className="w-full h-9 px-3 py-1 text-sm border border-gray-300 rounded-lg focus:ring-2 focus:ring-blue-500"
            >
              <option value="">Select...</option>
              <option value="FOB Jakarta">FOB Jakarta</option>
              <option value="CIF Jakarta">CIF Jakarta</option>
              <option value="FOB Surabaya">FOB Surabaya</option>
              <option value="CIF Surabaya">CIF Surabaya</option>
              <option value="FOB Semarang">FOB Semarang</option>
              <option value="CIF Semarang">CIF Semarang</option>
              <option value="EXW">EXW</option>
              <option value="DDP">DDP</option>
              <option value="DAP">DAP</option>
              <option value="CFR">CFR</option>
              <option value="FCA">FCA</option>
            </select>
          </div>
        </div>

        {/* Row: ACE ERP No | Pipeline Status */}
        <div className="grid grid-cols-2 gap-3">
          <div>
            <label className="block text-xs font-medium text-gray-700 mb-1">
              ACE ERP No
            </label>
            <input
              type="text"
              value={formData.aceerp_no}
              onChange={(e) => setFormData({ ...formData, aceerp_no: e.target.value })}
              className="w-full h-9 px-3 py-1 text-sm border border-gray-300 rounded-lg focus:ring-2 focus:ring-blue-500"
              placeholder="Optional"
            />
          </div>
          <div>
            <label className="block text-xs font-medium text-gray-700 mb-1">
              Pipeline Status
            </label>
            <select
              value={formData.pipeline_status}
              onChange={(e) => setFormData({ ...formData, pipeline_status: e.target.value })}
              className="w-full h-9 px-3 py-1 text-sm border border-gray-300 rounded-lg focus:ring-2 focus:ring-blue-500"
            >
              <option value="new">New</option>
              <option value="contacted">Contacted</option>
              <option value="qualified">Qualified</option>
              <option value="proposal">Proposal</option>
              <option value="negotiation">Negotiation</option>
              <option value="won">Won</option>
              <option value="lost">Lost</option>
            </select>
          </div>
        </div>

        {/* Remarks - Full Width */}
        <div>
          <label className="block text-xs font-medium text-gray-700 mb-1">
            Remarks
          </label>
          <textarea
            value={formData.remarks}
            onChange={(e) => setFormData({ ...formData, remarks: e.target.value })}
            rows={2}
            className="w-full px-3 py-1 text-sm border border-gray-300 rounded-lg focus:ring-2 focus:ring-blue-500"
            placeholder="Customer notes, special requirements..."
          />
        </div>

        {/* Internal Notes - Full Width */}
        <div>
          <label className="block text-xs font-medium text-gray-700 mb-1">
            Internal Notes
          </label>
          <textarea
            value={formData.internal_notes}
            onChange={(e) => setFormData({ ...formData, internal_notes: e.target.value })}
            rows={2}
            className="w-full px-3 py-1 text-sm border border-gray-300 rounded-lg focus:ring-2 focus:ring-blue-500"
            placeholder="Private notes (not visible to customer)..."
          />
        </div>

        {/* Action Buttons */}
        <div className="flex justify-end gap-3 pt-3 border-t border-gray-200 sticky bottom-0 bg-white">
          <button
            type="button"
            onClick={onCancel}
            className="px-4 py-2 text-sm border border-gray-300 rounded-lg hover:bg-gray-50 transition"
            disabled={submitting}
          >
            Cancel
          </button>
          <button
            type="submit"
            className="px-4 py-2 text-sm bg-blue-600 text-white rounded-lg hover:bg-blue-700 transition disabled:opacity-50"
            disabled={submitting}
          >
            {submitting ? 'Saving...' : (isEditing ? 'Update Inquiry' : 'Add Inquiry')}
          </button>
        </div>
      </form>

      {/* Add Customer Modal */}
      {showAddCustomerModal && (
        <div className="fixed inset-0 bg-black bg-opacity-50 flex items-center justify-center z-50">
          <div className="bg-white rounded-lg shadow-xl p-6 w-full max-w-md max-h-[90vh] overflow-y-auto">
            <div className="flex items-center justify-between mb-4">
              <h3 className="text-lg font-semibold">Add New Customer</h3>
              <button
                onClick={() => setShowAddCustomerModal(false)}
                className="text-gray-400 hover:text-gray-600"
              >
                <X className="w-5 h-5" />
              </button>
            </div>
            <div className="space-y-3">
              <div>
                <label className="block text-xs font-medium text-gray-700 mb-1">
                  Company Name <span className="text-red-500">*</span>
                </label>
                <input
                  type="text"
                  value={newCustomer.company_name}
                  onChange={(e) => setNewCustomer({ ...newCustomer, company_name: e.target.value })}
                  className="w-full h-9 px-3 py-1 text-sm border border-gray-300 rounded-lg focus:ring-2 focus:ring-blue-500"
                  placeholder="Company name"
                />
              </div>
              <div>
                <label className="block text-xs font-medium text-gray-700 mb-1">
                  Contact Person
                </label>
                <input
                  type="text"
                  value={newCustomer.contact_person}
                  onChange={(e) => setNewCustomer({ ...newCustomer, contact_person: e.target.value })}
                  className="w-full h-9 px-3 py-1 text-sm border border-gray-300 rounded-lg focus:ring-2 focus:ring-blue-500"
                  placeholder="Contact name"
                />
              </div>
              <div>
                <label className="block text-xs font-medium text-gray-700 mb-1">
                  Email
                </label>
                <input
                  type="email"
                  value={newCustomer.email}
                  onChange={(e) => setNewCustomer({ ...newCustomer, email: e.target.value })}
                  className="w-full h-9 px-3 py-1 text-sm border border-gray-300 rounded-lg focus:ring-2 focus:ring-blue-500"
                  placeholder="email@example.com"
                />
              </div>
              <div className="grid grid-cols-3 gap-3">
                <div>
                  <label className="block text-xs font-medium text-gray-700 mb-1">
                    Mobile
                  </label>
                  <input
                    type="tel"
                    value={newCustomer.mobile}
                    onChange={(e) => setNewCustomer({ ...newCustomer, mobile: e.target.value })}
                    className="w-full h-9 px-3 py-1 text-sm border border-gray-300 rounded-lg focus:ring-2 focus:ring-blue-500"
                    placeholder="+62 xxx"
                  />
                </div>
                <div>
                  <label className="block text-xs font-medium text-gray-700 mb-1">
                    Landline
                  </label>
                  <input
                    type="tel"
                    value={newCustomer.landline}
                    onChange={(e) => setNewCustomer({ ...newCustomer, landline: e.target.value })}
                    className="w-full h-9 px-3 py-1 text-sm border border-gray-300 rounded-lg focus:ring-2 focus:ring-blue-500"
                    placeholder="021-xxx"
                  />
                </div>
                <div>
                  <label className="block text-xs font-medium text-gray-700 mb-1">
                    Phone
                  </label>
                  <input
                    type="tel"
                    value={newCustomer.phone}
                    onChange={(e) => setNewCustomer({ ...newCustomer, phone: e.target.value })}
                    className="w-full h-9 px-3 py-1 text-sm border border-gray-300 rounded-lg focus:ring-2 focus:ring-blue-500"
                    placeholder="Other"
                  />
                </div>
              </div>
              <div>
                <label className="block text-xs font-medium text-gray-700 mb-1">
                  Country
                </label>
                <input
                  type="text"
                  value={newCustomer.country}
                  onChange={(e) => setNewCustomer({ ...newCustomer, country: e.target.value })}
                  className="w-full h-9 px-3 py-1 text-sm border border-gray-300 rounded-lg focus:ring-2 focus:ring-blue-500"
                  placeholder="Indonesia"
                />
              </div>
              <div>
                <label className="block text-xs font-medium text-gray-700 mb-1">
                  Address
                </label>
                <textarea
                  value={newCustomer.address}
                  onChange={(e) => setNewCustomer({ ...newCustomer, address: e.target.value })}
                  rows={2}
                  className="w-full px-3 py-1 text-sm border border-gray-300 rounded-lg focus:ring-2 focus:ring-blue-500"
                  placeholder="Full address"
                />
              </div>
            </div>
            <div className="flex justify-end gap-3 mt-4">
              <button
                onClick={() => setShowAddCustomerModal(false)}
                className="px-4 py-2 text-sm border border-gray-300 rounded-lg hover:bg-gray-50 transition"
              >
                Cancel
              </button>
              <button
                onClick={handleAddCustomer}
                className="px-4 py-2 text-sm bg-blue-600 text-white rounded-lg hover:bg-blue-700 transition"
              >
                Add Customer
              </button>
            </div>
          </div>
        </div>
      )}
    </>
  );
}
