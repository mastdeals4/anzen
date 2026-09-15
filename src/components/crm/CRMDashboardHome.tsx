import React, { useEffect, useState, useMemo } from 'react';
import {
  Inbox,
  Clock,
  Send,
  AlertTriangle,
  CheckCircle2,
  XCircle,
  ArrowDown,
  UserX,
  FileQuestion,
  Search,
  DollarSign,
  SlidersHorizontal,
  ChevronRight,
  TrendingUp,
  Building2,
  Globe2,
  Calendar,
  Layers,
  ArrowRight,
  Mail,
  Zap,
} from 'lucide-react';
import { supabase } from '../../lib/supabase';
import { Inquiry } from '../../pages/CRM';

interface Props {
  inquiries: Inquiry[];
  onNavigateTab: (tab: any, filters?: Record<string, any>) => void;
  canManage?: boolean;
}

export function CRMDashboardHome({ inquiries, onNavigateTab, canManage }: Props) {
  const [requestCounts, setRequestCounts] = useState<{
    waitingIndia: number;
    waitingManufacturer: number;
    waitingCustomer: number;
    blocked: number;
    overdue: number;
  }>({
    waitingIndia: 0,
    waitingManufacturer: 0,
    waitingCustomer: 0,
    blocked: 0,
    overdue: 0,
  });

  useEffect(() => {
    let cancelled = false;
    async function loadRequestStats() {
      try {
        const { data, error } = await supabase
          .from('enquiry_requests')
          .select('status, waiting_for, due_at')
          .in('status', ['OPEN', 'IN_PROGRESS', 'BLOCKED']);

        if (error || !data || cancelled) return;

        const now = Date.now();
        let waitingIndia = 0;
        let waitingManufacturer = 0;
        let waitingCustomer = 0;
        let blocked = 0;
        let overdue = 0;

        for (const r of data) {
          if (r.status === 'BLOCKED') blocked++;
          if (r.waiting_for === 'INDIA') waitingIndia++;
          if (r.waiting_for === 'MANUFACTURER') waitingManufacturer++;
          if (r.waiting_for === 'CUSTOMER') waitingCustomer++;
          if (r.due_at && new Date(r.due_at).getTime() < now) overdue++;
        }

        setRequestCounts({
          waitingIndia,
          waitingManufacturer,
          waitingCustomer,
          blocked,
          overdue,
        });
      } catch (err) {
        console.error('Failed to load enquiry request stats:', err);
      }
    }
    loadRequestStats();
    return () => {
      cancelled = true;
    };
  }, []);

  // Compute live pipeline metrics from inquiries
  const stats = useMemo(() => {
    const now = new Date();
    now.setHours(0, 0, 0, 0);

    let newEnquiries = 0;
    let understanding = 0;
    let priceReady = 0;
    let quoteSent = 0;
    let followUp = 0;
    let won = 0;
    let lost = 0;

    let unassigned = 0;
    let followUpsDue = 0;

    for (const inq of inquiries) {
      if (!inq.assigned_to) unassigned++;

      if (inq.next_follow_up) {
        const fuDate = new Date(inq.next_follow_up);
        if (fuDate <= new Date()) {
          followUpsDue++;
        }
      }

      // Stage categorization
      if (inq.pipeline_status === 'won') {
        won++;
      } else if (inq.pipeline_status === 'lost') {
        lost++;
      } else if (inq.price_ready) {
        priceReady++;
      } else if (inq.pipeline_status === 'quoted' || inq.quote_sent_at) {
        quoteSent++;
      } else if (inq.pipeline_status === 'negotiating') {
        followUp++;
      } else if (inq.pipeline_status === 'new' || inq.status === 'new' || !inq.pipeline_status) {
        newEnquiries++;
      } else {
        understanding++;
      }
    }

    return {
      newEnquiries,
      understanding,
      priceReady,
      quoteSent,
      followUp,
      won,
      lost,
      unassigned,
      followUpsDue,
      totalActive: inquiries.filter(i => i.pipeline_status !== 'lost').length,
    };
  }, [inquiries]);

  return (
    <div className="space-y-5 pb-6">
      {/* ── HEADER BANNER ────────────────────────────────────────── */}
      <div className="flex flex-col md:flex-row items-start md:items-center justify-between gap-3 bg-gradient-to-r from-slate-900 via-indigo-950 to-slate-900 text-white p-4 rounded-xl shadow-sm border border-slate-800">
        <div>
          <div className="flex items-center gap-2">
            <span className="inline-flex items-center px-2 py-0.5 rounded text-[10px] font-semibold bg-indigo-500/20 text-indigo-300 border border-indigo-400/30">
              SALES DESK
            </span>
            <h2 className="text-lg font-bold tracking-tight text-white">CRM Operations Overview</h2>
          </div>
          <p className="text-xs text-slate-300 mt-0.5">
            Real-time enquiry flow and actionable queues for the sales team. Click any card or stage to take action.
          </p>
        </div>

        <div className="flex items-center gap-2 flex-wrap">
          <button
            onClick={() => onNavigateTab('control-center')}
            className="inline-flex items-center gap-1.5 px-3 py-1.5 bg-indigo-600 hover:bg-indigo-500 text-white text-xs font-semibold rounded-lg shadow-sm transition"
          >
            <SlidersHorizontal className="w-3.5 h-3.5" />
            Open Control Center
          </button>
          <button
            onClick={() => onNavigateTab('work')}
            className="inline-flex items-center gap-1.5 px-3 py-1.5 bg-white/10 hover:bg-white/20 text-white text-xs font-semibold rounded-lg transition border border-white/10"
          >
            <Clock className="w-3.5 h-3.5" />
            Today's Work Queue
          </button>
        </div>
      </div>

      {/* ── ACTION BOXES (HIGH ATTENTION) ────────────────────────── */}
      <div>
        <div className="flex items-center justify-between mb-2">
          <h3 className="text-xs font-bold text-gray-700 uppercase tracking-wider flex items-center gap-1.5">
            <Zap className="w-3.5 h-3.5 text-amber-600" />
            Priority Action Queues
          </h3>
          <span className="text-[11px] text-gray-500 font-medium">Click to inspect filtered work</span>
        </div>

        <div className="grid grid-cols-2 sm:grid-cols-4 lg:grid-cols-8 gap-2.5">
          {/* Overdue */}
          <button
            onClick={() => onNavigateTab('control-center', { filter: 'overdue' })}
            className={`p-2.5 rounded-lg border text-left transition flex flex-col justify-between ${
              requestCounts.overdue > 0
                ? 'bg-red-50/70 border-red-200 hover:bg-red-100/70 hover:border-red-300'
                : 'bg-white border-gray-200 hover:bg-gray-50'
            }`}
          >
            <div className="flex items-center justify-between">
              <span className="text-[10px] font-bold uppercase text-red-700">Overdue</span>
              <AlertTriangle className="w-3.5 h-3.5 text-red-600" />
            </div>
            <div className="mt-1.5">
              <div className="text-xl font-bold text-red-800 font-mono">{requestCounts.overdue}</div>
              <div className="text-[10px] text-red-600">Past target SLA</div>
            </div>
          </button>

          {/* Follow-ups Due */}
          <button
            onClick={() => onNavigateTab('table', { filter: 'followup_due' })}
            className={`p-2.5 rounded-lg border text-left transition flex flex-col justify-between ${
              stats.followUpsDue > 0
                ? 'bg-amber-50/70 border-amber-200 hover:bg-amber-100/70 hover:border-amber-300'
                : 'bg-white border-gray-200 hover:bg-gray-50'
            }`}
          >
            <div className="flex items-center justify-between">
              <span className="text-[10px] font-bold uppercase text-amber-800">Follow-ups Due</span>
              <Calendar className="w-3.5 h-3.5 text-amber-600" />
            </div>
            <div className="mt-1.5">
              <div className="text-xl font-bold text-amber-900 font-mono">{stats.followUpsDue}</div>
              <div className="text-[10px] text-amber-700">Call / mail customer</div>
            </div>
          </button>

          {/* Waiting Customer */}
          <button
            onClick={() => onNavigateTab('control-center', { waitingFor: 'CUSTOMER' })}
            className="p-2.5 rounded-lg border border-purple-200 bg-purple-50/60 hover:bg-purple-100/70 text-left transition flex flex-col justify-between"
          >
            <div className="flex items-center justify-between">
              <span className="text-[10px] font-bold uppercase text-purple-800">Waiting Customer</span>
              <Building2 className="w-3.5 h-3.5 text-purple-600" />
            </div>
            <div className="mt-1.5">
              <div className="text-xl font-bold text-purple-900 font-mono">{requestCounts.waitingCustomer}</div>
              <div className="text-[10px] text-purple-700">Need info/spec</div>
            </div>
          </button>

          {/* Waiting India */}
          <button
            onClick={() => onNavigateTab('control-center', { waitingFor: 'INDIA' })}
            className="p-2.5 rounded-lg border border-blue-200 bg-blue-50/60 hover:bg-blue-100/70 text-left transition flex flex-col justify-between"
          >
            <div className="flex items-center justify-between">
              <span className="text-[10px] font-bold uppercase text-blue-800">Waiting India</span>
              <Globe2 className="w-3.5 h-3.5 text-blue-600" />
            </div>
            <div className="mt-1.5">
              <div className="text-xl font-bold text-blue-900 font-mono">{requestCounts.waitingIndia}</div>
              <div className="text-[10px] text-blue-700">India pricing queue</div>
            </div>
          </button>

          {/* Waiting Manufacturer */}
          <button
            onClick={() => onNavigateTab('control-center', { waitingFor: 'MANUFACTURER' })}
            className="p-2.5 rounded-lg border border-indigo-200 bg-indigo-50/60 hover:bg-indigo-100/70 text-left transition flex flex-col justify-between"
          >
            <div className="flex items-center justify-between">
              <span className="text-[10px] font-bold uppercase text-indigo-800">Waiting Mfr</span>
              <Layers className="w-3.5 h-3.5 text-indigo-600" />
            </div>
            <div className="mt-1.5">
              <div className="text-xl font-bold text-indigo-900 font-mono">{requestCounts.waitingManufacturer}</div>
              <div className="text-[10px] text-indigo-700">COA / factory cost</div>
            </div>
          </button>

          {/* Price Ready */}
          <button
            onClick={() => onNavigateTab('control-center', { filter: 'price_ready' })}
            className="p-2.5 rounded-lg border border-emerald-200 bg-emerald-50/70 hover:bg-emerald-100/70 text-left transition flex flex-col justify-between"
          >
            <div className="flex items-center justify-between">
              <span className="text-[10px] font-bold uppercase text-emerald-800">Price Ready</span>
              <DollarSign className="w-3.5 h-3.5 text-emerald-600" />
            </div>
            <div className="mt-1.5">
              <div className="text-xl font-bold text-emerald-900 font-mono">{stats.priceReady}</div>
              <div className="text-[10px] text-emerald-700">Ready to quote</div>
            </div>
          </button>

          {/* Blocked */}
          <button
            onClick={() => onNavigateTab('control-center', { status: 'BLOCKED' })}
            className={`p-2.5 rounded-lg border text-left transition flex flex-col justify-between ${
              requestCounts.blocked > 0
                ? 'bg-rose-50/80 border-rose-300 hover:bg-rose-100/80'
                : 'bg-white border-gray-200 hover:bg-gray-50'
            }`}
          >
            <div className="flex items-center justify-between">
              <span className="text-[10px] font-bold uppercase text-rose-800">Blocked</span>
              <XCircle className="w-3.5 h-3.5 text-rose-600" />
            </div>
            <div className="mt-1.5">
              <div className="text-xl font-bold text-rose-900 font-mono">{requestCounts.blocked}</div>
              <div className="text-[10px] text-rose-700">Requires escalation</div>
            </div>
          </button>

          {/* Unassigned */}
          <button
            onClick={() => onNavigateTab('table', { filter: 'unassigned' })}
            className="p-2.5 rounded-lg border border-gray-200 bg-white hover:bg-gray-50 text-left transition flex flex-col justify-between"
          >
            <div className="flex items-center justify-between">
              <span className="text-[10px] font-bold uppercase text-gray-700">Unassigned</span>
              <UserX className="w-3.5 h-3.5 text-gray-500" />
            </div>
            <div className="mt-1.5">
              <div className="text-xl font-bold text-gray-900 font-mono">{stats.unassigned}</div>
              <div className="text-[10px] text-gray-500">Need salesperson</div>
            </div>
          </button>
        </div>
      </div>

      {/* ── VISUAL FLOWCHART OVERVIEW ────────────────────────────── */}
      <div className="bg-white border border-gray-200 rounded-xl p-4 shadow-xs">
        <div className="flex items-center justify-between mb-4 border-b border-gray-100 pb-2">
          <div>
            <h3 className="text-xs font-bold text-gray-800 uppercase tracking-wider flex items-center gap-1.5">
              <TrendingUp className="w-4 h-4 text-indigo-600" />
              Enquiry Lifecycle Pipeline
            </h3>
            <p className="text-[11px] text-gray-500">
              Visual pipeline from incoming communication to final won/lost outcome
            </p>
          </div>
          <div className="text-xs font-semibold text-gray-600">
            Total Active: <span className="font-mono text-indigo-700 font-bold">{stats.totalActive}</span>
          </div>
        </div>

        {/* Vertical Connected Flow-Chart */}
        <div className="space-y-3 max-w-3xl mx-auto py-2">
          {/* 1. NEW ENQUIRIES */}
          <div className="relative group">
            <button
              onClick={() => onNavigateTab('control-center', { pipelineStatus: 'new' })}
              className="w-full flex items-center justify-between p-3.5 rounded-xl border-2 border-indigo-200 bg-indigo-50/50 hover:bg-indigo-50 hover:border-indigo-300 transition text-left shadow-xs"
            >
              <div className="flex items-center gap-3">
                <div className="w-8 h-8 rounded-lg bg-indigo-600 text-white flex items-center justify-center font-bold text-xs shadow-xs">
                  1
                </div>
                <div>
                  <div className="text-xs font-bold text-indigo-950 uppercase tracking-wide flex items-center gap-2">
                    <span>New Enquiries</span>
                    <span className="text-[10px] font-medium text-indigo-700 bg-indigo-100/70 px-1.5 py-0.2 rounded">
                      Inbox & Direct
                    </span>
                  </div>
                  <div className="text-[11px] text-indigo-700 mt-0.5">
                    Newly received emails, WhatsApps, or manually recorded inquiries
                  </div>
                </div>
              </div>
              <div className="flex items-center gap-3">
                <div className="text-right">
                  <div className="text-xl font-bold font-mono text-indigo-950">{stats.newEnquiries}</div>
                  <div className="text-[10px] text-indigo-600">enquiries</div>
                </div>
                <ChevronRight className="w-4 h-4 text-indigo-400 group-hover:translate-x-0.5 transition" />
              </div>
            </button>

            {/* Connecting Arrow */}
            <div className="flex justify-center my-1 text-indigo-300">
              <ArrowDown className="w-4 h-4 stroke-[2.5]" />
            </div>
          </div>

          {/* 2. UNDERSTANDING / REQUIREMENT */}
          <div className="relative group">
            <button
              onClick={() => onNavigateTab('control-center', { pipelineStatus: 'in_progress' })}
              className="w-full flex items-center justify-between p-3.5 rounded-xl border border-blue-200 bg-blue-50/40 hover:bg-blue-50 hover:border-blue-300 transition text-left shadow-xs"
            >
              <div className="flex items-center gap-3">
                <div className="w-8 h-8 rounded-lg bg-blue-600 text-white flex items-center justify-center font-bold text-xs shadow-xs">
                  2
                </div>
                <div>
                  <div className="text-xs font-bold text-blue-950 uppercase tracking-wide flex items-center gap-2">
                    <span>Understanding / Requirement</span>
                    <span className="text-[10px] font-medium text-blue-700 bg-blue-100/70 px-1.5 py-0.2 rounded">
                      Enquiry Brain
                    </span>
                  </div>
                  <div className="text-[11px] text-blue-700 mt-0.5">
                    Customer requirement extraction, specifications, and scope clarification
                  </div>
                </div>
              </div>
              <div className="flex items-center gap-3">
                <div className="text-right">
                  <div className="text-xl font-bold font-mono text-blue-950">{stats.understanding}</div>
                  <div className="text-[10px] text-blue-600">in progress</div>
                </div>
                <ChevronRight className="w-4 h-4 text-blue-400 group-hover:translate-x-0.5 transition" />
              </div>
            </button>

            {/* Connecting Arrow */}
            <div className="flex justify-center my-1 text-blue-300">
              <ArrowDown className="w-4 h-4 stroke-[2.5]" />
            </div>
          </div>

          {/* 3. WAITING FOR STAKEHOLDERS */}
          <div className="relative">
            <div className="p-3.5 rounded-xl border border-amber-200 bg-amber-50/40 shadow-xs">
              <div className="flex items-center justify-between mb-2">
                <div className="flex items-center gap-3">
                  <div className="w-8 h-8 rounded-lg bg-amber-600 text-white flex items-center justify-center font-bold text-xs shadow-xs">
                    3
                  </div>
                  <div>
                    <div className="text-xs font-bold text-amber-950 uppercase tracking-wide">
                      Pending Action & Input
                    </div>
                    <div className="text-[11px] text-amber-800">
                      Work routed to specialized stakeholders before pricing can complete
                    </div>
                  </div>
                </div>
                <div className="text-xs font-bold text-amber-900 font-mono">
                  {requestCounts.waitingCustomer + requestCounts.waitingIndia + requestCounts.waitingManufacturer} pending
                </div>
              </div>

              {/* 3 Sub-Branches */}
              <div className="grid grid-cols-1 sm:grid-cols-3 gap-2 mt-2 pt-2 border-t border-amber-200/60">
                <button
                  onClick={() => onNavigateTab('control-center', { waitingFor: 'CUSTOMER' })}
                  className="p-2.5 rounded-lg bg-white border border-amber-200 hover:border-amber-400 hover:bg-amber-50/50 transition text-left flex items-center justify-between"
                >
                  <div>
                    <div className="text-[11px] font-bold text-gray-800">Waiting Customer</div>
                    <div className="text-[10px] text-gray-500">Spec / Qty confirmation</div>
                  </div>
                  <div className="text-base font-bold font-mono text-purple-700">{requestCounts.waitingCustomer}</div>
                </button>

                <button
                  onClick={() => onNavigateTab('control-center', { waitingFor: 'INDIA' })}
                  className="p-2.5 rounded-lg bg-white border border-amber-200 hover:border-amber-400 hover:bg-amber-50/50 transition text-left flex items-center justify-between"
                >
                  <div>
                    <div className="text-[11px] font-bold text-gray-800">Waiting India</div>
                    <div className="text-[10px] text-gray-500">Kunal pricing request</div>
                  </div>
                  <div className="text-base font-bold font-mono text-blue-700">{requestCounts.waitingIndia}</div>
                </button>

                <button
                  onClick={() => onNavigateTab('control-center', { waitingFor: 'MANUFACTURER' })}
                  className="p-2.5 rounded-lg bg-white border border-amber-200 hover:border-amber-400 hover:bg-amber-50/50 transition text-left flex items-center justify-between"
                >
                  <div>
                    <div className="text-[11px] font-bold text-gray-800">Waiting Mfr</div>
                    <div className="text-[10px] text-gray-500">Factory lead time / COA</div>
                  </div>
                  <div className="text-base font-bold font-mono text-indigo-700">{requestCounts.waitingManufacturer}</div>
                </button>
              </div>
            </div>

            {/* Connecting Arrow */}
            <div className="flex justify-center my-1 text-amber-300">
              <ArrowDown className="w-4 h-4 stroke-[2.5]" />
            </div>
          </div>

          {/* 4. PRICING READY */}
          <div className="relative group">
            <button
              onClick={() => onNavigateTab('control-center', { filter: 'price_ready' })}
              className="w-full flex items-center justify-between p-3.5 rounded-xl border border-emerald-300 bg-emerald-50/50 hover:bg-emerald-50 hover:border-emerald-400 transition text-left shadow-xs"
            >
              <div className="flex items-center gap-3">
                <div className="w-8 h-8 rounded-lg bg-emerald-600 text-white flex items-center justify-center font-bold text-xs shadow-xs">
                  4
                </div>
                <div>
                  <div className="text-xs font-bold text-emerald-950 uppercase tracking-wide flex items-center gap-2">
                    <span>Pricing Ready</span>
                    <span className="text-[10px] font-medium text-emerald-800 bg-emerald-200/60 px-1.5 py-0.2 rounded">
                      Action Required
                    </span>
                  </div>
                  <div className="text-[11px] text-emerald-700 mt-0.5">
                    Supplier & India cost confirmed. Ready to generate sales quotation.
                  </div>
                </div>
              </div>
              <div className="flex items-center gap-3">
                <div className="text-right">
                  <div className="text-xl font-bold font-mono text-emerald-950">{stats.priceReady}</div>
                  <div className="text-[10px] text-emerald-700">quote ready</div>
                </div>
                <ChevronRight className="w-4 h-4 text-emerald-500 group-hover:translate-x-0.5 transition" />
              </div>
            </button>

            {/* Connecting Arrow */}
            <div className="flex justify-center my-1 text-emerald-300">
              <ArrowDown className="w-4 h-4 stroke-[2.5]" />
            </div>
          </div>

          {/* 5. QUOTE SENT */}
          <div className="relative group">
            <button
              onClick={() => onNavigateTab('table', { pipeline_status: 'quoted' })}
              className="w-full flex items-center justify-between p-3.5 rounded-xl border border-teal-200 bg-teal-50/40 hover:bg-teal-50 hover:border-teal-300 transition text-left shadow-xs"
            >
              <div className="flex items-center gap-3">
                <div className="w-8 h-8 rounded-lg bg-teal-600 text-white flex items-center justify-center font-bold text-xs shadow-xs">
                  5
                </div>
                <div>
                  <div className="text-xs font-bold text-teal-950 uppercase tracking-wide">Quote Sent</div>
                  <div className="text-[11px] text-teal-700 mt-0.5">
                    Official quote delivered to customer via email / PDF
                  </div>
                </div>
              </div>
              <div className="flex items-center gap-3">
                <div className="text-right">
                  <div className="text-xl font-bold font-mono text-teal-950">{stats.quoteSent}</div>
                  <div className="text-[10px] text-teal-600">quotes sent</div>
                </div>
                <ChevronRight className="w-4 h-4 text-teal-400 group-hover:translate-x-0.5 transition" />
              </div>
            </button>

            {/* Connecting Arrow */}
            <div className="flex justify-center my-1 text-teal-300">
              <ArrowDown className="w-4 h-4 stroke-[2.5]" />
            </div>
          </div>

          {/* 6. FOLLOW-UP */}
          <div className="relative group">
            <button
              onClick={() => onNavigateTab('table', { pipeline_status: 'negotiating' })}
              className="w-full flex items-center justify-between p-3.5 rounded-xl border border-sky-200 bg-sky-50/40 hover:bg-sky-50 hover:border-sky-300 transition text-left shadow-xs"
            >
              <div className="flex items-center gap-3">
                <div className="w-8 h-8 rounded-lg bg-sky-600 text-white flex items-center justify-center font-bold text-xs shadow-xs">
                  6
                </div>
                <div>
                  <div className="text-xs font-bold text-sky-950 uppercase tracking-wide">Follow-Up & Negotiation</div>
                  <div className="text-[11px] text-sky-700 mt-0.5">
                    Customer evaluating price, negotiation, sample approvals, delivery schedule
                  </div>
                </div>
              </div>
              <div className="flex items-center gap-3">
                <div className="text-right">
                  <div className="text-xl font-bold font-mono text-sky-950">{stats.followUp}</div>
                  <div className="text-[10px] text-sky-600">negotiating</div>
                </div>
                <ChevronRight className="w-4 h-4 text-sky-400 group-hover:translate-x-0.5 transition" />
              </div>
            </button>

            {/* Connecting Arrow */}
            <div className="flex justify-center my-1 text-sky-300">
              <ArrowDown className="w-4 h-4 stroke-[2.5]" />
            </div>
          </div>

          {/* 7. WON / LOST OUTCOME */}
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-3 pt-1">
            <button
              onClick={() => onNavigateTab('table', { pipeline_status: 'won' })}
              className="p-3.5 rounded-xl border-2 border-emerald-300 bg-emerald-50/60 hover:bg-emerald-100/60 transition text-left flex items-center justify-between shadow-xs"
            >
              <div className="flex items-center gap-3">
                <CheckCircle2 className="w-7 h-7 text-emerald-600" />
                <div>
                  <div className="text-xs font-bold text-emerald-950 uppercase tracking-wide">Won Orders</div>
                  <div className="text-[11px] text-emerald-700">Converted to Sales Order / Contract</div>
                </div>
              </div>
              <div className="text-2xl font-bold font-mono text-emerald-900">{stats.won}</div>
            </button>

            <button
              onClick={() => onNavigateTab('archive', { pipeline_status: 'lost' })}
              className="p-3.5 rounded-xl border border-gray-300 bg-gray-50/70 hover:bg-gray-100 transition text-left flex items-center justify-between shadow-xs"
            >
              <div className="flex items-center gap-3">
                <XCircle className="w-7 h-7 text-gray-500" />
                <div>
                  <div className="text-xs font-bold text-gray-800 uppercase tracking-wide">Lost / Closed</div>
                  <div className="text-[11px] text-gray-500">Archived with competitor / price reasons</div>
                </div>
              </div>
              <div className="text-2xl font-bold font-mono text-gray-700">{stats.lost}</div>
            </button>
          </div>
        </div>
      </div>

      {/* ── QUICK SHORTCUTS TOOLBAR ──────────────────────────────── */}
      <div className="bg-gray-50 border border-gray-200 rounded-xl p-3 flex flex-wrap items-center justify-between gap-2">
        <span className="text-xs font-semibold text-gray-600">Quick Tools:</span>
        <div className="flex flex-wrap items-center gap-2">
          <button
            onClick={() => onNavigateTab('control-center')}
            className="px-2.5 py-1 text-xs font-medium text-purple-700 bg-purple-50 hover:bg-purple-100 border border-purple-200 rounded-md transition"
          >
            Control Center
          </button>
          <button
            onClick={() => onNavigateTab('work')}
            className="px-2.5 py-1 text-xs font-medium text-purple-700 bg-purple-50 hover:bg-purple-100 border border-purple-200 rounded-md transition"
          >
            Today's Work
          </button>
          <button
            onClick={() => onNavigateTab('table')}
            className="px-2.5 py-1 text-xs font-medium text-blue-700 bg-blue-50 hover:bg-blue-100 border border-blue-200 rounded-md transition"
          >
            Inquiries Table
          </button>
          <button
            onClick={() => onNavigateTab('pipeline')}
            className="px-2.5 py-1 text-xs font-medium text-blue-700 bg-blue-50 hover:bg-blue-100 border border-blue-200 rounded-md transition"
          >
            Pipeline Kanban
          </button>
          <button
            onClick={() => onNavigateTab('email')}
            className="px-2.5 py-1 text-xs font-medium text-blue-700 bg-blue-50 hover:bg-blue-100 border border-blue-200 rounded-md transition"
          >
            Email Inbox
          </button>
          <button
            onClick={() => onNavigateTab('customer-360')}
            className="px-2.5 py-1 text-xs font-medium text-gray-700 bg-white hover:bg-gray-100 border border-gray-200 rounded-md transition"
          >
            Customer 360
          </button>
        </div>
      </div>
    </div>
  );
}
