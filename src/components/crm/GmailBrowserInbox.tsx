import { useEffect, useMemo, useState } from 'react';
import { supabase } from '../../lib/supabase';
import { useNavigation } from '../../contexts/NavigationContext';
import { showToast } from '../ToastNotification';
import {
  AlertCircle,
  CheckCircle,
  Inbox,
  Link as LinkIcon,
  Loader,
  Mail,
  Paperclip,
  RefreshCw,
  Search,
  Sparkles,
  X,
} from 'lucide-react';

interface InboxMessage {
  messageId: string;
  threadId: string;
  from: string;
  to: string;
  subject: string;
  date: string | null;
  snippet: string;
  body?: string;
  hasAttachments: boolean;
  attachments?: Array<{ filename: string; mimeType: string; size: number; attachmentId: string }>;
  labels: string[];
  matchedInquiryId: string | null;
}

function parseEmailAddress(value: string) {
  const match = value.match(/^(.*?)\s*<(.+?)>$/);
  if (!match) return { name: '', email: value.trim() };
  return { name: match[1].replace(/^"|"$/g, '').trim(), email: match[2].trim() };
}

function formatDate(value: string | null) {
  if (!value) return '-';
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value;
  return date.toLocaleString('en-GB', { day: '2-digit', month: 'short', hour: '2-digit', minute: '2-digit' });
}

export function GmailBrowserInbox() {
  const { setCurrentPage } = useNavigation();
  const [emailAddress, setEmailAddress] = useState<string | null>(null);
  const [messages, setMessages] = useState<InboxMessage[]>([]);
  const [selected, setSelected] = useState<InboxMessage | null>(null);
  const [loading, setLoading] = useState(true);
  const [loadingMessage, setLoadingMessage] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [query, setQuery] = useState('in:inbox');
  const [nextPageToken, setNextPageToken] = useState<string | null>(null);
  const [linking, setLinking] = useState(false);

  const connected = useMemo(() => !!emailAddress && !error, [emailAddress, error]);

  const loadMessages = async (pageToken?: string) => {
    setLoading(true);
    setError(null);
    const { data, error: fnError } = await supabase.functions.invoke('gmail-inbox-list', {
      body: { query: query || 'in:inbox', maxResults: 25, pageToken },
    });

    if (fnError) {
      setError(fnError.message || 'Failed to load Gmail inbox');
      setLoading(false);
      return;
    }
    if (data?.code === 'NO_GMAIL_CONNECTED') {
      setEmailAddress(null);
      setMessages([]);
      setError('NO_GMAIL_CONNECTED');
      setLoading(false);
      return;
    }
    if (!data?.success) {
      setError(data?.code || 'Failed to load Gmail inbox');
      setLoading(false);
      return;
    }

    setEmailAddress(data.emailAddress || null);
    setNextPageToken(data.nextPageToken || null);
    setMessages(current => pageToken ? [...current, ...(data.messages || [])] : (data.messages || []));
    setLoading(false);
  };

  useEffect(() => {
    loadMessages();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const openMessage = async (message: InboxMessage) => {
    setSelected(message);
    setLoadingMessage(true);
    const { data, error: fnError } = await supabase.functions.invoke('gmail-inbox-message', {
      body: { messageId: message.messageId },
    });
    setLoadingMessage(false);

    if (fnError || !data?.success) {
      showToast({ type: 'error', title: 'Could not open email', message: fnError?.message || data?.code || 'Unknown error' });
      return;
    }
    setSelected(data.message);
    setMessages(current => current.map(item => item.messageId === message.messageId ? data.message : item));
  };

  const createInquiry = (message: InboxMessage) => {
    const from = parseEmailAddress(message.from);
    sessionStorage.setItem('pendingEmailForInquiry', JSON.stringify({
      subject: message.subject || 'No Subject',
      body: message.body || message.snippet || '',
      fromEmail: from.email,
      fromName: from.name,
      date: message.date || new Date().toISOString(),
    }));
    setCurrentPage('command-center');
  };

  const linkToInquiry = async (message: InboxMessage) => {
    const inquiryNo = window.prompt('Enter Inquiry No to link this email');
    if (!inquiryNo?.trim()) return;
    setLinking(true);
    try {
      const { data: inquiry, error: inquiryError } = await supabase
        .from('crm_inquiries')
        .select('id,inquiry_number')
        .eq('inquiry_number', inquiryNo.trim())
        .maybeSingle();
      if (inquiryError) throw inquiryError;
      if (!inquiry) throw new Error('Inquiry not found');

      const from = parseEmailAddress(message.from);
      await supabase.from('crm_email_inbox').upsert({
        message_id: message.messageId,
        thread_id: message.threadId,
        from_email: from.email || message.from,
        from_name: from.name || null,
        to_email: message.to || '',
        subject: message.subject || '(No Subject)',
        body: message.body || message.snippet || '',
        received_date: message.date || new Date().toISOString(),
        has_attachments: message.hasAttachments,
        labels: message.labels || [],
        is_processed: true,
        converted_to_inquiry: inquiry.id,
      }, { onConflict: 'message_id' });

      const { data: userData } = await supabase.auth.getUser();
      await supabase.from('crm_email_activities').insert({
        inquiry_id: inquiry.id,
        email_type: 'received',
        from_email: from.email || message.from,
        to_email: message.to ? [message.to] : [],
        subject: message.subject || '(No Subject)',
        body: message.body || message.snippet || '',
        sent_date: message.date || new Date().toISOString(),
        created_by: userData.user?.id || null,
      });

      const updated = { ...message, matchedInquiryId: inquiry.id };
      setSelected(updated);
      setMessages(current => current.map(item => item.messageId === message.messageId ? updated : item));
      showToast({ type: 'success', title: 'Email linked', message: `Linked to ${inquiry.inquiry_number}` });
    } catch (err) {
      showToast({ type: 'error', title: 'Could not link email', message: err instanceof Error ? err.message : 'Unknown error' });
    } finally {
      setLinking(false);
    }
  };

  if (loading && messages.length === 0) {
    return (
      <div className="p-8 flex items-center justify-center text-sm text-gray-500">
        <Loader className="w-4 h-4 animate-spin mr-2" /> Loading Gmail inbox...
      </div>
    );
  }

  if (error === 'NO_GMAIL_CONNECTED') {
    return (
      <div className="p-6 max-w-2xl mx-auto">
        <div className="bg-amber-50 border border-amber-200 rounded-md px-4 py-3 text-sm text-amber-900">
          <p className="font-medium mb-1">No Gmail connected</p>
          <p className="text-xs text-amber-800">Connect your Gmail in Settings to view your CRM inbox. Gmail tokens stay server-side.</p>
        </div>
      </div>
    );
  }

  return (
    <div className="h-[calc(100vh-220px)] min-h-[560px] bg-white border border-gray-200 rounded-lg overflow-hidden flex">
      <div className="w-full md:w-[430px] border-r border-gray-200 flex flex-col">
        <div className="px-3 py-2 border-b border-gray-200 bg-gray-50 space-y-2">
          <div className="flex items-center justify-between gap-2">
            <div className="flex items-center gap-2 min-w-0">
              <Inbox className="w-4 h-4 text-blue-600" />
              <div className="min-w-0">
                <p className="text-sm font-semibold text-gray-900">Gmail Inbox</p>
                <p className="text-[11px] text-gray-500 truncate">{connected ? emailAddress : 'Server-side Gmail access'}</p>
              </div>
            </div>
            <div className="flex items-center gap-1">
              {connected && (
                <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded bg-green-50 text-green-700 text-[11px] border border-green-200">
                  <CheckCircle className="w-3 h-3" /> Connected
                </span>
              )}
              <button onClick={() => loadMessages()} disabled={loading} className="p-1.5 rounded hover:bg-gray-100 text-gray-500">
                <RefreshCw className={`w-4 h-4 ${loading ? 'animate-spin' : ''}`} />
              </button>
            </div>
          </div>
          <div className="flex gap-2">
            <div className="relative flex-1">
              <Search className="absolute left-2 top-1.5 w-3.5 h-3.5 text-gray-400" />
              <input
                value={query}
                onChange={event => setQuery(event.target.value)}
                onKeyDown={event => { if (event.key === 'Enter') loadMessages(); }}
                placeholder="Gmail search, e.g. in:inbox quotation"
                className="w-full pl-7 pr-2 py-1 text-xs border border-gray-300 rounded focus:outline-none focus:ring-1 focus:ring-blue-500"
              />
            </div>
            <button onClick={() => loadMessages()} className="px-3 py-1 text-xs bg-blue-600 text-white rounded hover:bg-blue-700">Search</button>
          </div>
        </div>

        {error && error !== 'NO_GMAIL_CONNECTED' && (
          <div className="m-3 px-3 py-2 bg-red-50 border border-red-200 rounded text-xs text-red-700 flex items-center gap-2">
            <AlertCircle className="w-4 h-4" /> {error}
          </div>
        )}

        <div className="flex-1 overflow-y-auto divide-y divide-gray-100">
          {messages.map(message => {
            const from = parseEmailAddress(message.from);
            return (
              <button
                key={message.messageId}
                onClick={() => openMessage(message)}
                className={`w-full text-left px-3 py-2 hover:bg-blue-50 ${selected?.messageId === message.messageId ? 'bg-blue-50' : ''}`}
              >
                <div className="flex items-center justify-between gap-2">
                  <p className="text-xs font-semibold text-gray-900 truncate">{from.name || from.email || message.from}</p>
                  <span className="text-[10px] text-gray-400 whitespace-nowrap">{formatDate(message.date)}</span>
                </div>
                <div className="flex items-center gap-1 mt-0.5">
                  <p className="text-xs font-medium text-gray-700 truncate flex-1">{message.subject || '(No Subject)'}</p>
                  {message.hasAttachments && <Paperclip className="w-3 h-3 text-gray-400" />}
                  {message.matchedInquiryId && <LinkIcon className="w-3 h-3 text-green-600" />}
                </div>
                <p className="text-[11px] text-gray-500 line-clamp-2 mt-0.5">{message.snippet}</p>
              </button>
            );
          })}
          {messages.length === 0 && !loading && (
            <div className="p-8 text-center text-sm text-gray-400">No emails found.</div>
          )}
        </div>

        {nextPageToken && (
          <div className="p-2 border-t border-gray-200 bg-gray-50">
            <button onClick={() => loadMessages(nextPageToken)} disabled={loading}
              className="w-full px-3 py-1.5 text-xs border border-gray-200 rounded hover:bg-white disabled:opacity-50">
              Load more
            </button>
          </div>
        )}
      </div>

      <div className="hidden md:flex flex-1 flex-col">
        {!selected ? (
          <div className="flex-1 flex items-center justify-center text-sm text-gray-400">
            <Mail className="w-5 h-5 mr-2" /> Select an email to preview
          </div>
        ) : (
          <>
            <div className="px-4 py-3 border-b border-gray-200 bg-gray-50">
              <div className="flex items-start justify-between gap-3">
                <div className="min-w-0">
                  <h3 className="text-sm font-semibold text-gray-900 truncate">{selected.subject || '(No Subject)'}</h3>
                  <p className="text-xs text-gray-500 mt-1">From: {selected.from}</p>
                  <p className="text-xs text-gray-500">To: {selected.to || '-'}</p>
                </div>
                <button onClick={() => setSelected(null)} className="p-1 rounded hover:bg-gray-100"><X className="w-4 h-4" /></button>
              </div>
              <div className="flex flex-wrap gap-2 mt-3">
                <button onClick={() => createInquiry(selected)} className="px-3 py-1.5 text-xs bg-blue-600 text-white rounded hover:bg-blue-700">
                  Create Inquiry
                </button>
                <button onClick={() => linkToInquiry(selected)} disabled={linking}
                  className="px-3 py-1.5 text-xs border border-gray-200 rounded hover:bg-white disabled:opacity-50">
                  Link to Inquiry
                </button>
                <button disabled className="inline-flex items-center gap-1 px-3 py-1.5 text-xs border border-gray-200 rounded text-gray-400 cursor-not-allowed">
                  <Sparkles className="w-3 h-3" /> Extract Inquiry disabled - AI parser coming next
                </button>
              </div>
            </div>

            <div className="flex-1 overflow-y-auto p-4">
              {loadingMessage ? (
                <div className="py-10 text-center text-sm text-gray-400">
                  <Loader className="w-4 h-4 animate-spin inline mr-2" /> Loading message...
                </div>
              ) : (
                <>
                  <pre className="whitespace-pre-wrap font-sans text-sm text-gray-800 leading-relaxed">
                    {selected.body || selected.snippet || 'No preview available.'}
                  </pre>
                  {selected.attachments && selected.attachments.length > 0 && (
                    <div className="mt-4 border-t border-gray-200 pt-3">
                      <p className="text-xs font-semibold text-gray-700 mb-2">Attachments</p>
                      <div className="space-y-1">
                        {selected.attachments.map(att => (
                          <div key={att.attachmentId} className="flex items-center gap-2 text-xs text-gray-600">
                            <Paperclip className="w-3 h-3" /> {att.filename} <span className="text-gray-400">({att.mimeType})</span>
                          </div>
                        ))}
                      </div>
                    </div>
                  )}
                </>
              )}
            </div>
          </>
        )}
      </div>
    </div>
  );
}
