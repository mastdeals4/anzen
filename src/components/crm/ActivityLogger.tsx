import { useState, useEffect } from 'react';
import { supabase } from '../../lib/supabase';
import { Phone, Calendar, MessageSquare, FileText, Video, MessageCircle, Plus, CheckCircle, Clock, Trash2, ChevronDown } from 'lucide-react';

interface ActivityLoggerProps {
  inquiryId?: string;
  customerId?: string;
  leadId?: string;
  onActivityLogged?: () => void;
}

interface Activity {
  id: string;
  activity_type: string;
  subject: string;
  description: string | null;
  follow_up_date: string | null;
  is_completed: boolean;
  completed_at: string | null;
  created_at: string;
  created_by: string;
  user_profiles?: {
    full_name: string;
  };
}

const PAGE_SIZE = 10;

export function ActivityLogger({ inquiryId: _inquiryId, customerId, leadId, onActivityLogged }: ActivityLoggerProps) {
  const [activities, setActivities] = useState<Activity[]>([]);
  const [loading, setLoading] = useState(true);
  const [showForm, setShowForm] = useState(false);
  const [visibleCount, setVisibleCount] = useState(PAGE_SIZE);
  const [toast, setToast] = useState<{ msg: string; type: 'success' | 'error' } | null>(null);
  const [confirmDelete, setConfirmDelete] = useState<string | null>(null);
  const [formData, setFormData] = useState({
    activity_type: 'phone_call',
    subject: '',
    description: '',
    follow_up_date: '',
    is_completed: false,
  });

  useEffect(() => {
    loadActivities();
  }, [customerId, leadId]);

  useEffect(() => {
    if (toast) {
      const timer = setTimeout(() => setToast(null), 3000);
      return () => clearTimeout(timer);
    }
  }, [toast]);

  const showToast = (msg: string, type: 'success' | 'error' = 'success') => {
    setToast({ msg, type });
  };

  const loadActivities = async () => {
    try {
      let query = supabase
        .from('crm_activities')
        .select('*, user_profiles!crm_activities_created_by_fkey(full_name)')
        .order('created_at', { ascending: false });

      if (leadId) query = query.eq('lead_id', leadId);
      if (customerId) query = query.eq('customer_id', customerId);

      const { data, error } = await query;
      if (error) throw error;
      setActivities(data || []);
    } catch (error) {
      console.error('Error loading activities:', error);
    } finally {
      setLoading(false);
    }
  };

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();

    try {
      const { data: { user } } = await supabase.auth.getUser();
      if (!user) throw new Error('Not authenticated');

      const activityData: Record<string, unknown> = {
        ...formData,
        created_by: user.id,
        follow_up_date: formData.follow_up_date || null,
        completed_at: formData.is_completed ? new Date().toISOString() : null,
      };

      if (leadId) activityData.lead_id = leadId;
      if (customerId) activityData.customer_id = customerId;

      const { error } = await supabase
        .from('crm_activities')
        .insert([activityData]);

      if (error) throw error;

      setShowForm(false);
      setFormData({
        activity_type: 'phone_call',
        subject: '',
        description: '',
        follow_up_date: '',
        is_completed: false,
      });

      showToast('Activity logged successfully');
      loadActivities();
      onActivityLogged?.();
    } catch (error) {
      console.error('Error logging activity:', error);
      showToast('Failed to log activity. Please try again.', 'error');
    }
  };

  const handleComplete = async (activityId: string) => {
    try {
      const { error } = await supabase
        .from('crm_activities')
        .update({
          is_completed: true,
          completed_at: new Date().toISOString(),
        })
        .eq('id', activityId);

      if (error) throw error;
      showToast('Activity marked as completed');
      loadActivities();
    } catch (error) {
      console.error('Error completing activity:', error);
      showToast('Failed to complete activity. Please try again.', 'error');
    }
  };

  const handleDelete = async (activityId: string) => {
    try {
      const { error } = await supabase
        .from('crm_activities')
        .delete()
        .eq('id', activityId);

      if (error) throw error;
      setConfirmDelete(null);
      showToast('Activity deleted');
      loadActivities();
      onActivityLogged?.();
    } catch (error) {
      console.error('Error deleting activity:', error);
      showToast('Failed to delete activity. Please try again.', 'error');
    }
  };

  const getActivityIcon = (type: string) => {
    switch (type) {
      case 'phone_call': return <Phone className="w-4 h-4" />;
      case 'meeting': return <Calendar className="w-4 h-4" />;
      case 'email': return <MessageSquare className="w-4 h-4" />;
      case 'note': return <FileText className="w-4 h-4" />;
      case 'video_call': return <Video className="w-4 h-4" />;
      case 'whatsapp': return <MessageCircle className="w-4 h-4" />;
      default: return <FileText className="w-4 h-4" />;
    }
  };

  const getActivityColor = (type: string) => {
    switch (type) {
      case 'phone_call': return 'bg-blue-50 text-blue-600 border-blue-200';
      case 'meeting': return 'bg-teal-50 text-teal-600 border-teal-200';
      case 'email': return 'bg-green-50 text-green-600 border-green-200';
      case 'note': return 'bg-gray-50 text-gray-600 border-gray-200';
      case 'video_call': return 'bg-sky-50 text-sky-600 border-sky-200';
      case 'whatsapp': return 'bg-emerald-50 text-emerald-600 border-emerald-200';
      default: return 'bg-gray-50 text-gray-600 border-gray-200';
    }
  };

  const formatActivityType = (type: string) => {
    const types: Record<string, string> = {
      phone_call: 'Phone Call',
      meeting: 'Meeting',
      email: 'Email',
      note: 'Note',
      video_call: 'Video Call',
      whatsapp: 'WhatsApp',
    };
    return types[type] || type;
  };

  const visibleActivities = activities.slice(0, visibleCount);
  const completedActivities = activities.filter((activity) => activity.is_completed).length;
  const pendingActivities = activities.length - completedActivities;
  const followUpActivities = activities.filter((activity) => activity.follow_up_date && !activity.is_completed).length;

  if (loading) {
    return <div className="flex justify-center py-8 text-gray-500 text-sm">Loading...</div>;
  }

  return (
    <div className="space-y-3">
      {toast && (
        <div className={`fixed top-4 right-4 z-50 px-4 py-3 rounded-lg shadow-lg text-sm text-white transition-all ${
          toast.type === 'error' ? 'bg-red-600' : 'bg-green-600'
        }`}>
          {toast.msg}
        </div>
      )}

      {confirmDelete && (
        <div className="fixed inset-0 bg-black bg-opacity-40 z-50 flex items-center justify-center p-4">
          <div className="bg-white rounded-xl shadow-xl p-6 max-w-sm w-full">
            <h3 className="text-base font-semibold text-gray-900 mb-2">Delete Activity</h3>
            <p className="text-sm text-gray-600 mb-4">Are you sure you want to delete this activity? This cannot be undone.</p>
            <div className="flex gap-3 justify-end">
              <button
                onClick={() => setConfirmDelete(null)}
                className="px-4 py-2 text-sm border border-gray-300 rounded-lg hover:bg-gray-50"
              >
                Cancel
              </button>
              <button
                onClick={() => handleDelete(confirmDelete)}
                className="px-4 py-2 text-sm bg-red-600 text-white rounded-lg hover:bg-red-700"
              >
                Delete
              </button>
            </div>
          </div>
        </div>
      )}

      <div className="flex items-center justify-between">
        <h3 className="text-base font-semibold text-gray-900">Activity Log</h3>
        <button
          onClick={() => setShowForm(!showForm)}
          className="flex items-center gap-1.5 px-3 py-1.5 bg-blue-600 text-white rounded-lg hover:bg-blue-700 transition text-sm"
        >
          <Plus className="w-3.5 h-3.5" />
          Log Activity
        </button>
      </div>

      {showForm && (
        <div className="bg-gray-50 rounded-lg p-4 border border-gray-200">
          <form onSubmit={handleSubmit} className="space-y-3">
            <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
              <div>
                <label className="block text-xs font-medium text-gray-700 mb-1">Activity Type *</label>
                <select
                  value={formData.activity_type}
                  onChange={(e) => setFormData({ ...formData, activity_type: e.target.value })}
                  className="w-full px-3 py-2 text-sm border border-gray-300 rounded-lg focus:ring-2 focus:ring-blue-500"
                  required
                >
                  <option value="phone_call">Phone Call</option>
                  <option value="meeting">Meeting</option>
                  <option value="email">Email</option>
                  <option value="note">Note</option>
                  <option value="video_call">Video Call</option>
                  <option value="whatsapp">WhatsApp</option>
                </select>
              </div>

              <div>
                <label className="block text-xs font-medium text-gray-700 mb-1">Subject *</label>
                <input
                  type="text"
                  value={formData.subject}
                  onChange={(e) => setFormData({ ...formData, subject: e.target.value })}
                  className="w-full px-3 py-2 text-sm border border-gray-300 rounded-lg focus:ring-2 focus:ring-blue-500"
                  placeholder="Brief description"
                  required
                />
              </div>

              <div className="md:col-span-2">
                <label className="block text-xs font-medium text-gray-700 mb-1">Description</label>
                <textarea
                  value={formData.description}
                  onChange={(e) => setFormData({ ...formData, description: e.target.value })}
                  className="w-full px-3 py-2 text-sm border border-gray-300 rounded-lg focus:ring-2 focus:ring-blue-500"
                  rows={2}
                  placeholder="Notes about the conversation or activity"
                />
              </div>

              <div>
                <label className="block text-xs font-medium text-gray-700 mb-1">Follow-up Date</label>
                <input
                  type="datetime-local"
                  value={formData.follow_up_date}
                  onChange={(e) => setFormData({ ...formData, follow_up_date: e.target.value })}
                  className="w-full px-3 py-2 text-sm border border-gray-300 rounded-lg focus:ring-2 focus:ring-blue-500"
                />
              </div>

              <div className="flex items-center">
                <label className="flex items-center gap-2 cursor-pointer">
                  <input
                    type="checkbox"
                    checked={formData.is_completed}
                    onChange={(e) => setFormData({ ...formData, is_completed: e.target.checked })}
                    className="w-4 h-4 text-blue-600 border-gray-300 rounded focus:ring-2 focus:ring-blue-500"
                  />
                  <span className="text-sm text-gray-700">Mark as completed</span>
                </label>
              </div>
            </div>

            <div className="flex justify-end gap-2 pt-2 border-t">
              <button
                type="button"
                onClick={() => setShowForm(false)}
                className="px-3 py-1.5 text-sm border border-gray-300 rounded-lg hover:bg-gray-50 transition"
              >
                Cancel
              </button>
              <button
                type="submit"
                className="px-3 py-1.5 text-sm bg-blue-600 text-white rounded-lg hover:bg-blue-700 transition"
              >
                Save Activity
              </button>
            </div>
          </form>
        </div>
      )}

      <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
        <div className="rounded-xl border border-blue-100 bg-gradient-to-br from-blue-50 to-white p-3">
          <p className="text-xs font-medium uppercase tracking-wide text-blue-700">Total</p>
          <p className="mt-1 text-2xl font-semibold text-blue-900">{activities.length}</p>
        </div>
        <div className="rounded-xl border border-emerald-100 bg-gradient-to-br from-emerald-50 to-white p-3">
          <p className="text-xs font-medium uppercase tracking-wide text-emerald-700">Completed</p>
          <p className="mt-1 text-2xl font-semibold text-emerald-900">{completedActivities}</p>
        </div>
        <div className="rounded-xl border border-orange-100 bg-gradient-to-br from-orange-50 to-white p-3">
          <p className="text-xs font-medium uppercase tracking-wide text-orange-700">Need Follow-up</p>
          <p className="mt-1 text-2xl font-semibold text-orange-900">{followUpActivities || pendingActivities}</p>
        </div>
      </div>

      <div className="space-y-2">
        {activities.length === 0 ? (
          <div className="text-center py-8 text-gray-500 text-sm">
            No activities logged yet. Start by logging your first activity!
          </div>
        ) : (
          <>
            {visibleActivities.map((activity) => (
              <div
                key={activity.id}
                className={`border rounded-xl p-3 shadow-sm transition ${
                  activity.is_completed
                    ? 'bg-gray-50 border-gray-200'
                    : 'bg-white border-gray-200 hover:border-blue-200 hover:shadow-md'
                }`}
              >
                <div className="flex items-start gap-3">
                  <div className={`p-1.5 rounded-lg border flex-shrink-0 ${getActivityColor(activity.activity_type)}`}>
                    {getActivityIcon(activity.activity_type)}
                  </div>

                  <div className="flex-1 min-w-0">
                    <div className="flex items-start justify-between gap-2">
                      <div className="min-w-0">
                        <div className="flex items-center gap-2 flex-wrap">
                          <h4 className="font-medium text-sm text-gray-900 truncate">{activity.subject}</h4>
                          {activity.is_completed && (
                            <span className="flex items-center gap-1 text-xs text-green-600 bg-green-50 px-1.5 py-0.5 rounded flex-shrink-0">
                              <CheckCircle className="w-3 h-3" />
                              Done
                            </span>
                          )}
                        </div>
                        <p className="text-xs text-gray-500 mt-0.5">
                          {formatActivityType(activity.activity_type)} &bull; {new Date(activity.created_at).toLocaleString()}
                          {activity.user_profiles && ` \u2022 ${activity.user_profiles.full_name}`}
                        </p>
                      </div>

                      <div className="flex items-center gap-1 flex-shrink-0">
                        {!activity.is_completed && (
                          <button
                            onClick={() => handleComplete(activity.id)}
                            className="text-xs px-2 py-1 text-green-600 hover:bg-green-50 rounded transition"
                            title="Mark complete"
                          >
                            Done
                          </button>
                        )}
                        <button
                          onClick={() => setConfirmDelete(activity.id)}
                          className="p-1 text-red-400 hover:text-red-600 hover:bg-red-50 rounded transition"
                          title="Delete"
                        >
                          <Trash2 className="w-3.5 h-3.5" />
                        </button>
                      </div>
                    </div>

                    {activity.description && (
                      <p className="mt-1.5 text-xs text-gray-600 whitespace-pre-wrap line-clamp-3">
                        {activity.description}
                      </p>
                    )}

                    {activity.follow_up_date && !activity.is_completed && (
                      <div className="mt-1.5 flex items-center gap-1 text-xs text-orange-600">
                        <Clock className="w-3 h-3" />
                        Follow-up: {new Date(activity.follow_up_date).toLocaleString()}
                      </div>
                    )}
                  </div>
                </div>
              </div>
            ))}

            {activities.length > visibleCount && (
              <button
                onClick={() => setVisibleCount(v => v + PAGE_SIZE)}
                className="w-full flex items-center justify-center gap-2 py-2 text-sm text-blue-600 hover:bg-blue-50 rounded-lg border border-blue-200 transition"
              >
                <ChevronDown className="w-4 h-4" />
                Show more ({activities.length - visibleCount} remaining)
              </button>
            )}
          </>
        )}
      </div>
    </div>
  );
}
