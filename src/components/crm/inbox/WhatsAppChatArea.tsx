// src/components/crm/inbox/WhatsAppChatArea.tsx
//
// Center Pane: Authentic WhatsApp Chat Interface.
// Supports text, documents (PDF), images, delivery status ticks (sent, delivered, read),
// and compact quick-action triggers.

import React, { useState, useRef, useEffect } from 'react';
import {
  Send,
  Paperclip,
  Check,
  CheckCheck,
  FileText,
  Download,
  Eye,
  DollarSign,
  Package,
  Clock,
  Sparkles,
  Search,
  ExternalLink,
  Loader,
  AlertTriangle,
  ChevronRight,
  Info,
  ArrowLeft,
  ShieldCheck,
  Settings,
} from 'lucide-react';
import { ThreadMessage } from './CrmOmnichannelInbox';
import { supabase } from '../../../lib/supabase';
import { showToast } from '../../ToastNotification';
import { uploadOptimizedFile } from '../../../services/storage/uploadOptimizationService';

interface Props {
  conversationTitle: string;
  recipientPhone: string;
  isWhatsApp: boolean;
  messages: ThreadMessage[];
  loading: boolean;
  error?: string | null;
  onSendMessage: (text: string, documentUrl?: string, filename?: string) => Promise<void>;
  onOpenQuotationModal: () => void;
  onOpenDocumentModal: () => void;
  onOpenStockModal: () => void;
  onOpenFollowUpModal: () => void;
  onToggleContextPanel: () => void;
  suggestedReply?: string | null;
  detectedIntent?: string | null;
  isSimulation?: boolean;
  onBack?: () => void;
}

export function WhatsAppChatArea({
  conversationTitle,
  recipientPhone,
  isWhatsApp,
  messages,
  loading,
  error,
  onSendMessage,
  onOpenQuotationModal,
  onOpenDocumentModal,
  onOpenStockModal,
  onOpenFollowUpModal,
  onToggleContextPanel,
  suggestedReply,
  detectedIntent,
  isSimulation = false,
  onBack,
}: Props) {
  const [inputText, setInputText] = useState('');
  const [sending, setSending] = useState(false);
  const [uploadingAttachment, setUploadingAttachment] = useState(false);
  const [searchInChat, setSearchInChat] = useState('');
  const [showSearch, setShowSearch] = useState(false);
  const messagesEndRef = useRef<HTMLDivElement>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);

  // Operator-configurable 20-second cooldown safeguard
  const [cooldownConfigSeconds, setCooldownConfigSeconds] = useState<number>(20);
  const [cooldownRemaining, setCooldownRemaining] = useState<number>(0);
  const [showCooldownSettings, setShowCooldownSettings] = useState<boolean>(false);

  useEffect(() => {
    messagesEndRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [messages]);

  useEffect(() => {
    if (cooldownRemaining <= 0) return;
    const timer = setInterval(() => {
      setCooldownRemaining((prev) => (prev > 0 ? prev - 1 : 0));
    }, 1000);
    return () => clearInterval(timer);
  }, [cooldownRemaining]);

  const handleSend = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!inputText.trim()) return;
    if (cooldownRemaining > 0) {
      showToast({
        type: 'warning',
        title: 'Cooldown Active',
        message: `Please wait ${cooldownRemaining}s before sending another manual message.`,
      });
      return;
    }

    const text = inputText.trim();
    setInputText('');
    setSending(true);
    try {
      await onSendMessage(text);
    } catch (err: any) {
      showToast({ type: 'error', title: 'Send Error', message: err.message || 'Failed to dispatch message.' });
    } finally {
      setSending(false);
      // Trigger operator cooldown safeguard between human-initiated messages
      setCooldownRemaining(cooldownConfigSeconds);
    }
  };

  const handleFileUpload = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;

    setUploadingAttachment(true);
    try {
      const safeName = file.name.replace(/[^a-zA-Z0-9._-]/g, '_');
      const storagePath = `whatsapp-attachments/${Date.now()}_${safeName}`;

      const { error: uploadError } = await uploadOptimizedFile(
        supabase,
        'crm-documents',
        storagePath,
        file,
        { upsert: true }
      );

      if (uploadError) throw uploadError;

      const { data: signData } = await supabase.storage
        .from('crm-documents')
        .createSignedUrl(storagePath, 86400 * 7);

      const downloadUrl = signData?.signedUrl || '';
      await onSendMessage(file.name, downloadUrl, file.name);
      showToast({ type: 'success', title: 'File Attached', message: `Sent ${file.name}` });
    } catch (err: any) {
      showToast({ type: 'error', title: 'Upload Failed', message: err.message || 'Could not upload attachment.' });
    } finally {
      setUploadingAttachment(false);
      if (fileInputRef.current) fileInputRef.current.value = '';
    }
  };

  const filteredMessages = messages.filter((m) => {
    if (!searchInChat.trim()) return true;
    const q = searchInChat.toLowerCase();
    return (m.body || '').toLowerCase().includes(q) || (m.subject || '').toLowerCase().includes(q);
  });

  const renderStatusTick = (msg: ThreadMessage) => {
    if (msg.direction !== 'outbound') return null;

    const payload = (msg as any).raw_payload || {};
    const isSim =
      msg.id?.startsWith('sim_wa_') ||
      (msg as any).isSimulation ||
      payload.isSimulation ||
      payload.is_simulation;

    if (isSim) {
      return (
        <span
          title="SIMULATED — NOT SENT TO CUSTOMER"
          className="inline-flex items-center ml-1 px-1.5 py-0.5 rounded text-[9px] font-bold bg-amber-100 text-amber-900 border border-amber-300 shrink-0"
        >
          SIMULATED — NOT SENT TO CUSTOMER
        </span>
      );
    }

    // Delivery state ticks
    const delivery = payload.delivery_status || 'sent';

    if (delivery === 'read') {
      return (
        <span title="Read" className="inline-flex items-center">
          <CheckCheck className="w-3.5 h-3.5 text-sky-500 inline ml-1 shrink-0" />
        </span>
      );
    }
    if (delivery === 'delivered') {
      return (
        <span title="Delivered" className="inline-flex items-center">
          <CheckCheck className="w-3.5 h-3.5 text-gray-400 inline ml-1 shrink-0" />
        </span>
      );
    }
    if (delivery === 'failed') {
      return (
        <span
          title={payload.status_details?.errors?.[0]?.message || 'Failed to deliver'}
          className="inline-flex items-center"
        >
          <AlertTriangle className="w-3.5 h-3.5 text-rose-500 inline ml-1 shrink-0" />
        </span>
      );
    }
    return (
      <span title="Sent to carrier" className="inline-flex items-center">
        <Check className="w-3.5 h-3.5 text-gray-400 inline ml-1 shrink-0" />
      </span>
    );
  };

  return (
    <div className="flex flex-col h-full bg-[#efeae2]/40 relative">
      {/* Top Bar */}
      <div className="h-14 bg-white border-b border-gray-200 px-3 sm:px-4 flex items-center justify-between shadow-sm shrink-0">
        <div className="flex items-center gap-2 sm:gap-3 min-w-0">
          {onBack && (
            <button
              type="button"
              onClick={onBack}
              className="p-1.5 -ml-1 rounded-full hover:bg-gray-100 text-gray-700 md:hidden flex items-center justify-center shrink-0 cursor-pointer"
              title="Back to conversation list"
              aria-label="Back to conversation list"
            >
              <ArrowLeft className="w-5 h-5 text-gray-700" />
            </button>
          )}
          <div className="w-9 h-9 rounded-full bg-emerald-600 text-white font-bold flex items-center justify-center text-xs shadow-sm shrink-0">
            {conversationTitle.charAt(0).toUpperCase()}
          </div>
          <div className="min-w-0">
            <h3 className="text-xs font-bold text-gray-900 truncate">{conversationTitle}</h3>
            <div className="flex items-center gap-1.5 text-[11px] text-gray-500">
              <span className="font-mono text-gray-700 truncate">{recipientPhone}</span>
              <span className="text-gray-300">&bull;</span>
              <span className="inline-flex items-center gap-1 text-emerald-700 font-medium truncate">
                <span className="w-1.5 h-1.5 rounded-full bg-emerald-500 shrink-0" />
                {isSimulation ? 'Simulated Dev Transport' : isWhatsApp ? 'WhatsApp Business' : 'Email Thread'}
              </span>
            </div>
          </div>
        </div>

        {/* Action icons */}
        <div className="flex items-center gap-1">
          <button
            onClick={() => setShowSearch(!showSearch)}
            className="p-1.5 rounded hover:bg-gray-100 text-gray-500 transition"
            title="Search in conversation"
          >
            <Search className="w-4 h-4" />
          </button>
          <button
            onClick={onToggleContextPanel}
            className="p-1.5 rounded hover:bg-gray-100 text-gray-600 transition flex items-center gap-1 text-xs font-semibold"
            title="Customer & ERP Context"
          >
            <Info className="w-4 h-4 text-emerald-700" />
            <span className="hidden sm:inline">Details</span>
          </button>
        </div>
      </div>

      {/* Top Simulation Warning Banner */}
      {isSimulation && (
        <div className="bg-amber-100/90 border-b border-amber-300 px-4 py-1.5 text-xs text-amber-900 font-semibold flex items-center justify-between shadow-xs">
          <div className="flex items-center gap-2">
            <AlertTriangle className="w-4 h-4 text-amber-600 shrink-0" />
            <span>⚠️ SIMULATED TRANSPORT — NOT SENT TO REAL CUSTOMER</span>
          </div>
          <span className="text-[10px] bg-amber-200 text-amber-950 font-bold px-2 py-0.5 rounded border border-amber-300 uppercase tracking-wide">
            Test Sandbox Active
          </span>
        </div>
      )}

      {/* In-chat search bar */}
      {showSearch && (
        <div className="p-2 bg-white border-b border-gray-200 flex items-center gap-2 text-xs">
          <Search className="w-3.5 h-3.5 text-gray-400" />
          <input
            type="text"
            value={searchInChat}
            onChange={(e) => setSearchInChat(e.target.value)}
            placeholder="Search within this conversation..."
            className="flex-1 border-none outline-none text-xs"
            autoFocus
          />
          <button onClick={() => setSearchInChat('')} className="text-gray-400 hover:text-gray-600">
            Clear
          </button>
        </div>
      )}

      {/* AI Intent & Quick Suggestion Bar */}
      {detectedIntent && (
        <div className="bg-emerald-50/90 border-b border-emerald-200/80 px-4 py-2 flex items-center justify-between text-xs animate-in fade-in">
          <div className="flex items-center gap-2 text-emerald-900">
            <Sparkles className="w-3.5 h-3.5 text-emerald-600 shrink-0" />
            <span className="font-semibold">Detected Intent:</span>
            <span className="px-2 py-0.5 rounded bg-emerald-200/60 font-bold text-[11px] text-emerald-800">
              {detectedIntent}
            </span>
          </div>
          {suggestedReply && (
            <button
              onClick={() => setInputText(suggestedReply)}
              className="text-emerald-700 hover:text-emerald-900 font-semibold text-[11px] underline"
            >
              Use Suggested Draft
            </button>
          )}
        </div>
      )}

      {/* Messages Stream */}
      <div className="flex-1 overflow-y-auto p-4 space-y-3">
        {loading ? (
          <div className="h-full flex items-center justify-center text-gray-400 text-xs gap-2">
            <Loader className="w-5 h-5 animate-spin text-emerald-600" />
            Loading messages...
          </div>
        ) : error ? (
          <div className="p-4 bg-rose-50 border border-rose-200 rounded-lg text-rose-700 text-xs text-center">
            {error}
          </div>
        ) : filteredMessages.length === 0 ? (
          <div className="h-full flex flex-col items-center justify-center text-gray-400 text-xs">
            <div className="w-12 h-12 rounded-full bg-white flex items-center justify-center mb-2 shadow-sm text-gray-300">
              <Check className="w-6 h-6" />
            </div>
            No messages yet. Send a greeting or quotation to start!
          </div>
        ) : (
          filteredMessages.map((msg) => {
            const isOut = msg.direction === 'outbound';
            const timeStr = msg.date ? new Date(msg.date).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }) : '';

            return (
              <div key={msg.id} className={`flex ${isOut ? 'justify-end' : 'justify-start'}`}>
                <div
                  className={`max-w-[78%] sm:max-w-[65%] rounded-lg p-2.5 shadow-sm text-xs relative ${
                    isOut
                      ? 'bg-[#d9fdd3] text-gray-900 rounded-tr-none border border-emerald-200/50'
                      : 'bg-white text-gray-900 rounded-tl-none border border-gray-100'
                  }`}
                >
                  {/* Sender Name if inbound */}
                  {!isOut && msg.from && (
                    <p className="text-[10px] font-bold text-emerald-800 mb-1">{msg.from}</p>
                  )}

                  {/* Attachment Card if document / PDF */}
                  {msg.attachments && msg.attachments.length > 0 && (
                    <div className="mb-2 space-y-1.5">
                      {msg.attachments.map((att, i) => (
                        <div
                          key={i}
                          className="p-2 bg-white/80 border border-gray-200/80 rounded flex items-center justify-between gap-2 shadow-xs"
                        >
                          <div className="flex items-center gap-2 min-w-0">
                            <FileText className="w-4 h-4 text-emerald-700 shrink-0" />
                            <span className="font-semibold truncate text-[11px] text-gray-900">
                              {att.filename}
                            </span>
                          </div>
                          {att.storagePath && (
                            <a
                              href={att.storagePath}
                              target="_blank"
                              rel="noopener noreferrer"
                              className="p-1 rounded hover:bg-gray-100 text-emerald-700"
                              title="Download Attachment"
                            >
                              <Download className="w-3.5 h-3.5" />
                            </a>
                          )}
                        </div>
                      ))}
                    </div>
                  )}

                  {/* Body Text */}
                  <p className="whitespace-pre-wrap leading-relaxed select-text">{msg.body}</p>

                  {/* Timestamp & Status */}
                  <div className="flex items-center justify-end gap-1 mt-1 text-[10px] text-gray-400 select-none">
                    <span>{timeStr}</span>
                    {renderStatusTick(msg)}
                  </div>
                </div>
              </div>
            );
          })
        )}
        <div ref={messagesEndRef} />
      </div>

      {/* Quick ERP Action Buttons above composer */}
      <div className="px-3 py-1.5 bg-slate-50 border-t border-gray-200 flex flex-wrap lg:flex-nowrap items-center gap-1.5 shrink-0">
        <span className="text-[10px] font-bold uppercase text-gray-400 shrink-0 mr-0.5">ERP Actions:</span>
        <button
          onClick={onOpenQuotationModal}
          className="px-2.5 py-1 rounded bg-white hover:bg-emerald-50 border border-emerald-300 text-emerald-800 text-[11px] font-semibold flex items-center gap-1 shrink-0 shadow-2xs transition cursor-pointer"
        >
          <DollarSign className="w-3 h-3 text-emerald-600" />
          Send Quotation
        </button>
        <button
          onClick={onOpenDocumentModal}
          className="px-2.5 py-1 rounded bg-white hover:bg-sky-50 border border-sky-300 text-sky-800 text-[11px] font-semibold flex items-center gap-1 shrink-0 shadow-2xs transition cursor-pointer"
        >
          <FileText className="w-3 h-3 text-sky-600" />
          Send COA / Spec
        </button>
        <button
          onClick={onOpenStockModal}
          className="px-2.5 py-1 rounded bg-white hover:bg-slate-100 border border-slate-300 text-slate-800 text-[11px] font-semibold flex items-center gap-1 shrink-0 shadow-2xs transition cursor-pointer"
        >
          <Package className="w-3 h-3 text-slate-600" />
          Check Stock
        </button>
        <button
          onClick={onOpenFollowUpModal}
          className="px-2.5 py-1 rounded bg-white hover:bg-indigo-50 border border-indigo-300 text-indigo-800 text-[11px] font-semibold flex items-center gap-1 shrink-0 shadow-2xs transition cursor-pointer"
        >
          <Clock className="w-3 h-3 text-indigo-600" />
          Follow-Up
        </button>
      </div>

      {/* Recorded Permission Safeguard */}
      <div className="px-3 py-1 bg-emerald-50/70 border-t border-emerald-100 text-[10px] text-emerald-900 flex items-center justify-between">
        <div className="flex items-center gap-1.5 min-w-0">
          <ShieldCheck className="w-3.5 h-3.5 text-emerald-600 shrink-0" />
          <span className="truncate">
            <strong>Permission on File:</strong> Verified B2B partner ({recipientPhone}). Operator must explicitly review and click Send.
          </span>
        </div>
        <button
          type="button"
          onClick={() => setShowCooldownSettings(!showCooldownSettings)}
          className="text-[10px] text-emerald-800 hover:text-emerald-950 font-semibold flex items-center gap-1 shrink-0"
          title="Pacing delay safeguard settings"
        >
          <Clock className="w-3 h-3 text-emerald-700" />
          <span>Pacing: {cooldownConfigSeconds}s</span>
        </button>
      </div>

      {/* Operator Pacing Settings Drawer */}
      {showCooldownSettings && (
        <div className="px-3 py-1.5 bg-slate-50 border-t border-slate-200 text-xs flex items-center justify-between gap-3">
          <span className="text-gray-700 font-medium text-[11px]">
            Message Pacing Safeguard (OpenWA anti-spam safeguard):
          </span>
          <div className="flex items-center gap-1">
            {[10, 15, 20, 30].map((sec) => (
              <button
                key={sec}
                type="button"
                onClick={() => {
                  setCooldownConfigSeconds(sec);
                  setShowCooldownSettings(false);
                  showToast({ type: 'info', title: 'Pacing Updated', message: `Pacing cooldown set to ${sec}s.` });
                }}
                className={`px-2 py-0.5 rounded text-[10px] font-semibold border ${
                  cooldownConfigSeconds === sec
                    ? 'bg-emerald-600 text-white border-emerald-700'
                    : 'bg-white text-gray-700 border-gray-300 hover:bg-gray-100'
                }`}
              >
                {sec}s
              </button>
            ))}
          </div>
        </div>
      )}

      {/* Active Cooldown Banner */}
      {cooldownRemaining > 0 && (
        <div className="px-3 py-1 bg-amber-50 border-t border-amber-200 text-amber-900 text-[11px] flex items-center justify-between animate-fadeIn">
          <div className="flex items-center gap-1.5">
            <Clock className="w-3.5 h-3.5 text-amber-700 animate-pulse shrink-0" />
            <span>
              <strong>Operator Cooldown Active ({cooldownRemaining}s):</strong> Safeguard pacing between human-initiated messages. Review next customer context before dispatch.
            </span>
          </div>
          <button
            type="button"
            onClick={() => setCooldownRemaining(0)}
            className="text-[10px] text-amber-800 underline hover:text-amber-950 font-semibold shrink-0"
          >
            Override
          </button>
        </div>
      )}

      {/* Composer */}
      <form onSubmit={handleSend} className="p-3 bg-white border-t border-gray-200 flex items-center gap-2">
        <input
          type="file"
          ref={fileInputRef}
          onChange={handleFileUpload}
          className="hidden"
          accept=".pdf,.doc,.docx,.jpg,.jpeg,.png"
        />

        <button
          type="button"
          onClick={() => fileInputRef.current?.click()}
          disabled={uploadingAttachment || sending}
          className="p-2 rounded-full hover:bg-gray-100 text-gray-500 transition disabled:opacity-50"
          title="Attach Document or Image (Stored safely in ERP)"
        >
          {uploadingAttachment ? (
            <Loader className="w-4 h-4 animate-spin text-emerald-600" />
          ) : (
            <Paperclip className="w-4 h-4" />
          )}
        </button>

        <textarea
          rows={1}
          value={inputText}
          onChange={(e) => setInputText(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter' && !e.shiftKey) {
              e.preventDefault();
              handleSend(e);
            }
          }}
          placeholder="Type a message (Enter to send, Shift+Enter for newline)..."
          className="flex-1 bg-gray-50 border border-gray-200 rounded-lg px-3 py-2 text-xs text-gray-900 focus:outline-none focus:border-emerald-500 focus:bg-white resize-none transition"
        />

        <button
          type="submit"
          disabled={!inputText.trim() || sending || cooldownRemaining > 0}
          className={`h-8 px-2.5 rounded-full text-white flex items-center justify-center transition shadow-sm ${
            cooldownRemaining > 0
              ? 'bg-amber-600 hover:bg-amber-700 cursor-not-allowed opacity-90'
              : 'bg-emerald-600 hover:bg-emerald-700 disabled:opacity-50'
          }`}
          title={cooldownRemaining > 0 ? `Cooldown active (${cooldownRemaining}s)` : 'Send WhatsApp Message'}
        >
          {sending ? (
            <Loader className="w-3.5 h-3.5 animate-spin" />
          ) : cooldownRemaining > 0 ? (
            <span className="flex items-center gap-1 text-[11px] font-bold">
              <Clock className="w-3 h-3 animate-pulse" />
              <span>{cooldownRemaining}s</span>
            </span>
          ) : (
            <Send className="w-3.5 h-3.5" />
          )}
        </button>
      </form>
    </div>
  );
}
