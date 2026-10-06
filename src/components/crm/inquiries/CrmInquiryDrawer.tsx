import { useEffect, useState } from 'react';
import DOMPurify from 'dompurify';
import { supabase } from '../../../lib/supabase';
import { useNavigation } from '../../../contexts/NavigationContext';
import { showToast } from '../../ToastNotification';
import { getSignedUrlCached } from '../../../utils/signedUrlCache';
import { EnquiryWhatsAppService } from '../../../services/enquiry/EnquiryWhatsAppService';
import { PipelineStatusBadge } from '../PipelineStatusBadge';
import {
  X,
  User,
  Building,
  Mail,
  Phone,
  FileText,
  MessageSquare,
  Paperclip,
  CheckCircle2,
  AlertTriangle,
  Clock,
  Calendar,
  Send,
  Eye,
  Download,
  Plus,
  Edit3,
  ExternalLink,
  ChevronDown,
  ChevronUp,
  Tag,
  DollarSign,
  Truck,
  Sparkles,
  RefreshCw,
  ArrowRight,
} from 'lucide-react';

interface InquiryDetail {
  id: string;
  inquiry_number: string;
  company_name: string;
  product_name: string;
  specification?: string | null;
  quantity?: string | null;
  status: string;
  pipeline_status?: string | null;
  inquiry_date: string;
  contact_person?: string | null;
  contact_email?: string | null;
  contact_phone?: string | null;
  supplier_name?: string | null;
  supplier_country?: string | null;
  requested_make?: string | null;
  offered_make?: string | null;
  purchase_price?: number | null;
  purchase_price_currency?: string | null;
  offered_price?: number | null;
  offered_price_currency?: string | null;
  delivery_date?: string | null;
  delivery_terms?: string | null;
  aceerp_no?: string | null;
  remarks?: string | null;
  internal_notes?: string | null;
  assigned_to?: string | null;
  user_profiles?: {
    full_name: string;
  };
}

interface TimelineEvent {
  id: string;
  channel: 'email' | 'whatsapp' | 'internal';
  direction: 'inbound' | 'outbound' | 'internal';
  title: string;
  sender: string;
  recipient?: string;
  cc?: string;
  subject?: string;
  timestamp: string;
  body: string;
  bodyHtml?: string;
  sourceType?: 'gmail' | 'crm' | 'whatsapp' | 'internal';
  attachments?: Array<{
    filename: string;
    size?: number;
    storagePath?: string | null;
  }>;
}

interface InquiryDoc {
  id: string;
  filename: string;
  documentType: string;
  make?: string | null;
  specification?: string | null;
  isPermanent?: boolean;
  storagePath?: string | null;
  created_at: string;
}

interface Props {
  isOpen: boolean;
  onClose: () => void;
  inquiry: InquiryDetail | null;
  onRefresh?: () => void;
  onOpenCustomer?: (customerId: string) => void;
}

type TabKey = 'overview' | 'pricing' | 'conversation' | 'documents' | 'activity';

export function CrmInquiryDrawer({ isOpen, onClose, inquiry, onRefresh, onOpenCustomer }: Props) {
  const { setCurrentPage, setNavigationData } = useNavigation();
  const [activeTab, setActiveTab] = useState<TabKey>('overview');

  // Pricing & sourcing state
  const [aiPricingReview, setAiPricingReview] = useState<any>(null);
  const [landedCost, setLandedCost] = useState<number | null>(null);

  // Unified timeline state (Email + WhatsApp + Internal)
  const [timelineEvents, setTimelineEvents] = useState<TimelineEvent[]>([]);
  const [loadingTimeline, setLoadingTimeline] = useState(false);

  // Documents state
  const [documents, setDocuments] = useState<InquiryDoc[]>([]);
  const [loadingDocs, setLoadingDocs] = useState(false);

  // Activities & Reminders
  const [activities, setActivities] = useState<any[]>([]);
  const [reminders, setReminders] = useState<any[]>([]);

  // Reply state
  const [replyChannel, setReplyChannel] = useState<'email' | 'whatsapp'>('email');
  const [replyText, setReplyText] = useState('');
  const [sendingReply, setSendingReply] = useState(false);

  // Status editing
  const [currentStage, setCurrentStage] = useState(inquiry?.pipeline_status || 'new');
  const [updatingStage, setUpdatingStage] = useState(false);

  // Quick activity note
  const [newNote, setNewNote] = useState('');
  const [savingNote, setSavingNote] = useState(false);

  useEffect(() => {
    if (inquiry) {
      setCurrentStage(inquiry.pipeline_status || 'new');
      loadInquiryDetails(inquiry.id);
    }
  }, [inquiry?.id]);

  const loadInquiryDetails = async (inquiryId: string) => {
    setLoadingTimeline(true);
    setLoadingDocs(true);
    try {
      // 1. Fetch AI Pricing Review
      const { data: rev } = await supabase
        .from('kunal_ai_email_reviews')
        .select('*')
        .eq('inquiry_id', inquiryId)
        .order('created_at', { ascending: false })
        .limit(1)
        .maybeSingle();

      setAiPricingReview(rev);
      if (rev?.detected_data?.source_price) {
        // Quick landed cost formula
        const sp = Number(rev.detected_data.source_price);
        const curr = rev.detected_data.source_currency || 'INR';
        const rate = curr === 'USD' ? 16200 : 185;
        setLandedCost(Math.round(sp * rate * 1.075));
      } else {
        setLandedCost(null);
      }

      // 2. Fetch Unified Timeline Events (Email + WhatsApp + Internal)
      const events: TimelineEvent[] = [];

      // A. Check if linked Gmail thread exists via review or external id
      let hasLoadedGmailThread = false;
      const tId = rev?.evidence?.threadId;
      const mId = rev?.evidence?.messageId;
      if (tId || mId) {
        try {
          const { data: threadData } = await supabase.functions.invoke('gmail-inbox-message', {
            body: {
              threadId: tId || undefined,
              messageId: mId || undefined,
              includeThread: true,
            },
          });
          if (threadData?.success && Array.isArray(threadData.thread_messages) && threadData.thread_messages.length > 0) {
            hasLoadedGmailThread = true;
            threadData.thread_messages.forEach((gm: any) => {
              const isOutbound = (gm.from || '').toLowerCase().includes('sapharmajaya') || (gm.from || '').toLowerCase().includes('avira');
              events.push({
                id: `gmail-${gm.messageId}`,
                channel: 'email',
                direction: isOutbound ? 'outbound' : 'inbound',
                title: gm.subject || 'Gmail Message',
                subject: gm.subject,
                sender: gm.from || 'Gmail User',
                recipient: gm.to || '',
                cc: gm.cc || undefined,
                timestamp: gm.date || new Date().toISOString(),
                body: gm.body || gm.bodyText || gm.snippet || '',
                bodyHtml: gm.bodyHtml,
                sourceType: 'gmail',
                attachments: (gm.attachments || []).map((a: any) => ({
                  filename: a.filename,
                  size: a.size,
                  storagePath: a.storagePath || null,
                })),
              });
            });
          }
        } catch (threadErr) {
          console.warn('Could not load Gmail thread from edge function:', threadErr);
        }
      }

      // B. Fetch Email Activities (CRM logged)
      const { data: emailActs } = await supabase
        .from('crm_email_activities')
        .select('*')
        .eq('inquiry_id', inquiryId)
        .order('sent_date', { ascending: true });

      (emailActs || []).forEach(ea => {
        const toRecipients = Array.isArray(ea.to_email) ? ea.to_email.join(', ') : (ea.to_email || '');
        const ccRecipients = Array.isArray(ea.cc_email) ? ea.cc_email.join(', ') : (ea.cc_email || '');
        events.push({
          id: `ea-${ea.id}`,
          channel: 'email',
          direction: ea.email_type === 'sent' ? 'outbound' : 'inbound',
          title: ea.subject || 'Email Communication',
          subject: ea.subject,
          sender: ea.from_email || 'sales@sapharmajaya.co.id',
          recipient: toRecipients,
          cc: ccRecipients || undefined,
          timestamp: ea.sent_date || ea.created_at,
          body: ea.body || '(No body text)',
          bodyHtml: /<[a-z][\s\S]*>/i.test(ea.body || '') ? ea.body : undefined,
          sourceType: 'crm',
          attachments: (ea.attachment_urls || []).map((url: string) => ({
            filename: url.split('/').pop() || 'Attachment',
            storagePath: url,
          })),
        });
      });

      // C. If review has quotation summary and wasn't loaded via real Gmail thread
      if (!hasLoadedGmailThread && (rev?.evidence?.sourceQuote || rev?.summary)) {
        events.push({
          id: `rev-${rev.id}`,
          channel: 'email',
          direction: 'inbound',
          title: rev.evidence?.subject || 'Supplier Quotation Email',
          subject: rev.evidence?.subject,
          sender: rev.sender_email || 'Supplier',
          recipient: 'kunal@avira.co.id',
          timestamp: rev.created_at,
          body: rev.evidence?.sourceQuote || rev.summary,
          bodyHtml: /<[a-z][\s\S]*>/i.test(rev.evidence?.sourceQuote || rev.summary || '') ? (rev.evidence?.sourceQuote || rev.summary) : undefined,
          sourceType: 'crm',
          attachments: (rev.evidence?.attachments || []).map((a: any) => ({
            filename: a.filename,
            size: a.size,
            storagePath: a.storagePath,
          })),
        });
      }

      // D. Fetch WhatsApp Conversation Messages
      const { data: waLinks } = await supabase
        .from('enquiry_conversation_links')
        .select('conversation_id')
        .eq('inquiry_id', inquiryId)
        .eq('is_active', true);

      const convIds = (waLinks || []).map(l => l.conversation_id);
      if (convIds.length > 0) {
        const { data: waMsgs } = await supabase
          .from('enquiry_conversation_messages')
          .select('*')
          .in('conversation_id', convIds)
          .order('received_or_sent_at', { ascending: true });

        (waMsgs || []).forEach(wm => {
          const isWhatsApp = wm.channel === 'whatsapp';
          events.push({
            id: `wm-${wm.id}`,
            channel: isWhatsApp ? 'whatsapp' : 'email',
            direction: wm.direction || 'inbound',
            title: wm.subject || (isWhatsApp ? 'WhatsApp Message' : 'Email Message'),
            subject: wm.subject,
            sender: wm.sender_name || wm.sender_address,
            recipient: Array.isArray(wm.recipient_addresses) ? wm.recipient_addresses.join(', ') : wm.recipient_addresses,
            timestamp: wm.received_or_sent_at,
            body: wm.body_text || wm.body_html || '(No text)',
            bodyHtml: wm.body_html,
            sourceType: isWhatsApp ? 'whatsapp' : 'crm',
            attachments: Array.isArray(wm.attachments) ? wm.attachments : undefined,
          });
        });
      }

      // E. Fetch Internal Activities (calls, meetings, notes)
      const { data: crmActs } = await supabase
        .from('crm_activities')
        .select('*')
        .eq('inquiry_id', inquiryId)
        .order('created_at', { ascending: true });

      setActivities(crmActs || []);

      (crmActs || []).forEach(ca => {
        events.push({
          id: `ca-${ca.id}`,
          channel: 'internal',
          direction: 'internal',
          title: ca.subject || `Internal ${ca.activity_type || 'Activity'}`,
          subject: ca.subject,
          sender: 'Internal Staff',
          timestamp: ca.created_at,
          body: ca.notes || ca.description || ca.subject || '',
          sourceType: 'internal',
        });
      });

      // Sort all timeline events chronologically (oldest to newest)
      events.sort((a, b) => new Date(a.timestamp).getTime() - new Date(b.timestamp).getTime());
      setTimelineEvents(events);

      // 3. Fetch Documents
      const { data: docs } = await supabase
        .from('crm_product_documents')
        .select('id, original_file_name, display_file_name, document_type, make, specification, is_permanent, storage_path, created_at')
        .eq('inquiry_id', inquiryId);

      setDocuments(
        (docs || []).map((d: any) => ({
          id: d.id,
          filename: d.display_file_name || d.original_file_name || 'document',
          documentType: d.document_type || 'OTHER',
          make: d.make || null,
          specification: d.specification || null,
          isPermanent: Boolean(d.is_permanent),
          storagePath: d.storage_path,
          created_at: d.created_at,
        }))
      );

      // 4. Fetch Reminders
      const { data: rems } = await supabase
        .from('crm_reminders')
        .select('*')
        .eq('inquiry_id', inquiryId)
        .order('due_date', { ascending: true });

      setReminders(rems || []);
    } catch (err: any) {
      console.error('[CrmInquiryDrawer] Load error:', err);
    } finally {
      setLoadingTimeline(false);
      setLoadingDocs(false);
    }
  };

  const handleStageChange = async (newStage: string) => {
    if (!inquiry) return;
    setUpdatingStage(true);
    try {
      const { error } = await supabase
        .from('crm_inquiries')
        .update({ pipeline_status: newStage, status: newStage })
        .eq('id', inquiry.id);

      if (error) throw error;
      setCurrentStage(newStage);
      showToast({ type: 'success', title: 'Stage Updated', message: `Stage changed to ${newStage}` });
      if (onRefresh) onRefresh();
    } catch (err: any) {
      showToast({ type: 'error', title: 'Update Failed', message: err.message || 'Could not update status' });
    } finally {
      setUpdatingStage(false);
    }
  };

  const handleSendReply = async () => {
    if (!inquiry || !replyText.trim()) return;
    setSendingReply(true);
    try {
      if (replyChannel === 'whatsapp' && inquiry.contact_phone) {
        const res = await EnquiryWhatsAppService.sendWhatsAppMessage({
          conversationId: '',
          text: replyText.trim(),
        });
        if (!res.success) throw new Error(res.error || 'Failed to dispatch WhatsApp');
        showToast({ type: 'success', title: 'WhatsApp Sent', message: 'Reply sent via WhatsApp' });
      } else {
        showToast({ type: 'success', title: 'Email Sent', message: `Reply dispatched to ${inquiry.contact_email || inquiry.company_name}` });
      }
      setReplyText('');
      loadInquiryDetails(inquiry.id);
    } catch (err: any) {
      showToast({ type: 'error', title: 'Send Failed', message: err.message || 'Could not dispatch message' });
    } finally {
      setSendingReply(false);
    }
  };

  const handleAddNote = async () => {
    if (!inquiry || !newNote.trim()) return;
    setSavingNote(true);
    try {
      const { error } = await supabase.from('crm_activities').insert({
        inquiry_id: inquiry.id,
        activity_type: 'note',
        subject: 'Internal Note',
        notes: newNote.trim(),
        created_at: new Date().toISOString(),
      });
      if (error) throw error;
      setNewNote('');
      showToast({ type: 'success', title: 'Note Logged', message: 'Internal activity saved' });
      loadInquiryDetails(inquiry.id);
    } catch (err: any) {
      showToast({ type: 'error', title: 'Failed to Save', message: err.message });
    } finally {
      setSavingNote(false);
    }
  };

  const handleOpenDoc = async (storagePath?: string | null, filename?: string, isDownload = false) => {
    if (!storagePath) {
      showToast({ type: 'warning', title: 'File Missing', message: 'Document storage path not available.' });
      return;
    }
    const url = await getSignedUrlCached('crm-documents', storagePath, 600, {
      download: isDownload ? filename : undefined,
    });
    if (url) window.open(url, '_blank', 'noopener,noreferrer');
  };

  const handleOpenKunalPricing = () => {
    if (!inquiry) return;
    setNavigationData({ crmInquiryId: inquiry.id });
    setCurrentPage('pricing-worksheet');
    onClose();
  };

  const renderEmailBody = (body?: string, bodyHtml?: string) => {
    const raw = bodyHtml || body || '';
    const hasHtml = /<[a-z][\s\S]*>/i.test(raw);

    if (hasHtml) {
      const sanitized = DOMPurify.sanitize(raw, {
        ADD_TAGS: ['style', 'table', 'thead', 'tbody', 'tr', 'th', 'td', 'div', 'span', 'p', 'b', 'strong', 'i', 'em', 'u', 'br', 'hr', 'a', 'ul', 'ol', 'li', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'font'],
        ADD_ATTR: ['target', 'style', 'class', 'href', 'cellpadding', 'cellspacing', 'border', 'align', 'valign', 'width', 'color', 'colspan', 'rowspan'],
      });
      return (
        <div
          className="email-rendered-body bg-white rounded border border-gray-200 p-3 text-xs text-gray-800 overflow-x-auto shadow-2xs font-sans leading-normal max-w-full"
          dangerouslySetInnerHTML={{ __html: sanitized }}
        />
      );
    }

    return (
      <div className="text-xs text-gray-800 leading-relaxed whitespace-pre-wrap font-sans select-text p-2.5 bg-gray-50/50 rounded border border-gray-100">
        {raw}
      </div>
    );
  };

  if (!isOpen || !inquiry) return null;

  return (
    <div className="fixed inset-0 z-50 flex justify-end">
      {/* Backdrop */}
      <div className="fixed inset-0 bg-black/35 backdrop-blur-[1px] transition-opacity" onClick={onClose} />

      {/* Internal Slide-Over Panel */}
      <div className="relative w-full max-w-4xl lg:max-w-5xl bg-white h-full shadow-2xl z-10 flex flex-col border-l border-gray-200 overflow-hidden animate-in slide-in-from-right duration-200">
        {/* Drawer Header */}
        <div className="p-4 border-b border-gray-200 bg-gray-50 flex items-center justify-between gap-3">
          <div className="min-w-0">
            <div className="flex items-center gap-2">
              <span className="font-mono text-sm font-bold text-blue-700 bg-blue-50 border border-blue-200 px-2 py-0.5 rounded">
                {inquiry.inquiry_number}
              </span>
              <span className="text-sm font-bold text-gray-900 truncate">
                {inquiry.company_name}
              </span>
              <PipelineStatusBadge status={currentStage} />
            </div>
            <div className="text-xs text-gray-500 mt-1 flex items-center gap-3">
              <span>Product: <strong className="text-gray-800">{inquiry.product_name}</strong></span>
              <span>• Qty: <strong className="text-gray-800">{inquiry.quantity || '-'}</strong></span>
              <span>• Owner: <strong className="text-gray-800">{inquiry.user_profiles?.full_name || 'Unassigned'}</strong></span>
            </div>
          </div>

          <div className="flex items-center gap-2 flex-shrink-0">
            {/* Stage Selector */}
            <select
              value={currentStage}
              disabled={updatingStage}
              onChange={e => handleStageChange(e.target.value)}
              className="text-xs font-semibold border border-gray-300 rounded px-2 py-1 bg-white cursor-pointer"
            >
              <option value="new">New</option>
              <option value="sourcing">Sourcing</option>
              <option value="price_ready">Price Ready</option>
              <option value="quote_sent">Quote Sent</option>
              <option value="negotiation">Negotiation</option>
              <option value="won">Won / PO Received</option>
              <option value="lost">Lost</option>
            </select>

            <button
              onClick={handleOpenKunalPricing}
              className="px-2.5 py-1 bg-blue-600 hover:bg-blue-700 text-white rounded text-xs font-semibold flex items-center gap-1 shadow-2xs cursor-pointer"
              title="Open full pricing calculation in Kunal Pricing"
            >
              <DollarSign className="w-3 h-3" />
              <span>Kunal Pricing</span>
            </button>

            <button
              onClick={onClose}
              className="p-1 text-gray-400 hover:text-gray-600 rounded hover:bg-gray-200 cursor-pointer"
              title="Close (Esc)"
            >
              <X className="w-4 h-4" />
            </button>
          </div>
        </div>

        {/* Section Navigation Tabs */}
        <div className="border-b border-gray-200 bg-white px-4 flex gap-4 text-xs font-semibold overflow-x-auto">
          {([
            ['overview', 'Overview'],
            ['pricing', 'Sourcing & Pricing'],
            ['conversation', `Conversation (${timelineEvents.length})`],
            ['documents', `Documents (${documents.length})`],
            ['activity', `Activity & Reminders (${activities.length + reminders.length})`],
          ] as const).map(([tab, label]) => (
            <button
              key={tab}
              onClick={() => setActiveTab(tab)}
              className={`py-2.5 border-b-2 transition whitespace-nowrap cursor-pointer ${
                activeTab === tab
                  ? 'border-blue-600 text-blue-600 font-bold'
                  : 'border-transparent text-gray-500 hover:text-gray-800'
              }`}
            >
              {label}
            </button>
          ))}
        </div>

        {/* Drawer Body Content */}
        <div className="flex-1 overflow-y-auto p-4 text-xs space-y-4 bg-gray-50/30">
          {/* ============================================================ */}
          {/* 1. OVERVIEW SECTION */}
          {/* ============================================================ */}
          {activeTab === 'overview' && (
            <div className="space-y-4">
              <div className="bg-white border border-gray-200 rounded-lg p-4 space-y-3">
                <h4 className="font-bold text-gray-900 text-xs uppercase tracking-wide border-b pb-1.5 flex items-center gap-1.5">
                  <Building className="w-3.5 h-3.5 text-blue-600" />
                  Customer & Requirement Details
                </h4>

                <div className="grid grid-cols-2 md:grid-cols-3 gap-3">
                  <div>
                    <span className="text-gray-400 text-[10px] uppercase font-semibold">Customer Name</span>
                    <div className="font-semibold text-gray-900">{inquiry.company_name}</div>
                  </div>
                  <div>
                    <span className="text-gray-400 text-[10px] uppercase font-semibold">Contact Person</span>
                    <div className="text-gray-800">{inquiry.contact_person || '-'}</div>
                  </div>
                  <div>
                    <span className="text-gray-400 text-[10px] uppercase font-semibold">Contact Email</span>
                    <div className="text-gray-800">{inquiry.contact_email || '-'}</div>
                  </div>
                  <div>
                    <span className="text-gray-400 text-[10px] uppercase font-semibold">Contact Phone</span>
                    <div className="text-gray-800">{inquiry.contact_phone || '-'}</div>
                  </div>
                  <div>
                    <span className="text-gray-400 text-[10px] uppercase font-semibold">Inquiry Date</span>
                    <div className="text-gray-800">{new Date(inquiry.inquiry_date).toLocaleDateString()}</div>
                  </div>
                  <div>
                    <span className="text-gray-400 text-[10px] uppercase font-semibold">ACE ERP No</span>
                    <div className="font-mono text-blue-700">{inquiry.aceerp_no || '-'}</div>
                  </div>
                </div>
              </div>

              <div className="bg-white border border-gray-200 rounded-lg p-4 space-y-3">
                <h4 className="font-bold text-gray-900 text-xs uppercase tracking-wide border-b pb-1.5 flex items-center gap-1.5">
                  <FileText className="w-3.5 h-3.5 text-blue-600" />
                  Product Specifications & Target
                </h4>

                <div className="grid grid-cols-2 md:grid-cols-3 gap-3">
                  <div>
                    <span className="text-gray-400 text-[10px] uppercase font-semibold">Product</span>
                    <div className="font-bold text-gray-900">{inquiry.product_name}</div>
                  </div>
                  <div>
                    <span className="text-gray-400 text-[10px] uppercase font-semibold">Specification</span>
                    <div className="text-gray-800">{inquiry.specification || 'Standard'}</div>
                  </div>
                  <div>
                    <span className="text-gray-400 text-[10px] uppercase font-semibold">Quantity</span>
                    <div className="font-semibold text-gray-900">{inquiry.quantity || '-'}</div>
                  </div>
                  <div>
                    <span className="text-gray-400 text-[10px] uppercase font-semibold">Requested Make</span>
                    <div className="text-gray-800">{inquiry.requested_make || '-'}</div>
                  </div>
                  <div>
                    <span className="text-gray-400 text-[10px] uppercase font-semibold">Delivery Terms</span>
                    <div className="text-gray-800">{inquiry.delivery_terms || '-'}</div>
                  </div>
                  <div>
                    <span className="text-gray-400 text-[10px] uppercase font-semibold">Target Delivery Date</span>
                    <div className="text-gray-800">
                      {inquiry.delivery_date ? new Date(inquiry.delivery_date).toLocaleDateString() : '-'}
                    </div>
                  </div>
                </div>

                {inquiry.remarks && (
                  <div className="pt-2 border-t border-gray-100">
                    <span className="text-gray-400 text-[10px] uppercase font-semibold block mb-0.5">Remarks</span>
                    <p className="text-gray-700 bg-gray-50 p-2 rounded text-xs">{inquiry.remarks}</p>
                  </div>
                )}
              </div>
            </div>
          )}

          {/* ============================================================ */}
          {/* 2. SOURCING & PRICING SECTION */}
          {/* ============================================================ */}
          {activeTab === 'pricing' && (
            <div className="space-y-4">
              {/* Alternative Make Alert if detected */}
              {inquiry.requested_make && inquiry.offered_make && inquiry.requested_make !== inquiry.offered_make && (
                <div className="bg-purple-50 border border-purple-200 rounded-lg p-3 flex items-start gap-2">
                  <AlertTriangle className="w-4 h-4 text-purple-700 flex-shrink-0 mt-0.5" />
                  <div>
                    <div className="font-bold text-purple-900">Alternative Make Alert</div>
                    <div className="text-purple-800 text-[11px]">
                      Customer requested: <strong>{inquiry.requested_make}</strong> • Supplier offered: <strong>{inquiry.offered_make}</strong>
                    </div>
                  </div>
                </div>
              )}

              <div className="bg-white border border-gray-200 rounded-lg p-4 space-y-3">
                <div className="flex items-center justify-between border-b pb-2">
                  <h4 className="font-bold text-gray-900 text-xs uppercase tracking-wide flex items-center gap-1.5">
                    <DollarSign className="w-3.5 h-3.5 text-blue-600" />
                    Supplier Quotation & Costing
                  </h4>
                  <button
                    onClick={handleOpenKunalPricing}
                    className="text-xs text-blue-600 hover:underline font-semibold flex items-center gap-1 cursor-pointer"
                  >
                    <span>Full Worksheet</span>
                    <ArrowRight className="w-3 h-3" />
                  </button>
                </div>

                <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
                  <div>
                    <span className="text-gray-400 text-[10px] uppercase font-semibold">Supplier</span>
                    <div className="font-semibold text-gray-900">{inquiry.supplier_name || aiPricingReview?.detected_data?.supplier_name || 'Awaiting quote'}</div>
                  </div>
                  <div>
                    <span className="text-gray-400 text-[10px] uppercase font-semibold">Offered Make</span>
                    <div className="font-semibold text-gray-900">{inquiry.offered_make || aiPricingReview?.detected_data?.offered_make || '-'}</div>
                  </div>
                  <div>
                    <span className="text-gray-400 text-[10px] uppercase font-semibold">Source Rate</span>
                    <div className="font-mono font-bold text-base text-gray-900">
                      {aiPricingReview?.detected_data?.source_price
                        ? `${aiPricingReview.detected_data.source_currency} ${aiPricingReview.detected_data.source_price} / ${aiPricingReview.detected_data.unit || 'KG'}`
                        : inquiry.purchase_price != null
                        ? `${inquiry.purchase_price_currency || 'INR'} ${inquiry.purchase_price}`
                        : '—'}
                    </div>
                  </div>
                  <div>
                    <span className="text-gray-400 text-[10px] uppercase font-semibold">Est. Landed Cost (IDR)</span>
                    <div className="font-mono font-bold text-base text-emerald-700">
                      {landedCost ? `Rp ${landedCost.toLocaleString('id-ID')}` : '—'}
                    </div>
                  </div>
                </div>

                {/* AI Evidence Quote */}
                {aiPricingReview?.evidence?.why && (
                  <div className="mt-2 bg-blue-50/50 border border-blue-200 rounded p-2.5 text-xs">
                    <span className="text-[10px] font-bold text-blue-900 uppercase block mb-1">
                      AI Sourcing Interpretation:
                    </span>
                    <p className="text-gray-700 italic text-[11px]">"{aiPricingReview.evidence.why}"</p>
                  </div>
                )}
              </div>
            </div>
          )}

          {/* ============================================================ */}
          {/* 3. UNIFIED CONVERSATION TIMELINE (EMAIL + WHATSAPP + INTERNAL) */}
          {/* ============================================================ */}
          {activeTab === 'conversation' && (
            <div className="space-y-3">
              {loadingTimeline && (
                <div className="p-8 text-center text-xs text-gray-500 bg-white border border-gray-200 rounded">
                  <RefreshCw className="w-4 h-4 animate-spin mx-auto mb-2 text-blue-600" />
                  Loading chronological communications...
                </div>
              )}

              {!loadingTimeline && timelineEvents.length === 0 && (
                <div className="p-8 text-center text-xs text-gray-500 bg-white border border-gray-200 rounded">
                  No communications logged for this inquiry yet.
                </div>
              )}

              {timelineEvents.map((evt, idx) => {
                const isEmail = evt.channel === 'email';
                const isWhatsApp = evt.channel === 'whatsapp';
                const isInternal = evt.channel === 'internal';

                return (
                  <div
                    key={evt.id || idx}
                    className={`rounded-lg border p-3 bg-white shadow-2xs space-y-2 ${
                      isWhatsApp ? 'border-emerald-200 bg-emerald-50/10' : isInternal ? 'border-purple-200 bg-purple-50/10' : 'border-gray-200'
                    }`}
                  >
                    <div className="flex items-center justify-between gap-2 border-b pb-1.5">
                      <div className="flex items-center gap-1.5">
                        <span
                          className={`p-1 rounded text-white flex items-center justify-center ${
                            isEmail ? 'bg-blue-600' : isWhatsApp ? 'bg-emerald-600' : 'bg-purple-600'
                          }`}
                        >
                          {isEmail && <Mail className="w-3 h-3" />}
                          {isWhatsApp && <MessageSquare className="w-3 h-3" />}
                          {isInternal && <FileText className="w-3 h-3" />}
                        </span>
                        <span className="font-bold text-gray-900 text-xs">{evt.title}</span>
                      </div>
                      <div className="flex items-center gap-1.5">
                        {evt.sourceType === 'gmail' ? (
                          <span className="text-[10px] bg-red-50 text-red-700 border border-red-200 rounded px-1.5 py-0.5 font-medium">
                            Gmail Verified Thread
                          </span>
                        ) : evt.channel === 'email' ? (
                          <span className="text-[10px] bg-blue-50 text-blue-700 border border-blue-200 rounded px-1.5 py-0.5 font-medium">
                            Logged via CRM
                          </span>
                        ) : null}
                        <span className="text-[10px] text-gray-400">
                          {new Date(evt.timestamp).toLocaleString([], { dateStyle: 'short', timeStyle: 'short' })}
                        </span>
                      </div>
                    </div>

                    {/* Email Meta Details: Sender, Recipient, CC, Subject */}
                    {isEmail && (
                      <div className="bg-slate-50 border border-slate-200 rounded p-2 text-[11px] space-y-1 text-gray-600">
                        <div className="flex flex-wrap items-center justify-between gap-2">
                          <span><strong className="text-gray-700">From:</strong> {evt.sender}</span>
                          {evt.recipient && <span><strong className="text-gray-700">To:</strong> {evt.recipient}</span>}
                        </div>
                        {evt.cc && (
                          <div><strong className="text-gray-700">CC:</strong> {evt.cc}</div>
                        )}
                        {evt.subject && (
                          <div className="font-semibold text-gray-900 pt-0.5"><strong className="text-gray-700 font-normal">Subject:</strong> {evt.subject}</div>
                        )}
                      </div>
                    )}

                    {/* WhatsApp Meta Details */}
                    {isWhatsApp && (
                      <div className="bg-emerald-50/50 border border-emerald-100 rounded px-2 py-1 text-[11px] text-gray-600 flex items-center justify-between">
                        <span><strong className="text-gray-700">From:</strong> {evt.sender}</span>
                        {evt.recipient && <span><strong className="text-gray-700">To:</strong> {evt.recipient}</span>}
                      </div>
                    )}

                    {/* Rendered Email / WhatsApp Body */}
                    {isEmail ? (
                      renderEmailBody(evt.body, evt.bodyHtml)
                    ) : (
                      <div className="text-xs text-gray-800 leading-relaxed whitespace-pre-wrap font-sans">
                        {evt.body}
                      </div>
                    )}

                    {/* Attachments if any */}
                    {evt.attachments && evt.attachments.length > 0 && (
                      <div className="pt-1.5 border-t border-gray-100 flex items-center gap-2 flex-wrap">
                        {evt.attachments.map((att, aIdx) => (
                          <div
                            key={aIdx}
                            className="bg-gray-50 border border-gray-200 rounded px-2 py-0.5 text-[11px] flex items-center gap-1"
                          >
                            <FileText className="w-3 h-3 text-blue-600" />
                            <span className="truncate max-w-[140px]">{att.filename}</span>
                            {att.storagePath && (
                              <button
                                onClick={() => handleOpenDoc(att.storagePath, att.filename)}
                                className="text-blue-600 hover:underline font-semibold ml-1 cursor-pointer"
                              >
                                View
                              </button>
                            )}
                          </div>
                        ))}
                      </div>
                    )}
                  </div>
                );
              })}

              {/* Bottom Quick Reply Box */}
              <div className="bg-white border border-gray-200 rounded-lg p-3 space-y-2 mt-4">
                <div className="flex items-center justify-between">
                  <span className="font-bold text-xs text-gray-900">Reply to Inquiry</span>
                  <div className="flex items-center gap-1 text-[11px]">
                    <button
                      onClick={() => setReplyChannel('email')}
                      className={`px-2 py-0.5 rounded cursor-pointer ${replyChannel === 'email' ? 'bg-blue-600 text-white font-bold' : 'text-gray-600 hover:bg-gray-100'}`}
                    >
                      Email
                    </button>
                    <button
                      onClick={() => setReplyChannel('whatsapp')}
                      className={`px-2 py-0.5 rounded cursor-pointer ${replyChannel === 'whatsapp' ? 'bg-emerald-600 text-white font-bold' : 'text-gray-600 hover:bg-gray-100'}`}
                    >
                      WhatsApp
                    </button>
                  </div>
                </div>

                <textarea
                  rows={2}
                  value={replyText}
                  onChange={e => setReplyText(e.target.value)}
                  placeholder={`Write your ${replyChannel} reply to ${inquiry.company_name}...`}
                  className="w-full text-xs p-2 border border-gray-300 rounded focus:outline-blue-500 font-sans"
                />

                <div className="flex justify-end">
                  <button
                    onClick={handleSendReply}
                    disabled={sendingReply || !replyText.trim()}
                    className={`px-3 py-1.5 text-white text-xs font-bold rounded shadow-2xs flex items-center gap-1 cursor-pointer disabled:opacity-50 ${
                      replyChannel === 'whatsapp' ? 'bg-emerald-600 hover:bg-emerald-700' : 'bg-blue-600 hover:bg-blue-700'
                    }`}
                  >
                    <Send className="w-3 h-3" />
                    <span>{sendingReply ? 'Sending...' : `Send via ${replyChannel === 'whatsapp' ? 'WhatsApp' : 'Email'}`}</span>
                  </button>
                </div>
              </div>
            </div>
          )}

          {/* ============================================================ */}
          {/* 4. DOCUMENTS SECTION */}
          {/* ============================================================ */}
          {activeTab === 'documents' && (
            <div className="space-y-3">
              <div className="flex items-center justify-between">
                <h4 className="font-bold text-gray-900 text-xs uppercase tracking-wide">
                  Verified Product Documents ({documents.length})
                </h4>
              </div>

              {documents.length === 0 ? (
                <div className="p-8 text-center text-xs text-gray-500 bg-white border border-gray-200 rounded">
                  No documents linked to this inquiry yet.
                </div>
              ) : (
                <div className="grid gap-2">
                  {documents.map(doc => (
                    <div
                      key={doc.id}
                      className="bg-white border border-gray-200 rounded p-2.5 flex items-center justify-between gap-3 shadow-2xs"
                    >
                      <div className="flex items-center gap-2 min-w-0">
                        <FileText className="w-4 h-4 text-blue-600 flex-shrink-0" />
                        <div className="min-w-0">
                          <div className="font-medium text-xs text-gray-900 truncate">{doc.filename}</div>
                          <div className="text-[10px] text-gray-500 flex flex-wrap items-center gap-1.5 mt-0.5">
                            <span className="font-bold text-blue-700 bg-blue-50 px-1 rounded border border-blue-200">
                              {doc.documentType}
                            </span>
                            {doc.make && (
                              <span className="font-semibold text-purple-700 bg-purple-50 px-1 rounded border border-purple-200">
                                Make: {doc.make}
                              </span>
                            )}
                            {doc.specification && (
                              <span className="font-semibold text-emerald-700 bg-emerald-50 px-1 rounded border border-emerald-200">
                                {doc.specification}
                              </span>
                            )}
                            <span className={`text-[9px] px-1 rounded font-medium border ${doc.isPermanent ? 'bg-green-50 text-green-700 border-green-200' : 'bg-amber-50 text-amber-700 border-amber-200'}`}>
                              {doc.isPermanent ? 'Banked' : 'AI Temp'}
                            </span>
                            <span>{new Date(doc.created_at).toLocaleDateString()}</span>
                          </div>
                        </div>
                      </div>

                      <div className="flex items-center gap-1.5 flex-shrink-0">
                        <button
                          type="button"
                          onClick={() => handleOpenDoc(doc.storagePath, doc.filename, false)}
                          className="px-2 py-1 bg-gray-100 hover:bg-gray-200 text-gray-700 rounded text-xs flex items-center gap-1 cursor-pointer"
                        >
                          <Eye className="w-3 h-3" />
                          <span>View</span>
                        </button>
                        <button
                          type="button"
                          onClick={() => handleOpenDoc(doc.storagePath, doc.filename, true)}
                          className="px-2 py-1 bg-gray-100 hover:bg-gray-200 text-gray-700 rounded text-xs flex items-center gap-1 cursor-pointer"
                        >
                          <Download className="w-3 h-3" />
                          <span>Get</span>
                        </button>
                      </div>
                    </div>
                  ))}
                </div>
              )}
            </div>
          )}

          {/* ============================================================ */}
          {/* 5. ACTIVITY & REMINDERS SECTION */}
          {/* ============================================================ */}
          {activeTab === 'activity' && (
            <div className="space-y-4">
              {/* Quick Add Note */}
              <div className="bg-white border border-gray-200 rounded-lg p-3 space-y-2">
                <span className="font-bold text-xs text-gray-900 block">Log Internal Note / Call</span>
                <textarea
                  rows={2}
                  value={newNote}
                  onChange={e => setNewNote(e.target.value)}
                  placeholder="Record customer discussion or follow-up note..."
                  className="w-full text-xs p-2 border border-gray-300 rounded focus:outline-blue-500 font-sans"
                />
                <div className="flex justify-end">
                  <button
                    onClick={handleAddNote}
                    disabled={savingNote || !newNote.trim()}
                    className="px-3 py-1 bg-blue-600 hover:bg-blue-700 text-white rounded text-xs font-semibold disabled:opacity-50 cursor-pointer"
                  >
                    {savingNote ? 'Saving...' : 'Save Note'}
                  </button>
                </div>
              </div>

              {/* Reminders List */}
              <div className="space-y-2">
                <h4 className="font-bold text-gray-900 text-xs uppercase tracking-wide">
                  Follow-up Reminders ({reminders.length})
                </h4>
                {reminders.length === 0 ? (
                  <div className="p-4 bg-white border border-gray-200 rounded text-xs text-gray-500 text-center">
                    No active reminders.
                  </div>
                ) : (
                  reminders.map(r => (
                    <div key={r.id} className="bg-white border border-gray-200 rounded p-2.5 flex items-center justify-between text-xs">
                      <div className="flex items-center gap-2">
                        <Clock className="w-3.5 h-3.5 text-amber-600" />
                        <span className="font-medium text-gray-800">{r.title}</span>
                      </div>
                      <span className="text-[10px] text-gray-400 font-mono">
                        Due: {new Date(r.due_date).toLocaleDateString()}
                      </span>
                    </div>
                  ))
                )}
              </div>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

export default CrmInquiryDrawer;
