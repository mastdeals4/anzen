import { supabase } from '../lib/supabase';
import type { Inquiry } from '../types/commandCenter';

export interface QuickActionResult {
  success: boolean;
  error?: string;
  reminderId?: string;
}

export async function performQuickAction(
  inquiryId: string,
  actionType: string,
  actionLabel: string,
  userId: string,
  additionalData?: {
    emailSubject?: string;
    emailBody?: string;
    emailTo?: string;
    templateId?: string;
    notes?: string;
  }
): Promise<QuickActionResult> {
  try {
    const { data: inquiry, error: inquiryError } = await supabase
      .from('crm_inquiries')
      .select('*')
      .eq('id', inquiryId)
      .single();

    if (inquiryError) throw inquiryError;

    let newStatus = inquiry.status;
    let statusUpdated = false;
    const updateFields: any = {};

    switch (actionType) {
      case 'send_price':
        updateFields.price_quoted = true;
        updateFields.price_quoted_date = new Date().toISOString().split('T')[0];
        newStatus = 'price_quoted';
        statusUpdated = true;
        break;
      case 'send_coa':
        updateFields.coa_sent = true;
        updateFields.coa_sent_date = new Date().toISOString().split('T')[0];
        if (inquiry.price_quoted && inquiry.coa_sent) {
          newStatus = 'negotiation';
          statusUpdated = true;
        }
        break;
      case 'send_msds':
        updateFields.msds_sent = true;
        updateFields.msds_sent_date = new Date().toISOString().split('T')[0];
        break;
      case 'send_sample':
        updateFields.sample_sent = true;
        updateFields.sample_sent_date = new Date().toISOString().split('T')[0];
        newStatus = 'sample_sent';
        statusUpdated = true;
        break;
    }

    if (statusUpdated) {
      updateFields.status = newStatus;
    }

    if (Object.keys(updateFields).length > 0) {
      const { error: updateError } = await supabase
        .from('crm_inquiries')
        .update(updateFields)
        .eq('id', inquiryId);

      if (updateError) throw updateError;
    }

    let reminderId: string | undefined;
    const { data: reminderData } = await supabase.rpc('auto_create_followup', {
      p_inquiry_id: inquiryId,
      p_action_type: actionType,
      p_user_id: userId,
    });

    if (reminderData) {
      reminderId = reminderData;
    }

    const { error: logError } = await supabase
      .from('crm_quick_actions_log')
      .insert({
        inquiry_id: inquiryId,
        action_type: actionType,
        action_label: actionLabel,
        email_sent: !!additionalData?.emailTo,
        email_to: additionalData?.emailTo || null,
        email_subject: additionalData?.emailSubject || null,
        email_body: additionalData?.emailBody || null,
        template_used: additionalData?.templateId || null,
        old_status: inquiry.status,
        new_status: newStatus,
        status_updated: statusUpdated,
        follow_up_created: !!reminderId,
        follow_up_reminder_id: reminderId || null,
        notes: additionalData?.notes || null,
        performed_by: userId,
      });

    if (logError) throw logError;

    if (additionalData?.emailTo && additionalData?.emailSubject && additionalData?.emailBody) {
      const { error: emailError } = await supabase
        .from('crm_email_activities')
        .insert({
          inquiry_id: inquiryId,
          email_type: 'sent',
          from_email: (await supabase.auth.getUser()).data.user?.email,
          to_email: [additionalData.emailTo],
          subject: additionalData.emailSubject,
          body: additionalData.emailBody,
          template_id: additionalData.templateId || null,
          sent_date: new Date().toISOString(),
          created_by: userId,
        });

      if (emailError) console.error('Error logging email:', emailError);
    }

    return {
      success: true,
      reminderId,
    };
  } catch (error) {
    console.error('Error performing quick action:', error);
    return {
      success: false,
      error: error instanceof Error ? error.message : 'Unknown error',
    };
  }
}

export async function logActivity(
  inquiryId: string,
  activityType: 'phone_call' | 'meeting' | 'whatsapp' | 'note',
  title: string,
  outcome: string,
  userId: string,
  description?: string
): Promise<QuickActionResult> {
  try {
    let nextFollowUpDate: Date | null = null;
    let followUpReason = '';

    switch (outcome) {
      case 'customer_will_revert':
        nextFollowUpDate = new Date();
        nextFollowUpDate.setDate(nextFollowUpDate.getDate() + 2);
        followUpReason = 'Customer will revert';
        break;
      case 'could_not_reach':
        nextFollowUpDate = new Date();
        nextFollowUpDate.setDate(nextFollowUpDate.getDate() + 1);
        followUpReason = 'Try calling again';
        break;
      case 'discussed_price':
      case 'discussed_coa':
      case 'discussed_sample':
        nextFollowUpDate = new Date();
        nextFollowUpDate.setDate(nextFollowUpDate.getDate() + 3);
        followUpReason = 'Follow up on discussion';
        break;
      case 'positive':
        nextFollowUpDate = new Date();
        nextFollowUpDate.setDate(nextFollowUpDate.getDate() + 2);
        followUpReason = 'Positive response - follow up';
        break;
      case 'negative':
        nextFollowUpDate = new Date();
        nextFollowUpDate.setDate(nextFollowUpDate.getDate() + 7);
        followUpReason = 'Negative response - check back later';
        break;
    }

    const { error: activityError } = await supabase
      .from('crm_activity_logs')
      .insert({
        inquiry_id: inquiryId,
        activity_type: activityType,
        activity_title: title,
        activity_description: description || null,
        outcome: outcome,
        next_follow_up_date: nextFollowUpDate ? nextFollowUpDate.toISOString() : null,
        follow_up_reason: followUpReason,
        created_by: userId,
      });

    if (activityError) throw activityError;

    if (nextFollowUpDate) {
      await supabase
        .from('crm_inquiries')
        .update({
          next_follow_up: nextFollowUpDate.toISOString(),
          last_contact_date: new Date().toISOString(),
        })
        .eq('id', inquiryId);
    }

    let reminderId: string | undefined;
    if (nextFollowUpDate) {
      const { data: reminderData, error: reminderError } = await supabase
        .from('crm_reminders')
        .insert({
          inquiry_id: inquiryId,
          reminder_type: 'follow_up',
          title: followUpReason,
          due_date: nextFollowUpDate.toISOString(),
          assigned_to: userId,
          created_by: userId,
        })
        .select('id')
        .single();

      if (!reminderError && reminderData) {
        reminderId = reminderData.id;
      }
    }

    return {
      success: true,
      reminderId,
    };
  } catch (error) {
    console.error('Error logging activity:', error);
    return {
      success: false,
      error: error instanceof Error ? error.message : 'Unknown error',
    };
  }
}
