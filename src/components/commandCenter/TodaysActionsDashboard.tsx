import { useEffect, useState } from 'react';
import { supabase } from '../../lib/supabase';
import { useAuth } from '../../contexts/AuthContext';
import { useNavigation } from '../../contexts/NavigationContext';
import { Clock, AlertCircle, CheckCircle2, Calendar, Phone, Send, ChevronRight, FileText, ClipboardCheck } from 'lucide-react';
import { fetchSalesOrderDeliveryAlerts, SalesOrderDeliveryAlert, summarizeDeliveryAlerts } from '../../utils/salesOrderDeliveryAlerts';

interface Reminder {
  id: string;
  inquiry_id: string | null;
  reminder_type: string;
  title: string;
  due_date: string;
  is_completed: boolean;
  crm_inquiries?: {
    inquiry_number: string;
    company_name: string;
    product_name: string;
  } | null;
}

interface TodaysActionsDashboardProps {
  onActionClick?: (reminderId: string) => void;
}

export function TodaysActionsDashboard({ onActionClick: _onActionClick }: TodaysActionsDashboardProps) {
  const { profile } = useAuth();
  const { setCurrentPage } = useNavigation();
  const [todayReminders, setTodayReminders] = useState<Reminder[]>([]);
  const [overdueReminders, setOverdueReminders] = useState<Reminder[]>([]);
  const [pendingSalesOrders, setPendingSalesOrders] = useState(0);
  const [pendingDeliveryChallans, setPendingDeliveryChallans] = useState(0);
  const [deliveryAlerts, setDeliveryAlerts] = useState<SalesOrderDeliveryAlert[]>([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    loadReminders();
    loadApprovals();
    loadDeliveryAlerts();

    const subscription = supabase
      .channel('reminders_changes')
      .on(
        'postgres_changes',
        {
          event: '*',
          schema: 'public',
          table: 'crm_reminders',
        },
        () => {
          loadReminders();
        }
      )
      .subscribe();

    return () => {
      subscription.unsubscribe();
    };
  }, [profile?.role]);

  const loadReminders = async () => {
    try {
      const today = new Date();
      today.setHours(0, 0, 0, 0);

      const tomorrow = new Date(today);
      tomorrow.setDate(tomorrow.getDate() + 1);

      const { data: todayData, error: todayError } = await supabase
        .from('crm_reminders')
        .select(`
          *,
          crm_inquiries (
            inquiry_number,
            company_name,
            product_name
          )
        `)
        .eq('is_completed', false)
        .gte('due_date', today.toISOString())
        .lt('due_date', tomorrow.toISOString())
        .order('due_date', { ascending: true })
        .limit(5);

      if (todayError) throw todayError;

      const { data: overdueData, error: overdueError } = await supabase
        .from('crm_reminders')
        .select(`
          *,
          crm_inquiries (
            inquiry_number,
            company_name,
            product_name
          )
        `)
        .eq('is_completed', false)
        .lt('due_date', today.toISOString())
        .order('due_date', { ascending: true })
        .limit(5);

      if (overdueError) throw overdueError;

      setTodayReminders(todayData || []);
      setOverdueReminders(overdueData || []);
    } catch (error) {
      console.error('Error loading reminders:', error);
    } finally {
      setLoading(false);
    }
  };

  const loadApprovals = async () => {
    try {
      if (profile?.role === 'admin' || profile?.role === 'sales') {
        const { count: soCount } = await supabase
          .from('sales_orders')
          .select('id', { count: 'exact', head: true })
          .eq('status', 'pending_approval');
        setPendingSalesOrders(soCount || 0);
      }

      if (profile?.role === 'admin') {
        const { count: dcCount } = await supabase
          .from('delivery_challans')
          .select('id', { count: 'exact', head: true })
          .eq('approval_status', 'pending_approval');
        setPendingDeliveryChallans(dcCount || 0);
      }
    } catch (error) {
      console.error('Error loading approvals:', error);
    }
  };

  const loadDeliveryAlerts = async () => {
    try {
      if (!['admin', 'sales', 'warehouse', 'manager'].includes(profile?.role || '')) {
        setDeliveryAlerts([]);
        return;
      }
      setDeliveryAlerts(await fetchSalesOrderDeliveryAlerts());
    } catch (error) {
      console.error('Error loading delivery alerts:', error);
    }
  };

  const completeReminder = async (id: string) => {
    try {
      const { error } = await supabase
        .from('crm_reminders')
        .update({
          is_completed: true,
          completed_at: new Date().toISOString(),
        })
        .eq('id', id);

      if (error) throw error;
      loadReminders();
    } catch (error) {
      console.error('Error completing reminder:', error);
    }
  };

  const getReminderIcon = (type: string) => {
    switch (type) {
      case 'send_price':
      case 'send_coa':
      case 'send_sample':
        return Send;
      case 'follow_up':
        return Phone;
      default:
        return Calendar;
    }
  };

  const getReminderColor = (type: string) => {
    switch (type) {
      case 'send_price':
        return 'text-green-600';
      case 'send_coa':
        return 'text-blue-600';
      case 'send_sample':
        return 'text-purple-600';
      case 'follow_up':
        return 'text-orange-600';
      default:
        return 'text-gray-600';
    }
  };

  if (loading) {
    return (
      <div className="bg-white rounded-lg shadow p-3">
        <div className="animate-pulse space-y-2">
          <div className="h-4 bg-gray-200 rounded w-1/3" />
          <div className="h-8 bg-gray-200 rounded" />
          <div className="h-8 bg-gray-200 rounded" />
        </div>
      </div>
    );
  }

  const deliveryAlertSummary = summarizeDeliveryAlerts(deliveryAlerts);
  const totalActions = todayReminders.length + overdueReminders.length + pendingSalesOrders + pendingDeliveryChallans + deliveryAlerts.length;

  if (totalActions === 0) {
    return (
      <div className="bg-white rounded-lg shadow p-3">
        <div className="flex items-center justify-between mb-2">
          <h2 className="text-sm font-semibold text-gray-900 flex items-center gap-2">
            <Clock className="w-4 h-4 text-blue-600" />
            Today's Actions
          </h2>
          <span className="px-2 py-0.5 text-xs font-medium bg-green-100 text-green-700 rounded-full">
            All Clear!
          </span>
        </div>
        <div className="text-center py-4">
          <CheckCircle2 className="w-12 h-12 text-green-500 mx-auto mb-2" />
          <p className="text-sm text-gray-600">No pending actions</p>
        </div>
      </div>
    );
  }

  return (
    <div className="bg-white rounded-lg shadow">
      <div className="p-2.5 border-b border-gray-200">
        <div className="flex items-center justify-between">
          <h2 className="text-sm font-semibold text-gray-900 flex items-center gap-2">
            <Clock className="w-4 h-4 text-blue-600" />
            Today's Actions
          </h2>
          <span className="px-2 py-0.5 text-xs font-medium bg-blue-100 text-blue-700 rounded-full">
            {totalActions} {totalActions === 1 ? 'Action' : 'Actions'}
          </span>
        </div>
      </div>

      <div className="p-2.5 space-y-2">
        {deliveryAlerts.length > 0 && (
          <div>
            <div className="flex items-center gap-1.5 mb-1.5">
              <AlertCircle className={`w-3.5 h-3.5 ${deliveryAlertSummary.overdue.length ? 'text-red-600' : 'text-yellow-600'}`} />
              <h3 className={`text-xs font-semibold ${deliveryAlertSummary.overdue.length ? 'text-red-600' : 'text-yellow-600'}`}>
                Delivery Alerts ({deliveryAlerts.length})
              </h3>
            </div>
            <div className="space-y-1.5">
              {deliveryAlerts.slice(0, 5).map((alert) => (
                <div
                  key={alert.soId}
                  onClick={() => setCurrentPage('sales-orders')}
                  className={`flex items-start gap-2 p-2 border rounded-lg hover:shadow-md transition cursor-pointer ${
                    alert.level === 'overdue' ? 'bg-red-50 border-red-200' : 'bg-yellow-50 border-yellow-200'
                  }`}
                >
                  <FileText className={`w-4 h-4 mt-0.5 flex-shrink-0 ${alert.level === 'overdue' ? 'text-red-600' : 'text-yellow-600'}`} />
                  <div className="flex-1 min-w-0">
                    <p className="text-sm font-medium text-gray-900">
                      {alert.soNumber} - {alert.customerName}
                    </p>
                    <p className={`text-xs mt-0.5 ${alert.level === 'overdue' ? 'text-red-600' : 'text-yellow-700'}`}>
                      {alert.level === 'overdue'
                        ? `${Math.abs(alert.daysUntilDue)} day${Math.abs(alert.daysUntilDue) === 1 ? '' : 's'} overdue`
                        : `Due in ${alert.daysUntilDue} day${alert.daysUntilDue === 1 ? '' : 's'}`}
                    </p>
                  </div>
                  <ChevronRight className="w-5 h-5 text-gray-400 flex-shrink-0" />
                </div>
              ))}
            </div>
          </div>
        )}

        {(pendingSalesOrders > 0 || pendingDeliveryChallans > 0) && (
          <div>
            <div className="flex items-center gap-1.5 mb-1.5">
              <AlertCircle className="w-3.5 h-3.5 text-yellow-600" />
              <h3 className="text-xs font-semibold text-yellow-600">Pending Approvals</h3>
            </div>
            <div className="space-y-1.5">
              {pendingSalesOrders > 0 && (
                <div
                  onClick={() => setCurrentPage('sales-orders')}
                  className="flex items-start gap-2 p-2 bg-yellow-50 border border-yellow-200 rounded-lg hover:shadow-md transition cursor-pointer"
                >
                  <FileText className="w-4 h-4 text-yellow-600 mt-0.5 flex-shrink-0" />
                  <div className="flex-1 min-w-0">
                    <p className="text-sm font-medium text-gray-900">
                      Sales Orders Pending Approval
                    </p>
                    <p className="text-xs text-gray-600 mt-0.5">
                      {pendingSalesOrders} order{pendingSalesOrders !== 1 ? 's' : ''} waiting for your review
                    </p>
                  </div>
                  <ChevronRight className="w-5 h-5 text-gray-400 flex-shrink-0" />
                </div>
              )}
              {pendingDeliveryChallans > 0 && (
                <div
                  onClick={() => setCurrentPage('delivery-challan')}
                  className="flex items-start gap-2 p-2 bg-yellow-50 border border-yellow-200 rounded-lg hover:shadow-md transition cursor-pointer"
                >
                  <ClipboardCheck className="w-4 h-4 text-yellow-600 mt-0.5 flex-shrink-0" />
                  <div className="flex-1 min-w-0">
                    <p className="text-sm font-medium text-gray-900">
                      Delivery Challans Pending Approval
                    </p>
                    <p className="text-xs text-gray-600 mt-0.5">
                      {pendingDeliveryChallans} challan{pendingDeliveryChallans !== 1 ? 's' : ''} waiting for your review
                    </p>
                  </div>
                  <ChevronRight className="w-5 h-5 text-gray-400 flex-shrink-0" />
                </div>
              )}
            </div>
          </div>
        )}

        {overdueReminders.length > 0 && (
          <div>
            <div className="flex items-center gap-1.5 mb-1.5">
              <AlertCircle className="w-3.5 h-3.5 text-red-600" />
              <h3 className="text-xs font-semibold text-red-600">Overdue ({overdueReminders.length})</h3>
            </div>
            <div className="space-y-1.5">
              {overdueReminders.map((reminder) => {
                const Icon = getReminderIcon(reminder.reminder_type);
                const color = getReminderColor(reminder.reminder_type);

                return (
                  <div
                    key={reminder.id}
                    className="flex items-start gap-2 p-2 bg-red-50 border border-red-200 rounded-lg hover:shadow-sm transition"
                  >
                    <Icon className={`w-4 h-4 ${color} mt-0.5 flex-shrink-0`} />
                    <div className="flex-1 min-w-0">
                      <p className="text-sm font-medium text-gray-900 line-clamp-1">
                        {reminder.title}
                      </p>
                      {reminder.crm_inquiries && (
                        <p className="text-xs text-gray-600 mt-0.5 truncate">
                          #{reminder.crm_inquiries.inquiry_number} - {reminder.crm_inquiries.company_name}
                        </p>
                      )}
                      <p className="text-xs text-red-600 font-medium mt-1">
                        {Math.abs(Math.floor((new Date().getTime() - new Date(reminder.due_date).getTime()) / (1000 * 60 * 60 * 24)))} days overdue
                      </p>
                    </div>
                    <button
                      onClick={() => completeReminder(reminder.id)}
                      className="p-1 text-gray-400 hover:text-green-600 flex-shrink-0"
                      title="Mark as complete"
                    >
                      <CheckCircle2 className="w-5 h-5" />
                    </button>
                  </div>
                );
              })}
            </div>
          </div>
        )}

        {todayReminders.length > 0 && (
          <div>
            {overdueReminders.length > 0 && (
              <div className="flex items-center gap-1.5 mb-1.5 mt-2">
                <Clock className="w-3.5 h-3.5 text-blue-600" />
                <h3 className="text-xs font-semibold text-blue-600">Today ({todayReminders.length})</h3>
              </div>
            )}
            <div className="space-y-1.5">
              {todayReminders.map((reminder) => {
                const Icon = getReminderIcon(reminder.reminder_type);
                const color = getReminderColor(reminder.reminder_type);

                return (
                  <div
                    key={reminder.id}
                    className="flex items-start gap-2 p-2 bg-blue-50 border border-blue-200 rounded-lg hover:shadow-sm transition"
                  >
                    <Icon className={`w-4 h-4 ${color} mt-0.5 flex-shrink-0`} />
                    <div className="flex-1 min-w-0">
                      <p className="text-sm font-medium text-gray-900 line-clamp-1">
                        {reminder.title}
                      </p>
                      {reminder.crm_inquiries && (
                        <p className="text-xs text-gray-600 mt-0.5 truncate">
                          #{reminder.crm_inquiries.inquiry_number} - {reminder.crm_inquiries.company_name}
                        </p>
                      )}
                      <p className="text-xs text-blue-600 mt-1">
                        {new Date(reminder.due_date).toLocaleTimeString('en-US', {
                          hour: '2-digit',
                          minute: '2-digit',
                        })}
                      </p>
                    </div>
                    <button
                      onClick={() => completeReminder(reminder.id)}
                      className="p-1 text-gray-400 hover:text-green-600 flex-shrink-0"
                      title="Mark as complete"
                    >
                      <CheckCircle2 className="w-5 h-5" />
                    </button>
                  </div>
                );
              })}
            </div>
          </div>
        )}
      </div>

      {totalActions > 5 && (
        <div className="p-2 border-t border-gray-200">
          <button className="w-full flex items-center justify-center gap-1.5 text-xs text-blue-600 hover:text-blue-700 font-medium">
            <span>View All</span>
            <ChevronRight className="w-3.5 h-3.5" />
          </button>
        </div>
      )}
    </div>
  );
}
