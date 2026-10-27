import React, { useState, useEffect } from 'react';
import { Modal } from '../../Modal';
import { useAuth } from '../../../contexts/AuthContext';
import { EnquiryRequestService } from '../../../services/enquiry/EnquiryRequestService';
import { EnquiryRequestGridItem, EnquiryRequestStatus, WaitingForParty } from '../../../types/enquiry';
import { showToast } from '../../ToastNotification';
import { Loader2 } from 'lucide-react';
import { FloatingField, FLOAT_INPUT, FLOAT_TEXTAREA } from '../../finance/FloatingField';
import { SapRow } from '../../finance/SapLayout';

interface EditRequestRequirementModalProps {
  isOpen: boolean;
  onClose: () => void;
  onSuccess: () => void;
  request: EnquiryRequestGridItem;
}

export const EditRequestRequirementModal: React.FC<EditRequestRequirementModalProps> = ({
  isOpen,
  onClose,
  onSuccess,
  request,
}) => {
  const { user } = useAuth();
  const [loading, setLoading] = useState(false);
  const [newRequirement, setNewRequirement] = useState('');
  const [reason, setReason] = useState('');
  const [newStatus, setNewStatus] = useState<EnquiryRequestStatus>('IN_PROGRESS');
  const [newWaitingFor, setNewWaitingFor] = useState<WaitingForParty>('CUSTOMER');

  useEffect(() => {
    if (isOpen) {
      setNewRequirement(request.customer_requirement || '');
      setReason('');
      setNewStatus(request.status || 'IN_PROGRESS');
      setNewWaitingFor((request.waiting_for as WaitingForParty) || 'CUSTOMER');
    }
  }, [isOpen, request]);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!newRequirement.trim()) {
      showToast({ title: 'Validation', message: 'Requirement text cannot be empty', type: 'error' });
      return;
    }

    try {
      setLoading(true);
      await EnquiryRequestService.changeRequirement({
        request_id: request.id,
        new_requirement: newRequirement.trim(),
        reason: reason.trim() || undefined,
        summary: `Requirement updated from "${request.customer_requirement}" to "${newRequirement.trim()}"`,
        status: newStatus,
        waiting_for: newWaitingFor,
        actor: {
          actor_type: 'user',
          actor_id: user?.id || null,
        },
      });

      showToast({
        title: 'Requirement Updated',
        message: `Auditable change recorded for request ${request.request_code}.`,
        type: 'success',
      });
      onSuccess();
      onClose();
    } catch (err: any) {
      console.error('[EditRequestRequirementModal] Error changing requirement:', err);
      showToast({
        title: 'Update Failed',
        message: err.message || 'Failed to update requirement',
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
      title={`Evolve Requirement: ${request.request_code}`}
      size="md"
    >
      <form onSubmit={handleSubmit} className="space-y-4 text-xs">
        <div className="bg-amber-50 border border-amber-200 rounded-lg p-3 text-amber-900 space-y-1">
          <div className="font-semibold">Audited Requirement Evolution</div>
          <p className="text-[11px] text-amber-800">
            Current: <span className="font-medium">{request.customer_requirement}</span>
          </p>
          <p className="text-[10px] text-amber-700">
            Historical requirements remain immutable in the enquiry event log.
          </p>
        </div>

        <SapRow>
          <FloatingField label="New Customer Requirement" required textarea filled={!!newRequirement.trim()} span={12}>
            <textarea name="requirement" aria-label="e.g. 500 KG — 660 mesh (customer approved alternative)"
              value={newRequirement}
              onChange={e => setNewRequirement(e.target.value)}
              rows={3}
              className={FLOAT_TEXTAREA}
              placeholder="e.g. 500 KG — 660 mesh (customer approved alternative)"
              required
            />
          </FloatingField>
        </SapRow>

        <SapRow>
          <FloatingField label="Reason for Change / Context" filled={!!reason.trim()} span={12}>
            <input name="reason_for_change_context" aria-label="Reason for Change / Context"
              type="text"
              value={reason}
              onChange={e => setReason(e.target.value)}
              className={FLOAT_INPUT}
              placeholder="e.g. Manufacturer confirmed 100 mesh unavailable; customer accepted 660 mesh"
            />
          </FloatingField>
        </SapRow>

        <SapRow>
          <FloatingField label="Updated Status" filled={!!newStatus} span={6}>
            <select name="updated_status" aria-label="Updated Status"
              value={newStatus}
              onChange={e => setNewStatus(e.target.value as any)}
              className={FLOAT_INPUT}
            >
              <option value="OPEN">OPEN</option>
              <option value="IN_PROGRESS">IN_PROGRESS</option>
              <option value="BLOCKED">BLOCKED</option>
            </select>
          </FloatingField>

          <FloatingField label="Waiting For" filled={!!newWaitingFor} span={6}>
            <select name="waiting_for" aria-label="Waiting For"
              value={newWaitingFor}
              onChange={e => setNewWaitingFor(e.target.value as any)}
              className={FLOAT_INPUT}
            >
              <option value="CUSTOMER">CUSTOMER</option>
              <option value="INDIA">INDIA</option>
              <option value="MANUFACTURER">MANUFACTURER</option>
              <option value="INTERNAL">INTERNAL</option>
              <option value="NONE">NONE</option>
            </select>
          </FloatingField>
        </SapRow>

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
            className="inline-flex items-center gap-1.5 px-4 py-1.5 rounded-md bg-amber-600 hover:bg-amber-700 text-white font-semibold shadow-xs cursor-pointer disabled:opacity-50"
          >
            {loading ? <Loader2 className="w-4 h-4 animate-spin" /> : null}
            <span>Record Change</span>
          </button>
        </div>
      </form>
    </Modal>
  );
};
