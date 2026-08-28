import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "npm:@supabase/supabase-js@2.57.4";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type, Authorization, X-Client-Info, Apikey, X-Bulk-Email-Worker-Secret",
};

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

function parseEmails(raw: string | null | undefined): string[] {
  const seen = new Set<string>();
  const result: string[] = [];
  for (const token of String(raw || "").split(/[,;\s\r\n]+/)) {
    const email = token.trim();
    if (email && EMAIL_RE.test(email) && !seen.has(email)) {
      seen.add(email);
      result.push(email);
    }
  }
  return result;
}

function applyVariables(value: string, contact: Record<string, unknown>): string {
  const companyName = String(contact.company_name || "");
  const contactPerson = String(contact.contact_person || "").trim() || "Sir/Madam";
  const salutation = `Dear ${contactPerson},`;

  return value
    .replace(/\{\{company_name\}\}/gi, companyName)
    .replace(/\{\{contact_person\}\}/gi, contactPerson)
    .replace(/\{\{customer_name\}\}/gi, contactPerson)
    .replace(/\{\{salutation\}\}/gi, salutation);
}

function classifyError(status: number, result: any): string {
  const text = `${result?.code || ""} ${result?.error || ""}`.toLowerCase();
  if (status === 401 || text.includes("jwt") || text.includes("session")) return "SUPABASE_AUTH_ERROR";
  if (status === 429 || text.includes("rate")) return "RATE_LIMITED";
  if (text.includes("invalid") && text.includes("email")) return "INVALID_EMAIL";
  if (text.includes("gmail api")) return "GMAIL_API_ERROR";
  if (text.includes("worker_resource_limit")) return "WORKER_RESOURCE_LIMIT";
  if (text.includes("network")) return "NETWORK_ERROR";
  return result?.code || "SEND_FAILED";
}

async function refreshCounts(supabase: any, campaignId: string) {
  const { data } = await supabase.rpc("refresh_bulk_email_campaign_counts", { p_campaign_id: campaignId });
  return Array.isArray(data) ? data[0] : null;
}

async function loadDueCampaignIds(supabase: any): Promise<string[]> {
  const { data } = await supabase
    .from("bulk_email_campaigns")
    .select("id")
    .eq("status", "in_progress")
    .lte("next_run_at", new Date().toISOString())
    .order("next_run_at", { ascending: true })
    .limit(5);
  return (data || []).map((row: { id: string }) => row.id);
}

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") {
    return new Response(null, { status: 200, headers: corsHeaders });
  }

  const executionId = crypto.randomUUID();
  const supabaseUrl = Deno.env.get("SUPABASE_URL")!;
  const serviceKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
  const workerSecret = Deno.env.get("BULK_EMAIL_WORKER_SECRET") || "";
  const supabase = createClient(supabaseUrl, serviceKey);

  try {
    const authHeader = req.headers.get("Authorization") || "";
    const jwt = authHeader.startsWith("Bearer ") ? authHeader.slice(7) : "";
    const suppliedWorkerSecret = req.headers.get("X-Bulk-Email-Worker-Secret") || "";
    const { data: settings } = await supabase
      .from("app_settings")
      .select("bulk_email_worker_secret")
      .limit(1)
      .maybeSingle();
    const storedWorkerSecret = settings?.bulk_email_worker_secret || "";
    const isInternal = Boolean(workerSecret)
      && Boolean(storedWorkerSecret)
      && suppliedWorkerSecret === workerSecret
      && suppliedWorkerSecret === storedWorkerSecret;

    const body = await req.json().catch(() => ({}));
    const requestedCampaignId = String(body?.campaignId || "");
    let authUserId = "";

    if (!isInternal) {
      if (!jwt) {
        return new Response(JSON.stringify({ success: false, error: "Missing Authorization header" }), {
          status: 401,
          headers: { ...corsHeaders, "Content-Type": "application/json" },
        });
      }
      const userClient = createClient(supabaseUrl, Deno.env.get("SUPABASE_ANON_KEY")!, {
        global: { headers: { Authorization: `Bearer ${jwt}` } },
      });
      const { data: authData, error: authError } = await userClient.auth.getUser();
      if (authError || !authData?.user) {
        return new Response(JSON.stringify({ success: false, error: "Invalid or expired session" }), {
          status: 401,
          headers: { ...corsHeaders, "Content-Type": "application/json" },
        });
      }
      authUserId = authData.user.id;
    }

    const campaignIds = requestedCampaignId ? [requestedCampaignId] : await loadDueCampaignIds(supabase);
    if (campaignIds.length === 0) {
      return new Response(JSON.stringify({ success: true, processed: 0, dueCampaigns: 0 }), {
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    const totals = [];
    let hasPendingWork = false;
    let nextRunDelaySecs = 30;
    for (const campaignId of campaignIds) {
    if (!isInternal && !requestedCampaignId) {
      return new Response(JSON.stringify({ success: false, error: "Worker secret is required to process due campaigns" }), {
        status: 403,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    const { data: campaign, error: campaignError } = await supabase.rpc("claim_bulk_email_campaign", {
      p_campaign_id: campaignId,
      p_execution_id: executionId,
      p_lock_seconds: 120,
      p_owner_id: isInternal ? null : authUserId,
    });
    if (campaignError) throw new Error(campaignError.message);
    if (!campaign) {
      totals.push({ campaignId, lockedOrNotDue: true, processed: 0 });
      continue;
    }
    if (campaign.status === "completed") {
      totals.push({ campaignId, done: true, processed: 0 });
      continue;
    }
    if (!campaign.email_body) throw new Error("Campaign email body is missing");

    const batchSize = Math.max(1, Math.min(Number(campaign.processing_batch_size || 10), 25));
    const delaySeconds = Math.max(0, Number(campaign.processing_delay_seconds || 30));
    const { data: claimedRows, error: claimError } = await supabase.rpc("claim_bulk_email_recipients", {
      p_campaign_id: campaignId,
      p_limit: batchSize,
      p_execution_id: executionId,
    });
    if (claimError) throw new Error(claimError.message);

    const recipients = claimedRows || [];
    let processed = 0;
    for (const row of recipients) {
      const contact = {
        company_name: row.company_name || "",
        contact_person: null,
        email: row.email,
      };
      if (row.contact_id) {
        const { data: contactRow } = await supabase
          .from("crm_contacts")
          .select("company_name, contact_person, email")
          .eq("id", row.contact_id)
          .maybeSingle();
        if (contactRow) {
          contact.company_name = contactRow.company_name || contact.company_name;
          contact.contact_person = contactRow.contact_person || null;
          contact.email = contactRow.email || contact.email;
        }
      }

      const subject = applyVariables(campaign.subject, contact);
      const htmlBody = applyVariables(campaign.email_body, contact);
      const toEmails = parseEmails(row.email || contact.email);
      let status = 500;
      let result: any = null;

      try {
        // 30-second timeout per recipient — prevents one slow send from blocking the whole batch
        const sendController = new AbortController();
        const sendTimer = setTimeout(() => sendController.abort(), 30_000);
        let response: Response;
        try {
          response = await fetch(`${supabaseUrl}/functions/v1/send-bulk-email`, {
            method: "POST",
            headers: {
              "Content-Type": "application/json",
              Authorization: `Bearer ${serviceKey}`,
              "X-Bulk-Email-Worker-Secret": workerSecret,
            },
            body: JSON.stringify({
              userId: campaign.created_by,
              toEmails,
              subject,
              body: htmlBody,
              contactId: row.contact_id,
              senderName: campaign.sender_name || "",
              isHtml: true,
              attachmentUrls: campaign.attachments_context || [],
              workflowType: "crm_bulk_email",
            }),
            signal: sendController.signal,
          });
        } finally {
          clearTimeout(sendTimer);
        }
        status = response.status;
        result = await response.json().catch(() => ({}));

        if (!response.ok || !result?.success) {
          const errorMessage = result?.error || `HTTP ${response.status}`;
          throw new Error(errorMessage);
        }

        await supabase.from("crm_email_activities").insert([{
          contact_id: row.contact_id,
          email_type: "sent",
          from_email: result.senderEmail || null,
          to_email: toEmails,
          subject,
          body: htmlBody,
          template_id: campaign.template_id || null,
          sent_date: new Date().toISOString(),
          created_by: campaign.created_by,
        }]);

        await supabase
          .from("bulk_email_recipients")
          .update({
            status: "sent",
            sent_at: new Date().toISOString(),
            completed_at: new Date().toISOString(),
            http_status: status,
            provider_response: result,
            error_code: null,
            error_message: null,
          })
          .eq("id", row.id);
      } catch (error: any) {
        await supabase
          .from("bulk_email_recipients")
          .update({
            status: "failed",
            completed_at: new Date().toISOString(),
            http_status: status,
            provider_response: result,
            error_code: classifyError(status, result),
            error_message: error?.message || result?.error || "Send failed",
          })
          .eq("id", row.id);
      }

      processed++;
    }

    const counts = await refreshCounts(supabase, campaignId);
    const pending = Number(counts?.pending_count || 0);
    const sending = Number(counts?.sending_count || 0);
    const sent = Number(counts?.sent_count || 0);
    const failed = Number(counts?.failed_count || 0);
    const done = pending === 0 && sending === 0;
    const finalStatus = done ? (failed === 0 ? "completed" : sent === 0 ? "failed" : "partial") : "in_progress";

    await supabase
      .from("bulk_email_campaigns")
      .update({
        status: finalStatus,
        next_run_at: done ? null : new Date(Date.now() + delaySeconds * 1000).toISOString(),
        worker_lock_until: null,
        worker_lock_id: null,
        worker_finished_at: new Date().toISOString(),
        completed_at: done ? new Date().toISOString() : null,
      })
      .eq("id", campaignId)
      .eq("worker_lock_id", executionId);

    if (!done) {
      hasPendingWork = true;
      nextRunDelaySecs = delaySeconds;
    }

    totals.push({ campaignId, processed, done, pending, sent, failed });
    }

    // Self-schedule: if any campaign still has pending recipients, fire the next
    // worker invocation after the configured delay. This makes the pipeline work
    // even when pg_cron is not installed or app_settings are not configured.
    // Cap the wait at 55 s so it stays within Edge Function wall-clock limits;
    // for longer delays the claim guard (next_run_at) prevents early processing.
    if (hasPendingWork && workerSecret) {
      const waitMs = Math.min(nextRunDelaySecs * 1000, 55_000);
      const nextUrl = `${supabaseUrl}/functions/v1/process-bulk-email-campaign`;
      const secret = workerSecret;
      EdgeRuntime.waitUntil(
        (async () => {
          if (waitMs > 0) await new Promise<void>(r => setTimeout(r, waitMs));
          await fetch(nextUrl, {
            method: "POST",
            headers: {
              "Content-Type": "application/json",
              "X-Bulk-Email-Worker-Secret": secret,
            },
            body: "{}",
          }).catch(() => {});
        })()
      );
    }

    return new Response(JSON.stringify({ success: true, campaigns: totals, executionId }), {
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  } catch (error: any) {
    console.error("[bulk-email-worker] failed", error);
    await supabase
      .from("bulk_email_campaigns")
      .update({
        worker_lock_until: null,
        worker_lock_id: null,
        worker_finished_at: new Date().toISOString(),
        last_worker_error: error?.message || "Worker failed",
      })
      .eq("worker_lock_id", executionId);
    return new Response(JSON.stringify({ success: false, error: error?.message || "Worker failed", executionId }), {
      status: 500,
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  }
});
