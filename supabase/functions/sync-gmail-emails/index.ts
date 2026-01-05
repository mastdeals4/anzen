import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "npm:@supabase/supabase-js@2.57.4";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type, Authorization, X-Client-Info, Apikey",
};

interface GmailMessage {
  id: string;
  threadId: string;
  snippet: string;
  internalDate: string;
  payload: {
    headers: Array<{ name: string; value: string }>;
    body?: { data?: string };
    parts?: Array<{
      mimeType: string;
      body?: { data?: string; size: number };
      parts?: any[];
    }>;
  };
}

function decodeBase64Url(str: string): string {
  try {
    const base64 = str.replace(/-/g, '+').replace(/_/g, '/');
    const binaryString = atob(base64);

    // Convert binary string to Uint8Array
    const bytes = new Uint8Array(binaryString.length);
    for (let i = 0; i < binaryString.length; i++) {
      bytes[i] = binaryString.charCodeAt(i);
    }

    // Decode as UTF-8
    const decoder = new TextDecoder('utf-8');
    return decoder.decode(bytes);
  } catch {
    return '';
  }
}

function extractEmailBody(payload: any): string {
  let htmlBody = '';
  let textBody = '';

  function traverse(part: any) {
    if (part.mimeType === 'text/html' && part.body?.data) {
      const decoded = decodeBase64Url(part.body.data);
      if (decoded && decoded.length > htmlBody.length) {
        htmlBody = decoded;
      }
    } else if (part.mimeType === 'text/plain' && part.body?.data) {
      const decoded = decodeBase64Url(part.body.data);
      if (decoded && decoded.length > textBody.length) {
        textBody = decoded;
      }
    }

    if (part.parts && Array.isArray(part.parts)) {
      for (const subPart of part.parts) {
        traverse(subPart);
      }
    }
  }

  if (payload.body?.data) {
    return decodeBase64Url(payload.body.data);
  }

  if (payload.parts) {
    traverse(payload);
  }

  return htmlBody || textBody || '';
}

function getHeader(headers: Array<{ name: string; value: string }>, name: string): string {
  const header = headers.find(h => h.name.toLowerCase() === name.toLowerCase());
  return header?.value || '';
}

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") {
    return new Response(null, {
      status: 200,
      headers: corsHeaders,
    });
  }

  try {
    const supabaseUrl = Deno.env.get('SUPABASE_URL')!;
    const supabaseServiceKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!;
    const supabase = createClient(supabaseUrl, supabaseServiceKey);

    const { data: { user } } = await supabase.auth.getUser(req.headers.get('Authorization')?.split(' ')[1] || '');
    if (!user) {
      throw new Error('Unauthorized');
    }

    const { data: connections, error: connectionsError } = await supabase
      .from('gmail_connections')
      .select('*')
      .eq('user_id', user.id)
      .eq('is_connected', true)
      .eq('sync_enabled', true);

    if (connectionsError) throw connectionsError;
    if (!connections || connections.length === 0) {
      return new Response(
        JSON.stringify({ success: false, error: 'No active Gmail connections found' }),
        {
          status: 400,
          headers: { ...corsHeaders, 'Content-Type': 'application/json' },
        }
      );
    }

    let totalMessages = 0;
    let totalProcessed = 0;
    let totalInquiries = 0;

    for (const connection of connections) {
      try {
        const tokenExpiry = new Date(connection.access_token_expires_at);
        let accessToken = connection.access_token;

        if (tokenExpiry <= new Date()) {
          const refreshResponse = await fetch('https://oauth2.googleapis.com/token', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
              client_id: Deno.env.get('GMAIL_CLIENT_ID'),
              client_secret: Deno.env.get('GMAIL_CLIENT_SECRET'),
              refresh_token: connection.refresh_token,
              grant_type: 'refresh_token',
            }),
          });

          if (!refreshResponse.ok) {
            console.error('Failed to refresh token for connection:', connection.id);
            continue;
          }

          const refreshData = await refreshResponse.json();
          accessToken = refreshData.access_token;

          await supabase
            .from('gmail_connections')
            .update({
              access_token: accessToken,
              access_token_expires_at: new Date(Date.now() + refreshData.expires_in * 1000).toISOString(),
            })
            .eq('id', connection.id);
        }

        const messagesResponse = await fetch(
          `https://gmail.googleapis.com/gmail/v1/users/me/messages?maxResults=10&q=is:unread`,
          {
            headers: {
              'Authorization': `Bearer ${accessToken}`,
            },
          }
        );

        if (!messagesResponse.ok) {
          console.error('Failed to fetch messages for connection:', connection.id);
          continue;
        }

        const messagesData = await messagesResponse.json();
        const messageList = messagesData.messages || [];
        totalMessages += messageList.length;

        const batchPromises = messageList.slice(0, 5).map(async (message: { id: string }) => {
          try {
            const messageResponse = await fetch(
              `https://gmail.googleapis.com/gmail/v1/users/me/messages/${message.id}?format=full`,
              {
                headers: {
                  'Authorization': `Bearer ${accessToken}`,
                },
              }
            );

            if (!messageResponse.ok) return null;

            const messageData: GmailMessage = await messageResponse.json();
            const headers = messageData.payload.headers;
            const subject = getHeader(headers, 'subject');
            const from = getHeader(headers, 'from');
            const fromEmail = from.match(/<(.+?)>/)?.[1] || from;
            const fromName = from.replace(/<.+?>/, '').trim();
            const body = extractEmailBody(messageData.payload);
            const receivedDate = new Date(parseInt(messageData.internalDate));

            const { data: existing } = await supabase
              .from('crm_email_inbox')
              .select('id')
              .eq('message_id', messageData.id)
              .maybeSingle();

            if (existing) return null;

            let isInquiry = false;
            let parsedData = null;

            try {
              const parseResponse = await fetch(`${supabaseUrl}/functions/v1/parse-pharma-email`, {
                method: 'POST',
                headers: {
                  'Content-Type': 'application/json',
                  'Authorization': `Bearer ${supabaseServiceKey}`,
                },
                body: JSON.stringify({
                  emailSubject: subject,
                  emailBody: body,
                  fromEmail: fromEmail,
                  fromName: fromName,
                  receivedDate: receivedDate.toISOString(),
                }),
              });

              if (parseResponse.ok) {
                const parseResult = await parseResponse.json();
                if (parseResult.success && parseResult.data) {
                  parsedData = parseResult.data;
                  isInquiry = (
                    (parsedData.productName && parsedData.productName.length > 2) &&
                    parsedData.confidenceScore >= 0.5
                  );
                }
              }
            } catch (parseError) {
              console.error('Failed to parse email:', parseError);
            }

            const { data: insertedEmail, error: insertError } = await supabase
              .from('crm_email_inbox')
              .insert({
                gmail_connection_id: connection.id,
                message_id: messageData.id,
                thread_id: messageData.threadId,
                subject,
                from_email: fromEmail,
                from_name: fromName,
                body: body,
                received_date: receivedDate.toISOString(),
                is_processed: false,
                is_inquiry: isInquiry,
              })
              .select()
              .single();

            if (insertError || !insertedEmail) return null;

            if (isInquiry && parsedData) {
              await supabase
                .from('crm_email_inbox')
                .update({
                  parsed_data: parsedData,
                })
                .eq('id', insertedEmail.id);

              console.log('Email marked as inquiry for manual review:', insertedEmail.id);
            }

            return { processed: true, inquiry: isInquiry };
          } catch (error) {
            console.error('Error processing message:', error);
            return null;
          }
        });

        const batchResults = await Promise.all(batchPromises);
        const validResults = batchResults.filter(r => r !== null);
        totalProcessed += validResults.length;
        totalInquiries += validResults.filter(r => r.inquiry).length;

        await supabase
          .from('gmail_connections')
          .update({ last_sync: new Date().toISOString() })
          .eq('id', connection.id);

      } catch (connectionError) {
        console.error('Error processing connection:', connection.id, connectionError);
      }
    }

    return new Response(
      JSON.stringify({
        success: true,
        totalMessages,
        processedCount: totalProcessed,
        newInquiriesCount: totalInquiries,
      }),
      {
        headers: {
          ...corsHeaders,
          'Content-Type': 'application/json',
        },
      }
    );
  } catch (error) {
    console.error('Error syncing emails:', error);
    return new Response(
      JSON.stringify({
        success: false,
        error: error.message || 'Failed to sync emails',
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
