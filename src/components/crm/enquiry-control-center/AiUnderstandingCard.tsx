import React, { useState } from 'react';
import {
  Bot,
  CheckCircle2,
  Edit3,
  XCircle,
  AlertTriangle,
  ArrowRight,
  Quote,
  ShieldAlert,
  Loader2,
  Mail,
  MessageSquare,
} from 'lucide-react';
import { AiProposal } from '../../../types/enquiry';
import { EnquiryBrainService } from '../../../services/enquiry/EnquiryBrainService';
import { EditAiProposalModal } from './EditAiProposalModal';

interface AiUnderstandingCardProps {
  proposal: AiProposal;
  messageId: string;
  inquiryId: string;
  channel?: string;
  senderAddress?: string;
  senderName?: string;
  onRefresh: () => void;
}

export const AiUnderstandingCard: React.FC<AiUnderstandingCardProps> = ({
  proposal,
  messageId,
  inquiryId,
  channel = 'email',
  senderAddress,
  senderName,
  onRefresh,
}) => {
  const [acting, setActing] = useState(false);
  const [showEditModal, setShowEditModal] = useState(false);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);

  // Confidence styling
  const isHigh = proposal.confidence_tier === 'HIGH';
  const isMedium = proposal.confidence_tier === 'MEDIUM';
  const isLow = proposal.confidence_tier === 'LOW' || proposal.needs_verification;

  const confidenceBadge = isHigh ? (
    <span className="inline-flex items-center px-2 py-0.5 rounded text-[11px] font-semibold bg-emerald-100 text-emerald-800 border border-emerald-300">
      Grounded in message
    </span>
  ) : isMedium ? (
    <span className="inline-flex items-center px-2 py-0.5 rounded text-[11px] font-semibold bg-amber-100 text-amber-800 border border-amber-300">
      Inferred from thread context
    </span>
  ) : (
    <span className="inline-flex items-center px-2 py-0.5 rounded text-[11px] font-semibold bg-rose-100 text-rose-800 border border-rose-300">
      Needs verification
    </span>
  );

  // Extract requirement diff if present
  const reqUpdate = proposal.proposed_updates?.find((u) => u.field === 'customer_requirement');
  const statusUpdate = proposal.proposed_updates?.find((u) => u.field === 'status');
  const waitingUpdate = proposal.proposed_updates?.find((u) => u.field === 'waiting_for');

  const handleAccept = async () => {
    if (acting) return;
    if (isLow) {
      const confirmed = window.confirm(
        'This AI proposal has LOW confidence or ambiguous text. We recommend reviewing via [Edit] first. Proceed with Accept anyway?'
      );
      if (!confirmed) return;
    }

    try {
      setActing(true);
      setErrorMessage(null);
      const res = await EnquiryBrainService.acceptProposal(messageId, proposal, inquiryId);
      if (!res.success) {
        setErrorMessage(res.error || 'Failed to accept proposal.');
        return;
      }
      onRefresh();
    } catch (err: any) {
      setErrorMessage(err.message || 'Unexpected error accepting proposal.');
    } finally {
      setActing(false);
    }
  };

  const handleDismiss = async () => {
    if (acting) return;
    try {
      setActing(true);
      setErrorMessage(null);
      const res = await EnquiryBrainService.dismissProposal(messageId, proposal);
      if (!res.success) {
        setErrorMessage(res.error || 'Failed to dismiss proposal.');
        return;
      }
      onRefresh();
    } catch (err: any) {
      setErrorMessage(err.message || 'Unexpected error dismissing proposal.');
    } finally {
      setActing(false);
    }
  };

  const handleSaveEdit = async (editedValues: any) => {
    const res = await EnquiryBrainService.editProposal(messageId, proposal, editedValues, inquiryId);
    if (!res.success) {
      throw new Error(res.error || 'Failed to apply edited proposal.');
    }
    onRefresh();
  };

  return (
    <div className="bg-gradient-to-br from-blue-50/70 via-indigo-50/40 to-white border-2 border-blue-200 rounded-lg p-3.5 space-y-3 shadow-sm text-xs">
      {/* Header */}
      <div className="flex items-center justify-between border-b border-blue-100 pb-2">
        <div className="flex items-center gap-1.5 font-bold text-blue-900 text-xs uppercase tracking-wider">
          <Bot className="w-4 h-4 text-blue-600 shrink-0" />
          <span>AI UNDERSTANDING</span>
        </div>
        <div className="flex items-center gap-2">
          {confidenceBadge}
          <span className="flex items-center gap-1 text-[11px] text-gray-500 bg-white px-1.5 py-0.5 rounded border border-gray-200">
            {channel === 'email' ? <Mail className="w-3 h-3 text-gray-400" /> : <MessageSquare className="w-3 h-3 text-emerald-500" />}
            <span>{senderName || senderAddress || channel}</span>
          </span>
        </div>
      </div>

      {/* Error / Stale Notice */}
      {errorMessage && (
        <div className="p-2.5 bg-rose-50 border border-rose-300 rounded text-rose-800 text-xs flex items-start gap-2">
          <ShieldAlert className="w-4 h-4 text-rose-600 shrink-0 mt-0.5" />
          <div>
            <span className="font-semibold block">Cannot Apply Suggestion:</span>
            <span>{errorMessage}</span>
          </div>
        </div>
      )}

      {/* Summary */}
      <div className="text-gray-900 font-medium text-xs leading-relaxed">
        {proposal.summary}
      </div>

      {/* Grounding Quotes */}
      {proposal.grounding && proposal.grounding.length > 0 && (
        <div className="bg-white/80 border border-blue-100 rounded p-2.5 space-y-1 text-xs">
          <div className="text-[10px] uppercase font-semibold text-gray-400 flex items-center gap-1">
            <Quote className="w-3 h-3 text-blue-400" />
            <span>Grounded in message</span>
          </div>
          {proposal.grounding.map((g, idx) => (
            <div key={idx} className="space-y-0.5">
              <div className="font-mono text-gray-800 italic bg-gray-50 px-2 py-1 rounded border border-gray-100">
                "{g.text}"
              </div>
              {g.reason && <div className="text-[11px] text-gray-500 pl-1">— {g.reason}</div>}
            </div>
          ))}
        </div>
      )}

      {/* Requirement Evolution Diff */}
      {Boolean(reqUpdate && reqUpdate.old_value && reqUpdate.new_value) && (
        <div className="bg-white border border-blue-200 rounded p-2.5 space-y-1 text-xs">
          <span className="text-[10px] uppercase font-bold text-gray-500 block">Requirement Evolution</span>
          <div className="flex items-center gap-2 font-mono">
            <span className="px-2 py-0.5 rounded bg-rose-50 text-rose-700 border border-rose-200 line-through text-[11px]">
              {String(reqUpdate?.old_value)}
            </span>
            <ArrowRight className="w-3.5 h-3.5 text-blue-500 shrink-0" />
            <span className="px-2 py-0.5 rounded bg-emerald-50 text-emerald-800 border border-emerald-200 font-bold text-[11px]">
              {String(reqUpdate?.new_value)}
            </span>
          </div>
        </div>
      )}

      {/* Proposed State Transitions & Next Actions */}
      <div className="grid grid-cols-2 gap-2 text-[11px] pt-1">
        {statusUpdate && (
          <div className="bg-white/60 p-1.5 rounded border border-gray-100">
            <span className="text-gray-400 block text-[10px] uppercase">Status</span>
            <span className="font-semibold text-gray-800">
              {String(statusUpdate.old_value || 'OPEN')} → {String(statusUpdate.new_value)}
            </span>
          </div>
        )}

        {waitingUpdate && (
          <div className="bg-white/60 p-1.5 rounded border border-gray-100">
            <span className="text-gray-400 block text-[10px] uppercase">Waiting For</span>
            <span className="font-semibold text-gray-800">
              {String(waitingUpdate.old_value || 'INTERNAL')} → {String(waitingUpdate.new_value)}
            </span>
          </div>
        )}

        {proposal.suggested_next_action && (
          <div className="col-span-2 bg-white/60 p-1.5 rounded border border-gray-100">
            <span className="text-gray-400 block text-[10px] uppercase">Suggested Next Action</span>
            <span className="font-medium text-gray-900">{proposal.suggested_next_action}</span>
          </div>
        )}
      </div>

      {/* Low Confidence Warning Notice */}
      {isLow && (
        <div className="p-2 bg-amber-50 border border-amber-200 rounded text-amber-800 text-[11px] flex items-center gap-1.5">
          <AlertTriangle className="w-3.5 h-3.5 text-amber-600 shrink-0" />
          <span>Low confidence or ambiguous text. Please click <strong>Edit</strong> to verify before saving.</span>
        </div>
      )}

      {/* Action Buttons */}
      <div className="pt-2 border-t border-blue-100 flex items-center justify-end gap-2">
        <button
          type="button"
          onClick={handleDismiss}
          disabled={acting}
          className="px-2.5 py-1.5 border border-gray-300 text-gray-600 hover:text-gray-800 hover:bg-gray-100 rounded text-xs font-medium cursor-pointer transition disabled:opacity-50"
        >
          Dismiss
        </button>

        <button
          type="button"
          onClick={() => setShowEditModal(true)}
          disabled={acting}
          className="px-2.5 py-1.5 border border-blue-300 text-blue-700 bg-white hover:bg-blue-50 rounded text-xs font-semibold flex items-center gap-1 cursor-pointer transition disabled:opacity-50"
        >
          <Edit3 className="w-3.5 h-3.5" />
          <span>Edit</span>
        </button>

        <button
          type="button"
          onClick={handleAccept}
          disabled={acting}
          className={`px-3 py-1.5 rounded text-xs font-semibold flex items-center gap-1 cursor-pointer transition shadow-2xs text-white ${
            isLow ? 'bg-amber-600 hover:bg-amber-700' : 'bg-emerald-600 hover:bg-emerald-700'
          } disabled:opacity-50`}
        >
          {acting ? (
            <Loader2 className="w-3.5 h-3.5 animate-spin" />
          ) : (
            <CheckCircle2 className="w-3.5 h-3.5" />
          )}
          <span>{acting ? 'Applying...' : 'Accept'}</span>
        </button>
      </div>

      {/* Edit Modal */}
      {showEditModal && (
        <EditAiProposalModal
          proposal={proposal}
          messageId={messageId}
          inquiryId={inquiryId}
          onClose={() => setShowEditModal(false)}
          onSave={handleSaveEdit}
        />
      )}
    </div>
  );
};
