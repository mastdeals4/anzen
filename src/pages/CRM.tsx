import { useEffect, useState } from 'react';
import { Layout } from '../components/Layout';
import { Modal } from '../components/Modal';
import { useAuth } from '../contexts/AuthContext';
import { useLanguage } from '../contexts/LanguageContext';
import { useNavigation } from '../contexts/NavigationContext';
import { supabase } from '../lib/supabase';
import {
  Inbox,
  Table,
  Send,
  Users,
  Search,
  Plus,
  SlidersHorizontal,
  RefreshCw,
  FileText,
} from 'lucide-react';

import { CrmOmnichannelInbox } from '../components/crm/inbox/CrmOmnichannelInbox';
import { CrmInquiriesWorkspace } from '../components/crm/inquiries/CrmInquiriesWorkspace';
import { CrmInquiryDrawer } from '../components/crm/inquiries/CrmInquiryDrawer';
import { CrmBulkEmailWorkspace } from '../components/crm/bulk-email/CrmBulkEmailWorkspace';
import { CrmCustomersWorkspace } from '../components/crm/customers/CrmCustomersWorkspace';
import { CrmCustomerDrawer, CustomerDetail } from '../components/crm/customers/CrmCustomerDrawer';
import { CrmGlobalSearchModal } from '../components/crm/search/CrmGlobalSearchModal';
import { CrmSettingsModal } from '../components/crm/settings/CrmSettingsModal';
import { EnquiryControlCenter } from '../components/crm/enquiry-control-center';
import { ProductDocumentsPanel } from '../components/crm/ProductDocumentsPanel';
import { CompactInquiryForm } from '../components/crm/CompactInquiryForm';
import { CustomerSelectionDialog } from '../components/crm/CustomerSelectionDialog';
import { CustomerConfirmationDialog } from '../components/crm/CustomerConfirmationDialog';
import { CustomerUpdateDialog } from '../components/crm/CustomerUpdateDialog';
import { registerRecentInquiryValues } from '../services/crmInquirySuggestions';
import {
  ensureUniqueCrmContactName,
  findOrCreateCrmContact,
  isDuplicateCrmContactError,
} from '../utils/customerValidation';
import { fuzzyMatchCompanyName, detectCustomerChanges, findBestMatch } from '../utils/customerMatching';

export type CrmPrimaryTab = 'inbox' | 'inquiries' | 'bulk_email' | 'customers' | 'control-center' | 'documents';

export interface Inquiry {
  id: string;
  inquiry_number: string;
  inquiry_date: string;
  product_name: string;
  specification?: string | null;
  quantity: string;
  supplier_name: string | null;
  supplier_country: string | null;
  company_name: string;
  contact_person: string | null;
  contact_email: string | null;
  contact_phone: string | null;
  email_subject: string | null;
  mail_subject?: string | null;
  status: string;
  pipeline_status?: string;
  assigned_to?: string | null;
  next_follow_up?: string | null;
  priority: string;
  coa_sent: boolean;
  coa_sent_date: string | null;
  msds_sent: boolean;
  msds_sent_date: string | null;
  sample_sent: boolean;
  sample_sent_date: string | null;
  price_quoted: boolean;
  price_quoted_date: string | null;
  price_required?: boolean;
  coa_required?: boolean;
  sample_required?: boolean;
  agency_letter_required?: boolean;
  price_sent_at?: string | null;
  coa_sent_at?: string | null;
  sample_sent_at?: string | null;
  agency_letter_sent_at?: string | null;
  aceerp_no?: string | null;
  purchase_price?: number | null;
  purchase_price_currency?: string;
  offered_price?: number | null;
  offered_price_currency?: string;
  delivery_date?: string | null;
  delivery_terms?: string | null;
  lost_reason?: string | null;
  lost_at?: string | null;
  competitor_name?: string | null;
  competitor_price?: number | null;
  remarks: string | null;
  internal_notes: string | null;
  created_at: string;
  price_ready?: boolean;
  source_type?: string | null;
  source_status?: string | null;
  document_status?: string | null;
  kunal_price_status?: string | null;
  quote_status?: string | null;
  quote_sent_at?: string | null;
  last_sourcing_sent_at?: string | null;
  last_reminder_sent_at?: string | null;
  reminder_count?: number | null;
  kunal_pricing_requested_at?: string | null;
  kunal_pricing_requested_by?: string | null;
  kunal_pricing_note?: string | null;
  user_profiles?: {
    full_name: string;
  };
}

export function CRM() {
  const { profile } = useAuth();
  const { t } = useLanguage();
  const { navigationData, clearNavigationData } = useNavigation();

  // Exactly 4 primary CRM destinations, default is INBOX
  const [activeTab, setActiveTab] = useState<CrmPrimaryTab>('inbox');

  const [inquiries, setInquiries] = useState<Inquiry[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  // Inquiry Drawer & Modals
  const [targetInquiryId, setTargetInquiryId] = useState<string | null>(null);
  const [selectedInquiryForDrawer, setSelectedInquiryForDrawer] = useState<any>(null);
  const [isInquiryDrawerOpen, setIsInquiryDrawerOpen] = useState(false);

  // Customer Drawer
  const [selectedCustomerForDrawer, setSelectedCustomerForDrawer] = useState<CustomerDetail | null>(null);

  // Global Search Modal (Cmd+K)
  const [isSearchOpen, setIsSearchOpen] = useState(false);

  // Settings / Control Center / Connection Health Modal
  const [isSettingsOpen, setIsSettingsOpen] = useState(false);

  // New / Edit Inquiry Form Modal
  const [modalOpen, setModalOpen] = useState(false);
  const [editingInquiry, setEditingInquiry] = useState<Inquiry | null>(null);
  const [prefillInquiry, setPrefillInquiry] = useState<any>(null);

  // Bulk Email Handover State
  const [stagedBulkRecipients, setStagedBulkRecipients] = useState<any[]>([]);

  // Customer deduplication / selection state
  const [pendingFormData, setPendingFormData] = useState<any>(null);
  const [customerMatches, setCustomerMatches] = useState<any[]>([]);
  const [showCustomerSelectionDialog, setShowCustomerSelectionDialog] = useState(false);
  const [showCustomerConfirmationDialog, setShowCustomerConfirmationDialog] = useState(false);
  const [showCustomerUpdateDialog, setShowCustomerUpdateDialog] = useState(false);
  const [customerChanges, setCustomerChanges] = useState<any>(null);
  const [inquiryCounts, setInquiryCounts] = useState<Record<string, number>>({});

  useEffect(() => {
    loadInquiries();
  }, []);

  // Global Hotkey (Cmd/Ctrl+K) for CRM Global Search
  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'k') {
        e.preventDefault();
        setIsSearchOpen(true);
      }
    };
    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, []);

  // Handle external deep-link navigation (e.g. from Pricing Worksheet or Global Search)
  useEffect(() => {
    const targetId = navigationData?.crmInquiryId;
    if (!targetId || typeof targetId !== 'string' || inquiries.length === 0) return;
    const target = inquiries.find((inquiry) => inquiry.id === targetId);
    if (!target) return;
    setActiveTab('inquiries');
    setTargetInquiryId(targetId);
    setSelectedInquiryForDrawer(target);
    setIsInquiryDrawerOpen(true);
    clearNavigationData();
  }, [clearNavigationData, inquiries, navigationData]);

  // Handle external "Create New Inquiry" prefill
  useEffect(() => {
    const create = navigationData?.crmCreateInquiry as any;
    if (!create || typeof create !== 'object') return;
    setEditingInquiry(null);
    setPrefillInquiry({
      product_name: create.product_name || '',
      company_name: create.company_name || '',
      supplier_name: create.supplier_name || '',
      quantity: create.quantity || '',
      purchase_price: create.purchase_price ?? '',
      purchase_price_currency: create.purchase_price_currency || 'USD',
      offered_price: create.offered_price ?? '',
      offered_price_currency: create.offered_price_currency || 'IDR',
      remarks: create.remarks || '',
      internal_notes: create.internal_notes || '',
    });
    setModalOpen(true);
    clearNavigationData();
  }, [clearNavigationData, navigationData]);

  const loadInquiries = async () => {
    try {
      setLoading(true);
      setError(null);
      const { data, error } = await supabase
        .from('crm_inquiries')
        .select(`
          *,
          user_profiles:assigned_to (
            full_name
          )
        `)
        .order('created_at', { ascending: false });

      if (error) throw error;
      setInquiries(data || []);
    } catch (err: any) {
      console.error('Error loading inquiries:', err);
      setError(t('errors.failedToLoadInquiries'));
    } finally {
      setLoading(false);
    }
  };

  const handleOpenInquiry = async (inquiryId: string) => {
    const found = inquiries.find((i) => i.id === inquiryId);
    if (found) {
      setSelectedInquiryForDrawer(found);
      setIsInquiryDrawerOpen(true);
    } else {
      const { data } = await supabase
        .from('crm_inquiries')
        .select(`
          *,
          user_profiles:assigned_to (
            full_name
          )
        `)
        .eq('id', inquiryId)
        .maybeSingle();

      if (data) {
        setSelectedInquiryForDrawer(data);
        setIsInquiryDrawerOpen(true);
      }
    }
  };

  const handleOpenCustomer = async (customerId: string) => {
    const { data } = await supabase
      .from('crm_contacts')
      .select('*')
      .eq('id', customerId)
      .maybeSingle();

    if (data) {
      setSelectedCustomerForDrawer(data as CustomerDetail);
    }
  };

  const handleCreateInquiryFromMessage = (msg: {
    subject: string;
    body: string;
    fromEmail: string;
    fromName: string;
  }) => {
    setEditingInquiry(null);
    setPrefillInquiry({
      company_name: msg.fromName || '',
      contact_email: msg.fromEmail || '',
      email_subject: msg.subject || '',
      remarks: msg.body?.slice(0, 500) || '',
    });
    setModalOpen(true);
  };

  // Form submission and customer relationship handling
  const handleFormSubmit = async (formData: any) => {
    try {
      const { data: { user } } = await supabase.auth.getUser();
      if (!user) throw new Error('User not authenticated');

      if (!editingInquiry && !formData.crm_contact_id) {
        const { data: existingCustomers } = await supabase
          .from('crm_contacts')
          .select('id, company_name, contact_person, email, phone, city, address')
          .eq('is_active', true);

        if (existingCustomers && existingCustomers.length > 0) {
          const matchResult = findBestMatch(formData.company_name, existingCustomers);
          if (matchResult && matchResult.score >= 85) {
            setPendingFormData(formData);
            const counts: Record<string, number> = {};
            const { data: countData } = await supabase
              .from('crm_inquiries')
              .select('crm_contact_id')
              .in('crm_contact_id', [matchResult.customer.id]);

            if (countData) {
              countData.forEach((row) => {
                if (row.crm_contact_id) {
                  counts[row.crm_contact_id] = (counts[row.crm_contact_id] || 0) + 1;
                }
              });
            }

            setInquiryCounts(counts);
            setCustomerMatches([
              {
                ...matchResult.customer,
                similarity: matchResult.score / 100,
                matchType: matchResult.matchType,
              },
            ]);
            setShowCustomerSelectionDialog(true);
            return;
          }
        }
      }

      const sanitizeFormData = (data: any) => {
        const sanitized: any = {};
        const emptyToNull = (val: any) => (val === '' || val === undefined ? null : val);

        // Fields that should never be sent to the crm_inquiries table
        const excludedFields = new Set(['products', 'items']);

        // UUID, date, timestamp, and numeric fields that must be null if empty string
        const nullableFields = new Set([
          'crm_contact_id',
          'customer_id',
          'assigned_to',
          'created_by',
          'sales_member_id',
          'source_email_id',
          'converted_to_quotation',
          'converted_to_order',
          'delivery_date',
          'delivery_date_expected',
          'next_follow_up',
          'last_contact_date',
          'coa_sent_date',
          'msds_sent_date',
          'sample_sent_date',
          'price_quoted_date',
          'lost_at',
          'closed_at',
          'purchase_price',
          'offered_price',
          'purchase_price_currency',
          'offered_price_currency',
        ]);

        Object.keys(data).forEach((key) => {
          if (excludedFields.has(key)) {
            return;
          }
          if (nullableFields.has(key)) {
            sanitized[key] = emptyToNull(data[key]);
          } else {
            sanitized[key] = data[key];
          }
        });
        return sanitized;
      };

      if (editingInquiry) {
        const updatePayload = sanitizeFormData(formData);
        const { error } = await supabase
          .from('crm_inquiries')
          .update(updatePayload)
          .eq('id', editingInquiry.id);

        if (error) throw error;
      } else {
        const { items, products, is_multi_product, ...restFormData } = formData;
        const multiProducts = (items && items.length > 0) ? items : (products && products.length > 0 ? products : []);

        if (is_multi_product && multiProducts.length > 0) {
          const inquiriesToInsert = multiProducts.map((item: any) =>
            sanitizeFormData({
              ...restFormData,
              product_name: item.product_name || item.productName,
              specification: item.specification || null,
              quantity: item.quantity,
              supplier_name: item.supplier_name || item.supplierName || restFormData.supplier_name || null,
              supplier_country: item.supplier_country || item.supplierCountry || restFormData.supplier_country || null,
              delivery_date: item.delivery_date || item.deliveryDate || restFormData.delivery_date || null,
              delivery_terms: item.delivery_terms || item.deliveryTerms || restFormData.delivery_terms || null,
              inquiry_date: new Date().toISOString().split('T')[0],
              assigned_to: user.id,
              created_by: user.id,
              purchase_price: item.purchase_price && !isNaN(parseFloat(item.purchase_price)) ? parseFloat(item.purchase_price) : null,
              offered_price: item.offered_price && !isNaN(parseFloat(item.offered_price)) ? parseFloat(item.offered_price) : null,
              is_multi_product: true,
              has_items: true,
            })
          );

          const { data: insertedInquiries, error } = await supabase
            .from('crm_inquiries')
            .insert(inquiriesToInsert)
            .select();

          if (error) throw error;

          if (insertedInquiries && insertedInquiries.length > 0) {
            const baseInquiryNumber = insertedInquiries[0].inquiry_number;
            for (let i = 0; i < insertedInquiries.length; i++) {
              await supabase
                .from('crm_inquiries')
                .update({ inquiry_number: `${baseInquiryNumber}.${i + 1}` })
                .eq('id', insertedInquiries[i].id);
            }
          }
        } else {
          const insertData: any = sanitizeFormData({
            ...restFormData,
            specification: formData.specification || null,
            inquiry_date: new Date().toISOString().split('T')[0],
            assigned_to: user.id,
            created_by: user.id,
            purchase_price: formData.purchase_price && !isNaN(parseFloat(formData.purchase_price)) ? parseFloat(formData.purchase_price) : null,
            offered_price: formData.offered_price && !isNaN(parseFloat(formData.offered_price)) ? parseFloat(formData.offered_price) : null,
            is_multi_product: false,
            has_items: false,
          });

          const { error, status } = await supabase.from('crm_inquiries').insert([insertData]);
          if (error) {
            console.error('[CRM_INQUIRY_INSERT_ERROR]', {
              message: error.message,
              code: error.code,
              details: error.details,
              hint: error.hint,
              status,
              payloadKeys: Object.keys(insertData),
            });
            throw error;
          }
        }
      }

      registerRecentInquiryValues({
        product_name: formData.product_name,
        specification: formData.specification,
        supplier_country: formData.supplier_country,
      });

      setModalOpen(false);
      setEditingInquiry(null);
      setPrefillInquiry(null);
      loadInquiries();
    } catch (error: any) {
      console.error('Error saving inquiry:', {
        message: error?.message,
        code: error?.code,
        details: error?.details,
        hint: error?.hint,
      });
      alert(t('errors.failedToSaveInquiry'));
    }
  };

  const handleCustomerSelect = (customer: any) => {
    if (pendingFormData) {
      pendingFormData.crm_contact_id = customer.id;
      setShowCustomerSelectionDialog(false);
      handleFormSubmit(pendingFormData);
    }
  };

  const handleCreateNewCustomer = async (customerData: any) => {
    try {
      const { contact } = await findOrCreateCrmContact({
        company_name: customerData.company_name,
        contact_person: customerData.contact_person,
        email: customerData.email,
        phone: customerData.phone,
        country: customerData.country,
        address: customerData.address,
        city: customerData.city,
      });

      if (pendingFormData) {
        pendingFormData.crm_contact_id = contact.id;
        setShowCustomerConfirmationDialog(false);
        handleFormSubmit(pendingFormData);
      }
    } catch (error: any) {
      console.error('Error creating CRM contact:', error);
      throw error;
    }
  };

  const handleUpdateCustomer = async () => {
    if (!customerChanges || !customerChanges.customer) return;
    try {
      const updateData: any = {};
      customerChanges.changedFields.forEach((field: string) => {
        updateData[field] = customerChanges.newValues[field];
      });

      if (updateData.company_name) {
        await ensureUniqueCrmContactName(updateData.company_name, customerChanges.customer.id);
      }

      const { error } = await supabase
        .from('crm_contacts')
        .update(updateData)
        .eq('id', customerChanges.customer.id);

      if (error) throw error;

      setShowCustomerUpdateDialog(false);
      if (pendingFormData) {
        handleFormSubmit(pendingFormData);
      }
    } catch (error: any) {
      console.error('Error updating CRM contact:', error);
      alert(
        isDuplicateCrmContactError(error)
          ? 'A CRM customer with this name already exists.'
          : error?.message || t('errors.failedToUpdateCustomer')
      );
    }
  };

  const canManage = profile?.role === 'admin' || profile?.role === 'sales';

  return (
    <Layout>
      <div className="space-y-3">
        {/* Top Consolidated CRM Bar: 4 Primary Destinations + Quick Actions */}
        <div className="bg-white rounded-lg border border-gray-200 shadow-sm px-4 py-2.5 flex flex-wrap items-center justify-between gap-3">
          
          {/* PRIMARY CRM DESTINATIONS */}
          <div className="flex items-center gap-1">
            {(
              [
                ['inbox', Inbox, 'INBOX'],
                ['inquiries', Table, 'INQUIRIES'],
                ['bulk_email', Send, 'BULK EMAIL'],
                ['customers', Users, 'CUSTOMERS'],
                ['documents', FileText, 'DOCUMENT BANK'],
              ] as const
            ).map(([tabKey, Icon, label]) => {
              const isActive = activeTab === tabKey;
              return (
                <button
                  key={tabKey}
                  onClick={() => setActiveTab(tabKey)}
                  className={`inline-flex items-center gap-2 px-3.5 py-1.5 rounded-md text-xs font-bold transition ${
                    isActive
                      ? 'bg-blue-600 text-white shadow-xs'
                      : 'text-gray-600 hover:text-gray-900 hover:bg-gray-100'
                  }`}
                >
                  <Icon className="w-4 h-4" />
                  {label}
                </button>
              );
            })}
          </div>

          {/* Quick Header Utilities */}
          <div className="flex items-center gap-2">
            {/* Global Search Trigger (Cmd+K) */}
            <button
              onClick={() => setIsSearchOpen(true)}
              className="inline-flex items-center gap-2 px-3 py-1.5 bg-slate-50 hover:bg-slate-100 text-gray-600 border border-gray-200 rounded-md text-xs transition"
              title="Global CRM Search (Cmd+K)"
            >
              <Search className="w-3.5 h-3.5 text-gray-400" />
              <span className="hidden md:inline font-medium">Search CRM...</span>
              <kbd className="hidden sm:inline-block px-1.5 py-0.2 text-[10px] font-semibold text-gray-500 bg-white rounded border border-gray-200">
                ⌘K
              </kbd>
            </button>

            {/* Integration Health & Settings */}
            <button
              onClick={() => setIsSettingsOpen(true)}
              className="p-1.5 text-gray-500 hover:text-gray-800 hover:bg-gray-100 rounded-md border border-gray-200 transition"
              title="Integration Health & Settings (Gmail / WhatsApp)"
            >
              <SlidersHorizontal className="w-4 h-4" />
            </button>

            {/* New Inquiry Action */}
            <button
              onClick={() => {
                setEditingInquiry(null);
                setPrefillInquiry(null);
                setModalOpen(true);
              }}
              className="inline-flex items-center gap-1.5 px-3 py-1.5 bg-blue-600 text-white rounded-md text-xs font-semibold hover:bg-blue-700 shadow-sm transition"
            >
              <Plus className="w-4 h-4" />
              <span>New Inquiry</span>
            </button>
          </div>
        </div>

        {/* Error Notification */}
        {error && (
          <div className="bg-red-50 border border-red-200 rounded-lg p-3 flex items-center justify-between text-xs text-red-700">
            <span>{error}</span>
            <button
              onClick={loadInquiries}
              className="px-2.5 py-1 bg-red-600 text-white rounded hover:bg-red-700 transition"
            >
              {t('crm.retry')}
            </button>
          </div>
        )}

        {/* 1. INBOX DESTINATION (DEFAULT) */}
        {activeTab === 'inbox' && (
          <CrmOmnichannelInbox
            onOpenInquiry={handleOpenInquiry}
            onOpenCustomer={handleOpenCustomer}
            onCreateInquiryFromMessage={handleCreateInquiryFromMessage}
          />
        )}

        {/* 2. INQUIRIES DESTINATION (OPERATIONAL CENTER) */}
        {activeTab === 'inquiries' && (
          <CrmInquiriesWorkspace
            canManage={canManage}
            onAddInquiry={() => {
              setEditingInquiry(null);
              setPrefillInquiry(null);
              setModalOpen(true);
            }}
            onOpenCustomer={handleOpenCustomer}
            initialInquiryId={targetInquiryId}
          />
        )}

        {/* 3. BULK EMAIL DESTINATION */}
        {activeTab === 'bulk_email' && (
          <CrmBulkEmailWorkspace initialRecipients={stagedBulkRecipients} />
        )}

        {/* 4. CUSTOMERS DESTINATION */}
        {activeTab === 'customers' && (
          <CrmCustomersWorkspace
            onOpenInquiry={handleOpenInquiry}
            onNavigateBulkEmail={(recipients) => {
              setStagedBulkRecipients(recipients);
              setActiveTab('bulk_email');
            }}
          />
        )}

        {/* Legacy / Direct Re-Homed Integration */}
        {activeTab === 'control-center' && (
          <div className="bg-white rounded-lg border border-gray-200 p-4 shadow-sm">
            <EnquiryControlCenter canManage={canManage} />
          </div>
        )}

        {/* 5. DOCUMENT BANK DESTINATION */}
        {activeTab === 'documents' && (
          <ProductDocumentsPanel />
        )}

        {/* Contextual Inquiry Drawer (Overlay) */}
        <CrmInquiryDrawer
          isOpen={isInquiryDrawerOpen}
          onClose={() => {
            setIsInquiryDrawerOpen(false);
            setSelectedInquiryForDrawer(null);
          }}
          inquiry={selectedInquiryForDrawer}
          onRefresh={loadInquiries}
          onOpenCustomer={(cid: string) => {
            setIsInquiryDrawerOpen(false);
            handleOpenCustomer(cid);
          }}
        />

        {/* Contextual Customer Drawer (Overlay) */}
        <CrmCustomerDrawer
          isOpen={!!selectedCustomerForDrawer}
          onClose={() => setSelectedCustomerForDrawer(null)}
          customer={selectedCustomerForDrawer}
          onOpenInquiry={(inqId) => {
            setSelectedCustomerForDrawer(null);
            handleOpenInquiry(inqId);
          }}
          onRefresh={loadInquiries}
        />

        {/* Global CRM Search Modal (Cmd+K) */}
        <CrmGlobalSearchModal
          isOpen={isSearchOpen}
          onClose={() => setIsSearchOpen(false)}
          onSelectInquiry={handleOpenInquiry}
          onSelectCustomer={handleOpenCustomer}
          onSelectCommunication={(comm) => {
            if (comm.inquiryId) handleOpenInquiry(comm.inquiryId);
            else if (comm.customerId) handleOpenCustomer(comm.customerId);
            else setActiveTab('inbox');
          }}
        />

        {/* Settings & Integration Health Modal */}
        <CrmSettingsModal
          isOpen={isSettingsOpen}
          onClose={() => setIsSettingsOpen(false)}
          canManage={canManage}
        />

        {/* Create / Edit Inquiry Modal */}
        <Modal
          isOpen={modalOpen}
          onClose={() => {
            setModalOpen(false);
            setEditingInquiry(null);
            setPrefillInquiry(null);
          }}
          title={editingInquiry ? t('crm.editInquiry') : t('crm.addNewInquiry')}
        >
          <CompactInquiryForm
            onSubmit={handleFormSubmit}
            onCancel={() => {
              setModalOpen(false);
              setEditingInquiry(null);
              setPrefillInquiry(null);
            }}
            initialData={editingInquiry || prefillInquiry}
            isEditing={!!editingInquiry}
          />
        </Modal>

        {/* Customer Deduplication & Matching Dialogs */}
        <CustomerSelectionDialog
          isOpen={showCustomerSelectionDialog}
          matches={customerMatches}
          searchTerm={pendingFormData?.company_name || ''}
          onSelect={handleCustomerSelect}
          onCreateNew={() => {
            if (pendingFormData) {
              pendingFormData.crm_contact_id = null;
              setShowCustomerSelectionDialog(false);
              handleFormSubmit(pendingFormData);
            }
          }}
          onCancel={() => {
            setShowCustomerSelectionDialog(false);
            setPendingFormData(null);
          }}
          inquiryCounts={inquiryCounts}
        />

        <CustomerConfirmationDialog
          isOpen={showCustomerConfirmationDialog}
          initialData={{
            company_name: pendingFormData?.company_name || '',
            contact_person: pendingFormData?.contact_person || '',
            email: pendingFormData?.contact_email || '',
            phone: pendingFormData?.contact_phone || '',
            country: pendingFormData?.supplier_country || 'Indonesia',
          }}
          onConfirm={handleCreateNewCustomer}
          onCancel={() => {
            if (pendingFormData) {
              pendingFormData.crm_contact_id = null;
              setShowCustomerConfirmationDialog(false);
              handleFormSubmit(pendingFormData);
            } else {
              setShowCustomerConfirmationDialog(false);
            }
          }}
        />

        <CustomerUpdateDialog
          isOpen={showCustomerUpdateDialog}
          customerName={customerChanges?.customer?.company_name || ''}
          changedFields={customerChanges?.changedFields || []}
          oldValues={customerChanges?.oldValues || {}}
          newValues={customerChanges?.newValues || {}}
          onUpdateCustomer={handleUpdateCustomer}
          onKeepExisting={() => {
            setShowCustomerUpdateDialog(false);
            if (pendingFormData) handleFormSubmit(pendingFormData);
          }}
          onCancel={() => {
            setShowCustomerUpdateDialog(false);
            setPendingFormData(null);
          }}
        />
      </div>
    </Layout>
  );
}
