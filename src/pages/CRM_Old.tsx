import { useEffect, useState } from 'react';
import { Layout } from '../components/Layout';
import { Modal } from '../components/Modal';
import { useLanguage } from '../contexts/LanguageContext';
import { useAuth } from '../contexts/AuthContext';
import { supabase } from '../lib/supabase';
import { Plus, Edit, Trash2, Phone, Mail, MessageSquare, Calendar, CheckCircle, FileText, AlertCircle, TrendingUp, Star, Users } from 'lucide-react';
import { QuotationManager } from '../components/crm/QuotationManager';

interface CRMLead {
  id: string;
  company_name: string;
  contact_person: string;
  email: string;
  phone: string;
  product_interest: string;
  quantity_interest: string;
  lead_source: string;
  status: 'inquiry' | 'quotation' | 'negotiation' | 'won' | 'lost';
  assigned_to: string;
  expected_close_date: string | null;
  estimated_value: number | null;
  notes: string | null;
  priority: 'low' | 'medium' | 'high' | 'urgent';
  next_follow_up: string | null;
  lead_score: number;
  tags: string[] | null;
  deal_value: number;
  created_at: string;
  user_profiles?: {
    full_name: string;
  };
}

interface Activity {
  id: string;
  lead_id: string | null;
  customer_id: string | null;
  activity_type: 'call' | 'email' | 'meeting' | 'note';
  subject: string;
  description: string | null;
  follow_up_date: string | null;
  is_completed: boolean;
  created_at: string;
}

export function CRM() {
  const { t } = useLanguage();
  const { profile } = useAuth();
  const [leads, setLeads] = useState<CRMLead[]>([]);
  const [selectedLead, setSelectedLead] = useState<CRMLead | null>(null);
  const [activities, setActivities] = useState<Activity[]>([]);
  const [loading, setLoading] = useState(true);
  const [modalOpen, setModalOpen] = useState(false);
  const [activityModalOpen, setActivityModalOpen] = useState(false);
  const [editingLead, setEditingLead] = useState<CRMLead | null>(null);
  const [filterStatus, setFilterStatus] = useState<string>('all');
  const [activeTab, setActiveTab] = useState<'details' | 'quotations'>('details');
  const [formData, setFormData] = useState({
    company_name: '',
    contact_person: '',
    email: '',
    phone: '',
    product_interest: '',
    quantity_interest: '',
    lead_source: '',
    status: 'inquiry' as CRMLead['status'],
    priority: 'medium' as CRMLead['priority'],
    expected_close_date: '',
    deal_value: 0,
    lead_score: 50,
    notes: '',
  });
  const [activityFormData, setActivityFormData] = useState({
    activity_type: 'note' as Activity['activity_type'],
    subject: '',
    description: '',
    follow_up_date: '',
  });

  useEffect(() => {
    loadLeads();
  }, []);

  useEffect(() => {
    if (selectedLead) {
      loadActivities(selectedLead.id);
    }
  }, [selectedLead]);

  const loadLeads = async () => {
    try {
      const { data, error } = await supabase
        .from('crm_leads')
        .select('*, user_profiles!crm_leads_assigned_to_fkey(full_name)')
        .order('created_at', { ascending: false });

      if (error) throw error;
      setLeads(data || []);
    } catch (error) {
      console.error('Error loading leads:', error);
    } finally {
      setLoading(false);
    }
  };

  const loadActivities = async (leadId: string) => {
    try {
      const { data, error } = await supabase
        .from('crm_activities')
        .select('*')
        .eq('lead_id', leadId)
        .order('created_at', { ascending: false });

      if (error) throw error;
      setActivities(data || []);
    } catch (error) {
      console.error('Error loading activities:', error);
    }
  };

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();

    try {
      const { data: { user } } = await supabase.auth.getUser();
      if (!user) throw new Error('Not authenticated');

      if (editingLead) {
        const { error } = await supabase
          .from('crm_leads')
          .update(formData)
          .eq('id', editingLead.id);

        if (error) throw error;
      } else {
        const { error } = await supabase
          .from('crm_leads')
          .insert([{
            ...formData,
            assigned_to: user.id,
            expected_close_date: formData.expected_close_date || null,
            notes: formData.notes || null,
          }]);

        if (error) throw error;
      }

      setModalOpen(false);
      resetForm();
      loadLeads();
    } catch (error) {
      console.error('Error saving lead:', error);
      alert('Failed to save lead. Please try again.');
    }
  };

  const handleActivitySubmit = async (e: React.FormEvent) => {
    e.preventDefault();

    if (!selectedLead) return;

    try {
      const { data: { user } } = await supabase.auth.getUser();
      if (!user) throw new Error('Not authenticated');

      const { error } = await supabase
        .from('crm_activities')
        .insert([{
          lead_id: selectedLead.id,
          customer_id: null,
          ...activityFormData,
          description: activityFormData.description || null,
          follow_up_date: activityFormData.follow_up_date || null,
          is_completed: false,
          created_by: user.id,
        }]);

      if (error) throw error;

      setActivityModalOpen(false);
      resetActivityForm();
      loadActivities(selectedLead.id);
    } catch (error) {
      console.error('Error saving activity:', error);
      alert('Failed to save activity. Please try again.');
    }
  };

  const handleEdit = (lead: CRMLead) => {
    setEditingLead(lead);
    setFormData({
      company_name: lead.company_name,
      contact_person: lead.contact_person,
      email: lead.email,
      phone: lead.phone,
      product_interest: lead.product_interest,
      quantity_interest: lead.quantity_interest || '',
      lead_source: lead.lead_source || '',
      status: lead.status,
      priority: lead.priority || 'medium',
      expected_close_date: lead.expected_close_date || '',
      deal_value: lead.deal_value || 0,
      lead_score: lead.lead_score || 50,
      notes: lead.notes || '',
    });
    setModalOpen(true);
  };

  const handleDelete = async (id: string) => {
    if (!confirm('Are you sure you want to delete this lead?')) return;

    try {
      const { error } = await supabase
        .from('crm_leads')
        .delete()
        .eq('id', id);

      if (error) throw error;
      loadLeads();
      if (selectedLead?.id === id) {
        setSelectedLead(null);
      }
    } catch (error) {
      console.error('Error deleting lead:', error);
      alert('Failed to delete lead. Please try again.');
    }
  };

  const toggleActivityCompleted = async (activity: Activity) => {
    try {
      const { error } = await supabase
        .from('crm_activities')
        .update({ is_completed: !activity.is_completed })
        .eq('id', activity.id);

      if (error) throw error;
      if (selectedLead) {
        loadActivities(selectedLead.id);
      }
    } catch (error) {
      console.error('Error updating activity:', error);
    }
  };

  const resetForm = () => {
    setEditingLead(null);
    setFormData({
      company_name: '',
      contact_person: '',
      email: '',
      phone: '',
      product_interest: '',
      quantity_interest: '',
      lead_source: '',
      status: 'inquiry',
      priority: 'medium',
      expected_close_date: '',
      deal_value: 0,
      lead_score: 50,
      notes: '',
    });
  };

  const resetActivityForm = () => {
    setActivityFormData({
      activity_type: 'note',
      subject: '',
      description: '',
      follow_up_date: '',
    });
  };

  const statusConfig = {
    inquiry: { label: 'Inquiry', color: 'bg-gray-100 text-gray-800' },
    quotation: { label: 'Quotation', color: 'bg-blue-100 text-blue-800' },
    negotiation: { label: 'Negotiation', color: 'bg-yellow-100 text-yellow-800' },
    won: { label: 'Won', color: 'bg-green-100 text-green-800' },
    lost: { label: 'Lost', color: 'bg-red-100 text-red-800' },
  };

  const activityIcons = {
    call: Phone,
    email: Mail,
    meeting: Calendar,
    note: MessageSquare,
  };

  const filteredLeads = filterStatus === 'all'
    ? leads
    : leads.filter(lead => lead.status === filterStatus);

  const stats = {
    total: leads.length,
    inquiry: leads.filter(l => l.status === 'inquiry').length,
    quotation: leads.filter(l => l.status === 'quotation').length,
    negotiation: leads.filter(l => l.status === 'negotiation').length,
    won: leads.filter(l => l.status === 'won').length,
  };

  const canManage = profile?.role === 'admin' || profile?.role === 'sales';

  return (
    <Layout>
      <div className="space-y-6">
        <div className="flex items-center justify-between">
          <div>
            <h1 className="text-3xl font-bold text-gray-900">CRM - Lead Management</h1>
            <p className="text-gray-600 mt-1">Manage leads and track customer interactions</p>
          </div>
          {canManage && (
            <button
              onClick={() => {
                resetForm();
                setModalOpen(true);
              }}
              className="flex items-center gap-2 bg-blue-600 text-white px-4 py-2 rounded-lg hover:bg-blue-700 transition"
            >
              <Plus className="w-5 h-5" />
              Add Lead
            </button>
          )}
        </div>

        <div className="grid grid-cols-1 md:grid-cols-5 gap-4">
          <div className="bg-white rounded-lg shadow p-6">
            <p className="text-sm text-gray-600">Total Leads</p>
            <p className="text-2xl font-bold text-gray-900 mt-1">{stats.total}</p>
          </div>
          <div className="bg-gray-50 rounded-lg shadow p-6">
            <p className="text-sm text-gray-600">Inquiry</p>
            <p className="text-2xl font-bold text-gray-800 mt-1">{stats.inquiry}</p>
          </div>
          <div className="bg-blue-50 rounded-lg shadow p-6">
            <p className="text-sm text-blue-600">Quotation</p>
            <p className="text-2xl font-bold text-blue-600 mt-1">{stats.quotation}</p>
          </div>
          <div className="bg-yellow-50 rounded-lg shadow p-6">
            <p className="text-sm text-yellow-600">Negotiation</p>
            <p className="text-2xl font-bold text-yellow-600 mt-1">{stats.negotiation}</p>
          </div>
          <div className="bg-green-50 rounded-lg shadow p-6">
            <p className="text-sm text-green-600">Won</p>
            <p className="text-2xl font-bold text-green-600 mt-1">{stats.won}</p>
          </div>
        </div>

        <div className="flex gap-2">
          <button
            onClick={() => setFilterStatus('all')}
            className={`px-4 py-2 rounded-lg transition ${
              filterStatus === 'all' ? 'bg-blue-600 text-white' : 'bg-white text-gray-700 hover:bg-gray-50'
            }`}
          >
            All Leads
          </button>
          {Object.entries(statusConfig).map(([key, config]) => (
            <button
              key={key}
              onClick={() => setFilterStatus(key)}
              className={`px-4 py-2 rounded-lg transition ${
                filterStatus === key ? 'bg-blue-600 text-white' : 'bg-white text-gray-700 hover:bg-gray-50'
              }`}
            >
              {config.label}
            </button>
          ))}
        </div>

        <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
          <div className="bg-white rounded-lg shadow">
            <div className="p-4 border-b border-gray-200">
              <h2 className="text-lg font-semibold">Leads</h2>
            </div>
            <div className="divide-y divide-gray-200 max-h-[600px] overflow-y-auto">
              {loading ? (
                <div className="p-8 text-center">
                  <div className="animate-spin rounded-full h-8 w-8 border-b-2 border-blue-600 mx-auto" />
                </div>
              ) : filteredLeads.length === 0 ? (
                <div className="p-8 text-center text-gray-500">No leads found</div>
              ) : (
                filteredLeads.map((lead) => (
                  <div
                    key={lead.id}
                    className={`p-4 hover:bg-gray-50 cursor-pointer transition ${
                      selectedLead?.id === lead.id ? 'bg-blue-50' : ''
                    }`}
                    onClick={() => setSelectedLead(lead)}
                  >
                    <div className="flex items-start justify-between">
                      <div className="flex-1">
                        <h3 className="font-semibold text-gray-900">{lead.company_name}</h3>
                        <p className="text-sm text-gray-600">{lead.contact_person}</p>
                        <div className="flex items-center gap-2 mt-2">
                          <span className={`text-xs px-2 py-1 rounded-full ${statusConfig[lead.status].color}`}>
                            {statusConfig[lead.status].label}
                          </span>
                          <span className="text-xs text-gray-500">{lead.product_interest}</span>
                        </div>
                      </div>
                      {canManage && (
                        <div className="flex items-center gap-2">
                          <button
                            onClick={(e) => {
                              e.stopPropagation();
                              handleEdit(lead);
                            }}
                            className="p-1 text-blue-600 hover:bg-blue-50 rounded"
                          >
                            <Edit className="w-4 h-4" />
                          </button>
                          <button
                            onClick={(e) => {
                              e.stopPropagation();
                              handleDelete(lead.id);
                            }}
                            className="p-1 text-red-600 hover:bg-red-50 rounded"
                          >
                            <Trash2 className="w-4 h-4" />
                          </button>
                        </div>
                      )}
                    </div>
                  </div>
                ))
              )}
            </div>
          </div>

          <div className="bg-white rounded-lg shadow">
            <div className="border-b border-gray-200">
              <div className="flex items-center justify-between p-4">
                <h2 className="text-lg font-semibold">
                  {selectedLead ? selectedLead.company_name : 'Select a Lead'}
                </h2>
                {selectedLead && canManage && (
                  <div className="flex gap-2">
                    <button
                      onClick={() => {
                        setActivityFormData({
                          activity_type: 'note',
                          subject: '',
                          description: '',
                          follow_up_date: '',
                        });
                        setActivityModalOpen(true);
                      }}
                      className="flex items-center gap-2 bg-green-600 text-white px-3 py-1.5 rounded-lg hover:bg-green-700 transition text-sm"
                    >
                      <MessageSquare className="w-4 h-4" />
                      Quick Note
                    </button>
                    <button
                      onClick={() => setActivityModalOpen(true)}
                      className="flex items-center gap-2 bg-blue-600 text-white px-3 py-1.5 rounded-lg hover:bg-blue-700 transition text-sm"
                    >
                      <Plus className="w-4 h-4" />
                      Add Activity
                    </button>
                  </div>
                )}
              </div>

              {selectedLead && (
                <div className="flex px-4">
                  <button
                    onClick={() => setActiveTab('details')}
                    className={`px-4 py-2 border-b-2 transition ${
                      activeTab === 'details'
                        ? 'border-blue-500 text-blue-600 font-medium'
                        : 'border-transparent text-gray-500 hover:text-gray-700'
                    }`}
                  >
                    Details & Activities
                  </button>
                  <button
                    onClick={() => setActiveTab('quotations')}
                    className={`px-4 py-2 border-b-2 transition ${
                      activeTab === 'quotations'
                        ? 'border-blue-500 text-blue-600 font-medium'
                        : 'border-transparent text-gray-500 hover:text-gray-700'
                    }`}
                  >
                    <FileText className="w-4 h-4 inline mr-1" />
                    Quotations
                  </button>
                </div>
              )}
            </div>

            <div className="p-4 max-h-[600px] overflow-y-auto">
              {selectedLead ? (
                <>
                  {activeTab === 'details' ? (
                    <div className="space-y-6">
                      <div className="space-y-3">
                        <div>
                          <span className="text-sm text-gray-600">Contact Person:</span>
                          <p className="font-medium">{selectedLead.contact_person}</p>
                        </div>
                        <div className="grid grid-cols-2 gap-3">
                          <div>
                            <span className="text-sm text-gray-600">Email:</span>
                            <p className="font-medium text-sm">{selectedLead.email}</p>
                          </div>
                          <div>
                            <span className="text-sm text-gray-600">Phone:</span>
                            <p className="font-medium text-sm">{selectedLead.phone}</p>
                          </div>
                        </div>
                        <div>
                          <span className="text-sm text-gray-600">Product Interest:</span>
                          <p className="font-medium">{selectedLead.product_interest}</p>
                        </div>
                        <div className="grid grid-cols-2 gap-3">
                          <div>
                            <span className="text-sm text-gray-600">Priority:</span>
                            <span className={`inline-block px-2 py-1 rounded-full text-xs font-medium ml-2 ${
                              selectedLead.priority === 'urgent' ? 'bg-red-100 text-red-800' :
                              selectedLead.priority === 'high' ? 'bg-orange-100 text-orange-800' :
                              selectedLead.priority === 'medium' ? 'bg-yellow-100 text-yellow-800' :
                              'bg-gray-100 text-gray-800'
                            }`}>
                              {selectedLead.priority?.toUpperCase() || 'MEDIUM'}
                            </span>
                          </div>
                          <div>
                            <span className="text-sm text-gray-600">Lead Score:</span>
                            <span className="font-medium ml-2">{selectedLead.lead_score || 50}/100</span>
                          </div>
                        </div>
                        <div>
                          <span className="text-sm text-gray-600">Deal Value:</span>
                          <p className="font-semibold text-blue-600">
                            Rp {(selectedLead.deal_value || 0).toLocaleString('id-ID')}
                          </p>
                        </div>
                        {selectedLead.next_follow_up && (
                          <div>
                            <span className="text-sm text-gray-600">Next Follow-up:</span>
                            <p className="font-medium text-blue-600">
                              {new Date(selectedLead.next_follow_up).toLocaleString()}
                            </p>
                          </div>
                        )}
                        {selectedLead.notes && (
                          <div>
                            <span className="text-sm text-gray-600">Notes:</span>
                            <p className="text-sm mt-1">{selectedLead.notes}</p>
                          </div>
                        )}
                      </div>

                      <div className="border-t pt-4">
                        <h3 className="font-semibold mb-3">Activities</h3>
                    <div className="space-y-3">
                      {activities.length === 0 ? (
                        <p className="text-sm text-gray-500 text-center py-4">No activities yet</p>
                      ) : (
                        activities.map((activity) => {
                          const Icon = activityIcons[activity.activity_type];
                          return (
                            <div
                              key={activity.id}
                              className={`p-3 rounded-lg border ${
                                activity.is_completed ? 'bg-gray-50 border-gray-200' : 'bg-white border-blue-200'
                              }`}
                            >
                              <div className="flex items-start gap-3">
                                <Icon className="w-5 h-5 text-gray-600 mt-0.5" />
                                <div className="flex-1">
                                  <div className="flex items-start justify-between">
                                    <div>
                                      <p className="font-medium text-sm">{activity.subject}</p>
                                      <p className="text-xs text-gray-500 mt-1">
                                        {new Date(activity.created_at).toLocaleDateString()}
                                      </p>
                                    </div>
                                    <button
                                      onClick={() => toggleActivityCompleted(activity)}
                                      className={`p-1 rounded ${
                                        activity.is_completed ? 'text-green-600' : 'text-gray-400 hover:text-green-600'
                                      }`}
                                    >
                                      <CheckCircle className="w-5 h-5" />
                                    </button>
                                  </div>
                                  {activity.description && (
                                    <p className="text-sm text-gray-600 mt-2">{activity.description}</p>
                                  )}
                                  {activity.follow_up_date && (
                                    <p className="text-xs text-blue-600 mt-2">
                                      Follow-up: {new Date(activity.follow_up_date).toLocaleDateString()}
                                    </p>
                                  )}
                                </div>
                              </div>
                            </div>
                          );
                        })
                      )}
                    </div>
                  </div>
                    </div>
                  ) : (
                    <QuotationManager
                      leadId={selectedLead.id}
                      canManage={canManage}
                    />
                  )}
                </>
              ) : (
                <div className="text-center text-gray-500 py-12">
                  <MessageSquare className="w-12 h-12 mx-auto text-gray-300 mb-3" />
                  <p>Select a lead to view details and activities</p>
                </div>
              )}
            </div>
          </div>
        </div>

        <Modal
          isOpen={modalOpen}
          onClose={() => {
            setModalOpen(false);
            resetForm();
          }}
          title={editingLead ? 'Edit Lead' : 'Add New Lead'}
        >
          <form onSubmit={handleSubmit} className="space-y-4">
            <div className="grid grid-cols-2 gap-4">
              <div>
                <label className="block text-sm font-medium text-gray-700 mb-1">
                  Company Name *
                </label>
                <input
                  type="text"
                  value={formData.company_name}
                  onChange={(e) => setFormData({ ...formData, company_name: e.target.value })}
                  className="w-full px-3 py-2 border border-gray-300 rounded-lg focus:ring-2 focus:ring-blue-500"
                  required
                />
              </div>

              <div>
                <label className="block text-sm font-medium text-gray-700 mb-1">
                  Contact Person *
                </label>
                <input
                  type="text"
                  value={formData.contact_person}
                  onChange={(e) => setFormData({ ...formData, contact_person: e.target.value })}
                  className="w-full px-3 py-2 border border-gray-300 rounded-lg focus:ring-2 focus:ring-blue-500"
                  required
                />
              </div>

              <div>
                <label className="block text-sm font-medium text-gray-700 mb-1">
                  Email *
                </label>
                <input
                  type="email"
                  value={formData.email}
                  onChange={(e) => setFormData({ ...formData, email: e.target.value })}
                  className="w-full px-3 py-2 border border-gray-300 rounded-lg focus:ring-2 focus:ring-blue-500"
                  required
                />
              </div>

              <div>
                <label className="block text-sm font-medium text-gray-700 mb-1">
                  Phone *
                </label>
                <input
                  type="text"
                  value={formData.phone}
                  onChange={(e) => setFormData({ ...formData, phone: e.target.value })}
                  className="w-full px-3 py-2 border border-gray-300 rounded-lg focus:ring-2 focus:ring-blue-500"
                  required
                />
              </div>

              <div>
                <label className="block text-sm font-medium text-gray-700 mb-1">
                  Product Interest *
                </label>
                <input
                  type="text"
                  value={formData.product_interest}
                  onChange={(e) => setFormData({ ...formData, product_interest: e.target.value })}
                  className="w-full px-3 py-2 border border-gray-300 rounded-lg focus:ring-2 focus:ring-blue-500"
                  required
                  placeholder="e.g., Paracetamol DC 90"
                />
              </div>

              <div>
                <label className="block text-sm font-medium text-gray-700 mb-1">
                  Quantity Interest
                </label>
                <input
                  type="text"
                  value={formData.quantity_interest}
                  onChange={(e) => setFormData({ ...formData, quantity_interest: e.target.value })}
                  className="w-full px-3 py-2 border border-gray-300 rounded-lg focus:ring-2 focus:ring-blue-500"
                  placeholder="e.g., 500 kg"
                />
              </div>

              <div>
                <label className="block text-sm font-medium text-gray-700 mb-1">
                  Lead Source
                </label>
                <select
                  value={formData.lead_source}
                  onChange={(e) => setFormData({ ...formData, lead_source: e.target.value })}
                  className="w-full px-3 py-2 border border-gray-300 rounded-lg focus:ring-2 focus:ring-blue-500"
                >
                  <option value="">Select source</option>
                  <option value="website">Website</option>
                  <option value="referral">Referral</option>
                  <option value="trade_show">Trade Show</option>
                  <option value="cold_call">Cold Call</option>
                  <option value="email">Email</option>
                  <option value="other">Other</option>
                </select>
              </div>

              <div>
                <label className="block text-sm font-medium text-gray-700 mb-1">
                  Priority *
                </label>
                <select
                  value={formData.priority}
                  onChange={(e) => setFormData({ ...formData, priority: e.target.value as any })}
                  className="w-full px-3 py-2 border border-gray-300 rounded-lg focus:ring-2 focus:ring-blue-500"
                  required
                >
                  <option value="low">Low</option>
                  <option value="medium">Medium</option>
                  <option value="high">High</option>
                  <option value="urgent">Urgent</option>
                </select>
              </div>

              <div>
                <label className="block text-sm font-medium text-gray-700 mb-1">
                  Status *
                </label>
                <select
                  value={formData.status}
                  onChange={(e) => setFormData({ ...formData, status: e.target.value as any })}
                  className="w-full px-3 py-2 border border-gray-300 rounded-lg focus:ring-2 focus:ring-blue-500"
                  required
                >
                  {Object.entries(statusConfig).map(([key, config]) => (
                    <option key={key} value={key}>{config.label}</option>
                  ))}
                </select>
              </div>

              <div>
                <label className="block text-sm font-medium text-gray-700 mb-1">
                  Lead Score (0-100)
                </label>
                <input
                  type="number"
                  value={formData.lead_score}
                  onChange={(e) => setFormData({ ...formData, lead_score: Number(e.target.value) })}
                  className="w-full px-3 py-2 border border-gray-300 rounded-lg focus:ring-2 focus:ring-blue-500"
                  min="0"
                  max="100"
                />
              </div>

              <div>
                <label className="block text-sm font-medium text-gray-700 mb-1">
                  Deal Value (Rp)
                </label>
                <input
                  type="number"
                  value={formData.deal_value === 0 ? '' : formData.deal_value}
                  onChange={(e) => setFormData({ ...formData, deal_value: e.target.value === '' ? 0 : Number(e.target.value) })}
                  className="w-full px-3 py-2 border border-gray-300 rounded-lg focus:ring-2 focus:ring-blue-500"
                  min="0"
                  placeholder="0"
                />
              </div>

              <div className="col-span-2">
                <label className="block text-sm font-medium text-gray-700 mb-1">
                  Expected Close Date
                </label>
                <input
                  type="date"
                  value={formData.expected_close_date}
                  onChange={(e) => setFormData({ ...formData, expected_close_date: e.target.value })}
                  className="w-full px-3 py-2 border border-gray-300 rounded-lg focus:ring-2 focus:ring-blue-500"
                />
              </div>

              <div className="col-span-2">
                <label className="block text-sm font-medium text-gray-700 mb-1">
                  Notes
                </label>
                <textarea
                  value={formData.notes}
                  onChange={(e) => setFormData({ ...formData, notes: e.target.value })}
                  className="w-full px-3 py-2 border border-gray-300 rounded-lg focus:ring-2 focus:ring-blue-500"
                  rows={3}
                />
              </div>
            </div>

            <div className="flex justify-end gap-3 pt-4">
              <button
                type="button"
                onClick={() => {
                  setModalOpen(false);
                  resetForm();
                }}
                className="px-4 py-2 border border-gray-300 rounded-lg hover:bg-gray-50 transition"
              >
                Cancel
              </button>
              <button
                type="submit"
                className="px-4 py-2 bg-blue-600 text-white rounded-lg hover:bg-blue-700 transition"
              >
                {editingLead ? 'Update Lead' : 'Add Lead'}
              </button>
            </div>
          </form>
        </Modal>

        <Modal
          isOpen={activityModalOpen}
          onClose={() => {
            setActivityModalOpen(false);
            resetActivityForm();
          }}
          title="Add Activity"
        >
          <form onSubmit={handleActivitySubmit} className="space-y-4">
            <div>
              <label className="block text-sm font-medium text-gray-700 mb-1">
                Activity Type *
              </label>
              <select
                value={activityFormData.activity_type}
                onChange={(e) => setActivityFormData({ ...activityFormData, activity_type: e.target.value as any })}
                className="w-full px-3 py-2 border border-gray-300 rounded-lg focus:ring-2 focus:ring-blue-500"
                required
              >
                <option value="call">Phone Call</option>
                <option value="email">Email</option>
                <option value="meeting">Meeting</option>
                <option value="note">Note</option>
              </select>
            </div>

            <div>
              <label className="block text-sm font-medium text-gray-700 mb-1">
                Subject *
              </label>
              <input
                type="text"
                value={activityFormData.subject}
                onChange={(e) => setActivityFormData({ ...activityFormData, subject: e.target.value })}
                className="w-full px-3 py-2 border border-gray-300 rounded-lg focus:ring-2 focus:ring-blue-500"
                required
                placeholder="Brief summary of the activity"
              />
            </div>

            <div>
              <label className="block text-sm font-medium text-gray-700 mb-1">
                Description
              </label>
              <textarea
                value={activityFormData.description}
                onChange={(e) => setActivityFormData({ ...activityFormData, description: e.target.value })}
                className="w-full px-3 py-2 border border-gray-300 rounded-lg focus:ring-2 focus:ring-blue-500"
                rows={4}
                placeholder="Detailed notes about the activity"
              />
            </div>

            <div>
              <label className="block text-sm font-medium text-gray-700 mb-1">
                Follow-up Date
              </label>
              <input
                type="date"
                value={activityFormData.follow_up_date}
                onChange={(e) => setActivityFormData({ ...activityFormData, follow_up_date: e.target.value })}
                className="w-full px-3 py-2 border border-gray-300 rounded-lg focus:ring-2 focus:ring-blue-500"
              />
            </div>

            <div className="flex justify-end gap-3 pt-4">
              <button
                type="button"
                onClick={() => {
                  setActivityModalOpen(false);
                  resetActivityForm();
                }}
                className="px-4 py-2 border border-gray-300 rounded-lg hover:bg-gray-50 transition"
              >
                Cancel
              </button>
              <button
                type="submit"
                className="px-4 py-2 bg-blue-600 text-white rounded-lg hover:bg-blue-700 transition"
              >
                Add Activity
              </button>
            </div>
          </form>
        </Modal>
      </div>
    </Layout>
  );
}
