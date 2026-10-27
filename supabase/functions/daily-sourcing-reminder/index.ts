import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "npm:@supabase/supabase-js@2.57.4";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type, Authorization, X-Client-Info, Apikey",
};

interface OutstandingItem {
  id: string;
  inquiry_number: string;
  aceerp_no: string | null;
  company_name: string;
  product_name: string;
  specification: string | null;
  quantity: string;
  supplier_name: string | null;
  supplier_country: string | null;
  source_type: string | null;
  source_status: string;
  document_status: string;
  kunal_price_status: string;
  purchase_price: number | null;
  offered_price: number | null;
  last_sourcing_sent_at: string | null;
  last_reminder_sent_at: string | null;
  reminder_count: number | null;
  coa_required: boolean | null;
  created_at: string;
}

const REMINDER_DISCLAIMER_TEXT =
  "This is a system-generated email. Please ignore if you have already quoted for one or two products which we have missed updating yet.";

function escapeHtml(value: unknown): string {
  return String(value ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

function calculateAging(createdAt: string, sourcingSentAt: string | null): number {
  const anchor = sourcingSentAt || createdAt;
  const ms = Date.now() - new Date(anchor).getTime();
  return Number.isFinite(ms) ? Math.max(0, Math.floor(ms / 86400000)) : 0;
}

function determineStatusLabel(item: OutstandingItem): string {
  const hasPrice = (item.purchase_price !== null && item.purchase_price > 0) || item.kunal_price_status === "price_received";
  const coaPending = item.coa_required && item.document_status !== "received";
  if (hasPrice && coaPending) return "Price Received — COA Pending";
  if (!hasPrice && coaPending) return "Price Pending — COA Pending";
  if (!hasPrice) return "Price Pending";
  return "COA Pending";
}

function deriveRoute(item: OutstandingItem): "india" | "china" {
  const source = (item.source_type || "").trim().toLowerCase();
  if (source === "china") return "china";
  if (source === "india") return "india";
  const country = (item.supplier_country || "").trim().toLowerCase();
  if (country === "china") return "china";
  const supplier = (item.supplier_name || "").toLowerCase();
  if (supplier.includes("china")) return "china";
  return "india";
}

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") {
    return new Response(null, { headers: corsHeaders });
  }

  const supabaseUrl = Deno.env.get("SUPABASE_URL") || "";
  const supabaseServiceKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") || "";
  const supabase = createClient(supabaseUrl, supabaseServiceKey);

  try {
    // 1. Fetch outstanding sourcing items (not completed, not won/lost, sourcing initiated)
    const { data: rawItems, error: fetchErr } = await supabase
      .from("crm_inquiries")
      .select("id, inquiry_number, aceerp_no, company_name, product_name, specification, quantity, supplier_name, supplier_country, source_type, source_status, document_status, kunal_price_status, purchase_price, offered_price, last_sourcing_sent_at, last_reminder_sent_at, reminder_count, coa_required, created_at")
      .in("source_status", ["sent", "waiting_reply", "waiting_supplier", "needs_sourcing"])
      .not("source_status", "in", '("received","unavailable")')
      .order("created_at", { ascending: true });

    if (fetchErr) throw fetchErr;

    const items = (rawItems || []) as OutstandingItem[];

    // Filter to truly outstanding: price not received OR (price received but COA pending)
    const outstanding = items.filter(i => {
      const hasPrice = (i.purchase_price !== null && i.purchase_price > 0) || i.kunal_price_status === "price_received";
      const coaPending = i.coa_required && i.document_status !== "received";
      return !hasPrice || coaPending;
    });

    if (outstanding.length === 0) {
      return new Response(
        JSON.stringify({ success: true, message: "No outstanding sourcing items found." }),
        { headers: { ...corsHeaders, "Content-Type": "application/json" } }
      );
    }

    // Segregate by route (India vs China)
    const groups: Record<"india" | "china", OutstandingItem[]> = {
      india: [],
      china: [],
    };
    for (const item of outstanding) {
      const r = deriveRoute(item);
      groups[r].push(item);
    }

    // Load route recipient configurations
    const { data: recData } = await supabase
      .from("sourcing_email_recipients")
      .select("route, to_emails, cc_emails, bcc_emails");

    const recipientsMap: Record<string, { to: string[]; cc: string[]; bcc: string[] }> = {
      india: { to: ["devansh@shubham.co.in"], cc: ["devansh@shubham.co.in"], bcc: [] },
      china: { to: [], cc: [], bcc: [] },
    };

    for (const r of recData || []) {
      recipientsMap[r.route] = {
        to: r.to_emails || [],
        cc: r.cc_emails || [],
        bcc: r.bcc_emails || [],
      };
    }

    const todayDateStr = new Date().toLocaleDateString("en-GB", { day: "2-digit", month: "short", year: "numeric" });
    const nowIso = new Date().toISOString();
    const sendResults: Record<string, any> = {};

    for (const route of ["india", "china"] as const) {
      const routeItems = groups[route];
      if (routeItems.length === 0) continue;

      const rec = recipientsMap[route];
      const toList = rec?.to && rec.to.length > 0 ? rec.to : (route === "india" ? ["devansh@shubham.co.in"] : []);
      if (toList.length === 0) {
        sendResults[route] = { skipped: true, reason: `No recipients configured for ${route}` };
        continue;
      }

      const ccList = route === "india"
        ? Array.from(new Set([...(rec?.cc || []), "devansh@shubham.co.in"]))
        : (rec?.cc || []);

      const subject = `Daily Pending Price & COA Follow-up – ${route === "china" ? "China Team – " : ""}${todayDateStr}`;

      // Build consolidated table
      const headerStyle = "padding:10px 12px;border:1px solid #b7c9df;background:#073763;color:#ffffff;text-align:left;font-weight:700;font-size:12px;";
      const cellBase = "padding:8px 12px;border:1px solid #d1d5db;color:#1f2937;font-size:12px;vertical-align:top;";

      const tableRows = routeItems.map((item, idx) => {
        const bg = idx % 2 === 0 ? "#ffffff" : "#f8fafc";
        const agingDays = calculateAging(item.created_at, item.last_sourcing_sent_at);
        const agingColor = agingDays > 14 ? "#b91c1c" : agingDays > 7 ? "#d97706" : "#059669";
        const statusLabel = determineStatusLabel(item);
        const dateSent = item.last_sourcing_sent_at ? new Date(item.last_sourcing_sent_at).toLocaleDateString("en-GB", { day: "2-digit", month: "short" }) : "-";

        return `<tr style="background:${bg};">
          <td style="${cellBase}font-weight:600;white-space:nowrap;">${escapeHtml(item.inquiry_number)}</td>
          <td style="${cellBase}white-space:nowrap;">${escapeHtml(item.aceerp_no || "-")}</td>
          <td style="${cellBase}">${escapeHtml(item.company_name || "-")}</td>
          <td style="${cellBase}font-weight:600;">${escapeHtml(item.product_name)}</td>
          <td style="${cellBase}">${escapeHtml(item.specification || "-")}</td>
          <td style="${cellBase}white-space:nowrap;">${escapeHtml(item.quantity || "-")}</td>
          <td style="${cellBase}">${escapeHtml(item.supplier_name || "-")}</td>
          <td style="${cellBase}white-space:nowrap;">${escapeHtml(dateSent)}</td>
          <td style="${cellBase}text-align:center;font-weight:700;color:${agingColor};white-space:nowrap;">${agingDays}d</td>
          <td style="${cellBase}font-weight:600;color:#073763;">${escapeHtml(statusLabel)}</td>
        </tr>`;
      }).join("");

      const emailHtml = `<p>Dear Team,</p>
        <p>Please find below the consolidated list of outstanding sourcing items requiring price or document updates as of today:</p>
        <table role="presentation" cellpadding="0" cellspacing="0" border="0" style="border-collapse:collapse;width:100%;max-width:1050px;font-family:Arial,Helvetica,sans-serif;font-size:12px;">
          <thead><tr>
            <th style="${headerStyle}">Inquiry No</th>
            <th style="${headerStyle}">AC ERP Ref</th>
            <th style="${headerStyle}">Customer</th>
            <th style="${headerStyle}">Product</th>
            <th style="${headerStyle}">Specification</th>
            <th style="${headerStyle}">Quantity</th>
            <th style="${headerStyle}">Preferred Make</th>
            <th style="${headerStyle}">Date Sent</th>
            <th style="${headerStyle}">Aging</th>
            <th style="${headerStyle}">Status / Pending Item</th>
          </tr></thead>
          <tbody>${tableRows}</tbody>
        </table>
        <div style="font-family:Arial,Helvetica,sans-serif;color:#1f2937;line-height:1.45;font-size:14px;margin-top:18px;">
          <p style="margin:0 0 6px 0;">Warm regards,</p>
          <p style="margin:0 0 6px 0;">Kunal Lunkad</p>
          <p style="margin:0 0 4px 0;color:#073763;font-size:18px;font-weight:700;">PT Sarana Anugrah Jaya</p>
        </div>
        <div style="margin-top:24px;padding:12px 14px;background:#f1f5f9;border-left:4px solid #64748b;font-family:Arial,Helvetica,sans-serif;font-size:11px;color:#475569;font-style:italic;">${REMINDER_DISCLAIMER_TEXT}</div>`;

      // Invoke send-bulk-email with fixed Kunal sender
      const sendRes = await fetch(`${supabaseUrl}/functions/v1/send-bulk-email`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${supabaseServiceKey}`,
        },
        body: JSON.stringify({
          requiredSenderEmail: "kunal@avira.co.id",
          replyTo: "kunal@avira.co.id",
          workflowType: "pricing_reminder",
          toEmails: toList,
          cc: ccList,
          bcc: rec?.bcc || [],
          subject,
          body: emailHtml,
          isHtml: true,
          senderName: "Kunal Lunkad",
        }),
      });

      const sendJson = await sendRes.json().catch(() => ({}));
      sendResults[route] = sendJson;

      // Update existing records: increment reminder_count and set last_reminder_sent_at (NEVER creates duplicates)
      for (const item of routeItems) {
        await supabase.from("crm_inquiries").update({
          last_reminder_sent_at: nowIso,
          reminder_count: (item.reminder_count ?? 0) + 1,
        }).eq("id", item.id);

        await supabase.from("crm_inquiry_timeline").insert({
          inquiry_id: item.id,
          event_type: "reminder_sent",
          event_title: "Daily Consolidated Reminder Sent",
          event_description: `Included in daily ${route} reminder to ${toList.join(", ")}`,
          event_timestamp: nowIso,
        });
      }
    }

    return new Response(
      JSON.stringify({ success: true, timestamp: nowIso, sendResults, totalOutstanding: outstanding.length }),
      { headers: { ...corsHeaders, "Content-Type": "application/json" } }
    );
  } catch (err: any) {
    return new Response(
      JSON.stringify({ success: false, error: err.message || "Failed to execute daily reminder" }),
      { status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" } }
    );
  }
});
