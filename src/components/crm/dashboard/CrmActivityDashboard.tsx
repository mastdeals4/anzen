import React, { useEffect, useState, useMemo } from 'react';
import { supabase } from '../../../lib/supabase';
import { useAuth } from '../../../contexts/AuthContext';
import {
  Inbox,
  Clock,
  Calendar,
  CheckSquare,
  AlertTriangle,
  Building,
  User,
  ExternalLink,
  ChevronRight,
  TrendingUp,
  MessageSquare,
  Mail,
  Phone,
  Sparkles,
  Tag,
  CheckCircle2,
  FileText,
  DollarSign,
  ArrowRight,
  RefreshCw,
  MoreVertical,
} from 'lucide-react';

interface Props {
  onOpenInquiry?: (inquiryId: string) => void;
  onOpenCustomer?: (customerId: string) => void;
  onNavigateTab?: (tab: string, params?: Record<string, any>) => void;
}

export function CrmActivityDashboard({
  onOpenInquiry,
  onOpenCustomer,
  onNavigateTab,
}: Props) {
  const { user, profile } = useAuth();
  const [loading, setLoading] = useState(true);

  // Salesperson filter
  const [salesMembers, setSalesMembers] = useState<any[]>([]);
  const [selectedSalesMemberId, setSelectedSalesMemberId] = useState<string>('all');

  // Indicators
  const [tasksDueToday, setTasksDueToday] = useState(0);
  const [overdueTasks, setOverdueTasks] = useState(0);
  const [waitingCustomer, setWaitingCustomer] = useState(0);
  const [meetingsThisWeek, setMeetingsThisWeek] = useState(0);

  // Left Column Data
  const [contacts, setContacts] = useState<any[]>([]);
  const [totalContactsCount, setTotalContactsCount] = useState<number>(0);
  const [accounts, setAccounts] = useState<any[]>([]);
  const [totalAccountsCount, setTotalAccountsCount] = useState<number>(0);
  const [inquiries, setInquiries] = useState<any[]>([]);
  const [tasks, setTasks] = useState<any[]>([]);
  const [appointments, setAppointments] = useState<any[]>([]);
  const [appointmentFilter, setAppointmentFilter] = useState<'all' | 'confirmed' | 'cancelled' | 'pending'>('all');
  const [stageFilter, setStageFilter] = useState<string>('all');

  // Right Column Activity Stream
  const [timelineItems, setTimelineItems] = useState<any[]>([]);

  useEffect(() => {
    loadSalesMembers();
  }, []);

  useEffect(() => {
    loadDashboardData(selectedSalesMemberId);
  }, [selectedSalesMemberId]);

  const loadSalesMembers = async () => {
    try {
      const { data } = await supabase
        .from('sales_team_members')
        .select('id, name, email')
        .eq('is_active', true)
        .order('name');
      setSalesMembers(data || []);
    } catch (err) {
      console.error('Error loading sales members:', err);
    }
  };

  const loadDashboardData = async (memberId: string = 'all') => {
    setLoading(true);
    try {
      const now = new Date();
      const startOfDay = new Date(now.getFullYear(), now.getMonth(), now.getDate()).toISOString();
      const endOfDay = new Date(now.getFullYear(), now.getMonth(), now.getDate(), 23, 59, 59).toISOString();
      
      const startOfWeek = new Date(now);
      startOfWeek.setDate(now.getDate() - now.getDay());
      const endOfWeek = new Date(startOfWeek);
      endOfWeek.setDate(startOfWeek.getDate() + 7);

      // Check for assigned contacts if a specific salesperson is selected
      let assignedContactIds: string[] = [];
      let assignedCustomerIds: string[] = [];
      if (memberId !== 'all') {
        const { data: assignments } = await supabase
          .from('customer_assignments')
          .select('crm_contact_id, customer_id')
          .eq('sales_member_id', memberId)
          .eq('is_active', true);

        if (assignments) {
          assignedContactIds = assignments.map(a => a.crm_contact_id).filter(Boolean);
          assignedCustomerIds = assignments.map(a => a.customer_id).filter(Boolean);
        }
      }

      // 1. Fetch Indicators & Tasks from tasks table
      let taskQuery = supabase
        .from('tasks')
        .select('*')
        .eq('is_deleted', false)
        .order('deadline', { ascending: true });

      if (memberId !== 'all') {
        taskQuery = taskQuery.contains('assigned_users', [memberId]);
      }

      const { data: allTasks } = await taskQuery.limit(20);

      const taskList = allTasks || [];
      const dueTodayCount = taskList.filter(
        t => t.status !== 'completed' && t.deadline >= startOfDay && t.deadline <= endOfDay
      ).length;
      const overdueCount = taskList.filter(
        t => t.status !== 'completed' && t.deadline < startOfDay
      ).length;

      setTasksDueToday(dueTodayCount);
      setOverdueTasks(overdueCount);
      setTasks(taskList.slice(0, 5));

      // 2. Fetch Waiting for Customer from crm_inquiries
      const { data: inqData } = await supabase
        .from('crm_inquiries')
        .select('*')
        .order('created_at', { ascending: false })
        .limit(25);

      const inqList = inqData || [];
      const waitingCount = inqList.filter(i =>
        i.pipeline_status === 'PRICE_SENT' ||
        i.pipeline_status === 'SAMPLE_SENT' ||
        i.status === 'pending_customer'
      ).length;
      setWaitingCustomer(waitingCount);
      setInquiries(inqList.slice(0, 5));

      // 3. Fetch Contacts (Filtered by salesperson assignments if selected)
      let contactsQuery = supabase
        .from('crm_contacts')
        .select('*', { count: 'exact' })
        .eq('is_active', true)
        .order('created_at', { ascending: false });

      if (memberId !== 'all' && assignedContactIds.length > 0) {
        contactsQuery = contactsQuery.in('id', assignedContactIds);
      } else if (memberId !== 'all') {
        // Salesperson has no assigned contacts yet
        contactsQuery = contactsQuery.in('id', ['00000000-0000-0000-0000-000000000000']);
      }

      const { data: contactsData, count: cCount } = await contactsQuery.limit(20);
      const contactList = contactsData || [];
      setContacts(contactList);
      const effectiveContactsCount = cCount !== null && cCount !== undefined ? cCount : contactList.length;
      setTotalContactsCount(effectiveContactsCount);

      // 4. Fetch Accounts / Companies
      // In SAPJ CRM, companies are tracked via crm_contacts (where each contact represents an account).
      setAccounts(contactList);
      setTotalAccountsCount(effectiveContactsCount);

      // 5. Fetch Appointments / Meetings from crm_activities (scheduled meetings only, excluding phone calls)
      let actsQuery = supabase
        .from('crm_activities')
        .select('*')
        .in('activity_type', ['meeting', 'video_call'])
        .order('follow_up_date', { ascending: true });

      if (memberId !== 'all' && assignedContactIds.length > 0) {
        actsQuery = actsQuery.in('customer_id', assignedContactIds);
      }

      const { data: actData } = await actsQuery.limit(10);

      const appointmentsList = actData || [];
      const thisWeekCount = appointmentsList.filter(a => {
        if (!a.follow_up_date) return false;
        const d = new Date(a.follow_up_date);
        return d >= startOfWeek && d <= endOfWeek;
      }).length;
      setMeetingsThisWeek(thisWeekCount);
      setAppointments(appointmentsList);

      // 6. Build Right Column Timeline Items (Real-time Omnichannel Stream)
      const { data: recentMsgs } = await supabase
        .from('enquiry_conversation_messages')
        .select(`
          id,
          conversation_id,
          sender_name,
          sender_address,
          subject,
          body_text,
          direction,
          received_or_sent_at,
          enquiry_conversations (
            channel,
            title,
            customer_id,
            crm_contact_id
          )
        `)
        .order('received_or_sent_at', { ascending: false })
        .limit(12);

      const stream: any[] = [];
      (recentMsgs || []).forEach(m => {
        const conv = m.enquiry_conversations as any;
        const isWa = conv?.channel === 'whatsapp';
        stream.push({
          id: `msg-${m.id}`,
          type: isWa ? 'whatsapp' : 'email',
          title: isWa ? 'WhatsApp Message' : 'Email Message',
          actor: m.sender_name || (m.direction === 'outbound' ? 'SAPJ Sales Team' : 'Customer'),
          description: m.body_text?.slice(0, 100) || m.subject || 'New message received',
          timestamp: m.received_or_sent_at,
          linkType: 'conversation',
          linkId: m.conversation_id,
          direction: m.direction,
        });
      });

      // Add recent staff activities
      const { data: recentActivities } = await supabase
        .from('crm_activities')
        .select('*')
        .order('created_at', { ascending: false })
        .limit(8);

      (recentActivities || []).forEach(a => {
        stream.push({
          id: `act-${a.id}`,
          type: a.activity_type === 'call' || a.activity_type === 'phone_call' ? 'call' : 'meeting',
          title: a.subject || 'Sales Follow-up Activity',
          actor: profile?.full_name || 'Sales Staff',
          description: a.description || 'Customer interaction recorded',
          timestamp: a.created_at,
          linkType: 'customer',
          linkId: a.customer_id,
        });
      });

      stream.sort((a, b) => new Date(b.timestamp).getTime() - new Date(a.timestamp).getTime());
      setTimelineItems(stream.slice(0, 12));
    } catch (err) {
      console.error('Error loading CRM dashboard data:', err);
    } finally {
      setLoading(false);
    }
  };

  const getGreeting = () => {
    const hour = new Date().getHours();
    if (hour < 12) return 'Good Morning';
    if (hour < 17) return 'Good Afternoon';
    return 'Good Evening';
  };

  const userName = profile?.full_name || user?.email?.split('@')[0] || 'Sales Executive';

  const formatRelativeTime = (isoString?: string | null) => {
    if (!isoString) return 'Recently';
    const diffMs = Date.now() - new Date(isoString).getTime();
    const diffHours = Math.floor(diffMs / 3600000);
    if (diffHours < 1) return 'Just now';
    if (diffHours < 24) return `${diffHours}h ago`;
    const diffDays = Math.floor(diffHours / 24);
    if (diffDays === 1) return 'Yesterday';
    if (diffDays < 30) return `${diffDays} days ago`;
    return `${Math.floor(diffDays / 30)} mo ago`;
  };

  return (
    <div className="space-y-4 animate-in fade-in duration-150">
      {/* Top Welcome Bar & 4 Primary Indicators (Autocloz Image 1 Style) */}
      <div className="bg-white rounded-xl border border-slate-200/90 shadow-2xs p-4 flex flex-col md:flex-row md:items-center justify-between gap-4">
        <div>
          <div className="flex items-center gap-2 flex-wrap">
            <h1 className="text-xl font-bold text-slate-900 tracking-tight">
              {getGreeting()}, <span className="text-blue-600">{userName}</span>
            </h1>
            <span className="px-2 py-0.5 bg-blue-50 text-blue-700 text-xs font-bold rounded-full border border-blue-200">
              Active CRM
            </span>

            {/* Salesperson View Switcher */}
            <div className="flex items-center gap-1.5 ml-2">
              <span className="text-xs text-slate-500 font-semibold">Rep:</span>
              <select
                value={selectedSalesMemberId}
                onChange={(e) => setSelectedSalesMemberId(e.target.value)}
                className="text-xs font-bold bg-slate-50 border border-slate-300 rounded px-2 py-0.5 text-slate-800 hover:bg-white focus:outline-none focus:ring-1 focus:ring-blue-500"
                title="Filter dashboard metrics and assigned work by salesperson"
              >
                <option value="all">All Sales Team</option>
                {salesMembers.map(m => (
                  <option key={m.id} value={m.id}>{m.name}</option>
                ))}
              </select>
            </div>
          </div>
          <p className="text-xs text-slate-500 mt-0.5">
            Overview of your assigned leads, accounts, upcoming tasks, and omnichannel customer timeline.
          </p>
        </div>

        {/* 4 Top KPI Metric Cards */}
        <div className="grid grid-cols-2 sm:grid-cols-4 gap-2.5">
          {/* 1. Tasks Due Today */}
          <div
            onClick={() => onNavigateTab && onNavigateTab('followups', { filter: 'today' })}
            className="bg-slate-50 hover:bg-slate-100 border border-slate-200/80 rounded-lg p-2.5 transition cursor-pointer flex items-center gap-2.5"
          >
            <div className="w-8 h-8 rounded-lg bg-blue-100 text-blue-700 flex items-center justify-center font-bold shrink-0">
              <CheckSquare className="w-4 h-4" />
            </div>
            <div>
              <div className="text-[11px] font-semibold text-slate-500">Tasks Due Today</div>
              <div className="text-base font-extrabold text-slate-900 leading-tight">{tasksDueToday}</div>
            </div>
          </div>

          {/* 2. Overdue Tasks */}
          <div
            onClick={() => onNavigateTab && onNavigateTab('followups', { filter: 'overdue' })}
            className="bg-slate-50 hover:bg-rose-50 border border-slate-200/80 rounded-lg p-2.5 transition cursor-pointer flex items-center gap-2.5"
          >
            <div className="w-8 h-8 rounded-lg bg-rose-100 text-rose-700 flex items-center justify-center font-bold shrink-0">
              <AlertTriangle className="w-4 h-4" />
            </div>
            <div>
              <div className="text-[11px] font-semibold text-slate-500">Overdue Tasks</div>
              <div className="text-base font-extrabold text-rose-700 leading-tight">{overdueTasks}</div>
            </div>
          </div>

          {/* 3. Waiting for Customer */}
          <div
            onClick={() => onNavigateTab && onNavigateTab('inquiries', { status: 'pending_customer' })}
            className="bg-slate-50 hover:bg-amber-50 border border-slate-200/80 rounded-lg p-2.5 transition cursor-pointer flex items-center gap-2.5"
          >
            <div className="w-8 h-8 rounded-lg bg-amber-100 text-amber-700 flex items-center justify-center font-bold shrink-0">
              <Clock className="w-4 h-4" />
            </div>
            <div>
              <div className="text-[11px] font-semibold text-slate-500">Waiting Customer</div>
              <div className="text-base font-extrabold text-amber-800 leading-tight">{waitingCustomer}</div>
            </div>
          </div>

          {/* 4. Meetings This Week */}
          <div
            onClick={() => onNavigateTab && onNavigateTab('followups', { view: 'meetings' })}
            className="bg-slate-50 hover:bg-purple-50 border border-slate-200/80 rounded-lg p-2.5 transition cursor-pointer flex items-center gap-2.5"
          >
            <div className="w-8 h-8 rounded-lg bg-purple-100 text-purple-700 flex items-center justify-center font-bold shrink-0">
              <Calendar className="w-4 h-4" />
            </div>
            <div>
              <div className="text-[11px] font-semibold text-slate-500">Meetings Week</div>
              <div className="text-base font-extrabold text-purple-800 leading-tight">{meetingsThisWeek}</div>
            </div>
          </div>
        </div>
      </div>

      {/* Main Two-Column Layout (Matching Reference Image 1) */}
      <div className="grid grid-cols-1 lg:grid-cols-12 gap-4">
        
        {/* LEFT COLUMN: Assigned Contacts, Accounts, Inquiries, Tasks, Appointments (7 cols) */}
        <div className="lg:col-span-8 space-y-4">
          
          {/* Row 1: Latest Assigned Contacts & Latest Assigned Accounts */}
          <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
            
            {/* Latest Assigned Contact Card */}
            <div className="bg-white rounded-xl border border-slate-200/90 shadow-2xs p-3.5 flex flex-col justify-between">
              <div className="flex items-center justify-between pb-2.5 border-b border-slate-100">
                <div className="flex items-center gap-2">
                  <User className="w-4 h-4 text-blue-600" />
                  <span className="text-xs font-bold text-slate-900">Latest assigned contact ({totalContactsCount})</span>
                </div>
                <button
                  onClick={() => onNavigateTab && onNavigateTab('customers')}
                  className="p-1 text-slate-400 hover:text-blue-600 rounded transition"
                  title="View all contacts"
                >
                  <ExternalLink className="w-3.5 h-3.5" />
                </button>
              </div>

              <div className="divide-y divide-slate-100 mt-2 space-y-2">
                {contacts.length === 0 ? (
                  <div className="text-xs text-slate-400 py-4 text-center">No assigned contacts yet.</div>
                ) : (
                  contacts.slice(0, 3).map((c) => (
                    <div
                      key={c.id}
                      onClick={() => onOpenCustomer && onOpenCustomer(c.id)}
                      className="pt-2 flex items-center justify-between hover:bg-slate-50 p-1.5 rounded-lg transition cursor-pointer"
                    >
                      <div className="flex items-center gap-2.5 min-w-0">
                        <div className="w-7 h-7 rounded-full bg-blue-100 text-blue-700 font-bold text-xs flex items-center justify-center shrink-0">
                          {(c.contact_person || c.company_name || 'C').charAt(0).toUpperCase()}
                        </div>
                        <div className="min-w-0">
                          <div className="text-xs font-bold text-slate-900 truncate">
                            {c.contact_person || c.company_name}
                          </div>
                          <div className="text-[10px] text-slate-500 truncate flex items-center gap-1">
                            <Mail className="w-2.5 h-2.5 text-slate-400" />
                            {c.email || c.company_name}
                          </div>
                        </div>
                      </div>
                      <div className="flex items-center gap-2 shrink-0">
                        <span className="text-[10px] text-slate-400">{formatRelativeTime(c.created_at)}</span>
                        <ChevronRight className="w-3.5 h-3.5 text-slate-400" />
                      </div>
                    </div>
                  ))
                )}
              </div>
            </div>

            {/* Latest Assigned Accounts Card */}
            <div className="bg-white rounded-xl border border-slate-200/90 shadow-2xs p-3.5 flex flex-col justify-between">
              <div className="flex items-center justify-between pb-2.5 border-b border-slate-100">
                <div className="flex items-center gap-2">
                  <Building className="w-4 h-4 text-indigo-600" />
                  <span className="text-xs font-bold text-slate-900">Latest assigned Accounts ({totalAccountsCount})</span>
                </div>
                <button
                  onClick={() => onNavigateTab && onNavigateTab('customers')}
                  className="p-1 text-slate-400 hover:text-indigo-600 rounded transition"
                  title="View all accounts"
                >
                  <ExternalLink className="w-3.5 h-3.5" />
                </button>
              </div>

              <div className="divide-y divide-slate-100 mt-2 space-y-2">
                {accounts.length === 0 ? (
                  <div className="text-xs text-slate-400 py-4 text-center">No assigned accounts yet.</div>
                ) : (
                  accounts.slice(0, 3).map((a) => (
                    <div
                      key={a.id}
                      onClick={() => onOpenCustomer && onOpenCustomer(a.id)}
                      className="pt-2 flex items-center justify-between hover:bg-slate-50 p-1.5 rounded-lg transition cursor-pointer"
                    >
                      <div className="flex items-center gap-2.5 min-w-0">
                        <div className="w-7 h-7 rounded-lg bg-indigo-100 text-indigo-700 font-bold text-xs flex items-center justify-center shrink-0">
                          <Building className="w-3.5 h-3.5" />
                        </div>
                        <div className="min-w-0">
                          <div className="text-xs font-bold text-slate-900 truncate">
                            {a.company_name}
                          </div>
                          <div className="text-[10px] text-slate-500 truncate">
                            {a.website || a.city || 'Indonesia'}
                          </div>
                        </div>
                      </div>
                      <div className="flex items-center gap-2 shrink-0">
                        <span className="text-[10px] text-slate-400">{formatRelativeTime(a.created_at)}</span>
                        <ChevronRight className="w-3.5 h-3.5 text-slate-400" />
                      </div>
                    </div>
                  ))
                )}
              </div>
            </div>
          </div>

          {/* Row 2: Latest Assigned Deals/Inquiries & Latest Assigned Tasks */}
          <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
            
            {/* Latest Assigned Inquiries Card */}
            <div className="bg-white rounded-xl border border-slate-200/90 shadow-2xs p-3.5">
              <div className="flex items-center justify-between pb-2.5 border-b border-slate-100">
                <div className="flex items-center gap-2">
                  <TrendingUp className="w-4 h-4 text-emerald-600" />
                  <span className="text-xs font-bold text-slate-900">Latest assigned Inquiries ({inquiries.length})</span>
                </div>
                <select
                  value={stageFilter}
                  onChange={(e) => setStageFilter(e.target.value)}
                  className="text-[11px] font-semibold bg-slate-50 border border-slate-200 rounded px-1.5 py-0.5 text-slate-700"
                >
                  <option value="all">Lead stage ▾</option>
                  <option value="qualified">Qualified</option>
                  <option value="price_ready">Price Ready</option>
                  <option value="quoted">Quoted</option>
                </select>
              </div>

              <div className="divide-y divide-slate-100 mt-2 space-y-2">
                {inquiries.slice(0, 3).map((inq) => (
                  <div
                    key={inq.id}
                    onClick={() => onOpenInquiry && onOpenInquiry(inq.id)}
                    className="pt-2 flex items-center justify-between hover:bg-slate-50 p-1.5 rounded-lg transition cursor-pointer"
                  >
                    <div className="min-w-0 pr-2">
                      <div className="text-xs font-bold text-slate-900 truncate">
                        {inq.inquiry_number} • {inq.product_name}
                      </div>
                      <div className="text-[10px] text-slate-500 truncate mt-0.5">
                        {inq.company_name}
                      </div>
                    </div>
                    <div className="flex items-center gap-2 shrink-0">
                      <span className="text-[10px] font-bold px-1.5 py-0.5 rounded bg-emerald-50 text-emerald-700 border border-emerald-200">
                        {inq.pipeline_status || 'Qualified'}
                      </span>
                      <span className="text-[10px] font-semibold text-slate-400">
                        {inq.priority || 'Normal'}
                      </span>
                      <ChevronRight className="w-3.5 h-3.5 text-slate-400" />
                    </div>
                  </div>
                ))}
              </div>
            </div>

            {/* Latest Assigned Task Card */}
            <div className="bg-white rounded-xl border border-slate-200/90 shadow-2xs p-3.5">
              <div className="flex items-center justify-between pb-2.5 border-b border-slate-100">
                <div className="flex items-center gap-2">
                  <CheckSquare className="w-4 h-4 text-amber-600" />
                  <span className="text-xs font-bold text-slate-900">Latest assigned task ({tasks.length})</span>
                </div>
                <button
                  onClick={() => onNavigateTab && onNavigateTab('followups')}
                  className="p-1 text-slate-400 hover:text-amber-600 rounded transition"
                  title="View all tasks"
                >
                  <ExternalLink className="w-3.5 h-3.5" />
                </button>
              </div>

              <div className="divide-y divide-slate-100 mt-2 space-y-2">
                {tasks.length === 0 ? (
                  <div className="text-xs text-slate-400 py-4 text-center">No tasks currently assigned.</div>
                ) : (
                  tasks.slice(0, 3).map((t) => (
                    <div
                      key={t.id}
                      onClick={() => onNavigateTab && onNavigateTab('followups')}
                      className="pt-2 flex items-center justify-between hover:bg-slate-50 p-1.5 rounded-lg transition cursor-pointer"
                    >
                      <div className="min-w-0 pr-2">
                        <div className="text-xs font-bold text-slate-900 truncate">
                          {t.title}
                        </div>
                        <div className="text-[10px] text-slate-500 truncate mt-0.5">
                          {t.description || 'Assigned follow-up task'}
                        </div>
                      </div>
                      <div className="flex items-center gap-2 shrink-0">
                        <span className={`text-[10px] font-bold px-1.5 py-0.5 rounded ${
                          t.status === 'completed'
                            ? 'bg-emerald-50 text-emerald-700'
                            : 'bg-amber-50 text-amber-800'
                        }`}>
                          {t.status === 'completed' ? 'Done' : 'In progress'}
                        </span>
                        <ChevronRight className="w-3.5 h-3.5 text-slate-400" />
                      </div>
                    </div>
                  ))
                )}
              </div>
            </div>
          </div>

          {/* Row 3: Appointment Section (Reference Image 1 Bottom Widget) */}
          <div className="bg-white rounded-xl border border-slate-200/90 shadow-2xs p-4">
            <div className="flex items-center justify-between pb-3 border-b border-slate-100 flex-wrap gap-2">
              <div className="flex items-center gap-2">
                <Calendar className="w-4 h-4 text-purple-600" />
                <span className="text-sm font-bold text-slate-900">Appointment</span>
              </div>
              <div className="flex items-center gap-1 text-xs">
                {(
                  [
                    ['all', `All (${appointments.length})`],
                    ['confirmed', `Confirmed (${appointments.filter(a => a.is_completed || a.activity_type).length})`],
                    ['cancelled', `Cancelled (${appointments.filter(a => a.status === 'cancelled').length})`],
                    ['pending', `Pending (${appointments.filter(a => !a.is_completed).length})`],
                  ] as const
                ).map(([key, label]) => (
                  <button
                    key={key}
                    onClick={() => setAppointmentFilter(key as any)}
                    className={`px-2 py-0.5 rounded text-xs font-semibold transition ${
                      appointmentFilter === key
                        ? 'bg-purple-100 text-purple-800 border border-purple-200'
                        : 'text-slate-500 hover:bg-slate-100'
                    }`}
                  >
                    {label}
                  </button>
                ))}
              </div>
            </div>

            <div className="divide-y divide-slate-100 mt-3 space-y-3">
              {(() => {
                const filteredAppointments = appointments.filter(a => {
                  if (appointmentFilter === 'confirmed') return a.is_completed || a.activity_type;
                  if (appointmentFilter === 'cancelled') return a.status === 'cancelled';
                  if (appointmentFilter === 'pending') return !a.is_completed;
                  return true;
                });

                if (filteredAppointments.length === 0) {
                  return (
                    <div className="text-xs text-slate-400 py-6 text-center">
                      No appointments matching this filter. Use Follow-ups → Meetings to schedule client appointments.
                    </div>
                  );
                }

                return filteredAppointments.slice(0, 3).map((apt) => {
                  const aptDate = apt.follow_up_date ? new Date(apt.follow_up_date) : new Date();
                  const dayName = aptDate.toLocaleDateString('en-US', { weekday: 'short' });
                  const dayNum = aptDate.getDate();
                  const timeStr = aptDate.toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' });

                  return (
                    <div
                      key={apt.id}
                      className="pt-2 flex items-center justify-between gap-3 hover:bg-slate-50 p-2 rounded-lg transition"
                    >
                      <div className="flex items-center gap-3 min-w-0">
                        {/* Date badge */}
                        <div className="w-11 h-11 rounded-lg bg-slate-100 border border-slate-200 flex flex-col items-center justify-center shrink-0">
                          <span className="text-[9px] font-bold text-slate-500 uppercase">{dayName}</span>
                          <span className="text-sm font-extrabold text-slate-900 leading-none">{dayNum}</span>
                        </div>

                        {/* Details */}
                        <div className="min-w-0">
                          <div className="text-xs font-bold text-slate-900 truncate">
                            {apt.subject || 'Client Sales Call / Meeting'}
                          </div>
                          <div className="text-[11px] text-slate-500 flex items-center gap-1.5 mt-0.5">
                            <Clock className="w-3 h-3 text-slate-400" />
                            <span>{timeStr} • Client Discussion</span>
                          </div>
                        </div>
                      </div>

                      <div className="flex items-center gap-3 shrink-0">
                        <span className="px-2 py-0.5 rounded-full text-[10px] font-bold bg-emerald-50 text-emerald-700 border border-emerald-200">
                          Confirmed
                        </span>
                        <button
                          onClick={() => onNavigateTab && onNavigateTab('followups', { view: 'meetings' })}
                          className="text-xs font-semibold text-blue-600 hover:text-blue-800 flex items-center gap-1"
                        >
                          <span>Meeting details</span>
                          <ExternalLink className="w-3 h-3" />
                        </button>
                      </div>
                    </div>
                  );
                });
              })()}
            </div>
          </div>
        </div>

        {/* RIGHT COLUMN: Chronological Activity Timeline (5 cols) */}
        <div className="lg:col-span-4">
          <div className="bg-white rounded-xl border border-slate-200/90 shadow-2xs p-4 flex flex-col h-full">
            <div className="flex items-center justify-between pb-3 border-b border-slate-100">
              <div className="flex items-center gap-2">
                <Sparkles className="w-4 h-4 text-blue-600" />
                <h3 className="text-sm font-bold text-slate-900">Activity timeline</h3>
              </div>
              <span className="text-[10px] font-semibold text-slate-400 bg-slate-50 px-2 py-0.5 rounded border border-slate-200">
                Live Omnichannel
              </span>
            </div>

            <div className="mt-3 flex-1 overflow-y-auto max-h-[600px] space-y-3.5 pr-1">
              <div className="text-[10px] font-bold text-slate-400 uppercase tracking-wider">
                Today, {new Date().toLocaleDateString('en-US', { day: 'numeric', month: 'short', year: 'numeric' })}
              </div>

              {timelineItems.length === 0 ? (
                <div className="text-xs text-slate-400 py-8 text-center">No recent timeline activity.</div>
              ) : (
                timelineItems.map((item) => (
                  <div
                    key={item.id}
                    className="p-2.5 rounded-lg border border-slate-100 hover:border-slate-200 hover:bg-slate-50/80 transition space-y-1.5"
                  >
                    <div className="flex items-center justify-between gap-2">
                      <div className="flex items-center gap-1.5">
                        {item.type === 'whatsapp' ? (
                          <div className="w-5 h-5 rounded-md bg-emerald-100 text-emerald-700 flex items-center justify-center">
                            <MessageSquare className="w-3 h-3" />
                          </div>
                        ) : item.type === 'email' ? (
                          <div className="w-5 h-5 rounded-md bg-blue-100 text-blue-700 flex items-center justify-center">
                            <Mail className="w-3 h-3" />
                          </div>
                        ) : item.type === 'call' ? (
                          <div className="w-5 h-5 rounded-md bg-teal-100 text-teal-700 flex items-center justify-center">
                            <Phone className="w-3 h-3" />
                          </div>
                        ) : (
                          <div className="w-5 h-5 rounded-md bg-purple-100 text-purple-700 flex items-center justify-center">
                            <Calendar className="w-3 h-3" />
                          </div>
                        )}
                        <span className="text-xs font-bold text-slate-800 capitalize">{item.type}</span>
                      </div>
                      <span className="text-[10px] text-slate-400">{formatRelativeTime(item.timestamp)}</span>
                    </div>

                    <p className="text-xs text-slate-700 font-medium leading-relaxed">
                      <strong className="text-slate-900">{item.actor}</strong> {item.description}
                    </p>

                    <div className="flex items-center justify-between text-[10px] text-slate-400 pt-1 border-t border-slate-100/60">
                      <span>Created at: {new Date(item.timestamp).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}</span>
                      {item.linkType === 'conversation' ? (
                        <button
                          onClick={() => onNavigateTab && onNavigateTab('inbox')}
                          className="text-blue-600 hover:underline flex items-center gap-0.5 font-semibold"
                        >
                          <span>Open</span>
                          <ChevronRight className="w-3 h-3" />
                        </button>
                      ) : (
                        <button
                          onClick={() => onNavigateTab && onNavigateTab('followups')}
                          className="text-blue-600 hover:underline flex items-center gap-0.5 font-semibold"
                        >
                          <span>View</span>
                          <ChevronRight className="w-3 h-3" />
                        </button>
                      )}
                    </div>
                  </div>
                ))
              )}
            </div>
          </div>
        </div>

      </div>
    </div>
  );
}
