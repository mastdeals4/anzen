import { useEffect, useState } from 'react';
import { Layout } from '../components/Layout';
import { Modal } from '../components/Modal';
import { useAuth } from '../contexts/AuthContext';
import { supabase } from '../lib/supabase';
import { Plus, Mail, Calendar as CalendarIcon, LayoutGrid, Users, Table, Inbox, Activity, Clock, Archive } from 'lucide-react';
import { GmailBrowserInbox } from '../components/crm/GmailBrowserInbox';
import { InquiryTableExcel } from '../components/crm/InquiryTableExcel';
import { ReminderCalendar } from '../components/crm/ReminderCalendar';
import { PipelineBoard } from '../components/crm/PipelineBoard';
import { EmailComposer } from '../components/crm/EmailComposer';
import { CustomerDatabase } from '../components/crm/CustomerDatabase';
import { CustomerDatabaseExcel } from '../components/crm/CustomerDatabaseExcel';
import { ActivityLogger } from '../components/crm/ActivityLogger';
import { AppointmentScheduler } from '../components/crm/AppointmentScheduler';
import { ArchiveView } from '../components/crm/ArchiveView';
import { CompactInquiryForm } from '../components/crm/CompactInquiryForm';
import { CustomerSelectionDialog } from '../components/crm/CustomerSelectionDialog';
import { CustomerConfirmationDialog } from '../components/crm/CustomerConfirmationDialog';
import { CustomerUpdateDialog } from '../components/crm/CustomerUpdateDialog';
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
  user_profiles?: {
    full_name: string;
  };
}

export function CRM() {
  const { profile } = useAuth();
  const [inquiries, setInquiries] = useState<Inquiry[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [activeTab, setActiveTab] = useState<'table' | 'pipeline' | 'calendar' | 'email' | 'customers' | 'activities' | 'appointments' | 'archive'>('table');
  const [modalOpen, setModalOpen] = useState(false);
  const [editingInquiry, setEditingInquiry] = useState<Inquiry | null>(null);
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
      setError('Failed to load inquiries. Please try again.');
    } finally {
      setLoading(false);
    }
  };

  const loadCustomers = async () => {
    try {
      const { data, error } = await supabase
        .from('customers')
        .select('id, company_name, contact_person, email, phone, country, address, city')
        .eq('is_active', true);

      if (error) throw error;
      return data || [];
    } catch (error) {
      console.error('Error loading customers:', error);
      return [];
    }
  };

  const loadInquiryCounts = async (customerIds: string[]) => {
    try {
      const { data, error } = await supabase
        .from('crm_inquiries')
        .select('customer_id')
        .in('customer_id', customerIds);

      if (error) throw error;

      const counts: Record<string, number> = {};
      data?.forEach(inquiry => {
        if (inquiry.customer_id) {
          counts[inquiry.customer_id] = (counts[inquiry.customer_id] || 0) + 1;
        }
      });

      setInquiryCounts(counts);
    } catch (error) {
      console.error('Error loading inquiry counts:', error);
    }
  };

  const processCustomerMatching = async (formData: any) => {
    if (formData.customer_id) {
      const customers = await loadCustomers();
      const selectedCustomer = customers.find(c => c.id === formData.customer_id);

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
        formData.customer_id = bestMatch.customer.id;
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

        if (!formData.customer_id) {
          alert('Customer selection is required. Please select or create a customer.');
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
      alert('Failed to save inquiry. Please try again.');
      throw error;
    }
  };

  const handleEdit = (inquiry: Inquiry) => {
    setEditingInquiry(inquiry);
    setModalOpen(true);
  };

  const handleDelete = async (id: string) => {
    if (!confirm('Are you sure you want to delete this inquiry?')) return;

    try {
      const { error } = await supabase
        .from('crm_inquiries')
        .delete()
        .eq('id', id);

      if (error) throw error;
      loadInquiries();
    } catch (error) {
      console.error('Error deleting inquiry:', error);
      alert('Failed to delete inquiry. Please try again.');
    }
  };

  const handleCustomerSelect = (customer: any) => {
    if (pendingFormData) {
      pendingFormData.customer_id = customer.id;
      setShowCustomerSelectionDialog(false);
      handleFormSubmit(pendingFormData);
    }
  };

  const handleCreateNewCustomer = async (customerData: any) => {
    try {
      const { data, error } = await supabase
        .from('customers')
        .insert({
          ...customerData,
          is_active: true,
        })
        .select()
        .single();

      if (error) throw error;

      if (pendingFormData) {
        pendingFormData.customer_id = data.id;
        setShowCustomerConfirmationDialog(false);
        handleFormSubmit(pendingFormData);
      }
    } catch (error) {
      console.error('Error creating customer:', error);
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

      const { error } = await supabase
        .from('customers')
        .update(updateData)
        .eq('id', customerChanges.customer.id);

      if (error) throw error;

      setShowCustomerUpdateDialog(false);
      if (pendingFormData) {
        handleFormSubmit(pendingFormData);
      }
    } catch (error) {
      console.error('Error updating customer:', error);
      alert('Failed to update customer. Please try again.');
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
      <div className="space-y-4">
        <div className="flex items-center">
          <h1 className="text-xl font-semibold text-gray-900">CRM - Inquiry Management</h1>
        </div>

        <div className="bg-white rounded-lg shadow">
          <div className="border-b border-gray-200">
            <div className="flex overflow-x-auto">
              <button
                onClick={() => setActiveTab('email')}
                className={`flex items-center gap-2 px-6 py-4 border-b-2 transition whitespace-nowrap ${
                  activeTab === 'email'
                    ? 'border-blue-500 text-blue-600 font-medium'
                    : 'border-transparent text-gray-500 hover:text-gray-700'
                }`}
              >
                <Inbox className="w-5 h-5" />
                Email Inbox
              </button>
              <button
                onClick={() => setActiveTab('table')}
                className={`flex items-center gap-2 px-6 py-4 border-b-2 transition whitespace-nowrap ${
                  activeTab === 'table'
                    ? 'border-blue-500 text-blue-600 font-medium'
                    : 'border-transparent text-gray-500 hover:text-gray-700'
                }`}
              >
                <Table className="w-5 h-5" />
                Table View
              </button>
              <button
                onClick={() => setActiveTab('pipeline')}
                className={`flex items-center gap-2 px-6 py-4 border-b-2 transition whitespace-nowrap ${
                  activeTab === 'pipeline'
                    ? 'border-blue-500 text-blue-600 font-medium'
                    : 'border-transparent text-gray-500 hover:text-gray-700'
                }`}
              >
                <LayoutGrid className="w-5 h-5" />
                Pipeline
              </button>
              <button
                onClick={() => setActiveTab('calendar')}
                className={`flex items-center gap-2 px-6 py-4 border-b-2 transition whitespace-nowrap ${
                  activeTab === 'calendar'
                    ? 'border-blue-500 text-blue-600 font-medium'
                    : 'border-transparent text-gray-500 hover:text-gray-700'
                }`}
              >
                <CalendarIcon className="w-5 h-5" />
                Calendar
              </button>
              <button
                onClick={() => setActiveTab('customers')}
                className={`flex items-center gap-2 px-6 py-4 border-b-2 transition whitespace-nowrap ${
                  activeTab === 'customers'
                    ? 'border-blue-500 text-blue-600 font-medium'
                    : 'border-transparent text-gray-500 hover:text-gray-700'
                }`}
              >
                <Users className="w-5 h-5" />
                Customers
              </button>
              <button
                onClick={() => setActiveTab('activities')}
                className={`flex items-center gap-2 px-6 py-4 border-b-2 transition whitespace-nowrap ${
                  activeTab === 'activities'
                    ? 'border-blue-500 text-blue-600 font-medium'
                    : 'border-transparent text-gray-500 hover:text-gray-700'
                }`}
              >
                <Activity className="w-5 h-5" />
                Activities
              </button>
              <button
                onClick={() => setActiveTab('appointments')}
                className={`flex items-center gap-2 px-6 py-4 border-b-2 transition whitespace-nowrap ${
                  activeTab === 'appointments'
                    ? 'border-blue-500 text-blue-600 font-medium'
                    : 'border-transparent text-gray-500 hover:text-gray-700'
                }`}
              >
                <Clock className="w-5 h-5" />
                Appointments
              </button>
              <button
                onClick={() => setActiveTab('archive')}
                className={`flex items-center gap-2 px-6 py-4 border-b-2 transition whitespace-nowrap ${
                  activeTab === 'archive'
                    ? 'border-blue-500 text-blue-600 font-medium'
                    : 'border-transparent text-gray-500 hover:text-gray-700'
                }`}
              >
                <Archive className="w-5 h-5" />
                Archive
              </button>
            </div>
          </div>

          <div className="p-6">
            {error && (
              <div className="bg-red-50 border border-red-200 rounded-lg p-4 mb-4 flex items-center justify-between">
                <p className="text-red-700">{error}</p>
                <button
                  onClick={loadInquiries}
                  className="px-3 py-1 bg-red-600 text-white rounded-lg hover:bg-red-700 transition text-sm"
                >
                  Retry
                </button>
              </div>
            )}
            
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
                onInquiryClick={(inquiry) => handleEdit(inquiry as Inquiry)}
              />
            )}

            {activeTab === 'calendar' && (
              <ReminderCalendar onReminderCreated={loadInquiries} />
            )}

            {activeTab === 'customers' && (
              <CustomerDatabaseExcel />
            )}

            {activeTab === 'activities' && (
              <ActivityLogger onActivityLogged={loadInquiries} />
            )}

            {activeTab === 'appointments' && (
              <AppointmentScheduler onAppointmentCreated={loadInquiries} />
            )}

            {activeTab === 'archive' && (
              <ArchiveView canManage={canManage} onRefresh={loadInquiries} />
            )}
          </div>
        </div>

        <Modal
          isOpen={modalOpen}
          onClose={() => {
            setModalOpen(false);
            setEditingInquiry(null);
          }}
          title={editingInquiry ? 'Edit Inquiry' : 'Add New Inquiry'}
        >
          <CompactInquiryForm
            onSubmit={handleFormSubmit}
            onCancel={() => {
              setModalOpen(false);
              setEditingInquiry(null);
            }}
            initialData={editingInquiry}
            isEditing={!!editingInquiry}
          />
        </Modal>

        <Modal
          isOpen={emailModalOpen}
          onClose={() => {
            setEmailModalOpen(false);
            setSelectedInquiryForEmail(null);
          }}
          title="Send Email"
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
            setShowCustomerSelectionDialog(false);
            setShowCustomerConfirmationDialog(true);
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
            setShowCustomerConfirmationDialog(false);
            setPendingFormData(null);
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
