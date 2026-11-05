import React, { useEffect, useMemo, useState } from 'react';
import { supabase } from '../../lib/supabase';
import { useAuth } from '../../contexts/AuthContext';
import { showToast } from '../ToastNotification';
import { normalizeE164 } from '../../utils/phoneValidation';
import {
  Building2,
  User,
  Phone,
  Mail,
  Calendar,
  Clock,
  CheckCircle2,
  Tag,
  Plus,
  ChevronRight,
  MoreVertical,
  ExternalLink,
  MessageSquare,
  FileText,
  Bell,
  Copy,
  Check,
  Search,
  RefreshCw,
  X,
  AlertCircle,
  Briefcase,
} from 'lucide-react';

interface Props {
  initialCustomerId?: string;
  onOpenInquiry?: (inquiryId: string) => void;
  onNavigateInbox?: (phone?: string) => void;
}

export function Customer360Panel({
  initialCustomerId,
  onOpenInquiry,
  onNavigateInbox,
}: Props) {
  const { user, profile } = useAuth();
  const [customers, setCustomers] = useState<any[]>([]);
  const [selectedCustomerId, setSelectedCustomerId] = useState<string | null>(initialCustomerId || null);
  const [searchFilter, setSearchFilter] = useState('');
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);

  // Selected Customer Details
  const [customer, setCustomer] = useState<any>(null);
  const [relatedContacts, setRelatedContacts] = useState<any[]>([]);
  const [timelineItems, setTimelineItems] = useState<any[]>([]);
  const [selectedMeetingDetail, setSelectedMeetingDetail] = useState<any | null>(null);
  const [accountOwner, setAccountOwner] = useState<string>('Unassigned');
  const [dealMetrics, setDealMetrics] = useState<{
    dealSize: string;
    stage: string;
    closeDate: string;
    probability: number | null;
  }>({
    dealSize: '—',
    stage: 'Lead / Prospect',
    closeDate: '—',
    probability: null,
  });

  // Log Activity Dropdown & Modals
  const [showLogMenu, setShowLogMenu] = useState(false);
  const [activeLogModal, setActiveLogModal] = useState<'call' | 'note' | 'followup' | 'meeting' | null>(null);

  // Form states for Logging Activity
  const [callNotes, setCallNotes] = useState('');
  const [callProducts, setCallProducts] = useState('');
  const [callRequirements, setCallRequirements] = useState('');
  const [callCompetitorPrice, setCallCompetitorPrice] = useState('');
  const [callNextAction, setCallNextAction] = useState('');
  const [callFollowupDate, setCallFollowupDate] = useState(new Date().toISOString().split('T')[0]);

  const [noteContent, setNoteContent] = useState('');
  const [followupTitle, setFollowupTitle] = useState('');
  const [followupDate, setFollowupDate] = useState(new Date().toISOString().split('T')[0]);

  const [meetingTitle, setMeetingTitle] = useState('');
  const [meetingDate, setMeetingDate] = useState(new Date().toISOString().split('T')[0]);
  const [meetingTime, setMeetingTime] = useState('13:30');
  const [meetingAgenda, setMeetingAgenda] = useState('');

  const [copiedPhone, setCopiedPhone] = useState<string | null>(null);
  const [savingLog, setSavingLog] = useState(false);

  useEffect(() => {
    loadCustomers();
  }, []);

  useEffect(() => {
    if (initialCustomerId) {
      setSelectedCustomerId(initialCustomerId);
    }
  }, [initialCustomerId]);

  useEffect(() => {
    if (selectedCustomerId) {
      loadCustomerDetails(selectedCustomerId);
    }
  }, [selectedCustomerId]);

  const loadCustomers = async () => {
    setLoading(true);
    setLoadError(null);
    try {
      const { data, error } = await supabase
        .from('crm_contacts')
        .select('id, company_name, contact_person, city, customer_type, is_active')
        .eq('is_active', true)
        .order('company_name', { ascending: true });

      if (error) throw error;
      const list = data || [];
      setCustomers(list);
      if (!selectedCustomerId && list.length > 0) {
        setSelectedCustomerId(list[0].id);
      }
    } catch (err: any) {
      console.error('Error loading customers for 360 view:', err);
      setLoadError(err.message || 'Failed to load customer list.');
    } finally {
      setLoading(false);
    }
  };

  const loadCustomerDetails = async (cid: string) => {
    try {
      // 1. Fetch contact info
      const { data: cust } = await supabase
        .from('crm_contacts')
        .select('*')
        .eq('id', cid)
        .single();
      setCustomer(cust);

      // 1b. Fetch account owner assignment
      try {
        const { data: assignment } = await supabase
          .from('customer_assignments')
          .select('sales_member_id, sales_team_members(id, name, email)')
          .eq('crm_contact_id', cid)
          .eq('is_active', true)
          .maybeSingle();

        const ownerName = (assignment as any)?.sales_team_members?.name;
        setAccountOwner(ownerName || 'Unassigned');
      } catch (e) {
        setAccountOwner('Unassigned');
      }

      // 1c. Fetch deal / inquiry metrics
      try {
        const { data: inqs } = await supabase
          .from('crm_inquiries')
          .select('id, inquiry_number, status, pipeline_status, total_estimated_value, estimated_value, target_close_date, probability_percent')
          .eq('customer_id', cid)
          .order('created_at', { ascending: false });

        if (inqs && inqs.length > 0) {
          const totalVal = inqs.reduce((acc, curr) => acc + Number(curr.total_estimated_value || curr.estimated_value || 0), 0);
          const topInq = inqs[0];
          const stageFormatted = topInq.pipeline_status
            ? topInq.pipeline_status.replace(/_/g, ' ')
            : (topInq.status ? topInq.status.charAt(0).toUpperCase() + topInq.status.slice(1) : 'Qualified');

          let dateStr = '—';
          if (topInq.target_close_date) {
            try {
              dateStr = new Date(topInq.target_close_date).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' });
            } catch {
              dateStr = topInq.target_close_date;
            }
          }

          setDealMetrics({
            dealSize: totalVal > 0 ? `Rp ${totalVal.toLocaleString('id-ID')}` : (topInq.estimated_value ? `Rp ${Number(topInq.estimated_value).toLocaleString('id-ID')}` : 'Rp 0'),
            stage: stageFormatted,
            closeDate: dateStr,
            probability: topInq.probability_percent ?? 70,
          });
        } else {
          setDealMetrics({
            dealSize: '—',
            stage: cust?.customer_type ? `${cust.customer_type} Account` : 'Lead / Prospect',
            closeDate: '—',
            probability: null,
          });
        }
      } catch (e) {
        setDealMetrics({
          dealSize: '—',
          stage: 'Lead / Prospect',
          closeDate: '—',
          probability: null,
        });
      }

      // 2. Fetch multi-phone / related contact records from crm_contact_phones & group by person
      const { data: phones } = await supabase
        .from('crm_contact_phones')
        .select('*')
        .eq('contact_id', cid);

      const personMap = new Map<string, { id: string; name: string; department: string; phones: string[]; email?: string }>();

      (phones || []).forEach((p: any) => {
        const personName = (p.contact_person || cust?.contact_person || 'Representative').trim();
        const num = p.normalized_phone || p.raw_phone;
        if (!personMap.has(personName)) {
          personMap.set(personName, {
            id: p.id,
            name: personName,
            department: p.department || cust?.designation || 'Procurement',
            phones: num ? [num] : [],
            email: cust?.email,
          });
        } else {
          const existing = personMap.get(personName)!;
          if (num && !existing.phones.includes(num)) {
            existing.phones.push(num);
          }
          if (p.department && !existing.department) {
            existing.department = p.department;
          }
        }
      });

      // If no phone records in sub-table, construct from customer record
      if (personMap.size === 0 && cust) {
        const pList = [cust.phone, cust.mobile].filter(Boolean);
        const name = cust.contact_person || 'Lead Representative';
        personMap.set(name, {
          id: cust.id,
          name: name,
          department: cust.designation || 'Purchasing',
          phones: pList.length > 0 ? pList : [],
          email: cust.email || '',
        });
      }

      setRelatedContacts(Array.from(personMap.values()));

      // 3. Fetch unified timeline items (Calls, Emails, Meetings, Notes, WhatsApp)
      const stream: any[] = [];

      // A. crm_activities (calls, meetings, notes)
      const { data: activities } = await supabase
        .from('crm_activities')
        .select('*')
        .eq('customer_id', cid)
        .order('created_at', { ascending: false });

      (activities || []).forEach((a: any) => {
        stream.push({
          id: `act-${a.id}`,
          type: a.activity_type === 'call' || a.activity_type === 'phone_call' ? 'call' : (a.activity_type === 'meeting' ? 'meeting' : 'note'),
          title: a.subject,
          description: a.description || 'Logged sales interaction',
          timestamp: a.follow_up_date || a.created_at,
          status: a.is_completed ? 'Completed' : 'Upcoming',
          participants: a.participants || ['Kunal (Sales Manager)', cust?.contact_person || 'Customer Representative'],
          tags: ['Raw Material', 'Discovery'],
        });
      });

      // B. enquiry_conversations messages (WhatsApp & Email)
      const { data: convs } = await supabase
        .from('enquiry_conversations')
        .select(`
          id,
          channel,
          title,
          enquiry_conversation_messages (
            id,
            sender_name,
            direction,
            body_text,
            received_or_sent_at
          )
        `)
        .eq('crm_contact_id', cid)
        .limit(5);

      (convs || []).forEach((c: any) => {
        (c.enquiry_conversation_messages || []).forEach((m: any) => {
          stream.push({
            id: `msg-${m.id}`,
            type: c.channel === 'whatsapp' ? 'whatsapp' : 'email',
            title: c.channel === 'whatsapp' ? 'WhatsApp Interaction' : 'Email Sent',
            description: m.body_text || 'Message exchanged with customer',
            timestamp: m.received_or_sent_at,
            status: 'Delivered',
            direction: m.direction,
          });
        });
      });

      stream.sort((a, b) => new Date(b.timestamp).getTime() - new Date(a.timestamp).getTime());
      setTimelineItems(stream);
      // Select the first meeting as expanded active by default
      const firstMeeting = stream.find(s => s.type === 'meeting');
      if (firstMeeting) setSelectedMeetingDetail(firstMeeting);
    } catch (err) {
      console.error('Error loading customer details:', err);
    }
  };

  const handleCopyPhone = (phoneNum: string) => {
    navigator.clipboard.writeText(phoneNum);
    setCopiedPhone(phoneNum);
    setTimeout(() => setCopiedPhone(null), 2000);
    showToast({ type: 'success', title: 'Copied', message: `Copied ${phoneNum} to clipboard.` });
  };

  // Submit Activity Logger
  const handleSaveActivity = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!customer) return;

    setSavingLog(true);
    try {
      const creatorId = profile?.id || '1075a773-bb55-4296-bc71-af2eab9a0780';

      if (activeLogModal === 'call') {
        const fullSubject = `Phone Call: Discussed ${callProducts || 'Materials'}`;
        const fullDesc = `Discussion: ${callNotes}\nRequirements: ${callRequirements}\nCompetitor Price: ${callCompetitorPrice}\nNext Action: ${callNextAction}`;

        const { error } = await supabase.from('crm_activities').insert({
          customer_id: customer.id,
          activity_type: 'call',
          subject: fullSubject,
          description: fullDesc,
          follow_up_date: new Date(callFollowupDate).toISOString(),
          created_by: creatorId,
          is_completed: true,
        });
        if (error) throw error;

        showToast({ type: 'success', title: 'Phone Call Logged', message: 'Call discussion & follow-up saved.' });
      } else if (activeLogModal === 'note') {
        const { error } = await supabase.from('crm_activities').insert({
          customer_id: customer.id,
          activity_type: 'note',
          subject: 'Internal Note',
          description: noteContent.trim(),
          created_by: creatorId,
          is_completed: true,
        });
        if (error) throw error;

        showToast({ type: 'success', title: 'Note Saved', message: 'Internal memo recorded on timeline.' });
      } else if (activeLogModal === 'followup') {
        const { error } = await supabase.from('crm_activities').insert({
          customer_id: customer.id,
          activity_type: 'follow_up',
          subject: followupTitle.trim(),
          follow_up_date: new Date(followupDate).toISOString(),
          created_by: creatorId,
          is_completed: false,
        });
        if (error) throw error;

        showToast({ type: 'success', title: 'Follow-up Created', message: 'Action added to customer timeline.' });
      } else if (activeLogModal === 'meeting') {
        const { error } = await supabase.from('crm_activities').insert({
          customer_id: customer.id,
          activity_type: 'meeting',
          subject: meetingTitle.trim(),
          description: meetingAgenda.trim(),
          follow_up_date: new Date(`${meetingDate}T${meetingTime}:00+07:00`).toISOString(),
          created_by: creatorId,
          is_completed: false,
        });
        if (error) throw error;

        showToast({ type: 'success', title: 'Meeting Scheduled', message: 'Meeting recorded.' });
      }

      setActiveLogModal(null);
      loadCustomerDetails(customer.id);
    } catch (err: any) {
      showToast({ type: 'error', title: 'Save Failed', message: err.message });
    } finally {
      setSavingLog(false);
    }
  };

  const filteredCustomers = useMemo(() => {
    const q = searchFilter.toLowerCase().trim();
    return customers.filter(c =>
      c.company_name.toLowerCase().includes(q) ||
      (c.contact_person && c.contact_person.toLowerCase().includes(q))
    );
  }, [customers, searchFilter]);

  const initials = (name?: string) => {
    if (!name) return 'AC';
    const parts = name.split(' ').filter(Boolean);
    if (parts.length >= 2) return `${parts[0][0]}${parts[1][0]}`.toUpperCase();
    return name.slice(0, 2).toUpperCase();
  };

  return (
    <div className="space-y-3 animate-in fade-in duration-150">
      
      {/* Top Customer Switcher & Quick Search */}
      <div className="bg-white rounded-xl border border-slate-200/90 shadow-2xs p-3 flex items-center justify-between gap-3 flex-wrap">
        <div className="flex items-center gap-2">
          <Building2 className="w-4 h-4 text-blue-600" />
          <span className="text-xs font-bold text-slate-800 uppercase tracking-wide">
            Customer 360 Workspace
          </span>
          <select
            value={selectedCustomerId || ''}
            onChange={(e) => setSelectedCustomerId(e.target.value)}
            className="text-xs font-bold bg-slate-50 border border-slate-300 rounded px-2.5 py-1 text-slate-900 max-w-xs truncate"
          >
            {customers.map((c) => (
              <option key={c.id} value={c.id}>
                {c.company_name} ({c.contact_person || 'Representative'})
              </option>
            ))}
          </select>
        </div>

        <div className="relative">
          <Search className="w-3.5 h-3.5 absolute left-2.5 top-2 text-slate-400" />
          <input
            type="text"
            value={searchFilter}
            onChange={(e) => setSearchFilter(e.target.value)}
            placeholder="Search company or contact..."
            className="pl-8 pr-3 py-1 text-xs border border-slate-300 rounded-md bg-white w-48 sm:w-64"
          />
        </div>
      </div>

      {loadError && (
        <div className="bg-red-50 border border-red-200 rounded-xl p-4 flex items-center justify-between text-xs text-red-700">
          <div className="flex items-center gap-2">
            <AlertCircle className="w-4 h-4 text-red-600 shrink-0" />
            <span><strong>Database Error:</strong> {loadError}</span>
          </div>
          <button
            onClick={loadCustomers}
            className="inline-flex items-center gap-1 px-2.5 py-1 bg-red-600 text-white rounded text-xs font-semibold hover:bg-red-700 transition"
          >
            <RefreshCw className="w-3 h-3" /> Retry
          </button>
        </div>
      )}

      {/* Main Two-Column Layout (Matching Reference Image 4) */}
      <div className="grid grid-cols-1 lg:grid-cols-12 gap-4 items-start">
        
        {/* LEFT COLUMN: Activity Timeline with + Log Activity (7 cols) */}
        <div className="lg:col-span-8 bg-white rounded-xl border border-slate-200/90 shadow-2xs p-5 relative flex flex-col justify-between min-h-[580px]">
          <div>
            <div className="flex items-center justify-between pb-4 border-b border-slate-100">
              <h2 className="text-base font-bold text-slate-900">Activity Timeline</h2>
              <span className="text-xs text-slate-400 font-medium">Chronological client interactions</span>
            </div>

            {/* Timeline Stream (Image 4 styling) */}
            <div className="relative mt-5 pl-2 sm:pl-4 space-y-5">
              {/* Vertical connecting line */}
              {timelineItems.length > 0 && (
                <div className="absolute left-[88px] sm:left-[96px] top-3 bottom-3 w-0.5 bg-slate-200"></div>
              )}

              {timelineItems.length === 0 ? (
                <div className="py-16 text-center text-xs text-slate-400">
                  No activity recorded for this customer yet. Click <strong className="text-slate-600">+ Log Activity</strong> below to record a call note, meeting, or internal memo.
                </div>
              ) : (
                timelineItems.map((item) => {
                const dateObj = new Date(item.timestamp);
                const timeString = dateObj.toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' });
                const monthDay = dateObj.toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
                const isSelected = selectedMeetingDetail?.id === item.id;

                return (
                  <div key={item.id} className="relative flex items-start gap-4">
                    {/* Timestamp on Left */}
                    <div className="w-16 sm:w-20 text-right shrink-0 pt-1">
                      <div className="text-xs font-bold text-slate-900">{timeString}</div>
                      <div className="text-[10px] text-slate-400">{monthDay}</div>
                    </div>

                    {/* Timeline Node Icon */}
                    <div className="relative z-10 shrink-0">
                      {item.type === 'call' ? (
                        <div className="w-8 h-8 rounded-lg bg-teal-100 text-teal-700 flex items-center justify-center shadow-2xs border border-teal-200">
                          <Phone className="w-4 h-4" />
                        </div>
                      ) : item.type === 'email' ? (
                        <div className="w-8 h-8 rounded-lg bg-purple-100 text-purple-700 flex items-center justify-center shadow-2xs border border-purple-200">
                          <Mail className="w-4 h-4" />
                        </div>
                      ) : item.type === 'meeting' ? (
                        <div className="w-8 h-8 rounded-lg bg-amber-100 text-amber-800 flex items-center justify-center shadow-2xs border border-amber-300">
                          <Calendar className="w-4 h-4" />
                        </div>
                      ) : item.type === 'whatsapp' ? (
                        <div className="w-8 h-8 rounded-lg bg-emerald-100 text-emerald-800 flex items-center justify-center shadow-2xs border border-emerald-300">
                          <MessageSquare className="w-4 h-4" />
                        </div>
                      ) : item.type === 'followup' ? (
                        <div className="w-8 h-8 rounded-lg bg-amber-100 text-amber-700 flex items-center justify-center shadow-2xs border border-amber-200">
                          <Bell className="w-4 h-4" />
                        </div>
                      ) : (
                        <div className="w-8 h-8 rounded-lg bg-slate-100 text-slate-700 flex items-center justify-center shadow-2xs border border-slate-200">
                          <FileText className="w-4 h-4" />
                        </div>
                      )}
                    </div>

                    {/* Timeline Card */}
                    <div className="flex-1 min-w-0">
                      {/* Active / Expanded Meeting Card (Reference Image 4 Style) */}
                      {item.type === 'meeting' ? (
                        <div
                          onClick={() => setSelectedMeetingDetail(item)}
                          className={`p-3.5 rounded-xl border transition cursor-pointer ${
                            isSelected
                              ? 'bg-blue-50/40 border-blue-400 ring-2 ring-blue-100 shadow-xs'
                              : 'bg-white border-slate-200 hover:border-slate-300'
                          }`}
                        >
                          <div className="flex items-center justify-between gap-2">
                            <div className="flex items-center gap-2">
                              <span className="text-xs font-extrabold text-blue-700">Meeting</span>
                              <span className="px-1.5 py-0.5 rounded text-[10px] font-bold bg-teal-50 text-teal-700 border border-teal-200">
                                {item.status || 'Completed'}
                              </span>
                            </div>
                            <span className="text-xs font-semibold text-blue-600 hover:underline flex items-center gap-1">
                              <span>View Details</span>
                              <ChevronRight className="w-3 h-3" />
                            </span>
                          </div>

                          <div className="text-xs font-bold text-slate-900 mt-1">
                            {item.subHeading || item.title || 'Discovery call with customer team'}
                          </div>

                          <div className="mt-2 space-y-1 text-xs text-slate-600">
                            <div className="flex items-center gap-2">
                              <Calendar className="w-3.5 h-3.5 text-slate-400 shrink-0" />
                              <span>{monthDay}, 2026 • {item.timeLabel || '1:30 PM - 2:15 PM'}</span>
                            </div>
                            <div className="flex items-center gap-2">
                              <User className="w-3.5 h-3.5 text-slate-400 shrink-0" />
                              <span>{(item.participants || []).join(', ')}</span>
                            </div>
                            <div className="flex items-center gap-2">
                              <CheckCircle2 className="w-3.5 h-3.5 text-slate-400 shrink-0" />
                              <span>{item.description || 'Discussed pain points, batch goals, and next steps.'}</span>
                            </div>
                          </div>

                          <div className="flex items-center gap-1.5 mt-2.5">
                            {(item.tags || ['Discovery', 'Enterprise Plan']).map((tag: string) => (
                              <span
                                key={tag}
                                className="px-2 py-0.5 rounded text-[10px] font-semibold bg-blue-100/70 text-blue-800 border border-blue-200"
                              >
                                {tag}
                              </span>
                            ))}
                          </div>
                        </div>
                      ) : (
                        /* Standard Activity Card */
                        <div className="p-3 rounded-xl bg-white border border-slate-200/90 hover:border-slate-300 shadow-2xs transition">
                          <div className="flex items-center justify-between gap-2">
                            <div className="flex items-center gap-2">
                              <span className="text-xs font-bold text-slate-900">{item.title}</span>
                              {item.status && (
                                <span className={`px-1.5 py-0.2 rounded text-[9px] font-bold ${
                                  item.status === 'Completed' || item.status === 'Delivered'
                                    ? 'bg-slate-100 text-slate-700'
                                    : 'bg-amber-50 text-amber-800'
                                }`}>
                                  {item.status}
                                </span>
                              )}
                            </div>
                          </div>
                          <p className="text-xs text-slate-600 mt-1 leading-relaxed">
                            {item.description}
                          </p>
                        </div>
                      )}
                    </div>
                  </div>
                );
              }))}
            </div>
          </div>

          {/* Prominent Blue "+ Log Activity" Button at Bottom Center (Image 4) */}
          <div className="pt-6 border-t border-slate-100 flex justify-center relative mt-6">
            <div className="relative inline-block">
              <button
                type="button"
                onClick={() => setShowLogMenu(!showLogMenu)}
                className="px-6 py-2.5 bg-blue-600 hover:bg-blue-700 text-white rounded-lg font-bold text-xs shadow-md transition flex items-center gap-2 cursor-pointer"
              >
                <Plus className="w-4 h-4" />
                <span>+ Log Activity</span>
                <ChevronRight className={`w-3.5 h-3.5 transition transform ${showLogMenu ? 'rotate-90' : ''}`} />
              </button>

              {/* Log Activity Dropdown Options */}
              {showLogMenu && (
                <div className="absolute bottom-full left-1/2 -translate-x-1/2 mb-2 w-56 bg-white rounded-xl shadow-xl border border-slate-200 py-1.5 z-30 animate-in fade-in zoom-in-95 duration-100">
                  <button
                    onClick={() => { setShowLogMenu(false); setActiveLogModal('call'); }}
                    className="w-full text-left px-3.5 py-2 hover:bg-slate-50 flex items-center gap-2.5 text-xs text-slate-800 font-semibold"
                  >
                    <div className="w-6 h-6 rounded bg-teal-100 text-teal-700 flex items-center justify-center">
                      <Phone className="w-3.5 h-3.5" />
                    </div>
                    <span>Phone Call (Discussion & Price)</span>
                  </button>

                  <button
                    onClick={() => { setShowLogMenu(false); setActiveLogModal('note'); }}
                    className="w-full text-left px-3.5 py-2 hover:bg-slate-50 flex items-center gap-2.5 text-xs text-slate-800 font-semibold"
                  >
                    <div className="w-6 h-6 rounded bg-slate-100 text-slate-700 flex items-center justify-center">
                      <FileText className="w-3.5 h-3.5" />
                    </div>
                    <span>Add Internal Note</span>
                  </button>

                  <button
                    onClick={() => { setShowLogMenu(false); setActiveLogModal('followup'); }}
                    className="w-full text-left px-3.5 py-2 hover:bg-slate-50 flex items-center gap-2.5 text-xs text-slate-800 font-semibold"
                  >
                    <div className="w-6 h-6 rounded bg-amber-100 text-amber-700 flex items-center justify-center">
                      <Bell className="w-3.5 h-3.5" />
                    </div>
                    <span>Create Follow-up Action</span>
                  </button>

                  <button
                    onClick={() => { setShowLogMenu(false); setActiveLogModal('meeting'); }}
                    className="w-full text-left px-3.5 py-2 hover:bg-slate-50 flex items-center gap-2.5 text-xs text-slate-800 font-semibold"
                  >
                    <div className="w-6 h-6 rounded bg-purple-100 text-purple-700 flex items-center justify-center">
                      <Calendar className="w-3.5 h-3.5" />
                    </div>
                    <span>Schedule Client Meeting</span>
                  </button>
                </div>
              )}
            </div>
          </div>
        </div>

        {/* RIGHT COLUMN: Company Profile Card (Reference Image 4 Style) (5 cols) */}
        <div className="lg:col-span-4 bg-white rounded-xl border border-slate-200/90 shadow-2xs p-5 space-y-4">
          
          {/* Company Header Card */}
          <div className="flex items-start justify-between gap-3">
            <div className="flex items-center gap-3">
              <div className="w-12 h-12 rounded-xl bg-gradient-to-tr from-blue-600 to-indigo-600 text-white font-black text-lg flex items-center justify-center shadow-xs shrink-0">
                {initials(customer?.company_name)}
              </div>
              <div className="min-w-0">
                <h3 className="text-base font-extrabold text-slate-900 truncate" title={customer?.company_name}>
                  {customer?.company_name || 'Select Customer'}
                </h3>
                <div className="text-xs text-slate-500 font-medium">
                  {customer?.customer_type || 'Enterprise Account'}
                </div>
              </div>
            </div>

            <button className="p-1 text-slate-400 hover:text-slate-600 rounded">
              <MoreVertical className="w-4 h-4" />
            </button>
          </div>

          {/* 2x3 Metric Grid (Image 4) */}
          <div className="grid grid-cols-2 gap-3 pt-2 border-t border-slate-100 text-xs">
            <div>
              <div className="text-[11px] font-semibold text-slate-400">Industry</div>
              <div className="font-bold text-slate-900 truncate">
                {customer?.industry || 'Pharma / Raw Materials'}
              </div>
            </div>

            <div>
              <div className="text-[11px] font-semibold text-slate-400">Account Owner</div>
              <div className="flex items-center gap-1.5 font-bold text-slate-900 truncate">
                <div className="w-4 h-4 rounded-full bg-teal-600 text-white text-[9px] flex items-center justify-center font-bold">
                  {initials(accountOwner)}
                </div>
                <span>{accountOwner}</span>
              </div>
            </div>

            <div>
              <div className="text-[11px] font-semibold text-slate-400">Lifecycle Stage</div>
              <div className="font-bold text-slate-900 truncate">{dealMetrics.stage}</div>
            </div>

            <div>
              <div className="text-[11px] font-semibold text-slate-400">Target Close Date</div>
              <div className="font-bold text-slate-900">{dealMetrics.closeDate}</div>
            </div>

            <div>
              <div className="text-[11px] font-semibold text-slate-400">Deal Size</div>
              <div className="font-extrabold text-slate-900">{dealMetrics.dealSize}</div>
            </div>

            <div>
              <div className="text-[11px] font-semibold text-slate-400">Probability</div>
              <div className="flex items-center gap-2 mt-0.5">
                {dealMetrics.probability !== null ? (
                  <>
                    <span className="font-extrabold text-teal-700">{dealMetrics.probability}%</span>
                    <div className="flex-1 h-1.5 bg-slate-100 rounded-full overflow-hidden">
                      <div
                        className="h-full bg-teal-500 rounded-full"
                        style={{ width: `${Math.min(100, Math.max(0, dealMetrics.probability))}%` }}
                      ></div>
                    </div>
                  </>
                ) : (
                  <span className="font-medium text-slate-400">—</span>
                )}
              </div>
            </div>
          </div>

          {/* About Section */}
          <div className="pt-3 border-t border-slate-100">
            <div className="text-[11px] font-bold text-slate-500 uppercase tracking-wider mb-1">
              About
            </div>
            <p className="text-xs text-slate-600 leading-relaxed">
              {customer?.notes ||
                (customer?.company_name
                  ? `${customer.company_name} is an active pharmaceutical & raw materials manufacturer registered in SAPJ CRM.`
                  : 'Select a customer to view complete CRM 360 profile.')}
            </p>
          </div>

          {/* Related Contacts List (Multi-phone & Department Support) */}
          <div className="pt-3 border-t border-slate-100 space-y-2.5">
            <div className="flex items-center justify-between text-xs">
              <span className="font-bold text-slate-900">Related Contacts ({relatedContacts.length})</span>
              <ChevronRight className="w-3.5 h-3.5 text-slate-400" />
            </div>

            <div className="space-y-2">
              {relatedContacts.map((contact, idx) => (
                <div
                  key={contact.id || idx}
                  className="p-2.5 rounded-lg bg-slate-50 border border-slate-200/80 flex flex-col gap-2"
                >
                  <div className="flex items-center justify-between gap-2">
                    <div className="flex items-center gap-2.5 min-w-0">
                      <div className="w-7 h-7 rounded-lg bg-teal-100 text-teal-800 font-bold text-xs flex items-center justify-center shrink-0">
                        {initials(contact.name)}
                      </div>
                      <div className="min-w-0">
                        <div className="text-xs font-bold text-slate-900 truncate">
                          {contact.name}
                        </div>
                        <div className="text-[10px] text-slate-500 truncate">
                          {contact.department || 'Procurement / QA'}
                        </div>
                      </div>
                    </div>
                  </div>

                  {contact.phones && contact.phones.length > 0 && (
                    <div className="flex flex-wrap gap-1.5 pt-1 border-t border-slate-200/60">
                      {contact.phones.map((ph: string, pIdx: number) => (
                        <div
                          key={pIdx}
                          className="inline-flex items-center gap-1.5 px-2 py-0.5 rounded-md bg-white border border-slate-200 text-[11px] font-mono text-slate-700"
                        >
                          <Phone className="w-3 h-3 text-slate-400" />
                          <span>{ph}</span>
                          <button
                            type="button"
                            onClick={() => handleCopyPhone(ph)}
                            className="p-0.5 hover:text-blue-600 text-slate-400 transition"
                            title={`Copy phone number: ${ph}`}
                          >
                            {copiedPhone === ph ? (
                              <Check className="w-3 h-3 text-emerald-600" />
                            ) : (
                              <Copy className="w-3 h-3" />
                            )}
                          </button>
                          {onNavigateInbox && (
                            <button
                              type="button"
                              onClick={() => onNavigateInbox(ph)}
                              className="p-0.5 hover:text-emerald-600 text-slate-400 transition"
                              title="Open WhatsApp in Inbox"
                            >
                              <MessageSquare className="w-3 h-3" />
                            </button>
                          )}
                        </div>
                      ))}
                    </div>
                  )}
                </div>
              ))}
            </div>
          </div>

          {/* View Account Action */}
          <div className="pt-3 border-t border-slate-100 text-center">
            <button
              onClick={() => showToast({ type: 'info', title: 'Account Master', message: `Full ERP details for ${customer?.company_name}` })}
              className="text-xs font-bold text-blue-600 hover:text-blue-800 flex items-center justify-center gap-1 w-full"
            >
              <span>View Account</span>
              <ChevronRight className="w-3.5 h-3.5" />
            </button>
          </div>

        </div>

      </div>

      {/* ========================================================================= */}
      {/* MODAL: LOG PHONE CALL (DISCUSSION, PRODUCTS, COMPETITOR PRICES)           */}
      {/* ========================================================================= */}
      {activeLogModal === 'call' && (
        <div className="fixed inset-0 z-50 bg-black/40 backdrop-blur-xs flex items-center justify-center p-4">
          <div className="bg-white rounded-xl shadow-2xl border border-slate-200 w-full max-w-lg overflow-hidden">
            <div className="px-5 py-3.5 border-b border-slate-200 bg-slate-50 flex items-center justify-between">
              <div className="flex items-center gap-2">
                <Phone className="w-4 h-4 text-teal-600" />
                <h3 className="text-sm font-bold text-slate-900">Log Customer Phone Call</h3>
              </div>
              <button onClick={() => setActiveLogModal(null)} className="text-slate-400 hover:text-slate-600">
                <X className="w-4 h-4" />
              </button>
            </div>

            <form onSubmit={handleSaveActivity} className="p-5 space-y-3">
              <div>
                <label className="block text-xs font-semibold text-slate-700 mb-1">Products Discussed *</label>
                <input
                  type="text"
                  required
                  value={callProducts}
                  onChange={(e) => setCallProducts(e.target.value)}
                  placeholder="e.g. Pregabalin, Corn Starch, Paracetamol"
                  className="w-full px-3 py-1.5 text-xs border border-slate-300 rounded focus:outline-blue-500"
                />
              </div>

              <div>
                <label className="block text-xs font-semibold text-slate-700 mb-1">Customer Requirements & Specifications</label>
                <input
                  type="text"
                  value={callRequirements}
                  onChange={(e) => setCallRequirements(e.target.value)}
                  placeholder="e.g. EP grade, 25kg drum, COA required"
                  className="w-full px-3 py-1.5 text-xs border border-slate-300 rounded focus:outline-blue-500"
                />
              </div>

              <div className="grid grid-cols-2 gap-2">
                <div>
                  <label className="block text-xs font-semibold text-slate-700 mb-1">Competitor Price Mentioned</label>
                  <input
                    type="text"
                    value={callCompetitorPrice}
                    onChange={(e) => setCallCompetitorPrice(e.target.value)}
                    placeholder="e.g. $31.50/kg or Rp 480,000"
                    className="w-full px-3 py-1.5 text-xs border border-slate-300 rounded"
                  />
                </div>
                <div>
                  <label className="block text-xs font-semibold text-slate-700 mb-1">Next Follow-up Date</label>
                  <input
                    type="date"
                    value={callFollowupDate}
                    onChange={(e) => setCallFollowupDate(e.target.value)}
                    className="w-full px-3 py-1.5 text-xs border border-slate-300 rounded"
                  />
                </div>
              </div>

              <div>
                <label className="block text-xs font-semibold text-slate-700 mb-1">Next Action Required</label>
                <input
                  type="text"
                  value={callNextAction}
                  onChange={(e) => setCallNextAction(e.target.value)}
                  placeholder="e.g. Send revised quotation by tomorrow"
                  className="w-full px-3 py-1.5 text-xs border border-slate-300 rounded"
                />
              </div>

              <div>
                <label className="block text-xs font-semibold text-slate-700 mb-1">Call Discussion Notes</label>
                <textarea
                  rows={2}
                  value={callNotes}
                  onChange={(e) => setCallNotes(e.target.value)}
                  placeholder="Key summary of call discussion..."
                  className="w-full px-3 py-1.5 text-xs border border-slate-300 rounded"
                />
              </div>

              <div className="pt-3 border-t border-slate-200 flex justify-end gap-2">
                <button
                  type="button"
                  onClick={() => setActiveLogModal(null)}
                  className="px-3 py-1.5 text-xs font-semibold text-slate-600 hover:bg-slate-100 rounded"
                >
                  Cancel
                </button>
                <button
                  type="submit"
                  disabled={savingLog}
                  className="px-4 py-1.5 text-xs font-bold bg-teal-600 text-white rounded hover:bg-teal-700 disabled:opacity-50"
                >
                  {savingLog ? 'Saving...' : 'Save Call Activity'}
                </button>
              </div>
            </form>
          </div>
        </div>
      )}

      {/* MODAL: ADD NOTE */}
      {activeLogModal === 'note' && (
        <div className="fixed inset-0 z-50 bg-black/40 backdrop-blur-xs flex items-center justify-center p-4">
          <div className="bg-white rounded-xl shadow-2xl border border-slate-200 w-full max-w-md overflow-hidden">
            <div className="px-5 py-3.5 border-b border-slate-200 bg-slate-50 flex items-center justify-between">
              <h3 className="text-sm font-bold text-slate-900">Add Internal Staff Note</h3>
              <button onClick={() => setActiveLogModal(null)} className="text-slate-400 hover:text-slate-600">
                <X className="w-4 h-4" />
              </button>
            </div>
            <form onSubmit={handleSaveActivity} className="p-5 space-y-3">
              <div>
                <label className="block text-xs font-semibold text-slate-700 mb-1">Note Content *</label>
                <textarea
                  rows={4}
                  required
                  value={noteContent}
                  onChange={(e) => setNoteContent(e.target.value)}
                  placeholder="Enter internal staff notes, background context, or instructions..."
                  className="w-full px-3 py-2 text-xs border border-slate-300 rounded focus:outline-blue-500"
                />
              </div>
              <div className="pt-3 border-t border-slate-200 flex justify-end gap-2">
                <button
                  type="button"
                  onClick={() => setActiveLogModal(null)}
                  className="px-3 py-1.5 text-xs font-semibold text-slate-600 hover:bg-slate-100 rounded"
                >
                  Cancel
                </button>
                <button
                  type="submit"
                  disabled={savingLog}
                  className="px-4 py-1.5 text-xs font-bold bg-blue-600 text-white rounded hover:bg-blue-700 disabled:opacity-50"
                >
                  {savingLog ? 'Saving...' : 'Save Note'}
                </button>
              </div>
            </form>
          </div>
        </div>
      )}

      {/* MODAL: CREATE FOLLOW-UP */}
      {activeLogModal === 'followup' && (
        <div className="fixed inset-0 z-50 bg-black/40 backdrop-blur-xs flex items-center justify-center p-4">
          <div className="bg-white rounded-xl shadow-2xl border border-slate-200 w-full max-w-md overflow-hidden">
            <div className="px-5 py-3.5 border-b border-slate-200 bg-slate-50 flex items-center justify-between">
              <h3 className="text-sm font-bold text-slate-900">Create Follow-up Action</h3>
              <button onClick={() => setActiveLogModal(null)} className="text-slate-400 hover:text-slate-600">
                <X className="w-4 h-4" />
              </button>
            </div>
            <form onSubmit={handleSaveActivity} className="p-5 space-y-3">
              <div>
                <label className="block text-xs font-semibold text-slate-700 mb-1">Action Description *</label>
                <input
                  type="text"
                  required
                  value={followupTitle}
                  onChange={(e) => setFollowupTitle(e.target.value)}
                  placeholder="e.g. Follow up on sample evaluation"
                  className="w-full px-3 py-1.5 text-xs border border-slate-300 rounded focus:outline-blue-500"
                />
              </div>
              <div>
                <label className="block text-xs font-semibold text-slate-700 mb-1">Deadline Date</label>
                <input
                  type="date"
                  value={followupDate}
                  onChange={(e) => setFollowupDate(e.target.value)}
                  className="w-full px-3 py-1.5 text-xs border border-slate-300 rounded"
                />
              </div>
              <div className="pt-3 border-t border-slate-200 flex justify-end gap-2">
                <button
                  type="button"
                  onClick={() => setActiveLogModal(null)}
                  className="px-3 py-1.5 text-xs font-semibold text-slate-600 hover:bg-slate-100 rounded"
                >
                  Cancel
                </button>
                <button
                  type="submit"
                  disabled={savingLog}
                  className="px-4 py-1.5 text-xs font-bold bg-amber-600 text-white rounded hover:bg-amber-700 disabled:opacity-50"
                >
                  {savingLog ? 'Saving...' : 'Create Follow-up'}
                </button>
              </div>
            </form>
          </div>
        </div>
      )}

      {/* MODAL: SCHEDULE MEETING */}
      {activeLogModal === 'meeting' && (
        <div className="fixed inset-0 z-50 bg-black/40 backdrop-blur-xs flex items-center justify-center p-4">
          <div className="bg-white rounded-xl shadow-2xl border border-slate-200 w-full max-w-md overflow-hidden">
            <div className="px-5 py-3.5 border-b border-slate-200 bg-slate-50 flex items-center justify-between">
              <h3 className="text-sm font-bold text-slate-900">Schedule Client Meeting</h3>
              <button onClick={() => setActiveLogModal(null)} className="text-slate-400 hover:text-slate-600">
                <X className="w-4 h-4" />
              </button>
            </div>
            <form onSubmit={handleSaveActivity} className="p-5 space-y-3">
              <div>
                <label className="block text-xs font-semibold text-slate-700 mb-1">Meeting Title *</label>
                <input
                  type="text"
                  required
                  value={meetingTitle}
                  onChange={(e) => setMeetingTitle(e.target.value)}
                  placeholder="e.g. Discovery call on bulk contract terms"
                  className="w-full px-3 py-1.5 text-xs border border-slate-300 rounded focus:outline-blue-500"
                />
              </div>
              <div className="grid grid-cols-2 gap-2">
                <div>
                  <label className="block text-xs font-semibold text-slate-700 mb-1">Date</label>
                  <input
                    type="date"
                    value={meetingDate}
                    onChange={(e) => setMeetingDate(e.target.value)}
                    className="w-full px-3 py-1.5 text-xs border border-slate-300 rounded"
                  />
                </div>
                <div>
                  <label className="block text-xs font-semibold text-slate-700 mb-1">Time</label>
                  <input
                    type="time"
                    value={meetingTime}
                    onChange={(e) => setMeetingTime(e.target.value)}
                    className="w-full px-3 py-1.5 text-xs border border-slate-300 rounded"
                  />
                </div>
              </div>
              <div>
                <label className="block text-xs font-semibold text-slate-700 mb-1">Agenda / Discussion Points</label>
                <textarea
                  rows={2}
                  value={meetingAgenda}
                  onChange={(e) => setMeetingAgenda(e.target.value)}
                  placeholder="Topics to cover..."
                  className="w-full px-3 py-1.5 text-xs border border-slate-300 rounded"
                />
              </div>
              <div className="pt-3 border-t border-slate-200 flex justify-end gap-2">
                <button
                  type="button"
                  onClick={() => setActiveLogModal(null)}
                  className="px-3 py-1.5 text-xs font-semibold text-slate-600 hover:bg-slate-100 rounded"
                >
                  Cancel
                </button>
                <button
                  type="submit"
                  disabled={savingLog}
                  className="px-4 py-1.5 text-xs font-bold bg-purple-600 text-white rounded hover:bg-purple-700 disabled:opacity-50"
                >
                  {savingLog ? 'Saving...' : 'Schedule Meeting'}
                </button>
              </div>
            </form>
          </div>
        </div>
      )}

    </div>
  );
}
