import { useState, useEffect } from 'react';
import { supabase } from '../../lib/supabase';
import { useAuth } from '../../contexts/AuthContext';
import { Phone, Calendar, MessageSquare, FileText, Video, MessageCircle, Plus, CheckCircle, Clock, Trash2 } from 'lucide-react';
import { useLanguage } from '../../contexts/LanguageContext';

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

export function ActivityLogger({ inquiryId, customerId, leadId, onActivityLogged }: ActivityLoggerProps) {
  const { profile } = useAuth();
  const { t } = useLanguage();
  const [activities, setActivities] = useState<Activity[]>([]);
  const [loading, setLoading] = useState(true);
  const [showForm, setShowForm] = useState(false);
  const [formData, setFormData] = useState({
    activity_type: 'phone_call',
    subject: '',
    description: '',
    follow_up_date: '',
    is_completed: false,
  });

  useEffect(() => {
    loadActivities();
  }, [inquiryId, customerId, leadId]);

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

      const activityData: any = {
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

      loadActivities();
      onActivityLogged?.();
    } catch (error) {
      console.error('Error logging activity:', error);
      alert('Failed to log activity. Please try again.');
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
      loadActivities();
    } catch (error) {
      console.error('Error completing activity:', error);
      alert('Failed to complete activity. Please try again.');
    }
  };

  const handleDelete = async (activityId: string) => {
    if (!confirm('Are you sure you want to delete this activity? This action cannot be undone.')) {
      return;
    }

    try {
      const { error } = await supabase
        .from('crm_activities')
        .delete()
        .eq('id', activityId);

      if (error) throw error;
      loadActivities();
      onActivityLogged?.();
    } catch (error) {
      console.error('Error deleting activity:', error);
      alert('Failed to delete activity. Please try again.');
    }
  };

  const getActivityIcon = (type: string) => {
    switch (type) {
      case 'phone_call':
        return <Phone className="w-5 h-5" />;
      case 'meeting':
        return <Calendar className="w-5 h-5" />;
      case 'email':
        return <MessageSquare className="w-5 h-5" />;
      case 'note':
        return <FileText className="w-5 h-5" />;
      case 'video_call':
        return <Video className="w-5 h-5" />;
      case 'whatsapp':
        return <MessageCircle className="w-5 h-5" />;
      default:
        return <FileText className="w-5 h-5" />;
    }
  };

  const getActivityColor = (type: string) => {
    switch (type) {
      case 'phone_call':
        return 'bg-blue-50 text-blue-600 border-blue-200';
      case 'meeting':
        return 'bg-purple-50 text-purple-600 border-purple-200';
      case 'email':
        return 'bg-green-50 text-green-600 border-green-200';
      case 'note':
        return 'bg-gray-50 text-gray-600 border-gray-200';
      case 'video_call':
        return 'bg-indigo-50 text-indigo-600 border-indigo-200';
      case 'whatsapp':
        return 'bg-emerald-50 text-emerald-600 border-emerald-200';
      default:
        return 'bg-gray-50 text-gray-600 border-gray-200';
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

  if (loading) {
    return <div className="flex justify-center py-8">Loading activities...</div>;
  }

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between">
        <h3 className="text-lg font-semibold text-gray-900">Activity Log</h3>
        <button
          onClick={() => setShowForm(!showForm)}
          className="flex items-center gap-2 px-4 py-2 bg-blue-600 text-white rounded-lg hover:bg-blue-700 transition"
        >
          <Plus className="w-4 h-4" />
          Log Activity
        </button>
      </div>

      {showForm && (
        <div className="bg-gray-50 rounded-lg p-6 border border-gray-200">
          <form onSubmit={handleSubmit} className="space-y-4">
            <div className="grid grid-cols-2 gap-4">
              <div>
                <label className="block text-sm font-medium text-gray-700 mb-1">
                  Activity Type *
                </label>
                <select
                  value={formData.activity_type}
                  onChange={(e) => setFormData({ ...formData, activity_type: e.target.value })}
                  className="w-full px-3 py-2 border border-gray-300 rounded-lg focus:ring-2 focus:ring-blue-500"
                  required
                >
                  <option value="phone_call">Phone Call</option>
                  <option value="meeting">Meeting</option>
                  <option value="email">Email</option>
                  <option value="note">Note</option>
                  <option value="video_call">Video Call</option>
                  <option value="whatsapp">WhatsApp (Coming Soon)</option>
                </select>
              </div>

              <div>
                <label className="block text-sm font-medium text-gray-700 mb-1">
                  Subject *
                </label>
                <input
                  type="text"
                  value={formData.subject}
                  onChange={(e) => setFormData({ ...formData, subject: e.target.value })}
                  className="w-full px-3 py-2 border border-gray-300 rounded-lg focus:ring-2 focus:ring-blue-500"
                  placeholder="Brief description"
                  required
                />
              </div>

              <div className="col-span-2">
                <label className="block text-sm font-medium text-gray-700 mb-1">
                  Description
                </label>
                <textarea
                  value={formData.description}
                  onChange={(e) => setFormData({ ...formData, description: e.target.value })}
                  className="w-full px-3 py-2 border border-gray-300 rounded-lg focus:ring-2 focus:ring-blue-500"
                  rows={3}
                  placeholder="Detailed notes about the conversation or activity"
                />
              </div>

              <div>
                <label className="block text-sm font-medium text-gray-700 mb-1">
                  Follow-up Date
                </label>
                <input
                  type="datetime-local"
                  value={formData.follow_up_date}
                  onChange={(e) => setFormData({ ...formData, follow_up_date: e.target.value })}
                  className="w-full px-3 py-2 border border-gray-300 rounded-lg focus:ring-2 focus:ring-blue-500"
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

            <div className="flex justify-end gap-3 pt-4 border-t">
              <button
                type="button"
                onClick={() => setShowForm(false)}
                className="px-4 py-2 border border-gray-300 rounded-lg hover:bg-gray-50 transition"
              >
                Cancel
              </button>
              <button
                type="submit"
                className="px-4 py-2 bg-blue-600 text-white rounded-lg hover:bg-blue-700 transition"
              >
                Log Activity
              </button>
            </div>
          </form>
        </div>
      )}

      <div className="space-y-3">
        {activities.length === 0 ? (
          <div className="text-center py-8 text-gray-500">
            No activities logged yet. Start by logging your first activity!
          </div>
        ) : (
          activities.map((activity) => (
            <div
              key={activity.id}
              className={`border rounded-lg p-4 ${
                activity.is_completed ? 'bg-gray-50 border-gray-200' : 'bg-white border-gray-300'
              }`}
            >
              <div className="flex items-start gap-3">
                <div className={`p-2 rounded-lg border ${getActivityColor(activity.activity_type)}`}>
                  {getActivityIcon(activity.activity_type)}
                </div>

                <div className="flex-1 min-w-0">
                  <div className="flex items-start justify-between gap-2">
                    <div>
                      <div className="flex items-center gap-2">
                        <h4 className="font-medium text-gray-900">{activity.subject}</h4>
                        {activity.is_completed && (
                          <span className="flex items-center gap-1 text-xs text-green-600 bg-green-50 px-2 py-0.5 rounded">
                            <CheckCircle className="w-3 h-3" />
                            Completed
                          </span>
                        )}
                      </div>
                      <p className="text-sm text-gray-600">
                        {formatActivityType(activity.activity_type)} • {new Date(activity.created_at).toLocaleString()}
                      </p>
                    </div>

                    <div className="flex items-center gap-2">
                      {!activity.is_completed && activity.follow_up_date && (
                        <button
                          onClick={() => handleComplete(activity.id)}
                          className="text-sm px-3 py-1 text-green-600 hover:bg-green-50 rounded-lg transition"
                        >
                          Mark Complete
                        </button>
                      )}
                      <button
                        onClick={() => handleDelete(activity.id)}
                        className="p-1 text-red-600 hover:bg-red-50 rounded transition"
                        title="Delete activity"
                      >
                        <Trash2 className="w-4 h-4" />
                      </button>
                    </div>
                  </div>

                  {activity.description && (
                    <p className="mt-2 text-sm text-gray-700 whitespace-pre-wrap">
                      {activity.description}
                    </p>
                  )}

                  {activity.follow_up_date && !activity.is_completed && (
                    <div className="mt-2 flex items-center gap-2 text-sm text-orange-600">
                      <Clock className="w-4 h-4" />
                      Follow-up: {new Date(activity.follow_up_date).toLocaleString()}
                    </div>
                  )}

                  {activity.user_profiles && (
                    <p className="mt-2 text-xs text-gray-500">
                      by {activity.user_profiles.full_name}
                    </p>
                  )}
                </div>
              </div>
            </div>
          ))
        )}
      </div>
    </div>
  );
}
