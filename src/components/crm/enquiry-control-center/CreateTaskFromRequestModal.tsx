import React, { useState, useEffect } from 'react';
import { supabase } from '../../../lib/supabase';
import { useAuth } from '../../../contexts/AuthContext';
import { Modal } from '../../Modal';
import { Calendar, User, Clock, AlertCircle, Loader2 } from 'lucide-react';
import { showToast } from '../../ToastNotification';
import { EnquiryRequestGridItem } from '../../../types/enquiry/controlCenter.types.ts';

interface UserProfile {
  id: string;
  full_name: string;
  email: string;
}

interface CreateTaskFromRequestModalProps {
  isOpen: boolean;
  onClose: () => void;
  onSuccess: () => void;
  request: EnquiryRequestGridItem;
  inquiryId: string;
  inquiryNumber: string;
  productName?: string;
}

export const CreateTaskFromRequestModal: React.FC<CreateTaskFromRequestModalProps> = ({
  isOpen,
  onClose,
  onSuccess,
  request,
  inquiryId,
  inquiryNumber,
  productName,
}) => {
  const { user } = useAuth();
  const [loading, setLoading] = useState(false);
  const [users, setUsers] = useState<UserProfile[]>([]);
  
  // Form fields
  const [title, setTitle] = useState('');
  const [description, setDescription] = useState('');
  const [deadlineDate, setDeadlineDate] = useState('');
  const [deadlineTime, setDeadlineTime] = useState('17:00');
  const [priority, setPriority] = useState<'low' | 'medium' | 'high' | 'urgent'>('medium');
  const [selectedUserIds, setSelectedUserIds] = useState<string[]>([]);

  useEffect(() => {
    if (isOpen) {
      // Set default prefilled title from request
      const defaultTitle = `${request.title} (${request.request_code} · ${inquiryNumber})`;
      setTitle(defaultTitle);
      setDescription(
        `Requirement: ${request.customer_requirement}\n` +
        (request.current_issue ? `Current Blocker: ${request.current_issue}\n` : '') +
        (request.next_action ? `Next Action: ${request.next_action}\n` : '')
      );

      // Default deadline to request due_at or 2 business days from now
      if (request.due_at) {
        const d = new Date(request.due_at);
        setDeadlineDate(d.toISOString().split('T')[0]);
      } else {
        const d = new Date();
        d.setDate(d.getDate() + 2);
        setDeadlineDate(d.toISOString().split('T')[0]);
      }

      // Pre-select request assignee if available
      if (request.assigned_to) {
        setSelectedUserIds([request.assigned_to]);
      } else if (user?.id) {
        setSelectedUserIds([user.id]);
      }

      loadUsers();
    }
  }, [isOpen, request, inquiryNumber, user?.id]);

  const loadUsers = async () => {
    try {
      const { data, error } = await supabase
        .from('user_profiles')
        .select('id, full_name, email')
        .order('full_name');
      if (error) throw error;
      setUsers(data || []);
    } catch (err) {
      console.error('[CreateTaskFromRequestModal] Failed to load users:', err);
    }
  };

  const handleUserToggle = (userId: string) => {
    setSelectedUserIds(prev =>
      prev.includes(userId) ? prev.filter(id => id !== userId) : [...prev, userId]
    );
  };

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!title.trim()) {
      showToast({ title: 'Validation Error', message: 'Task title is required', type: 'error' });
      return;
    }
    if (!deadlineDate) {
      showToast({ title: 'Validation Error', message: 'Deadline date is required', type: 'error' });
      return;
    }
    if (selectedUserIds.length === 0) {
      showToast({ title: 'Validation Error', message: 'Please assign at least one user', type: 'error' });
      return;
    }

    try {
      setLoading(true);
      const deadlineIso = `${deadlineDate}T${deadlineTime || '17:00'}:00.000Z`;

      // 1. Insert directly into canonical `tasks` table
      // Canonical link: reference_type = 'enquiry_request', reference_id = request.id, inquiry_id = inquiryId
      const taskPayload = {
        title: title.trim(),
        description: description.trim() || null,
        deadline: deadlineIso,
        priority,
        status: 'to_do',
        created_by: user?.id,
        assigned_users: selectedUserIds,
        inquiry_id: inquiryId,
        reference_type: 'enquiry_request',
        reference_id: request.id,
        tags: ['crm', 'enquiry_request', request.category],
      };

      const { data: newTask, error: taskError } = await supabase
        .from('tasks')
        .insert([taskPayload])
        .select('id')
        .single();

      if (taskError) throw taskError;

      // 2. Insert into canonical `task_assignments`
      if (newTask?.id && selectedUserIds.length > 0) {
        const assignments = selectedUserIds.map(userId => ({
          task_id: newTask.id,
          assigned_user_id: userId,
          assigned_by: user?.id || null,
        }));

        const { error: assignError } = await supabase
          .from('task_assignments')
          .insert(assignments);

        if (assignError) {
          console.warn('[CreateTaskFromRequestModal] Task assignments insert warning:', assignError);
        }
      }

      showToast({
        title: 'Task Created',
        message: `Task linked to request ${request.request_code} created successfully.`,
        type: 'success',
      });

      onSuccess();
      onClose();
    } catch (err: any) {
      console.error('[CreateTaskFromRequestModal] Error creating task:', err);
      showToast({
        title: 'Task Creation Failed',
        message: err.message || 'Failed to create linked task',
        type: 'error',
      });
    } finally {
      setLoading(false);
    }
  };

  return (
    <Modal isOpen={isOpen} onClose={onClose} title={`Create Task for Request: ${request.request_code}`} size="lg">
      <form onSubmit={handleSubmit} className="space-y-4 text-xs">
        <div className="bg-blue-50 border border-blue-200 rounded-lg p-3 text-blue-900 space-y-1">
          <div className="font-semibold flex items-center gap-1.5">
            <span className="uppercase text-[10px] bg-blue-200 text-blue-800 px-1.5 py-0.2 rounded font-bold">
              {request.category}
            </span>
            <span>{request.title}</span>
          </div>
          <p className="text-blue-800 text-[11px] font-normal">{request.customer_requirement}</p>
          <div className="text-[10px] text-blue-600 pt-0.5 border-t border-blue-100 flex items-center justify-between">
            <span>Enquiry: <strong>{inquiryNumber}</strong></span>
            <span>Task will link canonically to <strong>{request.request_code}</strong></span>
          </div>
        </div>

        {/* Task Title */}
        <div>
          <label className="block text-xs font-semibold text-gray-700 mb-1">
            Task Title <span className="text-rose-500">*</span>
          </label>
          <input
            type="text"
            value={title}
            onChange={e => setTitle(e.target.value)}
            className="w-full px-3 py-1.5 border border-gray-300 rounded-md focus:ring-2 focus:ring-blue-500 focus:border-blue-500 text-xs"
            placeholder="What action needs to be completed?"
            required
          />
        </div>

        {/* Description / Instructions */}
        <div>
          <label className="block text-xs font-semibold text-gray-700 mb-1">
            Action Instructions / Internal Notes
          </label>
          <textarea
            value={description}
            onChange={e => setDescription(e.target.value)}
            rows={3}
            className="w-full px-3 py-1.5 border border-gray-300 rounded-md focus:ring-2 focus:ring-blue-500 focus:border-blue-500 text-xs"
            placeholder="Specific instructions for the assignee..."
          />
        </div>

        {/* Priority & Deadline */}
        <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
          <div>
            <label className="block text-xs font-semibold text-gray-700 mb-1">Priority</label>
            <select
              value={priority}
              onChange={e => setPriority(e.target.value as any)}
              className="w-full px-2.5 py-1.5 border border-gray-300 rounded-md text-xs bg-white focus:ring-2 focus:ring-blue-500"
            >
              <option value="low">Low</option>
              <option value="medium">Medium</option>
              <option value="high">High</option>
              <option value="urgent">Urgent</option>
            </select>
          </div>

          <div>
            <label className="block text-xs font-semibold text-gray-700 mb-1">
              Deadline Date <span className="text-rose-500">*</span>
            </label>
            <input
              type="date"
              value={deadlineDate}
              onChange={e => setDeadlineDate(e.target.value)}
              className="w-full px-2.5 py-1.5 border border-gray-300 rounded-md text-xs bg-white focus:ring-2 focus:ring-blue-500"
              required
            />
          </div>

          <div>
            <label className="block text-xs font-semibold text-gray-700 mb-1">Time</label>
            <input
              type="time"
              value={deadlineTime}
              onChange={e => setDeadlineTime(e.target.value)}
              className="w-full px-2.5 py-1.5 border border-gray-300 rounded-md text-xs bg-white focus:ring-2 focus:ring-blue-500"
            />
          </div>
        </div>

        {/* User Assignment */}
        <div>
          <label className="block text-xs font-semibold text-gray-700 mb-1">
            Assign To <span className="text-rose-500">*</span>
          </label>
          <div className="max-h-36 overflow-y-auto border border-gray-200 rounded-md p-2 space-y-1 bg-gray-50">
            {users.map(u => {
              const isSelected = selectedUserIds.includes(u.id);
              return (
                <label
                  key={u.id}
                  className={`flex items-center gap-2 p-1.5 rounded cursor-pointer transition ${
                    isSelected ? 'bg-blue-100 text-blue-900 font-medium' : 'hover:bg-gray-100 text-gray-700'
                  }`}
                >
                  <input
                    type="checkbox"
                    checked={isSelected}
                    onChange={() => handleUserToggle(u.id)}
                    className="rounded text-blue-600 focus:ring-blue-500 w-3.5 h-3.5"
                  />
                  <span>{u.full_name}</span>
                  <span className="text-[10px] text-gray-400">({u.email})</span>
                </label>
              );
            })}
          </div>
        </div>

        {/* Buttons */}
        <div className="flex items-center justify-end gap-2 pt-3 border-t border-gray-200">
          <button
            type="button"
            onClick={onClose}
            className="px-3 py-1.5 rounded-md border border-gray-300 text-gray-700 hover:bg-gray-100 font-medium transition cursor-pointer"
            disabled={loading}
          >
            Cancel
          </button>
          <button
            type="submit"
            disabled={loading}
            className="inline-flex items-center gap-1.5 px-4 py-1.5 rounded-md bg-blue-600 hover:bg-blue-700 text-white font-semibold shadow-xs transition cursor-pointer disabled:opacity-50"
          >
            {loading ? <Loader2 className="w-4 h-4 animate-spin" /> : null}
            <span>Create Linked Task</span>
          </button>
        </div>
      </form>
    </Modal>
  );
};
