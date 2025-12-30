import { useState, useEffect } from 'react';
import { supabase } from '../../lib/supabase';
import { Phone, Mail, Calendar, FileText, Video, MessageCircle, Clock, CheckCircle, AlertCircle } from 'lucide-react';

interface TimelineEvent {
  id: string;
  type: 'activity' | 'inquiry' | 'email' | 'reminder';
  activity_type?: string;
  subject: string;
  description?: string;
  status?: string;
  is_completed?: boolean;
  created_at: string;
  follow_up_date?: string;
  user_name?: string;
}

interface CustomerInteractionTimelineProps {
  customerId?: string;
  companyName?: string;
}

export function CustomerInteractionTimeline({ customerId, companyName }: CustomerInteractionTimelineProps) {
  const [events, setEvents] = useState<TimelineEvent[]>([]);
  const [loading, setLoading] = useState(true);
  const [filter, setFilter] = useState<'all' | 'activities' | 'inquiries' | 'reminders'>('all');

  useEffect(() => {
    if (customerId || companyName) {
      loadTimeline();
    }
  }, [customerId, companyName, filter]);

  const loadTimeline = async () => {
    try {
      const allEvents: TimelineEvent[] = [];

      if (filter === 'all' || filter === 'activities') {
        let query = supabase
          .from('crm_activities')
          .select('*, user_profiles!crm_activities_created_by_fkey(full_name)')
          .order('created_at', { ascending: false });

        if (customerId) {
          query = query.eq('customer_id', customerId);
        }

        const { data: activities } = await query;
        if (activities) {
          allEvents.push(...activities.map(a => ({
            id: a.id,
            type: 'activity' as const,
            activity_type: a.activity_type,
            subject: a.subject,
            description: a.description,
            is_completed: a.is_completed,
            follow_up_date: a.follow_up_date,
            created_at: a.created_at,
            user_name: a.user_profiles?.full_name,
          })));
        }
      }

      if ((filter === 'all' || filter === 'inquiries') && companyName) {
        const { data: inquiries } = await supabase
          .from('crm_inquiries')
          .select('*, user_profiles!crm_inquiries_assigned_to_fkey(full_name)')
          .eq('company_name', companyName)
          .order('created_at', { ascending: false });

        if (inquiries) {
          allEvents.push(...inquiries.map(i => ({
            id: i.id,
            type: 'inquiry' as const,
            subject: `Inquiry: ${i.product_name}`,
            description: `Quantity: ${i.quantity} - Status: ${i.status}`,
            status: i.status,
            created_at: i.created_at,
            user_name: i.user_profiles?.full_name,
          })));
        }
      }

      if ((filter === 'all' || filter === 'reminders') && companyName) {
        const { data: reminders } = await supabase
          .from('crm_reminders')
          .select('*, user_profiles!crm_reminders_user_id_fkey(full_name), crm_inquiries!inner(company_name)')
          .eq('crm_inquiries.company_name', companyName)
          .order('reminder_date', { ascending: false });

        if (reminders) {
          allEvents.push(...reminders.map(r => ({
            id: r.id,
            type: 'reminder' as const,
            subject: r.reminder_type,
            description: r.notes,
            is_completed: r.is_completed,
            created_at: r.reminder_date,
            user_name: r.user_profiles?.full_name,
          })));
        }
      }

      allEvents.sort((a, b) => new Date(b.created_at).getTime() - new Date(a.created_at).getTime());
      setEvents(allEvents);
    } catch (error) {
      console.error('Error loading timeline:', error);
    } finally {
      setLoading(false);
    }
  };

  const getEventIcon = (event: TimelineEvent) => {
    if (event.type === 'activity') {
      switch (event.activity_type) {
        case 'phone_call':
          return <Phone className="w-4 h-4" />;
        case 'meeting':
          return <Calendar className="w-4 h-4" />;
        case 'email':
          return <Mail className="w-4 h-4" />;
        case 'video_call':
          return <Video className="w-4 h-4" />;
        case 'whatsapp':
          return <MessageCircle className="w-4 h-4" />;
        default:
          return <FileText className="w-4 h-4" />;
      }
    } else if (event.type === 'reminder') {
      return <Clock className="w-4 h-4" />;
    }
    return <FileText className="w-4 h-4" />;
  };

  const getEventColor = (event: TimelineEvent) => {
    if (event.type === 'activity') {
      if (event.is_completed) return 'bg-green-100 border-green-300 text-green-700';
      return 'bg-blue-100 border-blue-300 text-blue-700';
    } else if (event.type === 'inquiry') {
      if (event.status === 'won') return 'bg-green-100 border-green-300 text-green-700';
      if (event.status === 'lost') return 'bg-red-100 border-red-300 text-red-700';
      return 'bg-purple-100 border-purple-300 text-purple-700';
    } else if (event.type === 'reminder') {
      if (event.is_completed) return 'bg-gray-100 border-gray-300 text-gray-700';
      return 'bg-orange-100 border-orange-300 text-orange-700';
    }
    return 'bg-gray-100 border-gray-300 text-gray-700';
  };

  if (loading) {
    return <div className="flex justify-center py-8">Loading timeline...</div>;
  }

  return (
    <div className="space-y-4">
      <div className="flex items-center gap-2">
        <button
          onClick={() => setFilter('all')}
          className={`px-4 py-2 rounded-lg text-sm font-medium transition ${
            filter === 'all'
              ? 'bg-blue-600 text-white'
              : 'bg-gray-100 text-gray-700 hover:bg-gray-200'
          }`}
        >
          All
        </button>
        <button
          onClick={() => setFilter('activities')}
          className={`px-4 py-2 rounded-lg text-sm font-medium transition ${
            filter === 'activities'
              ? 'bg-blue-600 text-white'
              : 'bg-gray-100 text-gray-700 hover:bg-gray-200'
          }`}
        >
          Activities
        </button>
        <button
          onClick={() => setFilter('inquiries')}
          className={`px-4 py-2 rounded-lg text-sm font-medium transition ${
            filter === 'inquiries'
              ? 'bg-blue-600 text-white'
              : 'bg-gray-100 text-gray-700 hover:bg-gray-200'
          }`}
        >
          Inquiries
        </button>
        <button
          onClick={() => setFilter('reminders')}
          className={`px-4 py-2 rounded-lg text-sm font-medium transition ${
            filter === 'reminders'
              ? 'bg-blue-600 text-white'
              : 'bg-gray-100 text-gray-700 hover:bg-gray-200'
          }`}
        >
          Reminders
        </button>
      </div>

      {events.length === 0 ? (
        <div className="text-center py-8 text-gray-500">
          No interactions found for this customer
        </div>
      ) : (
        <div className="relative">
          <div className="absolute left-6 top-0 bottom-0 w-0.5 bg-gray-200" />

          <div className="space-y-4">
            {events.map((event, index) => (
              <div key={event.id} className="relative flex gap-4">
                <div className={`relative z-10 flex items-center justify-center w-12 h-12 rounded-full border-2 ${getEventColor(event)}`}>
                  {getEventIcon(event)}
                </div>

                <div className="flex-1 bg-white rounded-lg border border-gray-200 p-4">
                  <div className="flex items-start justify-between gap-2">
                    <div>
                      <h4 className="font-medium text-gray-900">{event.subject}</h4>
                      <p className="text-sm text-gray-600 mt-1">
                        {new Date(event.created_at).toLocaleString('en-US', {
                          month: 'short',
                          day: 'numeric',
                          year: 'numeric',
                          hour: '2-digit',
                          minute: '2-digit',
                        })}
                      </p>
                    </div>

                    {event.is_completed !== undefined && (
                      <span className={`flex items-center gap-1 text-xs px-2 py-1 rounded ${
                        event.is_completed
                          ? 'bg-green-50 text-green-700'
                          : 'bg-orange-50 text-orange-700'
                      }`}>
                        {event.is_completed ? (
                          <>
                            <CheckCircle className="w-3 h-3" />
                            Completed
                          </>
                        ) : (
                          <>
                            <AlertCircle className="w-3 h-3" />
                            Pending
                          </>
                        )}
                      </span>
                    )}
                  </div>

                  {event.description && (
                    <p className="mt-2 text-sm text-gray-700 whitespace-pre-wrap">
                      {event.description}
                    </p>
                  )}

                  {event.user_name && (
                    <p className="mt-2 text-xs text-gray-500">
                      by {event.user_name}
                    </p>
                  )}
                </div>
              </div>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}
