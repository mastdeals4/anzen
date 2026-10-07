import { supabase } from '../lib/supabase';

/**
 * Central workflow email sender for the pricing flow.
 *
 * Sender resolution is entirely server-side now:
 *   - The Edge Function (send-bulk-email) verifies the caller's JWT and uses
 *     the authenticated user's Gmail connection if present.
 *   - If we pass `allowFallback: true`, and the auth user has no connection,
 *     the Edge Function resolves an admin/configured fallback connection.
 *
 * The frontend never reads Gmail tokens, and never picks the fallback sender.
 */

export type PricingWorkflowType =
  | 'sourcing_request'
  | 'sourcing_reminder'
  | 'customer_quote'
  | 'payment_reminder'; // accounts/Synthia — future use

export interface PricingEmailAttachment {
  /** Signed https URL on the Supabase host (required — edge drops url-less payloads). */
  url: string;
  storagePath?: string;
  filename?: string;
  mimeType?: string;
}

export interface PricingEmailRequest {
  workflowType: PricingWorkflowType;
  priceRequestId?: string | null;
  itemIds?: string[];
  sourceType?: 'india' | 'china' | null;
  to: string[];
  cc?: string[];
  bcc?: string[];
  replyTo?: string;
  subject: string;
  body: string;
  isHtml?: boolean;
  senderName?: string;
  /** Storage-path attachments (e.g. COA/MSDS from crm-documents) to attach. */
  attachmentUrls?: PricingEmailAttachment[];
  /** When true, write a row in email_thread_map for the sent message. Default: true. */
  recordThread?: boolean;
  requiredSenderEmail?: string;
  module?: 'crm' | 'pricing';
}

export interface PricingEmailResult {
  success: boolean;
  messageId: string | null;
  threadId: string | null;
  emailThreadMapId: string | null;
  senderMode: 'connected_gmail' | 'fallback' | null;
  senderEmail: string | null;
  error?: string;
  reauthRequired?: boolean;
}

export async function sendPricingWorkflowEmail(req: PricingEmailRequest): Promise<PricingEmailResult> {
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) {
    return {
      success: false,
      messageId: null, threadId: null, emailThreadMapId: null,
      senderMode: null, senderEmail: null, error: 'Not signed in',
    };
  }

  const supabaseUrl = import.meta.env.VITE_SUPABASE_URL;
  const { data: session } = await supabase.auth.getSession();
  if (!session.session) {
    return {
      success: false,
      messageId: null, threadId: null, emailThreadMapId: null,
      senderMode: null, senderEmail: null, error: 'No active session',
    };
  }

  const isCrm = req.module === 'crm' || req.workflowType === 'customer_quote';
  const targetSender = req.requiredSenderEmail || (isCrm ? 'sales@avira.co.id' : 'kunal@avira.co.id');
  const targetWorkflow =
    req.module === 'crm'
      ? 'crm_sourcing'
      : req.workflowType === 'customer_quote'
        ? 'customer_quote'
        : req.workflowType === 'sourcing_reminder'
          ? 'pricing_reminder'
          : req.workflowType === 'sourcing_request'
            ? 'pricing_sourcing'
            : 'pricing_sourcing';

  let resp: Response;
  try {
    resp = await fetch(`${supabaseUrl}/functions/v1/send-bulk-email`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${session.session.access_token}` },
      body: JSON.stringify({
        allowFallback: true,
        workflowType: targetWorkflow,
        requiredSenderEmail: targetSender,
        module: isCrm ? 'crm' : 'pricing',
        toEmails: req.to,
        cc: req.cc || [],
        bcc: req.bcc || [],
        replyTo: req.replyTo,
        subject: req.subject,
        body: req.body,
        senderName: req.senderName || '',
        isHtml: req.isHtml ?? true,
        attachmentUrls: (req.attachmentUrls || []).map(a => ({
          url: a.url,
          storagePath: a.storagePath,
          filename: a.filename,
          mimeType: a.mimeType,
        })),
      }),
    });
  } catch (err: unknown) {
    return {
      success: false, messageId: null, threadId: null, emailThreadMapId: null,
      senderMode: null, senderEmail: null,
      error: err instanceof Error ? err.message : 'Network error',
    };
  }

  let result: any = {};
  try { result = await resp.json(); } catch { /* fall through */ }

  if (!resp.ok || !result.success) {
    return {
      success: false,
      messageId: null, threadId: null, emailThreadMapId: null,
      senderMode: null, senderEmail: null,
      error: result.error || `HTTP ${resp.status}`,
      reauthRequired: !!result.reauthRequired,
    };
  }

  const messageId: string | null = result.messageId || null;
  const threadId: string | null = result.threadId || null;
  const senderMode: 'connected_gmail' | 'fallback' = result.senderMode === 'fallback' ? 'fallback' : 'connected_gmail';
  const senderEmail: string | null = result.senderEmail || null;

  // Record in email_thread_map (best-effort)
  let emailThreadMapId: string | null = null;
  if (req.recordThread !== false && req.priceRequestId) {
    const direction =
      req.workflowType === 'customer_quote'
        ? 'outbound_customer'
        : req.workflowType === 'sourcing_reminder'
          ? 'outbound_reminder'
          : 'outbound';
    try {
      const { data } = await supabase
        .from('email_thread_map')
        .insert({
          price_request_id: req.priceRequestId,
          item_ids: req.itemIds || null,
          source_type: req.sourceType || null,
          direction,
          subject: req.subject,
          sent_at: new Date().toISOString(),
          created_by: user.id,
          gmail_message_id: messageId,
          gmail_thread_id: threadId,
        })
        .select('id')
        .maybeSingle();
      emailThreadMapId = data?.id || null;
    } catch {
      // non-critical
    }
  }

  return {
    success: true,
    messageId,
    threadId,
    emailThreadMapId,
    senderMode,
    senderEmail,
  };
}

/** True iff the given user or email has an active connected Gmail. */
export async function userHasConnectedGmail(userIdOrEmail: string): Promise<boolean> {
  const query = supabase
    .from('gmail_connections')
    .select('id')
    .eq('is_connected', true);

  if (userIdOrEmail.includes('@')) {
    query.ilike('email_address', userIdOrEmail.trim());
  } else {
    query.eq('user_id', userIdOrEmail);
  }

  const { data } = await query.limit(1).maybeSingle();
  return !!data;
}
