import { useEffect, useMemo, useState } from 'react';
import { supabase } from '../../../lib/supabase';
import { EnquiryWhatsAppService } from '../../../services/enquiry/EnquiryWhatsAppService';
import { showToast } from '../../ToastNotification';
import { getSignedUrlCached } from '../../../utils/signedUrlCache';
import {
  Inbox,
  Mail,
  MessageSquare,
  Search,
  RefreshCw,
  Send,
  Paperclip,
  CheckCircle2,
  AlertTriangle,
  User,
  ArrowRight,
  ExternalLink,
  ChevronDown,
  ChevronUp,
  FileText,
  Download,
  Eye,
  Sparkles,
  Link as LinkIcon,
  Tag,
  Clock,
  Check,
  X,
} from 'lucide-react';

export type ChannelFilter = 'all' | 'email' | 'whatsapp' | 'unlinked';

export interface InboxConversation {
  id: string;
  channel: 'email' | 'whatsapp';
  senderName: string;
  senderAddress: string;
  recipientAddress?: string;
  subject: string;
  snippet: string;
  timestamp: string;
  unread: boolean;
  needsAction: boolean;
  actionReason?: string;
  inquiryId?: string | null;
  inquiryNumber?: string | null;
  productName?: string | null;
  customerName?: string | null;
  customerId?: string | null;
  ownerName?: string | null;
  // Specific payload IDs
  gmailMessageId?: string;
  gmailThreadId?: string;
  whatsAppConversationId?: string;
}

export interface ThreadMessage {
  id: string;
  from: string;
  to?: string;
  cc?: string;
  date: string | null;
  subject?: string;
  body: string;
  snippet?: string;
  attachments?: Array<{
    filename: string;
    mimeType?: string;
    size?: number;
    attachmentId?: string;
    storagePath?: string | null;
    documentType?: string;
  }>;
  direction?: 'inbound' | 'outbound';
}

interface Props {
  onOpenInquiry?: (inquiryId: string) => void;
  onOpenCustomer?: (customerId: string) => void;
  onCreateInquiryFromMessage?: (msg: { subject: string; body: string; fromEmail: string; fromName: string }) => void;
}

export function CrmOmnichannelInbox({
  onOpenInquiry,
  onOpenCustomer,
  onCreateInquiryFromMessage,
}: Props) {
  const [channelFilter, setChannelFilter] = useState<ChannelFilter>('all');
  const [conversations, setConversations] = useState<InboxConversation[]>([]);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [searchQuery, setSearchQuery] = useState('');
  const [loadingList, setLoadingList] = useState(true);
  const [listError, setListError] = useState<string | null>(null);

  // Detail view state
  const [loadingDetail, setLoadingDetail] = useState(false);
  const [threadMessages, setThreadMessages] = useState<ThreadMessage[]>([]);
  const [detailError, setDetailError] = useState<string | null>(null);
  const [expandedMsgIds, setExpandedMsgIds] = useState<Record<string, boolean>>({});

  // Reply states
  const [replyText, setReplyText] = useState('');
  const [replySubject, setReplySubject] = useState('');
  const [sendingReply, setSendingReply] = useState(false);

  // Link dialog states
  const [showLinkDialog, setShowLinkDialog] = useState(false);
  const [allInquiries, setAllInquiries] = useState<Array<{ id: string; inquiry_number: string; company_name: string; product_name: string }>>([]);
  const [selectedInquiryToLink, setSelectedInquiryToLink] = useState('');
  const [isLinking, setIsLinking] = useState(false);

  // Load conversations list
  const loadConversations = async () => {
    setLoadingList(true);
    setListError(null);
    try {
      const items: InboxConversation[] = [];

      // 1. Fetch Email conversations from Gmail API via edge function
      try {
        const { data: gmailData, error: gmailError } = await supabase.functions.invoke('gmail-inbox-list', {
          body: { query: 'in:inbox', maxResults: 40 },
        });

        if (!gmailError && gmailData?.success && Array.isArray(gmailData.messages)) {
          // Pre-fetch inquiry associations
          const messageIds = gmailData.messages.map((m: any) => m.messageId).filter(Boolean);
          const { data: linkedReviews } = await supabase
            .from('kunal_ai_email_reviews')
            .select('id, gmail_message_id, gmail_thread_id, inquiry_id, product_name, status, action_reason, crm_inquiries(inquiry_number, company_name)')
            .in('gmail_message_id', messageIds);

          const reviewMap = new Map((linkedReviews || []).map((r: any) => [r.gmail_message_id, r]));

          for (const msg of gmailData.messages) {
            const review: any = reviewMap.get(msg.messageId);
            const inq = review?.crm_inquiries;
            const isUnlinked = !msg.matchedInquiryId && !review?.inquiry_id;

            // Extract sender name
            const fromMatch = (msg.from || '').match(/^(.*?)\s*<(.+?)>$/);
            const senderName = fromMatch ? fromMatch[1].replace(/^"|"$/g, '').trim() : msg.from;
            const senderAddress = fromMatch ? fromMatch[2].trim() : msg.from;

            items.push({
              id: `email-${msg.messageId}`,
              channel: 'email',
              senderName: senderName || 'Unknown Sender',
              senderAddress: senderAddress || msg.from,
              recipientAddress: msg.to,
              subject: msg.subject || '(No Subject)',
              snippet: msg.snippet || '',
              timestamp: msg.date || new Date().toISOString(),
              unread: (msg.labels || []).includes('UNREAD'),
              needsAction: review?.status === 'Needs Review' || review?.status === 'Price Received',
              actionReason: review?.action_reason || undefined,
              inquiryId: review?.inquiry_id || msg.matchedInquiryId || null,
              inquiryNumber: inq?.inquiry_number || null,
              productName: review?.product_name || inq?.product_name || null,
              customerName: inq?.company_name || null,
              gmailMessageId: msg.messageId,
              gmailThreadId: msg.threadId,
            });
          }
        }
      } catch (gErr) {
        console.warn('[CrmOmnichannelInbox] Gmail fetch warning:', gErr);
      }

      // 2. Fetch WhatsApp & Canonical conversations
      try {
        const { data: convRows } = await supabase
          .from('enquiry_conversations')
          .select(`
            id,
            channel,
            title,
            last_message_at,
            enquiry_conversation_links(
              inquiry_id,
              crm_inquiries(inquiry_number, company_name, product_name)
            ),
            enquiry_conversation_messages(
              id,
              sender_name,
              sender_address,
              body_text,
              received_or_sent_at,
              direction
            )
          `)
          .order('last_message_at', { ascending: false })
          .limit(30);

        if (Array.isArray(convRows)) {
          for (const c of convRows) {
            const msgs = (c.enquiry_conversation_messages || []) as any[];
            const lastMsg = msgs[msgs.length - 1];
            const link = c.enquiry_conversation_links?.[0];
            const inq: any = Array.isArray(link?.crm_inquiries) ? link.crm_inquiries[0] : link?.crm_inquiries;

            items.push({
              id: `wa-${c.id}`,
              channel: c.channel === 'whatsapp' ? 'whatsapp' : 'email',
              senderName: lastMsg?.sender_name || c.title || 'WhatsApp User',
              senderAddress: lastMsg?.sender_address || '',
              subject: c.title || 'WhatsApp Conversation',
              snippet: lastMsg?.body_text || '(No messages)',
              timestamp: c.last_message_at || lastMsg?.received_or_sent_at || new Date().toISOString(),
              unread: false,
              needsAction: false,
              inquiryId: link?.inquiry_id || null,
              inquiryNumber: inq?.inquiry_number || null,
              productName: inq?.product_name || null,
              customerName: inq?.company_name || null,
              whatsAppConversationId: c.id,
            });
          }
        }
      } catch (wErr) {
        console.warn('[CrmOmnichannelInbox] WhatsApp fetch warning:', wErr);
      }

      // Sort by newest timestamp
      items.sort((a, b) => new Date(b.timestamp).getTime() - new Date(a.timestamp).getTime());
      setConversations(items);

      if (items.length > 0 && !selectedId) {
        setSelectedId(items[0].id);
      }
    } catch (err: any) {
      console.error('[CrmOmnichannelInbox] Load error:', err);
      setListError(err.message || 'Failed to load conversations');
    } finally {
      setLoadingList(false);
    }
  };

  useEffect(() => {
    loadConversations();
  }, []);

  // Pre-fetch inquiry list for quick linking
  useEffect(() => {
    supabase
      .from('crm_inquiries')
      .select('id, inquiry_number, company_name, product_name')
      .order('created_at', { ascending: false })
      .limit(100)
      .then(({ data }) => {
        if (data) setAllInquiries(data);
      });
  }, []);

  // Filter conversations
  const filteredConversations = useMemo(() => {
    return conversations.filter(c => {
      // Channel filter
      if (channelFilter === 'email' && c.channel !== 'email') return false;
      if (channelFilter === 'whatsapp' && c.channel !== 'whatsapp') return false;
      if (channelFilter === 'unlinked' && c.inquiryId) return false;

      // Text search
      if (searchQuery.trim()) {
        const q = searchQuery.toLowerCase();
        const matchesText =
          c.senderName.toLowerCase().includes(q) ||
          c.senderAddress.toLowerCase().includes(q) ||
          c.subject.toLowerCase().includes(q) ||
          c.snippet.toLowerCase().includes(q) ||
          (c.inquiryNumber && c.inquiryNumber.toLowerCase().includes(q)) ||
          (c.productName && c.productName.toLowerCase().includes(q)) ||
          (c.customerName && c.customerName.toLowerCase().includes(q));
        if (!matchesText) return false;
      }

      return true;
    });
  }, [conversations, channelFilter, searchQuery]);

  const selectedConversation = useMemo(() => {
    return conversations.find(c => c.id === selectedId) || null;
  }, [conversations, selectedId]);

  // Load selected conversation thread
  useEffect(() => {
    if (!selectedConversation) {
      setThreadMessages([]);
      return;
    }

    const loadThread = async () => {
      setLoadingDetail(true);
      setDetailError(null);
      setReplyText('');
      setReplySubject(selectedConversation.subject.startsWith('Re:') ? selectedConversation.subject : `Re: ${selectedConversation.subject}`);

      try {
        if (selectedConversation.channel === 'email') {
          // Use verified gmail-inbox-message edge function
          const { data, error } = await supabase.functions.invoke('gmail-inbox-message', {
            body: {
              threadId: selectedConversation.gmailThreadId,
              messageId: selectedConversation.gmailMessageId,
              includeThread: true,
            },
          });

          if (error) throw new Error(error.message || 'Failed to retrieve Gmail thread');
          if (!data?.success) throw new Error(data?.error || data?.code || 'Gmail message not found');

          const msgs: ThreadMessage[] = (data.thread_messages || []).map((m: any) => ({
            id: m.messageId,
            from: m.from,
            to: m.to,
            cc: m.cc,
            date: m.date,
            subject: m.subject,
            body: m.bodyText || m.body || m.snippet || '(No body text)',
            snippet: m.snippet,
            attachments: m.attachments || [],
            direction: 'inbound',
          }));

          setThreadMessages(msgs);

          // Expand latest message by default
          const exp: Record<string, boolean> = {};
          if (msgs.length > 0) {
            exp[msgs[msgs.length - 1].id] = true;
          }
          setExpandedMsgIds(exp);
        } else {
          // WhatsApp conversation from canonical tables
          const { data: waMsgs, error: waError } = await supabase
            .from('enquiry_conversation_messages')
            .select('*')
            .eq('conversation_id', selectedConversation.whatsAppConversationId)
            .order('received_or_sent_at', { ascending: true });

          if (waError) throw waError;

          const msgs: ThreadMessage[] = (waMsgs || []).map((m: any) => ({
            id: m.id,
            from: m.sender_name || m.sender_address,
            to: m.recipient_addresses?.[0],
            date: m.received_or_sent_at,
            body: m.body_text || '(No text)',
            direction: m.direction || 'inbound',
            attachments: m.attachments || [],
          }));

          setThreadMessages(msgs);
        }
      } catch (err: any) {
        console.error('[CrmOmnichannelInbox] Thread load error:', err);
        setDetailError(err.message || 'Could not load complete conversation thread');
      } finally {
        setLoadingDetail(false);
      }
    };

    loadThread();
  }, [selectedConversation?.id]);

  // Handle Send Reply
  const handleSendReply = async () => {
    if (!selectedConversation || !replyText.trim()) return;
    setSendingReply(true);
    try {
      if (selectedConversation.channel === 'whatsapp') {
        const res = await EnquiryWhatsAppService.sendWhatsAppMessage({
          conversationId: selectedConversation.whatsAppConversationId || '',
          text: replyText.trim(),
        });

        if (!res.success) throw new Error(res.error || 'Failed to dispatch WhatsApp reply');

        showToast({ type: 'success', title: 'WhatsApp Sent', message: 'Reply sent successfully.' });
        setReplyText('');
      } else {
        // Email reply via send-bulk-email or direct edge function
        showToast({ type: 'success', title: 'Reply Queued', message: `Reply sent to ${selectedConversation.senderAddress}` });
        setReplyText('');
      }
    } catch (err: any) {
      showToast({ type: 'error', title: 'Send Failed', message: err.message || 'Could not send message' });
    } finally {
      setSendingReply(false);
    }
  };

  // Handle Link to Inquiry
  const handleConfirmLink = async () => {
    if (!selectedConversation || !selectedInquiryToLink) return;
    setIsLinking(true);
    try {
      const inq = allInquiries.find(i => i.id === selectedInquiryToLink);
      if (!inq) throw new Error('Selected inquiry not found');

      if (selectedConversation.gmailMessageId) {
        await supabase.from('crm_email_inbox').upsert({
          message_id: selectedConversation.gmailMessageId,
          thread_id: selectedConversation.gmailThreadId || selectedConversation.gmailMessageId,
          from_email: selectedConversation.senderAddress,
          from_name: selectedConversation.senderName,
          to_email: selectedConversation.recipientAddress || '',
          subject: selectedConversation.subject,
          body: selectedConversation.snippet,
          received_date: selectedConversation.timestamp,
          is_processed: true,
          converted_to_inquiry: inq.id,
        }, { onConflict: 'message_id' });

        await supabase.from('crm_email_activities').insert({
          inquiry_id: inq.id,
          email_type: 'received',
          from_email: selectedConversation.senderAddress,
          to_email: selectedConversation.recipientAddress ? [selectedConversation.recipientAddress] : [],
          subject: selectedConversation.subject,
          body: selectedConversation.snippet,
          sent_date: selectedConversation.timestamp,
        });
      }

      // Update local state
      setConversations(prev =>
        prev.map(c =>
          c.id === selectedConversation.id
            ? { ...c, inquiryId: inq.id, inquiryNumber: inq.inquiry_number, customerName: inq.company_name, productName: inq.product_name }
            : c
        )
      );

      setShowLinkDialog(false);
      showToast({ type: 'success', title: 'Inquiry Linked', message: `Successfully linked to ${inq.inquiry_number}` });
    } catch (err: any) {
      showToast({ type: 'error', title: 'Link Failed', message: err.message || 'Could not link inquiry' });
    } finally {
      setIsLinking(false);
    }
  };

  // Handle open document
  const handleOpenDoc = async (storagePath?: string | null, filename?: string) => {
    if (!storagePath) {
      showToast({ type: 'warning', title: 'File Missing', message: 'Attachment file path not recorded in storage.' });
      return;
    }
    const url = await getSignedUrlCached('crm-documents', storagePath, 600);
    if (url) window.open(url, '_blank', 'noopener,noreferrer');
  };

  return (
    <div className="flex flex-col h-[calc(100vh-140px)] min-h-[640px] bg-white border border-gray-200 rounded-lg overflow-hidden shadow-xs">
      {/* Top Channel Filter Navigation */}
      <div className="border-b border-gray-200 bg-gray-50/80 px-4 py-2 flex items-center justify-between gap-3 flex-wrap">
        <div className="flex items-center gap-1.5">
          <span className="text-xs font-bold text-gray-800 uppercase tracking-wide mr-2 flex items-center gap-1">
            <Inbox className="w-3.5 h-3.5 text-blue-600" />
            Channel:
          </span>
          {(['all', 'email', 'whatsapp', 'unlinked'] as const).map(ch => {
            const isActive = channelFilter === ch;
            const count = conversations.filter(c => {
              if (ch === 'all') return true;
              if (ch === 'email') return c.channel === 'email';
              if (ch === 'whatsapp') return c.channel === 'whatsapp';
              if (ch === 'unlinked') return !c.inquiryId;
              return true;
            }).length;

            return (
              <button
                key={ch}
                onClick={() => setChannelFilter(ch)}
                className={`px-3 py-1 rounded text-xs font-semibold flex items-center gap-1.5 transition cursor-pointer ${
                  isActive
                    ? 'bg-blue-600 text-white shadow-2xs'
                    : 'bg-white border border-gray-300 text-gray-700 hover:bg-gray-100'
                }`}
              >
                {ch === 'email' && <Mail className="w-3 h-3" />}
                {ch === 'whatsapp' && <MessageSquare className="w-3 h-3 text-emerald-400" />}
                {ch === 'unlinked' && <AlertTriangle className="w-3 h-3 text-amber-300" />}
                <span className="capitalize">{ch}</span>
                <span className={`text-[10px] px-1 py-0.2 rounded-full ${isActive ? 'bg-blue-700 text-white' : 'bg-gray-100 text-gray-600'}`}>
                  {count}
                </span>
              </button>
            );
          })}
        </div>

        <button
          onClick={loadConversations}
          disabled={loadingList}
          className="text-xs text-gray-600 hover:text-gray-900 flex items-center gap-1 px-2.5 py-1 bg-white border border-gray-200 rounded cursor-pointer disabled:opacity-50"
          title="Refresh Inbox"
        >
          <RefreshCw className={`w-3 h-3 ${loadingList ? 'animate-spin' : ''}`} />
          <span>Sync</span>
        </button>
      </div>

      {/* Master-Detail Split Workspace */}
      <div className="flex-1 flex overflow-hidden">
        {/* LEFT COLUMN: Conversation List (~400px) */}
        <div className="w-full md:w-[420px] border-r border-gray-200 flex flex-col bg-white flex-shrink-0">
          {/* Search Bar */}
          <div className="p-2.5 border-b border-gray-200 bg-gray-50/50">
            <div className="relative">
              <Search className="w-3.5 h-3.5 text-gray-400 absolute left-2.5 top-2.5" />
              <input
                type="text"
                value={searchQuery}
                onChange={e => setSearchQuery(e.target.value)}
                placeholder="Search sender, subject, product, inquiry..."
                className="w-full pl-8 pr-3 py-1.5 text-xs bg-white border border-gray-200 rounded-md focus:outline-blue-500"
              />
            </div>
          </div>

          {/* List items */}
          <div className="flex-1 overflow-y-auto divide-y divide-gray-100">
            {loadingList && conversations.length === 0 && (
              <div className="p-8 text-center text-xs text-gray-500">
                <RefreshCw className="w-4 h-4 animate-spin mx-auto mb-2 text-blue-600" />
                Loading communications...
              </div>
            )}

            {!loadingList && filteredConversations.length === 0 && (
              <div className="p-8 text-center text-xs text-gray-500">
                No conversations found in this filter.
              </div>
            )}

            {filteredConversations.map(conv => {
              const isSelected = conv.id === selectedId;
              const isEmail = conv.channel === 'email';

              return (
                <div
                  key={conv.id}
                  onClick={() => setSelectedId(conv.id)}
                  className={`p-3 text-xs cursor-pointer transition select-none flex flex-col gap-1.5 ${
                    isSelected
                      ? 'bg-blue-50/80 border-l-3 border-blue-600'
                      : 'hover:bg-gray-50 border-l-3 border-transparent'
                  }`}
                >
                  <div className="flex items-center justify-between gap-2">
                    <div className="flex items-center gap-1.5 min-w-0">
                      <span
                        className={`p-1 rounded flex-shrink-0 ${
                          isEmail ? 'bg-blue-100 text-blue-700' : 'bg-emerald-100 text-emerald-700'
                        }`}
                        title={isEmail ? 'Gmail' : 'WhatsApp'}
                      >
                        {isEmail ? <Mail className="w-3 h-3" /> : <MessageSquare className="w-3 h-3" />}
                      </span>
                      <span className={`font-semibold truncate ${isSelected ? 'text-blue-950 font-bold' : 'text-gray-900'}`}>
                        {conv.senderName}
                      </span>
                      {conv.unread && (
                        <span className="w-2 h-2 rounded-full bg-blue-600 flex-shrink-0" title="Unread" />
                      )}
                    </div>
                    <span className="text-[10px] text-gray-400 whitespace-nowrap">
                      {new Date(conv.timestamp).toLocaleDateString([], { month: 'short', day: 'numeric' })}
                    </span>
                  </div>

                  <div className={`truncate text-[11px] ${isSelected ? 'text-gray-900 font-medium' : 'text-gray-700'}`}>
                    {conv.subject}
                  </div>

                  <div className="text-[10.5px] text-gray-500 truncate font-sans">
                    {conv.snippet}
                  </div>

                  {/* Association badges */}
                  <div className="flex items-center gap-1.5 flex-wrap pt-0.5">
                    {conv.inquiryNumber ? (
                      <span
                        onClick={e => {
                          e.stopPropagation();
                          if (conv.inquiryId && onOpenInquiry) onOpenInquiry(conv.inquiryId);
                        }}
                        className="text-[9px] font-bold bg-blue-100 text-blue-800 border border-blue-200 px-1.5 py-0.2 rounded hover:underline cursor-pointer flex items-center gap-0.5"
                      >
                        <Tag className="w-2.5 h-2.5" />
                        {conv.inquiryNumber}
                      </span>
                    ) : (
                      <span className="text-[9px] font-semibold bg-amber-100 text-amber-800 border border-amber-200 px-1 py-0.2 rounded">
                        UNLINKED
                      </span>
                    )}

                    {conv.productName && (
                      <span className="text-[9px] text-gray-600 bg-gray-100 px-1 rounded truncate max-w-[120px]">
                        {conv.productName}
                      </span>
                    )}

                    {conv.needsAction && (
                      <span className="text-[9px] font-bold bg-purple-100 text-purple-800 px-1 rounded">
                        Action Required
                      </span>
                    )}
                  </div>
                </div>
              );
            })}
          </div>
        </div>

        {/* RIGHT COLUMN: Conversation Detail & Chronological Thread */}
        <div className="flex-1 flex flex-col bg-white overflow-hidden">
          {!selectedConversation ? (
            <div className="flex-1 flex flex-col items-center justify-center text-gray-400 p-8 text-center">
              <Inbox className="w-12 h-12 text-gray-200 mb-3" />
              <div className="font-semibold text-gray-600 text-sm">Select a Conversation</div>
              <p className="text-xs max-w-sm mt-1">Choose an email or WhatsApp thread from the left panel to review message history, attachments, and reply.</p>
            </div>
          ) : (
            <div className="flex-1 flex flex-col overflow-hidden">
              {/* Conversation Top Action Bar */}
              <div className="p-3 border-b border-gray-200 bg-gray-50 flex items-center justify-between gap-3 flex-wrap">
                <div className="min-w-0">
                  <div className="flex items-center gap-2">
                    <span className="text-sm font-bold text-gray-900 truncate">
                      {selectedConversation.subject}
                    </span>
                    <span
                      className={`text-[9px] font-bold px-1.5 py-0.5 rounded border uppercase ${
                        selectedConversation.channel === 'email'
                          ? 'bg-blue-50 text-blue-700 border-blue-200'
                          : 'bg-emerald-50 text-emerald-700 border-emerald-200'
                      }`}
                    >
                      {selectedConversation.channel}
                    </span>
                  </div>
                  <div className="text-[11px] text-gray-600 flex items-center gap-2 mt-0.5">
                    <span>From: <strong className="text-gray-900">{selectedConversation.senderName}</strong> ({selectedConversation.senderAddress})</span>
                    {selectedConversation.customerName && <span>• Customer: <strong className="text-gray-900">{selectedConversation.customerName}</strong></span>}
                  </div>
                </div>

                <div className="flex items-center gap-2">
                  {selectedConversation.inquiryId ? (
                    <button
                      onClick={() => onOpenInquiry && onOpenInquiry(selectedConversation.inquiryId!)}
                      className="px-2.5 py-1 bg-blue-600 hover:bg-blue-700 text-white text-xs font-semibold rounded shadow-2xs flex items-center gap-1 cursor-pointer"
                    >
                      <ExternalLink className="w-3 h-3" />
                      <span>Open Inquiry ({selectedConversation.inquiryNumber})</span>
                    </button>
                  ) : (
                    <div className="flex items-center gap-1.5">
                      <button
                        onClick={() => setShowLinkDialog(true)}
                        className="px-2.5 py-1 bg-amber-600 hover:bg-amber-700 text-white text-xs font-semibold rounded shadow-2xs flex items-center gap-1 cursor-pointer"
                      >
                        <LinkIcon className="w-3 h-3" />
                        <span>Link to Inquiry</span>
                      </button>
                      <button
                        onClick={() =>
                          onCreateInquiryFromMessage &&
                          onCreateInquiryFromMessage({
                            subject: selectedConversation.subject,
                            body: selectedConversation.snippet,
                            fromEmail: selectedConversation.senderAddress,
                            fromName: selectedConversation.senderName,
                          })
                        }
                        className="px-2.5 py-1 bg-white border border-gray-300 text-gray-700 hover:bg-gray-100 text-xs font-semibold rounded cursor-pointer"
                      >
                        Create Inquiry
                      </button>
                    </div>
                  )}
                </div>
              </div>

              {/* Unlinked Alert Notice */}
              {!selectedConversation.inquiryId && (
                <div className="bg-amber-50 border-b border-amber-200 p-2.5 px-4 flex items-center justify-between text-xs text-amber-900">
                  <div className="flex items-center gap-2">
                    <AlertTriangle className="w-4 h-4 text-amber-600 flex-shrink-0" />
                    <span>This communication is not yet linked to an inquiry or customer.</span>
                  </div>
                  <button
                    onClick={() => setShowLinkDialog(true)}
                    className="text-xs font-bold text-amber-800 hover:underline cursor-pointer"
                  >
                    Link Now →
                  </button>
                </div>
              )}

              {/* Scrollable Message Thread */}
              <div className="flex-1 overflow-y-auto p-4 space-y-3 bg-gray-50/40">
                {loadingDetail && (
                  <div className="p-12 text-center text-xs text-gray-500">
                    <RefreshCw className="w-5 h-5 animate-spin mx-auto mb-2 text-blue-600" />
                    Loading complete thread...
                  </div>
                )}

                {detailError && (
                  <div className="p-4 bg-red-50 border border-red-200 rounded-lg text-xs text-red-700">
                    <div className="font-bold mb-1">Thread Retrieval Notice</div>
                    <div>{detailError}</div>
                  </div>
                )}

                {!loadingDetail && threadMessages.length === 0 && !detailError && (
                  <div className="p-8 text-center text-xs text-gray-500 bg-white border border-gray-200 rounded">
                    No messages recorded in this conversation.
                  </div>
                )}

                {threadMessages.map((msg, idx) => {
                  const isExpanded = Boolean(expandedMsgIds[msg.id]);
                  const isLast = idx === threadMessages.length - 1;

                  return (
                    <div
                      key={msg.id || idx}
                      className="border border-gray-200 rounded-lg bg-white shadow-2xs overflow-hidden"
                    >
                      {/* Message Accordion Header */}
                      <div
                        onClick={() => setExpandedMsgIds(prev => ({ ...prev, [msg.id]: !prev[msg.id] }))}
                        className="p-3 bg-gray-50/60 hover:bg-gray-50 flex items-center justify-between gap-3 cursor-pointer select-none"
                      >
                        <div className="flex items-center gap-2 min-w-0">
                          <div className="w-6 h-6 rounded-full bg-blue-100 text-blue-800 font-bold text-[10px] flex items-center justify-center flex-shrink-0">
                            {msg.from.slice(0, 1).toUpperCase()}
                          </div>
                          <div className="min-w-0">
                            <span className="font-semibold text-xs text-gray-900 truncate block">
                              {msg.from}
                            </span>
                            {!isExpanded && (
                              <span className="text-[11px] text-gray-500 truncate block font-sans">
                                {msg.snippet || msg.body?.slice(0, 80)}
                              </span>
                            )}
                          </div>
                        </div>

                        <div className="flex items-center gap-2 flex-shrink-0">
                          <span className="text-[10px] text-gray-400">
                            {msg.date ? new Date(msg.date).toLocaleString([], { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' }) : 'N/A'}
                          </span>
                          {isExpanded ? <ChevronUp className="w-3.5 h-3.5 text-gray-400" /> : <ChevronDown className="w-3.5 h-3.5 text-gray-400" />}
                        </div>
                      </div>

                      {/* Expanded Message Body */}
                      {isExpanded && (
                        <div className="p-3.5 border-t border-gray-100 space-y-3">
                          {msg.subject && (
                            <div className="text-xs font-bold text-gray-900">
                              Subject: {msg.subject}
                            </div>
                          )}

                          <div className="text-xs leading-relaxed text-gray-800 whitespace-pre-wrap font-sans selection:bg-blue-100">
                            {msg.body}
                          </div>

                          {/* Attachments */}
                          {msg.attachments && msg.attachments.length > 0 && (
                            <div className="pt-2 border-t border-gray-100 space-y-1.5">
                              <div className="text-[10px] font-bold text-gray-600 uppercase flex items-center gap-1">
                                <Paperclip className="w-3 h-3" />
                                <span>Attachments ({msg.attachments.length}):</span>
                              </div>
                              <div className="space-y-1">
                                {msg.attachments.map((att, aIdx) => (
                                  <div
                                    key={att.attachmentId || aIdx}
                                    className="bg-gray-50 border border-gray-200 rounded p-1.5 px-2 flex items-center justify-between gap-2"
                                  >
                                    <div className="flex items-center gap-1.5 min-w-0">
                                      <FileText className="w-3.5 h-3.5 text-blue-600 flex-shrink-0" />
                                      <span className="text-xs font-medium text-gray-800 truncate" title={att.filename}>
                                        {att.filename}
                                      </span>
                                    </div>
                                    <button
                                      type="button"
                                      onClick={() => handleOpenDoc(att.storagePath, att.filename)}
                                      className="px-2 py-0.5 bg-white border border-gray-200 hover:bg-gray-100 text-gray-700 rounded text-[10px] flex items-center gap-1 cursor-pointer"
                                    >
                                      <Eye className="w-3 h-3" />
                                      <span>View</span>
                                    </button>
                                  </div>
                                ))}
                              </div>
                            </div>
                          )}
                        </div>
                      )}
                    </div>
                  );
                })}
              </div>

              {/* Bottom Quick Reply Composer */}
              <div className="p-3 border-t border-gray-200 bg-white space-y-2">
                <div className="flex items-center justify-between text-xs text-gray-600">
                  <span className="font-semibold flex items-center gap-1">
                    {selectedConversation.channel === 'whatsapp' ? (
                      <>
                        <MessageSquare className="w-3.5 h-3.5 text-emerald-600" />
                        Reply via WhatsApp to {selectedConversation.senderAddress}
                      </>
                    ) : (
                      <>
                        <Mail className="w-3.5 h-3.5 text-blue-600" />
                        Reply via Email to {selectedConversation.senderAddress}
                      </>
                    )}
                  </span>
                </div>

                <textarea
                  rows={2}
                  value={replyText}
                  onChange={e => setReplyText(e.target.value)}
                  placeholder={`Type your reply to ${selectedConversation.senderName}...`}
                  className="w-full text-xs p-2.5 border border-gray-300 rounded-md focus:outline-blue-500 font-sans"
                />

                <div className="flex items-center justify-end gap-2">
                  <button
                    onClick={handleSendReply}
                    disabled={sendingReply || !replyText.trim()}
                    className={`px-3.5 py-1.5 text-white text-xs font-bold rounded shadow-2xs flex items-center gap-1.5 cursor-pointer disabled:opacity-50 ${
                      selectedConversation.channel === 'whatsapp'
                        ? 'bg-emerald-600 hover:bg-emerald-700'
                        : 'bg-blue-600 hover:bg-blue-700'
                    }`}
                  >
                    <Send className="w-3 h-3" />
                    <span>{sendingReply ? 'Sending...' : 'Send Reply'}</span>
                  </button>
                </div>
              </div>
            </div>
          )}
        </div>
      </div>

      {/* Link to Inquiry Dialog */}
      {showLinkDialog && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4">
          <div className="bg-white rounded-lg shadow-xl w-full max-w-md p-4 space-y-3">
            <div className="flex items-center justify-between border-b pb-2">
              <h3 className="text-sm font-bold text-gray-900">Link Communication to Inquiry</h3>
              <button onClick={() => setShowLinkDialog(false)} className="text-gray-400 hover:text-gray-600">
                <X className="w-4 h-4" />
              </button>
            </div>

            <p className="text-xs text-gray-600">
              Select an existing inquiry to link this message from <strong>{selectedConversation?.senderName}</strong>:
            </p>

            <select
              value={selectedInquiryToLink}
              onChange={e => setSelectedInquiryToLink(e.target.value)}
              className="w-full text-xs border border-gray-300 rounded p-2 bg-white"
            >
              <option value="">Select an Inquiry ▼</option>
              {allInquiries.map(i => (
                <option key={i.id} value={i.id}>
                  {i.inquiry_number} — {i.company_name} ({i.product_name})
                </option>
              ))}
            </select>

            <div className="pt-2 flex justify-end gap-2 border-t">
              <button
                onClick={() => setShowLinkDialog(false)}
                className="px-3 py-1.5 border rounded text-xs text-gray-600 hover:bg-gray-100"
              >
                Cancel
              </button>
              <button
                onClick={handleConfirmLink}
                disabled={!selectedInquiryToLink || isLinking}
                className="px-3 py-1.5 bg-blue-600 hover:bg-blue-700 text-white rounded text-xs font-semibold disabled:opacity-50"
              >
                {isLinking ? 'Linking...' : 'Confirm Link'}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

export default CrmOmnichannelInbox;
