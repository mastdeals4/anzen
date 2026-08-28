import { useState, useEffect } from 'react';
import { supabase } from '../../lib/supabase';
import { useAuth } from '../../contexts/AuthContext';
import { Calendar, Clock, Users, Plus, Edit2, Trash2, Video, Phone } from 'lucide-react';
import { SearchableSelect } from '../SearchableSelect';
import { formatDate } from '../../utils/dateFormat';

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
  participants: string[];
  auto_create_followup_task: boolean;
  user_profiles?: {
    full_name: string;
  };
  crm_contacts?: {
    company_name: string;
  };
}

interface UserProfile {
  id: string;
  full_name: string;
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
  useAuth();
  const [appointments, setAppointments] = useState<Appointment[]>([]);
  const [contacts, setContacts] = useState<Contact[]>([]);
  const [users, setUsers] = useState<UserProfile[]>([]);
  const [loading, setLoading] = useState(true);
  const [showForm, setShowForm] = useState(false);
  const [editingAppointment, setEditingAppointment] = useState<Appointment | null>(null);
  const [toast, setToast] = useState<{ msg: string; type: 'success' | 'error' } | null>(null);
  const [confirmDeleteId, setConfirmDeleteId] = useState<string | null>(null);
  const [expandedPastIds, setExpandedPastIds] = useState<Record<string, boolean>>({});
  const [formData, setFormData] = useState({
    activity_type: 'meeting',
    subject: '',
    description: '',
    follow_up_date: '',
    location: '',
    customer_id: customerId || '',
    participants: [] as string[],
    auto_create_followup_task: false,
  });

  useEffect(() => {
    loadAppointments();
    loadUsers();
    if (!customerId && !leadId) {
      loadContacts();
    }
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

  const loadUsers = async () => {
    try {
      const { data, error } = await supabase
        .from('user_profiles')
        .select('id, full_name')
        .order('full_name', { ascending: true });

      if (error) throw error;
      setUsers(data || []);
    } catch (error) {
      console.error('Error loading users:', error);
    }
  };

  const loadAppointments = async () => {
    try {
      let query = supabase
        .from('crm_activities')
        .select('*, user_profiles!crm_activities_created_by_fkey(full_name), crm_contacts!crm_activities_customer_id_fkey(company_name)')
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

      // Convert datetime-local input (which is in user's local time) to ISO string for database
      // The datetime-local gives us "2026-01-12T10:00" which needs to be treated as local time
      // We convert it to a proper ISO string for the database
      let followUpDateISO = formData.follow_up_date;
      if (formData.follow_up_date) {
        // Append seconds if not present, and treat as local time
        if (formData.follow_up_date.length === 16) {
          followUpDateISO = formData.follow_up_date + ':00';
        }
      }

      const appointmentData: any = {
        activity_type: formData.activity_type,
        subject: formData.subject,
        description: formData.description || null,
        follow_up_date: followUpDateISO,
        is_completed: false,
        created_by: user.id,
        participants: formData.participants,
        auto_create_followup_task: formData.auto_create_followup_task,
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
        customer_id: customerId || '',
        participants: [],
        auto_create_followup_task: false,
      });

      showToast(editingAppointment ? 'Appointment updated' : 'Appointment scheduled');
      loadAppointments();
      onAppointmentCreated?.();
    } catch (error) {
      console.error('Error saving appointment:', error);
      showToast('Failed to save appointment. Please try again.', 'error');
    }
  };

  const handleEdit = (appointment: Appointment) => {
    setEditingAppointment(appointment);

    // Convert UTC datetime to local datetime-local format (YYYY-MM-DDTHH:mm)
    // Database stores in UTC, we need to show in local time
    let formattedDate = '';
    if (appointment.follow_up_date) {
      // Remove the 'Z' or timezone info to treat as local time
      // If the database has "2026-01-12 10:00:00", we want to show "2026-01-12T10:00"
      formattedDate = appointment.follow_up_date.substring(0, 16);
    }

    setFormData({
      activity_type: appointment.activity_type,
      subject: appointment.subject,
      description: appointment.description || '',
      follow_up_date: formattedDate,
      location: '',
      customer_id: appointment.customer_id || customerId || '',
      participants: appointment.participants || [],
      auto_create_followup_task: appointment.auto_create_followup_task || false,
    });
    setShowForm(true);
  };

  const handleDelete = async (id: string) => {
    try {
      const { error } = await supabase
        .from('crm_activities')
        .delete()
        .eq('id', id);

      if (error) throw error;
      setConfirmDeleteId(null);
      showToast('Appointment deleted');
      loadAppointments();
    } catch (error) {
      console.error('Error deleting appointment:', error);
      showToast('Failed to delete appointment. Please try again.', 'error');
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
      showToast('Appointment marked as completed');
      loadAppointments();
    } catch (error) {
      console.error('Error completing appointment:', error);
      showToast('Failed to complete appointment. Please try again.', 'error');
    }
  };

  const togglePastDetails = (id: string) => {
    setExpandedPastIds((prev) => ({ ...prev, [id]: !prev[id] }));
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

      {confirmDeleteId && (
        <div className="fixed inset-0 bg-black bg-opacity-40 z-50 flex items-center justify-center p-4">
          <div className="bg-white rounded-xl shadow-xl p-6 max-w-sm w-full">
            <h3 className="text-base font-semibold text-gray-900 mb-2">Delete Appointment</h3>
            <p className="text-sm text-gray-600 mb-4">Are you sure you want to delete this appointment?</p>
            <div className="flex gap-3 justify-end">
              <button
                onClick={() => setConfirmDeleteId(null)}
                className="px-4 py-2 text-sm border border-gray-300 rounded-lg hover:bg-gray-50"
              >
                Cancel
              </button>
              <button
                onClick={() => handleDelete(confirmDeleteId)}
                className="px-4 py-2 text-sm bg-red-600 text-white rounded-lg hover:bg-red-700"
              >
                Delete
              </button>
            </div>
          </div>
        </div>
      )}

      <div className="flex items-center justify-between">
        <h3 className="text-base font-semibold text-gray-900">Appointments & Meetings</h3>
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
              participants: [],
              auto_create_followup_task: false,
            });
            // Reload contacts to get latest customer list
            if (!customerId && !leadId) {
              loadContacts();
            }
            setShowForm(!showForm);
          }}
          className="flex items-center gap-2 px-4 py-2 bg-blue-600 text-white rounded-lg hover:bg-blue-700 transition"
        >
          <Plus className="w-4 h-4" />
          Create Appointment
        </button>
      </div>

      {showForm && (
        <div className="bg-gray-50 rounded-lg p-4 border border-gray-200">
          <form onSubmit={handleSubmit} className="space-y-3">
            <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
              {!customerId && !leadId && (
                <div className="md:col-span-2">
                  <label className="block text-sm font-medium text-gray-700 mb-1">
                    Customer *
                  </label>
                  <SearchableSelect
                    value={formData.customer_id}
                    onChange={(val) => setFormData({ ...formData, customer_id: val })}
                    options={contacts.map(c => ({ value: c.id, label: c.company_name }))}
                    placeholder="Select a customer..."
                  />
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

              <div className="md:col-span-2">
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

              <div className="md:col-span-2">
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

              <div className="md:col-span-2">
                <label className="block text-sm font-medium text-gray-700 mb-1">
                  Participants
                </label>
                <div className="border border-gray-300 rounded-lg p-3 max-h-40 overflow-y-auto">
                  <div className="space-y-2">
                    {users.map(user => (
                      <label key={user.id} className="flex items-center gap-2 cursor-pointer hover:bg-gray-50 p-1 rounded">
                        <input
                          type="checkbox"
                          checked={formData.participants.includes(user.id)}
                          onChange={(e) => {
                            if (e.target.checked) {
                              setFormData({ ...formData, participants: [...formData.participants, user.id] });
                            } else {
                              setFormData({ ...formData, participants: formData.participants.filter(id => id !== user.id) });
                            }
                          }}
                          className="rounded border-gray-300 text-blue-600 focus:ring-blue-500"
                        />
                        <span className="text-sm text-gray-700">{user.full_name}</span>
                      </label>
                    ))}
                  </div>
                </div>
                <p className="text-xs text-gray-500 mt-1">
                  Tagged participants will receive notifications and can see this appointment
                </p>
              </div>

              <div className="md:col-span-2">
                <label className="flex items-center gap-2 cursor-pointer">
                  <input
                    type="checkbox"
                    checked={formData.auto_create_followup_task}
                    onChange={(e) => setFormData({ ...formData, auto_create_followup_task: e.target.checked })}
                    className="rounded border-gray-300 text-blue-600 focus:ring-blue-500"
                  />
                  <span className="text-sm font-medium text-gray-700">
                    Auto-create follow-up task after meeting
                  </span>
                </label>
                <p className="text-xs text-gray-500 ml-6">
                  A task will be created 2 days after the meeting for follow-up
                </p>
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
                            onClick={() => setConfirmDeleteId(appointment.id)}
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

                      {appointment.participants && appointment.participants.length > 0 && (
                        <div className="mt-2 flex items-center gap-2">
                          <Users className="w-4 h-4 text-gray-500" />
                          <div className="flex flex-wrap gap-1">
                            {appointment.participants.map(participantId => {
                              const user = users.find(u => u.id === participantId);
                              return user ? (
                                <span key={participantId} className="text-xs bg-blue-100 text-blue-700 px-2 py-0.5 rounded">
                                  {user.full_name}
                                </span>
                              ) : null;
                            })}
                          </div>
                        </div>
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
                        <div className="flex items-start justify-between gap-2">
                          <div>
                            <h4 className="font-medium text-gray-700">{appointment.subject}</h4>
                            {appointment.crm_contacts && (
                              <p className="text-sm font-medium text-blue-600 mt-1">
                                {appointment.crm_contacts.company_name}
                              </p>
                            )}
                            <p className="text-sm text-gray-500 mt-1">
                              {formatAppointmentType(appointment.activity_type)} • {formatDate(appointment.follow_up_date)}
                            </p>
                            {appointment.is_completed && appointment.completed_at && (
                              <p className="text-xs text-green-700 mt-1">
                                Completed: {new Date(appointment.completed_at).toLocaleString()}
                              </p>
                            )}
                          </div>
                          <button
                            onClick={() => togglePastDetails(appointment.id)}
                            className="text-xs px-2 py-1 border border-gray-300 rounded hover:bg-white transition"
                          >
                            {expandedPastIds[appointment.id] ? 'Hide details' : 'View details'}
                          </button>
                        </div>

                        {expandedPastIds[appointment.id] && (
                          <div className="mt-3 border-t border-gray-200 pt-3 space-y-3">
                            {appointment.description ? (
                              <div>
                                <p className="text-xs uppercase tracking-wide text-gray-500">Transcript / Notes</p>
                                <p className="mt-1 text-sm text-gray-700 whitespace-pre-wrap">{appointment.description}</p>
                              </div>
                            ) : (
                              <p className="text-sm text-gray-500">No notes logged for this appointment yet.</p>
                            )}

                            {appointment.participants && appointment.participants.length > 0 && (
                              <div>
                                <p className="text-xs uppercase tracking-wide text-gray-500 mb-1">Participants</p>
                                <div className="flex flex-wrap gap-1">
                                  {appointment.participants.map(participantId => {
                                    const user = users.find(u => u.id === participantId);
                                    return user ? (
                                      <span key={participantId} className="text-xs bg-blue-100 text-blue-700 px-2 py-0.5 rounded">
                                        {user.full_name}
                                      </span>
                                    ) : null;
                                  })}
                                </div>
                              </div>
                            )}

                            <div className="flex flex-wrap gap-2">
                              <button
                                onClick={() => handleEdit(appointment)}
                                className="text-xs px-3 py-1 bg-white border border-gray-300 rounded hover:bg-gray-100 transition"
                              >
                                Add / Edit Notes
                              </button>
                              <button
                                onClick={() => {
                                  setEditingAppointment(null);
                                  setFormData({
                                    activity_type: appointment.activity_type,
                                    subject: `Follow-up: ${appointment.subject}`,
                                    description: '',
                                    follow_up_date: '',
                                    location: '',
                                    customer_id: appointment.customer_id || customerId || '',
                                    participants: appointment.participants || [],
                                    auto_create_followup_task: true,
                                  });
                                  setShowForm(true);
                                }}
                                className="text-xs px-3 py-1 bg-blue-600 text-white rounded hover:bg-blue-700 transition"
                              >
                                Create Follow-up Call
                              </button>
                            </div>
                          </div>
                        )}
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
