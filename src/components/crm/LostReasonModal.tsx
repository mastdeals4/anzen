import { useState } from 'react';
import { Modal } from '../Modal';
import { supabase } from '../../lib/supabase';
import { XCircle } from 'lucide-react';
import { MoneyInput } from '../MoneyInput';

export const STRUCTURED_LOST_REASONS = [
  { code: 'PRICE_TOO_HIGH', label: 'Price Too High' },
  { code: 'OUT_OF_STOCK', label: 'Out of Stock / Unavailable' },
  { code: 'SPEC_MISMATCH', label: 'Specification / Grade Mismatch' },
  { code: 'CUSTOMER_CANCELLED', label: 'Customer Cancelled / Project Dropped' },
  { code: 'PAYMENT_TERMS', label: 'Payment Terms Unacceptable' },
  { code: 'DELIVERY_TIMING', label: 'Delivery Timing / Lead Time Too Long' },
  { code: 'COMPETITOR', label: 'Lost to Competitor' },
  { code: 'DUPLICATE', label: 'Duplicate Inquiry' },
  { code: 'OTHER', label: 'Other Reason' },
] as const;

export type LostReasonCode = typeof STRUCTURED_LOST_REASONS[number]['code'];

interface LostReasonModalProps {
  isOpen: boolean;
  onClose: () => void;
  inquiryId: string;
  inquiryNumber: string;
  onSuccess: () => void;
}

export function LostReasonModal({
  isOpen,
  onClose,
  inquiryId,
  inquiryNumber,
  onSuccess,
}: LostReasonModalProps) {
  const [lostReasonCode, setLostReasonCode] = useState<string>('');
  const [lostNotes, setLostNotes] = useState('');
  const [competitorName, setCompetitorName] = useState('');
  const [competitorPrice, setCompetitorPrice] = useState('');
  const [saving, setSaving] = useState(false);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();

    if (!lostReasonCode) {
      alert('Please select a primary lost reason');
      return;
    }

    setSaving(true);

    try {
      const selectedOption = STRUCTURED_LOST_REASONS.find(r => r.code === lostReasonCode);
      const label = selectedOption ? selectedOption.label : lostReasonCode;
      const formattedReason = lostNotes.trim() ? `${label} — ${lostNotes.trim()}` : label;

      const updateData: Record<string, unknown> = {
        pipeline_status: 'lost',
        lost_reason: formattedReason,
        lost_reason_code: lostReasonCode,
        lost_at: new Date().toISOString(),
      };

      if (competitorName.trim()) {
        updateData.competitor_name = competitorName.trim();
      }

      if (competitorPrice.trim()) {
        updateData.competitor_price = parseFloat(competitorPrice);
      }

      const { error } = await supabase
        .from('crm_inquiries')
        .update(updateData)
        .eq('id', inquiryId);

      if (error) throw error;

      onSuccess();
      onClose();
      resetForm();
    } catch (error) {
      console.error('Error marking inquiry as lost:', error);
      alert('Failed to mark inquiry as lost. Please try again.');
    } finally {
      setSaving(false);
    }
  };

  const resetForm = () => {
    setLostReasonCode('');
    setLostNotes('');
    setCompetitorName('');
    setCompetitorPrice('');
  };

  const handleClose = () => {
    if (!saving) {
      onClose();
      resetForm();
    }
  };

  return (
    <Modal isOpen={isOpen} onClose={handleClose} title={`Mark Inquiry #${inquiryNumber} as Lost`}>
      <form onSubmit={handleSubmit} className="space-y-4">
        <div className="bg-red-50 border border-red-200 rounded-lg p-3.5 flex items-start gap-3">
          <XCircle className="w-5 h-5 text-red-600 flex-shrink-0 mt-0.5" />
          <div className="text-sm text-red-800">
            <p className="font-semibold">You are about to mark this inquiry as lost.</p>
            <p className="mt-0.5 text-xs text-red-700">
              Select the primary business reason below. This updates CRM analytics and archives the inquiry.
            </p>
          </div>
        </div>

        <div>
          <label className="block text-sm font-semibold text-gray-800 mb-1">
            Primary Lost Reason <span className="text-red-600">*</span>
          </label>
          <select
            name="lost_reason_code"
            aria-label="Lost Reason Code"
            value={lostReasonCode}
            onChange={(e) => setLostReasonCode(e.target.value)}
            required
            className="w-full px-3 py-2 border border-gray-300 rounded-lg focus:ring-2 focus:ring-blue-500 focus:border-blue-500 text-sm font-medium text-gray-900 bg-white"
          >
            <option value="">-- Select Primary Reason --</option>
            {STRUCTURED_LOST_REASONS.map(r => (
              <option key={r.code} value={r.code}>
                {r.label}
              </option>
            ))}
          </select>
        </div>

        <div>
          <label className="block text-sm font-medium text-gray-700 mb-1">
            Additional Notes / Customer Feedback <span className="text-gray-400 font-normal">(optional)</span>
          </label>
          <textarea
            name="lost_notes"
            aria-label="Additional Notes / Customer Feedback"
            value={lostNotes}
            onChange={(e) => setLostNotes(e.target.value)}
            placeholder="e.g., Customer target price was Rp 195k/kg, or project postponed to Q4..."
            rows={3}
            className="w-full px-3 py-2 border border-gray-300 rounded-lg focus:ring-2 focus:ring-blue-500 focus:border-transparent text-sm"
          />
        </div>

        {(lostReasonCode === 'COMPETITOR' || lostReasonCode === 'PRICE_TOO_HIGH') && (
          <div className="p-3 bg-amber-50/60 border border-amber-200 rounded-lg space-y-3">
            <div className="text-xs font-semibold text-amber-900 uppercase tracking-wide">
              Competitor Intelligence (Optional)
            </div>
            <div>
              <label className="block text-xs font-medium text-gray-700 mb-1">
                Competitor Name
              </label>
              <input
                name="competitor_name"
                aria-label="e.g., ABC Trading Co."
                type="text"
                value={competitorName}
                onChange={(e) => setCompetitorName(e.target.value)}
                placeholder="e.g., ABC Trading Co."
                className="w-full px-3 py-1.5 border border-gray-300 rounded-md focus:ring-2 focus:ring-blue-500 focus:border-transparent text-sm"
              />
            </div>

            <div>
              <label className="block text-xs font-medium text-gray-700 mb-1">
                Competitor Offered Price (USD)
              </label>
              <MoneyInput
                value={Number(competitorPrice) || 0}
                onChange={(amount) => setCompetitorPrice(String(amount))}
                placeholder="0.00"
                className="w-full px-3 py-1.5 border border-gray-300 rounded-md focus:ring-2 focus:ring-blue-500 focus:border-transparent text-sm"
                maximumFractionDigits={4}
              />
            </div>
          </div>
        )}

        <div className="flex justify-end gap-3 pt-3 border-t">
          <button
            type="button"
            onClick={handleClose}
            disabled={saving}
            className="px-4 py-2 text-sm text-gray-700 bg-white border border-gray-300 rounded-lg hover:bg-gray-50 disabled:opacity-50"
          >
            Cancel
          </button>
          <button
            type="submit"
            disabled={saving || !lostReasonCode}
            className="px-4 py-2 text-sm bg-red-600 text-white rounded-lg hover:bg-red-700 disabled:opacity-50 disabled:cursor-not-allowed flex items-center gap-2 font-medium shadow-sm transition"
          >
            {saving ? (
              <>
                <div className="w-4 h-4 border-2 border-white border-t-transparent rounded-full animate-spin" />
                Saving...
              </>
            ) : (
              <>
                <XCircle className="w-4 h-4" />
                Confirm & Mark Lost
              </>
            )}
          </button>
        </div>
      </form>
    </Modal>
  );
}
