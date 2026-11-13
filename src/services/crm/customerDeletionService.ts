import { supabase } from '../../lib/supabase';

export interface CustomerDependencyCounts {
  inquiries: number;
  enquiryRequests: number;
  emails: number;
  activities: number;
  crmActivities: number;
  quickActions: number;
  domainMappings: number;
  bulkEmails: number;
  whatsappRecipients: number;
  customerAssignments: number;
  contactPhones: number;
  salesOrders: number;
  salesInvoices: number;
  deliveryChallans: number;
}

export interface CustomerDependencyReport {
  contactId: string;
  companyName: string;
  hasDependencies: boolean;
  totalCount: number;
  counts: CustomerDependencyCounts;
  summaryList: string[];
}

/**
 * Checks all historical records referencing a CRM contact.
 * Uses exact head count queries so no unnecessary payload is downloaded.
 */
export async function checkCustomerDependencies(
  contactId: string,
  companyName?: string
): Promise<CustomerDependencyReport> {
  const [
    inquiriesRes,
    enquiryRequestsRes,
    emailsRes,
    activitiesRes,
    crmActivitiesRes,
    quickActionsRes,
    domainMappingsRes,
    bulkEmailsRes,
    whatsappRes,
    assignmentsRes,
    phonesRes,
  ] = await Promise.all([
    supabase.from('crm_inquiries').select('id', { count: 'exact', head: true }).eq('crm_contact_id', contactId),
    supabase.from('enquiry_requests').select('id', { count: 'exact', head: true }).eq('crm_contact_id', contactId),
    supabase.from('crm_email_activities').select('id', { count: 'exact', head: true }).eq('contact_id', contactId),
    supabase.from('crm_activity_logs').select('id', { count: 'exact', head: true }).eq('contact_id', contactId),
    supabase.from('crm_activities').select('id', { count: 'exact', head: true }).eq('customer_id', contactId),
    supabase.from('crm_quick_actions_log').select('id', { count: 'exact', head: true }).eq('contact_id', contactId),
    supabase.from('crm_company_domain_mapping').select('id', { count: 'exact', head: true }).eq('primary_contact_id', contactId),
    supabase.from('bulk_email_recipients').select('id', { count: 'exact', head: true }).eq('contact_id', contactId),
    supabase.from('whatsapp_campaign_recipients').select('id', { count: 'exact', head: true }).eq('contact_id', contactId),
    supabase.from('customer_assignments').select('id', { count: 'exact', head: true }).eq('crm_contact_id', contactId),
    supabase.from('crm_contact_phones').select('id', { count: 'exact', head: true }).eq('contact_id', contactId),
  ]);

  let salesOrdersCount = 0;
  let salesInvoicesCount = 0;
  let deliveryChallansCount = 0;

  if (companyName && companyName.trim()) {
    try {
      const { data: erpCust } = await supabase
        .from('customers')
        .select('id')
        .ilike('company_name', companyName.trim())
        .maybeSingle();

      if (erpCust?.id) {
        const [ordersRes, invoicesRes, challansRes] = await Promise.all([
          supabase.from('sales_orders').select('id', { count: 'exact', head: true }).eq('customer_id', erpCust.id),
          supabase.from('sales_invoices').select('id', { count: 'exact', head: true }).eq('customer_id', erpCust.id),
          supabase.from('delivery_challans').select('id', { count: 'exact', head: true }).eq('customer_id', erpCust.id),
        ]);
        salesOrdersCount = ordersRes.count || 0;
        salesInvoicesCount = invoicesRes.count || 0;
        deliveryChallansCount = challansRes.count || 0;
      }
    } catch {
      // Ignore non-fatal ERP customer lookup error
    }
  }

  const counts: CustomerDependencyCounts = {
    inquiries: inquiriesRes.count || 0,
    enquiryRequests: enquiryRequestsRes.count || 0,
    emails: emailsRes.count || 0,
    activities: activitiesRes.count || 0,
    crmActivities: crmActivitiesRes.count || 0,
    quickActions: quickActionsRes.count || 0,
    domainMappings: domainMappingsRes.count || 0,
    bulkEmails: bulkEmailsRes.count || 0,
    whatsappRecipients: whatsappRes.count || 0,
    customerAssignments: assignmentsRes.count || 0,
    contactPhones: phonesRes.count || 0,
    salesOrders: salesOrdersCount,
    salesInvoices: salesInvoicesCount,
    deliveryChallans: deliveryChallansCount,
  };

  const summaryList: string[] = [];
  if (counts.inquiries > 0) summaryList.push(`${counts.inquiries} inquiry/inquiries`);
  if (counts.enquiryRequests > 0) summaryList.push(`${counts.enquiryRequests} sourcing/enquiry request(s)`);
  if (counts.emails > 0) summaryList.push(`${counts.emails} direct email communication(s)`);
  if (counts.activities > 0) summaryList.push(`${counts.activities} CRM activity log(s)`);
  if (counts.crmActivities > 0) summaryList.push(`${counts.crmActivities} CRM task/activity item(s)`);
  if (counts.quickActions > 0) summaryList.push(`${counts.quickActions} quick action log(s)`);
  if (counts.domainMappings > 0) summaryList.push(`${counts.domainMappings} company domain mapping(s)`);
  if (counts.bulkEmails > 0) summaryList.push(`${counts.bulkEmails} campaign email delivery record(s)`);
  if (counts.whatsappRecipients > 0) summaryList.push(`${counts.whatsappRecipients} WhatsApp campaign log(s)`);
  if (counts.customerAssignments > 0) summaryList.push(`${counts.customerAssignments} sales representative assignment(s)`);
  if (counts.contactPhones > 0) summaryList.push(`${counts.contactPhones} registered phone/WhatsApp number(s)`);
  if (counts.salesOrders > 0) summaryList.push(`${counts.salesOrders} Sales Order(s)`);
  if (counts.salesInvoices > 0) summaryList.push(`${counts.salesInvoices} Sales Invoice(s)`);
  if (counts.deliveryChallans > 0) summaryList.push(`${counts.deliveryChallans} Delivery Challan(s)`);

  // Notice: contact phones and customer assignments alone on a customer without history
  // can be safely cascaded on permanent delete IF there are no genuine business transactions or communications.
  // Genuine history: inquiries, enquiryRequests, emails, activities, crmActivities, quickActions, bulkEmails, whatsappRecipients, salesOrders, salesInvoices, deliveryChallans
  const genuineHistoryCount =
    counts.inquiries +
    counts.enquiryRequests +
    counts.emails +
    counts.activities +
    counts.crmActivities +
    counts.quickActions +
    counts.domainMappings +
    counts.bulkEmails +
    counts.whatsappRecipients +
    counts.salesOrders +
    counts.salesInvoices +
    counts.deliveryChallans;

  return {
    contactId,
    companyName: companyName || 'Customer',
    hasDependencies: genuineHistoryCount > 0,
    totalCount: genuineHistoryCount,
    counts,
    summaryList,
  };
}

/**
 * Soft deletes / archives a customer record while preserving all historical data and audit fields.
 */
export async function archiveCustomer(
  contactId: string,
  actorId?: string | null
): Promise<{ success: boolean; error?: string }> {
  try {
    const updatePayload: Record<string, any> = {
      is_active: false,
      updated_at: new Date().toISOString(),
    };
    if (actorId) {
      updatePayload.updated_by = actorId;
    }

    const { error } = await supabase
      .from('crm_contacts')
      .update(updatePayload)
      .eq('id', contactId);

    if (error) throw error;
    return { success: true };
  } catch (err: any) {
    return { success: false, error: err.message || 'Failed to archive customer' };
  }
}

/**
 * Restores an archived customer back to active status.
 */
export async function restoreCustomer(
  contactId: string,
  actorId?: string | null
): Promise<{ success: boolean; error?: string }> {
  try {
    const updatePayload: Record<string, any> = {
      is_active: true,
      updated_at: new Date().toISOString(),
    };
    if (actorId) {
      updatePayload.updated_by = actorId;
    }

    const { error } = await supabase
      .from('crm_contacts')
      .update(updatePayload)
      .eq('id', contactId);

    if (error) throw error;
    return { success: true };
  } catch (err: any) {
    return { success: false, error: err.message || 'Failed to restore customer' };
  }
}

/**
 * Batch archives multiple customer records.
 */
export async function batchArchiveCustomers(
  contactIds: string[],
  actorId?: string | null
): Promise<{ success: boolean; count: number; error?: string }> {
  if (contactIds.length === 0) return { success: true, count: 0 };
  try {
    const updatePayload: Record<string, any> = {
      is_active: false,
      updated_at: new Date().toISOString(),
    };
    if (actorId) {
      updatePayload.updated_by = actorId;
    }

    const { error } = await supabase
      .from('crm_contacts')
      .update(updatePayload)
      .in('id', contactIds);

    if (error) throw error;
    return { success: true, count: contactIds.length };
  } catch (err: any) {
    return { success: false, count: 0, error: err.message || 'Failed to archive customers' };
  }
}

/**
 * Permanently deletes a customer record ONLY if it has zero dependent records.
 */
export async function deleteCustomerPermanent(
  contactId: string,
  companyName?: string
): Promise<{ success: boolean; error?: string; blockedByDependencies?: boolean; dependencyReport?: CustomerDependencyReport }> {
  // 1. Dependency check
  const report = await checkCustomerDependencies(contactId, companyName);
  if (report.hasDependencies) {
    return {
      success: false,
      blockedByDependencies: true,
      dependencyReport: report,
      error: `Cannot permanently delete ${report.companyName} because it is referenced by: ${report.summaryList.join(', ')}. Please Archive this customer instead to protect historical records.`,
    };
  }

  // 2. Safe permanent deletion
  try {
    // Delete any phone entries first (handled by CASCADE in Postgres, but clean in API)
    await supabase.from('crm_contact_phones').delete().eq('contact_id', contactId);

    const { error } = await supabase
      .from('crm_contacts')
      .delete()
      .eq('id', contactId);

    if (error) throw error;
    return { success: true };
  } catch (err: any) {
    return {
      success: false,
      error: err.message || 'Failed to permanently delete customer record',
    };
  }
}

/**
 * Evaluates multiple customers before deletion and categorizes them into:
 * - Can delete permanently (0 dependencies)
 * - Must archive (>0 dependencies)
 */
export async function batchEvaluateCustomersForDeletion(
  targets: Array<{ id: string; company_name: string }>
): Promise<{
  safeToDelete: Array<{ id: string; company_name: string }>;
  mustArchive: Array<{ id: string; company_name: string; report: CustomerDependencyReport }>;
}> {
  const reports = await Promise.all(
    targets.map(t => checkCustomerDependencies(t.id, t.company_name))
  );

  const safeToDelete: Array<{ id: string; company_name: string }> = [];
  const mustArchive: Array<{ id: string; company_name: string; report: CustomerDependencyReport }> = [];

  reports.forEach((rep, idx) => {
    const cust = targets[idx];
    if (rep.hasDependencies) {
      mustArchive.push({ ...cust, report: rep });
    } else {
      safeToDelete.push(cust);
    }
  });

  return { safeToDelete, mustArchive };
}

