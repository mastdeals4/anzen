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

// Uses a DB-side RPC with ON CONFLICT DO NOTHING so duplicates are silently
// skipped at the database level — no 409 HTTP errors, no console noise.
export async function createNotification(params: NotificationParams) {
  try {
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

    const { data: users } = await supabase
      .from('user_profiles')
      .select('id')
      .eq('is_active', true)
      .in('role', ['admin', 'warehouse']);

    if (!users) return;

    // Build a descriptive message listing the product names
    const productList = lowStockProducts.map(p => p.product_name).join(', ');
    const message = lowStockProducts.length === 1
      ? `${productList} is running low on stock.`
      : `${lowStockProducts.length} products low on stock: ${productList}.`;

    for (const user of users) {
      if (await dailyNotifExistsToday(user.id, 'low_stock')) continue;

      await createNotification({
        userId: user.id,
        type: 'low_stock',
        title: 'Low Stock Alert',
        message,
      });
    }
  } catch (error) {
    if (isNavigationAbort(error)) return;
    console.error('Error checking low stock:', error);
  }
}

export async function checkAndCreateExpiryNotifications() {
  try {
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

    const { data: users } = await supabase
      .from('user_profiles')
      .select('id')
      .eq('is_active', true)
      .in('role', ['admin', 'warehouse', 'sales']);

    if (!users) return;

    const message = `${nearExpiryBatches.length} batch(es) will expire within ${alertDays} days.`;

    for (const user of users) {
      if (await dailyNotifExistsToday(user.id, 'near_expiry')) continue;

      await createNotification({
        userId: user.id,
        type: 'near_expiry',
        title: 'Products Near Expiry',
        message,
      });
    }
  } catch (error) {
    if (isNavigationAbort(error)) return;
    console.error('Error checking expiry dates:', error);
  }
}

export async function checkAndCreateFollowUpNotifications() {
  try {
    const today = new Date().toISOString().split('T')[0];

    const { data: dueActivities } = await supabase
      .from('crm_activities')
      .select('id, customer_id, activity_type, crm_contacts(company_name)')
      .eq('is_completed', false)
      .not('follow_up_date', 'is', null)
      .lte('follow_up_date', today);

    if (!dueActivities || dueActivities.length === 0) return;

    const { data: users } = await supabase
      .from('user_profiles')
      .select('id')
      .eq('is_active', true)
      .in('role', ['admin', 'sales']);

    if (!users) return;

    const message = `You have ${dueActivities.length} follow-up(s) due today.`;

    for (const user of users) {
      // Skip if already sent any follow_up notification today (read or unread)
      if (await dailyNotifExistsToday(user.id, 'follow_up')) continue;

      await createNotification({
        userId: user.id,
        type: 'follow_up',
        title: 'Follow-ups Due',
        message,
      });
    }
  } catch (error) {
    if (isNavigationAbort(error)) return;
    console.error('Error checking follow-ups:', error);
  }
}

export async function checkAndCreateDeliveryDueNotifications() {
  try {
    const alerts = await fetchSalesOrderDeliveryAlerts();
    if (alerts.length === 0) return;

    const { dueSoon, overdue } = summarizeDeliveryAlerts(alerts);
    const { data: users } = await supabase
      .from('user_profiles')
      .select('id, role')
      .eq('is_active', true)
      .in('role', ['sales', 'warehouse', 'admin', 'manager']);

    if (!users || users.length === 0) return;

    const parts = [
      overdue.length ? `${overdue.length} overdue` : '',
      dueSoon.length ? `${dueSoon.length} due soon` : '',
    ].filter(Boolean);
    const sample = alerts.slice(0, 3).map(alert => alert.soNumber).join(', ');
    const message = `${parts.join(', ')} sales order deliver${alerts.length === 1 ? 'y needs' : 'ies need'} attention${sample ? `: ${sample}` : ''}.`;

    for (const user of users) {
      if (await dailyNotifExistsToday(user.id, 'delivery_due')) continue;

      await createNotification({
        userId: user.id,
        type: 'delivery_due',
        title: overdue.length ? 'Delivery Overdue' : 'Delivery Due Soon',
        message,
      });
    }

    const { data: { user: currentUser } } = await supabase.auth.getUser();
    if (currentUser && users.some(user => user.id === currentUser.id)) {
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
  }
}

let notificationInterval: ReturnType<typeof setInterval> | null = null;

async function checkAndCreateTaxNotifications() {
  try {
    const { error } = await supabase.rpc('generate_tax_notifications');
    if (error) throw error;
  } catch (error) {
    if (isNavigationAbort(error)) return;
    console.error('Error generating tax notifications:', error);
  }
}

export async function initializeNotificationChecks() {
  if (notificationInterval) {
    clearInterval(notificationInterval);
  }

  await checkAndCreateLowStockNotifications();
  await checkAndCreateExpiryNotifications();
  await checkAndCreateFollowUpNotifications();
  await checkAndCreateDeliveryDueNotifications();
  await checkAndCreateTaxNotifications();

  notificationInterval = setInterval(async () => {
    await checkAndCreateLowStockNotifications();
    await checkAndCreateExpiryNotifications();
    await checkAndCreateFollowUpNotifications();
    await checkAndCreateDeliveryDueNotifications();
    await checkAndCreateTaxNotifications();
  }, 600000);
}
