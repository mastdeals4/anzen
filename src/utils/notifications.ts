import { supabase } from '../lib/supabase';

interface NotificationParams {
  userId: string;
  type: 'low_stock' | 'near_expiry' | 'pending_invoice' | 'follow_up';
  title: string;
  message: string;
  referenceId?: string;
  referenceType?: string;
}

export async function createNotification(params: NotificationParams) {
  try {
    const { error } = await supabase
      .from('notifications')
      .insert([{
        user_id: params.userId,
        type: params.type,
        title: params.title,
        message: params.message,
        reference_id: params.referenceId || null,
        reference_type: params.referenceType || null,
        is_read: false,
      }]);

    if (error) throw error;
  } catch (error) {
    console.error('Error creating notification:', error);
  }
}

export async function checkAndCreateLowStockNotifications() {
  try {
    const { data: settings } = await supabase
      .from('app_settings')
      .select('low_stock_threshold')
      .maybeSingle();

    const lowStockThreshold = settings?.low_stock_threshold || 100;

    const { data: lowStockBatches } = await supabase
      .from('batches')
      .select('id, batch_number, current_stock, products(product_name)')
      .eq('is_active', true)
      .lt('current_stock', lowStockThreshold);

    if (lowStockBatches && lowStockBatches.length > 0) {
      const { data: users } = await supabase
        .from('user_profiles')
        .select('id')
        .eq('is_active', true)
        .in('role', ['admin', 'warehouse']);

      if (users) {
        for (const user of users) {
          const existingNotifications = await supabase
            .from('notifications')
            .select('id')
            .eq('user_id', user.id)
            .eq('type', 'low_stock')
            .eq('is_read', false)
            .limit(1);

          if (!existingNotifications.data?.length) {
            await createNotification({
              userId: user.id,
              type: 'low_stock',
              title: 'Low Stock Alert',
              message: `${lowStockBatches.length} batch(es) are running low on stock.`,
            });
          }
        }
      }
    }
  } catch (error) {
    console.error('Error checking low stock:', error);
  }
}

export async function checkAndCreateExpiryNotifications() {
  try {
    const { data: settings } = await supabase
      .from('app_settings')
      .select('expiry_alert_days')
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

    if (nearExpiryBatches && nearExpiryBatches.length > 0) {
      const { data: users } = await supabase
        .from('user_profiles')
        .select('id')
        .eq('is_active', true)
        .in('role', ['admin', 'warehouse', 'sales']);

      if (users) {
        for (const user of users) {
          const existingNotifications = await supabase
            .from('notifications')
            .select('id')
            .eq('user_id', user.id)
            .eq('type', 'near_expiry')
            .eq('is_read', false)
            .limit(1);

          if (!existingNotifications.data?.length) {
            await createNotification({
              userId: user.id,
              type: 'near_expiry',
              title: 'Products Near Expiry',
              message: `${nearExpiryBatches.length} batch(es) will expire within ${alertDays} days.`,
            });
          }
        }
      }
    }
  } catch (error) {
    console.error('Error checking expiry dates:', error);
  }
}

export async function checkAndCreateFollowUpNotifications() {
  try {
    const today = new Date().toISOString().split('T')[0];

    const { data: dueActivities } = await supabase
      .from('crm_activities')
      .select('id, customer_id, activity_type, customers(company_name)')
      .eq('is_completed', false)
      .not('follow_up_date', 'is', null)
      .lte('follow_up_date', today);

    if (dueActivities && dueActivities.length > 0) {
      const { data: users } = await supabase
        .from('user_profiles')
        .select('id')
        .eq('is_active', true)
        .in('role', ['admin', 'sales']);

      if (users) {
        for (const user of users) {
          await createNotification({
            userId: user.id,
            type: 'follow_up',
            title: 'Follow-ups Due',
            message: `You have ${dueActivities.length} follow-up(s) due today.`,
          });
        }
      }
    }
  } catch (error) {
    console.error('Error checking follow-ups:', error);
  }
}

export async function initializeNotificationChecks() {
  await checkAndCreateLowStockNotifications();
  await checkAndCreateExpiryNotifications();
  await checkAndCreateFollowUpNotifications();

  setInterval(async () => {
    await checkAndCreateLowStockNotifications();
    await checkAndCreateExpiryNotifications();
    await checkAndCreateFollowUpNotifications();
  }, 300000);
}
