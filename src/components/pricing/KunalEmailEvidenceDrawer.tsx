import { useEffect, useState } from 'react';
import DOMPurify from 'dompurify';
import { supabase } from '../../lib/supabase';
import { showToast } from '../ToastNotification';
import type { UnifiedPricingRow } from '../../pages/PricingWorksheet';
import { getSignedUrlCached } from '../../utils/signedUrlCache';
import {
  X,
  Mail,
  FileText,
  Download,
  Eye,
  CheckCircle2,
  Edit3,
  Save,
  AlertTriangle,
  ChevronDown,
  ChevronUp,
  Sparkles,
  Paperclip,
  Check,
  Database,
  RefreshCw,
} from 'lucide-react';

interface Props {
  isOpen: boolean;
  onClose: () => void;
  row: UnifiedPricingRow | null;
  allInquiries: Array<{
    id: string;
    inquiry_number: string;
    aceerp_no: string | null;
    company_name: string;
    product_name: string;
  }>;
  makeOptions: string[];
  onAccept: (rowId: string) => void;
  onSaveCorrection: (rowId: string, correction: {
    inquiryId?: string;
    productName?: string;
    offeredMake?: string;
    supplierName?: string;
    sourcePrice?: number | null;
    sourceCurrency?: 'INR' | 'USD';
    unit?: string;
    quotePrice?: number | null;
  }) => Promise<void>;
}

export interface GmailAttachment {
  filename: string;
  mimeType: string;
  size: number;
  attachmentId?: string;
  storagePath?: string | null;
  storageBucket?: string;
  documentType?: string;
  matchStatus?: string;
}

export interface GmailThreadMessage {
  messageId: string;
  threadId: string;
  from: string;
  to: string;
  cc?: string;
  subject: string;
  date: string | null;
  snippet: string;
  body: string;
  bodyHtml?: string;
  bodyText?: string;
  attachments: GmailAttachment[];
  hasAttachments: boolean;
  labels?: string[];
}

function formatBytes(bytes: number, decimals = 1): string {
  if (!bytes || bytes === 0) return '0 B';
  const k = 1024;
  const dm = decimals < 0 ? 0 : decimals;
  const sizes = ['B', 'KB', 'MB', 'GB'];
  const i = Math.floor(Math.log(bytes) / Math.log(k));
  return `${parseFloat((bytes / Math.pow(k, i)).toFixed(dm))} ${sizes[i]}`;
}

function getInitials(fromStr = ''): string {
  const clean = fromStr.replace(/<.*>/, '').trim();
  if (!clean) return 'G';
  const parts = clean.split(/\s+/).filter(Boolean);
  if (parts.length >= 2) {
    return (parts[0][0] + parts[1][0]).toUpperCase();
  }
  return clean.slice(0, 2).toUpperCase();
}

/**
 * Safely renders email body text or HTML using DOMPurify with standard email typography and table styling.
 * Prevents raw <table><tr><td><style> HTML from displaying as literal text.
 */
function renderSafeEmailContent(bodyText?: string | null, bodyHtml?: string | null) {
  const rawHtml = bodyHtml || '';
  const rawText = bodyText || '';
  const hasHtml = Boolean(rawHtml && /<[a-z][\s\S]*>/i.test(rawHtml)) || /<[a-z][\s\S]*>/i.test(rawText);
  const contentToRender = rawHtml || (hasHtml ? rawText : '');

  if (hasHtml && contentToRender) {
    const sanitized = DOMPurify.sanitize(contentToRender, {
      ADD_TAGS: [
        'style', 'table', 'thead', 'tbody', 'tr', 'th', 'td',
        'div', 'span', 'p', 'b', 'strong', 'i', 'em', 'u',
        'br', 'hr', 'a', 'ul', 'ol', 'li', 'h1', 'h2', 'h3',
        'h4', 'h5', 'h6', 'font', 'blockquote', 'pre', 'code'
      ],
      ADD_ATTR: [
        'target', 'style', 'class', 'href', 'cellpadding', 'cellspacing',
        'border', 'align', 'valign', 'width', 'color', 'colspan', 'rowspan'
      ],
    });
    return (
      <div
        className="email-rendered-html text-xs text-gray-800 leading-relaxed font-sans max-h-[420px] overflow-y-auto overflow-x-auto p-3 bg-white rounded border border-gray-200 shadow-2xs select-text [&_table]:border-collapse [&_table]:w-auto [&_table]:max-w-full [&_table]:my-2 [&_table]:text-[11px] [&_th]:border [&_th]:border-gray-300 [&_th]:p-1.5 [&_th]:bg-gray-50 [&_th]:font-semibold [&_td]:border [&_td]:border-gray-300 [&_td]:p-1.5"
        dangerouslySetInnerHTML={{ __html: sanitized }}
      />
    );
  }

  return (
    <div className="text-xs text-gray-800 leading-relaxed whitespace-pre-wrap font-sans select-text p-3 bg-white rounded border border-gray-200 max-h-[420px] overflow-y-auto">
      {rawText || rawHtml || 'No text content available in this message.'}
    </div>
  );
}

export function KunalEmailEvidenceDrawer({
  isOpen,
  onClose,
  row,
  allInquiries,
  makeOptions,
  onAccept,
  onSaveCorrection,
}: Props) {
  const [activeTab, setActiveTab] = useState<'both' | 'source' | 'ai'>('both');
  const [isEditing, setIsEditing] = useState(false);
  const [isSaving, setIsSaving] = useState(false);

  // Live Gmail thread state
  const [threadMessages, setThreadMessages] = useState<GmailThreadMessage[]>([]);
  const [loadingThread, setLoadingThread] = useState(false);
  const [threadError, setThreadError] = useState<string | null>(null);
  const [connectedEmail, setConnectedEmail] = useState<string | null>(null);
  const [expandedMsgIds, setExpandedMsgIds] = useState<Record<string, boolean>>({});
  const [streamingAttachmentId, setStreamingAttachmentId] = useState<string | null>(null);

  // Edit fields
  const [editInquiryId, setEditInquiryId] = useState('');
  const [editProductName, setEditProductName] = useState('');
  const [editOfferedMake, setEditOfferedMake] = useState('');
  const [editSupplierName, setEditSupplierName] = useState('');
  const [editPrice, setEditPrice] = useState('');
  const [editCurrency, setEditCurrency] = useState<'INR' | 'USD'>('INR');
  const [editUnit, setEditUnit] = useState('KG');
  const [editQuotePrice, setEditQuotePrice] = useState('');

  // Sync edit form with current row
  useEffect(() => {
    if (row) {
      setEditInquiryId(row.inquiryId || '');
      setEditProductName(row.productName || '');
      setEditOfferedMake(row.offeredMake || '');
      setEditSupplierName(row.supplierName || '');
      setEditPrice(row.sourcePrice != null ? String(row.sourcePrice) : '');
      setEditCurrency(row.sourceCurrency || 'INR');
      setEditUnit(row.unit || 'KG');
      setEditQuotePrice(row.quotePrice != null ? String(row.quotePrice) : '');
      setIsEditing(false);
    }
  }, [row]);

  // Fetch full Gmail thread from edge function
  const fetchThread = async (tId?: string | null, mId?: string | null) => {
    if (!tId && !mId) return;
    setLoadingThread(true);
    setThreadError(null);
    try {
      const { data, error } = await supabase.functions.invoke('gmail-inbox-message', {
        body: {
          threadId: tId || undefined,
          messageId: mId || undefined,
          includeThread: true,
        },
      });

      if (error) {
        throw new Error(error.message || 'Failed to fetch thread from Gmail connection');
      }

      if (!data?.success) {
        throw new Error(data?.error || data?.code || 'Thread could not be retrieved from connected Gmail accounts');
      }

      const msgs = (data.thread_messages || []) as GmailThreadMessage[];
      setThreadMessages(msgs);
      setConnectedEmail(data.emailAddress || null);

      // Expand target message and latest message by default
      const initialExpanded: Record<string, boolean> = {};
      const targetMsgId = mId || (msgs.length > 0 ? msgs[msgs.length - 1].messageId : null);

      msgs.forEach((m, idx) => {
        if (m.messageId === targetMsgId || idx === msgs.length - 1 || msgs.length <= 2) {
          initialExpanded[m.messageId] = true;
        }
      });
      setExpandedMsgIds(initialExpanded);
    } catch (err: any) {
      console.error('[KunalEmailEvidenceDrawer] Error loading thread:', err);
      setThreadError(err.message || 'Failed to retrieve complete Gmail thread from connected account.');
    } finally {
      setLoadingThread(false);
    }
  };

  // Load Gmail thread messages when drawer opens
  useEffect(() => {
    if (isOpen && row?.evidence?.hasRealGmail) {
      const tId = row.evidence.threadId;
      const mId = row.evidence.messageId;
      if (tId || mId) {
        fetchThread(tId, mId);
      } else {
        setThreadMessages([]);
        setThreadError('No Gmail thread or message ID associated with this review.');
      }
    } else {
      setThreadMessages([]);
      setThreadError(null);
      setConnectedEmail(null);
      setExpandedMsgIds({});
    }
  }, [isOpen, row?.id, row?.evidence?.hasRealGmail, row?.evidence?.threadId, row?.evidence?.messageId]);

  const toggleMessage = (msgId: string) => {
    setExpandedMsgIds(prev => ({
      ...prev,
      [msgId]: !prev[msgId],
    }));
  };

  const handleExpandAll = () => {
    const allExp: Record<string, boolean> = {};
    threadMessages.forEach(m => {
      allExp[m.messageId] = true;
    });
    setExpandedMsgIds(allExp);
  };

  const handleCollapseAll = () => {
    const targetMsgId = row?.evidence?.messageId;
    const collapsed: Record<string, boolean> = {};
    if (targetMsgId) collapsed[targetMsgId] = true;
    setExpandedMsgIds(collapsed);
  };

  // Helper to open / download documents via signed URL
  const handleOpenDocument = async (storagePath?: string, filename?: string, isDownload = false) => {
    if (!storagePath) {
      showToast({
        type: 'warning',
        title: 'File Missing',
        message: 'No file storage path recorded for this document. Please upload manually or run catch-up sync.',
      });
      return;
    }
    try {
      const url = await getSignedUrlCached('crm-documents', storagePath, 600, {
        download: isDownload ? filename : undefined,
      });
      if (url) {
        window.open(url, '_blank', 'noopener,noreferrer');
      } else {
        showToast({ type: 'error', title: 'Open Failed', message: 'Could not generate signed document URL.' });
      }
    } catch (err: any) {
      showToast({ type: 'error', title: 'Document Error', message: err.message || 'Could not open document' });
    }
  };

  // Helper to stream attachment live from Gmail API via Edge Function
  const handleStreamGmailAttachment = async (
    messageId: string,
    attachmentId: string,
    filename: string,
    mimeType?: string,
    isDownload = false
  ) => {
    setStreamingAttachmentId(`${messageId}-${attachmentId}`);
    try {
      const { data, error } = await supabase.functions.invoke('gmail-attachment-view', {
        body: {
          messageId,
          attachmentId,
          filename,
          mimeType,
          disposition: isDownload ? 'attachment' : 'inline',
        },
      });

      if (error) {
        throw new Error(error.message || 'Could not fetch attachment bytes from Gmail');
      }

      const blob = data instanceof Blob ? data : new Blob([data], { type: mimeType || 'application/octet-stream' });
      const blobUrl = URL.createObjectURL(blob);

      if (isDownload) {
        const link = document.createElement('a');
        link.href = blobUrl;
        link.download = filename;
        document.body.appendChild(link);
        link.click();
        document.body.removeChild(link);
      } else {
        window.open(blobUrl, '_blank', 'noopener,noreferrer');
      }

      setTimeout(() => URL.revokeObjectURL(blobUrl), 60000);
    } catch (err: any) {
      showToast({
        type: 'error',
        title: 'Attachment Retrieval Failed',
        message: err.message || 'Failed to download attachment from Gmail',
      });
    } finally {
      setStreamingAttachmentId(null);
    }
  };

  if (!isOpen || !row) return null;

  const evidence = row.evidence;
  const hasRealGmail = Boolean(evidence?.hasRealGmail && (evidence?.messageId || evidence?.threadId));

  const handleSaveEdit = async () => {
    setIsSaving(true);
    try {
      const parsedPrice = parseFloat(editPrice);
      const validPrice = !isNaN(parsedPrice) && parsedPrice > 0 ? parsedPrice : null;
      const parsedQuotePrice = parseFloat(editQuotePrice);
      const validQuotePrice = !isNaN(parsedQuotePrice) && parsedQuotePrice > 0 ? parsedQuotePrice : null;

      await onSaveCorrection(row.id, {
        inquiryId: editInquiryId || undefined,
        productName: editProductName || undefined,
        offeredMake: editOfferedMake || undefined,
        supplierName: editSupplierName || undefined,
        sourcePrice: validPrice,
        sourceCurrency: editCurrency,
        unit: editUnit,
        quotePrice: validQuotePrice,
      });

      setIsEditing(false);
      showToast({ type: 'success', title: 'Correction Saved', message: 'AI extraction updated successfully.' });
    } catch (err: any) {
      showToast({ type: 'error', title: 'Save Failed', message: err.message || 'Could not save correction' });
    } finally {
      setIsSaving(false);
    }
  };

  return (
    <div className="fixed inset-0 z-50 flex justify-end">
      {/* Backdrop */}
      <div
        className="fixed inset-0 bg-black/35 backdrop-blur-[1px] transition-opacity"
        onClick={onClose}
      />

      {/* Internal Slide-Over Panel (spacious for side-by-side thread + AI view) */}
      <div className="relative w-full max-w-5xl lg:max-w-6xl bg-white h-full shadow-2xl z-10 flex flex-col border-l border-gray-200 overflow-hidden animate-in slide-in-from-right duration-200">
        {/* Panel Header */}
        <div className="p-3.5 border-b border-gray-200 bg-gray-50 flex items-center justify-between gap-3">
          <div className="flex items-center gap-2 min-w-0">
            <div className={`p-1.5 rounded-md ${hasRealGmail ? 'bg-blue-100 text-blue-700' : 'bg-amber-100 text-amber-800'}`}>
              {hasRealGmail ? <Mail className="w-4 h-4" /> : <Database className="w-4 h-4" />}
            </div>
            <div className="min-w-0">
              <div className="text-xs font-bold text-gray-900 truncate">
                {hasRealGmail
                  ? (evidence?.subject || 'Supplier Email Evidence')
                  : `CRM Inquiry ${row.inquiryNumber} — ${row.productName}`}
              </div>
              <div className="text-[10px] text-gray-500 flex items-center gap-2 flex-wrap">
                {hasRealGmail ? (
                  <>
                    <span>From: <strong className="text-gray-700">{evidence?.from || 'Unknown'}</strong></span>
                    {evidence?.to && <span>• To: <strong className="text-gray-700">{evidence.to}</strong></span>}
                    {evidence?.cc && <span>• CC: <strong className="text-gray-700">{evidence.cc}</strong></span>}
                    {evidence?.date && <span>• {new Date(evidence.date).toLocaleString()}</span>}
                    {connectedEmail && <span className="text-gray-500">• Connected via: <strong className="text-gray-700">{connectedEmail}</strong></span>}
                    {row.inquiryNumber && <span className="text-blue-700 font-mono">[{row.inquiryNumber}]</span>}
                    {row.aceerpNo && row.aceerpNo !== '-' && <span className="text-gray-600 font-mono">[ACE: {row.aceerpNo}]</span>}
                  </>
                ) : (
                  <>
                    <span className="text-amber-800 font-semibold">CRM Source Record</span>
                    <span>• Inquiry: <strong className="text-gray-700">{row.inquiryNumber}</strong></span>
                    {row.aceerpNo && row.aceerpNo !== '-' && <span>• ACE: {row.aceerpNo}</span>}
                  </>
                )}
              </div>
            </div>
          </div>

          <div className="flex items-center gap-2">
            {/* View Toggle Tabs */}
            <div className="hidden sm:flex bg-gray-200 p-0.5 rounded text-[10px] font-semibold">
              <button
                onClick={() => setActiveTab('both')}
                className={`px-2 py-0.5 rounded cursor-pointer ${activeTab === 'both' ? 'bg-white text-gray-900 shadow-2xs' : 'text-gray-600'}`}
              >
                Split View
              </button>
              <button
                onClick={() => setActiveTab('source')}
                className={`px-2 py-0.5 rounded cursor-pointer ${activeTab === 'source' ? 'bg-white text-gray-900 shadow-2xs' : 'text-gray-600'}`}
              >
                {hasRealGmail ? `Gmail Thread (${threadMessages.length || 1})` : 'CRM Source'}
              </button>
              <button
                onClick={() => setActiveTab('ai')}
                className={`px-2 py-0.5 rounded cursor-pointer ${activeTab === 'ai' ? 'bg-white text-gray-900 shadow-2xs' : 'text-gray-600'}`}
              >
                AI Extraction
              </button>
            </div>

            <button
              onClick={onClose}
              className="p-1 text-gray-400 hover:text-gray-600 rounded hover:bg-gray-200 cursor-pointer"
              title="Close panel (Esc)"
              aria-label="Close panel"
            >
              <X className="w-4 h-4" />
            </button>
          </div>
        </div>

        {/* Panel Main Content Area */}
        <div className="flex-1 overflow-y-auto p-4 space-y-4 text-xs">
          {/* Action Callout Banner */}
          {row.status === 'Needs Review' && (
            <div className="bg-amber-50 border border-amber-200 rounded-md p-2.5 flex items-start justify-between gap-2">
              <div className="flex items-start gap-2">
                <AlertTriangle className="w-4 h-4 text-amber-600 flex-shrink-0 mt-0.5" />
                <div>
                  <div className="font-bold text-amber-900">User Action Required</div>
                  <div className="text-[11px] text-amber-800">
                    {row.actionReason || 'Ambiguous signals detected. Review source against interpretation below.'}
                  </div>
                </div>
              </div>

              <div className="flex items-center gap-1.5 flex-shrink-0">
                <button
                  onClick={() => onAccept(row.id)}
                  className="px-2.5 py-1 bg-amber-600 hover:bg-amber-700 text-white rounded font-semibold text-[11px] flex items-center gap-1 cursor-pointer"
                >
                  <Check className="w-3 h-3" />
                  <span>ACCEPT AI</span>
                </button>
                <button
                  onClick={() => setIsEditing(!isEditing)}
                  className="px-2.5 py-1 bg-white border border-amber-300 text-amber-900 hover:bg-amber-100 rounded font-semibold text-[11px] flex items-center gap-1 cursor-pointer"
                >
                  <Edit3 className="w-3 h-3" />
                  <span>{isEditing ? 'CANCEL' : 'CORRECT'}</span>
                </button>
              </div>
            </div>
          )}

          {/* Grid Layout: Source Evidence vs AI Extraction */}
          <div className={`grid gap-4 ${activeTab === 'both' ? 'grid-cols-1 lg:grid-cols-12' : 'grid-cols-1'}`}>
            {/* ============================================================ */}
            {/* COLUMN 1: SOURCE EVIDENCE (COMPLETE GMAIL THREAD OR CRM) */}
            {/* ============================================================ */}
            {(activeTab === 'both' || activeTab === 'source') && (
              <div className={`border border-gray-200 rounded-lg bg-gray-50/70 p-3.5 space-y-3 flex flex-col ${activeTab === 'both' ? 'lg:col-span-7' : ''}`}>
                {/* Header with Thread count and Controls */}
                <div className="flex items-center justify-between pb-2 border-b border-gray-200 gap-2 flex-wrap">
                  <div className="flex items-center gap-2">
                    <span className="font-bold text-gray-900 uppercase tracking-wide text-[11px]">
                      Source Evidence
                    </span>
                    {hasRealGmail ? (
                      <span className="text-[10px] bg-green-100 text-green-800 border border-green-200 px-1.5 py-0.5 rounded font-bold">
                        Actual Gmail ({threadMessages.length} msg{threadMessages.length !== 1 ? 's' : ''})
                      </span>
                    ) : (
                      <span className="text-[10px] bg-amber-100 text-amber-900 border border-amber-300 px-1.5 py-0.5 rounded font-bold">
                        CRM SOURCE — No Gmail message linked
                      </span>
                    )}
                  </div>

                  {hasRealGmail && threadMessages.length > 0 && (
                    <div className="flex items-center gap-2">
                      <button
                        onClick={handleExpandAll}
                        className="text-[10px] text-blue-600 hover:underline cursor-pointer font-medium"
                      >
                        Expand All
                      </button>
                      <span className="text-gray-300">|</span>
                      <button
                        onClick={handleCollapseAll}
                        className="text-[10px] text-blue-600 hover:underline cursor-pointer font-medium"
                      >
                        Collapse Older
                      </button>
                      <span className="text-gray-300">|</span>
                      <button
                        onClick={() => fetchThread(row.evidence?.threadId, row.evidence?.messageId)}
                        disabled={loadingThread}
                        className="text-[10px] text-gray-500 hover:text-gray-800 flex items-center gap-1 cursor-pointer disabled:opacity-50"
                        title="Refresh thread"
                      >
                        <RefreshCw className={`w-2.5 h-2.5 ${loadingThread ? 'animate-spin' : ''}`} />
                        <span>Refresh</span>
                      </button>
                    </div>
                  )}
                </div>

                {hasRealGmail ? (
                  /* ============================================================ */
                  /* COMPLETE GMAIL THREAD (OLDEST -> NEWEST) */
                  /* ============================================================ */
                  <div className="space-y-3">
                    {/* Loading State */}
                    {loadingThread && threadMessages.length === 0 && (
                      <div className="p-8 flex flex-col items-center justify-center gap-3 text-gray-500 bg-white rounded-lg border border-gray-200">
                        <div className="w-6 h-6 border-2 border-blue-600 border-t-transparent rounded-full animate-spin" />
                        <div className="text-xs font-medium">Fetching complete Gmail thread from connected account...</div>
                      </div>
                    )}

                    {/* Real Error State (Requirement #7) */}
                    {threadError && (
                      <div className="p-3.5 bg-red-50 border border-red-200 rounded-lg text-xs space-y-2">
                        <div className="flex items-center gap-1.5 font-bold text-red-900">
                          <AlertTriangle className="w-4 h-4 text-red-600 flex-shrink-0" />
                          <span>Gmail Retrieval Notice</span>
                        </div>
                        <div className="text-red-700 text-[11px] leading-relaxed">
                          {threadError}
                        </div>
                        <div className="pt-1 flex items-center gap-2">
                          <button
                            onClick={() => fetchThread(row.evidence?.threadId, row.evidence?.messageId)}
                            disabled={loadingThread}
                            className="px-2.5 py-1 bg-red-600 hover:bg-red-700 text-white rounded font-medium text-[11px] cursor-pointer flex items-center gap-1 disabled:opacity-50"
                          >
                            <RefreshCw className={`w-3 h-3 ${loadingThread ? 'animate-spin' : ''}`} />
                            <span>Retry Fetch</span>
                          </button>
                        </div>
                      </div>
                    )}

                    {/* Thread Messages List (Chronological: Oldest -> Newest) */}
                    {!loadingThread && threadMessages.length === 0 && !threadError && (
                      row.evidence?.bodyText || row.evidence?.bodyHtml ? (
                        <div className="rounded-lg border border-indigo-200 bg-white p-3 space-y-2">
                          <div className="flex items-center justify-between pb-1.5 border-b border-gray-100">
                            <span className="font-bold text-indigo-900 text-[11px] flex items-center gap-1">
                              <Sparkles className="w-3 h-3 text-indigo-600" />
                              Extracted Message Content (Initial Scan)
                            </span>
                            <span className="text-[10px] text-gray-400 font-mono">
                              {row.evidence.date ? new Date(row.evidence.date).toLocaleString() : ''}
                            </span>
                          </div>
                          <div className="text-[10.5px] font-mono text-gray-700 bg-gray-50/80 p-2 rounded border border-gray-200/70 space-y-0.5">
                            {row.evidence.subject && <div><strong className="font-sans text-gray-900">Subject:</strong> {row.evidence.subject}</div>}
                            {row.evidence.from && <div><strong className="font-sans text-gray-900">From:</strong> {row.evidence.from}</div>}
                            {row.evidence.to && <div><strong className="font-sans text-gray-900">To:</strong> {row.evidence.to}</div>}
                            {row.evidence.cc && <div><strong className="font-sans text-gray-900">CC:</strong> {row.evidence.cc}</div>}
                          </div>
                          {renderSafeEmailContent(row.evidence.bodyText, row.evidence.bodyHtml)}
                        </div>
                      ) : (
                        <div className="p-4 bg-white border border-gray-200 rounded-lg text-center text-gray-500 text-xs">
                          No messages found in this Gmail thread.
                        </div>
                      )
                    )}

                    {threadMessages.length > 0 && (
                      <div className="space-y-2.5">
                        {threadMessages.map((msg, idx) => {
                          const isTargetExtracted = msg.messageId === row.evidence?.messageId;
                          const isExpanded = Boolean(expandedMsgIds[msg.messageId]);
                          const hasAtts = msg.attachments && msg.attachments.length > 0;

                          return (
                            <div
                              key={msg.messageId || idx}
                              className={`rounded-lg border transition-all duration-150 overflow-hidden ${
                                isTargetExtracted
                                  ? 'border-indigo-400 bg-indigo-50/20 shadow-xs ring-1 ring-indigo-400/50'
                                  : 'border-gray-200 bg-white hover:border-gray-300'
                              }`}
                            >
                              {/* Clickable Card Header */}
                              <div
                                onClick={() => toggleMessage(msg.messageId)}
                                className={`p-2.5 flex items-center justify-between gap-3 cursor-pointer select-none ${
                                  isTargetExtracted ? 'bg-indigo-50/40' : 'bg-gray-50/40 hover:bg-gray-50'
                                }`}
                              >
                                <div className="flex items-center gap-2.5 min-w-0">
                                  <div
                                    className={`w-7 h-7 rounded-full flex items-center justify-center font-bold text-[10px] flex-shrink-0 ${
                                      isTargetExtracted ? 'bg-indigo-600 text-white shadow-2xs' : 'bg-gray-200 text-gray-700'
                                    }`}
                                  >
                                    {getInitials(msg.from)}
                                  </div>

                                  <div className="min-w-0">
                                    <div className="flex items-center gap-1.5 flex-wrap">
                                      <span className={`font-semibold text-xs truncate ${isTargetExtracted ? 'text-indigo-950 font-bold' : 'text-gray-900'}`}>
                                        {msg.from || 'Unknown Sender'}
                                      </span>
                                      {isTargetExtracted && (
                                        <span className="inline-flex items-center gap-1 px-1.5 py-0.2 rounded text-[9px] font-bold bg-indigo-100 text-indigo-800 border border-indigo-200">
                                          <Sparkles className="w-2.5 h-2.5 text-indigo-600" />
                                          AI EXTRACTION SOURCE
                                        </span>
                                      )}
                                      {hasAtts && (
                                        <span className="inline-flex items-center gap-0.5 px-1 py-0.2 rounded text-[9px] font-semibold bg-gray-100 text-gray-600">
                                          <Paperclip className="w-2.5 h-2.5" />
                                          {msg.attachments.length}
                                        </span>
                                      )}
                                    </div>

                                    {!isExpanded && (
                                      <div className="text-[11px] text-gray-500 truncate max-w-lg font-sans">
                                        {msg.snippet || msg.body?.slice(0, 100) || '(No preview available)'}
                                      </div>
                                    )}
                                  </div>
                                </div>

                                <div className="flex items-center gap-2 flex-shrink-0">
                                  <span className="text-[10px] text-gray-400 font-sans">
                                    {msg.date
                                      ? new Date(msg.date).toLocaleString([], {
                                          month: 'short',
                                          day: 'numeric',
                                          hour: '2-digit',
                                          minute: '2-digit',
                                        })
                                      : 'N/A'}
                                  </span>
                                  <div className="text-gray-400">
                                    {isExpanded ? <ChevronUp className="w-3.5 h-3.5" /> : <ChevronDown className="w-3.5 h-3.5" />}
                                  </div>
                                </div>
                              </div>

                              {/* Expanded Card Details */}
                              {isExpanded && (
                                <div className="border-t border-gray-100 p-3 space-y-3 bg-white">
                                  {/* Detailed Headers Table */}
                                  <div className="bg-gray-50/80 rounded p-2.5 text-[10.5px] space-y-1 font-mono text-gray-700 border border-gray-200/70">
                                    <div><strong className="text-gray-900 font-sans">From:</strong> {msg.from}</div>
                                    <div><strong className="text-gray-900 font-sans">To:</strong> {msg.to}</div>
                                    {msg.cc && <div><strong className="text-gray-900 font-sans">CC:</strong> {msg.cc}</div>}
                                    <div>
                                      <strong className="text-gray-900 font-sans">Date:</strong>{' '}
                                      {msg.date ? new Date(msg.date).toLocaleString() : 'N/A'}
                                    </div>
                                    <div><strong className="text-gray-900 font-sans">Subject:</strong> {msg.subject}</div>
                                    <div className="flex items-center gap-3 text-[10px] text-gray-400 pt-0.5">
                                      <span>Message ID: <span className="font-mono text-gray-500">{msg.messageId}</span></span>
                                      {msg.threadId && (
                                        <span>Thread ID: <span className="font-mono text-gray-500">{msg.threadId}</span></span>
                                      )}
                                    </div>
                                  </div>

                                  {/* FULL Email Body Content (Rendered safely without raw HTML) */}
                                  {renderSafeEmailContent(msg.bodyText || msg.body, msg.bodyHtml)}

                                  {/* Attachments for this Message */}
                                  {hasAtts && (
                                    <div className="space-y-1.5 pt-1">
                                      <div className="text-[10px] font-bold text-gray-700 uppercase flex items-center gap-1">
                                        <Paperclip className="w-3 h-3 text-gray-500" />
                                        <span>Message Attachments ({msg.attachments.length}):</span>
                                      </div>
                                      <div className="space-y-1">
                                        {msg.attachments.map((att, aIdx) => {
                                          const isBusy = streamingAttachmentId === `${msg.messageId}-${att.attachmentId}`;
                                          return (
                                            <div
                                              key={att.attachmentId || aIdx}
                                              className="bg-white border border-gray-200 rounded p-1.5 flex items-center justify-between gap-2"
                                            >
                                              <div className="flex items-center gap-1.5 min-w-0">
                                                <FileText className="w-3.5 h-3.5 text-blue-600 flex-shrink-0" />
                                                <span className="text-[11px] font-medium text-gray-800 truncate" title={att.filename}>
                                                  {att.filename}
                                                </span>
                                                {att.size > 0 && (
                                                  <span className="text-[9px] text-gray-400 font-mono">
                                                    ({formatBytes(att.size)})
                                                  </span>
                                                )}
                                                {att.documentType && (
                                                  <span className="text-[9px] bg-blue-50 text-blue-700 border border-blue-200 px-1 rounded font-bold">
                                                    {att.documentType}
                                                  </span>
                                                )}
                                                {att.storagePath ? (
                                                  <span className="text-[9px] text-green-700 font-semibold flex-shrink-0 bg-green-50 px-1 rounded border border-green-200">
                                                    ✓ Stored in CRM
                                                  </span>
                                                ) : (
                                                  <span className="text-[9px] text-blue-700 font-semibold flex-shrink-0 bg-blue-50 px-1 rounded border border-blue-200">
                                                    Gmail Attachment
                                                  </span>
                                                )}
                                              </div>

                                              <div className="flex items-center gap-1 flex-shrink-0">
                                                <button
                                                  type="button"
                                                  onClick={() => {
                                                    if (att.storagePath) {
                                                      handleOpenDocument(att.storagePath, att.filename, false);
                                                    } else if (att.attachmentId) {
                                                      handleStreamGmailAttachment(msg.messageId, att.attachmentId, att.filename, att.mimeType, false);
                                                    } else {
                                                      showToast({ type: 'warning', title: 'File Unavailable', message: 'Attachment cannot be opened directly.' });
                                                    }
                                                  }}
                                                  disabled={isBusy}
                                                  className="px-1.5 py-0.5 bg-gray-100 hover:bg-gray-200 text-gray-700 rounded text-[10px] flex items-center gap-0.5 cursor-pointer disabled:opacity-40"
                                                  title="View attachment"
                                                >
                                                  <Eye className="w-3 h-3" />
                                                  <span>{isBusy ? 'Opening...' : 'View'}</span>
                                                </button>
                                                <button
                                                  type="button"
                                                  onClick={() => {
                                                    if (att.storagePath) {
                                                      handleOpenDocument(att.storagePath, att.filename, true);
                                                    } else if (att.attachmentId) {
                                                      handleStreamGmailAttachment(msg.messageId, att.attachmentId, att.filename, att.mimeType, true);
                                                    } else {
                                                      showToast({ type: 'warning', title: 'File Unavailable', message: 'Attachment cannot be downloaded directly.' });
                                                    }
                                                  }}
                                                  disabled={isBusy}
                                                  className="px-1.5 py-0.5 bg-gray-100 hover:bg-gray-200 text-gray-700 rounded text-[10px] flex items-center gap-0.5 cursor-pointer disabled:opacity-40"
                                                  title="Download attachment"
                                                >
                                                  <Download className="w-3 h-3" />
                                                  <span>{isBusy ? 'Downloading...' : 'Get'}</span>
                                                </button>
                                              </div>
                                            </div>
                                          );
                                        })}
                                      </div>
                                    </div>
                                  )}
                                </div>
                              )}
                            </div>
                          );
                        })}
                      </div>
                    )}
                  </div>
                ) : (
                  /* ============================================================ */
                  /* CRM FALLBACK CARD (NO FAKE GMAIL HEADERS) */
                  /* ============================================================ */
                  <div className="space-y-3">
                    <div className="bg-amber-50/70 border border-amber-200 rounded p-3 text-xs space-y-2">
                      <div className="font-bold text-amber-950 flex items-center gap-1.5 text-[11px]">
                        <AlertTriangle className="w-3.5 h-3.5 text-amber-700" />
                        <span>CRM SOURCE — No Gmail Message Linked</span>
                      </div>
                      <div className="text-[11px] text-amber-900 leading-relaxed">
                        This inquiry record is populated directly from existing CRM database tables. No incoming Gmail supplier reply has been received or linked to this inquiry yet.
                      </div>
                      <div className="bg-white border border-amber-200 rounded p-2.5 text-[11px] space-y-1.5 font-mono text-gray-800">
                        <div><strong>Inquiry:</strong> {row.inquiryNumber}</div>
                        <div><strong>ACE ERP No:</strong> {row.aceerpNo || '-'}</div>
                        <div><strong>Customer:</strong> {row.customerName}</div>
                        <div><strong>Product:</strong> {row.productName}</div>
                        <div><strong>Specification:</strong> {row.specification || 'Standard'}</div>
                        <div><strong>Requested Make:</strong> {row.requestedMake || '-'}</div>
                        <div><strong>Offered Make:</strong> {row.offeredMake || '-'}</div>
                        <div>
                          <strong>CRM Source Price:</strong>{' '}
                          {row.sourcePrice != null ? `${row.sourceCurrency} ${row.sourcePrice} / ${row.unit}` : 'None recorded'}
                        </div>
                        <div><strong>CRM Remarks:</strong> {row.remarks || 'None'}</div>
                      </div>
                    </div>

                    {/* CRM Attached Documents */}
                    <div className="space-y-1.5 pt-1">
                      <div className="text-[10px] font-bold text-gray-600 uppercase flex items-center gap-1">
                        <FileText className="w-3 h-3 text-blue-600" />
                        <span>CRM Product Documents ({row.documents.length}):</span>
                      </div>

                      {row.documents.length === 0 ? (
                        <div className="text-[11px] text-gray-400 italic">No documents attached in CRM.</div>
                      ) : (
                        <div className="space-y-1">
                          {row.documents.map((doc, idx) => (
                            <div
                              key={doc.id || idx}
                              className="bg-white border border-gray-200 rounded p-1.5 flex items-center justify-between gap-2"
                            >
                              <div className="flex items-center gap-1.5 min-w-0">
                                <span className="font-bold text-[9px] bg-blue-50 text-blue-700 border border-blue-200 px-1 rounded flex-shrink-0">
                                  {doc.documentType}
                                </span>
                                <span className="text-[11px] font-medium text-gray-800 truncate" title={doc.filename}>
                                  {doc.filename}
                                </span>
                                {doc.storagePath ? (
                                  <span className="text-[9px] text-green-700 font-semibold flex-shrink-0 bg-green-50 px-1 rounded border border-green-200">
                                    ✓ Stored in CRM
                                  </span>
                                ) : (
                                  <span className="text-[9px] text-amber-700 font-semibold flex-shrink-0 bg-amber-50 px-1 rounded border border-amber-200">
                                    FILE NOT STORED / NEEDS RE-SYNC
                                  </span>
                                )}
                              </div>

                              <div className="flex items-center gap-1 flex-shrink-0">
                                <button
                                  type="button"
                                  onClick={() => handleOpenDocument(doc.storagePath, doc.filename, false)}
                                  disabled={!doc.storagePath}
                                  className="px-1.5 py-0.5 bg-gray-100 hover:bg-gray-200 text-gray-700 rounded text-[10px] flex items-center gap-0.5 cursor-pointer disabled:opacity-40"
                                  title="View document"
                                >
                                  <Eye className="w-3 h-3" />
                                  <span>View</span>
                                </button>
                                <button
                                  type="button"
                                  onClick={() => handleOpenDocument(doc.storagePath, doc.filename, true)}
                                  disabled={!doc.storagePath}
                                  className="px-1.5 py-0.5 bg-gray-100 hover:bg-gray-200 text-gray-700 rounded text-[10px] flex items-center gap-0.5 cursor-pointer disabled:opacity-40"
                                  title="Download document"
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
                  </div>
                )}
              </div>
            )}

            {/* ============================================================ */}
            {/* COLUMN 2: AI EXTRACTION / UNDERSTOOD DATA (BESIDE THE THREAD) */}
            {/* ============================================================ */}
            {(activeTab === 'both' || activeTab === 'ai') && (
              <div className={`border border-blue-200 rounded-lg bg-blue-50/20 p-3.5 space-y-3 flex flex-col ${activeTab === 'both' ? 'lg:col-span-5' : ''}`}>
                <div className="flex items-center justify-between pb-2 border-b border-blue-200">
                  <div className="flex items-center gap-1.5">
                    <span className="font-bold text-blue-950 uppercase tracking-wide text-[11px]">
                      AI Extraction
                    </span>
                    <span className="text-[10px] bg-blue-100 text-blue-800 px-1.5 py-0.5 rounded font-semibold flex items-center gap-0.5">
                      <Sparkles className="w-2.5 h-2.5" /> What SAPJ Understood
                    </span>
                  </div>

                  <button
                    onClick={() => setIsEditing(!isEditing)}
                    className="text-[11px] font-semibold text-blue-700 hover:underline flex items-center gap-1 cursor-pointer"
                  >
                    <Edit3 className="w-3 h-3" />
                    <span>{isEditing ? 'View Readonly' : 'Edit Extraction'}</span>
                  </button>
                </div>

                {/* Alternative Make Alert Banner */}
                {row.alternativeMakeDetected && (
                  <div className="bg-purple-50 border border-purple-200 p-2 rounded text-xs space-y-1">
                    <div className="font-bold text-purple-900 flex items-center gap-1">
                      <AlertTriangle className="w-3.5 h-3.5 text-purple-600" />
                      Alternative Make Detected
                    </div>
                    <div className="text-[11px] text-purple-800">
                      Requested: <strong className="text-purple-950">{row.requestedMake || 'None'}</strong> • Offered: <strong className="text-purple-950">{row.offeredMake}</strong>
                    </div>
                  </div>
                )}

                {/* Readonly or Edit View */}
                {!isEditing ? (
                  <div className="space-y-2.5 bg-white border border-gray-200 rounded-md p-3 text-[11px]">
                    <div className="grid grid-cols-2 gap-2">
                      <div>
                        <div className="flex items-center justify-between">
                          <span className="text-gray-400 text-[10px] uppercase font-semibold">Product</span>
                          <span className="text-[9px] font-bold px-1 rounded bg-gray-100 text-gray-600">CRM</span>
                        </div>
                        <span className="font-bold text-gray-900">{row.productName}</span>
                      </div>

                      <div>
                        <div className="flex items-center justify-between">
                          <span className="text-gray-400 text-[10px] uppercase font-semibold">Supplier</span>
                          <span className={`text-[9px] font-bold px-1 rounded ${hasRealGmail ? 'bg-blue-100 text-blue-700' : 'bg-gray-100 text-gray-600'}`}>
                            {hasRealGmail ? 'EMAIL BODY' : 'CRM'}
                          </span>
                        </div>
                        <span className="font-bold text-gray-900">{row.supplierName || '-'}</span>
                      </div>

                      <div>
                        <div className="flex items-center justify-between">
                          <span className="text-gray-400 text-[10px] uppercase font-semibold">Requested Make</span>
                          <span className="text-[9px] font-bold px-1 rounded bg-gray-100 text-gray-600">CRM</span>
                        </div>
                        <span className="font-bold text-gray-900">{row.requestedMake || '-'}</span>
                      </div>

                      <div>
                        <div className="flex items-center justify-between">
                          <span className="text-gray-400 text-[10px] uppercase font-semibold">Offered Make</span>
                          <span className={`text-[9px] font-bold px-1 rounded ${hasRealGmail ? 'bg-blue-100 text-blue-700' : 'bg-gray-100 text-gray-600'}`}>
                            {hasRealGmail ? 'EMAIL BODY' : 'CRM'}
                          </span>
                        </div>
                        <span className="font-bold text-gray-900">{row.offeredMake || row.requestedMake || '-'}</span>
                      </div>

                      <div>
                        <div className="flex items-center justify-between">
                          <span className="text-gray-400 text-[10px] uppercase font-semibold">Supplier Price</span>
                          <span className={`text-[9px] font-bold px-1 rounded ${hasRealGmail ? 'bg-blue-100 text-blue-700' : 'bg-gray-100 text-gray-600'}`}>
                            {hasRealGmail ? 'EMAIL BODY' : 'CRM'}
                          </span>
                        </div>
                        <span className="font-mono font-bold text-base text-gray-950">
                          {row.sourcePrice != null ? `${row.sourceCurrency} ${row.sourcePrice} / ${row.unit}` : '—'}
                        </span>
                      </div>

                      <div>
                        <div className="flex items-center justify-between">
                          <span className="text-gray-400 text-[10px] uppercase font-semibold">Currency</span>
                          <span className={`text-[9px] font-bold px-1 rounded ${hasRealGmail ? 'bg-blue-100 text-blue-700' : 'bg-gray-100 text-gray-600'}`}>
                            {hasRealGmail ? 'EMAIL BODY' : 'CRM'}
                          </span>
                        </div>
                        <span className="font-bold text-gray-900">{row.sourceCurrency}</span>
                      </div>

                      <div className="bg-blue-50/60 p-1.5 rounded border border-blue-200">
                        <div className="flex items-center justify-between">
                          <span className="text-blue-900 text-[10px] uppercase font-bold">Landed Cost</span>
                          <span className="text-[9px] font-bold px-1 rounded bg-blue-100 text-blue-800">ENGINE</span>
                        </div>
                        <span className="font-mono font-bold text-sm text-blue-950">
                          {row.landedCostUsd != null ? `$${row.landedCostUsd.toFixed(2)} / kg` : '—'}
                        </span>
                      </div>

                      <div className="bg-emerald-50/60 p-1.5 rounded border border-emerald-200">
                        <div className="flex items-center justify-between">
                          <span className="text-emerald-900 text-[10px] uppercase font-bold">Suggested Quote</span>
                          <span className="text-[9px] font-bold px-1 rounded bg-emerald-100 text-emerald-800">RECOMMENDED</span>
                        </div>
                        <span className="font-mono font-bold text-sm text-emerald-950">
                          {row.suggestedQuoteUsd != null ? `$${row.suggestedQuoteUsd.toFixed(2)} / kg` : '—'}
                        </span>
                      </div>

                      <div className="col-span-2 bg-green-50 p-2 rounded border border-green-300">
                        <div className="flex items-center justify-between">
                          <span className="text-green-900 text-[10px] uppercase font-black">Actual Quoted Price</span>
                          <span className="text-[9px] font-bold px-1.5 py-0.5 rounded bg-green-600 text-white">CUSTOMER QUOTE</span>
                        </div>
                        <div className="flex items-center justify-between mt-0.5">
                          <span className="font-mono font-black text-base text-green-950">
                            {row.quotePrice != null ? `${row.quoteCurrency || 'USD'} ${row.quotePrice}` : '— (Not Quoted Yet)'}
                          </span>
                          {!row.quotePrice && (
                            <span className="text-[10px] text-amber-700 font-semibold bg-amber-100 px-1.5 py-0.5 rounded">
                              Action Needed: Enter Quote
                            </span>
                          )}
                        </div>
                      </div>

                      <div>
                        <div className="flex items-center justify-between">
                          <span className="text-gray-400 text-[10px] uppercase font-semibold">Quantity</span>
                          <span className="text-[9px] font-bold px-1 rounded bg-gray-100 text-gray-600">CRM</span>
                        </div>
                        <span className="font-medium text-gray-800">{row.quantity} ({row.unit})</span>
                      </div>

                      <div>
                        <div className="flex items-center justify-between">
                          <span className="text-gray-400 text-[10px] uppercase font-semibold">MOQ & Availability</span>
                          <span className={`text-[9px] font-bold px-1 rounded ${hasRealGmail ? 'bg-blue-100 text-blue-700' : 'bg-gray-100 text-gray-600'}`}>
                            {hasRealGmail ? 'EMAIL BODY' : 'CRM'}
                          </span>
                        </div>
                        <span className="text-gray-700 capitalize">{row.moq} • {row.availability}</span>
                      </div>

                      <div>
                        <div className="flex items-center justify-between">
                          <span className="text-gray-400 text-[10px] uppercase font-semibold">Lead Time</span>
                          <span className={`text-[9px] font-bold px-1 rounded ${hasRealGmail ? 'bg-blue-100 text-blue-700' : 'bg-gray-100 text-gray-600'}`}>
                            {hasRealGmail ? 'EMAIL BODY' : 'CRM'}
                          </span>
                        </div>
                        <span className="text-gray-700">{row.leadTime}</span>
                      </div>

                      <div>
                        <div className="flex items-center justify-between">
                          <span className="text-gray-400 text-[10px] uppercase font-semibold">Specification</span>
                          <span className="text-[9px] font-bold px-1 rounded bg-gray-100 text-gray-600">CRM</span>
                        </div>
                        <span className="text-gray-700 truncate block">{row.specification || 'Standard'}</span>
                      </div>

                      <div>
                        <div className="flex items-center justify-between">
                          <span className="text-gray-400 text-[10px] uppercase font-semibold">Inquiry</span>
                          <span className="text-[9px] font-bold px-1 rounded bg-gray-100 text-gray-600">CRM</span>
                        </div>
                        <span className="font-mono font-bold text-blue-700">{row.inquiryNumber}</span>
                      </div>

                      <div>
                        <div className="flex items-center justify-between">
                          <span className="text-gray-400 text-[10px] uppercase font-semibold">ACE ERP</span>
                          <span className="text-[9px] font-bold px-1 rounded bg-gray-100 text-gray-600">CRM</span>
                        </div>
                        <span className="font-mono font-bold text-gray-800">{row.aceerpNo || '-'}</span>
                      </div>
                    </div>

                    {/* AI WHY Evidence Quote */}
                    {evidence?.why && (
                      <div className="mt-2 pt-2 border-t border-gray-100">
                        <span className="text-gray-400 block text-[10px] uppercase font-semibold mb-0.5">
                          Evidence / Reasoning:
                        </span>
                        <p className="text-gray-700 italic bg-gray-50 p-2 rounded border border-gray-200 text-[10.5px]">
                          "{evidence.why}"
                        </p>
                      </div>
                    )}
                  </div>
                ) : (
                  /* Editable Form for One-Click Correction */
                  <div className="space-y-2 bg-white border border-blue-300 rounded-md p-3 text-xs">
                    <div className="text-[11px] font-bold text-blue-900 mb-1">
                      Correct Extraction:
                    </div>

                    <div>
                      <label className="text-[10px] text-gray-500 font-semibold">Link to Inquiry</label>
                      <select
                        value={editInquiryId}
                        onChange={e => setEditInquiryId(e.target.value)}
                        className="w-full border border-gray-300 rounded px-2 py-1 text-xs bg-white"
                      >
                        <option value="">Select Inquiry ▼</option>
                        {allInquiries.map(i => (
                          <option key={i.id} value={i.id}>
                            {i.inquiry_number} ({i.aceerp_no || 'No ACE'}) - {i.product_name.slice(0, 24)}
                          </option>
                        ))}
                      </select>
                    </div>

                    <div className="grid grid-cols-2 gap-2">
                      <div>
                        <label className="text-[10px] text-gray-500 font-semibold">Product Name</label>
                        <input
                          value={editProductName}
                          onChange={e => setEditProductName(e.target.value)}
                          className="w-full border border-gray-300 rounded px-2 py-1 text-xs"
                        />
                      </div>
                      <div>
                        <label className="text-[10px] text-gray-500 font-semibold">Offered Make</label>
                        <input
                          list="make-drawer-options"
                          value={editOfferedMake}
                          onChange={e => setEditOfferedMake(e.target.value)}
                          className="w-full border border-gray-300 rounded px-2 py-1 text-xs"
                        />
                        <datalist id="make-drawer-options">
                          {makeOptions.map(m => <option key={m} value={m} />)}
                        </datalist>
                      </div>
                      <div>
                        <label className="text-[10px] text-gray-500 font-semibold">Supplier Name</label>
                        <input
                          value={editSupplierName}
                          onChange={e => setEditSupplierName(e.target.value)}
                          className="w-full border border-gray-300 rounded px-2 py-1 text-xs"
                        />
                      </div>
                      <div>
                        <label className="text-[10px] text-gray-500 font-semibold">Supplier Rate</label>
                        <div className="flex gap-1">
                          <input
                            type="text"
                            inputMode="decimal"
                            value={editPrice}
                            onChange={e => setEditPrice(e.target.value)}
                            className="w-full border border-gray-300 rounded px-2 py-1 text-xs font-mono font-bold"
                            placeholder="3650"
                          />
                          <select
                            value={editCurrency}
                            onChange={e => setEditCurrency(e.target.value as any)}
                            className="border border-gray-300 rounded px-1 text-xs bg-white font-bold"
                          >
                            <option value="INR">INR</option>
                            <option value="USD">USD</option>
                          </select>
                          <select
                            value={editUnit}
                            onChange={e => setEditUnit(e.target.value)}
                            className="border border-gray-300 rounded px-1 text-xs bg-white font-bold"
                          >
                            <option value="KG">KG</option>
                            <option value="MT">MT</option>
                          </select>
                        </div>
                      </div>

                      <div className="col-span-2 bg-green-50/60 p-2 rounded border border-green-200">
                        <div className="flex items-center justify-between mb-1">
                          <label className="text-[10px] text-green-950 font-bold uppercase">
                            Actual Quoted Price ($/kg)
                          </label>
                          {row.suggestedQuoteUsd !== null && (
                            <button
                              type="button"
                              onClick={() => setEditQuotePrice(String(row.suggestedQuoteUsd))}
                              className="text-[10px] text-blue-700 hover:text-blue-900 font-semibold underline cursor-pointer"
                            >
                              Use Suggested (${row.suggestedQuoteUsd.toFixed(2)})
                            </button>
                          )}
                        </div>
                        <input
                          type="text"
                          inputMode="decimal"
                          value={editQuotePrice}
                          onChange={e => setEditQuotePrice(e.target.value)}
                          className="w-full border border-green-400 rounded px-2 py-1 text-xs font-mono font-bold text-green-950 bg-white"
                          placeholder="e.g. 2.45 (Approved Customer Quote)"
                        />
                      </div>
                    </div>

                    <div className="pt-2 flex justify-end gap-2">
                      <button
                        onClick={() => setIsEditing(false)}
                        className="px-2.5 py-1 text-gray-600 hover:bg-gray-100 rounded text-xs cursor-pointer"
                      >
                        Cancel
                      </button>
                      <button
                        onClick={handleSaveEdit}
                        disabled={isSaving}
                        className="px-3 py-1 bg-blue-600 hover:bg-blue-700 text-white rounded text-xs font-semibold flex items-center gap-1 shadow-2xs disabled:opacity-50 cursor-pointer"
                      >
                        <Save className="w-3.5 h-3.5" />
                        <span>{isSaving ? 'Saving...' : 'SAVE CORRECTION'}</span>
                      </button>
                    </div>
                  </div>
                )}

                {/* Bottom Action Buttons */}
                <div className="pt-2 border-t border-blue-200 flex items-center gap-2">
                  <button
                    onClick={() => {
                      onAccept(row.id);
                      onClose();
                    }}
                    className="flex-1 py-1.5 px-3 bg-green-600 hover:bg-green-700 text-white rounded font-bold text-xs flex items-center justify-center gap-1.5 shadow-2xs cursor-pointer"
                  >
                    <CheckCircle2 className="w-3.5 h-3.5" />
                    <span>CONFIRM & APPLY</span>
                  </button>

                  <button
                    onClick={() => setIsEditing(!isEditing)}
                    className="py-1.5 px-3 bg-white border border-blue-300 text-blue-900 hover:bg-blue-50 rounded font-semibold text-xs flex items-center gap-1 cursor-pointer"
                  >
                    <Edit3 className="w-3.5 h-3.5" />
                    <span>{isEditing ? 'Cancel Edit' : 'Edit'}</span>
                  </button>
                </div>
              </div>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}

export default KunalEmailEvidenceDrawer;
