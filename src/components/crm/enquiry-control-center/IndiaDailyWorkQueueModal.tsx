import React, { useState, useEffect, useMemo } from 'react';
import {
  X,
  AlertTriangle,
  Clock,
  CheckCircle2,
  Filter,
  Layers,
  ArrowRight,
  User,
  Building,
  ShieldAlert,
  Calendar,
  ExternalLink,
  ChevronRight,
  RefreshCw,
} from 'lucide-react';
import { supabase } from '../../../lib/supabase';
import { EnquiryControlCenterRow } from '../../../types/enquiry/controlCenter.types';

export interface IndiaWorkItem {
  id: string;
  inquiryId: string;
  inquiryNumber: string;
  companyName: string;
  productName: string;
  requestCode: string;
  requestTitle: string;
  customerRequirement: string;
  category: string;
  status: string;
  waitingFor: string;
  currentIssue: string | null;
  nextAction: string | null;
  assignedTeam: string | null;
  assignedToName: string | null;
  dueAt: string | null;
  isOverdue: boolean;
  isDueToday: boolean;
  daysOverdue: number;
  // Associated task if any
  taskId?: string | null;
  taskTitle?: string | null;
  taskAssignee?: string | null;
}

interface IndiaDailyWorkQueueModalProps {
  isOpen: boolean;
  onClose: () => void;
  onSelectEnquiry: (inquiryId: string) => void;
}

type WorkQueueFilter = 'all' | 'overdue' | 'due_today' | 'waiting_manufacturer' | 'waiting_india' | 'blocked' | 'unassigned';

export const IndiaDailyWorkQueueModal: React.FC<IndiaDailyWorkQueueModalProps> = ({
  isOpen,
  onClose,
  onSelectEnquiry,
}) => {
  const [workItems, setWorkItems] = useState<IndiaWorkItem[]>([]);
  const [loading, setLoading] = useState(true);
  const [activeFilter, setActiveFilter] = useState<WorkQueueFilter>('all');
  const [runningEvaluator, setRunningEvaluator] = useState(false);

  const loadWorkQueue = async () => {
    setLoading(true);
    try {
      // 1. Fetch active requests relevant to India operations:
      // either waiting_for in ('INDIA', 'MANUFACTURER') OR assigned_team = 'pricing_india' OR blocked
      const { data: reqData, error: reqErr } = await supabase
        .from('enquiry_requests')
        .select(`
          id,
          inquiry_id,
          request_code,
          title,
          customer_requirement,
          category,
          status,
          waiting_for,
          current_issue,
          next_action,
          assigned_team,
          assigned_to,
          due_at,
          crm_inquiries(
            id,
            inquiry_number,
            product_name,
            company_name,
            crm_contacts:crm_contact_id(company_name)
          ),
          user_profiles:assigned_to(full_name)
        `)
        .in('status', ['OPEN', 'IN_PROGRESS', 'BLOCKED'])
        .or('waiting_for.in.(INDIA,MANUFACTURER),assigned_team.eq.pricing_india,status.eq.BLOCKED')
        .order('created_at', { ascending: false });

      if (reqErr) throw reqErr;

      // 2. Fetch linked tasks for these requests
      const reqIds = (reqData || []).map(r => r.id);
      let tasksByReqId: Record<string, any> = {};

      if (reqIds.length > 0) {
        const { data: taskData } = await supabase
          .from('tasks')
          .select(`
            id,
            title,
            reference_id,
            status,
            task_assignments(
              user_profiles:assigned_user_id(full_name)
            )
          `)
          .eq('reference_type', 'enquiry_request')
          .in('reference_id', reqIds)
          .eq('is_deleted', false);

        for (const t of taskData || []) {
          if (t.reference_id && !tasksByReqId[t.reference_id]) {
            let assignee = 'Unassigned';
            if (t.task_assignments && t.task_assignments.length > 0) {
              const profile = (t.task_assignments[0] as any).user_profiles;
              if (profile?.full_name) assignee = profile.full_name;
            }
            tasksByReqId[t.reference_id] = {
              id: t.id,
              title: t.title,
              assignee,
            };
          }
        }
      }

      // 3. Process into IndiaWorkItems
      const now = Date.now();
      const items: IndiaWorkItem[] = [];

      for (const r of reqData || []) {
        const inq = (r as any).crm_inquiries;
        const profile = (r as any).user_profiles;

        let isOverdue = false;
        let isDueToday = false;
        let daysOverdue = 0;

        if (r.due_at) {
          const dueMs = new Date(r.due_at).getTime();
          const diffMs = dueMs - now;
          const diffDays = Math.round(diffMs / 86400000);

          if (dueMs < now) {
            isOverdue = true;
            daysOverdue = Math.max(1, Math.abs(diffDays));
          } else if (diffDays === 0) {
            isDueToday = true;
          }
        }

        const linkedTask = tasksByReqId[r.id];

        items.push({
          id: r.id,
          inquiryId: r.inquiry_id,
          inquiryNumber: inq?.inquiry_number || 'INQ-UNKNOWN',
          companyName: inq?.crm_contacts?.company_name || inq?.company_name || 'Prospect Customer',
          productName: inq?.product_name || 'General Product',
          requestCode: r.request_code,
          requestTitle: r.title,
          customerRequirement: r.customer_requirement,
          category: r.category,
          status: r.status,
          waitingFor: r.waiting_for || 'NONE',
          currentIssue: r.current_issue,
          nextAction: r.next_action,
          assignedTeam: r.assigned_team,
          assignedToName: profile?.full_name || null,
          dueAt: r.due_at,
          isOverdue,
          isDueToday,
          daysOverdue,
          taskId: linkedTask?.id || null,
          taskTitle: linkedTask?.title || null,
          taskAssignee: linkedTask?.assignee || null,
        });
      }

      setWorkItems(items);
    } catch (err) {
      console.error('[IndiaDailyWorkQueue] Error loading items:', err);
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    if (isOpen) {
      loadWorkQueue();
    }
  }, [isOpen]);

  const handleRunReminders = async () => {
    setRunningEvaluator(true);
    try {
      await supabase.rpc('evaluate_enquiry_task_reminders');
      await loadWorkQueue();
    } catch (err) {
      console.error('Error running reminders:', err);
    } finally {
      setRunningEvaluator(false);
    }
  };

  const filteredItems = useMemo(() => {
    return workItems.filter(item => {
      switch (activeFilter) {
        case 'overdue':
          return item.isOverdue;
        case 'due_today':
          return item.isDueToday;
        case 'waiting_manufacturer':
          return item.waitingFor === 'MANUFACTURER';
        case 'waiting_india':
          return item.waitingFor === 'INDIA';
        case 'blocked':
          return item.status === 'BLOCKED';
        case 'unassigned':
          return !item.assignedToName && !item.taskAssignee;
        default:
          return true;
      }
    });
  }, [workItems, activeFilter]);

  const counts = useMemo(() => {
    return {
      all: workItems.length,
      overdue: workItems.filter(i => i.isOverdue).length,
      dueToday: workItems.filter(i => i.isDueToday).length,
      waitingManufacturer: workItems.filter(i => i.waitingFor === 'MANUFACTURER').length,
      waitingIndia: workItems.filter(i => i.waitingFor === 'INDIA').length,
      blocked: workItems.filter(i => i.status === 'BLOCKED').length,
      unassigned: workItems.filter(i => !i.assignedToName && !i.taskAssignee).length,
    };
  }, [workItems]);

  if (!isOpen) return null;

  return (
    <div className="fixed inset-0 z-50 overflow-y-auto bg-black/50 backdrop-blur-xs flex items-center justify-center p-3 sm:p-4">
      <div className="bg-white rounded-xl shadow-2xl border border-gray-200 w-full max-w-4xl flex flex-col max-h-[90vh]">
        {/* Modal Header */}
        <div className="p-4 border-b border-gray-200 bg-gray-50 flex items-start justify-between gap-3">
          <div>
            <div className="flex items-center gap-2">
              <h3 className="text-base font-bold text-gray-900 flex items-center gap-2">
                <span>🇮🇳 India Enquiry Daily Work Queue</span>
              </h3>
              <span className="text-[11px] bg-amber-100 text-amber-800 px-2 py-0.5 rounded-full font-semibold">
                Operational Queue
              </span>
            </div>
            <p className="text-xs text-gray-500 pt-0.5">
              Actionable daily view for India sourcing, pricing, and manufacturer verification.
            </p>
          </div>

          <div className="flex items-center gap-2">
            <button
              type="button"
              onClick={handleRunReminders}
              disabled={runningEvaluator}
              className="inline-flex items-center gap-1.5 px-2.5 py-1 text-xs font-semibold rounded border border-gray-300 bg-white hover:bg-gray-50 text-gray-700 transition cursor-pointer shadow-2xs"
              title="Evaluate overdue deadlines and dispatch in-app notifications"
            >
              <RefreshCw className={`w-3.5 h-3.5 text-blue-600 ${runningEvaluator ? 'animate-spin' : ''}`} />
              <span>{runningEvaluator ? 'Evaluating...' : 'Run Reminders'}</span>
            </button>
            <button
              type="button"
              onClick={onClose}
              className="p-1 rounded text-gray-400 hover:text-gray-700 hover:bg-gray-200 transition cursor-pointer"
            >
              <X className="w-5 h-5" />
            </button>
          </div>
        </div>

        {/* Filter Tabs */}
        <div className="flex items-center gap-1.5 p-3 border-b border-gray-200 bg-white overflow-x-auto text-xs no-scrollbar">
          <button
            type="button"
            onClick={() => setActiveFilter('all')}
            className={`px-2.5 py-1 rounded-full font-medium transition border cursor-pointer ${
              activeFilter === 'all'
                ? 'bg-slate-800 text-white border-slate-800'
                : 'bg-gray-50 text-gray-600 border-gray-200 hover:bg-gray-100'
            }`}
          >
            All Work ({counts.all})
          </button>
          <button
            type="button"
            onClick={() => setActiveFilter('overdue')}
            className={`px-2.5 py-1 rounded-full font-medium transition border cursor-pointer ${
              activeFilter === 'overdue'
                ? 'bg-rose-600 text-white border-rose-600'
                : 'bg-rose-50 text-rose-700 border-rose-200 hover:bg-rose-100'
            }`}
          >
            🔴 Overdue ({counts.overdue})
          </button>
          <button
            type="button"
            onClick={() => setActiveFilter('due_today')}
            className={`px-2.5 py-1 rounded-full font-medium transition border cursor-pointer ${
              activeFilter === 'due_today'
                ? 'bg-amber-600 text-white border-amber-600'
                : 'bg-amber-50 text-amber-700 border-amber-200 hover:bg-amber-100'
            }`}
          >
            🟠 Due Today ({counts.dueToday})
          </button>
          <button
            type="button"
            onClick={() => setActiveFilter('waiting_manufacturer')}
            className={`px-2.5 py-1 rounded-full font-medium transition border cursor-pointer ${
              activeFilter === 'waiting_manufacturer'
                ? 'bg-cyan-600 text-white border-cyan-600'
                : 'bg-cyan-50 text-cyan-700 border-cyan-200 hover:bg-cyan-100'
            }`}
          >
            🏭 Waiting Manufacturer ({counts.waitingManufacturer})
          </button>
          <button
            type="button"
            onClick={() => setActiveFilter('waiting_india')}
            className={`px-2.5 py-1 rounded-full font-medium transition border cursor-pointer ${
              activeFilter === 'waiting_india'
                ? 'bg-purple-600 text-white border-purple-600'
                : 'bg-purple-50 text-purple-700 border-purple-200 hover:bg-purple-100'
            }`}
          >
            🇮🇳 Waiting India ({counts.waitingIndia})
          </button>
          <button
            type="button"
            onClick={() => setActiveFilter('blocked')}
            className={`px-2.5 py-1 rounded-full font-medium transition border cursor-pointer ${
              activeFilter === 'blocked'
                ? 'bg-rose-700 text-white border-rose-700'
                : 'bg-rose-50 text-rose-800 border-rose-200 hover:bg-rose-100'
            }`}
          >
            🛑 Blocked ({counts.blocked})
          </button>
          <button
            type="button"
            onClick={() => setActiveFilter('unassigned')}
            className={`px-2.5 py-1 rounded-full font-medium transition border cursor-pointer ${
              activeFilter === 'unassigned'
                ? 'bg-gray-800 text-white border-gray-800'
                : 'bg-gray-50 text-gray-700 border-gray-200 hover:bg-gray-100'
            }`}
          >
            👤 Unassigned ({counts.unassigned})
          </button>
        </div>

        {/* Work Items List */}
        <div className="flex-1 overflow-y-auto p-4 space-y-2.5 text-xs">
          {loading ? (
            <div className="p-12 text-center text-gray-500 space-y-2">
              <div className="inline-block w-6 h-6 border-2 border-amber-600 border-t-transparent rounded-full animate-spin" />
              <p className="text-xs">Loading India operational queue...</p>
            </div>
          ) : filteredItems.length === 0 ? (
            <div className="p-10 text-center rounded-lg border border-dashed border-gray-300 bg-gray-50/50 space-y-1.5">
              <CheckCircle2 className="w-8 h-8 text-emerald-500 mx-auto" />
              <p className="text-gray-700 text-xs font-semibold">No pending work in this bucket</p>
              <p className="text-gray-400 text-[11px]">
                All India and manufacturer requests for this filter are cleared.
              </p>
            </div>
          ) : (
            filteredItems.map(item => (
              <div
                key={item.id}
                onClick={() => {
                  onSelectEnquiry(item.inquiryId);
                  onClose();
                }}
                className={`p-3 rounded-lg border transition shadow-2xs hover:border-blue-400 cursor-pointer flex items-start justify-between gap-3 group ${
                  item.isOverdue
                    ? 'bg-rose-50/30 border-rose-200'
                    : item.status === 'BLOCKED'
                    ? 'bg-rose-50/20 border-rose-200'
                    : 'bg-white border-gray-200'
                }`}
              >
                <div className="space-y-1.5 min-w-0 flex-1">
                  {/* Top Line: Enquiry & Request Codes */}
                  <div className="flex flex-wrap items-center gap-1.5">
                    <span className="font-bold text-gray-900 group-hover:text-blue-600 transition">
                      {item.inquiryNumber}
                    </span>
                    <span className="text-gray-300">·</span>
                    <span className="font-semibold text-gray-800">{item.requestCode}</span>
                    <span className="text-gray-300">·</span>
                    <span className="text-gray-700 font-medium">{item.requestTitle}</span>

                    {/* Due / Overdue Badge */}
                    {item.isOverdue ? (
                      <span className="px-1.5 py-0.2 rounded border bg-rose-100 text-rose-800 border-rose-300 text-[10px] font-bold uppercase">
                        🔴 Overdue ({item.daysOverdue}d)
                      </span>
                    ) : item.isDueToday ? (
                      <span className="px-1.5 py-0.2 rounded border bg-amber-100 text-amber-800 border-amber-300 text-[10px] font-bold uppercase">
                        🟠 Due Today
                      </span>
                    ) : null}

                    {/* Waiting Badge */}
                    <span className="px-1.5 py-0.2 rounded border text-[10px] font-medium bg-cyan-50 text-cyan-700 border-cyan-200">
                      Waiting: {item.waitingFor}
                    </span>
                  </div>

                  {/* Customer Requirement text */}
                  <div className="text-gray-700 font-medium bg-gray-50/70 p-2 rounded border border-gray-200/60 leading-relaxed">
                    {item.customerRequirement}
                  </div>

                  {/* Blocker or Next Action banner */}
                  {item.currentIssue && (
                    <div className="flex items-center gap-1.5 text-rose-700 font-medium text-[11px] bg-rose-50/80 px-2 py-1 rounded border border-rose-200">
                      <ShieldAlert className="w-3.5 h-3.5 flex-shrink-0" />
                      <span>Blocker: {item.currentIssue}</span>
                    </div>
                  )}

                  {item.nextAction && (
                    <div className="flex items-center gap-1.5 text-blue-700 font-medium text-[11px] bg-blue-50/80 px-2 py-1 rounded border border-blue-200">
                      <ArrowRight className="w-3.5 h-3.5 flex-shrink-0" />
                      <span>Next Action: {item.nextAction}</span>
                    </div>
                  )}

                  {/* Context footer: Company, Product, Owner, Task */}
                  <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-[11px] text-gray-500 pt-1">
                    <span className="flex items-center gap-1 font-medium text-gray-700">
                      <Building className="w-3 h-3 text-gray-400" />
                      {item.companyName}
                    </span>
                    <span>Product: <strong className="text-gray-700">{item.productName}</strong></span>
                    <span>
                      Owner: <strong className="text-gray-700">{item.assignedToName || 'Unassigned'}</strong>
                    </span>
                    {item.taskTitle && (
                      <span className="inline-flex items-center gap-1 text-purple-700 font-medium">
                        <span>Task:</span>
                        <strong className="underline decoration-purple-300">{item.taskTitle}</strong>
                        {item.taskAssignee && <span>({item.taskAssignee})</span>}
                      </span>
                    )}
                  </div>
                </div>

                <div className="flex-shrink-0 self-center">
                  <span className="p-1.5 rounded-full bg-gray-100 group-hover:bg-blue-600 group-hover:text-white text-gray-400 transition inline-flex items-center">
                    <ChevronRight className="w-4 h-4" />
                  </span>
                </div>
              </div>
            ))
          )}
        </div>
      </div>
    </div>
  );
};
