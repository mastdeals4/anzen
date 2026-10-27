import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "npm:@supabase/supabase-js@2";
import { requireRole, writeSecurityAudit } from "../_shared/security.ts";
import { getGmailConnectionSecret } from "../_shared/gmailSecrets.ts";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type, Authorization, X-Client-Info, Apikey",
};

const WAREHOUSE_EMAIL = "accounts@sapharmajaya.co.id";
const APP_URL = "https://sapharmajaya.co.id";

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

// Splits any delimiter-separated email string and returns valid addresses joined with ", "
// Returns "" if no valid addresses are found.
function normalizeToHeader(raw: string): string {
  return raw
    .split(/[,;\s\r\n]+/)
    .map(t => t.trim())
    .filter(t => EMAIL_RE.test(t))
    .join(", ");
}

function appLink(path: string, label: string): string {
  const url = `${APP_URL}/${path}`;
  return `<a href="${url}" style="display:inline-block;margin-top:16px;padding:10px 20px;background:#1e40af;color:#fff;text-decoration:none;border-radius:6px;font-size:13px;font-weight:600">${label} →</a>`;
}

interface NotificationPayload {
  type: "so_approved" | "dc_approved" | "invoice_created" | "low_stock" | "overdue_invoices" | "payment_reminder";
  data?: Record<string, unknown>;
  sender_user_id?: string;
}

const ALLOWED_NOTIFICATION_ROLES: Record<NotificationPayload["type"], string[]> = {
  so_approved: ["admin", "manager", "sales"],
  dc_approved: ["admin", "manager", "warehouse", "sales"],
  invoice_created: ["admin", "manager", "accounts", "sales"],
  low_stock: ["admin", "manager", "warehouse", "accounts"],
  overdue_invoices: ["admin", "manager", "accounts"],
  payment_reminder: ["admin", "manager", "accounts"],
};

interface GmailConnection {
  id: string;
  user_id: string;
  access_token: string;
  refresh_token: string;
  access_token_expires_at: string;
  email_address: string;
  is_connected: boolean;
}

interface UserProfile {
  id: string;
  email: string;
  full_name: string;
  role: string;
  is_active: boolean;
}

async function getGmailTokenForUser(
  supabase: ReturnType<typeof createClient>,
  userId: string
): Promise<{ token: string; connection: GmailConnection } | null> {
  const conn = await getGmailConnectionSecret(supabase, { userId }) as GmailConnection | null;

  if (!conn) return null;

  let accessToken = conn.access_token;

  if (new Date(conn.access_token_expires_at) <= new Date()) {
    const refreshRes = await fetch("https://oauth2.googleapis.com/token", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        client_id: Deno.env.get("GMAIL_CLIENT_ID"),
        client_secret: Deno.env.get("GMAIL_CLIENT_SECRET"),
        refresh_token: conn.refresh_token,
        grant_type: "refresh_token",
      }),
    });

    if (!refreshRes.ok) return null;

    const refreshData = await refreshRes.json();
    accessToken = refreshData.access_token;

    await supabase
      .from("gmail_connections")
      .update({
        access_token: accessToken,
        access_token_expires_at: new Date(Date.now() + refreshData.expires_in * 1000).toISOString(),
      })
      .eq("id", conn.id);
  }

  return { token: accessToken, connection: { ...conn, access_token: accessToken } };
}

async function sendViaGmail(
  token: string,
  from: string,
  toEmail: string,
  subject: string,
  htmlBody: string
): Promise<boolean> {
  const toHeader = normalizeToHeader(toEmail);
  if (!toHeader) return false; // skip entirely if no valid address

  const emailLines = [
    `From: ${from}`,
    `To: ${toHeader}`,
    `Subject: ${subject}`,
    "Content-Type: text/html; charset=utf-8",
    "",
    htmlBody,
  ];

  const encodedEmail = btoa(unescape(encodeURIComponent(emailLines.join("\r\n"))))
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/, "");

  const res = await fetch("https://gmail.googleapis.com/gmail/v1/users/me/messages/send", {
    method: "POST",
    headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
    body: JSON.stringify({ raw: encodedEmail }),
  });

  return res.ok;
}

function emailWrapper(title: string, content: string): string {
  return `<!DOCTYPE html>
<html>
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width,initial-scale=1">
  <style>
    body{font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;margin:0;padding:0;background:#f3f4f6}
    .wrap{max-width:600px;margin:24px auto;background:#fff;border-radius:8px;overflow:hidden;box-shadow:0 1px 3px rgba(0,0,0,.1)}
    .hdr{background:#1e40af;padding:20px 24px}
    .hdr h1{color:#fff;margin:0;font-size:18px;font-weight:600}
    .hdr p{color:#bfdbfe;margin:4px 0 0;font-size:13px}
    .bdy{padding:24px}
    .bdy p{color:#374151;font-size:14px;line-height:1.6;margin:0 0 12px}
    table.data{width:100%;border-collapse:collapse;margin:16px 0}
    table.data th{background:#f9fafb;text-align:left;padding:8px 12px;font-size:12px;color:#6b7280;border-bottom:1px solid #e5e7eb}
    table.data td{padding:8px 12px;font-size:13px;color:#111827;border-bottom:1px solid #f3f4f6}
    .red{background:#fee2e2;color:#991b1b;padding:2px 8px;border-radius:9999px;font-size:11px;font-weight:600}
    .yellow{background:#fef9c3;color:#854d0e;padding:2px 8px;border-radius:9999px;font-size:11px;font-weight:600}
    .green{background:#dcfce7;color:#166534;padding:2px 8px;border-radius:9999px;font-size:11px;font-weight:600}
    .ftr{background:#f9fafb;padding:16px 24px;border-top:1px solid #e5e7eb}
    .ftr p{color:#9ca3af;font-size:11px;margin:0}
  </style>
</head>
<body>
  <div class="wrap">
    <div class="hdr"><h1>PT Shubham Anzen Pharma Jaya</h1><p>${title}</p></div>
    <div class="bdy">${content}</div>
    <div class="ftr"><p>Automated notification from your ERP system.</p></div>
  </div>
</body>
</html>`;
}

async function findBestSenderForRole(
  supabase: ReturnType<typeof createClient>,
  preferredRoles: string[]
): Promise<{ token: string; email: string } | null> {
  const { data: users } = await supabase
    .from("user_profiles")
    .select("id, email, role")
    .in("role", preferredRoles)
    .eq("is_active", true) as { data: UserProfile[] | null };

  if (!users || users.length === 0) return null;

  for (const user of users) {
    const result = await getGmailTokenForUser(supabase, user.id);
    if (result) return { token: result.token, email: result.connection.email_address };
  }

  return null;
}

async function handleSOApproved(
  supabase: ReturnType<typeof createClient>,
  data: Record<string, unknown>,
  senderUserId?: string
) {
  const soId = data.so_id as string;
  if (!soId) return { sent: 0, error: "Missing so_id" };

  const [{ data: so }, { data: admins }] = await Promise.all([
    supabase
      .from("sales_orders")
      .select("*, customers(company_name)")
      .eq("id", soId)
      .maybeSingle(),
    supabase
      .from("user_profiles")
      .select("id, email, full_name, role")
      .in("role", ["admin", "accounts", "sales"])
      .eq("is_active", true),
  ]) as [{ data: Record<string, unknown> | null }, { data: UserProfile[] | null }];

  if (!so) return { sent: 0, error: "SO not found" };

  const senderResult = senderUserId
    ? await getGmailTokenForUser(supabase, senderUserId)
    : await findBestSenderForRole(supabase, ["admin", "accounts"]);

  if (!senderResult) return { sent: 0, error: "No Gmail connection available. Please connect Gmail in CRM Settings." };

  const customer = so.customers as { company_name: string } | null;
  const htmlContent = `
    <p>Sales Order <strong>${so.so_number}</strong> has been approved.</p>
    <table class="data">
      <tr><th>Customer</th><td>${customer?.company_name ?? "N/A"}</td></tr>
      <tr><th>SO Number</th><td>${so.so_number}</td></tr>
      <tr><th>Total Amount</th><td>Rp ${Number(so.total_amount).toLocaleString("id-ID")}</td></tr>
      <tr><th>Status</th><td><span class="green">Approved</span></td></tr>
    </table>
    <p>Please proceed with delivery challan creation as required.</p>
    ${appLink("sales-orders", "View Sales Order")}`;

  let sent = 0;
  const recipients = admins ?? [];
  const seen = new Set<string>();

  // Always include warehouse staff
  seen.add(WAREHOUSE_EMAIL);
  const warehouseOk = await sendViaGmail(
    senderResult.token,
    senderResult.email,
    WAREHOUSE_EMAIL,
    `SO Approved: ${so.so_number}`,
    emailWrapper("Sales Order Approved", htmlContent)
  );
  if (warehouseOk) sent++;

  for (const user of recipients) {
    if (!user.email || seen.has(user.email)) continue;
    seen.add(user.email);
    const ok = await sendViaGmail(
      senderResult.token,
      senderResult.email,
      user.email,
      `SO Approved: ${so.so_number}`,
      emailWrapper("Sales Order Approved", htmlContent)
    );
    if (ok) sent++;
  }

  return { sent };
}

async function handleDCApproved(
  supabase: ReturnType<typeof createClient>,
  data: Record<string, unknown>
) {
  const dcId = data.dc_id as string;
  if (!dcId) return { sent: 0, error: "Missing dc_id" };

  const { data: dc } = await supabase
    .from("delivery_challans")
    .select("*, customers(company_name)")
    .eq("id", dcId)
    .maybeSingle() as { data: Record<string, unknown> | null };

  if (!dc) return { sent: 0, error: "DC not found" };

  const senderResult = await findBestSenderForRole(supabase, ["admin", "accounts"]);
  if (!senderResult) return { sent: 0, error: "No Gmail connection available." };

  const customer = dc.customers as { company_name: string } | null;
  const htmlContent = `
    <p>Delivery Challan <strong>${dc.challan_number}</strong> has been approved and stock has been deducted.</p>
    <table class="data">
      <tr><th>Customer</th><td>${customer?.company_name ?? "N/A"}</td></tr>
      <tr><th>DC Number</th><td>${dc.challan_number}</td></tr>
      <tr><th>Challan Date</th><td>${dc.challan_date ?? "N/A"}</td></tr>
      <tr><th>Status</th><td><span class="green">Approved</span></td></tr>
    </table>
    <p>Stock has been deducted from inventory. Please proceed with physical dispatch.</p>
    ${appLink("delivery-challan", "View Delivery Challan")}`;

  const ok = await sendViaGmail(
    senderResult.token,
    senderResult.email,
    WAREHOUSE_EMAIL,
    `DC Approved: ${dc.challan_number}`,
    emailWrapper("Delivery Challan Approved", htmlContent)
  );

  return { sent: ok ? 1 : 0, recipient: WAREHOUSE_EMAIL };
}

async function handleInvoiceCreated(
  supabase: ReturnType<typeof createClient>,
  data: Record<string, unknown>
) {
  const invoiceId = data.invoice_id as string;
  if (!invoiceId) return { sent: 0, error: "Missing invoice_id" };

  const { data: invoice } = await supabase
    .from("sales_invoices")
    .select("*, customers(company_name)")
    .eq("id", invoiceId)
    .maybeSingle() as { data: Record<string, unknown> | null };

  if (!invoice) return { sent: 0, error: "Invoice not found" };

  const senderResult = await findBestSenderForRole(supabase, ["admin", "accounts"]);
  if (!senderResult) return { sent: 0, error: "No Gmail connection available." };

  const customer = invoice.customers as { company_name: string } | null;
  const htmlContent = `
    <p>Sales Invoice <strong>${invoice.invoice_number}</strong> has been created.</p>
    <table class="data">
      <tr><th>Customer</th><td>${customer?.company_name ?? "N/A"}</td></tr>
      <tr><th>Invoice Number</th><td>${invoice.invoice_number}</td></tr>
      <tr><th>Invoice Date</th><td>${invoice.invoice_date ?? "N/A"}</td></tr>
      <tr><th>Due Date</th><td>${invoice.due_date ?? "N/A"}</td></tr>
      <tr><th>Total Amount</th><td>Rp ${Number(invoice.total_amount).toLocaleString("id-ID")}</td></tr>
      <tr><th>Status</th><td><span class="yellow">Pending Payment</span></td></tr>
    </table>
    <p>Please ensure the invoice is dispatched to the customer and payment is tracked.</p>
    ${appLink("sales", "View Invoice")}`;

  const ok = await sendViaGmail(
    senderResult.token,
    senderResult.email,
    WAREHOUSE_EMAIL,
    `Invoice Created: ${invoice.invoice_number}`,
    emailWrapper("Sales Invoice Created", htmlContent)
  );

  return { sent: ok ? 1 : 0, recipient: WAREHOUSE_EMAIL };
}

async function handleLowStock(supabase: ReturnType<typeof createClient>) {
  const [{ data: products }, senderResult] = await Promise.all([
    supabase
      .from("products")
      .select("id, product_name, current_stock, min_stock_level")
      .eq("is_active", true)
      .not("min_stock_level", "is", null),
    findBestSenderForRole(supabase, ["admin", "accounts", "warehouse"]),
  ]);

  const lowStock = ((products as Array<{ id: string; product_name: string; current_stock: number; min_stock_level: number }>) ?? [])
    .filter(p => p.min_stock_level > 0 && p.current_stock <= p.min_stock_level);

  if (lowStock.length === 0) return { sent: 0, message: "No low stock products" };
  if (!senderResult) return { sent: 0, error: "No Gmail connection available for any admin/warehouse user." };

  const { data: recipients } = await supabase
    .from("user_profiles")
    .select("email, role")
    .in("role", ["admin", "warehouse", "accounts"])
    .eq("is_active", true) as { data: UserProfile[] | null };

  const rows = lowStock.map(p => {
    const pct = Math.round((p.current_stock / p.min_stock_level) * 100);
    const badge = p.current_stock === 0 ? "red" : "yellow";
    const label = p.current_stock === 0 ? "OUT OF STOCK" : "LOW";
    return `<tr><td>${p.product_name}</td><td>${p.current_stock}</td><td>${p.min_stock_level}</td><td>${pct}%</td><td><span class="${badge}">${label}</span></td></tr>`;
  }).join("");

  const htmlContent = `
    <p><strong>${lowStock.length}</strong> product(s) are at or below minimum stock level.</p>
    <table class="data">
      <thead><tr><th>Product</th><th>Current</th><th>Min Level</th><th>% of Min</th><th>Status</th></tr></thead>
      <tbody>${rows}</tbody>
    </table>
    <p>Please create purchase orders or import requirements for these items.</p>
    ${appLink("stock", "View Stock Levels")}`;

  let sent = 0;
  const seen = new Set<string>();
  for (const user of (recipients ?? [])) {
    if (!user.email || seen.has(user.email)) continue;
    seen.add(user.email);
    const ok = await sendViaGmail(
      senderResult.token,
      senderResult.email,
      user.email,
      `Low Stock Alert: ${lowStock.length} product(s) need attention`,
      emailWrapper("Low Stock Alert", htmlContent)
    );
    if (ok) sent++;
  }

  return { sent, low_stock_count: lowStock.length };
}

async function handleOverdueInvoices(supabase: ReturnType<typeof createClient>) {
  const today = new Date().toISOString().split("T")[0];

  const [{ data: invoices }, senderResult] = await Promise.all([
    supabase
      .from("sales_invoices")
      .select("id, invoice_number, total_amount, due_date, customers(company_name)")
      .in("payment_status", ["pending", "partial"])
      .lt("due_date", today)
      .order("due_date"),
    findBestSenderForRole(supabase, ["admin", "accounts"]),
  ]);

  if (!invoices || invoices.length === 0) return { sent: 0, message: "No overdue invoices" };
  if (!senderResult) return { sent: 0, error: "No Gmail connection available for any admin/accounts user." };

  const { data: recipients } = await supabase
    .from("user_profiles")
    .select("email, role")
    .in("role", ["admin", "accounts"])
    .eq("is_active", true) as { data: UserProfile[] | null };

  const rows = (invoices as Array<{ invoice_number: string; due_date: string; total_amount: number; customers: { company_name: string } | null }>).map(inv => {
    const daysOverdue = Math.floor((new Date().getTime() - new Date(inv.due_date).getTime()) / (1000 * 60 * 60 * 24));
    const badge = daysOverdue > 90 ? "red" : "yellow";
    return `<tr><td>${inv.customers?.company_name ?? "N/A"}</td><td>${inv.invoice_number}</td><td>${inv.due_date}</td><td>Rp ${Number(inv.total_amount).toLocaleString("id-ID")}</td><td><span class="${badge}">${daysOverdue}d overdue</span></td></tr>`;
  }).join("");

  const htmlContent = `
    <p><strong>${invoices.length}</strong> invoice(s) are overdue and require follow-up.</p>
    <table class="data">
      <thead><tr><th>Customer</th><th>Invoice #</th><th>Due Date</th><th>Amount</th><th>Status</th></tr></thead>
      <tbody>${rows}</tbody>
    </table>
    <p>Check the Ageing Report in Finance for details and to send individual reminders.</p>
    ${appLink("reports", "View Ageing Report")}`;

  let sent = 0;
  const seen = new Set<string>();
  for (const user of (recipients ?? [])) {
    if (!user.email || seen.has(user.email)) continue;
    seen.add(user.email);
    const ok = await sendViaGmail(
      senderResult.token,
      senderResult.email,
      user.email,
      `Overdue Invoice Alert: ${invoices.length} invoice(s) need attention`,
      emailWrapper("Overdue Invoice Alert", htmlContent)
    );
    if (ok) sent++;
  }

  return { sent, overdue_count: invoices.length };
}

async function handlePaymentReminder(
  supabase: ReturnType<typeof createClient>,
  data: Record<string, unknown>,
  senderUserId?: string
) {
  const { customer_email, customer_name, customer_id, reminder_body } = data as {
    customer_email: string;
    customer_name: string;
    customer_id: string;
    reminder_body: string;
  };

  if (!customer_email) return { sent: 0, error: "No customer email" };

  const senderResult = senderUserId
    ? await getGmailTokenForUser(supabase, senderUserId)
    : await findBestSenderForRole(supabase, ["accounts", "admin"]);

  if (!senderResult) return { sent: 0, error: "No Gmail connection available. Please connect Gmail in CRM Settings." };

  const htmlBody = reminder_body.replace(/\n/g, "<br>");
  const ok = await sendViaGmail(
    senderResult.token,
    senderResult.email,
    customer_email,
    "Payment Reminder – Outstanding Invoices",
    emailWrapper("Payment Reminder", `<p>${htmlBody}</p>`)
  );

  if (ok && customer_id && senderUserId) {
    await supabase.from("notifications").insert({
      user_id: senderUserId,
      type: "reminder_sent",
      title: "Payment reminder sent",
      message: `Reminder sent to ${customer_name} (${customer_email})`,
      reference_type: "customer",
      reference_id: customer_id,
    });
  }

  return { sent: ok ? 1 : 0, sender: senderResult.email };
}

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") {
    return new Response(null, { status: 200, headers: corsHeaders });
  }

  try {
    const supabaseUrl = Deno.env.get("SUPABASE_URL") ?? "";
    const serviceKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? "";

    const payload = (await req.json()) as NotificationPayload;
    const { type, data = {}, sender_user_id } = payload;

    if (!type || !ALLOWED_NOTIFICATION_ROLES[type]) {
      return new Response(JSON.stringify({ error: "Unknown notification type" }), {
        status: 400,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    const authResult = await requireRole(req, supabaseUrl, serviceKey, ALLOWED_NOTIFICATION_ROLES[type], corsHeaders);
    if (!authResult.ok) return authResult.response;
    const supabase = authResult.adminClient;

    if (sender_user_id && sender_user_id !== authResult.auth.user.id && authResult.auth.role !== "admin") {
      return new Response(JSON.stringify({ error: "Cannot send from another user's Gmail connection" }), {
        status: 403,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    await writeSecurityAudit(supabase, authResult.auth, "send_app_notification_requested", {
      function_name: "send-app-notifications",
      notification_type: type,
    });

    let result: Record<string, unknown> = {};

    switch (type) {
      case "so_approved":
        result = await handleSOApproved(supabase, data, sender_user_id);
        break;
      case "dc_approved":
        result = await handleDCApproved(supabase, data);
        break;
      case "invoice_created":
        result = await handleInvoiceCreated(supabase, data);
        break;
      case "low_stock":
        result = await handleLowStock(supabase);
        break;
      case "overdue_invoices":
        result = await handleOverdueInvoices(supabase);
        break;
      case "payment_reminder":
        result = await handlePaymentReminder(supabase, data, sender_user_id);
        break;
    }

    return new Response(JSON.stringify({ success: true, type, result }), {
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : "Unknown error";
    return new Response(JSON.stringify({ error: message }), {
      status: 500,
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  }
});
