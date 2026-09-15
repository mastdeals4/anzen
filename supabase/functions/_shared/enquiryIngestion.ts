// supabase/functions/_shared/enquiryIngestion.ts
//
// Shared canonical communication ingestion helper for Supabase Edge Functions.
// Connects existing Gmail ingestion (inbound) and sending (outbound) to the
// canonical Enquiry Control Center foundation (enquiry_conversations,
// enquiry_conversation_links, enquiry_conversation_messages).
//
// Invariants:
//   - Idempotent: safe under retries and concurrent execution
//   - Zero data loss: anti-join reconciliation discovers unmirrored records
//   - Strict Tier-1 matching: never auto-links on product/fuzzy similarity
//   - Zero impact on legacy flow: errors in mirror do not fail legacy flow
//   - Zero enquiry_requests created in this phase

import { SupabaseClient } from "npm:@supabase/supabase-js@2.57.4";

export interface InboundAttachmentDescriptor {
  filename: string;
  mimeType?: string;
  size?: number;
  attachmentId?: string;
  storagePath?: string;
}

export interface InboundMirrorPayload {
  messageId: string;
  threadId: string;
  fromEmail: string;
  fromName?: string | null;
  toEmails?: string[];
  subject: string;
  bodyText?: string | null;
  bodyHtml?: string | null;
  receivedAt?: string;
  attachments?: InboundAttachmentDescriptor[];
  rawPayload?: Record<string, unknown> | null;
  legacyInboxId?: string | null;
  convertedToInquiry?: string | null;
}

export interface OutboundMirrorPayload {
  messageId: string;
  threadId: string;
  fromEmail: string;
  toEmails?: string[];
  ccEmails?: string[];
  bccEmails?: string[];
  subject: string;
  bodyText?: string | null;
  bodyHtml?: string | null;
  sentAt?: string;
  attachments?: InboundAttachmentDescriptor[];
  actorId?: string | null;
  inquiryId?: string | null;
  additionalInquiryIds?: string[] | null;
}

export interface WhatsAppInboundPayload {
  messageId: string;
  chatId: string;
  senderPhone: string;
  senderName?: string | null;
  businessPhone?: string | null;
  text?: string | null;
  receivedAt?: string;
  isGroup?: boolean;
  quotedMessage?: {
    id?: string;
    body?: string;
    sender?: string;
  } | null;
  attachments?: InboundAttachmentDescriptor[];
  rawPayload?: Record<string, unknown> | null;
}

export interface WhatsAppOutboundPayload {
  messageId: string;
  conversationId: string;
  recipientPhone: string;
  text: string;
  actorId: string;
  draftMessageId?: string | null;
  sentAt?: string;
  rawPayload?: Record<string, unknown> | null;
}

export interface MirrorResult {
  success: boolean;
  conversationId: string | null;
  messageId: string | null;
  linkedInquiryId: string | null;
  isDuplicate: boolean;
  error?: string;
}

function cleanTitle(subject: string | null | undefined): string {
  if (!subject) return "(No Subject)";
  return subject
    .replace(/^(\s*(re|fwd|fw|external)\s*:\s*)+/gi, "")
    .trim() || "(No Subject)";
}

/**
 * Extract exact INQ number pattern: INQ-2026-001 or INQ-26-015 or INQ-26-015.1
 */
export function extractExactInquiryNumber(text: string | null | undefined): string | null {
  if (!text) return null;
  const match = text.match(/\bINQ-\d{2,4}-\d{3,4}(\.\d+)?\b/i);
  return match ? match[0].toUpperCase() : null;
}

/**
 * Resolve or create canonical conversation header by channel and external_thread_id.
 */
export async function getOrCreateCanonicalConversation(
  supabase: SupabaseClient,
  threadId: string,
  title: string,
  participants: string[],
  lastMessageAt: string,
  customerId: string | null = null,
  channel: "email" | "whatsapp" = "email"
): Promise<{ id: string; isNew: boolean }> {
  // Check existing by channel + external_thread_id
  const { data: existing, error: findError } = await supabase
    .from("enquiry_conversations")
    .select("id, participant_identifiers")
    .eq("channel", channel)
    .eq("external_thread_id", threadId)
    .maybeSingle();

  if (findError) throw findError;

  if (existing) {
    // Merge new participants if any
    const existingSet = new Set((existing.participant_identifiers || []).map((p: string) => p.toLowerCase()));
    const merged = [...(existing.participant_identifiers || [])];
    let changed = false;
    for (const p of participants) {
      if (p && !existingSet.has(p.toLowerCase())) {
        existingSet.add(p.toLowerCase());
        merged.push(p);
        changed = true;
      }
    }

    const updates: Record<string, unknown> = {
      last_message_at: lastMessageAt,
    };
    if (changed) updates.participant_identifiers = merged;
    if (customerId) updates.customer_id = customerId;

    await supabase
      .from("enquiry_conversations")
      .update(updates)
      .eq("id", existing.id);

    return { id: existing.id, isNew: false };
  }

  // Insert new conversation
  const newPayload = {
    channel: channel,
    external_thread_id: threadId,
    title: cleanTitle(title),
    participant_identifiers: participants.filter(Boolean),
    last_message_at: lastMessageAt,
    customer_id: customerId,
    status: "active",
  };

  const { data: created, error: insertError } = await supabase
    .from("enquiry_conversations")
    .insert(newPayload)
    .select("id")
    .single();

  if (insertError) {
    // Collision on unique partial index: uq_enq_conv_channel_external_thread
    if (insertError.code === "23505") {
      const { data: winner } = await supabase
        .from("enquiry_conversations")
        .select("id")
        .eq("channel", channel)
        .eq("external_thread_id", threadId)
        .single();
      if (winner) return { id: winner.id, isNew: false };
    }
    throw insertError;
  }

  return { id: created.id, isNew: true };
}

/**
 * Mirror inbound email from crm_email_inbox to canonical communication tables.
 */
export async function mirrorInboundEmail(
  supabase: SupabaseClient,
  payload: InboundMirrorPayload
): Promise<MirrorResult> {
  const {
    messageId,
    threadId,
    fromEmail,
    fromName = null,
    toEmails = [],
    subject,
    bodyText = null,
    bodyHtml = null,
    receivedAt = new Date().toISOString(),
    attachments = [],
    rawPayload = null,
    convertedToInquiry = null,
  } = payload;

  if (!messageId || !threadId) {
    return {
      success: false,
      conversationId: null,
      messageId: null,
      linkedInquiryId: null,
      isDuplicate: false,
      error: "Missing messageId or threadId",
    };
  }

  // 1. Resolve or create canonical conversation
  const participants = [fromEmail, ...toEmails].filter(Boolean);
  let customerId: string | null = null;

  // Try resolving customer_id from customer email domain if available
  const domain = fromEmail.split("@")[1]?.toLowerCase();
  if (domain && !["gmail.com", "yahoo.com", "hotmail.com", "outlook.com"].includes(domain)) {
    const { data: cust } = await supabase
      .from("customers")
      .select("id")
      .ilike("email", `%@${domain}`)
      .limit(1)
      .maybeSingle();
    if (cust) customerId = cust.id;
  }

  const { id: conversationId } = await getOrCreateCanonicalConversation(
    supabase,
    threadId,
    subject,
    participants,
    receivedAt,
    customerId
  );

  // 2. Ingest message idempotently
  let canonicalMessageId: string | null = null;
  let isDuplicate = false;

  // Check if message already exists
  const { data: existingMsg } = await supabase
    .from("enquiry_conversation_messages")
    .select("id")
    .eq("channel", "email")
    .eq("external_message_id", messageId)
    .maybeSingle();

  if (existingMsg) {
    canonicalMessageId = existingMsg.id;
    isDuplicate = true;
  } else {
    const msgPayload = {
      conversation_id: conversationId,
      channel: "email",
      direction: "inbound",
      external_message_id: messageId,
      sender_address: fromEmail.toLowerCase().trim(),
      sender_name: fromName,
      recipient_addresses: toEmails.map(e => e.toLowerCase().trim()),
      subject: subject || "(No Subject)",
      body_text: bodyText,
      body_html: bodyHtml,
      attachments: attachments || [],
      raw_payload: rawPayload || {},
      received_or_sent_at: receivedAt,
      actor_type: "system",
      actor_id: null,
      ai_processed: false,
      ai_summary: null,
    };

    const { data: insertedMsg, error: insertError } = await supabase
      .from("enquiry_conversation_messages")
      .insert(msgPayload)
      .select("id")
      .single();

    if (insertError) {
      if (insertError.code === "23505") {
        // Unique index collision on (channel, external_message_id)
        const { data: winnerMsg } = await supabase
          .from("enquiry_conversation_messages")
          .select("id")
          .eq("channel", "email")
          .eq("external_message_id", messageId)
          .single();
        canonicalMessageId = winnerMsg?.id || null;
        isDuplicate = true;
      } else {
        throw insertError;
      }
    } else {
      canonicalMessageId = insertedMsg.id;
    }
  }

  // 3. Strict Tier-1 Safe Inquiry Matching
  let targetInquiryId: string | null = null;

  // Tier 1 Signal 1: converted_to_inquiry already set on legacy inbox row
  if (convertedToInquiry) {
    const { data: inq } = await supabase
      .from("crm_inquiries")
      .select("id")
      .eq("id", convertedToInquiry)
      .maybeSingle();
    if (inq) targetInquiryId = inq.id;
  }

  // Tier 1 Signal 2: Existing link on this conversation
  if (!targetInquiryId) {
    const { data: existingLink } = await supabase
      .from("enquiry_conversation_links")
      .select("inquiry_id")
      .eq("conversation_id", conversationId)
      .eq("is_active", true)
      .limit(1)
      .maybeSingle();
    if (existingLink) targetInquiryId = existingLink.inquiry_id;
  }

  // Tier 1 Signal 3: Existing email_inquiry_links for this thread or message
  if (!targetInquiryId) {
    const { data: eil } = await supabase
      .from("email_inquiry_links")
      .select("inquiry_id")
      .or(`gmail_thread_id.eq.${threadId},gmail_message_id.eq.${messageId}`)
      .limit(1)
      .maybeSingle();
    if (eil) targetInquiryId = eil.inquiry_id;
  }

  // Tier 1 Signal 4: Exact INQ number in Subject or Body
  if (!targetInquiryId) {
    const exactInqNo = extractExactInquiryNumber(`${subject || ""} ${bodyText || ""}`);
    if (exactInqNo) {
      const { data: inq } = await supabase
        .from("crm_inquiries")
        .select("id")
        .eq("inquiry_number", exactInqNo)
        .maybeSingle();
      if (inq) targetInquiryId = inq.id;
    }
  }

  // If a Tier-1 match is confirmed, create conversation link if not already linked
  if (targetInquiryId) {
    // Check if link already exists
    const { data: existingLink } = await supabase
      .from("enquiry_conversation_links")
      .select("id")
      .eq("conversation_id", conversationId)
      .eq("inquiry_id", targetInquiryId)
      .maybeSingle();

    if (!existingLink) {
      // Check if target inquiry already has an active primary link
      const { data: activePrimary } = await supabase
        .from("enquiry_conversation_links")
        .select("id")
        .eq("inquiry_id", targetInquiryId)
        .eq("link_type", "primary")
        .eq("is_active", true)
        .maybeSingle();

      const linkType = activePrimary ? "related" : "primary";

      await supabase
        .from("enquiry_conversation_links")
        .insert({
          conversation_id: conversationId,
          inquiry_id: targetInquiryId,
          link_type: linkType,
          is_active: true,
        })
        .catch((err: any) => {
          // If primary unique constraint hits due to concurrent link, retry as related
          if (err?.code === "23505") {
            return supabase.from("enquiry_conversation_links").insert({
              conversation_id: conversationId,
              inquiry_id: targetInquiryId,
              link_type: "related",
              is_active: true,
            });
          }
        });
    }
  }

  // 4. Trigger Enquiry Brain automatic analysis for new canonical inbound messages
  if (!isDuplicate && canonicalMessageId) {
    const isEligible = isEligibleForEnquiryBrainAnalysis({
      direction: "inbound",
      channel: "email",
      bodyText,
      bodyHtml,
      subject,
    });

    if (isEligible) {
      triggerEnquiryBrainAnalysis(supabase, canonicalMessageId).catch((aiErr) => {
        console.error(`[Canonical Ingestion] Auto analysis trigger error for message ${canonicalMessageId}:`, aiErr);
      });
    }
  }

  return {
    success: true,
    conversationId,
    messageId: canonicalMessageId,
    linkedInquiryId: targetInquiryId,
    isDuplicate,
  };
}

/**
 * Mirror outbound email sent via send-bulk-email to canonical communication tables.
 */
export async function mirrorOutboundEmail(
  supabase: SupabaseClient,
  payload: OutboundMirrorPayload
): Promise<MirrorResult> {
  const {
    messageId,
    threadId,
    fromEmail,
    toEmails = [],
    ccEmails = [],
    bccEmails = [],
    subject,
    bodyText = null,
    bodyHtml = null,
    sentAt = new Date().toISOString(),
    attachments = [],
    actorId = null,
    inquiryId = null,
    additionalInquiryIds = [],
  } = payload;

  if (!messageId || !threadId) {
    return {
      success: false,
      conversationId: null,
      messageId: null,
      linkedInquiryId: null,
      isDuplicate: false,
      error: "Missing messageId or threadId",
    };
  }

  // 1. Resolve or create canonical conversation
  const participants = [fromEmail, ...toEmails, ...ccEmails].filter(Boolean);
  const { id: conversationId } = await getOrCreateCanonicalConversation(
    supabase,
    threadId,
    subject,
    participants,
    sentAt
  );

  // 2. Ingest message idempotently
  let canonicalMessageId: string | null = null;
  let isDuplicate = false;

  const { data: existingMsg } = await supabase
    .from("enquiry_conversation_messages")
    .select("id")
    .eq("channel", "email")
    .eq("external_message_id", messageId)
    .maybeSingle();

  if (existingMsg) {
    canonicalMessageId = existingMsg.id;
    isDuplicate = true;
  } else {
    const msgPayload = {
      conversation_id: conversationId,
      channel: "email",
      direction: "outbound",
      external_message_id: messageId,
      sender_address: fromEmail.toLowerCase().trim(),
      sender_name: null,
      recipient_addresses: [...toEmails, ...ccEmails].map(e => e.toLowerCase().trim()),
      subject: subject || "(No Subject)",
      body_text: bodyText,
      body_html: bodyHtml,
      attachments: attachments || [],
      raw_payload: { bccCount: bccEmails.length },
      received_or_sent_at: sentAt,
      actor_type: "user",
      actor_id: actorId || null,
      ai_processed: false,
      ai_summary: null,
    };

    const { data: insertedMsg, error: insertError } = await supabase
      .from("enquiry_conversation_messages")
      .insert(msgPayload)
      .select("id")
      .single();

    if (insertError) {
      if (insertError.code === "23505") {
        const { data: winnerMsg } = await supabase
          .from("enquiry_conversation_messages")
          .select("id")
          .eq("channel", "email")
          .eq("external_message_id", messageId)
          .single();
        canonicalMessageId = winnerMsg?.id || null;
        isDuplicate = true;
      } else {
        throw insertError;
      }
    } else {
      canonicalMessageId = insertedMsg.id;
    }
  }

  // 3. Link to inquiries ONLY if explicit inquiry context was provided
  if (inquiryId) {
    // Primary inquiry
    const { data: existingLink } = await supabase
      .from("enquiry_conversation_links")
      .select("id")
      .eq("conversation_id", conversationId)
      .eq("inquiry_id", inquiryId)
      .maybeSingle();

    if (!existingLink) {
      const { data: activePrimary } = await supabase
        .from("enquiry_conversation_links")
        .select("id")
        .eq("inquiry_id", inquiryId)
        .eq("link_type", "primary")
        .eq("is_active", true)
        .maybeSingle();

      const linkType = activePrimary ? "related" : "primary";

      await supabase
        .from("enquiry_conversation_links")
        .insert({
          conversation_id: conversationId,
          inquiry_id: inquiryId,
          link_type: linkType,
          is_active: true,
          created_by: actorId,
        })
        .catch(() => { /* idempotent ignore */ });
    }

    // Additional multi-product inquiries (.2, .3, etc.)
    if (Array.isArray(additionalInquiryIds)) {
      for (const addId of additionalInquiryIds) {
        if (!addId || addId === inquiryId) continue;
        await supabase
          .from("enquiry_conversation_links")
          .upsert(
            {
              conversation_id: conversationId,
              inquiry_id: addId,
              link_type: "related",
              is_active: true,
              created_by: actorId,
            },
            { onConflict: "conversation_id,inquiry_id" }
          )
          .catch(() => { /* idempotent ignore */ });
      }
    }
  }

  return {
    success: true,
    conversationId,
    messageId: canonicalMessageId,
    linkedInquiryId: inquiryId || null,
    isDuplicate,
  };
}

/**
 * Mirror inbound WhatsApp message from OpenWA transport adapter to canonical communication tables.
 */
export async function mirrorInboundWhatsApp(
  supabase: SupabaseClient,
  payload: WhatsAppInboundPayload
): Promise<MirrorResult> {
  const {
    messageId,
    chatId,
    senderPhone,
    senderName = null,
    businessPhone = null,
    text = null,
    receivedAt = new Date().toISOString(),
    isGroup = false,
    quotedMessage = null,
    attachments = [],
    rawPayload = null,
  } = payload;

  if (!messageId || !chatId || !senderPhone) {
    return {
      success: false,
      conversationId: null,
      messageId: null,
      linkedInquiryId: null,
      isDuplicate: false,
      error: "Missing required fields (messageId, chatId, senderPhone)",
    };
  }

  // 1. Thread scoping: Scope external_thread_id by business number if present
  const externalThreadId = businessPhone ? `${businessPhone}:${chatId}` : chatId;

  // Title
  const title = isGroup
    ? `WhatsApp Group: ${chatId}`
    : senderName
    ? `WhatsApp: ${senderName} (${senderPhone})`
    : `WhatsApp: ${senderPhone}`;

  const participants = [senderPhone, businessPhone].filter(Boolean) as string[];

  // Customer resolution by phone number
  let customerId: string | null = null;
  const cleanPhone = senderPhone.replace(/\D/g, "");
  if (cleanPhone.length >= 7) {
    const lastDigits = cleanPhone.slice(-8);
    const { data: cust } = await supabase
      .from("customers")
      .select("id")
      .ilike("phone", `%${lastDigits}%`)
      .limit(1)
      .maybeSingle();
    if (cust) customerId = cust.id;
  }

  const { id: conversationId } = await getOrCreateCanonicalConversation(
    supabase,
    externalThreadId,
    title,
    participants,
    receivedAt,
    customerId,
    "whatsapp"
  );

  // 2. Ingest message idempotently
  let canonicalMessageId: string | null = null;
  let isDuplicate = false;

  const { data: existingMsg } = await supabase
    .from("enquiry_conversation_messages")
    .select("id")
    .eq("channel", "whatsapp")
    .eq("external_message_id", messageId)
    .maybeSingle();

  if (existingMsg) {
    canonicalMessageId = existingMsg.id;
    isDuplicate = true;
  } else {
    const msgPayload = {
      conversation_id: conversationId,
      channel: "whatsapp",
      direction: "inbound",
      external_message_id: messageId,
      sender_address: senderPhone,
      sender_name: senderName,
      recipient_addresses: businessPhone ? [businessPhone] : [],
      subject: title,
      body_text: text,
      body_html: null,
      attachments: attachments || [],
      raw_payload: {
        ...(rawPayload || {}),
        isGroup,
        quotedMessage,
      },
      received_or_sent_at: receivedAt,
      actor_type: "system",
      actor_id: null,
      ai_processed: false,
      ai_summary: null,
    };

    const { data: insertedMsg, error: insertError } = await supabase
      .from("enquiry_conversation_messages")
      .insert(msgPayload)
      .select("id")
      .single();

    if (insertError) {
      if (insertError.code === "23505") {
        // Unique index collision on (channel, external_message_id)
        const { data: winnerMsg } = await supabase
          .from("enquiry_conversation_messages")
          .select("id")
          .eq("channel", "whatsapp")
          .eq("external_message_id", messageId)
          .single();
        canonicalMessageId = winnerMsg?.id || null;
        isDuplicate = true;
      } else {
        throw insertError;
      }
    } else {
      canonicalMessageId = insertedMsg.id;
    }
  }

  // 3. Strict Tier-1 Safe Inquiry Matching
  let targetInquiryId: string | null = null;

  // Signal 1: Existing active link on this conversation
  const { data: existingLink } = await supabase
    .from("enquiry_conversation_links")
    .select("inquiry_id")
    .eq("conversation_id", conversationId)
    .eq("is_active", true)
    .limit(1)
    .maybeSingle();

  if (existingLink) {
    targetInquiryId = existingLink.inquiry_id;
  }

  // Signal 2: Exact INQ number in text / caption
  if (!targetInquiryId && text) {
    const exactInqNo = extractExactInquiryNumber(text);
    if (exactInqNo) {
      const { data: inq } = await supabase
        .from("crm_inquiries")
        .select("id")
        .eq("inquiry_number", exactInqNo)
        .maybeSingle();
      if (inq) targetInquiryId = inq.id;
    }
  }

  // Create link if target inquiry resolved and not yet linked
  if (targetInquiryId) {
    const { data: linkExists } = await supabase
      .from("enquiry_conversation_links")
      .select("id")
      .eq("conversation_id", conversationId)
      .eq("inquiry_id", targetInquiryId)
      .maybeSingle();

    if (!linkExists) {
      const { data: activePrimary } = await supabase
        .from("enquiry_conversation_links")
        .select("id")
        .eq("inquiry_id", targetInquiryId)
        .eq("link_type", "primary")
        .eq("is_active", true)
        .maybeSingle();

      const linkType = activePrimary ? "related" : "primary";

      await supabase
        .from("enquiry_conversation_links")
        .insert({
          conversation_id: conversationId,
          inquiry_id: targetInquiryId,
          link_type: linkType,
          is_active: true,
        })
        .catch((err: any) => {
          if (err?.code === "23505") {
            return supabase.from("enquiry_conversation_links").insert({
              conversation_id: conversationId,
              inquiry_id: targetInquiryId,
              link_type: "related",
              is_active: true,
            });
          }
        });
    }
  }

  // 4. Inbound Media / Technical Document Ingestion
  if (attachments && attachments.length > 0 && !isDuplicate) {
    for (const att of attachments) {
      const fn = att.filename || "document";
      const fnLower = fn.toLowerCase();
      const isTechDoc =
        fnLower.endsWith(".pdf") ||
        fnLower.endsWith(".png") ||
        fnLower.endsWith(".jpg") ||
        fnLower.endsWith(".jpeg") ||
        att.mimeType?.includes("pdf") ||
        att.mimeType?.includes("image");

      if (isTechDoc && targetInquiryId) {
        let docType = "OTHER";
        if (fnLower.includes("coa")) docType = "COA";
        else if (fnLower.includes("msds") || fnLower.includes("sds")) docType = "MSDS";
        else if (fnLower.includes("spec") || fnLower.includes("tds")) docType = "SPEC";

        const storagePath = att.storagePath || `whatsapp/${chatId}/${messageId}_${fn}`;

        // Insert into crm_product_documents if not already recorded
        const { data: existingDoc } = await supabase
          .from("crm_product_documents")
          .select("id")
          .eq("storage_path", storagePath)
          .maybeSingle();

        if (!existingDoc) {
          const { data: insertedDoc } = await supabase
            .from("crm_product_documents")
            .insert({
              inquiry_id: targetInquiryId,
              document_type: docType,
              original_file_name: fn,
              display_file_name: fn,
              storage_bucket: "crm-documents",
              storage_path: storagePath,
              source_email_subject: title,
              ai_extraction: null,
            })
            .select("id")
            .single();

          // If document was recorded, trigger 7.6E Document Intelligence if environment is configured
          if (insertedDoc?.id) {
            const supabaseUrl = typeof Deno !== "undefined" ? Deno.env.get("SUPABASE_URL") : null;
            const serviceKey = typeof Deno !== "undefined" ? Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") : null;
            if (supabaseUrl && serviceKey) {
              fetch(`${supabaseUrl}/functions/v1/enquiry-brain-document`, {
                method: "POST",
                headers: {
                  "Content-Type": "application/json",
                  "Authorization": `Bearer ${serviceKey}`,
                },
                body: JSON.stringify({ document_id: insertedDoc.id }),
              }).catch((docErr) => {
                console.error(`[WhatsApp Document] Error triggering document intelligence for ${insertedDoc.id}:`, docErr);
              });
            }
          }
        }
      }
    }
  }

  // 5. Trigger Enquiry Brain automatic analysis for new canonical inbound messages
  if (!isDuplicate && canonicalMessageId) {
    const isEligible = isEligibleForEnquiryBrainAnalysis({
      direction: "inbound",
      channel: "whatsapp",
      bodyText: text,
      bodyHtml: null,
      subject: title,
    });

    if (isEligible) {
      triggerEnquiryBrainAnalysis(supabase, canonicalMessageId).catch((aiErr) => {
        console.error(`[Canonical Ingestion] WhatsApp auto analysis trigger error for message ${canonicalMessageId}:`, aiErr);
      });
    }
  }

  return {
    success: true,
    conversationId,
    messageId: canonicalMessageId,
    linkedInquiryId: targetInquiryId,
    isDuplicate,
  };
}

/**
 * Mirror outbound WhatsApp reply to canonical communication tables.
 */
export async function mirrorOutboundWhatsApp(
  supabase: SupabaseClient,
  payload: WhatsAppOutboundPayload
): Promise<MirrorResult> {
  const {
    messageId,
    conversationId,
    recipientPhone,
    text,
    actorId,
    draftMessageId = null,
    sentAt = new Date().toISOString(),
    rawPayload = null,
  } = payload;

  if (!messageId || !conversationId || !recipientPhone || !actorId) {
    return {
      success: false,
      conversationId: null,
      messageId: null,
      linkedInquiryId: null,
      isDuplicate: false,
      error: "Missing required outbound WhatsApp parameters",
    };
  }

  // Verify conversation exists
  const { data: conv, error: convErr } = await supabase
    .from("enquiry_conversations")
    .select("id, participant_identifiers, channel")
    .eq("id", conversationId)
    .maybeSingle();

  if (convErr || !conv) {
    return {
      success: false,
      conversationId,
      messageId: null,
      linkedInquiryId: null,
      isDuplicate: false,
      error: `Conversation ${conversationId} not found`,
    };
  }

  // Check duplicate external message id
  const { data: existingMsg } = await supabase
    .from("enquiry_conversation_messages")
    .select("id")
    .eq("channel", "whatsapp")
    .eq("external_message_id", messageId)
    .maybeSingle();

  let canonicalMessageId: string | null = null;
  let isDuplicate = false;

  if (existingMsg) {
    canonicalMessageId = existingMsg.id;
    isDuplicate = true;
  } else {
    const businessNumber = (conv.participant_identifiers || []).find((p: string) => p !== recipientPhone) || "system";

    const msgPayload = {
      conversation_id: conversationId,
      channel: "whatsapp",
      direction: "outbound",
      external_message_id: messageId,
      sender_address: businessNumber,
      sender_name: "Staff",
      recipient_addresses: [recipientPhone],
      subject: "WhatsApp Outbound Reply",
      body_text: text,
      body_html: null,
      attachments: [],
      raw_payload: rawPayload || {},
      received_or_sent_at: sentAt,
      actor_type: "user",
      actor_id: actorId,
      ai_processed: false,
      ai_summary: null,
    };

    const { data: insertedMsg, error: insertError } = await supabase
      .from("enquiry_conversation_messages")
      .insert(msgPayload)
      .select("id")
      .single();

    if (insertError) {
      if (insertError.code === "23505") {
        const { data: winnerMsg } = await supabase
          .from("enquiry_conversation_messages")
          .select("id")
          .eq("channel", "whatsapp")
          .eq("external_message_id", messageId)
          .single();
        canonicalMessageId = winnerMsg?.id || null;
        isDuplicate = true;
      } else {
        throw insertError;
      }
    } else {
      canonicalMessageId = insertedMsg.id;
    }
  }

  // Update conversation last_message_at
  await supabase
    .from("enquiry_conversations")
    .update({ last_message_at: sentAt })
    .eq("id", conversationId);

  // If this reply fulfilled an AI reply draft, update the draft status atomically
  if (draftMessageId && canonicalMessageId) {
    const { data: triggerMsg } = await supabase
      .from("enquiry_conversation_messages")
      .select("ai_reply_draft")
      .eq("id", draftMessageId)
      .maybeSingle();

    if (triggerMsg?.ai_reply_draft) {
      const updatedDraft = {
        ...triggerMsg.ai_reply_draft,
        status: "sent",
        sent_at: sentAt,
        sent_message_id: canonicalMessageId,
      };
      await supabase
        .from("enquiry_conversation_messages")
        .update({ ai_reply_draft: updatedDraft })
        .eq("id", draftMessageId);
    }
  }

  // Find linked inquiry if any
  const { data: link } = await supabase
    .from("enquiry_conversation_links")
    .select("inquiry_id")
    .eq("conversation_id", conversationId)
    .eq("is_active", true)
    .limit(1)
    .maybeSingle();

  return {
    success: true,
    conversationId,
    messageId: canonicalMessageId,
    linkedInquiryId: link?.inquiry_id || null,
    isDuplicate,
  };
}

/**
 * Inbound Anti-Join Reconciliation Sweep.
 * Finds unmirrored rows in crm_email_inbox and mirrors them to canonical tables.
 */
export async function runInboundReconciliationSweep(
  supabase: SupabaseClient,
  limit = 50
): Promise<{ checked: number; reconciled: number; errors: string[] }> {
  // Query crm_email_inbox records where message_id is not yet in enquiry_conversation_messages
  const { data: unmirrored, error: qError } = await supabase
    .from("crm_email_inbox")
    .select(`
      id,
      message_id,
      thread_id,
      from_email,
      from_name,
      to_email,
      subject,
      body,
      body_html,
      received_date,
      has_attachments,
      attachment_urls,
      converted_to_inquiry
    `)
    .not("message_id", "is", null)
    .order("received_date", { ascending: false })
    .limit(limit);

  if (qError || !unmirrored || unmirrored.length === 0) {
    return { checked: 0, reconciled: 0, errors: qError ? [qError.message] : [] };
  }

  // Filter against canonical messages in one batch
  const messageIds = unmirrored.map((r: any) => r.message_id);
  const { data: existingCanonical } = await supabase
    .from("enquiry_conversation_messages")
    .select("external_message_id")
    .eq("channel", "email")
    .in("external_message_id", messageIds);

  const existingSet = new Set((existingCanonical || []).map((r: any) => r.external_message_id));
  const missing = unmirrored.filter((r: any) => !existingSet.has(r.message_id));

  let reconciledCount = 0;
  const errors: string[] = [];

  for (const item of missing) {
    try {
      const res = await mirrorInboundEmail(supabase, {
        messageId: item.message_id,
        threadId: item.thread_id || item.message_id,
        fromEmail: item.from_email,
        fromName: item.from_name,
        toEmails: item.to_email ? [item.to_email] : [],
        subject: item.subject || "(No Subject)",
        bodyText: item.body,
        bodyHtml: item.body_html,
        receivedAt: item.received_date,
        attachments: (item.attachment_urls || []).map((url: string) => ({
          filename: url.split("/").pop() || "attachment",
          storagePath: url,
        })),
        legacyInboxId: item.id,
        convertedToInquiry: item.converted_to_inquiry,
      });
      if (res.success) reconciledCount += 1;
    } catch (err: any) {
      errors.push(`Failed to reconcile inbox id ${item.id}: ${err?.message}`);
    }
  }

  // Periodic recovery sweep: analyze any pending/unprocessed inbound canonical messages
  try {
    await runPendingEnquiryBrainAnalysisSweep(supabase);
  } catch (aiSweepErr: any) {
    console.error("[Canonical Ingestion] Enquiry Brain pending sweep error:", aiSweepErr);
  }

  return { checked: unmirrored.length, reconciled: reconciledCount, errors };
}

/**
 * Check if a canonical message is eligible for automatic Enquiry Brain analysis.
 */
export function isEligibleForEnquiryBrainAnalysis(message: {
  direction: string;
  channel?: string;
  bodyText?: string | null;
  bodyHtml?: string | null;
  subject?: string | null;
}): boolean {
  if (message.direction !== "inbound") return false;
  if (message.channel && message.channel !== "email" && message.channel !== "whatsapp") return false;
  const content = `${message.subject || ""} ${message.bodyText || ""} ${message.bodyHtml || ""}`.trim();
  return content.length > 0;
}

/**
 * Triggers non-blocking background analysis of an inbound canonical message.
 */
export async function triggerEnquiryBrainAnalysis(
  supabase: SupabaseClient,
  messageId: string,
  options?: {
    supabaseUrl?: string;
    serviceKey?: string;
    force?: boolean;
  }
): Promise<{ triggered: boolean; error?: string }> {
  try {
    const supabaseUrl = options?.supabaseUrl || (typeof Deno !== "undefined" ? Deno.env.get("SUPABASE_URL") : null);
    const serviceKey = options?.serviceKey || (typeof Deno !== "undefined" ? Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") : null);

    // If environment variables are missing (e.g. offline/testing), ensure message has pending marker
    if (!supabaseUrl || !serviceKey) {
      await supabase
        .from("enquiry_conversation_messages")
        .update({
          ai_proposal: {
            status: "pending",
            queued_at: new Date().toISOString(),
          },
        })
        .eq("id", messageId)
        .is("ai_proposal", null);

      return { triggered: false, error: "SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY not configured" };
    }

    // Set pending status before dispatching
    await supabase
      .from("enquiry_conversation_messages")
      .update({
        ai_proposal: {
          status: "pending",
          queued_at: new Date().toISOString(),
        },
      })
      .eq("id", messageId)
      .is("ai_proposal", null);

    const callPromise = fetch(`${supabaseUrl}/functions/v1/enquiry-brain-analyze`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Authorization": `Bearer ${serviceKey}`,
      },
      body: JSON.stringify({
        message_id: messageId,
        force_reanalyze: !!options?.force,
      }),
    }).catch((err) => {
      console.error(`[EnquiryBrain Trigger] Asynchronous invocation error for message ${messageId}:`, err);
    });

    if (typeof (globalThis as any).EdgeRuntime?.waitUntil === "function") {
      (globalThis as any).EdgeRuntime.waitUntil(callPromise);
    }

    return { triggered: true };
  } catch (err: any) {
    console.error(`[EnquiryBrain Trigger] Failed to trigger analysis for message ${messageId}:`, err);
    return { triggered: false, error: err.message };
  }
}

/**
 * Sweeps for unanalyzed or failed (retryable) inbound canonical messages and triggers analysis.
 */
export async function runPendingEnquiryBrainAnalysisSweep(
  supabase: SupabaseClient,
  options?: {
    supabaseUrl?: string;
    serviceKey?: string;
    limit?: number;
  }
): Promise<{ checked: number; triggered: number; errors: string[] }> {
  const limit = options?.limit || 10;
  const errors: string[] = [];

  try {
    const { data: pendingMsgs, error: qErr } = await supabase
      .from("enquiry_conversation_messages")
      .select("id, subject, body_text, body_html, ai_proposal, ai_processed, created_at, channel")
      .eq("direction", "inbound")
      .in("channel", ["email", "whatsapp"])
      .eq("ai_processed", false)
      .order("created_at", { ascending: false })
      .limit(limit);

    if (qErr) {
      errors.push(`Query pending messages failed: ${qErr.message}`);
      return { checked: 0, triggered: 0, errors };
    }

    if (!pendingMsgs || pendingMsgs.length === 0) {
      return { checked: 0, triggered: 0, errors: [] };
    }

    let triggeredCount = 0;
    const now = Date.now();

    for (const msg of pendingMsgs) {
      const proposal = msg.ai_proposal as any;

      // Skip if actively processing within last 5 minutes
      if (proposal?.status === "processing" && proposal.started_at) {
        const elapsed = now - new Date(proposal.started_at).getTime();
        if (elapsed < 5 * 60 * 1000) {
          continue;
        }
      }

      // Skip if max retries exceeded
      if (proposal?.status === "failed" && (proposal.retry_count || 0) >= 3) {
        continue;
      }

      // Skip empty content
      if (!isEligibleForEnquiryBrainAnalysis({
        direction: "inbound",
        channel: msg.channel || "email",
        bodyText: msg.body_text,
        bodyHtml: msg.body_html,
        subject: msg.subject,
      })) {
        continue;
      }

      const res = await triggerEnquiryBrainAnalysis(supabase, msg.id, options);
      if (res.triggered) {
        triggeredCount++;
      } else if (res.error) {
        errors.push(`Message ${msg.id}: ${res.error}`);
      }
    }

    return { checked: pendingMsgs.length, triggered: triggeredCount, errors };
  } catch (err: any) {
    errors.push(`Sweep error: ${err.message}`);
    return { checked: 0, triggered: 0, errors };
  }
}

/**
 * Outbound Reconciliation Sweep.
 * Discovers unmirrored outbound emails from legacy outbound records:
 *   1. Primary: crm_email_activities (where gmail_message_id IS NOT NULL)
 *   2. Secondary: email_thread_map (where gmail_message_id IS NOT NULL)
 * Strictly adheres to Safety Rule 5: NEVER fabricates sender, recipients, body, or inquiry context.
 */
export async function runOutboundReconciliationSweep(
  supabase: SupabaseClient,
  limit = 50
): Promise<{ checked: number; reconciled: number; errors: string[] }> {
  let reconciledCount = 0;
  const errors: string[] = [];
  let checkedCount = 0;

  // -------------------------------------------------------------
  // 1. Primary Source: crm_email_activities with gmail_message_id
  // -------------------------------------------------------------
  const { data: unmirroredActivities, error: actError } = await supabase
    .from("crm_email_activities")
    .select(`
      id,
      inquiry_id,
      contact_id,
      from_email,
      to_email,
      cc_email,
      bcc_email,
      subject,
      body,
      attachment_urls,
      sent_date,
      created_by,
      gmail_message_id,
      gmail_thread_id
    `)
    .not("gmail_message_id", "is", null)
    .order("sent_date", { ascending: false })
    .limit(limit);

  if (actError) {
    errors.push(`Failed to query crm_email_activities: ${actError.message}`);
  } else if (unmirroredActivities && unmirroredActivities.length > 0) {
    checkedCount += unmirroredActivities.length;
    const actMsgIds = unmirroredActivities.map((r: any) => r.gmail_message_id);

    const { data: existingCanon } = await supabase
      .from("enquiry_conversation_messages")
      .select("external_message_id")
      .eq("channel", "email")
      .in("external_message_id", actMsgIds);

    const existingSet = new Set((existingCanon || []).map((r: any) => r.external_message_id));
    const missingActs = unmirroredActivities.filter((r: any) => !existingSet.has(r.gmail_message_id));

    for (const act of missingActs) {
      try {
        const toList = Array.isArray(act.to_email) ? act.to_email : (act.to_email ? [act.to_email] : []);
        const ccList = Array.isArray(act.cc_email) ? act.cc_email : [];
        const bccList = Array.isArray(act.bcc_email) ? act.bcc_email : [];
        const attachments: InboundAttachmentDescriptor[] = Array.isArray(act.attachment_urls)
          ? act.attachment_urls.map((url: string) => ({
              filename: url.split("/").pop() || "attachment",
              storagePath: url,
            }))
          : [];

        if (!act.from_email || toList.length === 0) {
          errors.push(
            `Cannot faithfully reconstruct outbound activity ${act.id} (${act.gmail_message_id}): missing sender or recipients`
          );
          continue;
        }

        const res = await mirrorOutboundEmail(supabase, {
          messageId: act.gmail_message_id,
          threadId: act.gmail_thread_id || act.gmail_message_id,
          fromEmail: act.from_email,
          toEmails: toList,
          ccEmails: ccList,
          bccEmails: bccList,
          subject: act.subject || "(No Subject)",
          bodyText: null,
          bodyHtml: act.body || null,
          sentAt: act.sent_date,
          actorId: act.created_by,
          inquiryId: act.inquiry_id || null,
          attachments,
        });

        if (res.success) reconciledCount += 1;
      } catch (actErr: any) {
        errors.push(`Failed to reconcile activity id ${act.id}: ${actErr?.message}`);
      }
    }
  }

  // -------------------------------------------------------------
  // 2. Secondary Source: email_thread_map with gmail_message_id
  // -------------------------------------------------------------
  const { data: unmirroredThreadMap, error: tmError } = await supabase
    .from("email_thread_map")
    .select(`
      id,
      gmail_message_id,
      gmail_thread_id,
      price_request_id,
      subject,
      sent_at,
      created_by
    `)
    .not("gmail_message_id", "is", null)
    .order("sent_at", { ascending: false })
    .limit(limit);

  if (tmError) {
    errors.push(`Failed to query email_thread_map: ${tmError.message}`);
  } else if (unmirroredThreadMap && unmirroredThreadMap.length > 0) {
    checkedCount += unmirroredThreadMap.length;
    const tmMsgIds = unmirroredThreadMap.map((r: any) => r.gmail_message_id);

    const { data: existingCanonTm } = await supabase
      .from("enquiry_conversation_messages")
      .select("external_message_id")
      .eq("channel", "email")
      .in("external_message_id", tmMsgIds);

    const existingTmSet = new Set((existingCanonTm || []).map((r: any) => r.external_message_id));
    const missingTms = unmirroredThreadMap.filter((r: any) => !existingTmSet.has(r.gmail_message_id));

    for (const item of missingTms) {
      try {
        let inquiryId: string | null = null;
        if (item.price_request_id) {
          const { data: pr } = await supabase
            .from("crm_inquiry_prices")
            .select("inquiry_id")
            .eq("id", item.price_request_id)
            .maybeSingle();
          if (pr) inquiryId = pr.inquiry_id;
        }

        // Correlate with crm_email_activities to find authentic communication content
        let fromEmail: string | null = null;
        let toEmails: string[] = [];
        let ccEmails: string[] = [];
        let bccEmails: string[] = [];
        let bodyHtml: string | null = null;
        let attachments: InboundAttachmentDescriptor[] = [];

        const { data: activity } = await supabase
          .from("crm_email_activities")
          .select("from_email, to_email, cc_email, bcc_email, body, attachment_urls")
          .or(`gmail_message_id.eq.${item.gmail_message_id},and(subject.eq.${item.subject || ""},inquiry_id.eq.${inquiryId || "00000000-0000-0000-0000-000000000000"})`)
          .order("sent_date", { ascending: false })
          .limit(1)
          .maybeSingle();

        if (activity) {
          fromEmail = activity.from_email || null;
          toEmails = Array.isArray(activity.to_email) ? activity.to_email : (activity.to_email ? [activity.to_email] : []);
          ccEmails = Array.isArray(activity.cc_email) ? activity.cc_email : [];
          bccEmails = Array.isArray(activity.bcc_email) ? activity.bcc_email : [];
          bodyHtml = activity.body || null;
          if (Array.isArray(activity.attachment_urls)) {
            attachments = activity.attachment_urls.map((url: string) => ({
              filename: url.split("/").pop() || "attachment",
              storagePath: url,
            }));
          }
        }

        // Safety Rule 5: If sender/recipients cannot be faithfully resolved, DO NOT FABRICATE DEFAULTS
        if (!fromEmail || toEmails.length === 0) {
          errors.push(
            `Cannot faithfully reconstruct outbound message ${item.gmail_message_id}: lacks sender/recipient data and no matching crm_email_activities record was found`
          );
          continue;
        }

        const res = await mirrorOutboundEmail(supabase, {
          messageId: item.gmail_message_id,
          threadId: item.gmail_thread_id || item.gmail_message_id,
          fromEmail,
          toEmails,
          ccEmails,
          bccEmails,
          subject: item.subject || "(No Subject)",
          bodyText: null,
          bodyHtml,
          sentAt: item.sent_at,
          actorId: item.created_by,
          inquiryId,
          attachments,
        });

        if (res.success) reconciledCount += 1;
      } catch (err: any) {
        errors.push(`Failed to reconcile thread map id ${item.id}: ${err?.message}`);
      }
    }
  }

  return { checked: checkedCount, reconciled: reconciledCount, errors };
}
