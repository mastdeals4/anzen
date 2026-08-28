import React, { useEffect, useState } from 'react';
import { Layout } from '../components/Layout';
import { supabase } from '../lib/supabase';
import { useAuth } from '../contexts/AuthContext';
import { useLanguage } from '../contexts/LanguageContext';
import { showToast } from '../components/ToastNotification';
import { showConfirm } from '../components/ConfirmDialog';
import {
  Users, Plus, Edit, Trash2, Building, TrendingUp, CheckCircle,
  XCircle, Clock, Search, X, UserPlus, BarChart3, RefreshCw
} from 'lucide-react';
import { Modal } from '../components/Modal';

interface SalesMember {
  id: string;
  name: string;
  email: string | null;
  phone: string | null;
  is_active: boolean;
  created_at: string;
}

interface CustomerAssignment {
  id: string;
  customer_id: string;
  sales_member_id: string;
  is_active: boolean;
  customers: {
    id: string;
    company_name: string;
    contact_person: string | null;
    city: string | null;
    country: string | null;
  };
}

interface Performance {
  member_id: string;
  member_name: string;
  total_inquiries: number;
  new_count: number;
  in_progress_count: number;
  follow_up_count: number;
  won_count: number;
  lost_count: number;
  on_hold_count: number;
  conversion_rate: number;
  assigned_customers: number;
}

interface Customer {
  id: string;
  company_name: string;
  contact_person: string | null;
  city: string | null;
  country: string | null;
}

type ActiveTab = 'overview' | 'assignments';

export function SalesTeam({ embedded = false }: { embedded?: boolean }) {
  const { profile } = useAuth();
  const { t } = useLanguage();
  const [activeTab, setActiveTab] = useState<ActiveTab>('overview');
  const [members, setMembers] = useState<SalesMember[]>([]);
  const [performance, setPerformance] = useState<Performance[]>([]);
  const [assignments, setAssignments] = useState<CustomerAssignment[]>([]);
  const [allCustomers, setAllCustomers] = useState<Customer[]>([]);
  const [loading, setLoading] = useState(true);
  const [selectedMember, setSelectedMember] = useState<SalesMember | null>(null);

  const [memberModal, setMemberModal] = useState(false);
  const [editingMember, setEditingMember] = useState<SalesMember | null>(null);
  const [memberForm, setMemberForm] = useState({ name: '', email: '', phone: '' });

  const [assignModal, setAssignModal] = useState(false);
  const [assigningMember, setAssigningMember] = useState<SalesMember | null>(null);
  const [customerSearch, setCustomerSearch] = useState('');

  const [selectedMemberFilter, setSelectedMemberFilter] = useState<string>('all');

  const isAdmin = profile?.role === 'admin';

  useEffect(() => { loadAll(); }, []);

  const loadAll = async () => {
    setLoading(true);
    await Promise.all([loadMembers(), loadPerformance(), loadAssignments(), loadCustomers()]);
    setLoading(false);
  };

  const loadMembers = async () => {
    const { data } = await supabase.from('sales_team_members').select('*').eq('is_active', true).order('name');
    setMembers(data || []);
  };

  const loadPerformance = async () => {
    const { data } = await supabase.rpc('get_sales_member_performance');
    setPerformance(data || []);
  };

  const loadAssignments = async () => {
    const { data } = await supabase
      .from('customer_assignments')
      .select('*, customers(id, company_name, contact_person, city, country)')
      .eq('is_active', true)
      .order('assigned_at', { ascending: false });
    setAssignments(data || []);
  };

  const loadCustomers = async () => {
    const { data } = await supabase.from('customers').select('id, company_name, contact_person, city, country').eq('is_active', true).order('company_name');
    setAllCustomers(data || []);
  };

  const handleSaveMember = async () => {
    if (!memberForm.name.trim()) return;
    try {
      if (editingMember) {
        const { error } = await supabase.from('sales_team_members')
          .update({ name: memberForm.name, email: memberForm.email || null, phone: memberForm.phone || null })
          .eq('id', editingMember.id);
        if (error) throw error;
        showToast({ type: 'success', title: t('common.success'), message: t('success.updated') });
      } else {
        const { error } = await supabase.from('sales_team_members')
          .insert({ name: memberForm.name, email: memberForm.email || null, phone: memberForm.phone || null });
        if (error) throw error;
        showToast({ type: 'success', title: t('common.success'), message: t('success.created') });
      }
      setMemberModal(false);
      setEditingMember(null);
      setMemberForm({ name: '', email: '', phone: '' });
      loadAll();
    } catch (err: any) {
      showToast({ type: 'error', title: t('common.error'), message: err.message });
    }
  };

  const handleDeleteMember = async (member: SalesMember) => {
    if (!await showConfirm({
      title: t('salesTeam.removeMember'),
      message: `${t('common.delete')} ${member.name}? ${t('salesTeam.removeConfirm')}`,
      variant: 'danger',
      confirmLabel: t('common.delete')
    })) return;
    const { error } = await supabase.from('sales_team_members').update({ is_active: false }).eq('id', member.id);
    if (error) showToast({ type: 'error', title: t('common.error'), message: error.message });
    else { showToast({ type: 'success', title: t('common.success'), message: t('success.deleted') }); loadAll(); }
  };

  const handleAssignCustomer = async (customerId: string) => {
    if (!assigningMember) return;
    try {
      const { error } = await supabase.from('customer_assignments').upsert({
        customer_id: customerId, sales_member_id: assigningMember.id,
        assigned_by: profile?.id, is_active: true,
      }, { onConflict: 'customer_id,sales_member_id' });
      if (error) throw error;
      showToast({ type: 'success', title: t('common.success'), message: t('success.saved') });
      loadAssignments();
    } catch (err: any) {
      showToast({ type: 'error', title: t('common.error'), message: err.message });
    }
  };

  const handleUnassign = async (assignmentId: string) => {
    const { error } = await supabase.from('customer_assignments').update({ is_active: false }).eq('id', assignmentId);
    if (error) showToast({ type: 'error', title: t('common.error'), message: error.message });
    else { showToast({ type: 'success', title: t('common.success'), message: t('success.updated') }); loadAssignments(); }
  };

  const getPerf = (memberId: string) => performance.find(p => p.member_id === memberId);

  const filteredAssignments = selectedMemberFilter === 'all'
    ? assignments
    : assignments.filter(a => a.sales_member_id === selectedMemberFilter);

  const assignedCustomerIds = new Set(
    assignments.filter(a => assigningMember ? a.sales_member_id === assigningMember.id : true).map(a => a.customer_id)
  );

  const availableCustomers = allCustomers.filter(c =>
    !assignedCustomerIds.has(c.id) &&
    (c.company_name?.toLowerCase().includes(customerSearch.toLowerCase()) ||
      (c.contact_person || '').toLowerCase().includes(customerSearch.toLowerCase()))
  );

  const totalWon = performance.reduce((s, p) => s + Number(p.won_count), 0);
  const totalInquiries = performance.reduce((s, p) => s + Number(p.total_inquiries), 0);
  const overallConversion = totalInquiries > 0 ? Math.round(100 * totalWon / totalInquiries) : 0;

  const Wrapper = embedded ? ({ children }: { children: React.ReactNode }) => <div>{children}</div> : Layout;

  if (loading) {
    return (
      <Wrapper>
        <div className="flex items-center justify-center py-20">
          <div className="animate-spin rounded-full h-10 w-10 border-b-2 border-blue-600" />
        </div>
      </Wrapper>
    );
  }

  const pipelineLabels: Record<string, string> = {
    New: t('salesTeam.new'),
    'In Progress': t('salesTeam.inProgress'),
    'Follow Up': t('salesTeam.followUp'),
    'On Hold': t('salesTeam.onHold'),
  };

  return (
    <Wrapper>
      <div className="space-y-6">
        {/* Header */}
        <div className="flex flex-col sm:flex-row sm:items-center gap-3 justify-between">
          <div>
            <h1 className="text-xl sm:text-2xl font-bold text-gray-900">{t('salesTeam.title')}</h1>
            <p className="text-gray-500 text-sm mt-1">{t('salesTeam.subtitle')}</p>
          </div>
          <div className="flex items-center gap-2 self-start sm:self-auto">
            <button onClick={loadAll} className="p-2 text-gray-500 hover:bg-gray-100 rounded-lg" title={t('common.refresh')}>
              <RefreshCw className="w-4 h-4" />
            </button>
            {isAdmin && (
              <button
                onClick={() => { setEditingMember(null); setMemberForm({ name: '', email: '', phone: '' }); setMemberModal(true); }}
                className="flex items-center gap-2 bg-blue-600 text-white px-4 py-2 rounded-lg hover:bg-blue-700 text-sm"
              >
                <Plus className="w-4 h-4" />
                {t('salesTeam.addMember')}
              </button>
            )}
          </div>
        </div>

        {/* Summary Cards */}
        <div className="grid grid-cols-2 lg:grid-cols-4 gap-3 sm:gap-4">
          {[
            { icon: <Users className="w-5 h-5 text-blue-600" />, bg: 'bg-blue-50', label: t('salesTeam.teamMembers'), value: members.length },
            { icon: <Building className="w-5 h-5 text-green-600" />, bg: 'bg-green-50', label: t('salesTeam.assignedCompanies'), value: assignments.length },
            { icon: <TrendingUp className="w-5 h-5 text-orange-600" />, bg: 'bg-orange-50', label: t('salesTeam.totalInquiries'), value: totalInquiries },
            { icon: <BarChart3 className="w-5 h-5 text-emerald-600" />, bg: 'bg-emerald-50', label: t('salesTeam.overallConversion'), value: `${overallConversion}%` },
          ].map((card, i) => (
            <div key={i} className="bg-white rounded-lg border border-gray-200 p-4">
              <div className="flex items-center gap-3">
                <div className={`p-2 ${card.bg} rounded-lg`}>{card.icon}</div>
                <div>
                  <p className="text-xs text-gray-500">{card.label}</p>
                  <p className="text-xl font-bold text-gray-900">{card.value}</p>
                </div>
              </div>
            </div>
          ))}
        </div>

        {/* Tabs */}
        <div className="flex gap-1 border-b border-gray-200">
          {(['overview', 'assignments'] as ActiveTab[]).map(tab => (
            <button
              key={tab}
              onClick={() => setActiveTab(tab)}
              className={`px-4 py-2 text-sm font-medium border-b-2 transition ${
                activeTab === tab ? 'border-blue-600 text-blue-600' : 'border-transparent text-gray-500 hover:text-gray-700'
              }`}
            >
              {tab === 'overview' ? t('salesTeam.performanceOverview') : t('salesTeam.companyAssignments')}
            </button>
          ))}
        </div>

        {/* Overview Tab */}
        {activeTab === 'overview' && (
          <div className="grid grid-cols-1 md:grid-cols-2 xl:grid-cols-3 gap-5">
            {members.map(member => {
              const perf = getPerf(member.id);
              const memberAssignments = assignments.filter(a => a.sales_member_id === member.id);
              const convRate = perf ? Number(perf.conversion_rate) : 0;

              return (
                <div key={member.id} className="bg-white rounded-xl border border-gray-200 overflow-hidden shadow-sm">
                  <div className="bg-gradient-to-r from-blue-600 to-blue-700 px-5 py-4">
                    <div className="flex items-center justify-between">
                      <div className="flex items-center gap-3">
                        <div className="w-10 h-10 bg-white/20 rounded-full flex items-center justify-center text-white font-bold text-lg">
                          {member.name.charAt(0).toUpperCase()}
                        </div>
                        <div>
                          <h3 className="font-semibold text-white">{member.name}</h3>
                          {member.email && <p className="text-xs text-blue-100">{member.email}</p>}
                        </div>
                      </div>
                      {isAdmin && (
                        <div className="flex gap-1">
                          <button
                            onClick={() => { setEditingMember(member); setMemberForm({ name: member.name, email: member.email || '', phone: member.phone || '' }); setMemberModal(true); }}
                            className="p-1.5 bg-white/20 hover:bg-white/30 rounded text-white"
                          >
                            <Edit className="w-3.5 h-3.5" />
                          </button>
                          <button onClick={() => handleDeleteMember(member)} className="p-1.5 bg-white/20 hover:bg-red-500 rounded text-white">
                            <Trash2 className="w-3.5 h-3.5" />
                          </button>
                        </div>
                      )}
                    </div>
                  </div>

                  <div className="px-5 pt-4 pb-2">
                    <div className="flex items-center justify-between mb-1">
                      <span className="text-xs text-gray-500">{t('salesTeam.conversionRate')}</span>
                      <span className={`text-sm font-bold ${convRate >= 50 ? 'text-green-600' : convRate >= 25 ? 'text-orange-500' : 'text-gray-500'}`}>
                        {convRate}%
                      </span>
                    </div>
                    <div className="h-2 bg-gray-100 rounded-full overflow-hidden">
                      <div
                        className={`h-full rounded-full transition-all ${convRate >= 50 ? 'bg-green-500' : convRate >= 25 ? 'bg-orange-400' : 'bg-gray-300'}`}
                        style={{ width: `${Math.min(convRate, 100)}%` }}
                      />
                    </div>
                  </div>

                  <div className="px-5 py-3 grid grid-cols-3 gap-2 text-center border-t border-gray-100">
                    <div>
                      <p className="text-lg font-bold text-gray-900">{perf ? perf.total_inquiries : 0}</p>
                      <p className="text-xs text-gray-400">{t('salesTeam.total')}</p>
                    </div>
                    <div>
                      <p className="text-lg font-bold text-green-600">{perf ? perf.won_count : 0}</p>
                      <p className="text-xs text-gray-400">{t('salesTeam.won')}</p>
                    </div>
                    <div>
                      <p className="text-lg font-bold text-red-500">{perf ? perf.lost_count : 0}</p>
                      <p className="text-xs text-gray-400">{t('salesTeam.lost')}</p>
                    </div>
                  </div>

                  {perf && perf.total_inquiries > 0 && (
                    <div className="px-5 pb-3 space-y-1.5">
                      {[
                        { label: 'New', count: perf.new_count, color: 'bg-gray-400' },
                        { label: 'In Progress', count: perf.in_progress_count, color: 'bg-blue-400' },
                        { label: 'Follow Up', count: perf.follow_up_count, color: 'bg-purple-400' },
                        { label: 'On Hold', count: perf.on_hold_count, color: 'bg-yellow-400' },
                      ].filter(s => s.count > 0).map(s => (
                        <div key={s.label} className="flex items-center gap-2 text-xs">
                          <div className={`w-2 h-2 rounded-full ${s.color}`} />
                          <span className="text-gray-600 flex-1">{pipelineLabels[s.label] || s.label}</span>
                          <span className="font-medium text-gray-800">{s.count}</span>
                        </div>
                      ))}
                    </div>
                  )}

                  <div className="px-5 py-3 bg-gray-50 border-t border-gray-100">
                    <div className="flex items-center justify-between mb-2">
                      <span className="text-xs font-medium text-gray-600">
                        {t('salesTeam.assignedCompanies')} ({memberAssignments.length})
                      </span>
                      {(isAdmin || profile?.role === 'sales') && (
                        <button
                          onClick={() => { setAssigningMember(member); setCustomerSearch(''); setAssignModal(true); }}
                          className="flex items-center gap-1 text-xs text-blue-600 hover:text-blue-700"
                        >
                          <UserPlus className="w-3 h-3" />
                          {t('salesTeam.assign')}
                        </button>
                      )}
                    </div>
                    {memberAssignments.length === 0 ? (
                      <p className="text-xs text-gray-400 italic">{t('salesTeam.noCompaniesAssigned')}</p>
                    ) : (
                      <div className="space-y-1 max-h-28 overflow-y-auto">
                        {memberAssignments.slice(0, 5).map(a => (
                          <div key={a.id} className="flex items-center justify-between group">
                            <div>
                              <span className="text-xs text-gray-700 font-medium">{a.customers?.company_name}</span>
                              {a.customers?.city && <span className="text-xs text-gray-400 ml-1">· {a.customers.city}</span>}
                            </div>
                            {(isAdmin || profile?.role === 'sales') && (
                              <button onClick={() => handleUnassign(a.id)} className="opacity-0 group-hover:opacity-100 p-0.5 text-gray-400 hover:text-red-500">
                                <X className="w-3 h-3" />
                              </button>
                            )}
                          </div>
                        ))}
                        {memberAssignments.length > 5 && (
                          <p className="text-xs text-blue-600 cursor-pointer" onClick={() => { setSelectedMemberFilter(member.id); setActiveTab('assignments'); }}>
                            +{memberAssignments.length - 5} more
                          </p>
                        )}
                      </div>
                    )}
                  </div>
                </div>
              );
            })}

            {members.length === 0 && (
              <div className="col-span-full py-16 text-center text-gray-400">
                <Users className="w-12 h-12 mx-auto mb-3 opacity-30" />
                <p className="text-sm">{t('salesTeam.noMembersYet')}</p>
                {isAdmin && <p className="text-xs mt-1">{t('salesTeam.clickAddMember')}</p>}
              </div>
            )}
          </div>
        )}

        {/* Assignments Tab */}
        {activeTab === 'assignments' && (
          <div className="bg-white rounded-xl border border-gray-200">
            <div className="p-4 border-b border-gray-200 flex flex-wrap items-center gap-3">
              <div className="relative flex-1 min-w-[200px] max-w-xs">
                <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-gray-400" />
                <input
                  type="text" placeholder={t('salesTeam.searchCompanies')}
                  className="pl-9 pr-4 py-2 w-full border border-gray-300 rounded-lg text-sm focus:ring-2 focus:ring-blue-500 outline-none"
                />
              </div>
              <select
                value={selectedMemberFilter}
                onChange={(e) => setSelectedMemberFilter(e.target.value)}
                className="border border-gray-300 rounded-lg px-3 py-2 text-sm focus:ring-2 focus:ring-blue-500 outline-none"
              >
                <option value="all">{t('salesTeam.allMembers')}</option>
                {members.map(m => <option key={m.id} value={m.id}>{m.name}</option>)}
              </select>
            </div>

            {filteredAssignments.length === 0 ? (
              <div className="py-16 text-center text-gray-400">
                <Building className="w-10 h-10 mx-auto mb-3 opacity-30" />
                <p className="text-sm">{t('salesTeam.noAssignmentsFound')}</p>
              </div>
            ) : (
              <div className="overflow-x-auto">
                <table className="w-full text-sm">
                  <thead className="bg-gray-50 border-b border-gray-200">
                    <tr>
                      <th className="px-4 py-3 text-left text-xs font-semibold text-gray-500 uppercase">{t('customers.companyName')}</th>
                      <th className="px-4 py-3 text-left text-xs font-semibold text-gray-500 uppercase hidden sm:table-cell">{t('customers.contactPerson')}</th>
                      <th className="px-4 py-3 text-left text-xs font-semibold text-gray-500 uppercase hidden md:table-cell">{t('customers.city')}</th>
                      <th className="px-4 py-3 text-left text-xs font-semibold text-gray-500 uppercase">{t('crm.assignedTo')}</th>
                      {(isAdmin || profile?.role === 'sales') && (
                        <th className="px-4 py-3 text-center text-xs font-semibold text-gray-500 uppercase w-20">{t('common.actions')}</th>
                      )}
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-gray-100">
                    {filteredAssignments.map(a => {
                      const member = members.find(m => m.id === a.sales_member_id);
                      return (
                        <tr key={a.id} className="hover:bg-gray-50">
                          <td className="px-4 py-3 font-medium text-gray-900">{a.customers?.company_name}</td>
                          <td className="px-4 py-3 text-gray-600 text-xs hidden sm:table-cell">{a.customers?.contact_person || '—'}</td>
                          <td className="px-4 py-3 text-gray-500 text-xs hidden md:table-cell">{[a.customers?.city, a.customers?.country].filter(Boolean).join(', ') || '—'}</td>
                          <td className="px-4 py-3">
                            {member && (
                              <span className="inline-flex items-center gap-1.5 px-2.5 py-1 bg-blue-50 text-blue-700 rounded-full text-xs font-medium">
                                <span className="w-5 h-5 bg-blue-600 text-white rounded-full flex items-center justify-center text-xs font-bold">
                                  {member.name.charAt(0)}
                                </span>
                                {member.name}
                              </span>
                            )}
                          </td>
                          {(isAdmin || profile?.role === 'sales') && (
                            <td className="px-4 py-3 text-center">
                              <button onClick={() => handleUnassign(a.id)} className="p-1.5 text-gray-400 hover:text-red-500 hover:bg-red-50 rounded">
                                <X className="w-3.5 h-3.5" />
                              </button>
                            </td>
                          )}
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              </div>
            )}
          </div>
        )}
      </div>

      {/* Add/Edit Member Modal */}
      <Modal isOpen={memberModal} onClose={() => { setMemberModal(false); setEditingMember(null); }}
        title={editingMember ? t('salesTeam.editMember') : t('salesTeam.addSalesMember')}>
        <div className="space-y-4">
          {[
            { label: `${t('salesTeam.name')} *`, field: 'name', type: 'text', placeholder: 'e.g. Zara', required: true },
            { label: t('salesTeam.email'), field: 'email', type: 'email', placeholder: t('common.optional') },
            { label: t('salesTeam.phone'), field: 'phone', type: 'text', placeholder: t('common.optional') },
          ].map(({ label, field, type, placeholder }) => (
            <div key={field}>
              <label className="block text-sm font-medium text-gray-700 mb-1">{label}</label>
              <input
                type={type}
                value={(memberForm as any)[field]}
                onChange={(e) => setMemberForm({ ...memberForm, [field]: e.target.value })}
                className="w-full px-3 py-2 border border-gray-300 rounded-lg focus:ring-2 focus:ring-blue-500 outline-none"
                placeholder={placeholder}
              />
            </div>
          ))}
          <div className="flex justify-end gap-3 pt-2 border-t">
            <button onClick={() => setMemberModal(false)} className="px-4 py-2 text-sm border border-gray-300 rounded-lg hover:bg-gray-50">{t('common.cancel')}</button>
            <button onClick={handleSaveMember} className="px-4 py-2 text-sm bg-blue-600 text-white rounded-lg hover:bg-blue-700">
              {editingMember ? t('common.update') : t('salesTeam.addMember')}
            </button>
          </div>
        </div>
      </Modal>

      {/* Assign Customer Modal */}
      <Modal isOpen={assignModal} onClose={() => setAssignModal(false)}
        title={`${t('salesTeam.assignCompaniesTo')} ${assigningMember?.name}`} size="lg">
        <div className="space-y-3">
          <div className="relative">
            <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-gray-400" />
            <input
              type="text" value={customerSearch}
              onChange={(e) => setCustomerSearch(e.target.value)}
              placeholder={t('salesTeam.searchCompanies')}
              className="w-full pl-9 pr-4 py-2 border border-gray-300 rounded-lg text-sm focus:ring-2 focus:ring-blue-500 outline-none"
              autoFocus
            />
          </div>

          <div className="max-h-80 overflow-y-auto border border-gray-200 rounded-lg divide-y divide-gray-100">
            {availableCustomers.length === 0 ? (
              <div className="py-8 text-center text-gray-400 text-sm">
                {customerSearch ? t('salesTeam.noMatchingCompanies') : t('salesTeam.allCompaniesAssigned')}
              </div>
            ) : (
              availableCustomers.map(c => (
                <div key={c.id} className="flex items-center justify-between px-3 py-2.5 hover:bg-gray-50">
                  <div>
                    <div className="font-medium text-sm text-gray-900">{c.company_name}</div>
                    <div className="text-xs text-gray-400">{[c.contact_person, c.city].filter(Boolean).join(' · ')}</div>
                  </div>
                  <button
                    onClick={() => handleAssignCustomer(c.id)}
                    className="flex items-center gap-1 px-3 py-1.5 bg-blue-600 text-white text-xs rounded-lg hover:bg-blue-700"
                  >
                    <Plus className="w-3 h-3" />
                    {t('salesTeam.assign')}
                  </button>
                </div>
              ))
            )}
          </div>

          <div className="pt-2 border-t text-right">
            <button onClick={() => setAssignModal(false)} className="px-4 py-2 text-sm border border-gray-300 rounded-lg hover:bg-gray-50">{t('common.done')}</button>
          </div>
        </div>
      </Modal>
    </Wrapper>
  );
}
