import React, { useState } from 'react';
import {
  AlertTriangle,
  ArrowRight,
  CheckCircle2,
  Clock,
  Edit3,
  ExternalLink,
  MessageSquare,
  MoreHorizontal,
  Plus,
  ShieldAlert,
  User,
  CheckSquare,
  FileText,
  Download,
  Tag,
  Paperclip,
} from 'lucide-react';
import { EnquiryRequestGridItem } from '../../../types/enquiry/controlCenter.types.ts';
import { EditRequestRequirementModal } from './EditRequestRequirementModal';
import { TransitionRequestStateModal } from './TransitionRequestStateModal';
import { CreateTaskFromRequestModal } from './CreateTaskFromRequestModal';
import { getSignedUrlCached } from '../../../utils/signedUrlCache';

export interface LinkedTaskItem {
  id: string;
  title: string;
  description: string | null;
  status: string;
  priority: string;
  deadline: string;
  completed_at: string | null;
  created_at: string;
  reference_type: string | null;
  reference_id: string | null;
  inquiry_id: string | null;
  created_by: string;
  assigned_users?: string[];
  assignee_names?: string[];
  comment_count?: number;
}

export interface RequestLinkedDocumentItem {
  id: string;
  document_type: string;
  display_file_name?: string | null;
  original_file_name?: string | null;
  storage_path: string;
  created_at: string;
}

export interface RequestLinkedMessageItem {
  message_id: string;
  relationship: 'originated' | 'clarified' | 'blocked' | 'resolved' | 'referenced';
  sender_address?: string;
  subject?: string | null;
  received_or_sent_at?: string;
}

interface RequestCardProps {
  request: EnquiryRequestGridItem;
  inquiryId: string;
  inquiryNumber: string;
  linkedTasks: LinkedTaskItem[];
  linkedDocuments?: RequestLinkedDocumentItem[];
  linkedMessages?: RequestLinkedMessageItem[];
  onRefresh: () => void;
  onOpenTaskModal: (taskId: string) => void;
  canManage?: boolean;
}

const CATEGORY_STYLES: Record<string, { bg: string; text: string; label: string }> = {
  technical: { bg: 'bg-purple-100', text: 'text-purple-800', label: 'Technical' },
  commercial: { bg: 'bg-emerald-100', text: 'text-emerald-800', label: 'Commercial' },
  document: { bg: 'bg-blue-100', text: 'text-blue-800', label: 'Document' },
  sample: { bg: 'bg-amber-100', text: 'text-amber-800', label: 'Sample' },
  logistics: { bg: 'bg-indigo-100', text: 'text-indigo-800', label: 'Logistics' },
  custom: { bg: 'bg-gray-100', text: 'text-gray-800', label: 'Custom' },
};

const STATUS_STYLES: Record<string, { bg: string; text: string; border: string }> = {
  OPEN: { bg: 'bg-blue-50', text: 'text-blue-700', border: 'border-blue-200' },
  IN_PROGRESS: { bg: 'bg-amber-50', text: 'text-amber-700', border: 'border-amber-200' },
  BLOCKED: { bg: 'bg-rose-50', text: 'text-rose-700', border: 'border-rose-300' },
  RESOLVED: { bg: 'bg-emerald-50', text: 'text-emerald-700', border: 'border-emerald-200' },
  CANCELLED: { bg: 'bg-gray-100', text: 'text-gray-500', border: 'border-gray-200' },
};

const WAITING_STYLES: Record<string, string> = {
  CUSTOMER: 'bg-purple-50 text-purple-700 border-purple-200',
  INDIA: 'bg-amber-50 text-amber-700 border-amber-200',
  MANUFACTURER: 'bg-cyan-50 text-cyan-700 border-cyan-200',
  INTERNAL: 'bg-blue-50 text-blue-700 border-blue-200',
  NONE: 'bg-gray-50 text-gray-500 border-gray-200',
};

export const RequestCard: React.FC<RequestCardProps> = ({
  request,
  inquiryId,
  inquiryNumber,
  linkedTasks,
  linkedDocuments = [],
  linkedMessages = [],
  onRefresh,
  onOpenTaskModal,
  canManage = true,
}) => {
  const [showEditRequirementModal, setShowEditRequirementModal] = useState(false);
  const [showTransitionStateModal, setShowTransitionStateModal] = useState(false);
  const [showCreateTaskModal, setShowCreateTaskModal] = useState(false);

  const handleDownloadDoc = async (doc: RequestLinkedDocumentItem) => {
    const filename = doc.display_file_name || doc.original_file_name || 'document';
    try {
      const url = await getSignedUrlCached('crm-documents', doc.storage_path, 3600, {
        download: filename,
      });
      if (!url) {
        alert('Could not generate secure download link.');
        return;
      }
      const link = document.createElement('a');
      link.href = url;
      link.download = filename;
      link.rel = 'noopener noreferrer';
      document.body.appendChild(link);
      link.click();
      link.remove();
    } catch (err) {
      console.error('[RequestCard] Document download error:', err);
    }
  };

  const catStyle = CATEGORY_STYLES[request.category] || CATEGORY_STYLES.custom;
  const statusStyle = STATUS_STYLES[request.status] || STATUS_STYLES.OPEN;
  const waitingStyle =
    WAITING_STYLES[request.waiting_for?.toUpperCase()] || 'bg-gray-50 text-gray-700 border-gray-200';

  const isBlocked = request.status === 'BLOCKED';
  const isResolved = request.status === 'RESOLVED';

  return (
    <div
      className={`rounded-lg border shadow-xs transition ${
        isBlocked
          ? 'bg-rose-50/20 border-rose-300'
          : isResolved
          ? 'bg-emerald-50/15 border-emerald-200'
          : 'bg-white border-gray-200'
      }`}
    >
      {/* Header */}
      <div className="p-3 border-b border-gray-100 flex items-start justify-between gap-2">
        <div className="space-y-1">
          <div className="flex flex-wrap items-center gap-1.5">
            <span
              className={`px-1.5 py-0.5 rounded text-[10px] font-bold uppercase tracking-wider ${catStyle.bg} ${catStyle.text}`}
            >
              {catStyle.label}
            </span>
            <span className="font-bold text-gray-900 text-xs">{request.request_code}</span>
            <span className="text-gray-300">·</span>
            <span className="font-semibold text-gray-800 text-xs">{request.title}</span>
          </div>

          <div className="flex flex-wrap items-center gap-2 text-[11px] pt-0.5">
            <span
              className={`px-1.5 py-0.2 rounded border text-[10px] font-semibold ${statusStyle.bg} ${statusStyle.text} ${statusStyle.border}`}
            >
              {request.status}
            </span>

            <span
              className={`px-1.5 py-0.2 rounded border text-[10px] font-medium ${waitingStyle}`}
            >
              Waiting: {request.waiting_for}
            </span>

            {request.assigned_team && (
              <span className="text-gray-500 text-[10px]">
                Team: <strong>{request.assigned_team}</strong>
              </span>
            )}
          </div>
        </div>

        {/* Action Buttons */}
        {canManage && (
          <div className="flex items-center gap-1">
            <button
              type="button"
              onClick={() => setShowTransitionStateModal(true)}
              className="px-2 py-1 text-[11px] font-medium rounded border border-gray-300 bg-white hover:bg-gray-50 text-gray-700 transition cursor-pointer shadow-2xs"
              title="Update status, blocker, or mark resolved"
            >
              State
            </button>
            <button
              type="button"
              onClick={() => setShowEditRequirementModal(true)}
              className="px-2 py-1 text-[11px] font-medium rounded border border-gray-300 bg-white hover:bg-gray-50 text-gray-700 transition cursor-pointer shadow-2xs"
              title="Evolve customer requirement"
            >
              <Edit3 className="w-3 h-3" />
            </button>
          </div>
        )}
      </div>

      {/* Body */}
      <div className="p-3 space-y-2.5 text-xs">
        {/* Customer Requirement */}
        <div className="bg-gray-50/70 border border-gray-200/70 rounded p-2.5 space-y-1">
          <div className="text-[10px] font-semibold uppercase tracking-wider text-gray-400">
            Customer Requirement
          </div>
          <div className="text-gray-800 font-medium leading-relaxed">
            {request.customer_requirement}
          </div>
        </div>

        {/* Current Blocker Alert if active */}
        {request.current_issue && (
          <div className="bg-rose-50 border border-rose-200 rounded p-2 text-rose-900 space-y-0.5">
            <div className="font-semibold flex items-center gap-1 text-[11px] text-rose-800">
              <ShieldAlert className="w-3.5 h-3.5 text-rose-600" />
              <span>Current Blocker:</span>
            </div>
            <p className="text-rose-800 font-medium text-xs">{request.current_issue}</p>
          </div>
        )}

        {/* Next Action Banner */}
        {request.next_action && (
          <div className="bg-blue-50 border border-blue-200 rounded p-2 text-blue-900 space-y-0.5">
            <div className="font-semibold flex items-center gap-1 text-[11px] text-blue-800">
              <ArrowRight className="w-3.5 h-3.5 text-blue-600" />
              <span>Next Action:</span>
            </div>
            <p className="text-blue-800 font-medium text-xs">{request.next_action}</p>
          </div>
        )}

        {/* Linked Documents (e.g. COA / MSDS attached to this request) */}
        {linkedDocuments && linkedDocuments.length > 0 && (
          <div className="pt-2 border-t border-gray-100 space-y-1.5">
            <div className="flex items-center justify-between text-[10px] font-semibold uppercase tracking-wider text-gray-400">
              <span className="flex items-center gap-1">
                <FileText className="w-3 h-3 text-emerald-600" />
                <span>Linked Documents ({linkedDocuments.length})</span>
              </span>
            </div>
            <div className="flex flex-wrap gap-1.5">
              {linkedDocuments.map(doc => (
                <button
                  key={doc.id}
                  type="button"
                  onClick={() => handleDownloadDoc(doc)}
                  className="inline-flex items-center gap-1.5 px-2 py-1 rounded border border-emerald-200 bg-emerald-50/50 hover:bg-emerald-100/60 text-emerald-900 text-[11px] font-medium transition cursor-pointer shadow-2xs group"
                  title={`Download ${doc.display_file_name || doc.original_file_name}`}
                >
                  <span className="px-1 py-0.2 rounded bg-emerald-200/80 text-[9px] font-bold uppercase tracking-wider text-emerald-800">
                    {doc.document_type}
                  </span>
                  <span className="truncate max-w-[150px]">
                    {doc.display_file_name || doc.original_file_name || 'document'}
                  </span>
                  <Download className="w-3 h-3 text-emerald-600 group-hover:scale-110 transition" />
                </button>
              ))}
            </div>
          </div>
        )}

        {/* Linked Communication Messages (enquiry_request_messages provenance) */}
        {linkedMessages && linkedMessages.length > 0 && (
          <div className="pt-2 border-t border-gray-100 space-y-1.5">
            <div className="flex items-center gap-1 text-[10px] font-semibold uppercase tracking-wider text-gray-400">
              <MessageSquare className="w-3 h-3 text-blue-500" />
              <span>Communication Provenance ({linkedMessages.length})</span>
            </div>
            <div className="flex flex-wrap gap-1.5">
              {linkedMessages.map((lm, lmIdx) => (
                <div
                  key={lmIdx}
                  className="inline-flex items-center gap-1.5 px-2 py-0.5 rounded border border-blue-200 bg-blue-50/40 text-blue-900 text-[10px] font-medium"
                >
                  <Tag className="w-2.5 h-2.5 text-blue-600" />
                  <span className="uppercase font-bold text-blue-800">{lm.relationship}:</span>
                  <span className="truncate max-w-[180px]">
                    {lm.subject || lm.sender_address || 'Message'}
                  </span>
                </div>
              ))}
            </div>
          </div>
        )}

        {/* Linked Tasks Section */}
        <div className="pt-2 border-t border-gray-200 space-y-2">
          <div className="flex items-center justify-between">
            <div className="flex items-center gap-1.5 font-semibold text-gray-700 text-xs">
              <CheckSquare className="w-3.5 h-3.5 text-gray-500" />
              <span>Linked Execution Tasks ({linkedTasks.length})</span>
            </div>
            {canManage && (
              <button
                type="button"
                onClick={() => setShowCreateTaskModal(true)}
                className="inline-flex items-center gap-1 px-2 py-0.5 rounded text-[11px] font-semibold bg-blue-50 border border-blue-200 text-blue-700 hover:bg-blue-100 transition cursor-pointer"
              >
                <Plus className="w-3 h-3" />
                <span>Task</span>
              </button>
            )}
          </div>

          {linkedTasks.length === 0 ? (
            <div className="p-2.5 rounded border border-dashed border-gray-200 bg-gray-50/50 text-center text-gray-400 text-[11px]">
              No internal tasks dispatched yet for this requirement.
            </div>
          ) : (
            <div className="space-y-1.5">
              {linkedTasks.map(task => {
                const isCompleted = task.status === 'completed';
                const isOverdue =
                  task.deadline && !isCompleted && new Date(task.deadline).getTime() < Date.now();

                return (
                  <div
                    key={task.id}
                    onClick={() => onOpenTaskModal(task.id)}
                    className="p-2 rounded border border-gray-200 bg-white hover:border-blue-400 hover:bg-blue-50/20 transition cursor-pointer flex items-center justify-between gap-2 shadow-2xs group"
                  >
                    <div className="min-w-0 flex-1 space-y-0.5">
                      <div className="flex items-center gap-1.5">
                        <span
                          className={`w-2 h-2 rounded-full flex-shrink-0 ${
                            isCompleted
                              ? 'bg-emerald-500'
                              : task.status === 'in_progress'
                              ? 'bg-amber-500'
                              : 'bg-blue-500'
                          }`}
                        />
                        <span
                          className={`font-medium text-xs truncate group-hover:text-blue-700 ${
                            isCompleted ? 'line-through text-gray-400' : 'text-gray-900'
                          }`}
                        >
                          {task.title}
                        </span>
                      </div>

                      <div className="flex flex-wrap items-center gap-x-2.5 gap-y-0.5 text-[10px] text-gray-500">
                        {task.assignee_names && task.assignee_names.length > 0 && (
                          <span className="flex items-center gap-0.5 text-gray-700 font-medium">
                            <User className="w-2.5 h-2.5 text-gray-400" />
                            {task.assignee_names.join(', ')}
                          </span>
                        )}

                        <span
                          className={`uppercase font-semibold ${
                            task.priority === 'urgent'
                              ? 'text-rose-600'
                              : task.priority === 'high'
                              ? 'text-orange-600'
                              : 'text-gray-500'
                          }`}
                        >
                          {task.priority}
                        </span>

                        {task.deadline && (
                          <span className={isOverdue ? 'text-rose-600 font-bold' : 'text-gray-500'}>
                            Due: {new Date(task.deadline).toLocaleDateString()}
                          </span>
                        )}

                        {(task.comment_count ?? 0) > 0 && (
                          <span className="flex items-center gap-0.5 text-blue-600">
                            <MessageSquare className="w-2.5 h-2.5" />
                            {task.comment_count}
                          </span>
                        )}
                      </div>
                    </div>

                    <span
                      className={`px-1.5 py-0.5 rounded text-[10px] font-semibold uppercase whitespace-nowrap ${
                        isCompleted
                          ? 'bg-emerald-100 text-emerald-800'
                          : task.status === 'in_progress'
                          ? 'bg-amber-100 text-amber-800'
                          : 'bg-gray-100 text-gray-700'
                      }`}
                    >
                      {task.status.replace('_', ' ')}
                    </span>
                  </div>
                );
              })}
            </div>
          )}

          <div className="text-[10px] text-gray-400 italic px-0.5">
            Note: Completing internal tasks does not automatically satisfy this customer requirement.
          </div>
        </div>
      </div>

      {/* Modals */}
      {showEditRequirementModal && (
        <EditRequestRequirementModal
          isOpen={showEditRequirementModal}
          onClose={() => setShowEditRequirementModal(false)}
          onSuccess={onRefresh}
          request={request}
        />
      )}

      {showTransitionStateModal && (
        <TransitionRequestStateModal
          isOpen={showTransitionStateModal}
          onClose={() => setShowTransitionStateModal(false)}
          onSuccess={onRefresh}
          request={request}
        />
      )}

      {showCreateTaskModal && (
        <CreateTaskFromRequestModal
          isOpen={showCreateTaskModal}
          onClose={() => setShowCreateTaskModal(false)}
          onSuccess={onRefresh}
          request={request}
          inquiryId={inquiryId}
          inquiryNumber={inquiryNumber}
        />
      )}
    </div>
  );
};
