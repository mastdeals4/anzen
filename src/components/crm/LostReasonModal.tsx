import { useState } from 'react';
import { Modal } from '../Modal';
import { supabase } from '../../lib/supabase';
import { XCircle } from 'lucide-react';

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
  const [lostReason, setLostReason] = useState('');
  const [competitorName, setCompetitorName] = useState('');
  const [competitorPrice, setCompetitorPrice] = useState('');
  const [saving, setSaving] = useState(false);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();

    if (lostReason.trim().length < 10) {
      alert('Please provide a detailed reason (at least 10 characters)');
      return;
    }

    setSaving(true);

    try {
      const updateData: any = {
        pipeline_status: 'lost',
        lost_reason: lostReason.trim(),
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
    setLostReason('');
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
        <div className="bg-red-50 border border-red-200 rounded-lg p-4 flex items-start gap-3">
          <XCircle className="w-5 h-5 text-red-600 flex-shrink-0 mt-0.5" />
          <div className="text-sm text-red-800">
            <p className="font-medium">You are about to mark this inquiry as lost.</p>
            <p className="mt-1 text-red-700">This will move it to the Archive. Please provide details below.</p>
          </div>
        </div>

        <div>
          <label className="block text-sm font-medium text-gray-700 mb-1">
            Lost Reason <span className="text-red-600">*</span>
          </label>
          <textarea
            value={lostReason}
            onChange={(e) => setLostReason(e.target.value)}
            placeholder="e.g., Competitor offered lower price, Customer chose local supplier, Budget constraints..."
            rows={4}
            required
            minLength={10}
            className="w-full px-3 py-2 border border-gray-300 rounded-lg focus:ring-2 focus:ring-blue-500 focus:border-transparent"
          />
          <p className="text-xs text-gray-500 mt-1">
            Minimum 10 characters. Be specific to help improve future quotes.
          </p>
        </div>

        <div>
          <label className="block text-sm font-medium text-gray-700 mb-1">
            Competitor Name <span className="text-gray-400">(optional)</span>
          </label>
          <input
            type="text"
            value={competitorName}
            onChange={(e) => setCompetitorName(e.target.value)}
            placeholder="e.g., ABC Trading Co."
            className="w-full px-3 py-2 border border-gray-300 rounded-lg focus:ring-2 focus:ring-blue-500 focus:border-transparent"
          />
        </div>

        <div>
          <label className="block text-sm font-medium text-gray-700 mb-1">
            Competitor Price (USD) <span className="text-gray-400">(optional)</span>
          </label>
          <input
            type="number"
            step="0.01"
            value={competitorPrice}
            onChange={(e) => setCompetitorPrice(e.target.value)}
            placeholder="0.00"
            className="w-full px-3 py-2 border border-gray-300 rounded-lg focus:ring-2 focus:ring-blue-500 focus:border-transparent"
          />
        </div>

        <div className="flex justify-end gap-3 pt-4 border-t">
          <button
            type="button"
            onClick={handleClose}
            disabled={saving}
            className="px-4 py-2 text-gray-700 bg-white border border-gray-300 rounded-lg hover:bg-gray-50 disabled:opacity-50"
          >
            Cancel
          </button>
          <button
            type="submit"
            disabled={saving || lostReason.trim().length < 10}
            className="px-4 py-2 bg-red-600 text-white rounded-lg hover:bg-red-700 disabled:opacity-50 disabled:cursor-not-allowed flex items-center gap-2"
          >
            {saving ? (
              <>
                <div className="w-4 h-4 border-2 border-white border-t-transparent rounded-full animate-spin" />
                Saving...
              </>
            ) : (
              <>
                <XCircle className="w-4 h-4" />
                Mark as Lost
              </>
            )}
          </button>
        </div>
      </form>
    </Modal>
  );
}
