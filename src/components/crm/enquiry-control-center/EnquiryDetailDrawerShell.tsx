import React from 'react';
import {
  X,
  Layers,
  CheckCircle2,
  AlertTriangle,
  Clock,
  User,
  Building,
  Mail,
  Phone,
  FileText,
  MessageSquare,
  Paperclip,
  CheckSquare,
} from 'lucide-react';
import { EnquiryControlCenterRow } from '../../../types/enquiry/controlCenter.types.ts';
import { PipelineStatusBadge } from '../PipelineStatusBadge';

interface EnquiryDetailDrawerShellProps {
  enquiry: EnquiryControlCenterRow | null;
  onClose: () => void;
}

export const EnquiryDetailDrawerShell: React.FC<EnquiryDetailDrawerShellProps> = ({
  enquiry,
  onClose,
}) => {
  if (!enquiry) return null;

  const { customer, operationalSummary, requests, age, due } = enquiry;

  return (
    <div className="fixed inset-y-0 right-0 w-full sm:w-[480px] lg:w-[560px] bg-white shadow-2xl border-l border-gray-200 z-50 flex flex-col transform transition-transform duration-200 ease-in-out">
      {/* Header */}
      <div className="p-4 border-b border-gray-200 bg-gray-50 flex items-start justify-between gap-3">
        <div>
          <div className="flex items-center gap-2">
            <span className="font-bold text-base text-gray-900">{enquiry.inquiryNumber}</span>
            {enquiry.isMultiProduct && (
              <span className="inline-flex items-center gap-1 text-[11px] bg-blue-100 text-blue-800 px-1.5 py-0.5 rounded font-medium">
                <Layers className="w-3 h-3" /> Multi-product
              </span>
            )}
            {enquiry.priceReady && (
              <span className="inline-flex items-center gap-1 text-[11px] bg-emerald-100 text-emerald-800 px-1.5 py-0.5 rounded font-medium">
                <CheckCircle2 className="w-3 h-3" /> Price Ready
              </span>
            )}
          </div>
          <div className="text-xs text-gray-500 mt-1 flex items-center gap-2">
            <span>Received: {enquiry.inquiryDate}</span>
            <span>·</span>
            <span className="font-medium text-gray-700">{age.label} ago</span>
          </div>
        </div>
        <div className="flex items-center gap-2">
          <PipelineStatusBadge status={enquiry.pipelineStatus} />
          <button
            type="button"
            onClick={onClose}
            className="p-1 rounded-md text-gray-400 hover:text-gray-700 hover:bg-gray-200 transition cursor-pointer"
          >
            <X className="w-5 h-5" />
          </button>
        </div>
      </div>

      {/* Content Body */}
      <div className="flex-1 overflow-y-auto p-4 space-y-4 text-xs">
        {/* Customer Info Card */}
        <div className="bg-white border border-gray-200 rounded-lg p-3 space-y-1.5 shadow-sm">
          <div className="flex items-center justify-between">
            <div className="flex items-center gap-1.5 font-semibold text-gray-900 text-sm">
              <Building className="w-4 h-4 text-gray-500" />
              <span>{customer.companyName}</span>
            </div>
            <span
              className={`px-1.5 py-0.5 rounded text-[10px] font-medium border ${
                customer.isErpCustomer
                  ? 'bg-emerald-50 text-emerald-700 border-emerald-200'
                  : 'bg-amber-50 text-amber-700 border-amber-200'
              }`}
            >
              {customer.isErpCustomer ? 'ERP Customer' : 'CRM Prospect'}
            </span>
          </div>
          {(customer.contactPerson || customer.contactEmail || customer.contactPhone) && (
            <div className="text-gray-600 flex flex-wrap items-center gap-x-3 gap-y-1 pt-1 border-t border-gray-100">
              {customer.contactPerson && (
                <span className="flex items-center gap-1">
                  <User className="w-3 h-3 text-gray-400" />
                  {customer.contactPerson}
                </span>
              )}
              {customer.contactEmail && (
                <span className="flex items-center gap-1">
                  <Mail className="w-3 h-3 text-gray-400" />
                  {customer.contactEmail}
                </span>
              )}
              {customer.contactPhone && (
                <span className="flex items-center gap-1">
                  <Phone className="w-3 h-3 text-gray-400" />
                  {customer.contactPhone}
                </span>
              )}
            </div>
          )}
        </div>

        {/* Product & Requirement Card */}
        <div className="bg-white border border-gray-200 rounded-lg p-3 space-y-2 shadow-sm">
          <h4 className="font-semibold text-gray-900 text-xs flex items-center justify-between">
            <span>Product & Requirement</span>
            {enquiry.priority && (
              <span className="uppercase text-[10px] font-bold text-gray-500">
                Priority: {enquiry.priority}
              </span>
            )}
          </h4>
          <div className="space-y-1">
            <div className="font-medium text-gray-900">{enquiry.productName}</div>
            <div className="text-gray-600">
              Quantity:{' '}
              <span className="font-medium text-gray-800">{enquiry.quantity || '—'}</span>
            </div>
            {enquiry.specification && (
              <div className="text-gray-600">
                Specification:{' '}
                <span className="font-medium text-gray-800">{enquiry.specification}</span>
              </div>
            )}
          </div>
        </div>

        {/* Operational Bottleneck Card */}
        <div className="bg-gradient-to-br from-gray-50 to-white border border-gray-200 rounded-lg p-3.5 space-y-2.5 shadow-sm">
          <h4 className="font-semibold text-gray-900 text-xs flex items-center gap-1.5">
            <AlertTriangle className="w-4 h-4 text-amber-500" />
            <span>Operational Work Status</span>
          </h4>

          <div className="grid grid-cols-2 gap-2 text-xs">
            <div className="p-2 rounded bg-white border border-gray-100">
              <span className="text-[10px] text-gray-400 block uppercase font-medium">
                Waiting For
              </span>
              <span className="font-semibold text-purple-700">
                {operationalSummary.waitingForSummary || 'None'}
              </span>
            </div>
            <div className="p-2 rounded bg-white border border-gray-100">
              <span className="text-[10px] text-gray-400 block uppercase font-medium">
                Due Target
              </span>
              <span
                className={`font-semibold ${
                  due.isOverdue ? 'text-rose-600' : 'text-gray-800'
                }`}
              >
                {due.dueLabel || 'No target set'}
              </span>
            </div>
          </div>

          {operationalSummary.currentBlocker ? (
            <div className="p-2.5 rounded bg-rose-50 border border-rose-200 text-rose-800 text-xs">
              <div className="font-semibold flex items-center gap-1">
                <span>🛑 Current Blocker:</span>
              </div>
              <div className="mt-0.5 font-medium">{operationalSummary.currentBlocker}</div>
            </div>
          ) : (
            <div className="text-gray-500 italic text-xs">No active blocker recorded.</div>
          )}

          {operationalSummary.nextAction && (
            <div className="p-2.5 rounded bg-blue-50 border border-blue-200 text-blue-800 text-xs">
              <div className="font-semibold flex items-center gap-1">
                <span>👉 Next Action:</span>
              </div>
              <div className="mt-0.5 font-medium">{operationalSummary.nextAction}</div>
            </div>
          )}
        </div>

        {/* Active Requests List */}
        <div className="space-y-2">
          <div className="flex items-center justify-between font-semibold text-gray-900 text-xs">
            <span>Customer Requirements & Requests ({requests.length})</span>
          </div>

          {requests.length === 0 ? (
            <div className="text-center py-6 bg-gray-50 rounded-lg border border-dashed border-gray-200 text-gray-400 text-xs">
              No structured requests recorded yet for this enquiry.
            </div>
          ) : (
            <div className="space-y-2">
              {requests.map(r => (
                <div
                  key={r.id}
                  className="bg-white p-2.5 rounded-lg border border-gray-200 space-y-1.5 shadow-sm"
                >
                  <div className="flex items-center justify-between">
                    <span className="font-semibold text-gray-800">
                      {r.request_code}: {r.title}
                    </span>
                    <span
                      className={`px-1.5 py-0.5 rounded text-[10px] font-medium ${
                        r.status === 'BLOCKED'
                          ? 'bg-rose-100 text-rose-800'
                          : r.status === 'IN_PROGRESS'
                          ? 'bg-amber-100 text-amber-800'
                          : r.status === 'RESOLVED'
                          ? 'bg-emerald-100 text-emerald-800'
                          : 'bg-blue-100 text-blue-800'
                      }`}
                    >
                      {r.status}
                    </span>
                  </div>
                  <p className="text-gray-600 text-xs">{r.customer_requirement}</p>
                  {r.current_issue && (
                    <div className="text-rose-700 font-medium text-[11px]">
                      Issue: {r.current_issue}
                    </div>
                  )}
                  {r.next_action && (
                    <div className="text-blue-700 font-medium text-[11px]">
                      Action: {r.next_action}
                    </div>
                  )}
                  <div className="flex items-center justify-between text-[10px] text-gray-400 pt-1 border-t border-gray-100">
                    <span>Waiting: {r.waiting_for || 'None'}</span>
                    <span>Team: {r.assigned_team || 'Unassigned'}</span>
                  </div>
                </div>
              ))}
            </div>
          )}
        </div>

        {/* Phase 7.3 & 7.4 Architectural Anchors */}
        <div className="border border-dashed border-gray-200 rounded-lg p-3 bg-gray-50/50 space-y-2 text-center text-gray-400">
          <div className="font-medium text-xs text-gray-500">Upcoming Control Center Modules</div>
          <div className="grid grid-cols-2 gap-2 text-[11px]">
            <div
              className="p-2 rounded bg-white border border-gray-200 flex flex-col items-center gap-1"
              data-task-ref="reference_type: 'enquiry_request'"
            >
              <CheckSquare className="w-4 h-4 text-gray-400" />
              <span>Phase 7.3: Request & Tasks Workflow</span>
            </div>
            <div className="p-2 rounded bg-white border border-gray-200 flex flex-col items-center gap-1">
              <MessageSquare className="w-4 h-4 text-gray-400" />
              <span>Phase 7.4: Conversation & Documents</span>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
};
