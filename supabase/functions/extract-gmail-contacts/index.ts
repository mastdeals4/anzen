import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from 'jsr:@supabase/supabase-js@2';

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, POST, PUT, DELETE, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type, Authorization, X-Client-Info, Apikey",
};

const INTERNAL_DOMAINS = ['anzen.co.in', 'shubham.co.in', 'shubham.com'];
const INTERNAL_EMAILS = ['lunkad.v@gmail.com', 'sumathi.lunkad@gmail.com'];

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

function isInternalEmail(email: string): boolean {
  const lowerEmail = email.toLowerCase();
  if (INTERNAL_EMAILS.some(internal => lowerEmail === internal.toLowerCase())) {
    return true;
  }
  const domain = email.split('@')[1]?.toLowerCase();
  return INTERNAL_DOMAINS.some(internalDomain => domain === internalDomain);
}

async function extractContactWithAI(
  email: string,
  name: string | undefined,
  subject: string,
  body: string,
  openaiApiKey: string
): Promise<ExtractedContact | null> {
  try {
    const prompt = `Extract company and contact information from this email. Return ONLY valid JSON, no markdown.

Email: ${email}
Name: ${name || 'N/A'}
Subject: ${subject}
Body: ${body.substring(0, 2000)}

Rules:
1. For company name:
   - Extract REAL company name from signature or email domain
   - For .co.id domains, add "PT " prefix if missing (e.g., "PT Genero Pharmaceuticals")
   - For .co.in domains, add " Pvt Ltd" suffix if appropriate
   - NEVER use email body content (like "Dear Sir", "Thank you", "We confirm", etc.)
   - NEVER use generic domains (gmail, yahoo, hotmail, outlook)
   - If no valid company found, return empty string

2. For contact name:
   - Use the name from email signature
   - If not in signature, use the "From" name
   - NEVER use email body content

3. Extract phone numbers, websites from signature only
4. Set confidence 0.8-1.0 for clear company names, 0.5-0.7 for domain-derived names, 0.0-0.4 for unclear

Return JSON:
{
  "companyName": "PT Company Name" or "",
  "customerName": "Person Name",
  "phone": "phone number",
  "mobile": "mobile number",
  "website": "company website",
  "address": "company address",
  "confidence": 0.0 to 1.0
}`;

    const response = await fetch('https://api.openai.com/v1/chat/completions', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${openaiApiKey}`,
      },
      body: JSON.stringify({
        model: 'gpt-3.5-turbo',
        messages: [
          {
            role: 'system',
            content: 'You are a data extraction assistant. Extract company information accurately. Return ONLY valid JSON, no markdown formatting.'
          },
          {
            role: 'user',
            content: prompt
          }
        ],
        temperature: 0.1,
        max_tokens: 300,
      }),
    });

    if (!response.ok) {
      console.error('OpenAI API error:', response.status);
      return null;
    }

    const data = await response.json();
    let content = data.choices[0]?.message?.content?.trim() || '';

    content = content.replace(/```json\s*/g, '').replace(/```\s*/g, '').trim();

    const extracted = JSON.parse(content);

    const isValidCompanyName = (name: string): boolean => {
      if (!name || name.length < 3) return false;
      const invalidPatterns = [
        /^(dear|hi|hello|regards|thanks|best|sincerely|thank you)/i,
        /^(we|i|our|your|the|this|that|it|please|sorry|actually)/i,
        /meeting|invitation|confirm|jump|delivery subsystem/i,
        /^googlemail$|^yahoomail$|^hotmail$|^outlook$/i,
      ];
      return !invalidPatterns.some(pattern => pattern.test(name));
    };

    if (!isValidCompanyName(extracted.companyName)) {
      extracted.companyName = '';
      extracted.confidence = Math.min(extracted.confidence || 0, 0.3);
    }

    return {
      companyName: extracted.companyName || '',
      customerName: extracted.customerName || name || email.split('@')[0],
      emailIds: [email],
      phone: extracted.phone || '',
      mobile: extracted.mobile || '',
      website: extracted.website || '',
      address: extracted.address || '',
      source: 'Gmail',
      confidence: extracted.confidence || 0.5,
    };
  } catch (error) {
    console.error('Error extracting with AI:', error);
    return null;
  }
}

async function fetchGmailMessages(
  accessToken: string,
  maxResults: number,
  supabase: any,
  connectionId: string,
  userId: string
): Promise<any[]> {
  const messages: any[] = [];
  let pageToken = '';

  try {
    const { data: processedMessages } = await supabase
      .from('gmail_processed_messages')
      .select('gmail_message_id')
      .eq('connection_id', connectionId)
      .eq('user_id', userId);

    const processedIds = new Set((processedMessages || []).map((m: any) => m.gmail_message_id));
    console.log(`Already processed ${processedIds.size} messages`);

    while (messages.length < maxResults) {
      const listUrl = `https://gmail.googleapis.com/gmail/v1/users/me/messages?maxResults=100${pageToken ? `&pageToken=${pageToken}` : ''}`;

      const listResponse = await fetch(listUrl, {
        headers: {
          'Authorization': `Bearer ${accessToken}`,
        },
      });

      if (!listResponse.ok) {
        throw new Error(`Gmail API error: ${listResponse.status}`);
      }

      const listData = await listResponse.json();

      if (!listData.messages || listData.messages.length === 0) {
        break;
      }

      for (const message of listData.messages) {
        if (processedIds.has(message.id)) {
          continue;
        }

        const detailUrl = `https://gmail.googleapis.com/gmail/v1/users/me/messages/${message.id}?format=full`;

        const detailResponse = await fetch(detailUrl, {
          headers: {
            'Authorization': `Bearer ${accessToken}`,
          },
        });

        if (detailResponse.ok) {
          const detailData = await detailResponse.json();
          messages.push(detailData);
        }

        if (messages.length >= maxResults) {
          break;
        }
      }

      if (!listData.nextPageToken || messages.length >= maxResults) {
        break;
      }

      pageToken = listData.nextPageToken;
    }

    console.log(`Fetched ${messages.length} NEW messages`);
  } catch (error) {
    console.error('Error fetching Gmail messages:', error);
    throw error;
  }

  return messages;
}

function extractEmailAddresses(headers: any[]): { email: string; name?: string; field: string }[] {
  const addresses: { email: string; name?: string; field: string }[] = [];
  const fields = ['from'];

  for (const field of fields) {
    const header = headers.find(h => h.name.toLowerCase() === field);
    if (header) {
      const emailRegex = /([^<\s]+@[^>\s]+)/g;
      const nameRegex = /([^<]+)<([^>]+)>/g;

      const emails = header.value.match(emailRegex) || [];
      const namesWithEmails = [...header.value.matchAll(nameRegex)];

      for (const email of emails) {
        const nameMatch = namesWithEmails.find(nm => nm[2] === email);
        addresses.push({
          email: email.trim(),
          name: nameMatch ? nameMatch[1].trim().replace(/\"/g, '') : undefined,
          field: field,
        });
      }
    }
  }

  return addresses;
}

function getEmailBody(message: any): string {
  let body = '';

  if (message.payload.body && message.payload.body.data) {
    body = atob(message.payload.body.data.replace(/-/g, '+').replace(/_/g, '/'));
  } else if (message.payload.parts) {
    for (const part of message.payload.parts) {
      if (part.mimeType === 'text/plain' && part.body && part.body.data) {
        body += atob(part.body.data.replace(/-/g, '+').replace(/_/g, '/'));
      }
    }
  }

  return body.substring(0, 5000);
}

async function extractContactsWithAI(
  messages: any[],
  openaiApiKey: string,
  supabase: any,
  connectionId: string,
  userId: string
): Promise<Map<string, ExtractedContact>> {
  const contactsMap = new Map<string, ExtractedContact>();
  const processedMessageIds: string[] = [];

  console.log(`Starting AI extraction for ${messages.length} messages...`);
  let processed = 0;

  for (const message of messages) {
    try {
      const headers = message.payload.headers;
      const addresses = extractEmailAddresses(headers);
      const fromAddresses = addresses.filter(addr => addr.field === 'from');

      if (fromAddresses.length === 0) {
        processedMessageIds.push(message.id);
        continue;
      }

      const fromAddr = fromAddresses[0];

      if (isInternalEmail(fromAddr.email)) {
        processedMessageIds.push(message.id);
        continue;
      }

      if (fromAddr.email.includes('noreply') || fromAddr.email.includes('no-reply')) {
        processedMessageIds.push(message.id);
        continue;
      }

      const subjectHeader = headers.find((h: any) => h.name.toLowerCase() === 'subject');
      const subject = subjectHeader?.value || '';
      const body = getEmailBody(message);

      const extractedContact = await extractContactWithAI(
        fromAddr.email,
        fromAddr.name,
        subject,
        body,
        openaiApiKey
      );

      if (extractedContact && extractedContact.confidence >= 0.5) {
        const domain = fromAddr.email.split('@')[1];
        const isGenericEmail = domain && (domain.includes('gmail') || domain.includes('yahoo') || domain.includes('hotmail') || domain.includes('outlook'));
        const companyKey = isGenericEmail ? fromAddr.email : domain;

        const existing = contactsMap.get(companyKey);
        if (existing) {
          if (!existing.emailIds.includes(fromAddr.email)) {
            existing.emailIds.push(fromAddr.email);
          }
          existing.confidence = Math.max(existing.confidence, extractedContact.confidence);
        } else {
          contactsMap.set(companyKey, extractedContact);
        }

        await supabase
          .from('gmail_processed_messages')
          .insert({
            user_id: userId,
            connection_id: connectionId,
            gmail_message_id: message.id,
            contacts_extracted: 1,
            extraction_data: extractedContact
          });
      } else {
        processedMessageIds.push(message.id);
      }

      processed++;
      if (processed % 50 === 0) {
        console.log(`Processed ${processed}/${messages.length} messages, found ${contactsMap.size} contacts so far...`);
      }
    } catch (error) {
      console.error('Error processing message:', error);
      processedMessageIds.push(message.id);
    }
  }

  if (processedMessageIds.length > 0) {
    try {
      await supabase
        .from('gmail_processed_messages')
        .insert(
          processedMessageIds.map(msgId => ({
            user_id: userId,
            connection_id: connectionId,
            gmail_message_id: msgId,
            contacts_extracted: 0,
            extraction_data: null
          }))
        );
    } catch (dbError) {
      console.error('Error saving processed messages:', dbError);
    }
  }

  console.log(`AI extraction complete. Found ${contactsMap.size} unique contacts from ${messages.length} messages`);
  return contactsMap;
}

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") {
    return new Response(null, {
      status: 200,
      headers: corsHeaders,
    });
  }

  try {
    console.log('Extract Gmail Contacts function called');

    const { access_token, max_emails = 100, user_id, connection_id } = await req.json();

    if (!access_token || !user_id || !connection_id) {
      return new Response(
        JSON.stringify({ error: 'access_token, user_id, and connection_id are required', success: false }),
        {
          status: 400,
          headers: {
            ...corsHeaders,
            'Content-Type': 'application/json',
          },
        }
      );
    }

    const openaiApiKey = Deno.env.get('OPENAI_API_KEY');
    if (!openaiApiKey) {
      return new Response(
        JSON.stringify({ error: 'OpenAI API key is not configured', success: false }),
        {
          status: 500,
          headers: {
            ...corsHeaders,
            'Content-Type': 'application/json',
          },
        }
      );
    }

    const supabaseUrl = Deno.env.get('SUPABASE_URL')!;
    const supabaseServiceKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!;
    const supabase = createClient(supabaseUrl, supabaseServiceKey);

    console.log(`Processing up to ${max_emails} emails with AI extraction...`);

    const messages = await fetchGmailMessages(
      access_token,
      Math.min(max_emails, 500),
      supabase,
      connection_id,
      user_id
    );

    if (messages.length === 0) {
      return new Response(
        JSON.stringify({
          success: true,
          total_emails_scanned: 0,
          total_contacts: 0,
          contacts: [],
          message: 'All emails have been processed already. No new emails to scan.'
        }),
        {
          headers: {
            ...corsHeaders,
            'Content-Type': 'application/json',
          },
        }
      );
    }

    console.log(`Extracting contacts from ${messages.length} messages using AI...`);

    const contactsMap = await extractContactsWithAI(
      messages,
      openaiApiKey,
      supabase,
      connection_id,
      user_id
    );

    const contacts = Array.from(contactsMap.values()).map(contact => ({
      ...contact,
      emailIds: contact.emailIds.join('; '),
    }));

    const filteredContacts = contacts.filter(c =>
      c.companyName && c.companyName.length > 2 && c.confidence >= 0.5
    );

    console.log(`Returning ${filteredContacts.length} high-quality contacts`);

    return new Response(
      JSON.stringify({
        success: true,
        total_emails_scanned: messages.length,
        total_contacts: filteredContacts.length,
        contacts: filteredContacts,
        message: `AI processed ${messages.length} NEW emails and extracted ${filteredContacts.length} high-quality contacts`
      }),
      {
        headers: {
          ...corsHeaders,
          'Content-Type': 'application/json',
        },
      }
    );
  } catch (error: any) {
    console.error('Error in extract-gmail-contacts:', error);
    return new Response(
      JSON.stringify({
        error: error.message || 'An error occurred while extracting contacts',
        success: false
      }),
      {
        status: 500,
        headers: {
          ...corsHeaders,
          'Content-Type': 'application/json',
        },
      }
    );
  }
});
