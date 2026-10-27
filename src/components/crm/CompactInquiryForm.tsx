import { useState, useEffect, useRef, useMemo } from 'react';
import { supabase } from '../../lib/supabase';
import {
  findOrCreateCrmContact,
} from '../../utils/customerValidation';
import { Plus, X, Search } from 'lucide-react';
import { useAuth } from '../../contexts/AuthContext';
import { SearchableSelect } from '../SearchableSelect';
import { useDebounce } from '../../hooks/useDebounce';
import {
  searchHistoricalProducts,
  searchHistoricalSpecifications,
  getHistoricalCountrySuggestions,
} from '../../services/crmInquirySuggestions';
import { FloatingField, FLOAT_INPUT, FLOAT_TEXTAREA } from '../finance/FloatingField';
import { SapRow } from '../finance/SapLayout';

interface Customer {
  id: string;
  company_name: string;
  contact_person: string | null;
  email: string | null;
  phone: string | null;
  country: string | null;
  address: string | null;
  city: string | null;
}

interface CompactInquiryFormProps {
  onSubmit: (data: any) => Promise<void>;
  onCancel: () => void;
  initialData?: any;
  isEditing?: boolean;
}

export function CompactInquiryForm({ onSubmit, onCancel, initialData, isEditing = false }: CompactInquiryFormProps) {
  const { profile } = useAuth();
  const [customers, setCustomers] = useState<Customer[]>([]);
  const [filteredCustomers, setFilteredCustomers] = useState<Customer[]>([]);
  const [customerSearch, setCustomerSearch] = useState('');
  const [showCustomerDropdown, setShowCustomerDropdown] = useState(false);
  const [showAddCustomerModal, setShowAddCustomerModal] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const dropdownRef = useRef<HTMLDivElement>(null);

  const [productSuggestions, setProductSuggestions] = useState<string[]>([]);
  const [specSuggestions, setSpecSuggestions] = useState<string[]>([]);
  const [countrySuggestions, setCountrySuggestions] = useState<string[]>([]);
  const [loadingProducts, setLoadingProducts] = useState(false);
  const [loadingSpecs, setLoadingSpecs] = useState(false);
  const [loadingCountries, setLoadingCountries] = useState(false);

  const [formData, setFormData] = useState({
    product_name: initialData?.product_name || '',
    specification: initialData?.specification || '',
    quantity: initialData?.quantity || '',
    priority: initialData?.priority || 'medium',
    inquiry_source: initialData?.inquiry_source || 'email',
    supplier_name: initialData?.supplier_name || '',
    supplier_country: initialData?.supplier_country || '',
    crm_contact_id: initialData?.crm_contact_id || '',
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
    is_multi_product: initialData?.is_multi_product || false,
    products: initialData?.products || [],
  });

  const [newCustomer, setNewCustomer] = useState({
    company_name: '',
    contact_person: '',
    email: '',
    phone: '',
    country: 'Indonesia',
    address: '',
    city: 'Jakarta Pusat',
    npwp: '',
    pbf_license: '',
    gst_vat_type: '',
    payment_terms: '',
  });

  useEffect(() => {
    loadCustomers();
  }, []);

  const debouncedProductQuery = useDebounce(formData.product_name, 250);
  const debouncedSpecQuery = useDebounce(formData.specification, 250);
  const debouncedCountryQuery = useDebounce(formData.supplier_country, 250);

  useEffect(() => {
    let active = true;
    if (!debouncedProductQuery || debouncedProductQuery.trim().length < 1) {
      setProductSuggestions([]);
      return;
    }
    setLoadingProducts(true);
    searchHistoricalProducts(debouncedProductQuery)
      .then((res) => {
        if (active) setProductSuggestions(res);
      })
      .catch(() => {
        if (active) setProductSuggestions([]);
      })
      .finally(() => {
        if (active) setLoadingProducts(false);
      });
    return () => {
      active = false;
    };
  }, [debouncedProductQuery]);

  useEffect(() => {
    let active = true;
    if (!debouncedSpecQuery || debouncedSpecQuery.trim().length < 1) {
      setSpecSuggestions([]);
      return;
    }
    setLoadingSpecs(true);
    searchHistoricalSpecifications(debouncedSpecQuery)
      .then((res) => {
        if (active) setSpecSuggestions(res);
      })
      .catch(() => {
        if (active) setSpecSuggestions([]);
      })
      .finally(() => {
        if (active) setLoadingSpecs(false);
      });
    return () => {
      active = false;
    };
  }, [debouncedSpecQuery]);

  useEffect(() => {
    let active = true;
    setLoadingCountries(true);
    getHistoricalCountrySuggestions(debouncedCountryQuery)
      .then((res) => {
        if (active) setCountrySuggestions(res);
      })
      .catch(() => {
        if (active) setCountrySuggestions(['India', 'China']);
      })
      .finally(() => {
        if (active) setLoadingCountries(false);
      });
    return () => {
      active = false;
    };
  }, [debouncedCountryQuery]);

  const productOptions = useMemo(
    () => productSuggestions.map((name) => ({ value: name, label: name })),
    [productSuggestions]
  );
  const specOptions = useMemo(
    () => specSuggestions.map((name) => ({ value: name, label: name })),
    [specSuggestions]
  );
  const countryOptions = useMemo(
    () => countrySuggestions.map((name) => ({ value: name, label: name })),
    [countrySuggestions]
  );

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
      // CRM Inquiry customer picker searches the CRM prospect master
      // (crm_contacts), not the ERP customers table.
      const { data, error } = await supabase
        .from('crm_contacts')
        .select('id, company_name, contact_person, email, phone, country, address, city')
        .eq('is_active', true)
        .order('company_name');

      if (error) throw error;
      setCustomers(data || []);
      setFilteredCustomers(data || []);
    } catch (error) {
      console.error('Error loading CRM contacts:', error);
    }
  };

  const handleCustomerSelect = (customer: Customer) => {
    setFormData({
      ...formData,
      crm_contact_id: customer.id,
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
      // Reuse an existing crm_contacts row when the company already exists
      // (case/space-insensitive) — never create duplicates.
      const { contact, created } = await findOrCreateCrmContact({
        company_name:   newCustomer.company_name,
        contact_person: newCustomer.contact_person,
        email:          newCustomer.email,
        phone:          newCustomer.phone,
        country:        newCustomer.country,
        address:        newCustomer.address,
        city:           newCustomer.city,
      });

      await loadCustomers();
      handleCustomerSelect(contact);
      setShowAddCustomerModal(false);
      setNewCustomer({
        company_name: '',
        contact_person: '',
        email: '',
        phone: '',
        country: 'Indonesia',
        address: '',
        city: 'Jakarta Pusat',
        npwp: '',
        pbf_license: '',
        gst_vat_type: '',
        payment_terms: '',
      });
      if (!created) {
        alert(`Reusing existing CRM customer: ${contact.company_name}`);
      }
    } catch (error: any) {
      console.error('Error adding CRM contact:', error);
      alert(error?.message || 'Failed to add CRM customer');
    }
  };

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();

    // Skip product validation for multi-product inquiries
    if (!formData.is_multi_product) {
      if (!formData.product_name || !formData.quantity || !formData.company_name) {
        alert('Please fill in all required fields: Product Name, Quantity, and Customer');
        return;
      }
    } else {
      if (!formData.company_name) {
        alert('Please fill in Customer');
        return;
      }
    }

    setSubmitting(true);
    try {
      await onSubmit(formData);
    } finally {
      setSubmitting(false);
    }
  };

  const addProduct = () => {
    setFormData({
      ...formData,
      products: [
        ...formData.products,
        {
          productName: '',
          specification: '',
          quantity: '',
          supplierName: '',
          supplierCountry: '',
          deliveryDate: '',
          deliveryTerms: ''
        }
      ]
    });
  };

  const removeProduct = (index: number) => {
    setFormData({
      ...formData,
      products: formData.products.filter((_item: (typeof formData.products)[number], i: number) => i !== index)
    });
  };

  const updateProduct = (index: number, field: string, value: string) => {
    const updatedProducts = [...formData.products];
    updatedProducts[index] = { ...updatedProducts[index], [field]: value };
    setFormData({ ...formData, products: updatedProducts });
  };

  return (
    <>
      <form onSubmit={handleSubmit} className="space-y-3">
        {/* Multi-Product Toggle */}
        <div className="flex items-center gap-2 p-3 bg-blue-50 rounded-lg border border-blue-200">
          <input
            type="checkbox"
            id="multiProductToggle"
            checked={formData.is_multi_product}
            onChange={(e) => {
              const isMulti = e.target.checked;
              setFormData({
                ...formData,
                is_multi_product: isMulti,
                products: isMulti && formData.products.length === 0
                  ? [{
                      productName: '',
                      specification: '',
                      quantity: '',
                      supplierName: '',
                      supplierCountry: '',
                      deliveryDate: '',
                      deliveryTerms: ''
                    }]
                  : formData.products
              });
            }}
            className="w-4 h-4 text-blue-600 border-gray-300 rounded focus:ring-blue-500"
          />
          <label htmlFor="multiProductToggle" className="text-sm font-medium text-gray-700 cursor-pointer">
            Multi-Product Inquiry (Common data will be applied to all products)
          </label>
        </div>

        {/* Multi-Product Products List */}
        {formData.is_multi_product && (
          <div className="space-y-3 p-3 bg-gray-50 rounded-lg border border-gray-200">
            <div className="flex items-center justify-between">
              <span className="text-xs font-semibold text-gray-700 uppercase tracking-wider">
                Products ({formData.products.length})
              </span>
              <button
                type="button"
                onClick={addProduct}
                className="inline-flex items-center gap-1 px-2.5 py-1 text-xs bg-blue-50 text-blue-600 hover:bg-blue-100 rounded-md font-medium transition"
              >
                <Plus className="w-3.5 h-3.5" /> Add Another Product
              </button>
            </div>

            {(formData.products as any[]).map((prod: any, index: number) => (
              <div key={index} className="grid grid-cols-12 gap-2 p-2 bg-white rounded border border-gray-200 items-end">
                <div className="col-span-5">
                  <label className="block text-xs font-medium text-gray-700 mb-1">
                    Product Name <span className="text-red-500">*</span>
                  </label>
                  <input
                    type="text"
                    value={prod.productName}
                    onChange={(e) => updateProduct(index, 'productName', e.target.value)}
                    placeholder="e.g., Paracetamol IP"
                    className="w-full h-8 px-2 text-sm border border-gray-300 rounded focus:ring-1 focus:ring-blue-500"
                    required
                  />
                </div>
                <div className="col-span-3">
                  <label className="block text-xs font-medium text-gray-700 mb-1">
                    Specification
                  </label>
                  <input
                    type="text"
                    value={prod.specification}
                    onChange={(e) => updateProduct(index, 'specification', e.target.value)}
                    placeholder="USP / BP"
                    className="w-full h-8 px-2 text-sm border border-gray-300 rounded focus:ring-1 focus:ring-blue-500"
                  />
                </div>
                <div className="col-span-3">
                  <label className="block text-xs font-medium text-gray-700 mb-1">
                    Quantity <span className="text-red-500">*</span>
                  </label>
                  <input
                    type="text"
                    value={prod.quantity}
                    onChange={(e) => updateProduct(index, 'quantity', e.target.value)}
                    placeholder="e.g., 500 KG"
                    className="w-full h-8 px-2 text-sm border border-gray-300 rounded focus:ring-1 focus:ring-blue-500"
                    required
                  />
                </div>
                <div className="col-span-1 flex justify-center pb-1">
                  {formData.products.length > 1 && (
                    <button
                      type="button"
                      onClick={() => removeProduct(index)}
                      className="text-red-500 hover:text-red-700 p-1"
                      title="Remove product"
                    >
                      <X className="w-4 h-4" />
                    </button>
                  )}
                </div>
              </div>
            ))}
          </div>
        )}

        {/* Row: Product Name | Specification */}
        {!formData.is_multi_product && (
          <SapRow>
            <FloatingField label="Product Name" required span={6} filled={!!formData.product_name}>
              <SearchableSelect
                id="inquiry_product_name"
                name="product_name"
                aria-label="Enter product name"
                freeSolo
                filterOptions={false}
                value={formData.product_name}
                onChange={(val) => setFormData((prev) => ({ ...prev, product_name: val }))}
                options={productOptions}
                loading={loadingProducts}
                placeholder="Enter product name"
                required
              />
            </FloatingField>
            <FloatingField label="Specification" span={6} filled={!!formData.specification}>
              <SearchableSelect
                id="inquiry_specification"
                name="specification"
                aria-label="Specification"
                freeSolo
                filterOptions={false}
                value={formData.specification}
                onChange={(val) => setFormData((prev) => ({ ...prev, specification: val }))}
                options={specOptions}
                loading={loadingSpecs}
                placeholder="BP / USP / EP"
              />
            </FloatingField>
          </SapRow>
        )}

        {/* Row: Quantity | Priority | Inquiry Source */}
        <SapRow>
          {!formData.is_multi_product && (
            <FloatingField label="Quantity" required span={4} filled={!!formData.quantity}>
              <input name="quantity" aria-label="e.g., 500 KG"
                type="text"
                value={formData.quantity}
                onChange={(e) => setFormData({ ...formData, quantity: e.target.value })}
                className={FLOAT_INPUT}
                placeholder="e.g., 500 KG"
                required
              />
            </FloatingField>
          )}
          <FloatingField label="Priority" required span={formData.is_multi_product ? 4 : 4} filled={!!formData.priority}>
            <select name="priority" aria-label="Priority"
              value={formData.priority}
              onChange={(e) => setFormData({ ...formData, priority: e.target.value })}
              className={FLOAT_INPUT}
            >
              <option value="low">Low</option>
              <option value="medium">Medium</option>
              <option value="high">High</option>
              <option value="urgent">Urgent</option>
            </select>
          </FloatingField>
          <FloatingField label="Inquiry Source" span={formData.is_multi_product ? 8 : 4} filled={!!formData.inquiry_source}>
            <select name="inquiry_source" aria-label="Inquiry Source"
              value={formData.inquiry_source}
              onChange={(e) => setFormData({ ...formData, inquiry_source: e.target.value })}
              className={FLOAT_INPUT}
            >
              <option value="email">Email</option>
              <option value="phone">Phone</option>
              <option value="whatsapp">WhatsApp</option>
              <option value="website">Website</option>
              <option value="referral">Referral</option>
              <option value="other">Other</option>
            </select>
          </FloatingField>
        </SapRow>

        {/* Row: Supplier Name | Country of Origin | Customer Dropdown */}
        <SapRow>
          <FloatingField label="Supplier Name" span={4} filled={!!formData.supplier_name}>
            <input name="supplier_name" aria-label="Supplier Name"
              type="text"
              value={formData.supplier_name}
              onChange={(e) => setFormData({ ...formData, supplier_name: e.target.value })}
              className={FLOAT_INPUT}
              placeholder="Manufacturer/Supplier"
            />
          </FloatingField>
          <FloatingField label="Country of Origin" span={4} filled={!!formData.supplier_country}>
            <SearchableSelect
              id="inquiry_country_of_origin"
              name="country_of_origin"
              aria-label="Country of Origin"
              freeSolo
              filterOptions={false}
              value={formData.supplier_country}
              onChange={(val) => setFormData((prev) => ({ ...prev, supplier_country: val }))}
              options={countryOptions}
              loading={loadingCountries}
              placeholder="Supplier country"
            />
          </FloatingField>
          <div ref={dropdownRef} className="relative sm:col-span-4 min-w-0">
            <FloatingField label="Customer" required span={12} filled={!!(customerSearch || formData.company_name)}>
              <div className="relative">
                <input name="company_name" aria-label="Search customer..."
                  type="text"
                  value={customerSearch || formData.company_name}
                  onChange={(e) => {
                    const val = e.target.value;
                    setCustomerSearch(val);
                    setFormData(prev => ({
                      ...prev,
                      company_name: val,
                      crm_contact_id: prev.company_name === val ? prev.crm_contact_id : '',
                    }));
                    setShowCustomerDropdown(true);
                  }}
                  onFocus={() => setShowCustomerDropdown(true)}
                  className={`${FLOAT_INPUT} pr-8`}
                  placeholder="Search customer..."
                  required
                />
                <Search className="absolute right-2 top-2 w-4 h-4 text-gray-400" />
              </div>
            </FloatingField>
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
        </SapRow>

        {/* Row: Contact Person | Email | Phone */}
        <SapRow>
          <FloatingField label="Contact Person" span={4} filled={!!formData.contact_person}>
            <input name="contact_person" aria-label="Contact Person"
              type="text"
              value={formData.contact_person}
              onChange={(e) => setFormData({ ...formData, contact_person: e.target.value })}
              className={FLOAT_INPUT}
              placeholder="Name"
            />
          </FloatingField>
          <FloatingField label="Email" span={4} filled={!!formData.contact_email} hint="Use comma (,) or semicolon (;) to separate multiple emails">
            <input name="email" aria-label="Email"
              type="text"
              value={formData.contact_email}
              onChange={(e) => setFormData({ ...formData, contact_email: e.target.value })}
              className={FLOAT_INPUT}
              placeholder="email@example.com or multiple: email1@example.com, email2@example.com"
            />
          </FloatingField>
          <FloatingField label="Phone" span={4} filled={!!formData.contact_phone}>
            <input name="phone" aria-label="Phone"
              type="tel"
              value={formData.contact_phone}
              onChange={(e) => setFormData({ ...formData, contact_phone: e.target.value })}
              className={FLOAT_INPUT}
              placeholder="+62 xxx"
            />
          </FloatingField>
        </SapRow>

        {/* Mail Subject - Full Width */}
        <SapRow>
          <FloatingField label="Mail Subject" span={12} filled={!!formData.mail_subject}>
            <input name="mail_subject" aria-label="Mail Subject"
              type="text"
              value={formData.mail_subject}
              onChange={(e) => setFormData({ ...formData, mail_subject: e.target.value })}
              className={FLOAT_INPUT}
              placeholder="Email subject line"
            />
          </FloatingField>
        </SapRow>

        {/* Customer Requested - 5 checkboxes in one row */}
        <div>
          <label className="block text-xs font-medium text-gray-700 mb-2">
            Customer Requested
          </label>
          <div className="grid grid-cols-5 gap-3">
            <label className="flex items-center gap-2 cursor-pointer">
              <input name="customer_requested" aria-label="Customer Requested"
                type="checkbox"
                checked={formData.price_required}
                onChange={(e) => setFormData({ ...formData, price_required: e.target.checked })}
                className="w-4 h-4 rounded border-gray-300"
              />
              <span className="text-xs text-gray-700">Price</span>
            </label>
            <label className="flex items-center gap-2 cursor-pointer">
              <input name="coa_required" aria-label="Coa Required"
                type="checkbox"
                checked={formData.coa_required}
                onChange={(e) => setFormData({ ...formData, coa_required: e.target.checked })}
                className="w-4 h-4 rounded border-gray-300"
              />
              <span className="text-xs text-gray-700">COA</span>
            </label>
            <label className="flex items-center gap-2 cursor-pointer">
              <input name="sample_required" aria-label="Sample Required"
                type="checkbox"
                checked={formData.sample_required}
                onChange={(e) => setFormData({ ...formData, sample_required: e.target.checked })}
                className="w-4 h-4 rounded border-gray-300"
              />
              <span className="text-xs text-gray-700">Sample</span>
            </label>
            <label className="flex items-center gap-2 cursor-pointer">
              <input name="agency_letter_required" aria-label="Agency Letter Required"
                type="checkbox"
                checked={formData.agency_letter_required}
                onChange={(e) => setFormData({ ...formData, agency_letter_required: e.target.checked })}
                className="w-4 h-4 rounded border-gray-300"
              />
              <span className="text-xs text-gray-700">Agency Letter</span>
            </label>
            <label className="flex items-center gap-2 cursor-pointer">
              <input name="others_required" aria-label="Others Required"
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

          {/* Row: Purchase Price (Admin Only) | Offered Price | Currency */}
          <SapRow>
            {profile?.role === 'admin' && (
              <>
                <FloatingField label="Purchase Price" span={4} filled={!!formData.purchase_price}>
                  <input name="purchase_price" aria-label="Purchase Price"
                    type="text"
                    value={formData.purchase_price}
                    onChange={(e) => setFormData({ ...formData, purchase_price: e.target.value })}
                    className={FLOAT_INPUT}
                    placeholder="100.00"
                  />
                </FloatingField>
                <FloatingField label="Currency" span={2} filled={!!formData.purchase_price_currency}>
                  <select name="currency" aria-label="Currency"
                    value={formData.purchase_price_currency}
                    onChange={(e) => setFormData({ ...formData, purchase_price_currency: e.target.value })}
                    className={FLOAT_INPUT}
                  >
                    <option value="USD">USD</option>
                    <option value="IDR">IDR</option>
                  </select>
                </FloatingField>
              </>
            )}
            <FloatingField label="Offered Price" span={profile?.role === 'admin' ? 4 : 8} filled={!!formData.offered_price}>
              <input name="offered_price" aria-label="Offered Price"
                type="text"
                value={formData.offered_price}
                onChange={(e) => setFormData({ ...formData, offered_price: e.target.value })}
                className={FLOAT_INPUT}
                placeholder="150.00"
              />
            </FloatingField>
            <FloatingField label="Currency" span={profile?.role === 'admin' ? 2 : 4} filled={!!formData.offered_price_currency}>
              <select name="currency" aria-label="Currency"
                value={formData.offered_price_currency}
                onChange={(e) => setFormData({ ...formData, offered_price_currency: e.target.value })}
                className={FLOAT_INPUT}
              >
                <option value="USD">USD</option>
                <option value="IDR">IDR</option>
              </select>
            </FloatingField>
          </SapRow>
        </div>

        {/* Delivery Date and Terms (always shown) */}
        <SapRow>
          <FloatingField label="Delivery Date" span={6} filled={!!formData.delivery_date}>
            <input name="delivery_date" aria-label="Delivery Date"
              type="date"
              value={formData.delivery_date}
              onChange={(e) => setFormData({ ...formData, delivery_date: e.target.value })}
              className={FLOAT_INPUT}
            />
          </FloatingField>
          <FloatingField label="Delivery Terms" span={6} filled={!!formData.delivery_terms}>
            <select name="delivery_terms" aria-label="Delivery Terms"
              value={formData.delivery_terms}
              onChange={(e) => setFormData({ ...formData, delivery_terms: e.target.value })}
              className={FLOAT_INPUT}
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
          </FloatingField>
        </SapRow>

        {/* Row: ACE ERP No | Pipeline Status */}
        <SapRow>
          <FloatingField label="ACE ERP No" span={6} filled={!!formData.aceerp_no}>
            <input name="ace_erp_no" aria-label="ACE ERP No"
              type="text"
              value={formData.aceerp_no}
              onChange={(e) => setFormData({ ...formData, aceerp_no: e.target.value })}
              className={FLOAT_INPUT}
              placeholder="Optional"
            />
          </FloatingField>
          <FloatingField label="Pipeline Status" span={6} filled={!!formData.pipeline_status}>
            <select name="pipeline_status" aria-label="Pipeline Status"
              value={formData.pipeline_status}
              onChange={(e) => setFormData({ ...formData, pipeline_status: e.target.value })}
              className={FLOAT_INPUT}
            >
              <option value="new">New</option>
              <option value="in_progress">In Progress</option>
              <option value="follow_up">Follow Up</option>
              <option value="won">Won</option>
              <option value="lost">Lost</option>
              <option value="on_hold">On Hold</option>
            </select>
          </FloatingField>
        </SapRow>

        {/* Remarks - Full Width */}
        <SapRow>
          <FloatingField label="Remarks" textarea span={12} filled={!!formData.remarks}>
            <textarea name="remarks" aria-label="Remarks"
              value={formData.remarks}
              onChange={(e) => setFormData({ ...formData, remarks: e.target.value })}
              rows={2}
              className={FLOAT_TEXTAREA}
              placeholder="Customer notes, special requirements..."
            />
          </FloatingField>
        </SapRow>

        {/* Internal Notes - Full Width */}
        <SapRow>
          <FloatingField label="Internal Notes" textarea span={12} filled={!!formData.internal_notes}>
            <textarea name="internal_notes" aria-label="Internal Notes"
              value={formData.internal_notes}
              onChange={(e) => setFormData({ ...formData, internal_notes: e.target.value })}
              rows={2}
              className={FLOAT_TEXTAREA}
              placeholder="Private notes (not visible to customer)..."
            />
          </FloatingField>
        </SapRow>

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
              <SapRow>
                <FloatingField label="Company Name" required span={6} filled={!!newCustomer.company_name}>
                  <input name="company_name" aria-label="Company name"
                    type="text"
                    value={newCustomer.company_name}
                    onChange={(e) => setNewCustomer({ ...newCustomer, company_name: e.target.value })}
                    className={FLOAT_INPUT}
                    placeholder="Company name"
                  />
                </FloatingField>
                <FloatingField label="Contact Person" span={6} filled={!!newCustomer.contact_person}>
                  <input name="contact_person" aria-label="Contact Person"
                    type="text"
                    value={newCustomer.contact_person}
                    onChange={(e) => setNewCustomer({ ...newCustomer, contact_person: e.target.value })}
                    className={FLOAT_INPUT}
                    placeholder="Contact name"
                  />
                </FloatingField>
              </SapRow>
              <SapRow>
                <FloatingField label="Email" span={6} filled={!!newCustomer.email}>
                  <input name="email" aria-label="Email"
                    type="text"
                    value={newCustomer.email}
                    onChange={(e) => setNewCustomer({ ...newCustomer, email: e.target.value })}
                    className={FLOAT_INPUT}
                    placeholder="email@example.com"
                  />
                </FloatingField>
                <FloatingField label="Phone" span={6} filled={!!newCustomer.phone}>
                  <input name="phone" aria-label="Phone"
                    type="tel"
                    value={newCustomer.phone}
                    onChange={(e) => setNewCustomer({ ...newCustomer, phone: e.target.value })}
                    className={FLOAT_INPUT}
                    placeholder="+62 xxx"
                  />
                </FloatingField>
              </SapRow>
              <SapRow>
                <FloatingField label="Country" span={6} filled={!!newCustomer.country}>
                  <input name="country" aria-label="Country"
                    type="text"
                    value={newCustomer.country}
                    onChange={(e) => setNewCustomer({ ...newCustomer, country: e.target.value })}
                    className={FLOAT_INPUT}
                    placeholder="Indonesia"
                  />
                </FloatingField>
                <FloatingField label="Address" textarea span={6} filled={!!newCustomer.address}>
                  <textarea name="address" aria-label="Address"
                    value={newCustomer.address}
                    onChange={(e) => setNewCustomer({ ...newCustomer, address: e.target.value })}
                    rows={2}
                    className={FLOAT_TEXTAREA}
                    placeholder="Full address"
                  />
                </FloatingField>
              </SapRow>
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
