import { useState, useEffect } from 'react';
import { supabase } from '../../lib/supabase';
import { useAuth } from '../../contexts/AuthContext';
import { Calendar, Clock, MapPin, Users, Plus, Edit2, Trash2, Video, Phone } from 'lucide-react';

interface Appointment {
  id: string;
  activity_type: string;
  subject: string;
  description: string | null;
  follow_up_date: string;
  is_completed: boolean;
  completed_at: string | null;
  created_at: string;
  lead_id: string | null;
  customer_id: string | null;
  user_profiles?: {
    full_name: string;
  };
  crm_contacts?: {
    company_name: string;
  };
}

interface Contact {
  id: string;
  company_name: string;
}

interface AppointmentSchedulerProps {
  customerId?: string;
  leadId?: string;
  onAppointmentCreated?: () => void;
}

export function AppointmentScheduler({ customerId, leadId, onAppointmentCreated }: AppointmentSchedulerProps) {
  const { profile } = useAuth();
  const [appointments, setAppointments] = useState<Appointment[]>([]);
  const [contacts, setContacts] = useState<Contact[]>([]);
  const [loading, setLoading] = useState(true);
  const [showForm, setShowForm] = useState(false);
  const [editingAppointment, setEditingAppointment] = useState<Appointment | null>(null);
  const [formData, setFormData] = useState({
    activity_type: 'meeting',
    subject: '',
    description: '',
    follow_up_date: '',
    location: '',
    customer_id: customerId || '',
  });

  useEffect(() => {
    loadAppointments();
    if (!customerId && !leadId) {
      loadContacts();
    }
  }, [customerId, leadId]);

  const loadContacts = async () => {
    try {
      const { data, error } = await supabase
        .from('crm_contacts')
        .select('id, company_name')
        .order('company_name', { ascending: true });

      if (error) throw error;
      setContacts(data || []);
    } catch (error) {
      console.error('Error loading contacts:', error);
    }
  };

  const loadAppointments = async () => {
    try {
      let query = supabase
        .from('crm_activities')
        .select('*, user_profiles!crm_activities_created_by_fkey(full_name), crm_contacts(company_name)')
        .in('activity_type', ['meeting', 'video_call', 'phone_call'])
        .not('follow_up_date', 'is', null)
        .order('follow_up_date', { ascending: true });

      if (customerId) {
        query = query.eq('customer_id', customerId);
      } else if (leadId) {
        query = query.eq('lead_id', leadId);
      }

      const { data, error } = await query;
      if (error) throw error;

      setAppointments(data || []);
    } catch (error) {
      console.error('Error loading appointments:', error);
    } finally {
      setLoading(false);
    }
  };

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();

    try {
      const { data: { user } } = await supabase.auth.getUser();
      if (!user) throw new Error('Not authenticated');

      const appointmentData: any = {
        activity_type: formData.activity_type,
        subject: formData.subject,
        description: formData.description || null,
        follow_up_date: formData.follow_up_date,
        is_completed: false,
        created_by: user.id,
      };

      if (customerId) {
        appointmentData.customer_id = customerId;
      } else if (leadId) {
        appointmentData.lead_id = leadId;
      } else if (formData.customer_id) {
        appointmentData.customer_id = formData.customer_id;
      }

      if (editingAppointment) {
        const { error } = await supabase
          .from('crm_activities')
          .update(appointmentData)
          .eq('id', editingAppointment.id);

        if (error) throw error;
      } else {
        const { error } = await supabase
          .from('crm_activities')
          .insert([appointmentData]);

        if (error) throw error;
      }

      setShowForm(false);
      setEditingAppointment(null);
      setFormData({
        activity_type: 'meeting',
        subject: '',
        description: '',
        follow_up_date: '',
        location: '',
      });

      loadAppointments();
      onAppointmentCreated?.();
    } catch (error) {
      console.error('Error saving appointment:', error);
      alert('Failed to save appointment. Please try again.');
    }
  };

  const handleEdit = (appointment: Appointment) => {
    setEditingAppointment(appointment);
    setFormData({
      activity_type: appointment.activity_type,
      subject: appointment.subject,
      description: appointment.description || '',
      follow_up_date: appointment.follow_up_date,
      location: '',
      customer_id: appointment.customer_id || customerId || '',
    });
    setShowForm(true);
  };

  const handleDelete = async (id: string) => {
    if (!confirm('Are you sure you want to delete this appointment?')) return;

    try {
      const { error } = await supabase
        .from('crm_activities')
        .delete()
        .eq('id', id);

      if (error) throw error;
      loadAppointments();
    } catch (error) {
      console.error('Error deleting appointment:', error);
      alert('Failed to delete appointment. Please try again.');
    }
  };

  const handleComplete = async (id: string) => {
    try {
      const { error } = await supabase
        .from('crm_activities')
        .update({
          is_completed: true,
          completed_at: new Date().toISOString(),
        })
        .eq('id', id);

      if (error) throw error;
      loadAppointments();
    } catch (error) {
      console.error('Error completing appointment:', error);
      alert('Failed to complete appointment. Please try again.');
    }
  };

  const getAppointmentIcon = (type: string) => {
    switch (type) {
      case 'meeting':
        return <Calendar className="w-5 h-5" />;
      case 'video_call':
        return <Video className="w-5 h-5" />;
      case 'phone_call':
        return <Phone className="w-5 h-5" />;
      default:
        return <Calendar className="w-5 h-5" />;
    }
  };

  const getAppointmentColor = (appointment: Appointment) => {
    if (appointment.is_completed) {
      return 'bg-gray-50 border-gray-200 text-gray-600';
    }

    const now = new Date();
    const appointmentDate = new Date(appointment.follow_up_date);

    if (appointmentDate < now) {
      return 'bg-red-50 border-red-200 text-red-700';
    } else if (appointmentDate < new Date(now.getTime() + 24 * 60 * 60 * 1000)) {
      return 'bg-orange-50 border-orange-200 text-orange-700';
    }
    return 'bg-blue-50 border-blue-200 text-blue-700';
  };

  const formatAppointmentType = (type: string) => {
    const types: Record<string, string> = {
      meeting: 'In-Person Meeting',
      video_call: 'Video Call',
      phone_call: 'Phone Call',
    };
    return types[type] || type;
  };

  if (loading) {
    return <div className="flex justify-center py-8">Loading appointments...</div>;
  }

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between">
        <h3 className="text-lg font-semibold text-gray-900">Appointments & Meetings</h3>
        <button
          onClick={() => {
            setEditingAppointment(null);
            setFormData({
              activity_type: 'meeting',
              subject: '',
              description: '',
              follow_up_date: '',
              location: '',
              customer_id: customerId || '',
            });
            setShowForm(!showForm);
          }}
          className="flex items-center gap-2 px-4 py-2 bg-blue-600 text-white rounded-lg hover:bg-blue-700 transition"
        >
          <Plus className="w-4 h-4" />
          Schedule Appointment
        </button>
      </div>

      {showForm && (
        <div className="bg-gray-50 rounded-lg p-6 border border-gray-200">
          <form onSubmit={handleSubmit} className="space-y-4">
            <div className="grid grid-cols-2 gap-4">
              {!customerId && !leadId && (
                <div className="col-span-2">
                  <label className="block text-sm font-medium text-gray-700 mb-1">
                    Customer *
                  </label>
                  <select
                    value={formData.customer_id}
                    onChange={(e) => setFormData({ ...formData, customer_id: e.target.value })}
                    className="w-full px-3 py-2 border border-gray-300 rounded-lg focus:ring-2 focus:ring-blue-500"
                    required
                  >
                    <option value="">Select a customer...</option>
                    {contacts.map(contact => (
                      <option key={contact.id} value={contact.id}>{contact.company_name}</option>
                    ))}
                  </select>
                </div>
              )}

              <div>
                <label className="block text-sm font-medium text-gray-700 mb-1">
                  Appointment Type *
                </label>
                <select
                  value={formData.activity_type}
                  onChange={(e) => setFormData({ ...formData, activity_type: e.target.value })}
                  className="w-full px-3 py-2 border border-gray-300 rounded-lg focus:ring-2 focus:ring-blue-500"
                  required
                >
                  <option value="meeting">In-Person Meeting</option>
                  <option value="video_call">Video Call</option>
                  <option value="phone_call">Phone Call</option>
                </select>
              </div>

              <div>
                <label className="block text-sm font-medium text-gray-700 mb-1">
                  Date & Time *
                </label>
                <input
                  type="datetime-local"
                  value={formData.follow_up_date}
                  onChange={(e) => setFormData({ ...formData, follow_up_date: e.target.value })}
                  className="w-full px-3 py-2 border border-gray-300 rounded-lg focus:ring-2 focus:ring-blue-500"
                  required
                />
              </div>

              <div className="col-span-2">
                <label className="block text-sm font-medium text-gray-700 mb-1">
                  Subject *
                </label>
                <input
                  type="text"
                  value={formData.subject}
                  onChange={(e) => setFormData({ ...formData, subject: e.target.value })}
                  className="w-full px-3 py-2 border border-gray-300 rounded-lg focus:ring-2 focus:ring-blue-500"
                  placeholder="e.g., Product demonstration, Price negotiation"
                  required
                />
              </div>

              <div className="col-span-2">
                <label className="block text-sm font-medium text-gray-700 mb-1">
                  Description / Agenda
                </label>
                <textarea
                  value={formData.description}
                  onChange={(e) => setFormData({ ...formData, description: e.target.value })}
                  className="w-full px-3 py-2 border border-gray-300 rounded-lg focus:ring-2 focus:ring-blue-500"
                  rows={3}
                  placeholder="Meeting agenda, discussion points, etc."
                />
              </div>
            </div>

            <div className="flex justify-end gap-3 pt-4 border-t">
              <button
                type="button"
                onClick={() => {
                  setShowForm(false);
                  setEditingAppointment(null);
                }}
                className="px-4 py-2 border border-gray-300 rounded-lg hover:bg-gray-50 transition"
              >
                Cancel
              </button>
              <button
                type="submit"
                className="px-4 py-2 bg-blue-600 text-white rounded-lg hover:bg-blue-700 transition"
              >
                {editingAppointment ? 'Update Appointment' : 'Schedule Appointment'}
              </button>
            </div>
          </form>
        </div>
      )}

      <div className="space-y-3">
        {appointments.length === 0 ? (
          <div className="text-center py-8 text-gray-500">
            No appointments scheduled. Create your first appointment!
          </div>
        ) : (
          <>
            <div className="space-y-2">
              <h4 className="text-sm font-semibold text-gray-700">Upcoming Appointments</h4>
              {appointments.filter(a => !a.is_completed && new Date(a.follow_up_date) >= new Date()).map((appointment) => (
                <div
                  key={appointment.id}
                  className={`border rounded-lg p-4 ${getAppointmentColor(appointment)}`}
                >
                  <div className="flex items-start gap-3">
                    <div className="flex-shrink-0">
                      {getAppointmentIcon(appointment.activity_type)}
                    </div>

                    <div className="flex-1 min-w-0">
                      <div className="flex items-start justify-between gap-2">
                        <div>
                          <h4 className="font-medium text-gray-900">{appointment.subject}</h4>
                          {appointment.crm_contacts && (
                            <p className="text-sm font-medium text-blue-600 mt-1">
                              {appointment.crm_contacts.company_name}
                            </p>
                          )}
                          <p className="text-sm text-gray-600 mt-1">
                            {formatAppointmentType(appointment.activity_type)}
                          </p>
                          <p className="text-sm font-medium mt-1 flex items-center gap-1">
                            <Clock className="w-4 h-4" />
                            {new Date(appointment.follow_up_date).toLocaleString('en-US', {
                              weekday: 'short',
                              month: 'short',
                              day: 'numeric',
                              year: 'numeric',
                              hour: '2-digit',
                              minute: '2-digit',
                            })}
                          </p>
                        </div>

                        <div className="flex items-center gap-2">
                          <button
                            onClick={() => handleEdit(appointment)}
                            className="p-1 hover:bg-white rounded transition"
                            title="Edit"
                          >
                            <Edit2 className="w-4 h-4" />
                          </button>
                          <button
                            onClick={() => handleDelete(appointment.id)}
                            className="p-1 hover:bg-white rounded transition"
                            title="Delete"
                          >
                            <Trash2 className="w-4 h-4" />
                          </button>
                        </div>
                      </div>

                      {appointment.description && (
                        <p className="mt-2 text-sm text-gray-700 whitespace-pre-wrap">
                          {appointment.description}
                        </p>
                      )}

                      <div className="mt-3 flex gap-2">
                        <button
                          onClick={() => handleComplete(appointment.id)}
                          className="text-xs px-3 py-1 bg-white border border-current rounded hover:bg-gray-50 transition"
                        >
                          Mark as Completed
                        </button>
                      </div>
                    </div>
                  </div>
                </div>
              ))}
            </div>

            {appointments.filter(a => a.is_completed || new Date(a.follow_up_date) < new Date()).length > 0 && (
              <div className="space-y-2 pt-4 border-t">
                <h4 className="text-sm font-semibold text-gray-700">Past Appointments</h4>
                {appointments.filter(a => a.is_completed || new Date(a.follow_up_date) < new Date()).map((appointment) => (
                  <div
                    key={appointment.id}
                    className="border rounded-lg p-4 bg-gray-50 border-gray-200"
                  >
                    <div className="flex items-start gap-3">
                      <div className="flex-shrink-0 text-gray-400">
                        {getAppointmentIcon(appointment.activity_type)}
                      </div>

                      <div className="flex-1 min-w-0">
                        <h4 className="font-medium text-gray-700">{appointment.subject}</h4>
                        <p className="text-sm text-gray-500 mt-1">
                          {formatAppointmentType(appointment.activity_type)} • {new Date(appointment.follow_up_date).toLocaleDateString()}
                        </p>
                      </div>
                    </div>
                  </div>
                ))}
              </div>
            )}
          </>
        )}
      </div>
    </div>
  );
}
