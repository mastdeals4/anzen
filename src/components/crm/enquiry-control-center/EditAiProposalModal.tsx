import React, { useState } from 'react';
import { X, CheckCircle2, AlertCircle, Bot, Save } from 'lucide-react';
import { AiProposal } from '../../../types/enquiry';

interface EditAiProposalModalProps {
  proposal: AiProposal;
  messageId: string;
  inquiryId: string;
  onClose: () => void;
  onSave: (editedValues: {
    target_request_id?: string;
    customer_requirement?: string;
    status?: string;
    waiting_for?: string;
    next_action?: string;
    assigned_team?: string;
    summary?: string;
  }) => Promise<void>;
}

export const EditAiProposalModal: React.FC<EditAiProposalModalProps> = ({
  proposal,
  messageId,
  inquiryId,
  onClose,
  onSave,
}) => {
  const primaryUpdate = proposal.proposed_updates?.[0];
  const [targetRequestId, setTargetRequestId] = useState(primaryUpdate?.request_id || '');
  const [requirement, setRequirement] = useState(
    (primaryUpdate?.field === 'customer_requirement' ? String(primaryUpdate.new_value) : '') ||
    proposal.proposed_new_requests?.[0]?.customer_requirement ||
    ''
  );
  const [status, setStatus] = useState(
    (primaryUpdate?.field === 'status' ? String(primaryUpdate.new_value) : 'OPEN')
  );
  const [waitingFor, setWaitingFor] = useState(
    proposal.suggested_waiting_for ||
    (primaryUpdate?.field === 'waiting_for' ? String(primaryUpdate.new_value) : 'INTERNAL')
  );
  const [nextAction, setNextAction] = useState(
    proposal.suggested_next_action ||
    (primaryUpdate?.field === 'next_action' ? String(primaryUpdate.new_value) : '')
  );
  const [assignedTeam, setAssignedTeam] = useState(
    proposal.suggested_team || 'pricing_india'
  );
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    try {
      setSaving(true);
      setError(null);
      await onSave({
        target_request_id: targetRequestId || undefined,
        customer_requirement: requirement.trim() || undefined,
        status,
        waiting_for: waitingFor,
        next_action: nextAction.trim() || undefined,
        assigned_team: assignedTeam || undefined,
        summary: `Human-Edited: ${proposal.summary}`,
      });
      onClose();
    } catch (err: any) {
      setError(err.message || 'Failed to save edited proposal');
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="fixed inset-0 bg-black/50 z-50 flex items-center justify-center p-4">
      <div className="bg-white rounded-lg shadow-xl w-full max-w-lg overflow-hidden border border-gray-200">
        <div className="flex items-center justify-between p-4 border-b border-gray-200 bg-gray-50">
          <div className="flex items-center gap-2">
            <Bot className="w-5 h-5 text-blue-600" />
            <h3 className="font-semibold text-gray-900 text-sm">Edit AI Suggestion Before Applying</h3>
          </div>
          <button
            type="button"
            onClick={onClose}
            className="text-gray-400 hover:text-gray-600 cursor-pointer"
          >
            <X className="w-5 h-5" />
          </button>
        </div>

        <form onSubmit={handleSubmit} className="p-4 space-y-3.5 text-xs">
          {error && (
            <div className="p-2.5 bg-rose-50 border border-rose-200 rounded text-rose-700 flex items-start gap-2 text-xs">
              <AlertCircle className="w-4 h-4 shrink-0 mt-0.5" />
              <span>{error}</span>
            </div>
          )}

          <div>
            <label className="block font-medium text-gray-700 mb-1">
              Customer Requirement / Specification
            </label>
            <textarea name="customer_requirement_specifica" aria-label="Customer Requirement / Specification"
              value={requirement}
              onChange={(e) => setRequirement(e.target.value)}
              rows={3}
              className="w-full px-2.5 py-1.5 border border-gray-300 rounded focus:ring-1 focus:ring-blue-500 font-mono text-xs"
              placeholder="e.g. Product A 500 KG, standard 660 mesh"
            />
          </div>

          <div className="grid grid-cols-2 gap-3">
            <div>
              <label className="block font-medium text-gray-700 mb-1">Status</label>
              <select name="status" aria-label="Status"
                value={status}
                onChange={(e) => setStatus(e.target.value)}
                className="w-full px-2.5 py-1.5 border border-gray-300 rounded bg-white"
              >
                <option value="OPEN">OPEN</option>
                <option value="IN_PROGRESS">IN_PROGRESS</option>
                <option value="BLOCKED">BLOCKED</option>
                <option value="RESOLVED">RESOLVED</option>
              </select>
            </div>

            <div>
              <label className="block font-medium text-gray-700 mb-1">Waiting For</label>
              <select name="waiting_for" aria-label="Waiting For"
                value={waitingFor}
                onChange={(e) => setWaitingFor(e.target.value)}
                className="w-full px-2.5 py-1.5 border border-gray-300 rounded bg-white"
              >
                <option value="INTERNAL">INTERNAL</option>
                <option value="INDIA">INDIA</option>
                <option value="MANUFACTURER">MANUFACTURER</option>
                <option value="CUSTOMER">CUSTOMER</option>
                <option value="NONE">NONE</option>
              </select>
            </div>
          </div>

          <div>
            <label className="block font-medium text-gray-700 mb-1">Next Action</label>
            <input name="next_action" aria-label="Next Action"
              type="text"
              value={nextAction}
              onChange={(e) => setNextAction(e.target.value)}
              className="w-full px-2.5 py-1.5 border border-gray-300 rounded focus:ring-1 focus:ring-blue-500"
              placeholder="e.g. Obtain supplier price for 660 mesh from India office"
            />
          </div>

          <div>
            <label className="block font-medium text-gray-700 mb-1">Assigned Team</label>
            <select name="assigned_team" aria-label="Assigned Team"
              value={assignedTeam}
              onChange={(e) => setAssignedTeam(e.target.value)}
              className="w-full px-2.5 py-1.5 border border-gray-300 rounded bg-white"
            >
              <option value="sales">Sales</option>
              <option value="pricing_india">Pricing / India Office</option>
              <option value="regulatory">Regulatory</option>
              <option value="sourcing">Sourcing</option>
              <option value="warehouse">Warehouse</option>
              <option value="management">Management</option>
            </select>
          </div>

          <div className="pt-3 border-t border-gray-200 flex items-center justify-end gap-2">
            <button
              type="button"
              onClick={onClose}
              className="px-3 py-1.5 border border-gray-300 text-gray-700 rounded hover:bg-gray-50 cursor-pointer font-medium"
            >
              Cancel
            </button>
            <button
              type="submit"
              disabled={saving}
              className="px-3 py-1.5 bg-blue-600 text-white rounded hover:bg-blue-700 cursor-pointer font-medium flex items-center gap-1.5 disabled:opacity-50"
            >
              <Save className="w-3.5 h-3.5" />
              <span>{saving ? 'Applying...' : 'Save & Apply Changes'}</span>
            </button>
          </div>
        </form>
      </div>
    </div>
  );
};
