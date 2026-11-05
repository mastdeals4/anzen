import React, { useEffect, useState, useMemo } from 'react';
import { supabase } from '../../../lib/supabase';
import { useAuth } from '../../../contexts/AuthContext';
import { showToast } from '../../ToastNotification';
import {
  Calendar,
  CheckSquare,
  Clock,
  Star,
  Search,
  Plus,
  Bell,
  Check,
  ChevronLeft,
  ChevronRight,
  Filter,
  Download,
  Building,
  User,
  Phone,
  Video,
  FileText,
  X,
  ExternalLink,
  Edit2,
  AlertCircle,
  AlertTriangle,
  MoreHorizontal,
  ChevronDown,
  CheckCircle2,
} from 'lucide-react';

export function getJakartaDateStr(date: string | Date = new Date()): string {
  const d = typeof date === 'string' ? new Date(date) : date;
  return new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Jakarta' }).format(d); // YYYY-MM-DD
}

export function getTomorrowJakartaDate(): string {
  const now = new Date();
  const tomorrow = new Date(now.getTime() + 24 * 60 * 60 * 1000);
  return getJakartaDateStr(tomorrow);
}

interface Props {
  onOpenCustomer?: (customerId: string) => void;
  onOpenInquiry?: (inquiryId: string) => void;
  onNavigateTab?: (tab: string, params?: Record<string, any>) => void;
  initialTab?: 'todo' | 'meetings';
}

interface FollowupTask {
  id: string;
  title: string;
  companyName: string;
  contactPerson: string;
  description: string;
  statusTag: 'VIP' | 'Follow-up focus' | 'Qualified' | 'Qualify' | 'Urgent';
  deadline: string;
  deadlineLabel: string;
  isCompleted: boolean;
  customerId?: string;
  inquiryId?: string;
  priority: string;
  assignedUsers?: string[];
}

interface CalendarMeeting {
  id: string;
  title: string;
  companyName: string;
  contactPerson?: string;
  date: string; // YYYY-MM-DD
  dayOfWeek: number; // 1 (Mon) - 5 (Fri)
  startTime: string; // e.g. "09:00"
  endTime: string; // e.g. "10:00"
  startHour: number; // e.g. 9
  activityType: 'meeting' | 'video_call' | 'phone_call';
  description?: string;
  isCompleted: boolean;
  customerId?: string;
}

export function CrmFollowupsWorkspace({
  onOpenCustomer,
  onOpenInquiry,
  onNavigateTab,
  initialTab = 'todo',
}: Props) {
  const { user, profile } = useAuth();
  const [activeTab, setActiveTab] = useState<'todo' | 'meetings'>(initialTab);

  useEffect(() => {
    if (initialTab) {
      setActiveTab(initialTab);
    }
  }, [initialTab]);

  // Sales team members
  const [salesMembers, setSalesMembers] = useState<any[]>([]);

  // TO-DO state
  const [todoTasks, setTodoTasks] = useState<FollowupTask[]>([]);
  const [todoSearch, setTodoSearch] = useState('');
  const [loadingTasks, setLoadingTasks] = useState(false);
  const [showNewTaskModal, setShowNewTaskModal] = useState(false);

  // New task form
  const [newTaskTitle, setNewTaskTitle] = useState('');
  const [newTaskCompany, setNewTaskCompany] = useState('');
  const [newTaskContact, setNewTaskContact] = useState('');
  const [newTaskStatus, setNewTaskStatus] = useState<'VIP' | 'Follow-up focus' | 'Qualified' | 'Qualify' | 'Urgent'>('Follow-up focus');
  const [newTaskDate, setNewTaskDate] = useState(getTomorrowJakartaDate());
  const [newTaskTime, setNewTaskTime] = useState('14:00');
  const [newTaskNotes, setNewTaskNotes] = useState('');
  const [newTaskAssignedTo, setNewTaskAssignedTo] = useState<string>('46b3d50c-ace4-42ea-8ab1-12cc6397a169'); // Default Zara
  const [savingTask, setSavingTask] = useState(false);

  // MEETINGS state
  const [calendarView, setCalendarView] = useState<'day' | 'week' | 'month'>('week');
  const [currentWeekOffset, setCurrentWeekOffset] = useState(0);
  const [meetings, setMeetings] = useState<CalendarMeeting[]>([]);
  const [meetingSearch, setMeetingSearch] = useState('');
  const [loadingMeetings, setLoadingMeetings] = useState(false);
  const [showNewMeetingModal, setShowNewMeetingModal] = useState(false);

  // Selected meeting for viewing / rescheduling / completing
  const [selectedMeeting, setSelectedMeeting] = useState<CalendarMeeting | null>(null);
  const [meetingNotes, setMeetingNotes] = useState('');
  const [rescheduleDate, setRescheduleDate] = useState('');
  const [rescheduleTime, setRescheduleTime] = useState('10:00');
  const [updatingMeeting, setUpdatingMeeting] = useState(false);

  // New meeting form
  const [newMeetingTitle, setNewMeetingTitle] = useState('');
  const [newMeetingCompany, setNewMeetingCompany] = useState('');
  const [newMeetingContact, setNewMeetingContact] = useState('');
  const [newMeetingDate, setNewMeetingDate] = useState(getJakartaDateStr(new Date()));
  const [newMeetingStartTime, setNewMeetingStartTime] = useState('10:00');
  const [newMeetingEndTime, setNewMeetingEndTime] = useState('11:00');
  const [newMeetingType, setNewMeetingType] = useState<'meeting' | 'video_call' | 'phone_call'>('meeting');
  const [newMeetingAgenda, setNewMeetingAgenda] = useState('');
  const [savingMeeting, setSavingMeeting] = useState(false);

  useEffect(() => {
    loadSalesMembers();
    loadTasks();
    loadMeetings();
  }, []);

  const loadSalesMembers = async () => {
    try {
      const { data } = await supabase
        .from('sales_team_members')
        .select('id, name, email')
        .eq('is_active', true)
        .order('name');
      setSalesMembers(data || []);
      if (data && data.length > 0) {
        setNewTaskAssignedTo(data[0].id);
      }
    } catch (err) {
      console.error('Error loading sales team members:', err);
    }
  };

  // Compute Monday date of current week offset
  const weekDays = useMemo(() => {
    const today = new Date();
    const currentDay = today.getDay(); // 0 is Sunday, 1 is Monday
    const distanceToMonday = currentDay === 0 ? -6 : 1 - currentDay;
    const monday = new Date(today);
    monday.setDate(today.getDate() + distanceToMonday + currentWeekOffset * 7);

    const days = [];
    for (let i = 0; i < 5; i++) {
      const d = new Date(monday);
      d.setDate(monday.getDate() + i);
      const dateStr = getJakartaDateStr(d);
      days.push({
        name: ['Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday'][i],
        dateStr,
        formatted: `${d.getMonth() + 1}/${d.getDate()}/${String(d.getFullYear()).slice(-2)}`,
        dayNum: d.getDate(),
        isToday: dateStr === getJakartaDateStr(new Date()),
      });
    }
    return days;
  }, [currentWeekOffset]);

  const loadTasks = async () => {
    setLoadingTasks(true);
    try {
      const { data: dbTasks } = await supabase
        .from('tasks')
        .select(`
          id,
          title,
          description,
          deadline,
          status,
          priority,
          customer_id,
          inquiry_id,
          assigned_users,
          customers:customer_id (
            id,
            company_name,
            contact_person
          )
        `)
        .eq('is_deleted', false)
        .order('deadline', { ascending: true })
        .limit(50);

      const jakartaToday = getJakartaDateStr(new Date());
      const jakartaTomorrow = getTomorrowJakartaDate();

      const items: FollowupTask[] = (dbTasks || []).map((t: any) => {
        const cust = t.customers;
        const taskJakartaDate = getJakartaDateStr(t.deadline);
        const d = new Date(t.deadline);

        let label = d.toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
        if (taskJakartaDate === jakartaToday) {
          label = `Today, ${d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}`;
        } else if (taskJakartaDate === jakartaTomorrow) {
          label = `Tomorrow, ${d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}`;
        }

        let tag: FollowupTask['statusTag'] = 'Follow-up focus';
        if (t.priority === 'urgent') tag = 'Urgent';
        else if (t.priority === 'high') tag = 'VIP';
        else if (t.status === 'in_progress') tag = 'Follow-up focus';
        else tag = 'Qualified';

        // Extract company and contact from description if not linked to ERP customer
        let displayCompany = cust?.company_name;
        let displayContact = cust?.contact_person;
        if (!displayCompany && t.description) {
          const compMatch = t.description.match(/Company:\s*([^•\n]+)/);
          if (compMatch) displayCompany = compMatch[1].trim();
          const contactMatch = t.description.match(/Contact:\s*([^•\n]+)/);
          if (contactMatch) displayContact = contactMatch[1].trim();
        }

        return {
          id: t.id,
          title: t.title,
          companyName: displayCompany || 'SAPJ Customer Partner',
          contactPerson: displayContact || 'Procurement Team',
          description: t.description || 'Follow up with customer regarding quotation and requirements.',
          statusTag: tag,
          deadline: t.deadline,
          deadlineLabel: label,
          isCompleted: t.status === 'completed',
          customerId: t.customer_id,
          inquiryId: t.inquiry_id,
          priority: t.priority || 'medium',
          assignedUsers: t.assigned_users || [],
        };
      });

      setTodoTasks(items);
    } catch (err) {
      console.error('Error loading follow-up tasks:', err);
    } finally {
      setLoadingTasks(false);
    }
  };

  const loadMeetings = async () => {
    setLoadingMeetings(true);
    try {
      const { data: acts } = await supabase
        .from('crm_activities')
        .select(`
          id,
          subject,
          description,
          activity_type,
          follow_up_date,
          is_completed,
          customer_id,
          crm_contacts:customer_id (
            company_name,
            contact_person
          )
        `)
        .in('activity_type', ['meeting', 'video_call'])
        .not('follow_up_date', 'is', null)
        .order('follow_up_date', { ascending: true });

      const mapped: CalendarMeeting[] = (acts || []).map((a: any) => {
        const d = new Date(a.follow_up_date);
        const dateStr = getJakartaDateStr(d);
        const dayOfWeek = d.getDay(); // 0 is Sun, 1 is Mon

        // Extract Jakarta hour and minute reliably
        const timeParts = new Intl.DateTimeFormat('en-US', {
          timeZone: 'Asia/Jakarta',
          hour12: false,
          hour: 'numeric',
          minute: 'numeric',
        }).formatToParts(d);

        let startH = 10;
        let startM = '00';
        timeParts.forEach(p => {
          if (p.type === 'hour') {
            const val = parseInt(p.value, 10);
            startH = val === 24 ? 0 : val;
          }
          if (p.type === 'minute') startM = p.value.padStart(2, '0');
        });

        const endH = (startH + 1) % 24;

        return {
          id: a.id,
          title: a.subject || 'Client Sales Call',
          companyName: a.crm_contacts?.company_name || 'Client Account',
          contactPerson: a.crm_contacts?.contact_person || '',
          date: dateStr,
          dayOfWeek: dayOfWeek === 0 ? 5 : dayOfWeek,
          startTime: `${String(startH).padStart(2, '0')}:${startM}`,
          endTime: `${String(endH).padStart(2, '0')}:${startM}`,
          startHour: startH,
          activityType: a.activity_type,
          description: a.description || '',
          isCompleted: !!a.is_completed,
          customerId: a.customer_id,
        };
      });

      setMeetings(mapped);
    } catch (err) {
      console.error('Error loading meetings:', err);
    } finally {
      setLoadingMeetings(false);
    }
  };

  const handleToggleTaskComplete = async (taskId: string, currentCompleted: boolean) => {
    try {
      setTodoTasks(prev =>
        prev.map(t => (t.id === taskId ? { ...t, isCompleted: !currentCompleted } : t))
      );
      await supabase
        .from('tasks')
        .update({
          status: !currentCompleted ? 'completed' : 'to_do',
          completed_at: !currentCompleted ? new Date().toISOString() : null,
          completed_by: !currentCompleted ? (profile?.id || '1075a773-bb55-4296-bc71-af2eab9a0780') : null,
        })
        .eq('id', taskId);

      showToast({
        type: 'success',
        title: !currentCompleted ? 'Task Completed' : 'Task Reopened',
        message: 'Follow-up status updated.',
      });
      loadTasks();
    } catch (err: any) {
      console.error('Error updating task:', err);
    }
  };

  const handleCreateTask = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!newTaskTitle.trim() || !newTaskCompany.trim()) return;

    setSavingTask(true);
    try {
      // Create deadline with explicit Jakarta timezone (+07:00)
      const deadlineIso = new Date(`${newTaskDate}T${newTaskTime}:00+07:00`).toISOString();
      const creatorId = profile?.id || '1075a773-bb55-4296-bc71-af2eab9a0780';

      const { data: newTask, error } = await supabase
        .from('tasks')
        .insert({
          title: newTaskTitle.trim(),
          description: `Company: ${newTaskCompany.trim()} • Contact: ${newTaskContact.trim()} • ${newTaskNotes.trim()}`,
          deadline: deadlineIso,
          priority: newTaskStatus === 'Urgent' ? 'urgent' : (newTaskStatus === 'VIP' ? 'high' : 'medium'),
          status: 'to_do',
          created_by: creatorId,
          assigned_users: newTaskAssignedTo ? [newTaskAssignedTo] : [],
        })
        .select()
        .single();

      if (error) {
        throw error;
      }

      showToast({ type: 'success', title: 'Task Created', message: 'New follow-up task added to pipeline.' });
      setShowNewTaskModal(false);
      setNewTaskTitle('');
      setNewTaskCompany('');
      setNewTaskContact('');
      setNewTaskNotes('');
      setNewTaskDate(getTomorrowJakartaDate());
      loadTasks();
    } catch (err: any) {
      showToast({ type: 'error', title: 'Failed to create task', message: err.message });
    } finally {
      setSavingTask(false);
    }
  };

  const handleCreateMeeting = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!newMeetingTitle.trim() || !newMeetingCompany.trim()) return;

    setSavingMeeting(true);
    try {
      // Match company if possible to existing crm_contacts
      let matchedContactId: string | null = null;
      const { data: contacts } = await supabase
        .from('crm_contacts')
        .select('id, company_name')
        .ilike('company_name', `%${newMeetingCompany.trim()}%`)
        .limit(1);

      if (contacts && contacts.length > 0) {
        matchedContactId = contacts[0].id;
      }

      const startIso = new Date(`${newMeetingDate}T${newMeetingStartTime}:00+07:00`).toISOString();
      const creatorId = profile?.id || '1075a773-bb55-4296-bc71-af2eab9a0780';

      const { error } = await supabase
        .from('crm_activities')
        .insert({
          activity_type: newMeetingType,
          subject: `${newMeetingTitle.trim()} (${newMeetingCompany.trim()})`,
          description: newMeetingAgenda.trim(),
          follow_up_date: startIso,
          created_by: creatorId,
          customer_id: matchedContactId,
          is_completed: false,
        });

      if (error) throw error;

      showToast({ type: 'success', title: 'Meeting Scheduled', message: 'Meeting added to weekly calendar.' });
      setShowNewMeetingModal(false);
      setNewMeetingTitle('');
      setNewMeetingCompany('');
      setNewMeetingContact('');
      setNewMeetingAgenda('');
      loadMeetings();
    } catch (err: any) {
      showToast({ type: 'error', title: 'Failed to schedule meeting', message: err.message });
    } finally {
      setSavingMeeting(false);
    }
  };

  const handleRescheduleMeeting = async () => {
    if (!selectedMeeting || !rescheduleDate) return;
    setUpdatingMeeting(true);
    try {
      const newFollowup = new Date(`${rescheduleDate}T${rescheduleTime}:00+07:00`).toISOString();
      const { error } = await supabase
        .from('crm_activities')
        .update({ follow_up_date: newFollowup })
        .eq('id', selectedMeeting.id);

      if (error) throw error;

      showToast({ type: 'success', title: 'Meeting Rescheduled', message: 'Meeting date and time updated.' });
      setSelectedMeeting(null);
      loadMeetings();
    } catch (err: any) {
      showToast({ type: 'error', title: 'Reschedule Failed', message: err.message });
    } finally {
      setUpdatingMeeting(false);
    }
  };

  const handleCompleteMeeting = async () => {
    if (!selectedMeeting) return;
    setUpdatingMeeting(true);
    try {
      const updatedDesc = selectedMeeting.description
        ? `${selectedMeeting.description}\n[Meeting Notes]: ${meetingNotes.trim()}`
        : `[Meeting Notes]: ${meetingNotes.trim()}`;

      const { error } = await supabase
        .from('crm_activities')
        .update({
          is_completed: true,
          completed_at: new Date().toISOString(),
          description: updatedDesc,
        })
        .eq('id', selectedMeeting.id);

      if (error) throw error;

      showToast({ type: 'success', title: 'Meeting Completed', message: 'Notes recorded in customer timeline.' });
      setSelectedMeeting(null);
      setMeetingNotes('');
      loadMeetings();
    } catch (err: any) {
      showToast({ type: 'error', title: 'Completion Failed', message: err.message });
    } finally {
      setUpdatingMeeting(false);
    }
  };

  const handleCreateFollowupFromMeeting = (meeting: CalendarMeeting) => {
    setNewTaskCompany(meeting.companyName);
    setNewTaskContact(meeting.contactPerson || '');
    setNewTaskTitle(`Follow-up: ${meeting.title}`);
    setNewTaskNotes(meetingNotes ? `Follow-up action: ${meetingNotes}` : 'Follow-up action from meeting discussion.');
    setNewTaskDate(getTomorrowJakartaDate());
    setSelectedMeeting(null);
    setShowNewTaskModal(true);
  };

  // Group tasks by Jakarta calendar date (Reference Image 3 style, ZERO mock slicing)
  const groupedTasks = useMemo(() => {
    const q = todoSearch.toLowerCase().trim();
    const filtered = todoTasks.filter(t =>
      t.companyName.toLowerCase().includes(q) ||
      t.contactPerson.toLowerCase().includes(q) ||
      t.title.toLowerCase().includes(q) ||
      t.description.toLowerCase().includes(q)
    );

    const jakartaToday = getJakartaDateStr(new Date());
    const jakartaTomorrow = getTomorrowJakartaDate();

    const todayTasks = filtered.filter(t => !t.isCompleted && getJakartaDateStr(t.deadline) === jakartaToday);
    const tomorrowTasks = filtered.filter(t => !t.isCompleted && getJakartaDateStr(t.deadline) === jakartaTomorrow);
    const overdueTasks = filtered.filter(t => !t.isCompleted && getJakartaDateStr(t.deadline) < jakartaToday);
    const upcomingTasks = filtered.filter(t => !t.isCompleted && getJakartaDateStr(t.deadline) > jakartaTomorrow);
    const completedTasks = filtered.filter(t => t.isCompleted);

    return {
      total: filtered.length,
      today: todayTasks,
      tomorrow: tomorrowTasks,
      overdue: overdueTasks,
      upcoming: upcomingTasks,
      completed: completedTasks,
    };
  }, [todoTasks, todoSearch]);

  const getStatusTagStyle = (tag: FollowupTask['statusTag']) => {
    switch (tag) {
      case 'VIP':
        return 'bg-[#2d6a4f] text-[#d8f3dc] font-bold';
      case 'Follow-up focus':
        return 'bg-[#0096c7] text-white font-bold';
      case 'Qualified':
        return 'bg-[#52b788] text-white font-bold';
      case 'Qualify':
        return 'bg-[#6c757d] text-white font-medium';
      case 'Urgent':
        return 'bg-[#d90429] text-white font-bold';
      default:
        return 'bg-slate-200 text-slate-800 font-medium';
    }
  };

  return (
    <div className="space-y-3 animate-in fade-in duration-150">
      {/* Top Workspace Tab Switcher (TO-DO | MEETINGS) */}
      <div className="bg-white rounded-xl border border-slate-200/90 shadow-2xs px-4 py-2 flex items-center justify-between gap-4 flex-wrap">
        <div className="flex items-center gap-1 bg-slate-100 p-1 rounded-lg">
          <button
            onClick={() => setActiveTab('todo')}
            className={`px-4 py-1.5 rounded-md text-xs font-bold transition flex items-center gap-2 ${
              activeTab === 'todo'
                ? 'bg-white text-slate-900 shadow-2xs border border-slate-200'
                : 'text-slate-600 hover:text-slate-900'
            }`}
          >
            <CheckSquare className="w-3.5 h-3.5 text-blue-600" />
            <span>TO-DO</span>
          </button>
          <button
            onClick={() => setActiveTab('meetings')}
            className={`px-4 py-1.5 rounded-md text-xs font-bold transition flex items-center gap-2 ${
              activeTab === 'meetings'
                ? 'bg-white text-slate-900 shadow-2xs border border-slate-200'
                : 'text-slate-600 hover:text-slate-900'
            }`}
          >
            <Calendar className="w-3.5 h-3.5 text-purple-600" />
            <span>MEETINGS</span>
          </button>
        </div>

        <div className="text-xs text-slate-500 font-medium">
          {activeTab === 'todo' ? 'Pipeline task actions & priority reminders' : 'Weekly 8am–5pm client meeting grid'}
        </div>
      </div>

      {/* ========================================================================= */}
      {/* TAB 1: TO-DO (REFERENCE IMAGE 3 STYLE)                                     */}
      {/* ========================================================================= */}
      {activeTab === 'todo' && (
        <div className="bg-white rounded-xl border border-slate-200/90 shadow-2xs overflow-hidden">
          {/* Header Card (Image 3) */}
          <div className="p-4 border-b border-slate-200/90">
            <div className="flex items-center justify-between gap-3 flex-wrap">
              <div className="flex items-center gap-2.5">
                <Star className="w-5 h-5 text-amber-500 fill-amber-500 shrink-0" />
                <h2 className="text-base font-bold text-slate-900 flex items-center gap-2">
                  <span>Next action on active sales</span>
                  <Edit2 className="w-3.5 h-3.5 text-slate-400 cursor-pointer hover:text-slate-600" />
                </h2>
              </div>

              <div className="flex items-center gap-2">
                <button
                  onClick={() => showToast({ type: 'info', title: 'Export', message: 'Exporting sales actions to Excel.' })}
                  className="px-2.5 py-1 text-xs font-semibold bg-white border border-slate-300 rounded text-slate-700 hover:bg-slate-50 flex items-center gap-1.5"
                >
                  <Download className="w-3.5 h-3.5" />
                  <span>Export ▾</span>
                </button>
                <button
                  onClick={() => setShowNewTaskModal(true)}
                  className="px-3 py-1 text-xs font-bold bg-blue-600 text-white rounded hover:bg-blue-700 flex items-center gap-1.5 shadow-2xs"
                >
                  <Plus className="w-3.5 h-3.5" />
                  <span>+ Automation / Add Task</span>
                </button>
              </div>
            </div>

            {/* Sub-bar: View toggle & Match Count */}
            <div className="flex items-center justify-between mt-3 pt-3 border-t border-slate-100 flex-wrap gap-2 text-xs">
              <div className="flex items-center gap-3">
                <div className="flex items-center border border-slate-200 rounded p-0.5 bg-slate-50">
                  <button className="px-2 py-0.5 bg-white text-slate-800 rounded font-semibold shadow-2xs">
                    ☰ List
                  </button>
                  <button className="px-2 py-0.5 text-slate-500 hover:text-slate-800">
                    ⊞ Cards
                  </button>
                </div>
                <span className="font-bold text-slate-700">{groupedTasks.total} matches</span>
              </div>

              <div className="relative">
                <Search className="w-3.5 h-3.5 absolute left-2.5 top-2 text-slate-400" />
                <input
                  type="text"
                  value={todoSearch}
                  onChange={(e) => setTodoSearch(e.target.value)}
                  placeholder="Filter actions or company..."
                  className="pl-8 pr-3 py-1 text-xs border border-slate-300 rounded-md focus:outline-blue-500 w-48 sm:w-64"
                />
              </div>
            </div>
          </div>

          {/* Table Sections (Tasks due Today, Tomorrow, Overdue, Upcoming, Completed) */}
          <div className="p-4 space-y-6">
            
            {/* 1. Tasks Due Today */}
            <div>
              <div className="grid grid-cols-12 text-[11px] font-bold text-slate-500 uppercase tracking-wider pb-2 border-b border-slate-200">
                <div className="col-span-7 sm:col-span-8 flex items-center gap-1.5">
                  <span>Tasks due Today</span>
                  <span className="px-1.5 py-0.2 rounded-full text-[10px] font-bold bg-blue-100 text-blue-800">
                    {groupedTasks.today.length}
                  </span>
                </div>
                <div className="col-span-2 sm:col-span-2">Status</div>
                <div className="col-span-3 sm:col-span-2 text-right">Deadline</div>
              </div>

              <div className="divide-y divide-slate-100">
                {groupedTasks.today.length === 0 ? (
                  <div className="py-3 text-xs text-slate-400 italic">No tasks due today.</div>
                ) : (
                  groupedTasks.today.map((task) => (
                    <div
                      key={task.id}
                      className="py-3 grid grid-cols-12 items-center hover:bg-slate-50/80 px-1 rounded-lg transition"
                    >
                      <div className="col-span-7 sm:col-span-8 flex items-start gap-3 min-w-0 pr-3">
                        <button
                          onClick={() => handleToggleTaskComplete(task.id, task.isCompleted)}
                          className="mt-0.5 text-slate-400 hover:text-amber-500 transition shrink-0"
                          title={task.isCompleted ? 'Mark incomplete' : 'Mark complete'}
                        >
                          {task.isCompleted ? (
                            <Check className="w-4 h-4 text-emerald-600" />
                          ) : (
                            <Bell className="w-4 h-4" />
                          )}
                        </button>
                        <div className="min-w-0">
                          <div className="text-xs font-bold text-slate-900 truncate">
                            <span
                              onClick={() => task.customerId && onOpenCustomer && onOpenCustomer(task.customerId)}
                              className="hover:text-blue-600 cursor-pointer"
                            >
                              {task.companyName} ({task.contactPerson})
                            </span>
                          </div>
                          <div className="text-xs text-slate-600 truncate mt-0.5">
                            {task.description}
                          </div>
                        </div>
                      </div>

                      <div className="col-span-2 sm:col-span-2">
                        <span className={`px-2 py-0.5 rounded text-[10px] ${getStatusTagStyle(task.statusTag)}`}>
                          {task.statusTag}
                        </span>
                      </div>

                      <div className="col-span-3 sm:col-span-2 text-right flex items-center justify-end gap-1.5 text-xs text-slate-600 font-medium">
                        <Calendar className="w-3.5 h-3.5 text-slate-400" />
                        <span>{task.deadlineLabel}</span>
                      </div>
                    </div>
                  ))
                )}
              </div>
            </div>

            {/* 2. Tasks Due Tomorrow */}
            <div>
              <div className="grid grid-cols-12 text-[11px] font-bold text-slate-500 uppercase tracking-wider pb-2 border-b border-slate-200">
                <div className="col-span-7 sm:col-span-8 flex items-center gap-1.5">
                  <span>Tasks due Tomorrow</span>
                  <span className="px-1.5 py-0.2 rounded-full text-[10px] font-bold bg-indigo-100 text-indigo-800">
                    {groupedTasks.tomorrow.length}
                  </span>
                </div>
                <div className="col-span-2 sm:col-span-2">Status</div>
                <div className="col-span-3 sm:col-span-2 text-right">Deadline</div>
              </div>

              <div className="divide-y divide-slate-100">
                {groupedTasks.tomorrow.length === 0 ? (
                  <div className="py-3 text-xs text-slate-400 italic">No tasks due tomorrow.</div>
                ) : (
                  groupedTasks.tomorrow.map((task) => (
                    <div
                      key={task.id}
                      className="py-3 grid grid-cols-12 items-center hover:bg-slate-50/80 px-1 rounded-lg transition"
                    >
                      <div className="col-span-7 sm:col-span-8 flex items-start gap-3 min-w-0 pr-3">
                        <button
                          onClick={() => handleToggleTaskComplete(task.id, task.isCompleted)}
                          className="mt-0.5 text-slate-400 hover:text-amber-500 transition shrink-0"
                          title={task.isCompleted ? 'Mark incomplete' : 'Mark complete'}
                        >
                          {task.isCompleted ? (
                            <Check className="w-4 h-4 text-emerald-600" />
                          ) : (
                            <Bell className="w-4 h-4" />
                          )}
                        </button>
                        <div className="min-w-0">
                          <div className="text-xs font-bold text-slate-900 truncate">
                            <span
                              onClick={() => task.customerId && onOpenCustomer && onOpenCustomer(task.customerId)}
                              className="hover:text-blue-600 cursor-pointer"
                            >
                              {task.companyName} ({task.contactPerson})
                            </span>
                          </div>
                          <div className="text-xs text-slate-600 truncate mt-0.5">
                            {task.description}
                          </div>
                        </div>
                      </div>

                      <div className="col-span-2 sm:col-span-2">
                        <span className={`px-2 py-0.5 rounded text-[10px] ${getStatusTagStyle(task.statusTag)}`}>
                          {task.statusTag}
                        </span>
                      </div>

                      <div className="col-span-3 sm:col-span-2 text-right flex items-center justify-end gap-1.5 text-xs text-slate-600 font-medium">
                        <Calendar className="w-3.5 h-3.5 text-slate-400" />
                        <span>{task.deadlineLabel}</span>
                      </div>
                    </div>
                  ))
                )}
              </div>
            </div>

            {/* 3. Overdue Tasks */}
            {groupedTasks.overdue.length > 0 && (
              <div>
                <div className="grid grid-cols-12 text-[11px] font-bold text-rose-600 uppercase tracking-wider pb-2 border-b border-rose-200">
                  <div className="col-span-7 sm:col-span-8 flex items-center gap-1.5">
                    <AlertTriangle className="w-3.5 h-3.5" />
                    <span>Overdue Tasks</span>
                    <span className="px-1.5 py-0.2 rounded-full text-[10px] font-bold bg-rose-100 text-rose-800">
                      {groupedTasks.overdue.length}
                    </span>
                  </div>
                  <div className="col-span-2 sm:col-span-2">Status</div>
                  <div className="col-span-3 sm:col-span-2 text-right">Deadline</div>
                </div>

                <div className="divide-y divide-rose-50">
                  {groupedTasks.overdue.map((task) => (
                    <div
                      key={task.id}
                      className="py-3 grid grid-cols-12 items-center bg-rose-50/30 hover:bg-rose-50/70 px-1 rounded-lg transition"
                    >
                      <div className="col-span-7 sm:col-span-8 flex items-start gap-3 min-w-0 pr-3">
                        <button
                          onClick={() => handleToggleTaskComplete(task.id, task.isCompleted)}
                          className="mt-0.5 text-slate-400 hover:text-rose-600 transition shrink-0"
                        >
                          <Bell className="w-4 h-4 text-rose-500" />
                        </button>
                        <div className="min-w-0">
                          <div className="text-xs font-bold text-slate-900 truncate">
                            {task.companyName} ({task.contactPerson})
                          </div>
                          <div className="text-xs text-slate-600 truncate mt-0.5">
                            {task.description}
                          </div>
                        </div>
                      </div>

                      <div className="col-span-2 sm:col-span-2">
                        <span className="px-2 py-0.5 rounded text-[10px] bg-rose-600 text-white font-bold">
                          Overdue
                        </span>
                      </div>

                      <div className="col-span-3 sm:col-span-2 text-right flex items-center justify-end gap-1.5 text-xs text-rose-700 font-bold">
                        <Calendar className="w-3.5 h-3.5" />
                        <span>{task.deadlineLabel}</span>
                      </div>
                    </div>
                  ))}
                </div>
              </div>
            )}

            {/* 4. Completed Tasks */}
            {groupedTasks.completed.length > 0 && (
              <div>
                <div className="grid grid-cols-12 text-[11px] font-bold text-slate-400 uppercase tracking-wider pb-2 border-b border-slate-200">
                  <div className="col-span-7 sm:col-span-8 flex items-center gap-1.5">
                    <CheckCircle2 className="w-3.5 h-3.5 text-emerald-600" />
                    <span>Completed Tasks</span>
                    <span className="px-1.5 py-0.2 rounded-full text-[10px] font-bold bg-slate-100 text-slate-600">
                      {groupedTasks.completed.length}
                    </span>
                  </div>
                  <div className="col-span-2 sm:col-span-2">Status</div>
                  <div className="col-span-3 sm:col-span-2 text-right">Status</div>
                </div>

                <div className="divide-y divide-slate-100">
                  {groupedTasks.completed.map((task) => (
                    <div
                      key={task.id}
                      className="py-2.5 grid grid-cols-12 items-center opacity-70 hover:opacity-100 px-1 rounded-lg transition"
                    >
                      <div className="col-span-7 sm:col-span-8 flex items-start gap-3 min-w-0 pr-3">
                        <button
                          onClick={() => handleToggleTaskComplete(task.id, task.isCompleted)}
                          className="mt-0.5 text-emerald-600 transition shrink-0"
                        >
                          <Check className="w-4 h-4 text-emerald-600" />
                        </button>
                        <div className="min-w-0">
                          <div className="text-xs font-semibold text-slate-600 line-through truncate">
                            {task.companyName} • {task.title}
                          </div>
                        </div>
                      </div>

                      <div className="col-span-2 sm:col-span-2">
                        <span className="px-2 py-0.5 rounded text-[10px] bg-emerald-50 text-emerald-700 border border-emerald-200 font-bold">
                          Done
                        </span>
                      </div>

                      <div className="col-span-3 sm:col-span-2 text-right text-xs text-slate-400">
                        Completed
                      </div>
                    </div>
                  ))}
                </div>
              </div>
            )}

          </div>
        </div>
      )}

      {/* ========================================================================= */}
      {/* TAB 2: MEETINGS (REFERENCE IMAGE 2 STYLE)                                  */}
      {/* ========================================================================= */}
      {activeTab === 'meetings' && (
        <div className="bg-white rounded-xl border border-slate-200/90 shadow-2xs overflow-hidden">
          {/* Header Bar */}
          <div className="p-4 border-b border-slate-200 bg-slate-50/50 flex items-center justify-between gap-3 flex-wrap">
            <div className="flex items-center gap-3">
              <h2 className="text-base font-bold text-slate-900">
                Weekly meetings ({weekDays[0].formatted} - {weekDays[4].formatted})
              </h2>
              <div className="flex items-center gap-1">
                <button
                  onClick={() => setCurrentWeekOffset(prev => prev - 1)}
                  className="p-1 text-slate-500 hover:bg-slate-200 rounded"
                  title="Previous week"
                >
                  <ChevronLeft className="w-4 h-4" />
                </button>
                <button
                  onClick={() => setCurrentWeekOffset(0)}
                  className="px-2 py-0.5 text-xs font-semibold bg-white border border-slate-300 rounded text-slate-700"
                >
                  Current Week
                </button>
                <button
                  onClick={() => setCurrentWeekOffset(prev => prev + 1)}
                  className="p-1 text-slate-500 hover:bg-slate-200 rounded"
                  title="Next week"
                >
                  <ChevronRight className="w-4 h-4" />
                </button>
              </div>
            </div>

            <div className="flex items-center gap-2 flex-wrap">
              <select
                value={calendarView}
                onChange={(e) => setCalendarView(e.target.value as any)}
                className="text-xs font-semibold bg-white border border-slate-300 rounded px-2 py-1 text-slate-800"
              >
                <option value="day">Day</option>
                <option value="week">Week</option>
                <option value="month">Month</option>
              </select>

              <div className="relative">
                <Search className="w-3.5 h-3.5 absolute left-2.5 top-2 text-slate-400" />
                <input
                  type="text"
                  value={meetingSearch}
                  onChange={(e) => setMeetingSearch(e.target.value)}
                  placeholder="Search meetings..."
                  className="pl-8 pr-3 py-1 text-xs border border-slate-300 rounded bg-white w-40"
                />
              </div>

              <button
                onClick={() => setShowNewMeetingModal(true)}
                className="px-3 py-1 text-xs font-bold bg-white text-slate-700 border border-slate-300 rounded hover:bg-slate-50 shadow-2xs"
              >
                + Log activity
              </button>

              <button
                onClick={() => setShowNewMeetingModal(true)}
                className="px-3 py-1 text-xs font-bold bg-blue-600 text-white rounded hover:bg-blue-700 shadow-2xs flex items-center gap-1.5"
              >
                <Plus className="w-3.5 h-3.5" />
                <span>+ Create new meeting</span>
              </button>
            </div>
          </div>

          {/* 8am–5pm Weekly Calendar Grid (Image 2) */}
          <div className="overflow-x-auto">
            <div className="min-w-[850px]">
              
              {/* Day Column Headers */}
              <div className="grid grid-cols-12 border-b border-slate-200 bg-slate-50 text-center font-bold text-xs">
                <div className="col-span-1 p-2.5 border-r border-slate-200 text-slate-400">Time</div>
                {weekDays.map((day, idx) => (
                  <div
                    key={day.dateStr}
                    className={`col-span-2 p-2 border-r border-slate-200 last:border-r-0 ${
                      day.isToday ? 'bg-blue-50/60' : ''
                    }`}
                  >
                    {day.isToday && (
                      <div className="h-1 bg-blue-600 -mt-2 mb-1 rounded-full"></div>
                    )}
                    <div className="text-slate-700">{day.name}</div>
                    <div className="text-[10px] text-slate-400 font-normal">{day.formatted}</div>
                  </div>
                ))}
                <div className="col-span-1 p-2 text-slate-400">Notes</div>
              </div>

              {/* 8:00 AM Row: Top Outreach Banner (Image 2 style) */}
              <div className="grid grid-cols-12 border-b border-slate-100 min-h-[44px] bg-slate-50/30">
                <div className="col-span-1 p-2 border-r border-slate-200 text-xs text-slate-400 font-mono">8am</div>
                {weekDays.map((d) => (
                  <div key={d.dateStr} className="col-span-2 p-1 border-r border-slate-200 last:border-r-0">
                    <div className="p-1 rounded bg-amber-100/90 text-amber-900 border border-amber-300 text-[10px] font-semibold truncate">
                      Perform outreach, 8:30 - 9:00am
                    </div>
                  </div>
                ))}
                <div className="col-span-1 p-1"></div>
              </div>

              {/* Hourly Rows (9am down to 4pm) */}
              {[9, 10, 11, 12, 1, 2, 3, 4].map((hourDisplay, rowIdx) => {
                const hour24 = rowIdx + 9;
                return (
                  <div key={hourDisplay} className="grid grid-cols-12 border-b border-slate-100 min-h-[58px]">
                    <div className="col-span-1 p-2 border-r border-slate-200 text-xs text-slate-400 font-mono">
                      {hourDisplay}{rowIdx < 3 ? 'am' : 'pm'}
                    </div>

                    {weekDays.map((day) => {
                      const daySlotMeetings = meetings.filter(m => {
                        if (m.date !== day.dateStr) return false;
                        if (hour24 === 9) return m.startHour <= 9;
                        if (hour24 === 16) return m.startHour >= 16;
                        return m.startHour === hour24;
                      });

                      return (
                        <div
                          key={day.dateStr}
                          className="col-span-2 p-1 border-r border-slate-200 last:border-r-0 relative hover:bg-slate-50/50 transition"
                        >
                          {daySlotMeetings.map((m) => (
                            <div
                              key={m.id}
                              onClick={() => {
                                setSelectedMeeting(m);
                                setMeetingNotes(m.description || '');
                                setRescheduleDate(m.date);
                                setRescheduleTime(m.startTime || '10:00');
                              }}
                              className={`p-1.5 rounded-md border shadow-2xs hover:border-blue-400 hover:shadow-xs transition cursor-pointer ${
                                m.isCompleted
                                  ? 'bg-emerald-50/70 border-emerald-200'
                                  : 'bg-white border-slate-200'
                              }`}
                              title="Click to view details, reschedule, complete, or create follow-up"
                            >
                              <div className="flex items-center justify-between gap-1">
                                <span className="text-[11px] font-bold text-slate-900 truncate">
                                  {m.title}
                                </span>
                                {m.isCompleted && (
                                  <span className="text-[9px] font-bold text-emerald-700 bg-emerald-100 px-1 rounded shrink-0">
                                    Done
                                  </span>
                                )}
                              </div>
                              <div className="text-[9px] text-slate-500 truncate flex items-center gap-1 mt-0.5">
                                <Clock className="w-2.5 h-2.5 text-slate-400" />
                                <span>{m.startTime} - {m.endTime}</span>
                              </div>
                            </div>
                          ))}
                        </div>
                      );
                    })}

                    <div className="col-span-1 p-1"></div>
                  </div>
                );
              })}

              {/* 5:00 PM Row: Daily Wrap-up Banner (Image 2 style) */}
              <div className="grid grid-cols-12 border-b border-slate-200 min-h-[44px] bg-slate-50/30">
                <div className="col-span-1 p-2 border-r border-slate-200 text-xs text-slate-400 font-mono">5pm</div>
                {weekDays.map((d) => (
                  <div key={d.dateStr} className="col-span-2 p-1 border-r border-slate-200 last:border-r-0">
                    <div className="p-1 rounded bg-purple-100/90 text-purple-900 border border-purple-300 text-[10px] font-semibold truncate">
                      Post the day's activity, 5:30 - 6:00pm
                    </div>
                  </div>
                ))}
                <div className="col-span-1 p-1"></div>
              </div>

            </div>
          </div>
        </div>
      )}

      {/* ========================================================================= */}
      {/* MODAL: CREATE FOLLOW-UP TASK                                              */}
      {/* ========================================================================= */}
      {showNewTaskModal && (
        <div className="fixed inset-0 z-50 bg-black/40 backdrop-blur-xs flex items-center justify-center p-4">
          <div className="bg-white rounded-xl shadow-2xl border border-slate-200 w-full max-w-md overflow-hidden">
            <div className="px-5 py-3.5 border-b border-slate-200 bg-slate-50 flex items-center justify-between">
              <h3 className="text-sm font-bold text-slate-900">Create Follow-up Action</h3>
              <button onClick={() => setShowNewTaskModal(false)} className="text-slate-400 hover:text-slate-600">
                <X className="w-4 h-4" />
              </button>
            </div>

            <form onSubmit={handleCreateTask} className="p-5 space-y-3">
              <div>
                <label className="block text-xs font-semibold text-slate-700 mb-1">Company Name *</label>
                <input
                  type="text"
                  required
                  value={newTaskCompany}
                  onChange={(e) => setNewTaskCompany(e.target.value)}
                  placeholder="e.g. PT Safa Farma"
                  className="w-full px-3 py-1.5 text-xs border border-slate-300 rounded focus:outline-blue-500"
                />
              </div>

              <div>
                <label className="block text-xs font-semibold text-slate-700 mb-1">Contact Person</label>
                <input
                  type="text"
                  value={newTaskContact}
                  onChange={(e) => setNewTaskContact(e.target.value)}
                  placeholder="e.g. Willy / Ibu Dewi"
                  className="w-full px-3 py-1.5 text-xs border border-slate-300 rounded focus:outline-blue-500"
                />
              </div>

              <div>
                <label className="block text-xs font-semibold text-slate-700 mb-1">Task Action / Title *</label>
                <input
                  type="text"
                  required
                  value={newTaskTitle}
                  onChange={(e) => setNewTaskTitle(e.target.value)}
                  placeholder="e.g. Call customer regarding COA verification"
                  className="w-full px-3 py-1.5 text-xs border border-slate-300 rounded focus:outline-blue-500"
                />
              </div>

              <div className="grid grid-cols-2 gap-2">
                <div>
                  <label className="block text-xs font-semibold text-slate-700 mb-1">Due Date (Jakarta WIB) *</label>
                  <input
                    type="date"
                    required
                    value={newTaskDate}
                    onChange={(e) => setNewTaskDate(e.target.value)}
                    className="w-full px-2.5 py-1.5 text-xs border border-slate-300 rounded"
                  />
                </div>
                <div>
                  <label className="block text-xs font-semibold text-slate-700 mb-1">Time</label>
                  <input
                    type="time"
                    value={newTaskTime}
                    onChange={(e) => setNewTaskTime(e.target.value)}
                    className="w-full px-2.5 py-1.5 text-xs border border-slate-300 rounded"
                  />
                </div>
              </div>

              <div className="grid grid-cols-2 gap-2">
                <div>
                  <label className="block text-xs font-semibold text-slate-700 mb-1">Status Tag</label>
                  <select
                    value={newTaskStatus}
                    onChange={(e) => setNewTaskStatus(e.target.value as any)}
                    className="w-full px-2.5 py-1.5 text-xs border border-slate-300 rounded bg-white"
                  >
                    <option value="Follow-up focus">Follow-up focus</option>
                    <option value="VIP">VIP</option>
                    <option value="Qualified">Qualified</option>
                    <option value="Qualify">Qualify</option>
                    <option value="Urgent">Urgent</option>
                  </select>
                </div>

                <div>
                  <label className="block text-xs font-semibold text-slate-700 mb-1">Assign to Salesperson</label>
                  <select
                    value={newTaskAssignedTo}
                    onChange={(e) => setNewTaskAssignedTo(e.target.value)}
                    className="w-full px-2.5 py-1.5 text-xs border border-slate-300 rounded bg-white font-medium"
                  >
                    {salesMembers.map(m => (
                      <option key={m.id} value={m.id}>{m.name}</option>
                    ))}
                  </select>
                </div>
              </div>

              <div>
                <label className="block text-xs font-semibold text-slate-700 mb-1">Notes / Description</label>
                <textarea
                  rows={2}
                  value={newTaskNotes}
                  onChange={(e) => setNewTaskNotes(e.target.value)}
                  placeholder="Key points or requirements..."
                  className="w-full px-3 py-1.5 text-xs border border-slate-300 rounded"
                />
              </div>

              <div className="pt-3 border-t border-slate-200 flex justify-end gap-2">
                <button
                  type="button"
                  onClick={() => setShowNewTaskModal(false)}
                  className="px-3 py-1.5 text-xs font-semibold text-slate-600 hover:bg-slate-100 rounded"
                >
                  Cancel
                </button>
                <button
                  type="submit"
                  disabled={savingTask}
                  className="px-4 py-1.5 text-xs font-bold bg-blue-600 text-white rounded hover:bg-blue-700 disabled:opacity-50"
                >
                  {savingTask ? 'Saving...' : 'Add Action'}
                </button>
              </div>
            </form>
          </div>
        </div>
      )}

      {/* ========================================================================= */}
      {/* MODAL: CREATE NEW MEETING                                                 */}
      {/* ========================================================================= */}
      {showNewMeetingModal && (
        <div className="fixed inset-0 z-50 bg-black/40 backdrop-blur-xs flex items-center justify-center p-4">
          <div className="bg-white rounded-xl shadow-2xl border border-slate-200 w-full max-w-md overflow-hidden">
            <div className="px-5 py-3.5 border-b border-slate-200 bg-slate-50 flex items-center justify-between">
              <h3 className="text-sm font-bold text-slate-900">Schedule Client Meeting</h3>
              <button onClick={() => setShowNewMeetingModal(false)} className="text-slate-400 hover:text-slate-600">
                <X className="w-4 h-4" />
              </button>
            </div>

            <form onSubmit={handleCreateMeeting} className="p-5 space-y-3">
              <div>
                <label className="block text-xs font-semibold text-slate-700 mb-1">Meeting Title *</label>
                <input
                  type="text"
                  required
                  value={newMeetingTitle}
                  onChange={(e) => setNewMeetingTitle(e.target.value)}
                  placeholder="e.g. Sales call to close enterprise batch"
                  className="w-full px-3 py-1.5 text-xs border border-slate-300 rounded focus:outline-blue-500"
                />
              </div>

              <div className="grid grid-cols-2 gap-2">
                <div>
                  <label className="block text-xs font-semibold text-slate-700 mb-1">Company *</label>
                  <input
                    type="text"
                    required
                    value={newMeetingCompany}
                    onChange={(e) => setNewMeetingCompany(e.target.value)}
                    placeholder="e.g. PT Safa Farma"
                    className="w-full px-3 py-1.5 text-xs border border-slate-300 rounded"
                  />
                </div>
                <div>
                  <label className="block text-xs font-semibold text-slate-700 mb-1">Contact Person</label>
                  <input
                    type="text"
                    value={newMeetingContact}
                    onChange={(e) => setNewMeetingContact(e.target.value)}
                    placeholder="e.g. Willy"
                    className="w-full px-3 py-1.5 text-xs border border-slate-300 rounded"
                  />
                </div>
              </div>

              <div className="grid grid-cols-3 gap-2">
                <div>
                  <label className="block text-xs font-semibold text-slate-700 mb-1">Date</label>
                  <input
                    type="date"
                    value={newMeetingDate}
                    onChange={(e) => setNewMeetingDate(e.target.value)}
                    className="w-full px-2 py-1.5 text-xs border border-slate-300 rounded"
                  />
                </div>
                <div>
                  <label className="block text-xs font-semibold text-slate-700 mb-1">Start Time</label>
                  <input
                    type="time"
                    value={newMeetingStartTime}
                    onChange={(e) => setNewMeetingStartTime(e.target.value)}
                    className="w-full px-2 py-1.5 text-xs border border-slate-300 rounded"
                  />
                </div>
                <div>
                  <label className="block text-xs font-semibold text-slate-700 mb-1">End Time</label>
                  <input
                    type="time"
                    value={newMeetingEndTime}
                    onChange={(e) => setNewMeetingEndTime(e.target.value)}
                    className="w-full px-2 py-1.5 text-xs border border-slate-300 rounded"
                  />
                </div>
              </div>

              <div>
                <label className="block text-xs font-semibold text-slate-700 mb-1">Meeting Type</label>
                <select
                  value={newMeetingType}
                  onChange={(e) => setNewMeetingType(e.target.value as any)}
                  className="w-full px-2.5 py-1.5 text-xs border border-slate-300 rounded bg-white"
                >
                  <option value="meeting">In-Person Meeting</option>
                  <option value="video_call">Google Meet / Video Call</option>
                  <option value="phone_call">Phone Call</option>
                </select>
              </div>

              <div>
                <label className="block text-xs font-semibold text-slate-700 mb-1">Agenda / Discussion Points</label>
                <textarea
                  rows={2}
                  value={newMeetingAgenda}
                  onChange={(e) => setNewMeetingAgenda(e.target.value)}
                  placeholder="Topics, pricing terms, COA documents..."
                  className="w-full px-3 py-1.5 text-xs border border-slate-300 rounded"
                />
              </div>

              <div className="pt-3 border-t border-slate-200 flex justify-end gap-2">
                <button
                  type="button"
                  onClick={() => setShowNewMeetingModal(false)}
                  className="px-3 py-1.5 text-xs font-semibold text-slate-600 hover:bg-slate-100 rounded"
                >
                  Cancel
                </button>
                <button
                  type="submit"
                  disabled={savingMeeting}
                  className="px-4 py-1.5 text-xs font-bold bg-blue-600 text-white rounded hover:bg-blue-700 disabled:opacity-50"
                >
                  {savingMeeting ? 'Scheduling...' : 'Schedule Meeting'}
                </button>
              </div>
            </form>
          </div>
        </div>
      )}
      {/* ========================================================================= */}
      {/* MODAL: VIEW / EDIT / COMPLETE MEETING                                     */}
      {/* ========================================================================= */}
      {selectedMeeting && (
        <div className="fixed inset-0 z-50 bg-black/40 backdrop-blur-xs flex items-center justify-center p-4">
          <div className="bg-white rounded-xl shadow-2xl border border-slate-200 w-full max-w-lg overflow-hidden animate-in fade-in duration-150">
            <div className="px-5 py-3.5 border-b border-slate-200 bg-slate-50 flex items-center justify-between">
              <div className="flex items-center gap-2">
                <Calendar className="w-4 h-4 text-purple-600" />
                <h3 className="text-sm font-bold text-slate-900">Meeting Details & Actions</h3>
              </div>
              <button
                onClick={() => setSelectedMeeting(null)}
                className="text-slate-400 hover:text-slate-600 p-1 rounded"
              >
                <X className="w-4 h-4" />
              </button>
            </div>

            <div className="p-5 space-y-4 max-h-[80vh] overflow-y-auto">
              {/* Meeting Header */}
              <div className="p-3 bg-purple-50/60 border border-purple-200/80 rounded-lg">
                <div className="flex items-start justify-between gap-2">
                  <div>
                    <h4 className="text-sm font-bold text-purple-950">{selectedMeeting.title}</h4>
                    <div className="text-xs text-purple-800 font-medium mt-0.5">
                      {selectedMeeting.companyName} {selectedMeeting.contactPerson ? `• ${selectedMeeting.contactPerson}` : ''}
                    </div>
                  </div>
                  <span className={`px-2 py-0.5 rounded text-[10px] font-bold ${
                    selectedMeeting.isCompleted
                      ? 'bg-emerald-100 text-emerald-800 border border-emerald-300'
                      : 'bg-amber-100 text-amber-800 border border-amber-300'
                  }`}>
                    {selectedMeeting.isCompleted ? 'Completed' : 'Scheduled'}
                  </span>
                </div>
                <div className="text-xs text-slate-600 mt-2 flex items-center gap-2 font-mono">
                  <Clock className="w-3.5 h-3.5 text-purple-600" />
                  <span>{selectedMeeting.date} ({selectedMeeting.startTime} - {selectedMeeting.endTime})</span>
                </div>
              </div>

              {/* 1. Reschedule Section */}
              <div className="border border-slate-200 rounded-lg p-3 space-y-2">
                <div className="flex items-center justify-between">
                  <span className="text-xs font-bold text-slate-800">Reschedule Meeting</span>
                  <span className="text-[10px] text-slate-400">Jakarta Time (+07:00)</span>
                </div>
                <div className="grid grid-cols-2 gap-2">
                  <div>
                    <label className="block text-[10px] text-slate-500 font-semibold mb-0.5">New Date</label>
                    <input
                      type="date"
                      value={rescheduleDate}
                      onChange={(e) => setRescheduleDate(e.target.value)}
                      className="w-full px-2.5 py-1 text-xs border border-slate-300 rounded"
                    />
                  </div>
                  <div>
                    <label className="block text-[10px] text-slate-500 font-semibold mb-0.5">New Time</label>
                    <input
                      type="time"
                      value={rescheduleTime}
                      onChange={(e) => setRescheduleTime(e.target.value)}
                      className="w-full px-2.5 py-1 text-xs border border-slate-300 rounded"
                    />
                  </div>
                </div>
                <button
                  type="button"
                  disabled={updatingMeeting}
                  onClick={handleRescheduleMeeting}
                  className="w-full py-1.5 px-3 bg-slate-100 hover:bg-slate-200 text-slate-700 rounded text-xs font-semibold transition"
                >
                  {updatingMeeting ? 'Updating...' : 'Save Reschedule'}
                </button>
              </div>

              {/* 2. Complete Meeting & Notes Section */}
              <div className="border border-slate-200 rounded-lg p-3 space-y-2">
                <span className="text-xs font-bold text-slate-800 block">Complete Meeting & Log Notes</span>
                <p className="text-[11px] text-slate-500">
                  Notes entered here are automatically appended to the customer's 360 activity timeline.
                </p>
                <textarea
                  rows={3}
                  value={meetingNotes}
                  onChange={(e) => setMeetingNotes(e.target.value)}
                  placeholder="Enter meeting discussion points, client requirements, agreed terms..."
                  className="w-full px-3 py-1.5 text-xs border border-slate-300 rounded focus:outline-blue-500"
                />
                <button
                  type="button"
                  disabled={updatingMeeting}
                  onClick={handleCompleteMeeting}
                  className="w-full py-1.5 px-3 bg-emerald-600 hover:bg-emerald-700 text-white rounded text-xs font-bold transition flex items-center justify-center gap-1.5"
                >
                  <Check className="w-3.5 h-3.5" />
                  <span>{updatingMeeting ? 'Saving...' : 'Mark Meeting Completed & Save Notes'}</span>
                </button>
              </div>

              {/* 3. Follow-up Action from Meeting */}
              <div className="pt-2 border-t border-slate-200 flex items-center justify-between gap-2">
                <button
                  type="button"
                  onClick={() => handleCreateFollowupFromMeeting(selectedMeeting)}
                  className="py-1.5 px-3 bg-blue-50 hover:bg-blue-100 text-blue-700 border border-blue-200 rounded text-xs font-bold transition flex items-center gap-1.5"
                >
                  <Plus className="w-3.5 h-3.5" />
                  <span>Create Follow-up Action from Meeting</span>
                </button>

                <button
                  type="button"
                  onClick={() => setSelectedMeeting(null)}
                  className="py-1.5 px-3 text-xs font-semibold text-slate-500 hover:bg-slate-100 rounded"
                >
                  Close
                </button>
              </div>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
