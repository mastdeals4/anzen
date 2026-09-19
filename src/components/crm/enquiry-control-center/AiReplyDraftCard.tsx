import React, { useState } from 'react';
import {
  Sparkles,
  Send,
  Edit2,
  Trash2,
  RefreshCw,
  Check,
  X,
  AlertCircle,
  Copy,
  CheckCheck,
} from 'lucide-react';
import { AiReplyDraft, ReplyDraftType } from '../../../types/enquiry';
import { EnquiryBrainDraftService } from '../../../services/enquiry/EnquiryBrainDraftService';
import { EnquiryWhatsAppService } from '../../../services/enquiry/EnquiryWhatsAppService';

interface AiReplyDraftCardProps {
  messageId: string;
  inquiryId: string;
  inquiryNumber: string;
  senderAddress?: string;
  channel?: string;
  conversationId?: string;
  initialDraft?: AiReplyDraft | null;
  onOpenComposer?: (draft: { to: string; subject: string; body: string }) => void;
  onDraftUpdated?: () => void;
}

const DRAFT_TYPE_LABELS: Record<ReplyDraftType, string> = {
  customer_reply: 'Customer Reply',
  india_internal: 'India Internal Follow-Up',
  supplier_followup: 'Supplier Follow-Up',
};

export const AiReplyDraftCard: React.FC<AiReplyDraftCardProps> = ({
  messageId,
  inquiryId,
  inquiryNumber,
  senderAddress,
  channel,
  conversationId,
  initialDraft,
  onOpenComposer,
  onDraftUpdated,
}) => {
  const [draft, setDraft] = useState<AiReplyDraft | null>(initialDraft || null);
  const [draftType, setDraftType] = useState<ReplyDraftType>(initialDraft?.draft_type || 'customer_reply');
  const [isEditing, setIsEditing] = useState<boolean>(false);
  const [editedBody, setEditedBody] = useState<string>(initialDraft?.body || '');
  const [editedSubject, setEditedSubject] = useState<string>(initialDraft?.subject || '');
  const [loading, setLoading] = useState<boolean>(false);
  const [error, setError] = useState<string | null>(null);
  const [copied, setCopied] = useState<boolean>(false);
  const [showConfirmSendWhatsApp, setShowConfirmSendWhatsApp] = useState<boolean>(false);
  const [sendSuccess, setSendSuccess] = useState<boolean>(false);

  const handleGenerate = async (typeToGenerate?: ReplyDraftType) => {
    setLoading(true);
    setError(null);
    const targetType = typeToGenerate || draftType;

    const res = await EnquiryBrainDraftService.generateReplyDraft({
      message_id: messageId,
      inquiry_id: inquiryId,
      draft_type: targetType,
    });

    if (!res.success || !res.draft) {
      setError(res.error || 'Failed to generate draft');
      setLoading(false);
      return;
    }

    setDraft(res.draft);
    setDraftType(targetType);
    setEditedBody(res.draft.body);
    setEditedSubject(res.draft.subject);
    setIsEditing(false);
    setLoading(false);
    onDraftUpdated?.();
  };

  const handleSaveEdit = async () => {
    if (!draft) return;
    setLoading(true);
    const res = await EnquiryBrainDraftService.updateDraftStatus(messageId, 'edited', {
      edited_body: editedBody,
      edited_subject: editedSubject,
    });
    if (res.success) {
      setDraft({
        ...draft,
        body: editedBody,
        subject: editedSubject,
        is_edited: true,
        status: 'edited',
      });
      setIsEditing(false);
      onDraftUpdated?.();
    } else {
      setError(res.error || 'Failed to save edits');
    }
    setLoading(false);
  };

  const handleDiscard = async () => {
    if (!confirm('Discard this AI draft?')) return;
    setLoading(true);
    await EnquiryBrainDraftService.updateDraftStatus(messageId, 'discarded');
    setDraft(null);
    setIsEditing(false);
    setLoading(false);
    onDraftUpdated?.();
  };

  const handleCopy = () => {
    if (!draft) return;
    navigator.clipboard.writeText(`${draft.subject}\n\n${draft.body}`);
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  };

  const handleSend = () => {
    if (!draft) return;
    if (channel === 'whatsapp') {
      setShowConfirmSendWhatsApp(true);
      return;
    }
    if (onOpenComposer) {
      onOpenComposer({
        to: draft.recipient_address || senderAddress || '',
        subject: draft.subject,
        body: isEditing ? editedBody : draft.body,
      });
    } else {
      handleCopy();
      alert('Draft copied to clipboard! Paste it into the email composer.');
    }
  };

  const handleSendWhatsApp = async () => {
    if (!draft || !conversationId) return;
    setLoading(true);
    setError(null);
    const bodyToSend = isEditing ? editedBody : draft.body;

    const res = await EnquiryWhatsAppService.sendWhatsAppMessage({
      conversationId,
      text: bodyToSend,
      draftMessageId: draft.trigger_message_id,
    });

    if (res.success) {
      setSendSuccess(true);
      setShowConfirmSendWhatsApp(false);
      setDraft({
        ...draft,
        status: 'sent',
        sent_at: new Date().toISOString(),
        sent_message_id: res.messageId,
      });
      onDraftUpdated?.();
    } else {
      setError(res.error || 'Failed to dispatch WhatsApp reply');
    }
    setLoading(false);
  };

  if (!draft) {
    return (
      <div className="bg-purple-50/50 border border-purple-200/80 rounded-lg p-3 text-xs flex items-center justify-between">
        <div className="flex items-center gap-2">
          <Sparkles className="w-4 h-4 text-purple-600" />
          <span className="font-medium text-purple-900">Enquiry Brain Reply Drafter</span>
        </div>
        <div className="flex items-center gap-2">
          <select name="draft_type" aria-label="Draft Type"
            value={draftType}
            onChange={(e) => setDraftType(e.target.value as ReplyDraftType)}
            className="text-[11px] bg-white border border-purple-300 rounded px-2 py-1 text-gray-700"
            disabled={loading}
          >
            <option value="customer_reply">Customer Reply</option>
            <option value="india_internal">India Follow-Up</option>
            <option value="supplier_followup">Supplier Follow-Up</option>
          </select>
          <button
            onClick={() => handleGenerate()}
            disabled={loading}
            className="px-2.5 py-1 bg-purple-600 hover:bg-purple-700 text-white rounded font-medium flex items-center gap-1 cursor-pointer transition-colors"
          >
            {loading ? (
              <RefreshCw className="w-3 h-3 animate-spin" />
            ) : (
              <Sparkles className="w-3 h-3" />
            )}
            <span>Generate Draft</span>
          </button>
        </div>
      </div>
    );
  }

  return (
    <div className="bg-gradient-to-br from-purple-50/60 to-white border border-purple-200 rounded-lg p-3.5 space-y-3 text-xs shadow-2xs">
      {/* Header */}
      <div className="flex items-center justify-between border-b border-purple-100 pb-2">
        <div className="flex items-center gap-2">
          <div className="p-1 rounded bg-purple-100 text-purple-700">
            <Sparkles className="w-3.5 h-3.5" />
          </div>
          <span className="font-semibold text-purple-950">AI DRAFT</span>
          <span className="px-2 py-0.5 rounded-full bg-purple-100 text-purple-800 text-[10px] font-medium uppercase">
            {DRAFT_TYPE_LABELS[draft.draft_type]}
          </span>
          {draft.is_edited && (
            <span className="px-1.5 py-0.5 rounded bg-gray-100 text-gray-600 text-[10px]">
              Edited
            </span>
          )}
        </div>

        <div className="flex items-center gap-1">
          <button
            onClick={() => handleGenerate(draft.draft_type)}
            disabled={loading}
            title="Regenerate draft"
            className="p-1 text-gray-500 hover:text-purple-600 rounded hover:bg-purple-100 transition-colors"
          >
            <RefreshCw className={`w-3.5 h-3.5 ${loading ? 'animate-spin' : ''}`} />
          </button>
          <button
            onClick={handleDiscard}
            disabled={loading}
            title="Discard draft"
            className="p-1 text-gray-500 hover:text-rose-600 rounded hover:bg-rose-50 transition-colors"
          >
            <Trash2 className="w-3.5 h-3.5" />
          </button>
        </div>
      </div>

      {error && (
        <div className="p-2 rounded bg-rose-50 border border-rose-200 text-rose-700 flex items-center gap-1.5 text-[11px]">
          <AlertCircle className="w-3.5 h-3.5 shrink-0" />
          <span>{error}</span>
        </div>
      )}

      {/* Draft Subject & Body */}
      {isEditing ? (
        <div className="space-y-2">
          <div>
            <label className="text-[10px] uppercase tracking-wider text-gray-500 font-semibold block mb-0.5">
              Subject
            </label>
            <input name="subject" aria-label="Subject"
              type="text"
              value={editedSubject}
              onChange={(e) => setEditedSubject(e.target.value)}
              className="w-full text-xs px-2.5 py-1.5 bg-white border border-gray-300 rounded focus:ring-1 focus:ring-purple-500"
            />
          </div>
          <div>
            <label className="text-[10px] uppercase tracking-wider text-gray-500 font-semibold block mb-0.5">
              Body
            </label>
            <textarea name="body" aria-label="Body"
              rows={6}
              value={editedBody}
              onChange={(e) => setEditedBody(e.target.value)}
              className="w-full text-xs px-2.5 py-1.5 bg-white border border-gray-300 rounded font-mono focus:ring-1 focus:ring-purple-500"
            />
          </div>
          <div className="flex justify-end gap-2 pt-1">
            <button
              onClick={() => setIsEditing(false)}
              className="px-2 py-1 text-gray-600 hover:bg-gray-100 rounded"
            >
              Cancel
            </button>
            <button
              onClick={handleSaveEdit}
              className="px-2.5 py-1 bg-purple-600 hover:bg-purple-700 text-white rounded font-medium flex items-center gap-1"
            >
              <Check className="w-3 h-3" />
              <span>Save Edits</span>
            </button>
          </div>
        </div>
      ) : (
        <div className="space-y-2">
          <div>
            <span className="text-[10px] text-gray-400 font-semibold uppercase tracking-wider block">
              Subject
            </span>
            <p className="font-medium text-gray-900">{draft.subject}</p>
          </div>
          <div className="p-2.5 rounded bg-white border border-gray-200 text-gray-800 whitespace-pre-wrap font-sans text-xs leading-relaxed max-h-48 overflow-y-auto">
            {draft.body}
          </div>
        </div>
      )}

      {/* Commercial Safety Notice */}
      <div className="text-[10px] text-gray-400 italic">
        * Non-authoritative draft. Requires human review and sending via composer.
      </div>

      {/* Actions */}
      {!isEditing && (
        <div className="flex items-center justify-between pt-2 border-t border-purple-100">
          <div className="flex items-center gap-2">
            <button
              onClick={() => setIsEditing(true)}
              className="px-2.5 py-1 rounded bg-white border border-gray-300 hover:bg-gray-50 text-gray-700 font-medium flex items-center gap-1 transition-colors"
            >
              <Edit2 className="w-3 h-3 text-gray-500" />
              <span>Edit</span>
            </button>
            <button
              onClick={handleCopy}
              className="px-2.5 py-1 rounded bg-white border border-gray-300 hover:bg-gray-50 text-gray-700 font-medium flex items-center gap-1 transition-colors"
            >
              {copied ? (
                <>
                  <CheckCheck className="w-3 h-3 text-emerald-600" />
                  <span className="text-emerald-700">Copied</span>
                </>
              ) : (
                <>
                  <Copy className="w-3 h-3 text-gray-500" />
                  <span>Copy</span>
                </>
              )}
            </button>
          </div>

          {channel === 'whatsapp' ? (
            <button
              onClick={handleSend}
              disabled={loading || draft.status === 'sent'}
              className="px-3 py-1 bg-emerald-600 hover:bg-emerald-700 text-white rounded font-medium flex items-center gap-1.5 cursor-pointer shadow-xs transition-colors disabled:opacity-50"
            >
              <Send className="w-3 h-3" />
              <span>{draft.status === 'sent' ? 'Sent via WhatsApp' : 'Send via WhatsApp'}</span>
            </button>
          ) : (
            <button
              onClick={handleSend}
              className="px-3 py-1 bg-purple-600 hover:bg-purple-700 text-white rounded font-medium flex items-center gap-1.5 cursor-pointer shadow-xs transition-colors"
            >
              <Send className="w-3 h-3" />
              <span>Send (Review in Composer)</span>
            </button>
          )}
        </div>
      )}

      {/* WhatsApp Outbound Confirmation Box */}
      {showConfirmSendWhatsApp && (
        <div className="p-3 bg-emerald-50/90 border border-emerald-300 rounded-md text-xs space-y-2 mt-2">
          <div className="flex items-center justify-between">
            <span className="font-semibold text-emerald-900 flex items-center gap-1">
              <span>Confirm WhatsApp Dispatch</span>
              <span className="text-[10px] px-1.5 py-0.2 bg-emerald-200 text-emerald-800 rounded font-mono">OpenWA</span>
            </span>
            <button
              onClick={() => setShowConfirmSendWhatsApp(false)}
              className="text-gray-400 hover:text-gray-600"
            >
              <X className="w-3.5 h-3.5" />
            </button>
          </div>
          <div className="text-gray-700 text-[11px]">
            To recipient: <strong className="font-mono text-gray-900">{senderAddress || 'Customer'}</strong>
          </div>
          <div className="p-2 bg-white rounded border border-emerald-200 text-gray-800 text-[11px] whitespace-pre-wrap max-h-32 overflow-y-auto">
            {isEditing ? editedBody : draft.body}
          </div>
          <div className="text-[10px] text-emerald-700 italic">
            * This will send an actual WhatsApp message through the OpenWA staging adapter. Human authorization is logged.
          </div>
          <div className="flex justify-end gap-2 pt-1">
            <button
              onClick={() => setShowConfirmSendWhatsApp(false)}
              disabled={loading}
              className="px-2.5 py-1 text-gray-600 hover:bg-emerald-100 rounded text-xs"
            >
              Cancel
            </button>
            <button
              onClick={handleSendWhatsApp}
              disabled={loading}
              className="px-3 py-1 bg-emerald-600 hover:bg-emerald-700 text-white rounded font-medium flex items-center gap-1 text-xs"
            >
              {loading ? <RefreshCw className="w-3 h-3 animate-spin" /> : <Send className="w-3 h-3" />}
              <span>Authorize & Send Now</span>
            </button>
          </div>
        </div>
      )}

      {/* WhatsApp Sent Success Alert */}
      {sendSuccess && (
        <div className="p-2 rounded bg-emerald-100 border border-emerald-300 text-emerald-800 flex items-center gap-1.5 text-[11px] mt-2">
          <Check className="w-3.5 h-3.5 shrink-0" />
          <span>Message successfully sent via WhatsApp and recorded in canonical conversation!</span>
        </div>
      )}
    </div>
  );
};
