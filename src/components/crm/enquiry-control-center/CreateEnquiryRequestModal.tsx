import React, { useState, useEffect } from 'react';
import { Modal } from '../../Modal';
import { useAuth } from '../../../contexts/AuthContext';
import { supabase } from '../../../lib/supabase';
import { EnquiryRequestService } from '../../../services/enquiry/EnquiryRequestService';
import { EnquiryRequestCategory, WaitingForParty } from '../../../types/enquiry/enquiryRequest.types';
import { showToast } from '../../ToastNotification';
import { Loader2 } from 'lucide-react';

interface CreateEnquiryRequestModalProps {
  isOpen: boolean;
  onClose: () => void;
  onSuccess: () => void;
  inquiryId: string;
  inquiryNumber: string;
  existingRequestCount: number;
}

interface UserProfile {
  id: string;
  full_name: string;
  email: string;
}

export const CreateEnquiryRequestModal: React.FC<CreateEnquiryRequestModalProps> = ({
  isOpen,
  onClose,
  onSuccess,
  inquiryId,
  inquiryNumber,
  existingRequestCount,
}) => {
  const { user } = useAuth();
  const [loading, setLoading] = useState(false);
  const [users, setUsers] = useState<UserProfile[]>([]);

  const [category, setCategory] = useState<EnquiryRequestCategory>('technical');
  const [title, setTitle] = useState('');
  const [customerRequirement, setCustomerRequirement] = useState('');
  const [assignedTo, setAssignedTo] = useState<string>('');
  const [waitingFor, setWaitingFor] = useState<WaitingForParty>('INTERNAL');
  const [dueDate, setDueDate] = useState('');

  useEffect(() => {
    if (isOpen) {
      setTitle('');
      setCustomerRequirement('');
      setCategory('technical');
      setWaitingFor('INTERNAL');
      setAssignedTo('');

      const d = new Date();
      d.setDate(d.getDate() + 3);
      setDueDate(d.toISOString().split('T')[0]);

      loadUsers();
    }
  }, [isOpen]);

  const loadUsers = async () => {
    try {
      const { data, error } = await supabase
        .from('user_profiles')
        .select('id, full_name, email')
        .order('full_name');
      if (error) throw error;
      setUsers(data || []);
    } catch (err) {
      console.error('[CreateEnquiryRequestModal] Error loading users:', err);
    }
  };

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!title.trim()) {
      showToast({ title: 'Validation', message: 'Title is required', type: 'error' });
      return;
    }
    if (!customerRequirement.trim()) {
      showToast({ title: 'Validation', message: 'Customer requirement is required', type: 'error' });
      return;
    }

    try {
      setLoading(true);
      const requestCode = `REQ-${category.slice(0, 3).toUpperCase()}-${existingRequestCount + 1}`;

      await EnquiryRequestService.createRequest({
        inquiry_id: inquiryId,
        category,
        request_code: requestCode,
        title: title.trim(),
        customer_requirement: customerRequirement.trim(),
        assigned_to: assignedTo || null,
        waiting_for: waitingFor,
        due_at: dueDate ? `${dueDate}T17:00:00.000Z` : null,
        actor: {
          actor_type: 'user',
          actor_id: user?.id || null,
        },
      });

      showToast({
        title: 'Requirement Added',
        message: `Request ${requestCode} added to enquiry ${inquiryNumber}.`,
        type: 'success',
      });
      onSuccess();
      onClose();
    } catch (err: any) {
      console.error('[CreateEnquiryRequestModal] Error creating request:', err);
      showToast({
        title: 'Creation Failed',
        message: err.message || 'Failed to add requirement',
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
      title={`Add Customer Requirement: ${inquiryNumber}`}
      size="md"
    >
      <form onSubmit={handleSubmit} className="space-y-4 text-xs">
        <div className="grid grid-cols-2 gap-3">
          <div>
            <label className="block text-xs font-semibold text-gray-700 mb-1">
              Category <span className="text-rose-500">*</span>
            </label>
            <select
              value={category}
              onChange={e => setCategory(e.target.value as any)}
              className="w-full px-2.5 py-1.5 border border-gray-300 rounded-md text-xs bg-white focus:ring-2 focus:ring-blue-500"
            >
              <option value="technical">Technical (Specification, mesh, grade)</option>
              <option value="commercial">Commercial (Target pricing, terms)</option>
              <option value="document">Document (COA, MSDS, Halal, TDS)</option>
              <option value="sample">Sample (Lab sample, trial batch)</option>
              <option value="logistics">Logistics (Packaging, delivery lead time)</option>
              <option value="custom">Other / Custom</option>
            </select>
          </div>

          <div>
            <label className="block text-xs font-semibold text-gray-700 mb-1">
              Waiting For
            </label>
            <select
              value={waitingFor}
              onChange={e => setWaitingFor(e.target.value as any)}
              className="w-full px-2.5 py-1.5 border border-gray-300 rounded-md text-xs bg-white focus:ring-2 focus:ring-blue-500"
            >
              <option value="INTERNAL">INTERNAL</option>
              <option value="CUSTOMER">CUSTOMER</option>
              <option value="INDIA">INDIA</option>
              <option value="MANUFACTURER">MANUFACTURER</option>
              <option value="NONE">NONE</option>
            </select>
          </div>
        </div>

        <div>
          <label className="block text-xs font-semibold text-gray-700 mb-1">
            Requirement Title <span className="text-rose-500">*</span>
          </label>
          <input
            type="text"
            value={title}
            onChange={e => setTitle(e.target.value)}
            placeholder="e.g. COA Batch Verification, 100 Mesh Availability"
            className="w-full px-3 py-1.5 border border-gray-300 rounded-md text-xs focus:ring-2 focus:ring-blue-500"
            required
          />
        </div>

        <div>
          <label className="block text-xs font-semibold text-gray-700 mb-1">
            Detailed Customer Requirement <span className="text-rose-500">*</span>
          </label>
          <textarea
            value={customerRequirement}
            onChange={e => setCustomerRequirement(e.target.value)}
            rows={3}
            placeholder="Exact specification or customer need..."
            className="w-full px-3 py-1.5 border border-gray-300 rounded-md text-xs focus:ring-2 focus:ring-blue-500"
            required
          />
        </div>

        <div className="grid grid-cols-2 gap-3">
          <div>
            <label className="block text-xs font-semibold text-gray-700 mb-1">Assign To</label>
            <select
              value={assignedTo}
              onChange={e => setAssignedTo(e.target.value)}
              className="w-full px-2.5 py-1.5 border border-gray-300 rounded-md text-xs bg-white focus:ring-2 focus:ring-blue-500"
            >
              <option value="">Unassigned</option>
              {users.map(u => (
                <option key={u.id} value={u.id}>
                  {u.full_name}
                </option>
              ))}
            </select>
          </div>

          <div>
            <label className="block text-xs font-semibold text-gray-700 mb-1">Due Date</label>
            <input
              type="date"
              value={dueDate}
              onChange={e => setDueDate(e.target.value)}
              className="w-full px-2.5 py-1.5 border border-gray-300 rounded-md text-xs bg-white focus:ring-2 focus:ring-blue-500"
            />
          </div>
        </div>

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
            <span>Add Requirement</span>
          </button>
        </div>
      </form>
    </Modal>
  );
};
