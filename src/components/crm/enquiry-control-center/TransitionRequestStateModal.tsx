import React, { useState, useEffect } from 'react';
import { Modal } from '../../Modal';
import { useAuth } from '../../../contexts/AuthContext';
import { EnquiryRequestService } from '../../../services/enquiry/EnquiryRequestService';
import { EnquiryRequestGridItem, EnquiryRequestStatus, WaitingForParty } from '../../../types/enquiry';
import { showToast } from '../../ToastNotification';
import { Loader2, CheckCircle, AlertTriangle, XCircle, ArrowRight } from 'lucide-react';

interface TransitionRequestStateModalProps {
  isOpen: boolean;
  onClose: () => void;
  onSuccess: () => void;
  request: EnquiryRequestGridItem;
}

export const TransitionRequestStateModal: React.FC<TransitionRequestStateModalProps> = ({
  isOpen,
  onClose,
  onSuccess,
  request,
}) => {
  const { user } = useAuth();
  const [loading, setLoading] = useState(false);
  const [status, setStatus] = useState<EnquiryRequestStatus>('IN_PROGRESS');
  const [waitingFor, setWaitingFor] = useState<WaitingForParty>('INTERNAL');
  const [currentIssue, setCurrentIssue] = useState('');
  const [nextAction, setNextAction] = useState('');
  const [responseText, setResponseText] = useState('');
  const [cancelReason, setCancelReason] = useState('');

  useEffect(() => {
    if (isOpen) {
      setStatus(request.status || 'IN_PROGRESS');
      setWaitingFor((request.waiting_for as WaitingForParty) || 'INTERNAL');
      setCurrentIssue(request.current_issue || '');
      setNextAction(request.next_action || '');
      setResponseText('');
      setCancelReason('');
    }
  }, [isOpen, request]);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();

    // Validations based on business domain
    if (status === 'BLOCKED') {
      if (!currentIssue.trim()) {
        showToast({ title: 'Validation', message: 'Current blocker description is required when status is BLOCKED', type: 'error' });
        return;
      }
      if (waitingFor === 'NONE') {
        showToast({ title: 'Validation', message: 'BLOCKED request cannot have Waiting For = NONE', type: 'error' });
        return;
      }
    }

    if (status === 'RESOLVED' && !responseText.trim()) {
      showToast({ title: 'Validation', message: 'Resolution details / satisfied requirement response is required to resolve', type: 'error' });
      return;
    }

    if (status === 'CANCELLED' && !cancelReason.trim()) {
      showToast({ title: 'Validation', message: 'Cancellation reason is required', type: 'error' });
      return;
    }

    try {
      setLoading(true);

      if (status === 'RESOLVED') {
        // Business requirement satisfied explicitly
        await EnquiryRequestService.resolveRequest({
          request_id: request.id,
          response_text: responseText.trim(),
          actor: {
            actor_type: 'user',
            actor_id: user?.id || null,
          },
        });
      } else if (status === 'CANCELLED') {
        await EnquiryRequestService.cancelRequest({
          request_id: request.id,
          cancellation_reason: cancelReason.trim(),
          actor: {
            actor_type: 'user',
            actor_id: user?.id || null,
          },
        });
      } else {
        await EnquiryRequestService.transitionState({
          request_id: request.id,
          event_type: 'status_changed',
          new_status: status,
          new_waiting_for: waitingFor,
          current_issue: currentIssue.trim() || null,
          next_action: nextAction.trim() || null,
          summary: `Status updated to ${status}, waiting for ${waitingFor}`,
          actor: {
            actor_type: 'user',
            actor_id: user?.id || null,
          },
        });
      }

      showToast({
        title: 'Request Updated',
        message: `State change for request ${request.request_code} recorded successfully.`,
        type: 'success',
      });
      onSuccess();
      onClose();
    } catch (err: any) {
      console.error('[TransitionRequestStateModal] Error transitioning state:', err);
      showToast({
        title: 'Update Failed',
        message: err.message || 'Failed to update request status',
        type: 'error',
      });
    } finally {
      setLoading(false);
    }
  };

  return (
    <Modal
      isOpen={isOpen}
      onClose={onClose}
      title={`Update Request State: ${request.request_code}`}
      size="md"
    >
      <form onSubmit={handleSubmit} className="space-y-4 text-xs">
        <div className="bg-gray-50 border border-gray-200 rounded-lg p-3 space-y-1">
          <div className="font-semibold text-gray-900 flex items-center justify-between">
            <span>{request.title}</span>
            <span className="uppercase text-[10px] text-gray-500 font-bold">{request.category}</span>
          </div>
          <p className="text-gray-600 text-[11px]">{request.customer_requirement}</p>
        </div>

        {/* Status Selection */}
        <div>
          <label className="block text-xs font-semibold text-gray-700 mb-1">
            Request Status <span className="text-rose-500">*</span>
          </label>
          <select name="status" aria-label="Status"
            value={status}
            onChange={e => setStatus(e.target.value as any)}
            className="w-full px-3 py-1.5 border border-gray-300 rounded-md text-xs bg-white font-medium focus:ring-2 focus:ring-blue-500"
          >
            <option value="OPEN">OPEN (Active requirement)</option>
            <option value="IN_PROGRESS">IN_PROGRESS (Under investigation / execution)</option>
            <option value="BLOCKED">BLOCKED (Halted by external or technical impediment)</option>
            <option value="RESOLVED">RESOLVED (Requirement successfully satisfied)</option>
            <option value="CANCELLED">CANCELLED (Requirement withdrawn or not needed)</option>
          </select>
        </div>

        {/* Conditional Fields based on status */}
        {status === 'BLOCKED' && (
          <div className="bg-rose-50 border border-rose-200 rounded-lg p-3 space-y-3 text-rose-900">
            <div className="flex items-center gap-1.5 font-semibold text-rose-800">
              <AlertTriangle className="w-4 h-4 text-rose-600" />
              <span>Blocker Information (Elevated to Control Center Table)</span>
            </div>
            <div>
              <label className="block text-xs font-semibold text-rose-900 mb-1">
                Current Operational Blocker / Issue <span className="text-rose-600">*</span>
              </label>
              <textarea name="issue" aria-label="e.g. 100 mesh unavailable; manufacturer offers 660 mesh only"
                value={currentIssue}
                onChange={e => setCurrentIssue(e.target.value)}
                rows={2}
                placeholder="e.g. 100 mesh unavailable; manufacturer offers 660 mesh only"
                className="w-full px-3 py-1.5 border border-rose-300 rounded-md text-xs bg-white text-gray-900 focus:ring-2 focus:ring-rose-500"
                required
              />
            </div>
          </div>
        )}

        {status === 'RESOLVED' && (
          <div className="bg-emerald-50 border border-emerald-200 rounded-lg p-3 space-y-3 text-emerald-900">
            <div className="flex items-center gap-1.5 font-semibold text-emerald-800">
              <CheckCircle className="w-4 h-4 text-emerald-600" />
              <span>Business Requirement Resolution</span>
            </div>
            <div>
              <label className="block text-xs font-semibold text-emerald-900 mb-1">
                Resolution Details / Deliverable <span className="text-emerald-600">*</span>
              </label>
              <textarea name="response_text" aria-label="e.g. COA provided from manufacturer and confirmed compliant with USP specifications."
                value={responseText}
                onChange={e => setResponseText(e.target.value)}
                rows={2}
                placeholder="e.g. COA provided from manufacturer and confirmed compliant with USP specifications."
                className="w-full px-3 py-1.5 border border-emerald-300 rounded-md text-xs bg-white text-gray-900 focus:ring-2 focus:ring-emerald-500"
                required
              />
            </div>
          </div>
        )}

        {status === 'CANCELLED' && (
          <div className="bg-gray-50 border border-gray-200 rounded-lg p-3 space-y-2 text-gray-900">
            <div className="flex items-center gap-1.5 font-semibold text-gray-800">
              <XCircle className="w-4 h-4 text-gray-500" />
              <span>Cancellation Details</span>
            </div>
            <div>
              <label className="block text-xs font-semibold text-gray-700 mb-1">
                Cancellation Reason <span className="text-rose-500">*</span>
              </label>
              <input name="cancel_reason" aria-label="e.g. Customer cancelled inquiry; or sample no longer requested"
                type="text"
                value={cancelReason}
                onChange={e => setCancelReason(e.target.value)}
                placeholder="e.g. Customer cancelled inquiry; or sample no longer requested"
                className="w-full px-3 py-1.5 border border-gray-300 rounded-md text-xs bg-white focus:ring-2 focus:ring-blue-500"
                required
              />
            </div>
          </div>
        )}

        {status !== 'RESOLVED' && status !== 'CANCELLED' && (
          <>
            {/* Waiting For */}
            <div>
              <label className="block text-xs font-semibold text-gray-700 mb-1">Waiting For</label>
              <select name="waiting_for" aria-label="Waiting For"
                value={waitingFor}
                onChange={e => setWaitingFor(e.target.value as any)}
                className="w-full px-2.5 py-1.5 border border-gray-300 rounded-md text-xs bg-white focus:ring-2 focus:ring-blue-500"
              >
                <option value="CUSTOMER">CUSTOMER (Awaiting customer input / approval)</option>
                <option value="INDIA">INDIA (Awaiting India sourcing / pricing)</option>
                <option value="MANUFACTURER">MANUFACTURER (Awaiting factory sample / COA / answer)</option>
                <option value="INTERNAL">INTERNAL (Pending staff action)</option>
                <option value="NONE">NONE</option>
              </select>
            </div>

            {/* Next Action */}
            <div>
              <label className="block text-xs font-semibold text-gray-700 mb-1">Next Action</label>
              <input name="next_action" aria-label="Next Action"
                type="text"
                value={nextAction}
                onChange={e => setNextAction(e.target.value)}
                placeholder="e.g. Sales to confirm sample delivery address"
                className="w-full px-3 py-1.5 border border-gray-300 rounded-md text-xs focus:ring-2 focus:ring-blue-500"
              />
            </div>
          </>
        )}

        <div className="flex items-center justify-end gap-2 pt-3 border-t border-gray-200">
          <button
            type="button"
            onClick={onClose}
            className="px-3 py-1.5 rounded-md border border-gray-300 text-gray-700 hover:bg-gray-100 font-medium cursor-pointer"
            disabled={loading}
          >
            Cancel
          </button>
          <button
            type="submit"
            disabled={loading}
            className="inline-flex items-center gap-1.5 px-4 py-1.5 rounded-md bg-blue-600 hover:bg-blue-700 text-white font-semibold shadow-xs cursor-pointer disabled:opacity-50"
          >
            {loading ? <Loader2 className="w-4 h-4 animate-spin" /> : null}
            <span>Save State</span>
          </button>
        </div>
      </form>
    </Modal>
  );
};
