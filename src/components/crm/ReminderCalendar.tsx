import { useEffect, useState } from 'react';
import { supabase } from '../../lib/supabase';
import { Calendar, ChevronLeft, ChevronRight, Clock, CheckCircle, AlertCircle, Plus } from 'lucide-react';
import { Modal } from '../Modal';

interface Reminder {
  id: string;
  inquiry_id: string | null;
  reminder_type: string;
  title: string;
  description: string | null;
  due_date: string;
  is_completed: boolean;
  completed_at: string | null;
  crm_inquiries?: {
    inquiry_number: string;
    company_name: string;
    product_name: string;
  } | null;
}

interface ReminderCalendarProps {
  onReminderCreated?: () => void;
}

export function ReminderCalendar({ onReminderCreated }: ReminderCalendarProps) {
  const [reminders, setReminders] = useState<Reminder[]>([]);
  const [currentDate, setCurrentDate] = useState(new Date());
  const [selectedDate, setSelectedDate] = useState<Date | null>(null);
  const [view, setView] = useState<'month' | 'week' | 'list'>('month');
  const [loading, setLoading] = useState(true);
  const [modalOpen, setModalOpen] = useState(false);
  const [selectedReminder, setSelectedReminder] = useState<Reminder | null>(null);

  useEffect(() => {
    loadReminders();
  }, [currentDate, view]);

  const loadReminders = async () => {
    try {
      let query = supabase
        .from('crm_reminders')
        .select(`
          *,
          crm_inquiries (
            inquiry_number,
            company_name,
            product_name
          )
        `);

      if (view === 'month') {
        const startOfMonth = new Date(currentDate.getFullYear(), currentDate.getMonth(), 1);
        const endOfMonth = new Date(currentDate.getFullYear(), currentDate.getMonth() + 1, 0);
        query = query
          .gte('due_date', startOfMonth.toISOString())
          .lte('due_date', endOfMonth.toISOString());
      }

      const { data, error } = await query.order('due_date', { ascending: true });

      if (error) throw error;
      setReminders(data || []);
    } catch (error) {
      console.error('Error loading reminders:', error);
    } finally {
      setLoading(false);
    }
  };

  const toggleCompleted = async (reminder: Reminder) => {
    try {
      const { error } = await supabase
        .from('crm_reminders')
        .update({
          is_completed: !reminder.is_completed,
          completed_at: !reminder.is_completed ? new Date().toISOString() : null,
        })
        .eq('id', reminder.id);

      if (error) throw error;
      loadReminders();
    } catch (error) {
      console.error('Error updating reminder:', error);
    }
  };

  const snoozeReminder = async (reminder: Reminder, days: number) => {
    try {
      const newDate = new Date(reminder.due_date);
      newDate.setDate(newDate.getDate() + days);

      const { error } = await supabase
        .from('crm_reminders')
        .update({
          due_date: newDate.toISOString(),
        })
        .eq('id', reminder.id);

      if (error) throw error;
      loadReminders();
      setModalOpen(false);
    } catch (error) {
      console.error('Error snoozing reminder:', error);
    }
  };

  const getDaysInMonth = (date: Date) => {
    return new Date(date.getFullYear(), date.getMonth() + 1, 0).getDate();
  };

  const getFirstDayOfMonth = (date: Date) => {
    return new Date(date.getFullYear(), date.getMonth(), 1).getDay();
  };

  const getRemindersForDate = (date: Date) => {
    return reminders.filter(r => {
      const reminderDate = new Date(r.due_date);
      return reminderDate.getDate() === date.getDate() &&
             reminderDate.getMonth() === date.getMonth() &&
             reminderDate.getFullYear() === date.getFullYear();
    });
  };

  const getTodayReminders = () => {
    const today = new Date();
    today.setHours(0, 0, 0, 0);
    return reminders.filter(r => {
      const reminderDate = new Date(r.due_date);
      reminderDate.setHours(0, 0, 0, 0);
      return reminderDate.getTime() === today.getTime() && !r.is_completed;
    });
  };

  const getOverdueReminders = () => {
    const today = new Date();
    today.setHours(0, 0, 0, 0);
    return reminders.filter(r => {
      const reminderDate = new Date(r.due_date);
      reminderDate.setHours(0, 0, 0, 0);
      return reminderDate < today && !r.is_completed;
    });
  };

  const getUpcomingReminders = () => {
    const today = new Date();
    today.setHours(0, 0, 0, 0);
    const nextWeek = new Date(today);
    nextWeek.setDate(nextWeek.getDate() + 7);

    return reminders.filter(r => {
      const reminderDate = new Date(r.due_date);
      reminderDate.setHours(0, 0, 0, 0);
      return reminderDate > today && reminderDate <= nextWeek && !r.is_completed;
    });
  };

  const previousMonth = () => {
    setCurrentDate(new Date(currentDate.getFullYear(), currentDate.getMonth() - 1));
  };

  const nextMonth = () => {
    setCurrentDate(new Date(currentDate.getFullYear(), currentDate.getMonth() + 1));
  };

  const reminderTypeColors = {
    follow_up: 'bg-blue-100 text-blue-800 border-blue-200',
    send_coa: 'bg-orange-100 text-orange-800 border-orange-200',
    send_sample: 'bg-green-100 text-green-800 border-green-200',
    send_price: 'bg-purple-100 text-purple-800 border-purple-200',
    custom: 'bg-gray-100 text-gray-800 border-gray-200',
  };

  const renderMonthView = () => {
    const daysInMonth = getDaysInMonth(currentDate);
    const firstDay = getFirstDayOfMonth(currentDate);
    const days = [];

    for (let i = 0; i < firstDay; i++) {
      days.push(<div key={`empty-${i}`} className="min-h-24 p-2 bg-gray-50"></div>);
    }

    for (let day = 1; day <= daysInMonth; day++) {
      const date = new Date(currentDate.getFullYear(), currentDate.getMonth(), day);
      const dayReminders = getRemindersForDate(date);
      const isToday = date.toDateString() === new Date().toDateString();

      days.push(
        <div
          key={day}
          className={`min-h-24 p-2 border border-gray-200 ${isToday ? 'bg-blue-50' : 'bg-white'} hover:bg-gray-50 transition cursor-pointer`}
          onClick={() => {
            setSelectedDate(date);
            if (dayReminders.length > 0) {
              setSelectedReminder(dayReminders[0]);
              setModalOpen(true);
            }
          }}
        >
          <div className={`text-sm font-medium mb-1 ${isToday ? 'text-blue-600' : 'text-gray-900'}`}>
            {day}
          </div>
          <div className="space-y-1">
            {dayReminders.slice(0, 3).map((reminder) => (
              <div
                key={reminder.id}
                className={`text-xs p-1 rounded border ${reminderTypeColors[reminder.reminder_type as keyof typeof reminderTypeColors]} truncate ${reminder.is_completed ? 'opacity-50 line-through' : ''}`}
                title={reminder.title}
              >
                {reminder.title}
              </div>
            ))}
            {dayReminders.length > 3 && (
              <div className="text-xs text-gray-500 font-medium">
                +{dayReminders.length - 3} more
              </div>
            )}
          </div>
        </div>
      );
    }

    return days;
  };

  const renderListView = () => {
    const overdueReminders = getOverdueReminders();
    const todayReminders = getTodayReminders();
    const upcomingReminders = getUpcomingReminders();

    return (
      <div className="space-y-6">
        {overdueReminders.length > 0 && (
          <div>
            <h3 className="text-sm font-semibold text-red-600 mb-2 flex items-center gap-2">
              <AlertCircle className="w-4 h-4" />
              Overdue ({overdueReminders.length})
            </h3>
            <div className="space-y-2">
              {overdueReminders.map((reminder) => (
                <ReminderCard
                  key={reminder.id}
                  reminder={reminder}
                  onToggleComplete={toggleCompleted}
                  onViewDetails={() => {
                    setSelectedReminder(reminder);
                    setModalOpen(true);
                  }}
                />
              ))}
            </div>
          </div>
        )}

        {todayReminders.length > 0 && (
          <div>
            <h3 className="text-sm font-semibold text-blue-600 mb-2 flex items-center gap-2">
              <Clock className="w-4 h-4" />
              Today ({todayReminders.length})
            </h3>
            <div className="space-y-2">
              {todayReminders.map((reminder) => (
                <ReminderCard
                  key={reminder.id}
                  reminder={reminder}
                  onToggleComplete={toggleCompleted}
                  onViewDetails={() => {
                    setSelectedReminder(reminder);
                    setModalOpen(true);
                  }}
                />
              ))}
            </div>
          </div>
        )}

        {upcomingReminders.length > 0 && (
          <div>
            <h3 className="text-sm font-semibold text-gray-700 mb-2">
              Upcoming (Next 7 days)
            </h3>
            <div className="space-y-2">
              {upcomingReminders.map((reminder) => (
                <ReminderCard
                  key={reminder.id}
                  reminder={reminder}
                  onToggleComplete={toggleCompleted}
                  onViewDetails={() => {
                    setSelectedReminder(reminder);
                    setModalOpen(true);
                  }}
                />
              ))}
            </div>
          </div>
        )}

        {overdueReminders.length === 0 && todayReminders.length === 0 && upcomingReminders.length === 0 && (
          <div className="text-center py-12 text-gray-500">
            <Clock className="w-12 h-12 mx-auto text-gray-300 mb-3" />
            {reminders.length === 0 ? (
              <p>No reminders found. Create one using the quick actions!</p>
            ) : (
              <div>
                <p className="font-medium">No upcoming reminders in the next 7 days</p>
                <p className="text-sm mt-1">You have {reminders.length} reminder{reminders.length === 1 ? '' : 's'} total (all past or completed)</p>
              </div>
            )}
          </div>
        )}
      </div>
    );
  };

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-4">
          <h3 className="text-lg font-semibold flex items-center gap-2">
            <Calendar className="w-5 h-5 text-blue-600" />
            Reminders & Tasks
          </h3>
          <div className="flex gap-1 bg-gray-100 rounded-lg p-1">
            <button
              onClick={() => setView('month')}
              className={`px-3 py-1 rounded text-sm ${view === 'month' ? 'bg-white shadow' : 'text-gray-600'}`}
            >
              Month
            </button>
            <button
              onClick={() => setView('list')}
              className={`px-3 py-1 rounded text-sm ${view === 'list' ? 'bg-white shadow' : 'text-gray-600'}`}
            >
              List
            </button>
          </div>
        </div>

        {view === 'month' && (
          <div className="flex items-center gap-2">
            <button
              onClick={previousMonth}
              className="p-2 hover:bg-gray-100 rounded-lg transition"
            >
              <ChevronLeft className="w-5 h-5" />
            </button>
            <span className="font-semibold min-w-40 text-center">
              {currentDate.toLocaleDateString('en-US', { month: 'long', year: 'numeric' })}
            </span>
            <button
              onClick={nextMonth}
              className="p-2 hover:bg-gray-100 rounded-lg transition"
            >
              <ChevronRight className="w-5 h-5" />
            </button>
          </div>
        )}
      </div>

      {loading ? (
        <div className="flex justify-center items-center py-12">
          <div className="animate-spin rounded-full h-8 w-8 border-b-2 border-blue-600" />
        </div>
      ) : view === 'month' ? (
        <div className="space-y-2">
          {reminders.length === 0 && (
            <div className="bg-yellow-50 border border-yellow-200 rounded-lg p-3 text-sm text-yellow-800">
              <p className="font-medium">No reminders for {currentDate.toLocaleDateString('en-US', { month: 'long', year: 'numeric' })}</p>
              <p className="text-xs mt-1">Use the arrows above to navigate to other months, or switch to "List" view to see all reminders.</p>
            </div>
          )}
          {reminders.length > 0 && (
            <div className="text-sm text-gray-600 px-2">
              {reminders.length} reminder{reminders.length === 1 ? '' : 's'} in {currentDate.toLocaleDateString('en-US', { month: 'long' })}
            </div>
          )}
          <div className="bg-white rounded-lg shadow overflow-hidden">
            <div className="grid grid-cols-7 border-b border-gray-200">
              {['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'].map((day) => (
                <div key={day} className="p-2 text-center text-sm font-semibold text-gray-700 bg-gray-50">
                  {day}
                </div>
              ))}
            </div>
            <div className="grid grid-cols-7">
              {renderMonthView()}
            </div>
          </div>
        </div>
      ) : (
        <div className="bg-white rounded-lg shadow p-4">
          {renderListView()}
        </div>
      )}

      <Modal
        isOpen={modalOpen}
        onClose={() => {
          setModalOpen(false);
          setSelectedReminder(null);
        }}
        title="Reminder Details"
      >
        {selectedReminder && (
          <div className="space-y-4">
            <div className={`p-3 rounded-lg border ${reminderTypeColors[selectedReminder.reminder_type as keyof typeof reminderTypeColors]}`}>
              <p className="font-semibold">{selectedReminder.title}</p>
              <p className="text-sm mt-1">Due: {new Date(selectedReminder.due_date).toLocaleDateString()}</p>
            </div>

            {selectedReminder.description && (
              <div>
                <label className="text-sm font-medium text-gray-700">Description</label>
                <p className="text-sm text-gray-600 mt-1">{selectedReminder.description}</p>
              </div>
            )}

            {selectedReminder.crm_inquiries && (
              <div className="border-t pt-4">
                <label className="text-sm font-medium text-gray-700">Related Inquiry</label>
                <div className="mt-2 bg-gray-50 p-3 rounded-lg">
                  <p className="text-sm font-medium">#{selectedReminder.crm_inquiries.inquiry_number}</p>
                  <p className="text-sm text-gray-600">{selectedReminder.crm_inquiries.company_name}</p>
                  <p className="text-xs text-gray-500 mt-1">{selectedReminder.crm_inquiries.product_name}</p>
                </div>
              </div>
            )}

            <div className="flex justify-between items-center pt-4 border-t">
              <div className="flex gap-2">
                <button
                  onClick={() => snoozeReminder(selectedReminder, 1)}
                  className="text-sm px-3 py-1.5 border border-gray-300 rounded-lg hover:bg-gray-50 transition"
                >
                  Snooze 1 day
                </button>
                <button
                  onClick={() => snoozeReminder(selectedReminder, 3)}
                  className="text-sm px-3 py-1.5 border border-gray-300 rounded-lg hover:bg-gray-50 transition"
                >
                  Snooze 3 days
                </button>
              </div>
              <button
                onClick={() => {
                  toggleCompleted(selectedReminder);
                  setModalOpen(false);
                }}
                className="flex items-center gap-2 px-4 py-2 bg-green-600 text-white rounded-lg hover:bg-green-700 transition"
              >
                <CheckCircle className="w-4 h-4" />
                {selectedReminder.is_completed ? 'Mark Incomplete' : 'Mark Complete'}
              </button>
            </div>
          </div>
        )}
      </Modal>
    </div>
  );
}

function ReminderCard({
  reminder,
  onToggleComplete,
  onViewDetails,
}: {
  reminder: Reminder;
  onToggleComplete: (reminder: Reminder) => void;
  onViewDetails: () => void;
}) {
  const reminderTypeColors = {
    follow_up: 'border-blue-200',
    send_coa: 'border-orange-200',
    send_sample: 'border-green-200',
    send_price: 'border-purple-200',
    custom: 'border-gray-200',
  };

  const isOverdue = new Date(reminder.due_date) < new Date() && !reminder.is_completed;

  return (
    <div
      className={`p-3 border-l-4 ${reminderTypeColors[reminder.reminder_type as keyof typeof reminderTypeColors]} bg-white rounded-lg shadow-sm hover:shadow-md transition ${reminder.is_completed ? 'opacity-60' : ''}`}
    >
      <div className="flex items-start justify-between">
        <div className="flex-1 cursor-pointer" onClick={onViewDetails}>
          <p className={`font-medium ${reminder.is_completed ? 'line-through' : ''}`}>
            {reminder.title}
          </p>
          {reminder.crm_inquiries && (
            <p className="text-xs text-gray-500 mt-1">
              #{reminder.crm_inquiries.inquiry_number} - {reminder.crm_inquiries.company_name}
            </p>
          )}
          <div className="flex items-center gap-2 mt-1">
            <span className={`text-xs ${isOverdue ? 'text-red-600 font-medium' : 'text-gray-500'}`}>
              {new Date(reminder.due_date).toLocaleDateString()}
            </span>
            {isOverdue && (
              <span className="text-xs bg-red-100 text-red-800 px-2 py-0.5 rounded-full">
                Overdue
              </span>
            )}
          </div>
        </div>
        <button
          onClick={() => onToggleComplete(reminder)}
          className={`p-1 rounded ${reminder.is_completed ? 'text-green-600' : 'text-gray-400 hover:text-green-600'}`}
        >
          <CheckCircle className="w-5 h-5" />
        </button>
      </div>
    </div>
  );
}
