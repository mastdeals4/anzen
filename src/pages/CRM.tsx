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
  const [activeTab, setActiveTab] = useState<'table' | 'pipeline' | 'calendar' | 'email' | 'customers' | 'activities' | 'appointments' | 'archive'>('table');
  const [modalOpen, setModalOpen] = useState(false);
  const [editingInquiry, setEditingInquiry] = useState<Inquiry | null>(null);
  const [emailModalOpen, setEmailModalOpen] = useState(false);
  const [selectedInquiryForEmail, setSelectedInquiryForEmail] = useState<any>(null);

  useEffect(() => {
    loadInquiries();
  }, []);

  const loadInquiries = async () => {
    try {
      // Exclude 'lost' status inquiries from default view (they appear in Archive)
      const { data, error } = await supabase
        .from('crm_inquiries')
        .select('*, user_profiles!crm_inquiries_assigned_to_fkey(full_name)')
        .neq('pipeline_status', 'lost')
        .order('created_at', { ascending: false });

      if (error) throw error;
      setInquiries(data || []);
    } catch (error) {
      console.error('Error loading inquiries:', error);
    } finally {
      setLoading(false);
    }
  };

  const handleFormSubmit = async (formData: any) => {
    try {
      const { data: { user } } = await supabase.auth.getUser();
      if (!user) throw new Error('Not authenticated');

      if (editingInquiry) {
        const updateData: any = {
          ...formData,
          specification: formData.specification || null,
          purchase_price: formData.purchase_price ? parseFloat(formData.purchase_price) : null,
          offered_price: formData.offered_price ? parseFloat(formData.offered_price) : null,
        };

        const { error } = await supabase
          .from('crm_inquiries')
          .update(updateData)
          .eq('id', editingInquiry.id);

        if (error) throw error;
      } else {
        const insertData: any = {
          ...formData,
          specification: formData.specification || null,
          inquiry_date: new Date().toISOString().split('T')[0],
          assigned_to: user.id,
          created_by: user.id,
          purchase_price: formData.purchase_price ? parseFloat(formData.purchase_price) : null,
          offered_price: formData.offered_price ? parseFloat(formData.offered_price) : null,
        };

        const { error } = await supabase
          .from('crm_inquiries')
          .insert([insertData]);

        if (error) throw error;
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
      </div>
    </Layout>
  );
}
