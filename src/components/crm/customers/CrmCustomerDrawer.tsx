import { useEffect, useMemo, useState } from 'react';
import { supabase } from '../../../lib/supabase';
import { showToast } from '../../ToastNotification';
import { SpeechToTextButton } from '../SpeechToTextButton';
import { getSignedUrlCached } from '../../../utils/signedUrlCache';
import {
  X,
  Building,
  User,
  Mail,
  Phone,
  MapPin,
  Globe,
  FileText,
  MessageSquare,
  ShoppingCart,
  Clock,
  ExternalLink,
  Plus,
  Send,
  Eye,
  Download,
  AlertCircle,
  CheckCircle2,
  Calendar,
  DollarSign,
  Tag,
  Paperclip,
  Sparkles,
  ListFilter,
  CheckSquare,
  MessageCircle,
} from 'lucide-react';

export interface CustomerBriefData {
  whatWasDiscussed: string[];
  whatWasOffered: string[];
  whatCustomerRequested: string[];
  previousObjections: string[];
  whatIsPending: string[];
  whatToDoNext: string[];
}

export interface TimelineItem {
  id: string;
  type: 'email' | 'whatsapp' | 'inquiry' | 'quote' | 'document' | 'order' | 'activity' | 'linkedin';
  title: string;
  subtitle?: string;
  description?: string;
  timestamp: string;
  badgeColor?: string;
  linkId?: string;
}

export interface CustomerDetail {
  id: string;
  company_name: string;
  contact_person?: string | null;
  designation?: string | null;
  email?: string | null;
  phone?: string | null;
  mobile?: string | null;
  landline?: string | null;
  address?: string | null;
  city?: string | null;
  country?: string | null;
  website?: string | null;
  customer_type?: string | null;
  company_type?: string | null;
  notes?: string | null;
  is_active?: boolean;
  erp_customer_id?: string | null;
}

interface InquirySummary {
  id: string;
  inquiry_number: string;
  inquiry_date: string;
  product_name: string;
  quantity?: string | null;
  status: string;
  pipeline_status?: string | null;
  offered_price?: number | null;
  offered_price_currency?: string | null;
}

interface OrderSummary {
  id: string;
  so_number: string;
  so_date: string;
  status: string;
  total_amount?: number | null;
  currency?: string | null;
}

interface DeliverySummary {
  id: string;
  challan_number: string;
  challan_date: string;
  approval_status: string;
}

interface InvoiceSummary {
  id: string;
  invoice_number: string;
  invoice_date: string;
  total_amount: number;
  paid_amount: number;
  payment_status: string;
}

interface ConversationItem {
  id: string;
  channel: 'email' | 'whatsapp' | 'internal';
  sender: string;
  subject?: string;
  body: string;
  timestamp: string;
  direction: 'inbound' | 'outbound' | 'internal';
  attachments?: Array<{
    filename: string;
    storagePath?: string | null;
  }>;
}

interface CustomerDocument {
  id: string;
  filename: string;
  documentType: string;
  storagePath?: string | null;
  created_at: string;
}

interface Props {
  isOpen: boolean;
  onClose: () => void;
  customer: CustomerDetail | null;
  onOpenInquiry?: (inquiryId: string) => void;
  onRefresh?: () => void;
}

type CustomerDrawerSection = 'overview' | 'timeline' | 'inquiries' | 'conversations' | 'documents' | 'orders' | 'activity';

export function CrmCustomerDrawer({
  isOpen,
  onClose,
  customer,
  onOpenInquiry,
  onRefresh,
}: Props) {
  const [activeSection, setActiveSection] = useState<CustomerDrawerSection>('overview');
  const [loading, setLoading] = useState(false);
  const [briefLoading, setBriefLoading] = useState(false);
  const [customerBrief, setCustomerBrief] = useState<CustomerBriefData | null>(null);
  const [timelineFilter, setTimelineFilter] = useState('');

  // Sub-data states
  const [inquiries, setInquiries] = useState<InquirySummary[]>([]);

  const nextFollowUp = useMemo(() => {
    const withFollowUp = inquiries.find((i: any) => i.next_follow_up);
    return (withFollowUp as any)?.next_follow_up || null;
  }, [inquiries]);
  const [orders, setOrders] = useState<OrderSummary[]>([]);
  const [deliveries, setDeliveries] = useState<DeliverySummary[]>([]);
  const [invoices, setInvoices] = useState<InvoiceSummary[]>([]);
  const [conversations, setConversations] = useState<ConversationItem[]>([]);
  const [documents, setDocuments] = useState<CustomerDocument[]>([]);
  const [activities, setActivities] = useState<Array<{ id: string; title: string; type: string; created_at: string; completed?: boolean }>>([]);

  // New Note / Activity State
  const [newNote, setNewNote] = useState('');
  const [noteActivityType, setNoteActivityType] = useState<'Note' | 'Call' | 'Meeting' | 'LinkedIn'>('Note');
  const [savingNote, setSavingNote] = useState(false);
  const [newReminderTitle, setNewReminderTitle] = useState('');
  const [newReminderDate, setNewReminderDate] = useState('');
  const [savingReminder, setSavingReminder] = useState(false);

  useEffect(() => {
    if (isOpen && customer) {
      loadCustomerDetails();
    }
  }, [isOpen, customer?.id]);

  const loadCustomerDetails = async () => {
    if (!customer) return;
    setLoading(true);

    try {
      // 1. Find matching inquiries: either by crm_contact_id or company_name or erp customer_id
      const inquiryQuery = supabase
        .from('crm_inquiries')
        .select('id, inquiry_number, inquiry_date, product_name, quantity, status, pipeline_status, offered_price, offered_price_currency, next_follow_up, assigned_to, crm_contact_id, customer_id')
        .or(`crm_contact_id.eq.${customer.id},company_name.ilike.%${customer.company_name.trim()}%`)
        .order('created_at', { ascending: false });

      const { data: inqData } = await inquiryQuery;
      const loadedInquiries = inqData || [];
      setInquiries(loadedInquiries);

      const inqIds = loadedInquiries.map((i: any) => i.id);

      // 2. Load ERP orders & invoices if linked or matching company name
      const { data: erpCust } = await supabase
        .from('customers')
        .select('id')
        .or(`id.eq.${customer.id},company_name.ilike.%${customer.company_name.trim()}%`)
        .maybeSingle();

      const erpCustId = erpCust?.id || customer.erp_customer_id;

      if (erpCustId) {
        const [ordersRes, deliveriesRes, invoicesRes] = await Promise.all([
          supabase.from('sales_orders').select('id, so_number, so_date, status, total_amount, currency').eq('customer_id', erpCustId).order('so_date', { ascending: false }).limit(20),
          supabase.from('delivery_challans').select('id, challan_number, challan_date, approval_status').eq('customer_id', erpCustId).order('challan_date', { ascending: false }).limit(20),
          supabase.from('sales_invoices').select('id, invoice_number, invoice_date, total_amount, paid_amount, payment_status').eq('customer_id', erpCustId).order('invoice_date', { ascending: false }).limit(20),
        ]);
        setOrders(ordersRes.data || []);
        setDeliveries(deliveriesRes.data || []);
        setInvoices(invoicesRes.data || []);
      } else {
        setOrders([]);
        setDeliveries([]);
        setInvoices([]);
      }

      // 3. Load Conversations (EMAIL + WHATSAPP)
      const convItems: ConversationItem[] = [];

      // A. Enquiry conversations messages linked via inquiries or directly to customer
      const { data: directConvs } = await supabase
        .from('enquiry_conversations')
        .select('id')
        .eq('customer_id', customer.id);

      const allConvIds = new Set<string>((directConvs || []).map((c: any) => c.id).filter(Boolean));

      if (inqIds.length > 0) {
        const { data: links } = await supabase
          .from('enquiry_conversation_links')
          .select('conversation_id')
          .in('inquiry_id', inqIds);

        (links || []).forEach((l: any) => {
          if (l.conversation_id) allConvIds.add(l.conversation_id);
        });
      }

      if (allConvIds.size > 0) {
        const { data: messages } = await supabase
          .from('enquiry_conversation_messages')
          .select('*')
          .in('conversation_id', Array.from(allConvIds))
          .order('created_at', { ascending: false })
          .limit(50);

        (messages || []).forEach((m: any) => {
          convItems.push({
            id: m.id,
            channel: m.channel === 'whatsapp' ? 'whatsapp' : 'email',
            sender: m.sender || m.sender_name || 'Customer',
            subject: m.subject || undefined,
            body: m.body_text || m.content || '',
            timestamp: m.received_or_sent_at || m.created_at,
            direction: m.direction || 'inbound',
            attachments: m.attachments || undefined,
          });
        });
      }

      if (inqIds.length > 0) {
        // B. Email activities
        const { data: emailActs } = await supabase
          .from('crm_email_activities')
          .select('*')
          .in('inquiry_id', inqIds)
          .order('created_at', { ascending: false })
          .limit(30);

        (emailActs || []).forEach((ea: any) => {
          convItems.push({
            id: `ea-${ea.id}`,
            channel: 'email',
            sender: ea.from_email || 'You',
            subject: ea.subject || 'Email Sent',
            body: ea.body || '',
            timestamp: ea.sent_date || ea.created_at,
            direction: 'outbound',
            attachments: ea.attachment_urls || undefined,
          });
        });
      }

      // Sort chronological descending
      convItems.sort((a, b) => new Date(b.timestamp).getTime() - new Date(a.timestamp).getTime());
      setConversations(convItems);

      // 4. Documents
      const docItems: CustomerDocument[] = [];
      if (inqIds.length > 0) {
        const { data: prodDocs } = await supabase
          .from('crm_product_documents')
          .select('id, original_file_name, display_file_name, document_type, storage_path, created_at')
          .in('inquiry_id', inqIds);

        (prodDocs || []).forEach((d: any) => {
          docItems.push({
            id: d.id,
            filename: d.display_file_name || d.original_file_name || 'document',
            documentType: d.document_type || 'DOCUMENT',
            storagePath: d.storage_path,
            created_at: d.created_at,
          });
        });
      }
      setDocuments(docItems);

      // 5. Activities & Reminders
      const [actRes, remRes] = await Promise.all([
        supabase.from('crm_activities').select('id, subject, activity_type, created_at, is_completed').eq('customer_id', customer.id).order('created_at', { ascending: false }).limit(20),
        inqIds.length > 0
          ? supabase.from('crm_reminders').select('id, title, due_date, is_completed, created_at').in('inquiry_id', inqIds).order('due_date', { ascending: false }).limit(20)
          : Promise.resolve({ data: [] }),
      ]);

      const actList: Array<{ id: string; title: string; type: string; created_at: string; completed?: boolean }> = [];
      (actRes.data || []).forEach((a: any) => {
        actList.push({
          id: a.id,
          title: a.subject,
          type: a.activity_type || 'Note',
          created_at: a.created_at,
          completed: a.is_completed,
        });
      });
      (remRes.data || []).forEach((r: any) => {
        actList.push({
          id: r.id,
          title: r.title,
          type: 'Reminder',
          created_at: r.due_date || r.created_at,
          completed: r.is_completed,
        });
      });
      setActivities(actList);

    } catch (err: any) {
      console.error('Failed to load customer drawer details:', err);
      showToast({ type: 'error', title: 'Customer Details', message: err.message || 'Unable to load details.' });
    } finally {
      setLoading(false);
    }
  };

  const generateCustomerBrief = () => {
    setBriefLoading(true);
    try {
      // 1. What was discussed
      const discussed: string[] = [];
      conversations.slice(0, 5).forEach((c) => {
        const preview = c.subject ? `Subject: "${c.subject}"` : `(${c.channel.toUpperCase()})`;
        const snippet = c.body.replace(/\s+/g, ' ').slice(0, 100);
        discussed.push(`${preview}: ${snippet}...`);
      });
      if (discussed.length === 0) {
        discussed.push('No recent electronic conversations logged.');
      }

      // 2. What was offered
      const offered: string[] = [];
      inquiries.filter(i => i.offered_price).forEach(i => {
        offered.push(`${i.product_name} (${i.quantity || 'unspecified qty'}): Quoted at ${i.offered_price_currency || 'USD'} ${i.offered_price} (Ref: ${i.inquiry_number})`);
      });
      if (offered.length === 0) {
        offered.push('No formal quotation has been submitted yet.');
      }

      // 3. What the customer requested
      const requested: string[] = [];
      inquiries.forEach(i => {
        requested.push(`${i.product_name} (Requirement: ${i.quantity || 'Quantity upon quote'}) [Status: ${i.status}]`);
      });
      if (requested.length === 0) {
        requested.push('No active product inquiry records found.');
      }

      // 4. Previous objections
      const objections: string[] = [];
      inquiries.filter((i: any) => i.lost_reason || i.competitor_price).forEach((i: any) => {
        objections.push(`Inquiry ${i.inquiry_number}: Lost/Objection: ${i.lost_reason || 'Price sensitive'} ${i.competitor_price ? `(Competitor: ${i.competitor_price})` : ''}`);
      });
      if (objections.length === 0) {
        objections.push('No historical pricing or quality objections on file.');
      }

      // 5. What is pending
      const pending: string[] = [];
      const pendingInqs = inquiries.filter(i => i.status === 'active' || i.pipeline_status === 'pending' || i.pipeline_status === 'quote_sent');
      pendingInqs.forEach(i => {
        pending.push(`Awaiting response on ${i.inquiry_number} (${i.product_name})`);
      });
      const pendingOrders = orders.filter(o => o.status === 'pending' || o.status === 'processing');
      pendingOrders.forEach(o => {
        pending.push(`Sales Order ${o.so_number} processing`);
      });
      if (pending.length === 0) {
        pending.push('All previous requests and inquiries are closed or settled.');
      }

      // 6. What to do next
      const nextSteps: string[] = [];
      if (pendingInqs.length > 0) {
        nextSteps.push(`Follow up with ${customer?.contact_person || customer?.company_name} on pending inquiry ${pendingInqs[0].inquiry_number} (${pendingInqs[0].product_name}).`);
      } else if (inquiries.length > 0) {
        nextSteps.push(`Re-engage customer for seasonal requirement updates on ${inquiries[0].product_name}.`);
      } else {
        nextSteps.push(`Reach out to introduce current product catalog and API availability.`);
      }

      setCustomerBrief({
        whatWasDiscussed: discussed,
        whatWasOffered: offered,
        whatCustomerRequested: requested,
        previousObjections: objections,
        whatIsPending: pending,
        whatToDoNext: nextSteps,
      });
      showToast({ type: 'success', title: 'Customer Brief Ready', message: 'AI Customer Brief generated successfully.' });
    } catch (err: any) {
      showToast({ type: 'error', title: 'Brief Failed', message: err.message || 'Could not generate brief' });
    } finally {
      setBriefLoading(false);
    }
  };

  const unifiedTimeline: TimelineItem[] = useMemo(() => {
    const list: TimelineItem[] = [];

    // 1. Conversations (Email & WhatsApp)
    conversations.forEach((c) => {
      list.push({
        id: `conv-${c.id}`,
        type: c.channel === 'whatsapp' ? 'whatsapp' : 'email',
        title: c.channel === 'whatsapp' ? `WhatsApp: ${c.sender}` : `Email: ${c.subject || 'No Subject'}`,
        subtitle: c.direction === 'inbound' ? 'Inbound from customer' : 'Outbound sent',
        description: c.body?.slice(0, 160),
        timestamp: c.timestamp,
        badgeColor: c.channel === 'whatsapp' ? 'bg-emerald-100 text-emerald-800 border-emerald-300' : 'bg-blue-100 text-blue-800 border-blue-300',
      });
    });

    // 2. Inquiries
    inquiries.forEach((i) => {
      list.push({
        id: `inq-${i.id}`,
        type: 'inquiry',
        title: `Inquiry ${i.inquiry_number}: ${i.product_name}`,
        subtitle: `Quantity: ${i.quantity || 'N/A'} · Status: ${i.status}`,
        timestamp: i.inquiry_date,
        badgeColor: 'bg-purple-100 text-purple-800 border-purple-300',
        linkId: i.id,
      });
      if (i.offered_price) {
        list.push({
          id: `quote-${i.id}`,
          type: 'quote',
          title: `Quotation Offered: ${i.product_name}`,
          subtitle: `${i.offered_price_currency || 'USD'} ${i.offered_price}`,
          timestamp: i.inquiry_date,
          badgeColor: 'bg-amber-100 text-amber-800 border-amber-300',
          linkId: i.id,
        });
      }
    });

    // 3. Documents
    documents.forEach((d) => {
      list.push({
        id: `doc-${d.id}`,
        type: 'document',
        title: `Document Bank: ${d.filename}`,
        subtitle: `Type: ${d.documentType}`,
        timestamp: d.created_at,
        badgeColor: 'bg-slate-100 text-slate-800 border-slate-300',
      });
    });

    // 4. Sales Orders
    orders.forEach((o) => {
      list.push({
        id: `so-${o.id}`,
        type: 'order',
        title: `Sales Order ${o.so_number}`,
        subtitle: `Status: ${o.status} · Amount: ${o.currency || 'IDR'} ${o.total_amount || 0}`,
        timestamp: o.so_date,
        badgeColor: 'bg-indigo-100 text-indigo-800 border-indigo-300',
      });
    });

    // 5. Activities & Notes (including LinkedIn)
    activities.forEach((a) => {
      const isLinkedIn = (a.type || '').toLowerCase().includes('linkedin') || (a.title || '').toLowerCase().includes('linkedin');
      list.push({
        id: `act-${a.id}`,
        type: isLinkedIn ? 'linkedin' : 'activity',
        title: a.title || (isLinkedIn ? 'LinkedIn Interaction' : 'Staff Note'),
        subtitle: isLinkedIn ? 'LinkedIn outreach / message' : 'Logged by staff',
        timestamp: a.created_at,
        badgeColor: isLinkedIn
          ? 'bg-sky-100 text-sky-800 border-sky-300 font-semibold'
          : 'bg-teal-100 text-teal-800 border-teal-300',
      });
    });

    // Sort descending by timestamp
    return list.sort((a, b) => new Date(b.timestamp).getTime() - new Date(a.timestamp).getTime());
  }, [conversations, inquiries, documents, orders, activities]);

  const handleAddNote = async () => {
    if (!customer || !newNote.trim()) return;
    setSavingNote(true);
    try {
      const { data: auth } = await supabase.auth.getUser();
      const prefix = noteActivityType === 'LinkedIn' ? '[LinkedIn Interaction] ' : '';
      const { error } = await supabase.from('crm_activities').insert({
        customer_id: customer.id,
        subject: `${prefix}${newNote.trim()}`,
        activity_type: noteActivityType,
        created_by: auth.user?.id || null,
        is_completed: true,
      });
      if (error) throw error;
      setNewNote('');
      showToast({ type: 'success', title: `${noteActivityType} Logged`, message: 'Activity note saved successfully.' });
      loadCustomerDetails();
    } catch (err: any) {
      showToast({ type: 'error', title: 'Save Failed', message: err.message });
    } finally {
      setSavingNote(false);
    }
  };

  const handleAddReminder = async () => {
    if (!customer || !newReminderTitle.trim() || !newReminderDate) return;
    setSavingReminder(true);
    try {
      const { data: auth } = await supabase.auth.getUser();
      // Link reminder to customer's latest inquiry if available
      const inqId = inquiries[0]?.id || null;
      const { error } = await supabase.from('crm_reminders').insert({
        inquiry_id: inqId,
        title: `[${customer.company_name}] ${newReminderTitle.trim()}`,
        due_date: new Date(newReminderDate).toISOString(),
        user_id: auth.user?.id || null,
        is_completed: false,
      });
      if (error) throw error;
      setNewReminderTitle('');
      setNewReminderDate('');
      showToast({ type: 'success', title: 'Reminder Set', message: 'Follow-up reminder recorded.' });
      loadCustomerDetails();
    } catch (err: any) {
      showToast({ type: 'error', title: 'Reminder Failed', message: err.message });
    } finally {
      setSavingReminder(false);
    }
  };

  const handleViewDocument = async (storagePath: string, filename: string) => {
    let popupWin: Window | null = null;
    popupWin = window.open('', '_blank');
    if (popupWin) {
      popupWin.document.write('<p style="font-family:sans-serif;padding:24px;color:#475569;font-size:14px;">Loading document securely...</p>');
    }
    try {
      const signedUrl = await getSignedUrlCached('crm-documents', storagePath, 3600);
      if (!signedUrl) throw new Error('Signed URL generation failed');
      if (popupWin && !popupWin.closed) {
        popupWin.location.href = signedUrl;
      } else {
        window.open(signedUrl, '_blank');
      }
    } catch (err: any) {
      if (popupWin && !popupWin.closed) popupWin.close();
      showToast({ type: 'error', title: 'Document Error', message: `Cannot open ${filename}: ${err.message}` });
    }
  };

  if (!isOpen || !customer) return null;

  return (
    <div className="fixed inset-0 z-50 overflow-hidden bg-black/40 backdrop-blur-sm flex justify-end animate-in fade-in duration-200">
      <div className="relative w-full max-w-3xl bg-white h-full shadow-2xl flex flex-col z-10 animate-in slide-in-from-right duration-200">
        
        {/* Drawer Header */}
        <div className="px-6 py-4 border-b border-gray-200 bg-slate-50 flex items-center justify-between">
          <div className="flex items-center gap-3 min-w-0">
            <div className="w-10 h-10 rounded-full bg-blue-100 text-blue-700 flex items-center justify-center font-bold text-lg shrink-0">
              <Building className="w-5 h-5" />
            </div>
            <div className="min-w-0">
              <div className="flex items-center gap-2">
                <h2 className="text-lg font-bold text-gray-900 truncate" title={customer.company_name}>
                  {customer.company_name}
                </h2>
                <span className={`px-2 py-0.5 text-xs font-semibold rounded-full ${
                  customer.is_active !== false ? 'bg-emerald-100 text-emerald-800' : 'bg-gray-100 text-gray-600'
                }`}>
                  {customer.is_active !== false ? 'Active' : 'Inactive'}
                </span>
                {(customer.company_type || customer.customer_type) && (
                  <span className="px-2 py-0.5 text-xs font-medium bg-blue-50 text-blue-700 border border-blue-200 rounded">
                    {customer.company_type || customer.customer_type}
                  </span>
                )}
              </div>
              <p className="text-xs text-gray-500 truncate">
                {customer.contact_person || 'No contact person'} {customer.email ? `• ${customer.email}` : ''} {customer.phone || customer.mobile ? `• ${customer.phone || customer.mobile}` : ''}
              </p>
            </div>
          </div>

          <div className="flex items-center gap-2">
            {customer.email && (
              <a
                href={`mailto:${customer.email}`}
                className="p-2 text-gray-600 hover:text-blue-600 hover:bg-white rounded-lg border border-gray-200 transition"
                title="Send Email"
              >
                <Mail className="w-4 h-4" />
              </a>
            )}
            {(customer.phone || customer.mobile) && (
              <a
                href={`tel:${customer.phone || customer.mobile}`}
                className="p-2 text-gray-600 hover:text-emerald-600 hover:bg-white rounded-lg border border-gray-200 transition"
                title="Call"
              >
                <Phone className="w-4 h-4" />
              </a>
            )}
            <button
              onClick={onClose}
              className="p-2 text-gray-400 hover:text-gray-600 hover:bg-gray-100 rounded-lg transition"
              title="Close Drawer"
            >
              <X className="w-5 h-5" />
            </button>
          </div>
        </div>

        {/* Navigation Tabs */}
        <div className="flex border-b border-gray-200 bg-white px-6 gap-6 text-sm font-medium">
          {(
            [
              ['overview', 'OVERVIEW'],
              ['inquiries', `INQUIRIES (${inquiries.length})`],
              ['conversations', `CONVERSATIONS (${conversations.length})`],
              ['documents', `DOCUMENTS (${documents.length})`],
              ['orders', `ORDERS (${orders.length})`],
              ['activity', `ACTIVITY (${activities.length})`],
            ] as const
          ).map(([sec, label]) => (
            <button
              key={sec}
              onClick={() => setActiveSection(sec as CustomerDrawerSection)}
              className={`py-3 border-b-2 text-xs uppercase tracking-wider font-semibold transition whitespace-nowrap ${
                activeSection === sec
                  ? 'border-blue-600 text-blue-600'
                  : 'border-transparent text-gray-500 hover:text-gray-800'
              }`}
            >
              {label}
            </button>
          ))}
        </div>

        {/* Drawer Body */}
        <div className="flex-1 overflow-y-auto p-6 bg-slate-50/50">
          {loading ? (
            <div className="flex items-center justify-center py-16 text-sm text-gray-500">
              <Clock className="w-5 h-5 animate-spin mr-2 text-blue-600" />
              Loading customer intelligence...
            </div>
          ) : (
            <>
              {/* 1. OVERVIEW SECTION */}
              {activeSection === 'overview' && (
                <div className="space-y-6">
                  {/* AI Customer Brief Card */}
                  {customerBrief && (
                    <div className="bg-gradient-to-br from-purple-50/80 via-white to-indigo-50/50 border border-purple-200 rounded-xl p-5 shadow-xs space-y-4">
                      <div className="flex items-center justify-between border-b border-purple-100 pb-2">
                        <div className="flex items-center gap-2">
                          <Sparkles className="w-4 h-4 text-purple-600" />
                          <h3 className="text-sm font-bold text-purple-900 uppercase tracking-wider">AI Customer Brief</h3>
                        </div>
                        <button
                          onClick={() => setCustomerBrief(null)}
                          className="text-xs text-purple-500 hover:text-purple-800"
                        >
                          Dismiss
                        </button>
                      </div>

                      <div className="grid grid-cols-1 md:grid-cols-2 gap-4 text-xs">
                        <div className="space-y-1">
                          <span className="font-bold text-gray-700 block">💬 What was discussed:</span>
                          <ul className="list-disc list-inside text-gray-600 space-y-0.5">
                            {customerBrief.whatWasDiscussed.map((item, idx) => (
                              <li key={idx} className="line-clamp-2">{item}</li>
                            ))}
                          </ul>
                        </div>

                        <div className="space-y-1">
                          <span className="font-bold text-emerald-800 block">🏷️ What was offered:</span>
                          <ul className="list-disc list-inside text-gray-600 space-y-0.5">
                            {customerBrief.whatWasOffered.map((item, idx) => (
                              <li key={idx} className="line-clamp-2">{item}</li>
                            ))}
                          </ul>
                        </div>

                        <div className="space-y-1">
                          <span className="font-bold text-blue-800 block">📋 What the customer requested:</span>
                          <ul className="list-disc list-inside text-gray-600 space-y-0.5">
                            {customerBrief.whatCustomerRequested.map((item, idx) => (
                              <li key={idx} className="line-clamp-2">{item}</li>
                            ))}
                          </ul>
                        </div>

                        <div className="space-y-1">
                          <span className="font-bold text-amber-800 block">⚠️ Previous objections:</span>
                          <ul className="list-disc list-inside text-gray-600 space-y-0.5">
                            {customerBrief.previousObjections.map((item, idx) => (
                              <li key={idx} className="line-clamp-2">{item}</li>
                            ))}
                          </ul>
                        </div>

                        <div className="space-y-1">
                          <span className="font-bold text-rose-800 block">⏳ What is pending:</span>
                          <ul className="list-disc list-inside text-gray-600 space-y-0.5">
                            {customerBrief.whatIsPending.map((item, idx) => (
                              <li key={idx} className="line-clamp-2">{item}</li>
                            ))}
                          </ul>
                        </div>

                        <div className="space-y-1">
                          <span className="font-bold text-indigo-900 block">🚀 What to do next:</span>
                          <ul className="list-disc list-inside text-indigo-950 font-medium space-y-0.5">
                            {customerBrief.whatToDoNext.map((item, idx) => (
                              <li key={idx} className="line-clamp-2">{item}</li>
                            ))}
                          </ul>
                        </div>
                      </div>
                    </div>
                  )}

                  {/* Compact Status & Follow-up Strip */}
                  <div className="bg-white rounded-lg border border-gray-200 p-3.5 shadow-xs flex items-center justify-between gap-4 flex-wrap text-xs">
                    <div>
                      <span className="text-gray-400 block text-[10px] uppercase font-bold">Assigned Salesperson</span>
                      <span className="font-semibold text-gray-800">
                        {customer.contact_person ? 'Sales Team (Kunal / Dedicated)' : 'Unassigned'}
                      </span>
                    </div>

                    <div>
                      <span className="text-gray-400 block text-[10px] uppercase font-bold">Last Communication</span>
                      <span className="font-semibold text-gray-800">
                        {conversations[0]?.timestamp ? new Date(conversations[0].timestamp).toLocaleDateString() : 'No recent activity'}
                      </span>
                    </div>

                    <div>
                      <span className="text-gray-400 block text-[10px] uppercase font-bold">Next Follow-up Date</span>
                      <span className={`font-bold ${nextFollowUp ? 'text-blue-700' : 'text-gray-500'}`}>
                        {nextFollowUp ? new Date(nextFollowUp).toLocaleDateString() : 'Not scheduled'}
                      </span>
                    </div>

                    <div>
                      <span className="text-gray-400 block text-[10px] uppercase font-bold">Pending Requests</span>
                      <span className="inline-flex items-center px-2 py-0.5 rounded-full text-[10px] font-bold bg-amber-50 text-amber-800 border border-amber-200">
                        {inquiries.filter(i => i.status === 'active').length} active inquiries
                      </span>
                    </div>
                  </div>

                  {/* Master Info Cards */}
                  <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
                    <div className="bg-white p-3.5 rounded-lg border border-gray-200 shadow-sm">
                      <div className="text-xs text-gray-500 font-medium">Inquiries</div>
                      <div className="text-xl font-bold text-gray-900 mt-1">{inquiries.length}</div>
                    </div>
                    <div className="bg-white p-3.5 rounded-lg border border-gray-200 shadow-sm">
                      <div className="text-xs text-gray-500 font-medium">Sales Orders</div>
                      <div className="text-xl font-bold text-blue-600 mt-1">{orders.length}</div>
                    </div>
                    <div className="bg-white p-3.5 rounded-lg border border-gray-200 shadow-sm">
                      <div className="text-xs text-gray-500 font-medium">Deliveries</div>
                      <div className="text-xl font-bold text-emerald-600 mt-1">{deliveries.length}</div>
                    </div>
                    <div className="bg-white p-3.5 rounded-lg border border-gray-200 shadow-sm">
                      <div className="text-xs text-gray-500 font-medium">Invoices</div>
                      <div className="text-xl font-bold text-purple-600 mt-1">{invoices.length}</div>
                    </div>
                  </div>

                  {/* Contact Details */}
                  <div className="bg-white rounded-lg border border-gray-200 p-5 shadow-sm space-y-4">
                    <h3 className="text-sm font-semibold text-gray-900 uppercase tracking-wider flex items-center gap-2">
                      <User className="w-4 h-4 text-gray-500" />
                      Contact & Business Details
                    </h3>

                    <div className="grid grid-cols-1 md:grid-cols-2 gap-4 text-sm">
                      <div>
                        <span className="text-xs text-gray-500 block">Contact Person</span>
                        <span className="font-medium text-gray-900">{customer.contact_person || '—'}</span>
                        {customer.designation && <span className="text-xs text-gray-500 ml-1">({customer.designation})</span>}
                      </div>
                      <div>
                        <span className="text-xs text-gray-500 block">Email Address</span>
                        {customer.email ? (
                          <a href={`mailto:${customer.email}`} className="text-blue-600 hover:underline font-medium">
                            {customer.email}
                          </a>
                        ) : '—'}
                      </div>
                      <div>
                        <span className="text-xs text-gray-500 block">Phone / Mobile</span>
                        <span className="font-medium text-gray-900">{customer.phone || customer.mobile || '—'}</span>
                        {customer.landline && <span className="text-xs text-gray-500 ml-1">(Landline: {customer.landline})</span>}
                      </div>
                      <div>
                        <span className="text-xs text-gray-500 block">Customer Classification / Type</span>
                        <span className="font-medium text-gray-900">{customer.company_type || customer.customer_type || 'General'}</span>
                      </div>
                      <div className="md:col-span-2">
                        <span className="text-xs text-gray-500 block">Address</span>
                        <div className="flex items-start gap-1 font-medium text-gray-900">
                          <MapPin className="w-4 h-4 text-gray-400 mt-0.5 shrink-0" />
                          <span>{[customer.address, customer.city, customer.country || 'Indonesia'].filter(Boolean).join(', ') || '—'}</span>
                        </div>
                      </div>
                      {customer.website && (
                        <div className="md:col-span-2">
                          <span className="text-xs text-gray-500 block">Website</span>
                          <a href={customer.website.startsWith('http') ? customer.website : `https://${customer.website}`} target="_blank" rel="noopener noreferrer" className="text-blue-600 hover:underline flex items-center gap-1 font-medium">
                            <Globe className="w-3.5 h-3.5" />
                            {customer.website}
                          </a>
                        </div>
                      )}
                    </div>
                  </div>

                  {/* Notes / Relationship summary */}
                  {customer.notes && (
                    <div className="bg-amber-50/60 border border-amber-200 rounded-lg p-4">
                      <h4 className="text-xs font-semibold text-amber-900 uppercase tracking-wider mb-1">Relationship Notes</h4>
                      <p className="text-sm text-amber-900 whitespace-pre-wrap">{customer.notes}</p>
                    </div>
                  )}
                </div>
              )}

              {/* 360 TIMELINE SECTION */}
              {activeSection === 'timeline' && (
                <div className="space-y-4">
                  <div className="flex items-center justify-between gap-3">
                    <span className="text-xs font-semibold text-gray-500 uppercase tracking-wider">
                      Omnichannel Chronological Timeline ({unifiedTimeline.length})
                    </span>
                    <input
                      type="text"
                      value={timelineFilter}
                      onChange={e => setTimelineFilter(e.target.value)}
                      placeholder="Filter timeline events..."
                      className="text-xs px-2.5 py-1 border border-gray-300 rounded bg-white w-48"
                    />
                  </div>

                  {unifiedTimeline.length === 0 ? (
                    <div className="bg-white rounded-lg border border-dashed border-gray-300 p-8 text-center text-sm text-gray-500">
                      No communications or activities recorded yet.
                    </div>
                  ) : (
                    <div className="space-y-2">
                      {unifiedTimeline
                        .filter(item =>
                          !timelineFilter ||
                          item.title.toLowerCase().includes(timelineFilter.toLowerCase()) ||
                          (item.description && item.description.toLowerCase().includes(timelineFilter.toLowerCase()))
                        )
                        .map(item => (
                          <div
                            key={item.id}
                            onClick={() => item.linkId && onOpenInquiry?.(item.linkId)}
                            className={`p-3 bg-white rounded-lg border border-gray-200 shadow-2xs flex items-start gap-3 transition ${
                              item.linkId ? 'hover:border-blue-400 cursor-pointer' : ''
                            }`}
                          >
                            <span className={`text-[10px] uppercase font-bold px-2 py-0.5 rounded border shrink-0 ${item.badgeColor}`}>
                              {item.type}
                            </span>
                            <div className="min-w-0 flex-1">
                              <div className="flex items-center justify-between gap-2">
                                <span className="font-semibold text-xs text-gray-900 truncate">{item.title}</span>
                                <span className="text-[10px] text-gray-400 shrink-0">
                                  {item.timestamp ? new Date(item.timestamp).toLocaleDateString() : ''}
                                </span>
                              </div>
                              {item.subtitle && <p className="text-[11px] text-gray-500 mt-0.5">{item.subtitle}</p>}
                              {item.description && (
                                <p className="text-xs text-gray-700 mt-1 line-clamp-2 bg-slate-50 p-1.5 rounded border border-gray-100">
                                  {item.description}
                                </p>
                              )}
                            </div>
                          </div>
                        ))}
                    </div>
                  )}
                </div>
              )}

              {/* 2. INQUIRIES SECTION */}
              {activeSection === 'inquiries' && (
                <div className="space-y-3">
                  <div className="flex items-center justify-between">
                    <span className="text-xs font-semibold text-gray-500 uppercase tracking-wider">
                      All Inquiries ({inquiries.length})
                    </span>
                  </div>

                  {inquiries.length === 0 ? (
                    <div className="bg-white rounded-lg border border-dashed border-gray-300 p-8 text-center text-sm text-gray-500">
                      No inquiries recorded for this customer yet.
                    </div>
                  ) : (
                    <div className="bg-white rounded-lg border border-gray-200 divide-y divide-gray-100 shadow-sm overflow-hidden">
                      {inquiries.map((inq) => (
                        <div
                          key={inq.id}
                          onClick={() => onOpenInquiry?.(inq.id)}
                          className="p-3.5 hover:bg-blue-50/60 transition cursor-pointer flex items-center justify-between gap-4"
                        >
                          <div className="min-w-0">
                            <div className="flex items-center gap-2">
                              <span className="font-semibold text-sm text-blue-600">
                                {inq.inquiry_number}
                              </span>
                              <span className="text-xs px-2 py-0.5 rounded-full bg-gray-100 text-gray-700 font-medium">
                                {inq.pipeline_status || inq.status}
                              </span>
                            </div>
                            <div className="text-sm font-medium text-gray-900 truncate mt-0.5">
                              {inq.product_name} {inq.quantity ? `• ${inq.quantity}` : ''}
                            </div>
                            <div className="text-xs text-gray-400 mt-0.5">
                              Date: {new Date(inq.inquiry_date).toLocaleDateString()}
                            </div>
                          </div>

                          <div className="flex items-center gap-3 shrink-0">
                            {inq.offered_price && (
                              <div className="text-right">
                                <div className="text-xs text-gray-400">Offered Price</div>
                                <div className="text-sm font-semibold text-gray-900">
                                  {inq.offered_price_currency || 'IDR'} {Number(inq.offered_price).toLocaleString()}
                                </div>
                              </div>
                            )}
                            <button
                              onClick={(e) => {
                                e.stopPropagation();
                                onOpenInquiry?.(inq.id);
                              }}
                              className="p-1.5 text-gray-400 hover:text-blue-600 hover:bg-blue-100 rounded transition"
                              title="Open Inquiry"
                            >
                              <ExternalLink className="w-4 h-4" />
                            </button>
                          </div>
                        </div>
                      ))}
                    </div>
                  )}
                </div>
              )}

              {/* 3. CONVERSATIONS SECTION (EMAIL + WHATSAPP) */}
              {activeSection === 'conversations' && (
                <div className="space-y-4">
                  <div className="flex items-center justify-between text-xs text-gray-500 uppercase tracking-wider font-semibold">
                    <span>Omnichannel Timeline (Email + WhatsApp)</span>
                    <span>{conversations.length} Messages</span>
                  </div>

                  {conversations.length === 0 ? (
                    <div className="bg-white rounded-lg border border-dashed border-gray-300 p-8 text-center text-sm text-gray-500">
                      No email or WhatsApp communications recorded for this customer yet.
                    </div>
                  ) : (
                    <div className="space-y-3">
                      {conversations.map((msg) => {
                        const isWhatsApp = msg.channel === 'whatsapp';
                        const isOutbound = msg.direction === 'outbound';

                        return (
                          <div
                            key={msg.id}
                            className={`rounded-lg border p-4 shadow-sm transition ${
                              isOutbound
                                ? 'bg-blue-50/50 border-blue-200 ml-4'
                                : 'bg-white border-gray-200 mr-4'
                            }`}
                          >
                            <div className="flex items-center justify-between mb-2">
                              <div className="flex items-center gap-2">
                                <span
                                  className={`inline-flex items-center gap-1 px-2 py-0.5 rounded text-xs font-semibold ${
                                    isWhatsApp
                                      ? 'bg-emerald-100 text-emerald-800'
                                      : 'bg-indigo-100 text-indigo-800'
                                  }`}
                                >
                                  {isWhatsApp ? (
                                    <>
                                      <MessageSquare className="w-3 h-3" />
                                      WHATSAPP
                                    </>
                                  ) : (
                                    <>
                                      <Mail className="w-3 h-3" />
                                      EMAIL
                                    </>
                                  )}
                                </span>
                                <span className="text-xs font-semibold text-gray-800">
                                  {msg.sender}
                                </span>
                                <span className="text-xs text-gray-400">
                                  {isOutbound ? '(Outbound)' : '(Inbound)'}
                                </span>
                              </div>
                              <span className="text-xs text-gray-400">
                                {new Date(msg.timestamp).toLocaleString()}
                              </span>
                            </div>

                            {msg.subject && (
                              <div className="text-xs font-semibold text-gray-900 mb-1">
                                Subject: {msg.subject}
                              </div>
                            )}

                            <div className="text-sm text-gray-700 whitespace-pre-wrap line-clamp-6 font-sans">
                              {msg.body}
                            </div>

                            {msg.attachments && msg.attachments.length > 0 && (
                              <div className="mt-3 pt-2 border-t border-gray-200/60 flex flex-wrap gap-2">
                                {msg.attachments.map((att, idx) => (
                                  <button
                                    key={idx}
                                    onClick={() => att.storagePath && handleViewDocument(att.storagePath, att.filename)}
                                    className="inline-flex items-center gap-1.5 px-2.5 py-1 rounded bg-white border border-gray-200 text-xs font-medium text-gray-700 hover:bg-gray-50"
                                  >
                                    <Paperclip className="w-3 h-3 text-gray-400" />
                                    {att.filename}
                                  </button>
                                ))}
                              </div>
                            )}
                          </div>
                        );
                      })}
                    </div>
                  )}
                </div>
              )}

              {/* 4. DOCUMENTS SECTION */}
              {activeSection === 'documents' && (
                <div className="space-y-3">
                  <div className="flex items-center justify-between text-xs font-semibold text-gray-500 uppercase tracking-wider">
                    <span>Product & Regulatory Documents ({documents.length})</span>
                  </div>

                  {documents.length === 0 ? (
                    <div className="bg-white rounded-lg border border-dashed border-gray-300 p-8 text-center text-sm text-gray-500">
                      No COA, MSDS, GMP, or certificates recorded for this customer yet.
                    </div>
                  ) : (
                    <div className="bg-white rounded-lg border border-gray-200 divide-y divide-gray-100 shadow-sm">
                      {documents.map((doc) => (
                        <div key={doc.id} className="p-3.5 flex items-center justify-between gap-3 hover:bg-slate-50">
                          <div className="flex items-center gap-3 min-w-0">
                            <FileText className="w-5 h-5 text-blue-600 shrink-0" />
                            <div className="min-w-0">
                              <div className="text-sm font-medium text-gray-900 truncate">
                                {doc.filename}
                              </div>
                              <div className="flex items-center gap-2 text-xs text-gray-500 mt-0.5">
                                <span className="px-1.5 py-0.5 rounded bg-blue-50 text-blue-700 font-semibold text-[10px]">
                                  {doc.documentType}
                                </span>
                                <span>{new Date(doc.created_at).toLocaleDateString()}</span>
                              </div>
                            </div>
                          </div>

                          <div className="flex items-center gap-1.5 shrink-0">
                            {doc.storagePath && (
                              <button
                                onClick={() => handleViewDocument(doc.storagePath!, doc.filename)}
                                className="px-2.5 py-1 text-xs font-medium bg-blue-50 text-blue-700 hover:bg-blue-100 rounded transition flex items-center gap-1"
                              >
                                <Eye className="w-3.5 h-3.5" />
                                View
                              </button>
                            )}
                          </div>
                        </div>
                      ))}
                    </div>
                  )}
                </div>
              )}

              {/* 5. ORDERS & FINANCIAL SECTION */}
              {activeSection === 'orders' && (
                <div className="space-y-6">
                  {/* Sales Orders */}
                  <div>
                    <h4 className="text-xs font-semibold text-gray-500 uppercase tracking-wider mb-2">
                      Sales Orders ({orders.length})
                    </h4>
                    {orders.length === 0 ? (
                      <div className="bg-white rounded-lg border border-dashed border-gray-200 p-4 text-xs text-gray-500">
                        No ERP sales orders recorded.
                      </div>
                    ) : (
                      <div className="bg-white rounded-lg border border-gray-200 divide-y divide-gray-100 shadow-sm">
                        {orders.map((so) => (
                          <div key={so.id} className="p-3 flex items-center justify-between text-xs">
                            <div>
                              <span className="font-semibold text-gray-900">{so.so_number}</span>
                              <span className="text-gray-400 ml-2">Date: {new Date(so.so_date).toLocaleDateString()}</span>
                            </div>
                            <div className="flex items-center gap-2">
                              <span className="font-bold text-gray-900">
                                {so.currency || 'IDR'} {Number(so.total_amount || 0).toLocaleString()}
                              </span>
                              <span className="px-2 py-0.5 rounded bg-gray-100 text-gray-700 font-medium">
                                {so.status}
                              </span>
                            </div>
                          </div>
                        ))}
                      </div>
                    )}
                  </div>

                  {/* Deliveries */}
                  <div>
                    <h4 className="text-xs font-semibold text-gray-500 uppercase tracking-wider mb-2">
                      Deliveries ({deliveries.length})
                    </h4>
                    {deliveries.length === 0 ? (
                      <div className="bg-white rounded-lg border border-dashed border-gray-200 p-4 text-xs text-gray-500">
                        No delivery challans recorded.
                      </div>
                    ) : (
                      <div className="bg-white rounded-lg border border-gray-200 divide-y divide-gray-100 shadow-sm">
                        {deliveries.map((dc) => (
                          <div key={dc.id} className="p-3 flex items-center justify-between text-xs">
                            <div>
                              <span className="font-semibold text-gray-900">{dc.challan_number}</span>
                              <span className="text-gray-400 ml-2">Date: {new Date(dc.challan_date).toLocaleDateString()}</span>
                            </div>
                            <span className="px-2 py-0.5 rounded bg-emerald-100 text-emerald-800 font-medium">
                              {dc.approval_status}
                            </span>
                          </div>
                        ))}
                      </div>
                    )}
                  </div>

                  {/* Invoices */}
                  <div>
                    <h4 className="text-xs font-semibold text-gray-500 uppercase tracking-wider mb-2">
                      Invoices & Payment Status ({invoices.length})
                    </h4>
                    {invoices.length === 0 ? (
                      <div className="bg-white rounded-lg border border-dashed border-gray-200 p-4 text-xs text-gray-500">
                        No invoices recorded.
                      </div>
                    ) : (
                      <div className="bg-white rounded-lg border border-gray-200 divide-y divide-gray-100 shadow-sm">
                        {invoices.map((inv) => (
                          <div key={inv.id} className="p-3 flex items-center justify-between text-xs">
                            <div>
                              <span className="font-semibold text-gray-900">{inv.invoice_number}</span>
                              <span className="text-gray-400 ml-2">Date: {new Date(inv.invoice_date).toLocaleDateString()}</span>
                            </div>
                            <div className="flex items-center gap-3">
                              <span className="font-bold text-gray-900">
                                IDR {Number(inv.total_amount).toLocaleString()}
                              </span>
                              <span className={`px-2 py-0.5 rounded font-medium ${
                                inv.payment_status === 'paid' ? 'bg-emerald-100 text-emerald-800' : 'bg-amber-100 text-amber-800'
                              }`}>
                                {inv.payment_status}
                              </span>
                            </div>
                          </div>
                        ))}
                      </div>
                    )}
                  </div>
                </div>
              )}

              {/* 6. ACTIVITY & REMINDERS SECTION */}
              {activeSection === 'activity' && (
                <div className="space-y-6">
                  {/* Log Note Box */}
                  <div className="bg-white rounded-lg border border-gray-200 p-4 shadow-sm space-y-3">
                    <div className="flex items-center justify-between">
                      <h4 className="text-xs font-semibold text-gray-900 uppercase tracking-wider">
                        Log Interaction / Note
                      </h4>
                      <div className="flex items-center gap-1">
                        {(['Note', 'Call', 'Meeting', 'LinkedIn'] as const).map((type) => (
                          <button
                            key={type}
                            type="button"
                            onClick={() => setNoteActivityType(type)}
                            className={`px-2 py-0.5 rounded text-[11px] font-medium transition ${
                              noteActivityType === type
                                ? type === 'LinkedIn'
                                  ? 'bg-sky-600 text-white font-semibold shadow-xs'
                                  : 'bg-blue-600 text-white font-semibold shadow-xs'
                                : 'bg-gray-100 text-gray-600 hover:bg-gray-200'
                            }`}
                          >
                            {type === 'LinkedIn' ? 'LinkedIn' : type}
                          </button>
                        ))}
                      </div>
                    </div>
                    <textarea
                      value={newNote}
                      onChange={(e) => setNewNote(e.target.value)}
                      placeholder={
                        noteActivityType === 'LinkedIn'
                          ? 'Record LinkedIn message, connection note, or profile outreach...'
                          : 'Add an internal note or meeting summary...'
                      }
                      rows={2}
                      className="w-full text-sm border border-gray-300 rounded-lg p-2.5 focus:ring-1 focus:ring-blue-500 focus:outline-none"
                    />
                    <div className="flex justify-between items-center">
                      <SpeechToTextButton
                        onTranscript={(text) => setNewNote((prev) => (prev ? prev + ' ' + text : text))}
                      />
                      <button
                        onClick={handleAddNote}
                        disabled={savingNote || !newNote.trim()}
                        className="px-3.5 py-1.5 bg-blue-600 text-white rounded-md text-xs font-semibold hover:bg-blue-700 disabled:opacity-50 transition"
                      >
                        {savingNote ? 'Saving...' : 'Save Note'}
                      </button>
                    </div>
                  </div>

                  {/* Add Reminder Box */}
                  <div className="bg-white rounded-lg border border-gray-200 p-4 shadow-sm space-y-3">
                    <h4 className="text-xs font-semibold text-gray-900 uppercase tracking-wider">
                      Set Follow-Up Reminder
                    </h4>
                    <div className="grid grid-cols-1 sm:grid-cols-3 gap-2">
                      <input
                        type="text"
                        value={newReminderTitle}
                        onChange={(e) => setNewReminderTitle(e.target.value)}
                        placeholder="Action item / follow-up reason..."
                        className="sm:col-span-2 text-xs border border-gray-300 rounded-lg p-2 focus:ring-1 focus:ring-blue-500 focus:outline-none"
                      />
                      <input
                        type="datetime-local"
                        value={newReminderDate}
                        onChange={(e) => setNewReminderDate(e.target.value)}
                        className="text-xs border border-gray-300 rounded-lg p-2 focus:ring-1 focus:ring-blue-500 focus:outline-none"
                      />
                    </div>
                    <div className="flex justify-end">
                      <button
                        onClick={handleAddReminder}
                        disabled={savingReminder || !newReminderTitle.trim() || !newReminderDate}
                        className="px-3.5 py-1.5 bg-emerald-600 text-white rounded-md text-xs font-semibold hover:bg-emerald-700 disabled:opacity-50 transition"
                      >
                        {savingReminder ? 'Saving...' : 'Set Reminder'}
                      </button>
                    </div>
                  </div>

                  {/* Past Activities & Reminders List */}
                  <div>
                    <h4 className="text-xs font-semibold text-gray-500 uppercase tracking-wider mb-2">
                      Activity History ({activities.length})
                    </h4>
                    {activities.length === 0 ? (
                      <div className="bg-white rounded-lg border border-dashed border-gray-300 p-6 text-center text-xs text-gray-500">
                        No activity recorded yet.
                      </div>
                    ) : (
                      <div className="bg-white rounded-lg border border-gray-200 divide-y divide-gray-100 shadow-sm">
                        {activities.map((act) => (
                          <div key={act.id} className="p-3 flex items-center justify-between text-xs">
                            <div className="flex items-center gap-2">
                              <span className={`px-2 py-0.5 rounded text-[10px] font-bold uppercase ${
                                act.type === 'Reminder' ? 'bg-amber-100 text-amber-800' : 'bg-blue-100 text-blue-800'
                              }`}>
                                {act.type}
                              </span>
                              <span className="font-medium text-gray-900">{act.title}</span>
                            </div>
                            <span className="text-gray-400">
                              {new Date(act.created_at).toLocaleString()}
                            </span>
                          </div>
                        ))}
                      </div>
                    )}
                  </div>
                </div>
              )}
            </>
          )}
        </div>
      </div>
    </div>
  );
}
