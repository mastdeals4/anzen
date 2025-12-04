import { useState, useEffect, useCallback } from 'react';
import { supabase } from '../../lib/supabase';
import { Mail, RefreshCw, Sparkles, DollarSign, FileText, TestTube, Package, Calendar, AlertCircle } from 'lucide-react';
import type { Email, ParsedEmailData } from '../../types/commandCenter';

interface EmailListPanelProps {
  onEmailSelect: (email: Email, parsedData: ParsedEmailData | null) => void;
  selectedEmailId: string | null;
}

export function EmailListPanel({ onEmailSelect, selectedEmailId }: EmailListPanelProps) {
  const [emails, setEmails] = useState<Email[]>([]);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [parsingEmailId, setParsingEmailId] = useState<string | null>(null);

  const loadEmails = useCallback(async () => {
    try {
      const { data, error } = await supabase
        .from('crm_email_inbox')
        .select('*')
        .eq('is_processed', false)
        .order('received_date', { ascending: false })
        .limit(50);

      if (error) throw error;
      setEmails(data || []);
    } catch (error) {
      console.error('Error loading emails:', error);
    } finally {
      setLoading(false);
      setRefreshing(false);
    }
  }, []);

  const handleRefresh = useCallback(async () => {
    setRefreshing(true);

    try {
      const { data: { session } } = await supabase.auth.getSession();
      if (!session) {
        console.error('Not authenticated');
        setRefreshing(false);
        return;
      }

      const apiUrl = `${import.meta.env.VITE_SUPABASE_URL}/functions/v1/sync-gmail-emails`;

      const controller = new AbortController();
      const timeoutId = setTimeout(() => controller.abort(), 120000);

      const response = await fetch(apiUrl, {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${session.access_token}`,
          'Content-Type': 'application/json',
        },
        signal: controller.signal,
      });

      clearTimeout(timeoutId);

      if (!response.ok) {
        throw new Error(`Sync failed: ${response.status}`);
      }

      await response.json();
      await loadEmails();
    } catch (error) {
      console.error('Error syncing emails:', error);
      await loadEmails();
    } finally {
      setRefreshing(false);
    }
  }, [loadEmails]);

  useEffect(() => {
    loadEmails();

    const subscription = supabase
      .channel('email_inbox_changes')
      .on(
        'postgres_changes',
        {
          event: '*',
          schema: 'public',
          table: 'crm_email_inbox',
        },
        () => {
          loadEmails();
        }
      )
      .subscribe();

    // Auto-sync emails every 10 minutes
    const syncInterval = setInterval(() => {
      handleRefresh();
    }, 600000); // 10 minutes

    return () => {
      subscription.unsubscribe();
      clearInterval(syncInterval);
    };
  }, [loadEmails, handleRefresh]);

  useEffect(() => {
    const checkPendingEmail = async () => {
      const pendingEmail = sessionStorage.getItem('pendingEmailForInquiry');
      if (pendingEmail) {
        console.log('[EmailListPanel] Found pending email in sessionStorage');
        sessionStorage.removeItem('pendingEmailForInquiry');

        try {
          const emailData = JSON.parse(pendingEmail);
          console.log('[EmailListPanel] Parsed email data:', emailData);

          const { data: { session } } = await supabase.auth.getSession();
          if (!session) {
            console.error('[EmailListPanel] No session found');
            throw new Error('Not authenticated');
          }

          console.log('[EmailListPanel] Calling parse-pharma-email edge function');
          const apiUrl = `${import.meta.env.VITE_SUPABASE_URL}/functions/v1/parse-pharma-email`;

          const response = await fetch(apiUrl, {
            method: 'POST',
            headers: {
              'Authorization': `Bearer ${session.access_token}`,
              'Content-Type': 'application/json',
            },
            body: JSON.stringify({
              emailSubject: emailData.subject,
              emailBody: emailData.body,
              fromEmail: emailData.fromEmail,
              fromName: emailData.fromName,
            }),
          });

          console.log('[EmailListPanel] Response status:', response.status);
          const result = await response.json();
          console.log('[EmailListPanel] Parse result:', result);

          if (result.success || result.fallbackData) {
            const mockEmail: Email = {
              id: 'gmail-' + Date.now(),
              from_email: emailData.fromEmail,
              from_name: emailData.fromName,
              subject: emailData.subject,
              body: emailData.body,
              received_date: emailData.date,
              is_processed: false,
              is_inquiry: false,
              parsed_data: null,
              converted_to_inquiry: null,
            };

            console.log('[EmailListPanel] Calling onEmailSelect with mock email');
            onEmailSelect(mockEmail, result.data || result.fallbackData);
          } else {
            console.error('[EmailListPanel] Parse failed:', result.error);
            alert('Failed to parse email from Gmail: ' + result.error);
          }
        } catch (error) {
          console.error('[EmailListPanel] Error processing pending email:', error);
          alert(`Failed to process email: ${error instanceof Error ? error.message : String(error)}`);
        }
      } else {
        console.log('[EmailListPanel] No pending email found in sessionStorage');
      }
    };

    checkPendingEmail();
  }, [onEmailSelect]);

  const handleEmailClick = async (email: Email) => {
    setParsingEmailId(email.id);

    try {
      const { data: { session } } = await supabase.auth.getSession();
      if (!session) throw new Error('Not authenticated');

      const apiUrl = `${import.meta.env.VITE_SUPABASE_URL}/functions/v1/parse-pharma-email`;

      const response = await fetch(apiUrl, {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${session.access_token}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          emailSubject: email.subject,
          emailBody: email.body,
          fromEmail: email.from_email,
          fromName: email.from_name,
        }),
      });

      const result = await response.json();

      if (result.success) {
        onEmailSelect(email, result.data);
      } else {
        if (result.fallbackData) {
          onEmailSelect(email, result.fallbackData);
        } else {
          alert('Failed to parse email: ' + result.error);
          onEmailSelect(email, null);
        }
      }
    } catch (error) {
      console.error('Error parsing email:', error);
      alert('Failed to parse email. Please try again.');
    } finally {
      setParsingEmailId(null);
    }
  };

  const getPurposeIcons = (email: Email) => {
    const body = email.body?.toLowerCase() || '';
    const subject = email.subject?.toLowerCase() || '';
    const text = body + ' ' + subject;

    const icons = [];

    if (text.includes('price') || text.includes('harga') || text.includes('quotation') || text.includes('quote')) {
      icons.push({ icon: DollarSign, color: 'text-green-600', label: 'Price' });
    }
    if (text.includes('coa') || text.includes('certificate') || text.includes('analysis')) {
      icons.push({ icon: FileText, color: 'text-blue-600', label: 'COA' });
    }
    if (text.includes('msds') || text.includes('safety') || text.includes('data sheet')) {
      icons.push({ icon: FileText, color: 'text-orange-600', label: 'MSDS' });
    }
    if (text.includes('sample') || text.includes('sampel')) {
      icons.push({ icon: TestTube, color: 'text-purple-600', label: 'Sample' });
    }

    return icons;
  };

  const extractPreview = (email: Email) => {
    const body = email.body || '';
    const lines = body.split('\n').filter(line => line.trim().length > 0);

    let product = '';
    let quantity = '';
    let supplier = '';

    for (const line of lines.slice(0, 20)) {
      const lowerLine = line.toLowerCase();

      if (!product && (lowerLine.includes('product') || lowerLine.includes('material') || lowerLine.includes('item'))) {
        product = line.replace(/^[^:]+:/, '').trim().substring(0, 50);
      }

      if (!quantity && (lowerLine.includes('qty') || lowerLine.includes('quantity') || lowerLine.includes('kg') || lowerLine.includes('mt'))) {
        const match = line.match(/\d+\s*(kg|mt|ton|units?|pcs)/i);
        if (match) quantity = match[0];
      }

      if (!supplier && (lowerLine.includes('supplier') || lowerLine.includes('manufacturer') || lowerLine.includes('origin'))) {
        supplier = line.replace(/^[^:]+:/, '').trim().substring(0, 30);
      }
    }

    return { product, quantity, supplier };
  };

  const isUrgent = (email: Email) => {
    const text = (email.subject + ' ' + email.body).toLowerCase();
    return text.includes('urgent') || text.includes('asap') || text.includes('segera') || text.includes('mendesak');
  };

  if (loading) {
    return (
      <div className="flex items-center justify-center h-full">
        <div className="text-center">
          <div className="animate-spin rounded-full h-12 w-12 border-b-2 border-blue-600 mx-auto mb-4" />
          <p className="text-gray-600">Loading emails...</p>
        </div>
      </div>
    );
  }

  return (
    <div className="flex flex-col h-full bg-white border-r border-gray-200">
      <div className="flex items-center justify-between px-4 py-3 border-b border-gray-200 bg-gray-50">
        <div className="flex items-center gap-2">
          <Mail className="w-5 h-5 text-blue-600" />
          <h2 className="font-semibold text-gray-900">New Emails</h2>
          <span className="px-2 py-0.5 text-xs font-medium bg-blue-100 text-blue-700 rounded-full">
            {emails.length}
          </span>
        </div>
        <button
          onClick={handleRefresh}
          disabled={refreshing}
          className="p-1.5 hover:bg-gray-200 rounded-lg transition"
          title="Refresh emails"
        >
          <RefreshCw className={`w-4 h-4 text-gray-600 ${refreshing ? 'animate-spin' : ''}`} />
        </button>
      </div>

      <div className="flex-1 overflow-y-auto">
        {emails.length === 0 ? (
          <div className="flex flex-col items-center justify-center h-full text-center px-4">
            <Mail className="w-16 h-16 text-gray-300 mb-4" />
            <p className="text-gray-600 font-medium">No unprocessed emails</p>
            <p className="text-sm text-gray-500 mt-1">New emails will appear here automatically</p>
          </div>
        ) : (
          <div className="divide-y divide-gray-100">
            {emails.map((email) => {
              const preview = extractPreview(email);
              const purposeIcons = getPurposeIcons(email);
              const urgent = isUrgent(email);
              const isSelected = selectedEmailId === email.id;
              const isParsing = parsingEmailId === email.id;

              return (
                <div
                  key={email.id}
                  onClick={() => !isParsing && handleEmailClick(email)}
                  className={`p-4 cursor-pointer transition ${
                    isSelected
                      ? 'bg-blue-50 border-l-4 border-blue-600'
                      : 'hover:bg-gray-50 border-l-4 border-transparent'
                  } ${isParsing ? 'opacity-50 cursor-wait' : ''}`}
                >
                  <div className="flex items-start justify-between mb-2">
                    <div className="flex-1 min-w-0">
                      <div className="flex items-center gap-2 mb-1">
                        <span className="font-semibold text-gray-900 truncate">
                          {email.from_name || email.from_email}
                        </span>
                        {urgent && (
                          <span className="flex-shrink-0 px-1.5 py-0.5 text-xs font-bold bg-red-100 text-red-700 rounded">
                            URGENT
                          </span>
                        )}
                      </div>
                      <p className="text-xs text-gray-500 truncate">{email.from_email}</p>
                    </div>
                    {isParsing && (
                      <Sparkles className="w-5 h-5 text-blue-600 animate-pulse flex-shrink-0 ml-2" />
                    )}
                  </div>

                  <p className="text-sm font-medium text-gray-800 mb-2 line-clamp-1">
                    {email.subject}
                  </p>

                  {(preview.product || preview.quantity) && (
                    <div className="space-y-1 mb-2">
                      {preview.product && (
                        <div className="flex items-start gap-2">
                          <Package className="w-3.5 h-3.5 text-gray-400 mt-0.5 flex-shrink-0" />
                          <span className="text-xs text-gray-600 line-clamp-1">{preview.product}</span>
                        </div>
                      )}
                      {preview.quantity && (
                        <div className="flex items-center gap-2">
                          <span className="text-xs font-medium text-blue-600">{preview.quantity}</span>
                        </div>
                      )}
                    </div>
                  )}

                  {purposeIcons.length > 0 && (
                    <div className="flex items-center gap-2 mb-2">
                      {purposeIcons.map((item, idx) => (
                        <div
                          key={idx}
                          className="flex items-center gap-1 px-2 py-0.5 bg-gray-100 rounded"
                          title={item.label}
                        >
                          <item.icon className={`w-3 h-3 ${item.color}`} />
                          <span className="text-xs text-gray-600">{item.label}</span>
                        </div>
                      ))}
                    </div>
                  )}

                  <div className="flex items-center justify-between mt-2">
                    <span className="text-xs text-gray-500">
                      {new Date(email.received_date).toLocaleString('en-US', {
                        month: 'short',
                        day: 'numeric',
                        hour: '2-digit',
                        minute: '2-digit',
                      })}
                    </span>
                    {!isParsing && (
                      <span className="text-xs text-blue-600 font-medium flex items-center gap-1">
                        <Sparkles className="w-3 h-3" />
                        AI Parse
                      </span>
                    )}
                  </div>
                </div>
              );
            })}
          </div>
        )}
      </div>
    </div>
  );
}
