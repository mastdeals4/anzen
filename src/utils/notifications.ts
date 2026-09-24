import { supabase } from '../lib/supabase';
import { showToast } from '../components/ToastNotification';
import { fetchSalesOrderDeliveryAlerts, summarizeDeliveryAlerts } from './salesOrderDeliveryAlerts';

interface NotificationParams {
  userId: string;
  type: 'low_stock' | 'near_expiry' | 'pending_invoice' | 'follow_up' | 'delivery_due';
  title: string;
  message: string;
  referenceId?: string;
  referenceType?: string;
}

function isNavigationAbort(error: unknown): boolean {
  const err = error as { name?: string; message?: string; details?: string; code?: string } | null;
  if (err && typeof err === 'object' && err.code) return false;
  const blob = error && typeof error === 'object'
    ? `${err?.name || ''} ${err?.message || ''} ${err?.details || ''}`
    : String(error);
  return /AbortError|The user aborted|signal is aborted|net::ERR_ABORTED|Failed to fetch/i.test(blob);
}

let cachedRole: { userId: string; role: string; expiresAt: number } | null = null;

async function getCurrentUserRole(): Promise<{ userId: string; role: string } | null> {
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return null;

  const now = Date.now();
  if (cachedRole && cachedRole.userId === user.id && cachedRole.expiresAt > now) {
    return { userId: user.id, role: cachedRole.role };
  }

  const { data: profile } = await supabase
    .from('user_profiles')
    .select('role')
    .eq('id', user.id)
    .maybeSingle();

  const role = profile?.role || '';
  cachedRole = { userId: user.id, role, expiresAt: now + 60000 };
  return { userId: user.id, role };
}

// Resolves recipient user IDs based on the caller's role:
// - Admins/managers can notify all users with target roles
// - Regular users can only notify themselves if their role is in target roles
// - Users outside target roles generate no notifications
async function resolveNotificationRecipients(targetRoles: string[]): Promise<string[]> {
  const caller = await getCurrentUserRole();
  if (!caller) return [];

  if (['admin', 'manager'].includes(caller.role)) {
    const { data: users } = await supabase
      .from('user_profiles')
      .select('id')
      .eq('is_active', true)
      .in('role', targetRoles);
    return (users || []).map(u => u.id);
  }

  if (targetRoles.includes(caller.role)) {
    return [caller.userId];
  }

  return [];
}

// Uses a DB-side RPC with ON CONFLICT DO NOTHING so duplicates are silently
// skipped at the database level — no 409 HTTP errors, no console noise.
export async function createNotification(params: NotificationParams) {
  try {
    const caller = await getCurrentUserRole();
    if (!caller) return;

    // Caller can only notify others if they are admin or manager
    if (params.userId !== caller.userId && !['admin', 'manager'].includes(caller.role)) {
      return;
    }

    const { error } = await supabase.rpc('upsert_notification', {
      p_user_id: params.userId,
      p_type: params.type,
      p_title: params.title,
      p_message: params.message,
      p_reference_id: params.referenceId || null,
      p_reference_type: params.referenceType || null,
    });
    if (error) throw error;
  } catch (error) {
    if (isNavigationAbort(error)) return;
    console.error('Error creating notification:', error);
  }
}

// Check if a daily notification has already been sent today (read or unread).
// The daily dedup index covers this at DB level, but we skip the insert entirely
// to avoid unnecessary round-trips.
async function dailyNotifExistsToday(userId: string, type: string): Promise<boolean> {
  const todayStart = new Date();
  todayStart.setHours(0, 0, 0, 0);

  const { data } = await supabase
    .from('notifications')
    .select('id')
    .eq('user_id', userId)
    .eq('type', type)
    .gte('created_at', todayStart.toISOString())
    .limit(1);

  return !!(data && data.length > 0);
}

export async function checkAndCreateLowStockNotifications() {
  try {
    const recipientIds = await resolveNotificationRecipients(['admin', 'warehouse']);
    if (recipientIds.length === 0) return;

    const { data: products } = await supabase
      .from('products')
      .select('id, product_name, min_stock_level, current_stock')
      .gt('min_stock_level', 0);

    if (!products || products.length === 0) return;

    const lowStockProducts: { product_name: string; current_stock: number; min_stock_level: number }[] = [];

    for (const product of products) {
      const stock = product.current_stock ?? 0;
      if (stock < product.min_stock_level) {
        lowStockProducts.push({
          product_name: product.product_name,
          current_stock: stock,
          min_stock_level: product.min_stock_level,
        });
      }
    }

    if (lowStockProducts.length === 0) return;

    // Build a descriptive message listing the product names
    const productList = lowStockProducts.map(p => p.product_name).join(', ');
    const message = lowStockProducts.length === 1
      ? `${productList} is running low on stock.`
      : `${lowStockProducts.length} products low on stock: ${productList}.`;

    for (const userId of recipientIds) {
      if (await dailyNotifExistsToday(userId, 'low_stock')) continue;

      await createNotification({
        userId,
        type: 'low_stock',
        title: 'Low Stock Alert',
        message,
      });
    }
  } catch (error) {
    if (isNavigationAbort(error)) return;
    console.error('Error checking low stock:', error);
    throw error;
  }
}

export async function checkAndCreateExpiryNotifications() {
  try {
    const recipientIds = await resolveNotificationRecipients(['admin', 'warehouse', 'sales']);
    if (recipientIds.length === 0) return;

    const { data: settings } = await supabase
      .from('app_settings')
      .select('expiry_alert_days')
      .limit(1)
      .maybeSingle();

    const alertDays = settings?.expiry_alert_days || 30;
    const alertDate = new Date();
    alertDate.setDate(alertDate.getDate() + alertDays);

    const { data: nearExpiryBatches } = await supabase
      .from('batches')
      .select('id, batch_number, expiry_date, products(product_name)')
      .eq('is_active', true)
      .not('expiry_date', 'is', null)
      .lte('expiry_date', alertDate.toISOString())
      .gte('expiry_date', new Date().toISOString());

    if (!nearExpiryBatches || nearExpiryBatches.length === 0) return;

    const message = `${nearExpiryBatches.length} batch(es) will expire within ${alertDays} days.`;

    for (const userId of recipientIds) {
      if (await dailyNotifExistsToday(userId, 'near_expiry')) continue;

      await createNotification({
        userId,
        type: 'near_expiry',
        title: 'Products Near Expiry',
        message,
      });
    }
  } catch (error) {
    if (isNavigationAbort(error)) return;
    console.error('Error checking expiry dates:', error);
    throw error;
  }
}

export async function checkAndCreateFollowUpNotifications() {
  try {
    const recipientIds = await resolveNotificationRecipients(['admin', 'sales']);
    if (recipientIds.length === 0) return;

    const today = new Date().toISOString().split('T')[0];

    const { data: dueActivities } = await supabase
      .from('crm_activities')
      .select('id, customer_id, activity_type, crm_contacts(company_name)')
      .eq('is_completed', false)
      .not('follow_up_date', 'is', null)
      .lte('follow_up_date', today);

    if (!dueActivities || dueActivities.length === 0) return;

    const message = `You have ${dueActivities.length} follow-up(s) due today.`;

    for (const userId of recipientIds) {
      // Skip if already sent any follow_up notification today (read or unread)
      if (await dailyNotifExistsToday(userId, 'follow_up')) continue;

      await createNotification({
        userId,
        type: 'follow_up',
        title: 'Follow-ups Due',
        message,
      });
    }
  } catch (error) {
    if (isNavigationAbort(error)) return;
    console.error('Error checking follow-ups:', error);
    throw error;
  }
}

export async function checkAndCreateDeliveryDueNotifications() {
  try {
    const recipientIds = await resolveNotificationRecipients(['sales', 'warehouse', 'admin', 'manager']);
    if (recipientIds.length === 0) return;

    const alerts = await fetchSalesOrderDeliveryAlerts();
    if (alerts.length === 0) return;

    const { dueSoon, overdue } = summarizeDeliveryAlerts(alerts);

    const parts = [
      overdue.length ? `${overdue.length} overdue` : '',
      dueSoon.length ? `${dueSoon.length} due soon` : '',
    ].filter(Boolean);
    const sample = alerts.slice(0, 3).map(alert => alert.soNumber).join(', ');
    const message = `${parts.join(', ')} sales order deliver${alerts.length === 1 ? 'y needs' : 'ies need'} attention${sample ? `: ${sample}` : ''}.`;

    for (const userId of recipientIds) {
      if (await dailyNotifExistsToday(userId, 'delivery_due')) continue;

      await createNotification({
        userId,
        type: 'delivery_due',
        title: overdue.length ? 'Delivery Overdue' : 'Delivery Due Soon',
        message,
      });
    }

    const { data: { user: currentUser } } = await supabase.auth.getUser();
    if (currentUser && recipientIds.includes(currentUser.id)) {
      const toastKey = `delivery_due_toast_${new Date().toISOString().split('T')[0]}`;
      if (sessionStorage.getItem(toastKey) !== 'shown') {
        showToast({
          type: overdue.length ? 'error' : 'warning',
          title: overdue.length ? 'Delivery Overdue' : 'Delivery Due Soon',
          message,
          duration: 8000,
        });
        sessionStorage.setItem(toastKey, 'shown');
      }
    }
  } catch (error) {
    if (isNavigationAbort(error)) return;
    console.error('Error checking delivery due alerts:', error);
    throw error;
  }
}

export function getLocalCalendarDate(date: Date = new Date()): string {
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, '0');
  const day = String(date.getDate()).padStart(2, '0');
  return `${year}-${month}-${day}`;
}

export function getDailyNotificationGuardKey(userId: string, date: Date = new Date()): string {
  return `notification_check_${userId}_${getLocalCalendarDate(date)}`;
}

export function isDailyNotificationCheckCompleted(userId: string, date: Date = new Date()): boolean {
  try {
    if (typeof localStorage === 'undefined') return false;
    return localStorage.getItem(getDailyNotificationGuardKey(userId, date)) === 'completed';
  } catch {
    return false;
  }
}

export function markDailyNotificationCheckCompleted(userId: string, date: Date = new Date()): void {
  try {
    if (typeof localStorage === 'undefined') return;
    const key = getDailyNotificationGuardKey(userId, date);
    localStorage.setItem(key, 'completed');

    // Clean up older date keys for this user to keep localStorage bounded
    for (let i = localStorage.length - 1; i >= 0; i--) {
      const k = localStorage.key(i);
      if (k && k.startsWith(`notification_check_${userId}_`) && k !== key) {
        localStorage.removeItem(k);
      }
    }
  } catch {
    // localStorage unavailable — silently ignore
  }
}

async function checkAndCreateTaxNotifications() {
  try {
    const caller = await getCurrentUserRole();
    if (!caller || !['admin', 'manager', 'accounts'].includes(caller.role)) return;

    const { error } = await supabase.rpc('generate_tax_notifications');
    if (error) throw error;
  } catch (error) {
    if (isNavigationAbort(error)) return;
    console.error('Error generating tax notifications:', error);
    throw error;
  }
}

async function checkAndCreateEnquiryTaskReminders() {
  try {
    const { error } = await supabase.rpc('evaluate_enquiry_task_reminders');
    if (error) throw error;
  } catch (error) {
    if (isNavigationAbort(error)) return;
    console.error('Error evaluating enquiry task reminders:', error);
    throw error;
  }
}

let isCheckingNotifications = false;

/**
 * Initializes notification checks ONCE PER USER PER CALENDAR DAY.
 *
 * Daily execution guard:
 * - Checks localStorage for `notification_check_<user_id>_<YYYY-MM-DD>`.
 * - If today's check has already completed: returns false immediately (NO queries, NO RPCs).
 * - If not completed: executes the alert checks once, marks the day as completed,
 *   and dispatches a 'notifications-checked' window event.
 * - If any check genuinely fails, does NOT mark the day as completed to allow retry on next startup.
 * - Strictly NO timer intervals, NO polling, NO repeated checks.
 */
export async function initializeNotificationChecks(): Promise<boolean> {
  try {
    const { data: { user } } = await supabase.auth.getUser();
    if (!user) return false;

    // Daily execution guard: run at most ONCE per user per calendar day
    if (isDailyNotificationCheckCompleted(user.id)) {
      return false;
    }

    if (isCheckingNotifications) {
      return false;
    }
    isCheckingNotifications = true;

    try {
      await checkAndCreateLowStockNotifications();
      await checkAndCreateExpiryNotifications();
      await checkAndCreateFollowUpNotifications();
      await checkAndCreateDeliveryDueNotifications();
      await checkAndCreateTaxNotifications();
      await checkAndCreateEnquiryTaskReminders();

      // Mark completed ONLY after all checks succeed
      markDailyNotificationCheckCompleted(user.id);

      if (typeof window !== 'undefined') {
        window.dispatchEvent(new CustomEvent('notifications-checked'));
      }
      return true;
    } finally {
      isCheckingNotifications = false;
    }
  } catch (error) {
    if (isNavigationAbort(error)) return false;
    console.error('Error during daily notification checks:', error);
    // If check failed, do NOT mark completed so it can retry on next initialization
    return false;
  }
}
