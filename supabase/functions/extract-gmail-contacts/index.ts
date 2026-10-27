import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from 'jsr:@supabase/supabase-js@2';
import { requireRole, writeSecurityAudit } from "../_shared/security.ts";
import { getGmailConnectionSecret } from "../_shared/gmailSecrets.ts";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, POST, PUT, DELETE, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type, Authorization, X-Client-Info, Apikey",
};

const INTERNAL_DOMAINS = ['sapharmajaya.co.id', 'anzen.co.in', 'shubham.co.in', 'shubham.com'];
const INTERNAL_EMAILS = ['lunkad.v@gmail.com', 'sumathi.lunkad@gmail.com'];
const OWN_COMPANY_NAMES = [
  'pt shubham anzen pharma jaya',
  'shubham anzen pharma',
  'shubham anzen',
  'sa pharma jaya',
  'sapharmajaya',
];
const BATCH_SIZE = 10;

interface ExtractedContact {
  companyName: string;
  customerName: string;
  emailIds: string[];
  phone: string;
  mobile: string;
  website: string;
  address: string;
  source: string;
  confidence: number;
}

interface EmailData {
  messageId: string;
  fromEmail: string;
  fromName?: string;
  subject: string;
  body: string;
}

function isInternalEmail(email: string): boolean {
  const lowerEmail = email.toLowerCase();
  if (INTERNAL_EMAILS.some(internal => lowerEmail === internal.toLowerCase())) return true;
  const domain = email.split('@')[1]?.toLowerCase();
  return INTERNAL_DOMAINS.some(d => domain === d);
}

function isNoReply(email: string): boolean {
  return /noreply|no-reply|donotreply|mailer-daemon|notifications@|support@|info@dochub|tom@dochub/i.test(email);
}

function isGenericDomain(domain: string): boolean {
  return ['gmail.com', 'yahoo.com', 'hotmail.com', 'outlook.com', 'live.com', 'icloud.com'].includes(domain.toLowerCase());
}

function isOwnCompanyName(name: string): boolean {
  if (!name) return false;
  const lower = name.toLowerCase().trim();
  return OWN_COMPANY_NAMES.some(own => lower.includes(own) || own.includes(lower));
}

function isValidPersonName(name: string): boolean {
  if (!name || name.length < 2 || name.length > 60) return false;
  if (/^(dear|hi|hello|regards|thanks|best|sincerely|thank you|we |i |our |your |the |this |that |it |please|sorry|greetings|to whom|purchasing|sales|marketing|admin|info|accounts|support)/i.test(name.trim())) return false;
  if (/\d{5,}/.test(name)) return false;
  if (name.includes('@')) return false;
  return true;
}

async function refreshAccessToken(
  refreshToken: string,
  clientId: string,
  clientSecret: string
): Promise<string | null> {
  try {
    const response = await fetch('https://oauth2.googleapis.com/token', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        client_id: clientId,
        client_secret: clientSecret,
        refresh_token: refreshToken,
        grant_type: 'refresh_token',
      }).toString(),
    });

    if (!response.ok) {
      console.error('Token refresh failed:', response.status, await response.text());
      return null;
    }

    const data = await response.json();
    return data.access_token || null;
  } catch (error) {
    console.error('Token refresh error:', error);
    return null;
  }
}

async function gmailFetchWithRefresh(
  url: string,
  accessToken: string,
  refreshToken: string,
  clientId: string,
  clientSecret: string,
  supabaseClient: any,
  connectionId: string
): Promise<{ response: Response; newAccessToken: string }> {
  let response = await fetch(url, {
    headers: { 'Authorization': `Bearer ${accessToken}` },
  });

  if (response.status === 401) {
    console.log('Access token expired, refreshing...');
    const newToken = await refreshAccessToken(refreshToken, clientId, clientSecret);
    if (!newToken) {
      throw new Error('Gmail token expired and refresh failed. Please reconnect Gmail in Settings.');
    }

    await supabaseClient
      .from('gmail_connections')
      .update({
        access_token: newToken,
        access_token_expires_at: new Date(Date.now() + 3600 * 1000).toISOString(),
        updated_at: new Date().toISOString(),
      })
      .eq('id', connectionId);

    response = await fetch(url, {
      headers: { 'Authorization': `Bearer ${newToken}` },
    });

    return { response, newAccessToken: newToken };
  }

  return { response, newAccessToken: accessToken };
}

async function extractContactsBatchWithAI(
  emails: EmailData[],
  openaiApiKey: string
): Promise<Map<string, Partial<ExtractedContact>>> {
  const results = new Map<string, Partial<ExtractedContact>>();

  const emailList = emails.map((e, i) =>
    `[${i + 1}] SENDER_EMAIL: ${e.fromEmail} | SENDER_NAME_HEADER: ${e.fromName || 'N/A'} | SUBJECT: ${e.subject.substring(0, 80)}\nBODY:\n${e.body.substring(0, 600)}`
  ).join('\n\n===\n\n');

  const prompt = `You are extracting the SENDER's business contact info from ${emails.length} emails.

CRITICAL RULES:
1. You are extracting info about the SENDER of each email (the person who WROTE the email to us)
2. The SENDER's email is given as SENDER_EMAIL - this is the contact's email
3. Extract the SENDER's company from their EMAIL SIGNATURE at the BOTTOM of the email body
4. IGNORE any company names in the email body paragraphs (those are mentions of other companies)
5. The company name "PT Shubham Anzen Pharma Jaya" or "SA Pharma" is OUR company - NEVER use it as a result
6. If the sender is from a corporate domain (e.g. trifa.co.id, sanbe-farma.com, pyfa.co.id), derive company from that domain
7. customerName = the real person's name from the signature block (bottom of email), NOT from greetings or body text
8. phone/mobile = only from the SENDER's signature block at the bottom
9. If you cannot find a clear company or person name, return confidence 0.3

Emails to process:
${emailList}

Return ONLY a JSON array of exactly ${emails.length} objects:
[{"companyName":"","customerName":"","phone":"","mobile":"","website":"","confidence":0.0}, ...]

No markdown, no explanation, just the JSON array.`;

  try {
    const response = await fetch('https://api.openai.com/v1/chat/completions', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${openaiApiKey}`,
      },
      body: JSON.stringify({
        model: 'gpt-3.5-turbo',
        messages: [
          { role: 'system', content: 'You extract business contact info from email signatures. Return ONLY valid JSON arrays. Never include PT Shubham Anzen Pharma Jaya as a result - that is the email account owner.' },
          { role: 'user', content: prompt }
        ],
        temperature: 0.0,
        max_tokens: 200 * emails.length,
      }),
    });

    if (!response.ok) {
      console.error('OpenAI batch error:', response.status, await response.text());
      return results;
    }

    const data = await response.json();
    let content = data.choices[0]?.message?.content?.trim() || '[]';
    content = content.replace(/```json\s*/g, '').replace(/```\s*/g, '').trim();

    const extracted = JSON.parse(content);
    if (!Array.isArray(extracted)) return results;

    for (let i = 0; i < emails.length; i++) {
      const item = extracted[i];
      if (!item) continue;

      let companyName = (item.companyName || '').trim();
      let customerName = (item.customerName || '').trim();

      if (isOwnCompanyName(companyName)) companyName = '';
      if (!isValidPersonName(customerName)) {
        customerName = emails[i].fromName && isValidPersonName(emails[i].fromName!) ? emails[i].fromName! : '';
      }

      const domain = emails[i].fromEmail.split('@')[1] || '';
      if (!companyName && !isGenericDomain(domain)) {
        const parts = domain.replace('.co.id', '').replace('.co.', '').replace('.com', '').split('.');
        const base = parts[0] || '';
        if (base.length > 2) companyName = base.charAt(0).toUpperCase() + base.slice(1);
      }

      if (isOwnCompanyName(companyName)) companyName = '';

      results.set(emails[i].messageId, {
        companyName,
        customerName: customerName || emails[i].fromEmail.split('@')[0],
        phone: item.phone || '',
        mobile: item.mobile || '',
        website: item.website || '',
        address: '',
        confidence: Number(item.confidence) || 0.3,
        emailIds: [emails[i].fromEmail],
        source: 'Gmail',
      });
    }
  } catch (error) {
    console.error('Batch AI extraction error:', error);
  }

  return results;
}

function getEmailBody(message: any): string {
  let body = '';
  if (message.payload.body?.data) {
    body = atob(message.payload.body.data.replace(/-/g, '+').replace(/_/g, '/'));
  } else if (message.payload.parts) {
    for (const part of message.payload.parts) {
      if (part.mimeType === 'text/plain' && part.body?.data) {
        body += atob(part.body.data.replace(/-/g, '+').replace(/_/g, '/'));
      } else if (part.parts) {
        for (const subpart of part.parts) {
          if (subpart.mimeType === 'text/plain' && subpart.body?.data) {
            body += atob(subpart.body.data.replace(/-/g, '+').replace(/_/g, '/'));
          }
        }
      }
    }
  }
  return body.substring(0, 800);
}

function extractFromHeader(headers: any[]): { email: string; name?: string } | null {
  const fromHeader = headers.find((h: any) => h.name.toLowerCase() === 'from');
  if (!fromHeader) return null;
  const nameEmail = /^(.+?)\s*<([^>]+)>/.exec(fromHeader.value);
  if (nameEmail) return { name: nameEmail[1].replace(/"/g, '').trim(), email: nameEmail[2].trim() };
  const emailOnly = /([^\s<>]+@[^\s<>]+)/.exec(fromHeader.value);
  if (emailOnly) return { email: emailOnly[1].trim() };
  return null;
}

function getSubject(headers: any[]): string {
  return headers.find((h: any) => h.name.toLowerCase() === 'subject')?.value || '';
}

async function fetchAllGmailMessages(
  accessToken: string,
  refreshToken: string,
  clientId: string,
  clientSecret: string,
  maxResults: number,
  supabaseClient: any,
  connectionId: string,
  userId: string
): Promise<{ messages: any[]; currentToken: string }> {
  const { data: processedMessages } = await supabaseClient
    .from('gmail_processed_messages')
    .select('gmail_message_id')
    .eq('connection_id', connectionId)
    .eq('user_id', userId);

  const processedIds = new Set((processedMessages || []).map((m: any) => m.gmail_message_id));
  console.log(`Already processed: ${processedIds.size} messages`);

  const messages: any[] = [];
  let pageToken = '';
  let pagesFetched = 0;
  const MAX_PAGES = 50;
  let currentToken = accessToken;

  while (messages.length < maxResults && pagesFetched < MAX_PAGES) {
    const listUrl = `https://gmail.googleapis.com/gmail/v1/users/me/messages?maxResults=100${pageToken ? `&pageToken=${pageToken}` : ''}`;

    const { response: listResponse, newAccessToken } = await gmailFetchWithRefresh(
      listUrl, currentToken, refreshToken, clientId, clientSecret, supabaseClient, connectionId
    );
    currentToken = newAccessToken;

    if (!listResponse.ok) throw new Error(`Gmail list error: ${listResponse.status}`);
    const listData = await listResponse.json();
    pagesFetched++;

    if (!listData.messages?.length) break;

    const newIds = listData.messages.filter((m: any) => !processedIds.has(m.id));

    const batchFetch = newIds.slice(0, maxResults - messages.length).map(async (msg: any) => {
      const detailUrl = `https://gmail.googleapis.com/gmail/v1/users/me/messages/${msg.id}?format=full`;
      const { response: detailResponse } = await gmailFetchWithRefresh(
        detailUrl, currentToken, refreshToken, clientId, clientSecret, supabaseClient, connectionId
      );
      if (detailResponse.ok) return detailResponse.json();
      return null;
    });

    const fetched = await Promise.all(batchFetch);
    for (const msg of fetched) {
      if (msg) messages.push(msg);
    }

    if (!listData.nextPageToken || messages.length >= maxResults) break;
    pageToken = listData.nextPageToken;
  }

  console.log(`Fetched ${messages.length} new messages`);
  return { messages, currentToken };
}

async function markMessagesProcessed(
  supabase: any,
  userId: string,
  connectionId: string,
  messageIds: string[],
  contactsExtracted: number,
  extractionData: any
): Promise<void> {
  const CHUNK = 50;
  for (let i = 0; i < messageIds.length; i += CHUNK) {
    const chunk = messageIds.slice(i, i + CHUNK);
    await supabase.from('gmail_processed_messages').upsert(
      chunk.map(msgId => ({
        user_id: userId,
        connection_id: connectionId,
        gmail_message_id: msgId,
        contacts_extracted: contactsExtracted,
        extraction_data: extractionData,
      })),
      { onConflict: 'connection_id,gmail_message_id' }
    );
  }
}

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") {
    return new Response(null, { status: 200, headers: corsHeaders });
  }

  try {
    const { max_emails = 2000, connection_id } = await req.json();

    if (!connection_id) {
      return new Response(
        JSON.stringify({ error: 'connection_id is required', success: false }),
        { status: 400, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
      );
    }

    const openaiApiKey = Deno.env.get('OPENAI_API_KEY');
    if (!openaiApiKey) {
      return new Response(
        JSON.stringify({ error: 'OpenAI API key not configured', success: false }),
        { status: 500, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
      );
    }

    const supabaseUrl = Deno.env.get('SUPABASE_URL')!;
    const supabaseServiceKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!;
    const authResult = await requireRole(req, supabaseUrl, supabaseServiceKey, ["admin", "manager", "sales"], corsHeaders);
    if (!authResult.ok) return authResult.response;
    const supabase = authResult.adminClient;
    const user_id = authResult.auth.user.id;

    const connection = await getGmailConnectionSecret(supabase, { connectionId: connection_id, userId: user_id });

    if (!connection) {
      return new Response(
        JSON.stringify({ error: 'Gmail connection not found for authenticated user', success: false }),
        { status: 403, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
      );
    }

    const googleClientId = Deno.env.get('GOOGLE_CLIENT_ID') || Deno.env.get('GMAIL_CLIENT_ID') || '';
    const googleClientSecret = Deno.env.get('GOOGLE_CLIENT_SECRET') || Deno.env.get('GMAIL_CLIENT_SECRET') || '';

    await writeSecurityAudit(supabase, authResult.auth, "extract_gmail_contacts_started", {
      function_name: "extract-gmail-contacts",
      connection_id,
      requested_max_emails: max_emails,
    });

    const safeMax = Math.min(max_emails, 500);
    console.log(`Fetching up to ${safeMax} new emails...`);

    const { messages } = await fetchAllGmailMessages(
      connection.access_token, connection.refresh_token || '', googleClientId, googleClientSecret,
      safeMax, supabase, connection_id, user_id
    );

    if (messages.length === 0) {
      return new Response(
        JSON.stringify({
          success: true,
          total_emails_scanned: 0,
          total_contacts: 0,
          contacts: [],
          message: 'All emails already processed. No new emails found.'
        }),
        { headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
      );
    }

    const emailsToProcess: EmailData[] = [];
    const skipIds: string[] = [];

    for (const message of messages) {
      const headers = message.payload?.headers || [];
      const from = extractFromHeader(headers);
      if (!from || isInternalEmail(from.email) || isNoReply(from.email)) {
        skipIds.push(message.id);
        continue;
      }
      emailsToProcess.push({
        messageId: message.id,
        fromEmail: from.email,
        fromName: from.name,
        subject: getSubject(headers),
        body: getEmailBody(message),
      });
    }

    console.log(`Skipped ${skipIds.length}, processing ${emailsToProcess.length} emails in batches of ${BATCH_SIZE}...`);

    if (skipIds.length > 0) {
      await markMessagesProcessed(supabase, user_id, connection_id, skipIds, 0, null);
    }

    const contactsMap = new Map<string, ExtractedContact>();
    const allProcessedIds: string[] = [];

    for (let i = 0; i < emailsToProcess.length; i += BATCH_SIZE) {
      const batch = emailsToProcess.slice(i, i + BATCH_SIZE);
      const batchResults = await extractContactsBatchWithAI(batch, openaiApiKey);

      const batchProcessedIds: string[] = [];

      for (const emailData of batch) {
        const result = batchResults.get(emailData.messageId);
        const domain = emailData.fromEmail.split('@')[1] || '';

        batchProcessedIds.push(emailData.messageId);
        allProcessedIds.push(emailData.messageId);

        if (result && result.confidence && result.confidence >= 0.4) {
          const companyKey = isGenericDomain(domain)
            ? (result.companyName ? result.companyName.toLowerCase() : emailData.fromEmail)
            : domain;

          const existing = contactsMap.get(companyKey);

          if (existing) {
            if (!existing.emailIds.includes(emailData.fromEmail)) existing.emailIds.push(emailData.fromEmail);
            existing.confidence = Math.max(existing.confidence, result.confidence);
            if (!existing.companyName && result.companyName) existing.companyName = result.companyName;
            if (!existing.phone && result.phone) existing.phone = result.phone;
            if (!existing.mobile && result.mobile) existing.mobile = result.mobile;
            if (!existing.website && result.website) existing.website = result.website;
          } else {
            contactsMap.set(companyKey, {
              companyName: result.companyName || '',
              customerName: result.customerName || emailData.fromName || emailData.fromEmail.split('@')[0],
              emailIds: [emailData.fromEmail],
              phone: result.phone || '',
              mobile: result.mobile || '',
              website: result.website || '',
              address: result.address || '',
              source: 'Gmail',
              confidence: result.confidence,
            });
          }
        }
      }

      await markMessagesProcessed(supabase, user_id, connection_id, batchProcessedIds, 1, null);

      console.log(`Batch ${Math.floor(i / BATCH_SIZE) + 1}/${Math.ceil(emailsToProcess.length / BATCH_SIZE)} done. Contacts so far: ${contactsMap.size}`);
    }

    const contacts = Array.from(contactsMap.values())
      .filter(c => c.customerName && !isOwnCompanyName(c.companyName))
      .map(c => ({ ...c, emailIds: c.emailIds.join('; ') }));

    console.log(`Done. ${contacts.length} contacts from ${messages.length} emails`);

    return new Response(
      JSON.stringify({
        success: true,
        total_emails_scanned: messages.length,
        total_contacts: contacts.length,
        contacts,
        message: `Processed ${messages.length} new emails and extracted ${contacts.length} contacts`
      }),
      { headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
    );
  } catch (error: any) {
    console.error('Error in extract-gmail-contacts:', error);
    return new Response(
      JSON.stringify({ error: error.message || 'An error occurred', success: false }),
      { status: 500, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
    );
  }
});
