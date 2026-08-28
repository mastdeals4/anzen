import { useEffect, useState } from 'react';
import { Layout } from '../components/Layout';
import { Modal } from '../components/Modal';
import { useAuth } from '../contexts/AuthContext';
import { useLanguage } from '../contexts/LanguageContext';
import { useNavigation } from '../contexts/NavigationContext';
import { supabase } from '../lib/supabase';
import { Plus, Mail, Calendar as CalendarIcon, LayoutGrid, Users, Table, Inbox, Activity, Clock, Archive, BarChart3, Send, FolderOpen, Orbit } from 'lucide-react';
import { SalesTeam } from './SalesTeam';
import { GmailBrowserInbox } from '../components/crm/GmailBrowserInbox';
import { InquiryTableExcel } from '../components/crm/InquiryTableExcel';
import { ReminderCalendar } from '../components/crm/ReminderCalendar';
import { PipelineBoard } from '../components/crm/PipelineBoard';
import { EmailComposer } from '../components/crm/EmailComposer';
import { CustomerDatabaseExcel } from '../components/crm/CustomerDatabaseExcel';
import { ActivityLogger } from '../components/crm/ActivityLogger';
import { AppointmentScheduler } from '../components/crm/AppointmentScheduler';
import { ArchiveView } from '../components/crm/ArchiveView';
import { DeliveryLog } from '../components/crm/DeliveryLog';
import { ProductDocumentsPanel } from '../components/crm/ProductDocumentsPanel';
import { Inquiry360View } from '../components/crm/Inquiry360View';
import { CompactInquiryForm } from '../components/crm/CompactInquiryForm';
import { CustomerSelectionDialog } from '../components/crm/CustomerSelectionDialog';
import { CustomerConfirmationDialog } from '../components/crm/CustomerConfirmationDialog';
import { CustomerUpdateDialog } from '../components/crm/CustomerUpdateDialog';
import { Customer360Panel } from '../components/crm/Customer360Panel';
import { CRMWorkQueue } from '../components/crm/CRMWorkQueue';
import { ConversionIntelligence } from '../components/crm/ConversionIntelligence';
import {
  ensureUniqueCrmContactName,
  findOrCreateCrmContact,
  isDuplicateCrmContactError,
} from '../utils/customerValidation';
import { fuzzyMatchCompanyName, detectCustomerChanges, findBestMatch } from '../utils/customerMatching';

interface Inquiry {
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
  const [inquiries, setInquiries] = useState<Inquiry[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [activeTab, setActiveTab] = useState<'work' | 'inquiry-360' | 'customer-360' | 'conversion-intelligence' | 'table' | 'pipeline' | 'calendar' | 'email' | 'customers' | 'activities' | 'archive' | 'sales-team' | 'delivery-log' | 'documents'>('work');
  const [modalOpen, setModalOpen] = useState(false);
  const [editingInquiry, setEditingInquiry] = useState<Inquiry | null>(null);
  // Prefill payload for creating a NEW inquiry (e.g. from AI Pricing "Create new
  // inquiry"). Distinct from editingInquiry so isEditing stays false → INSERT.
  const [prefillInquiry, setPrefillInquiry] = useState<any>(null);
  const [emailModalOpen, setEmailModalOpen] = useState(false);
  const [selectedInquiryForEmail, setSelectedInquiryForEmail] = useState<any>(null);

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

  useEffect(() => {
    const targetId = navigationData?.crmInquiryId;
    if (!targetId || typeof targetId !== 'string' || inquiries.length === 0) return;
    const target = inquiries.find(inquiry => inquiry.id === targetId);
    if (!target) return;
    setActiveTab('table');
    setEditingInquiry(target);
    setModalOpen(true);
    clearNavigationData();
  }, [clearNavigationData, inquiries, navigationData]);

  // Open a prefilled "New Inquiry" form when another module (e.g. AI Pricing's
  // "Create new inquiry" on an unmatched email) hands over draft fields.
  useEffect(() => {
    const create = navigationData?.crmCreateInquiry;
    if (!create || typeof create !== 'object') return;
    setEditingInquiry(null);
    setPrefillInquiry(create);
    setActiveTab('table');
    setModalOpen(true);
    clearNavigationData();
  }, [clearNavigationData, navigationData]);

  const loadInquiries = async () => {
    try {
      setError(null);
      // Exclude 'lost' status inquiries from default view (they appear in Archive)
      const { data, error: fetchError } = await supabase
        .from('crm_inquiries')
        .select('*, user_profiles!assigned_to(full_name)')
        .neq('pipeline_status', 'lost')
        .order('created_at', { ascending: false });

      if (fetchError) throw fetchError;
      setInquiries(data || []);
    } catch (err) {
      setError(t('errors.failedToLoadInquiries'));
    } finally {
      setLoading(false);
    }
  };

  const loadCustomers = async () => {
    try {
      // CRM Inquiry customer master lives in crm_contacts, not the ERP
      // customers table. The Inquiry form only ever selects from CRM prospects.
      const { data, error } = await supabase
        .from('crm_contacts')
        .select('id, company_name, contact_person, email, phone, country, address, city')
        .eq('is_active', true);

      if (error) throw error;
      return data || [];
    } catch (error) {
      console.error('Error loading CRM contacts:', error);
      return [];
    }
  };

  const loadInquiryCounts = async (contactIds: string[]) => {
    try {
      const { data, error } = await supabase
        .from('crm_inquiries')
        .select('crm_contact_id')
        .in('crm_contact_id', contactIds);

      if (error) throw error;

      const counts: Record<string, number> = {};
      data?.forEach(inquiry => {
        if (inquiry.crm_contact_id) {
          counts[inquiry.crm_contact_id] = (counts[inquiry.crm_contact_id] || 0) + 1;
        }
      });

      setInquiryCounts(counts);
    } catch (error) {
      console.error('Error loading inquiry counts:', error);
    }
  };

  const processCustomerMatching = async (formData: any) => {
    if (formData.crm_contact_id) {
      const customers = await loadCustomers();
      const selectedCustomer = customers.find(c => c.id === formData.crm_contact_id);

      if (selectedCustomer) {
        const changes = detectCustomerChanges(
          {
            contact_email: formData.contact_email,
            contact_phone: formData.contact_phone,
            contact_person: formData.contact_person,
          },
          selectedCustomer
        );

        if (changes.hasChanges) {
          setCustomerChanges({
            ...changes,
            customer: selectedCustomer,
          });
          setPendingFormData(formData);
          setShowCustomerUpdateDialog(true);
          return false;
        }
      }

      return true;
    }

    const customers = await loadCustomers();
    const matches = fuzzyMatchCompanyName(formData.company_name, customers);

    if (matches.length > 0) {
      const bestMatch = findBestMatch(formData.company_name, customers);

      if (bestMatch && bestMatch.score >= 95) {
        formData.crm_contact_id = bestMatch.customer.id;
        return processCustomerMatching(formData);
      } else {
        setCustomerMatches(matches);
        setPendingFormData(formData);
        await loadInquiryCounts(matches.map(m => m.customer.id));
        setShowCustomerSelectionDialog(true);
        return false;
      }
    } else {
      setPendingFormData(formData);
      setShowCustomerConfirmationDialog(true);
      return false;
    }
  };

  const sanitizeFormData = (data: any) => {
    const sanitized = { ...data };
    // Convert empty strings to null for date and numeric fields
    const dateFields = ['delivery_date', 'inquiry_date'];
    const numericFields = ['purchase_price', 'offered_price'];

    dateFields.forEach(field => {
      if (sanitized[field] === '' || sanitized[field] === undefined) {
        sanitized[field] = null;
      }
    });

    numericFields.forEach(field => {
      if (sanitized[field] === '' || sanitized[field] === undefined) {
        sanitized[field] = null;
      } else if (sanitized[field] !== null) {
        sanitized[field] = parseFloat(sanitized[field]);
      }
    });

    return sanitized;
  };

  const handleFormSubmit = async (formData: any) => {
    try {
      const { data: { user } } = await supabase.auth.getUser();
      if (!user) throw new Error('Not authenticated');

      if (!editingInquiry) {
        const canProceed = await processCustomerMatching(formData);
        if (!canProceed) {
          return;
        }

      }

      if (editingInquiry) {
        // Extract products and is_multi_product from formData before update
        const { products, is_multi_product, ...restFormData } = formData;

        const updateData: any = sanitizeFormData({
          ...restFormData,
          specification: formData.specification || null,
          purchase_price: formData.purchase_price ? parseFloat(formData.purchase_price) : null,
          offered_price: formData.offered_price ? parseFloat(formData.offered_price) : null,
        });

        const { error } = await supabase
          .from('crm_inquiries')
          .update(updateData)
          .eq('id', editingInquiry.id);

        if (error) throw error;
      } else {
        // Extract products and is_multi_product from formData before insert
        const { products, is_multi_product, ...restFormData } = formData;

        // If multi-product, create N separate inquiries in crm_inquiries with .1, .2, .3 suffixes
        // All common fields are copied to each inquiry
        if (is_multi_product && products && products.length > 0) {
          // Create inquiries for each product
          const inquiriesToInsert = products.map((product: any) => sanitizeFormData({
            ...restFormData,
            product_name: product.productName || product.product_name,
            specification: product.specification || null,
            quantity: product.quantity,
            supplier_name: product.supplierName || restFormData.supplier_name || null,
            supplier_country: product.supplierCountry || restFormData.supplier_country || null,
            delivery_date: product.deliveryDate || null,
            delivery_terms: product.deliveryTerms || null,
            inquiry_date: new Date().toISOString().split('T')[0],
            assigned_to: user.id,
            created_by: user.id,
            purchase_price: null,
            offered_price: null,
            is_multi_product: false,
            has_items: false,
          }));

          const { data: insertedInquiries, error } = await supabase
            .from('crm_inquiries')
            .insert(inquiriesToInsert)
            .select();

          if (error) throw error;

          // Update inquiry numbers to add .1, .2, .3 suffixes
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
          // Single product inquiry
          const insertData: any = sanitizeFormData({
            ...restFormData,
            specification: formData.specification || null,
            inquiry_date: new Date().toISOString().split('T')[0],
            assigned_to: user.id,
            created_by: user.id,
            purchase_price: formData.purchase_price ? parseFloat(formData.purchase_price) : null,
            offered_price: formData.offered_price ? parseFloat(formData.offered_price) : null,
            is_multi_product: false,
            has_items: false,
          });

          const { error } = await supabase
            .from('crm_inquiries')
            .insert([insertData]);

          if (error) throw error;
        }
      }

      setModalOpen(false);
      setEditingInquiry(null);
      loadInquiries();
    } catch (error) {
      console.error('Error saving inquiry:', error);
      alert(t('errors.failedToSaveInquiry'));
      throw error;
    }
  };

  const handleEdit = (inquiry: Inquiry) => {
    setEditingInquiry(inquiry);
    setModalOpen(true);
  };

  const handleDelete = async (id: string) => {
    if (!confirm(t('confirm.deleteInquiry'))) return;

    try {
      const { error } = await supabase
        .from('crm_inquiries')
        .delete()
        .eq('id', id);

      if (error) throw error;
      loadInquiries();
    } catch (error) {
      console.error('Error deleting inquiry:', error);
      alert(t('errors.failedToDeleteInquiry'));
    }
  };

  const handleCustomerSelect = (customer: any) => {
    if (pendingFormData) {
      pendingFormData.crm_contact_id = customer.id;
      setShowCustomerSelectionDialog(false);
      handleFormSubmit(pendingFormData);
    }
  };

  // Writes a NEW CRM prospect to crm_contacts (not the ERP customers table).
  // A prospect is promoted to an ERP trading customer only via the manual
  // ERP Customers workflow — never automatically from the Inquiry form.
  const handleCreateNewCustomer = async (customerData: any) => {
    try {
      // findOrCreateCrmContact reuses an existing CRM prospect (case- and
      // whitespace-insensitive company_name match) instead of creating a
      // duplicate row. Handles race conditions too — if two clicks land at
      // the same moment, both end up pointing at the same crm_contacts row.
      const { contact } = await findOrCreateCrmContact({
        company_name:   customerData.company_name,
        contact_person: customerData.contact_person,
        email:          customerData.email,
        phone:          customerData.phone,
        country:        customerData.country,
        address:        customerData.address,
        city:           customerData.city,
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
      alert(isDuplicateCrmContactError(error)
        ? 'A CRM customer with this name already exists.'
        : (error?.message || t('errors.failedToUpdateCustomer')));
    }
  };

  const handleKeepExistingCustomer = () => {
    setShowCustomerUpdateDialog(false);
    if (pendingFormData) {
      handleFormSubmit(pendingFormData);
    }
  };

  const handleSendEmail = (inquiry: Inquiry) => {
    setSelectedInquiryForEmail({
      id: inquiry.id,
      inquiry_number: inquiry.inquiry_number,
      company_name: inquiry.company_name,
      contact_person: inquiry.contact_person,
      contact_email: inquiry.contact_email,
      product_name: inquiry.product_name,
      quantity: inquiry.quantity,
    });
    setEmailModalOpen(true);
  };


  const canManage = profile?.role === 'admin' || profile?.role === 'sales';

  return (
    <Layout>
      <div className="space-y-2">
        <div className="bg-white rounded-lg shadow-sm">
          <div className="border-b border-gray-200">
            <div className="flex overflow-x-auto">
              {([
                ['work',        Clock,       "Today's Work",      'purple'],
                ['inquiry-360', Orbit,       'Inquiry 360',       'purple'],
                ['customer-360',Users,       'Customer 360',      'purple'],
                ['conversion-intelligence',BarChart3, 'Conversion Intelligence', 'purple'],
                ['email',       Inbox,       t('crm.emailInbox'), 'blue'],
                ['table',       Table,       t('crm.inquiries'),  'blue'],
                ['pipeline',    LayoutGrid,  t('crm.pipeline'),   'blue'],
                ['calendar',    CalendarIcon,t('crm.calendar'),   'blue'],
                ['customers',   Users,       t('crm.customers'),  'blue'],
                ['activities',  Activity,    t('crm.activities'), 'blue'],
                ['archive',     Archive,     t('crm.archive'),    'blue'],
                ['sales-team',  BarChart3,   t('crm.salesTeam'),  'blue'],
                ['delivery-log',Send,        'Delivery Log',      'blue'],
                ['documents',   FolderOpen,  'Documents',         'blue'],
              ] as const).map(([tab, Icon, label, color]) => {
                const isActive = activeTab === tab;
                const activeCls = color === 'purple'
                  ? 'border-purple-500 text-purple-600 font-medium'
                  : 'border-blue-500 text-blue-600 font-medium';
                return (
                  <button
                    key={tab}
                    onClick={() => setActiveTab(tab as typeof activeTab)}
                    className={`flex items-center gap-1.5 px-3 py-2 border-b-2 transition whitespace-nowrap text-xs ${
                      isActive ? activeCls : 'border-transparent text-gray-500 hover:text-gray-700'
                    }`}
                  >
                    <Icon className="w-4 h-4" />
                    {label}
                  </button>
                );
              })}
            </div>
          </div>

          <div className="p-3">
            {error && (
              <div className="bg-red-50 border border-red-200 rounded-lg p-4 mb-4 flex items-center justify-between">
                <p className="text-red-700">{error}</p>
                <button
                  onClick={loadInquiries}
                  className="px-3 py-1 bg-red-600 text-white rounded-lg hover:bg-red-700 transition text-sm"
                >
                  {t('crm.retry')}
                </button>
              </div>
            )}
            
            {activeTab === 'inquiry-360' && (
              <Inquiry360View inquiries={inquiries as any} />
            )}

            {activeTab === 'work' && <CRMWorkQueue inquiries={inquiries as any} />}

            {activeTab === 'customer-360' && <Customer360Panel />}

            {activeTab === 'conversion-intelligence' && <ConversionIntelligence />}

            {activeTab === 'email' && (
              <GmailBrowserInbox />
            )}

            {activeTab === 'table' && (
              <InquiryTableExcel
                inquiries={inquiries}
                onRefresh={loadInquiries}
                canManage={canManage}
                onAddInquiry={() => {
                  setEditingInquiry(null);
                  setModalOpen(true);
                }}
              />
            )}

            {activeTab === 'pipeline' && (
              <PipelineBoard
                canManage={canManage}
                onInquiryClick={(inquiry) => handleEdit(inquiry as unknown as Inquiry)}
              />
            )}

            {activeTab === 'calendar' && (
              <div className='space-y-4'>
                <div className='bg-blue-50 border border-blue-100 rounded-lg p-3 text-sm text-blue-800'>
                  Calendar is now the single place for appointment planning. The Appointment tab was merged here to avoid duplication.
                </div>
                <ReminderCalendar onReminderCreated={loadInquiries} />
                <AppointmentScheduler onAppointmentCreated={loadInquiries} />
              </div>
            )}

            {activeTab === 'customers' && (
              <CustomerDatabaseExcel />
            )}

            {activeTab === 'activities' && (
              <ActivityLogger onActivityLogged={loadInquiries} />
            )}


            {activeTab === 'archive' && (
              <ArchiveView canManage={canManage} onRefresh={loadInquiries} />
            )}

            {activeTab === 'sales-team' && (
              <SalesTeam embedded />
            )}


            {activeTab === 'delivery-log' && (
              <DeliveryLog />
            )}

            {activeTab === 'documents' && (
              <ProductDocumentsPanel />
            )}
          </div>
        </div>

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

        <Modal
          isOpen={emailModalOpen}
          onClose={() => {
            setEmailModalOpen(false);
            setSelectedInquiryForEmail(null);
          }}
          title={t('crm.sendEmail')}
        >
          <EmailComposer
            inquiry={selectedInquiryForEmail}
            onClose={() => {
              setEmailModalOpen(false);
              setSelectedInquiryForEmail(null);
            }}
            onSent={() => {
              loadInquiries();
            }}
          />
        </Modal>

        <CustomerSelectionDialog
          isOpen={showCustomerSelectionDialog}
          matches={customerMatches}
          searchTerm={pendingFormData?.company_name || ''}
          onSelect={handleCustomerSelect}
          onCreateNew={() => {
            // Keep CRM prospecting flexible: allow inquiry creation without linking to master customers
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
            // Continue as CRM prospect without creating a sales customer record
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
          onKeepExisting={handleKeepExistingCustomer}
          onCancel={() => {
            setShowCustomerUpdateDialog(false);
            setPendingFormData(null);
          }}
        />
      </div>
    </Layout>
  );
}
