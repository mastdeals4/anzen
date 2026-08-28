import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "npm:@supabase/supabase-js@2.57.4";
import { getGmailConnectionSecret } from "../_shared/gmailSecrets.ts";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type, Authorization, X-Client-Info, Apikey, X-Bulk-Email-Worker-Secret",
};

interface OAuthClientCredentials {
  clientId?: string;
  clientSecret?: string;
}

interface GmailConnection {
  id: string;
  user_id: string;
  email_address: string;
  access_token: string;
  refresh_token: string;
  access_token_expires_at: string | null;
}

async function getValidAccessToken(
  supabase: any,
  connection: GmailConnection,
  oauthClientCredentials: OAuthClientCredentials
): Promise<string> {
  const tokenExpiry = new Date(connection.access_token_expires_at || 0);
  const bufferMs = 5 * 60 * 1000;

  if (!Number.isNaN(tokenExpiry.getTime()) && tokenExpiry.getTime() - bufferMs > Date.now()) {
    return connection.access_token;
  }

  const clientId = oauthClientCredentials.clientId
    || Deno.env.get("GOOGLE_CLIENT_ID")
    || Deno.env.get("GMAIL_CLIENT_ID")
    || "";
  const clientSecret = oauthClientCredentials.clientSecret
    || Deno.env.get("GOOGLE_CLIENT_SECRET")
    || Deno.env.get("GMAIL_CLIENT_SECRET")
    || "";

  if (!clientId || !clientSecret) {
    throw new Error("Missing Google OAuth client credentials for token refresh");
  }

  const refreshResponse = await fetch("https://oauth2.googleapis.com/token", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      client_id: clientId,
      client_secret: clientSecret,
      refresh_token: connection.refresh_token,
      grant_type: "refresh_token",
    }),
  });

  if (!refreshResponse.ok) {
    const errText = await refreshResponse.text();
    const refreshError = new Error(`Failed to refresh access token: ${errText}`);
    (refreshError as any).code = "TOKEN_REFRESH_FAILED";
    throw refreshError;
  }

  const refreshData = await refreshResponse.json();
  const newExpiry = new Date(Date.now() + refreshData.expires_in * 1000).toISOString();

  await supabase
    .from("gmail_connections")
    .update({
      access_token: refreshData.access_token,
      access_token_expires_at: newExpiry,
    })
    .eq("id", connection.id);

  return refreshData.access_token;
}

function encodeBase64Url(str: string): string {
  return btoa(str).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function decodeBase64Url(str: string): string {
  const base64 = str.replace(/-/g, "+").replace(/_/g, "/");
  const padded = base64.padEnd(base64.length + ((4 - base64.length % 4) % 4), "=");
  return decodeURIComponent(escape(atob(padded)));
}

function inspectEmailHtml(html: string): Record<string, boolean> {
  return ["table", "thead", "tbody", "tr", "td"].reduce((acc, tag) => {
    acc[tag] = new RegExp(`<${tag}(\\s|>|/)`, "i").test(html);
    return acc;
  }, {} as Record<string, boolean>);
}

function encodeMimeWord(str: string): string {
  return `=?utf-8?B?${btoa(unescape(encodeURIComponent(str)))}?=`;
}

interface Attachment {
  filename: string;
  mimeType: string;
  data: string; // base64
}

interface AttachmentUrlPayload {
  url: string;
  filename?: string;
  mimeType?: string;
  source?: string;
  documentId?: string;
  storagePath?: string;
}

function joinEmails(list: string[] | undefined | null): string {
  if (!list || list.length === 0) return "";
  return list.filter(e => typeof e === "string" && e.trim().length > 0).join(", ");
}

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

function parseEmailRecipients(raw: unknown): string[] {
  if (Array.isArray(raw)) {
    const seen = new Set<string>();
    return raw
      .flatMap(item => parseEmailRecipients(item))
      .filter(email => (seen.has(email) ? false : (seen.add(email), true)));
  }
  if (typeof raw !== "string") return [];
  return raw
    .split(/[,;\s\r\n]+/)
    .map(email => email.trim())
    .filter(email => EMAIL_RE.test(email));
}

function filenameFromDisposition(disposition: string | null): string | null {
  if (!disposition) return null;
  const utf8Match = disposition.match(/filename\*=UTF-8''([^;]+)/i);
  if (utf8Match?.[1]) return decodeURIComponent(utf8Match[1].replace(/"/g, ""));
  const plainMatch = disposition.match(/filename="?([^";]+)"?/i);
  return plainMatch?.[1] || null;
}

function filenameFromUrl(url: string): string {
  try {
    const parsed = new URL(url);
    return decodeURIComponent(parsed.pathname.split("/").pop() || "attachment");
  } catch {
    return "attachment";
  }
}

function base64FromBytes(bytes: Uint8Array): string {
  let binary = "";
  const chunkSize = 0x8000;
  for (let i = 0; i < bytes.length; i += chunkSize) {
    binary += String.fromCharCode(...bytes.subarray(i, i + chunkSize));
  }
  return btoa(binary);
}

async function downloadAttachment(payload: AttachmentUrlPayload): Promise<Attachment> {
  const supabaseHost = new URL(Deno.env.get('SUPABASE_URL')!).hostname;
  let parsedUrl: URL;
  try {
    parsedUrl = new URL(payload.url);
  } catch {
    throw new Error(`Invalid attachment URL: ${payload.url}`);
  }
  if (parsedUrl.protocol !== 'https:') {
    throw new Error(`Only https attachment URLs allowed`);
  }
  if (parsedUrl.hostname !== supabaseHost) {
    throw new Error(`Attachment host not allowlisted: ${parsedUrl.hostname}`);
  }

  const response = await fetch(payload.url);
  if (!response.ok) {
    throw new Error(`Failed to download attachment ${payload.filename || payload.storagePath || payload.url}: ${response.status}`);
  }

  const contentLengthHeader = response.headers.get("content-length");
  if (contentLengthHeader) {
    const contentLength = parseInt(contentLengthHeader, 10);
    if (!Number.isNaN(contentLength) && contentLength > 25 * 1024 * 1024) {
      throw new Error('Attachment too large');
    }
  }

  const bytes = new Uint8Array(await response.arrayBuffer());
  if (bytes.length > 25 * 1024 * 1024) {
    throw new Error('Attachment too large');
  }
  const contentType = response.headers.get("content-type")?.split(";")[0]?.trim();
  const filename = payload.filename
    || filenameFromDisposition(response.headers.get("content-disposition"))
    || (payload.storagePath ? payload.storagePath.split("/").pop() : null)
    || filenameFromUrl(payload.url);

  return {
    filename,
    mimeType: payload.mimeType || contentType || "application/octet-stream",
    data: base64FromBytes(bytes),
  };
}

function buildEmailMime(opts: {
  fromEmail: string;
  fromName: string;
  toEmail: string;
  cc?: string[];
  bcc?: string[];
  replyTo?: string;
  subject: string;
  htmlBody: string;
  attachments: Attachment[];
}): string {
  const { fromEmail, fromName, toEmail, cc, bcc, replyTo, subject, htmlBody, attachments } = opts;
  const boundary = `boundary_${Date.now()}_${Math.random().toString(36).slice(2)}`;
  const fromField = fromName ? `${encodeMimeWord(fromName)} <${fromEmail}>` : fromEmail;
  const encodedSubject = encodeMimeWord(subject);

  const ccHeader = joinEmails(cc);
  const bccHeader = joinEmails(bcc);

  const baseHeaders = [
    `From: ${fromField}`,
    `To: ${toEmail}`,
    ccHeader ? `Cc: ${ccHeader}` : "",
    bccHeader ? `Bcc: ${bccHeader}` : "",
    replyTo ? `Reply-To: ${replyTo}` : "",
    `Subject: ${encodedSubject}`,
    `MIME-Version: 1.0`,
  ].filter(Boolean);

  if (attachments.length === 0) {
    const lines = [
      ...baseHeaders,
      `Content-Type: text/html; charset=utf-8`,
      `Content-Transfer-Encoding: base64`,
      ``,
      btoa(unescape(encodeURIComponent(htmlBody))),
    ];
    return lines.join("\r\n");
  }

  const parts: string[] = [];
  parts.push([
    `--${boundary}`,
    `Content-Type: text/html; charset=utf-8`,
    `Content-Transfer-Encoding: base64`,
    ``,
    btoa(unescape(encodeURIComponent(htmlBody))),
  ].join("\r\n"));

  for (const att of attachments) {
    const encodedFilename = encodeMimeWord(att.filename);
    parts.push([
      `--${boundary}`,
      `Content-Type: ${att.mimeType}; name="${encodedFilename}"`,
      `Content-Transfer-Encoding: base64`,
      `Content-Disposition: attachment; filename="${encodedFilename}"`,
      ``,
      att.data,
    ].join("\r\n"));
  }

  const headerBlock = [
    ...baseHeaders,
    `Content-Type: multipart/mixed; boundary="${boundary}"`,
    ``,
  ].join("\r\n");

  const body = parts.join("\r\n") + `\r\n--${boundary}--`;
  return headerBlock + "\r\n" + body;
}

function summarizeMime(mime: string): Record<string, unknown> {
  const headerBlock = mime.split("\r\n\r\n")[0] || "";
  const attachmentCount = (mime.match(/Content-Disposition:\s*attachment/gi) || []).length;
  return {
    hasCcHeader: /^Cc:/im.test(headerBlock),
    hasBccHeader: /^Bcc:/im.test(headerBlock),
    attachmentCount,
    headers: headerBlock,
  };
}

async function findFallbackConnection(supabase: any): Promise<GmailConnection | null> {
  // Server-side fallback: prefer a connection identified by a configured env var,
  // otherwise fall back to any active admin user with a connected Gmail.
  const fallbackUserId = Deno.env.get("PRICING_FALLBACK_USER_ID") || "";
  const fallbackEmail = Deno.env.get("PRICING_FALLBACK_EMAIL") || "";

  if (fallbackUserId) {
    const data = await getGmailConnectionSecret(supabase, { userId: fallbackUserId });
    if (data) return data as GmailConnection;
  }
  if (fallbackEmail) {
    const { data } = await supabase
      .from("gmail_connections")
      .select("id")
      .eq("email_address", fallbackEmail)
      .eq("is_connected", true)
      .maybeSingle();
    if (data?.id) return await getGmailConnectionSecret(supabase, { connectionId: data.id }) as GmailConnection | null;
  }
  // Last-resort fallback: any admin user's active connection
  const { data: admins } = await supabase
    .from("user_profiles")
    .select("id")
    .eq("role", "admin")
    .eq("is_active", true);
  const adminIds = (admins || []).map((a: { id: string }) => a.id);
  if (adminIds.length > 0) {
    const { data } = await supabase
      .from("gmail_connections")
      .select("id")
      .in("user_id", adminIds)
      .eq("is_connected", true)
      .limit(1)
      .maybeSingle();
    if (data?.id) return await getGmailConnectionSecret(supabase, { connectionId: data.id }) as GmailConnection | null;
  }
  return null;
}

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") {
    return new Response(null, { status: 200, headers: corsHeaders });
  }

  try {
    const supabaseUrl = Deno.env.get("SUPABASE_URL")!;
    const supabaseServiceKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
    const supabaseAnonKey = Deno.env.get("SUPABASE_ANON_KEY")!;
    const supabase = createClient(supabaseUrl, supabaseServiceKey);
    const workerSecret = Deno.env.get("BULK_EMAIL_WORKER_SECRET") || "";
    const isInternalWorker = Boolean(workerSecret)
      && req.headers.get("X-Bulk-Email-Worker-Secret") === workerSecret;

    // ── 1. Verify caller JWT ──────────────────────────────────────────────
    const authHeader = req.headers.get("Authorization") || "";
    const jwt = authHeader.startsWith("Bearer ") ? authHeader.slice(7) : "";
    if (!jwt && !isInternalWorker) {
      return new Response(
        JSON.stringify({ success: false, error: "Missing Authorization header" }),
        { status: 401, headers: { ...corsHeaders, "Content-Type": "application/json" } }
      );
    }
    let authUserId = "";
    if (!isInternalWorker) {
      const userClient = createClient(supabaseUrl, supabaseAnonKey, {
        global: { headers: { Authorization: `Bearer ${jwt}` } },
      });
      const { data: authData, error: authError } = await userClient.auth.getUser();
      if (authError || !authData?.user) {
        return new Response(
          JSON.stringify({ success: false, error: "Invalid or expired session" }),
          { status: 401, headers: { ...corsHeaders, "Content-Type": "application/json" } }
        );
      }
      authUserId = authData.user.id;
    }

    // ── 2. Parse body ─────────────────────────────────────────────────────
    const body = await req.json();
    const {
      userId,                 // optional — must equal authUserId if present
      allowFallback,          // boolean — true means fall through to fallback sender
      workflowType,           // required when allowFallback=true; categorises the send
      requiredSenderEmail,    // optional — bypass user lookup, send from this exact Gmail address
      toEmails,
      cc,
      bcc,
      replyTo,
      subject,
      body: emailBody,
      contactId,              // unused server-side, accepted for compat
      senderName,
      isHtml,
      attachments,
      attachmentUrls,
    } = body as Record<string, any>;

    void contactId;

    if (!toEmails || !subject || !emailBody) {
      return new Response(
        JSON.stringify({ success: false, error: "Missing required fields (toEmails, subject, body)" }),
        { status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" } }
      );
    }

    // ── 2b. Workflow / role gating ───────────────────────────────────────
    // workflowType is required for fallback usage and gates the whole call.
    // The allowlist below matches actual product flows. Unknown types are
    // rejected outright.
    const APPROVED_WORKFLOWS: Record<string, { roles: string[]; fallback: boolean }> = {
      pricing_sourcing : { roles: ["admin", "manager", "sales"], fallback: true },
      pricing_reminder : { roles: ["admin", "manager", "sales"], fallback: true },
      customer_quote   : { roles: ["admin", "manager", "sales"], fallback: true },
      crm_bulk_email   : { roles: ["admin", "manager", "sales"], fallback: true },
      stock_update     : { roles: ["admin", "manager", "sales"], fallback: true },
      delivery_log     : { roles: ["admin", "manager", "sales"], fallback: true },
      india_pricing    : { roles: ["admin", "manager", "sales"], fallback: false },
    };

    if (workflowType !== undefined && workflowType !== null) {
      if (typeof workflowType !== "string" || !APPROVED_WORKFLOWS[workflowType]) {
        return new Response(
          JSON.stringify({
            success: false,
            error: `Unknown workflowType: ${workflowType}`,
            code: "UNKNOWN_WORKFLOW_TYPE",
          }),
          { status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" } }
        );
      }
    }

    if (allowFallback && !isInternalWorker) {
      if (!workflowType) {
        return new Response(
          JSON.stringify({
            success: false,
            error: "workflowType is required when allowFallback=true",
            code: "WORKFLOW_TYPE_REQUIRED",
          }),
          { status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" } }
        );
      }
      const wf = APPROVED_WORKFLOWS[workflowType];
      if (!wf.fallback) {
        return new Response(
          JSON.stringify({
            success: false,
            error: `workflowType ${workflowType} does not allow fallback sender`,
            code: "FALLBACK_NOT_ALLOWED",
          }),
          { status: 403, headers: { ...corsHeaders, "Content-Type": "application/json" } }
        );
      }
      // Verify the caller has one of the approved roles for this workflow.
      const { data: profile } = await supabase
        .from("user_profiles")
        .select("role,is_active")
        .eq("id", authUserId)
        .maybeSingle();
      if (!profile || profile.is_active === false || !wf.roles.includes(profile.role)) {
        return new Response(
          JSON.stringify({
            success: false,
            error: "Your role is not allowed to use fallback sender for this workflow",
            code: "ROLE_NOT_ALLOWED",
          }),
          { status: 403, headers: { ...corsHeaders, "Content-Type": "application/json" } }
        );
      }
    }

    // Authorization rule:
    //  - userId omitted → sender = auth user
    //  - userId === authUserId → allowed
    //  - userId !== authUserId → reject (unless caller explicitly opts into fallback,
    //    in which case the userId is ignored and we resolve the fallback)
    if (isInternalWorker && !userId) {
      return new Response(
        JSON.stringify({ success: false, error: "Internal worker send requires userId" }),
        { status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" } }
      );
    }

    let intendedSenderUserId: string | null = isInternalWorker ? String(userId) : authUserId;
    if (!isInternalWorker && userId && userId !== authUserId) {
      if (!allowFallback) {
        return new Response(
          JSON.stringify({
            success: false,
            error: "Cannot send from another user's Gmail. Omit userId or set allowFallback=true with an approved workflowType.",
          }),
          { status: 403, headers: { ...corsHeaders, "Content-Type": "application/json" } }
        );
      }
      intendedSenderUserId = null; // skip self lookup, go straight to fallback
    }

    // ── 3. Resolve sender connection (self → fallback if allowed) ─────────
    let senderMode: "connected_gmail" | "fallback" = "connected_gmail";
    let connection: GmailConnection | null = null;

    // requiredSenderEmail bypasses the auth-user and fallback chains entirely.
    // The exact mailbox must be connected — no silent fallback.
    if (typeof requiredSenderEmail === "string" && requiredSenderEmail.trim()) {
      const { data: connRow } = await supabase
        .from("gmail_connections")
        .select("id")
        .eq("email_address", requiredSenderEmail.trim())
        .eq("is_connected", true)
        .maybeSingle();

      if (!connRow?.id) {
        return new Response(
          JSON.stringify({
            success: false,
            error: `India Pricing Mailbox (${requiredSenderEmail}) is not connected. Please reconnect it in Gmail Settings.`,
            code: "NO_CONNECTION",
          }),
          { status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" } }
        );
      }

      const fetched = await getGmailConnectionSecret(supabase, { connectionId: connRow.id });
      if (!fetched) {
        return new Response(
          JSON.stringify({
            success: false,
            error: `India Pricing Mailbox (${requiredSenderEmail}) credentials could not be retrieved. Please reconnect in Gmail Settings.`,
            code: "NO_CONNECTION",
          }),
          { status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" } }
        );
      }
      connection = fetched as GmailConnection;
    } else {
      if (intendedSenderUserId) {
        const data = await getGmailConnectionSecret(supabase, { userId: intendedSenderUserId });
        if (data) connection = data as GmailConnection;
      }
    }

    if (!connection && allowFallback) {
      connection = await findFallbackConnection(supabase);
      if (connection) senderMode = "fallback";
    }

    if (!connection) {
      return new Response(
        JSON.stringify({
          success: false,
          error: allowFallback
            ? "No connected Gmail available for sender or fallback. Connect Gmail in Settings."
            : "Gmail not connected. Please connect Gmail in Settings.",
          code: "NO_CONNECTION",
        }),
        { status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" } }
      );
    }

    // ── 4. Build & send via Gmail API ─────────────────────────────────────
    // Token refresh credentials come from the Edge Function environment only.
    const accessToken = await getValidAccessToken(supabase, connection, {});

    const recipientEmails = parseEmailRecipients(toEmails);
    const ccRecipients = parseEmailRecipients(cc);
    const bccRecipients = parseEmailRecipients(bcc);
    const finalRecipientList = [...recipientEmails, ...ccRecipients, ...bccRecipients];
    const toField = recipientEmails.join(", ");

    if (recipientEmails.length === 0) {
      return new Response(
        JSON.stringify({ success: false, error: "At least one TO recipient is required" }),
        { status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" } }
      );
    }

    const htmlContent = isHtml
      ? emailBody
      : `<html><body><pre style="font-family:sans-serif;white-space:pre-wrap">${emailBody}</pre></body></html>`;

    console.log("[quotation-email-debug] Actual HTML sent to Gmail API", {
      workflowType,
      subject,
      toField,
      isHtml,
      containsTableTags: inspectEmailHtml(htmlContent),
      html: htmlContent,
    });

    const directAttachments: Attachment[] = Array.isArray(attachments) ? attachments : [];
    const urlAttachments: AttachmentUrlPayload[] = Array.isArray(attachmentUrls)
      ? attachmentUrls.flatMap((att: any) => {
          if (typeof att === "string" && att.trim()) return [{ url: att.trim() }];
          if (att && typeof att.url === "string") return [att as AttachmentUrlPayload];
          return [];
        })
      : [];

    console.log("[quotation-delivery-debug] Edge Function payload received", {
      workflowType,
      subject,
      rawCcInput: cc,
      parsedCcRecipients: ccRecipients,
      rawBccInput: bcc,
      parsedBccRecipients: bccRecipients,
      parsedToRecipients: recipientEmails,
      finalGmailRecipientList: finalRecipientList,
      directAttachmentCount: directAttachments.length,
      attachmentPayload: urlAttachments.map(att => ({
        filename: att.filename || null,
        source: att.source || null,
        documentId: att.documentId || null,
        storagePath: att.storagePath || null,
        hasSignedUrl: Boolean(att.url),
      })),
    });

    const downloadedAttachments: Attachment[] = [];
    for (const attachmentPayload of urlAttachments) {
      downloadedAttachments.push(await downloadAttachment(attachmentPayload));
    }

    const fileAttachments = [...directAttachments, ...downloadedAttachments];

    console.log("[quotation-delivery-debug] Attachment download summary", {
      signedUrlCount: urlAttachments.length,
      downloadedFileCount: downloadedAttachments.length,
      directAttachmentCount: directAttachments.length,
      mimeAttachmentCount: fileAttachments.length,
      filenames: fileAttachments.map(att => att.filename),
    });

    const mimeEmail = buildEmailMime({
      fromEmail: connection.email_address,
      fromName: senderName || "",
      toEmail: toField,
      cc: ccRecipients,
      bcc: bccRecipients,
      replyTo: typeof replyTo === "string" ? replyTo : undefined,
      subject,
      htmlBody: htmlContent,
      attachments: fileAttachments,
    });
    const encodedEmail = encodeBase64Url(mimeEmail);

    console.log("[quotation-delivery-debug] Gmail MIME payload summary", {
      finalGmailRecipientList: finalRecipientList,
      attachmentFilenames: fileAttachments.map(att => att.filename),
      encodedPayloadBytes: encodedEmail.length,
      ...summarizeMime(mimeEmail),
    });

    const sendResponse = await fetch("https://gmail.googleapis.com/gmail/v1/users/me/messages/send", {
      method: "POST",
      headers: {
        "Authorization": `Bearer ${accessToken}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ raw: encodedEmail }),
    });

    if (!sendResponse.ok) {
      const errorData = await sendResponse.text();
      console.error("Gmail API error:", errorData);
      throw new Error(`Gmail API error: ${errorData}`);
    }

    const result = await sendResponse.json();

    return new Response(
      JSON.stringify({
        success: true,
        messageId: result.id || null,
        threadId: result.threadId || null,
        senderMode,
        senderEmail: connection.email_address,
        actualRecipientsSent: finalRecipientList,
        gmailMimeAttachmentCount: fileAttachments.length,
        attachmentFilenames: fileAttachments.map(att => att.filename),
      }),
      { headers: { ...corsHeaders, "Content-Type": "application/json" } }
    );
  } catch (error: any) {
    console.error("Error sending email:", error);
    const isRefreshError = error?.code === "TOKEN_REFRESH_FAILED"
      || String(error?.message || "").includes("Failed to refresh access token");

    return new Response(
      JSON.stringify({
        success: false,
        error: error.message || "Failed to send email",
        code: isRefreshError ? "TOKEN_REAUTH_REQUIRED" : "SEND_FAILED",
        reauthRequired: isRefreshError,
      }),
      {
        status: isRefreshError ? 401 : 500,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      }
    );
  }
});
