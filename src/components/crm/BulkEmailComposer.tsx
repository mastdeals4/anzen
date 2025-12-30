import { useState, useEffect } from 'react';
import { supabase } from '../../lib/supabase';
import { Mail, Send, FileText, Clock, Users, AlertCircle, CheckCircle, XCircle } from 'lucide-react';
import { Modal } from '../Modal';

interface EmailTemplate {
  id: string;
  template_name: string;
  subject: string;
  body: string;
  category: string | null;
}

interface SelectedCustomer {
  id: string;
  company_name: string;
  email: string;
  contact_person: string | null;
}

interface BulkEmailComposerProps {
  selectedCustomers: SelectedCustomer[];
  onClose: () => void;
  onComplete: () => void;
}

interface SendResult {
  customerId: string;
  companyName: string;
  email: string;
  status: 'pending' | 'sending' | 'success' | 'error';
  error?: string;
}

export function BulkEmailComposer({ selectedCustomers, onClose, onComplete }: BulkEmailComposerProps) {
  const [templates, setTemplates] = useState<EmailTemplate[]>([]);
  const [selectedTemplate, setSelectedTemplate] = useState<EmailTemplate | null>(null);
  const [subject, setSubject] = useState('');
  const [body, setBody] = useState('');
  const [intervalSeconds, setIntervalSeconds] = useState(30);
  const [sending, setSending] = useState(false);
  const [showTemplates, setShowTemplates] = useState(false);
  const [sendResults, setSendResults] = useState<SendResult[]>([]);
  const [currentIndex, setCurrentIndex] = useState(0);

  useEffect(() => {
    loadTemplates();
    initializeResults();
  }, []);

  const initializeResults = () => {
    const results = selectedCustomers.map(customer => ({
      customerId: customer.id,
      companyName: customer.company_name,
      email: customer.email,
      status: 'pending' as const,
    }));
    setSendResults(results);
  };

  const loadTemplates = async () => {
    try {
      const { data, error } = await supabase
        .from('crm_email_templates')
        .select('*')
        .eq('is_active', true)
        .order('template_name');

      if (error) throw error;
      setTemplates(data || []);
    } catch (error) {
      console.error('Error loading templates:', error);
    }
  };

  const applyTemplate = (template: EmailTemplate) => {
    setSubject(template.subject);
    setBody(template.body);
    setSelectedTemplate(template);
    setShowTemplates(false);
  };

  const personalizeContent = (content: string, customer: SelectedCustomer): string => {
    return content
      .replace(/\{\{company_name\}\}/g, customer.company_name)
      .replace(/\{\{contact_person\}\}/g, customer.contact_person || 'Sir/Madam');
  };

  const sendBulkEmails = async () => {
    if (!subject || !body) {
      alert('Please fill in subject and message');
      return;
    }

    if (intervalSeconds < 10) {
      alert('Please set interval to at least 10 seconds to avoid blocking');
      return;
    }

    setSending(true);
    setCurrentIndex(0);

    try {
      const { data: { user } } = await supabase.auth.getUser();
      if (!user) throw new Error('Not authenticated');

      const { data: gmailConnection } = await supabase
        .from('gmail_connections')
        .select('*')
        .eq('user_id', user.id)
        .eq('is_connected', true)
        .maybeSingle();

      if (!gmailConnection) {
        alert('Gmail not connected. Please connect Gmail in Settings first.');
        setSending(false);
        return;
      }

      for (let i = 0; i < selectedCustomers.length; i++) {
        const customer = selectedCustomers[i];
        setCurrentIndex(i);

        setSendResults(prev => prev.map((r, idx) =>
          idx === i ? { ...r, status: 'sending' } : r
        ));

        try {
          const emailAddresses = customer.email
            .split(';')
            .map(email => email.trim())
            .filter(email => email.length > 0);

          const personalizedSubject = personalizeContent(subject, customer);
          const personalizedBody = personalizeContent(body, customer);

          const supabaseUrl = import.meta.env.VITE_SUPABASE_URL;
          const supabaseKey = import.meta.env.VITE_SUPABASE_ANON_KEY;

          const response = await fetch(`${supabaseUrl}/functions/v1/send-bulk-email`, {
            method: 'POST',
            headers: {
              'Content-Type': 'application/json',
              'Authorization': `Bearer ${supabaseKey}`,
            },
            body: JSON.stringify({
              userId: user.id,
              toEmails: emailAddresses,
              subject: personalizedSubject,
              body: personalizedBody,
              contactId: customer.id,
            }),
          });

          if (!response.ok) {
            throw new Error('Failed to send email');
          }

          const result = await response.json();

          if (result.success) {
            const emailData = {
              contact_id: customer.id,
              email_type: 'sent',
              from_email: user.email,
              to_email: emailAddresses,
              subject: personalizedSubject,
              body: personalizedBody,
              template_id: selectedTemplate?.id || null,
              sent_date: new Date().toISOString(),
              created_by: user.id,
            };

            await supabase
              .from('crm_email_activities')
              .insert([emailData]);

            setSendResults(prev => prev.map((r, idx) =>
              idx === i ? { ...r, status: 'success' } : r
            ));
          } else {
            throw new Error(result.error || 'Unknown error');
          }

          if (i < selectedCustomers.length - 1) {
            await new Promise(resolve => setTimeout(resolve, intervalSeconds * 1000));
          }
        } catch (error) {
          console.error(`Error sending to ${customer.company_name}:`, error);
          setSendResults(prev => prev.map((r, idx) =>
            idx === i ? { ...r, status: 'error', error: error.message } : r
          ));
        }
      }

      if (selectedTemplate) {
        await supabase
          .from('crm_email_templates')
          .update({
            use_count: (selectedTemplate as any).use_count + selectedCustomers.length,
            last_used: new Date().toISOString(),
          })
          .eq('id', selectedTemplate.id);
      }

      const successCount = sendResults.filter(r => r.status === 'success').length;
      alert(`Bulk email completed!\n${successCount} of ${selectedCustomers.length} emails sent successfully.`);

      onComplete();
    } catch (error) {
      console.error('Error in bulk email:', error);
      alert('Failed to complete bulk email. Please check the results.');
    } finally {
      setSending(false);
    }
  };

  const successCount = sendResults.filter(r => r.status === 'success').length;
  const errorCount = sendResults.filter(r => r.status === 'error').length;
  const pendingCount = sendResults.filter(r => r.status === 'pending').length;

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between">
        <div>
          <h3 className="text-lg font-semibold flex items-center gap-2">
            <Mail className="w-5 h-5 text-blue-600" />
            Bulk Email to Customers
          </h3>
          <p className="text-sm text-gray-600 mt-1">
            Sending to {selectedCustomers.length} customers
          </p>
        </div>
        <button
          onClick={() => setShowTemplates(true)}
          disabled={sending}
          className="flex items-center gap-2 px-3 py-1.5 text-sm bg-gray-100 hover:bg-gray-200 rounded-lg transition disabled:opacity-50"
        >
          <FileText className="w-4 h-4" />
          Use Template
        </button>
      </div>

      <div className="bg-yellow-50 border border-yellow-200 rounded-lg p-3 flex items-start gap-2">
        <AlertCircle className="w-5 h-5 text-yellow-600 flex-shrink-0 mt-0.5" />
        <div className="text-sm text-yellow-800">
          <p className="font-medium">Important: Email Throttling</p>
          <p className="mt-1">
            Emails will be sent with {intervalSeconds}s intervals to prevent your email account from being blocked.
            Total time: ~{Math.ceil((selectedCustomers.length * intervalSeconds) / 60)} minutes
          </p>
        </div>
      </div>

      <div>
        <label className="block text-sm font-medium text-gray-700 mb-1">
          Interval Between Emails (seconds)
        </label>
        <input
          type="number"
          min="10"
          max="300"
          value={intervalSeconds}
          onChange={(e) => setIntervalSeconds(Math.max(10, parseInt(e.target.value) || 10))}
          disabled={sending}
          className="w-full px-3 py-2 border border-gray-300 rounded-lg focus:ring-2 focus:ring-blue-500 disabled:bg-gray-100"
        />
        <p className="text-xs text-gray-500 mt-1">
          Minimum 10 seconds recommended. Higher values are safer for large batches.
        </p>
      </div>

      <div>
        <label className="block text-sm font-medium text-gray-700 mb-1">
          Subject *
        </label>
        <input
          type="text"
          value={subject}
          onChange={(e) => setSubject(e.target.value)}
          disabled={sending}
          className="w-full px-3 py-2 border border-gray-300 rounded-lg focus:ring-2 focus:ring-blue-500 disabled:bg-gray-100"
          placeholder="Email subject (use {{company_name}} and {{contact_person}} for personalization)"
        />
      </div>

      <div>
        <label className="block text-sm font-medium text-gray-700 mb-1">
          Message *
        </label>
        <textarea
          value={body}
          onChange={(e) => setBody(e.target.value)}
          disabled={sending}
          className="w-full px-3 py-2 border border-gray-300 rounded-lg focus:ring-2 focus:ring-blue-500 disabled:bg-gray-100"
          rows={10}
          placeholder="Type your message here... (use {{company_name}} and {{contact_person}} for personalization)"
        />
        <p className="text-xs text-gray-500 mt-1">
          Variables: {'{{company_name}}'}, {'{{contact_person}}'}
        </p>
      </div>

      {sending && (
        <div className="bg-blue-50 border border-blue-200 rounded-lg p-4">
          <div className="flex items-center gap-3 mb-3">
            <div className="animate-spin rounded-full h-5 w-5 border-b-2 border-blue-600" />
            <div>
              <p className="font-medium text-blue-900">
                Sending email {currentIndex + 1} of {selectedCustomers.length}
              </p>
              <p className="text-sm text-blue-700">
                Current: {selectedCustomers[currentIndex]?.company_name}
              </p>
            </div>
          </div>
          <div className="flex gap-4 text-sm">
            <div className="flex items-center gap-1 text-green-700">
              <CheckCircle className="w-4 h-4" />
              Success: {successCount}
            </div>
            <div className="flex items-center gap-1 text-red-700">
              <XCircle className="w-4 h-4" />
              Failed: {errorCount}
            </div>
            <div className="flex items-center gap-1 text-gray-700">
              <Clock className="w-4 h-4" />
              Pending: {pendingCount}
            </div>
          </div>
        </div>
      )}

      {sendResults.some(r => r.status !== 'pending') && (
        <div className="border border-gray-200 rounded-lg overflow-hidden">
          <div className="bg-gray-50 px-4 py-2 border-b">
            <p className="text-sm font-medium text-gray-700">Send Results</p>
          </div>
          <div className="max-h-64 overflow-y-auto">
            {sendResults.map((result, idx) => (
              <div
                key={idx}
                className={`px-4 py-2 border-b last:border-b-0 flex items-center justify-between ${
                  result.status === 'success' ? 'bg-green-50' :
                  result.status === 'error' ? 'bg-red-50' :
                  result.status === 'sending' ? 'bg-blue-50' : ''
                }`}
              >
                <div className="flex-1">
                  <p className="text-sm font-medium text-gray-900">{result.companyName}</p>
                  <p className="text-xs text-gray-600">{result.email}</p>
                  {result.error && (
                    <p className="text-xs text-red-600 mt-1">{result.error}</p>
                  )}
                </div>
                <div>
                  {result.status === 'success' && (
                    <CheckCircle className="w-5 h-5 text-green-600" />
                  )}
                  {result.status === 'error' && (
                    <XCircle className="w-5 h-5 text-red-600" />
                  )}
                  {result.status === 'sending' && (
                    <div className="animate-spin rounded-full h-5 w-5 border-b-2 border-blue-600" />
                  )}
                  {result.status === 'pending' && (
                    <Clock className="w-5 h-5 text-gray-400" />
                  )}
                </div>
              </div>
            ))}
          </div>
        </div>
      )}

      <div className="flex justify-end gap-3 pt-4 border-t">
        <button
          onClick={onClose}
          disabled={sending}
          className="px-4 py-2 border border-gray-300 rounded-lg hover:bg-gray-50 transition disabled:opacity-50"
        >
          {sending ? 'Sending...' : 'Cancel'}
        </button>
        <button
          onClick={sendBulkEmails}
          disabled={sending || !subject || !body}
          className="flex items-center gap-2 px-6 py-2 bg-blue-600 text-white rounded-lg hover:bg-blue-700 transition disabled:opacity-50 disabled:cursor-not-allowed"
        >
          <Send className="w-4 h-4" />
          {sending ? 'Sending...' : 'Start Bulk Send'}
        </button>
      </div>

      <Modal
        isOpen={showTemplates}
        onClose={() => setShowTemplates(false)}
        title="Email Templates"
      >
        <div className="space-y-2">
          {templates.length === 0 ? (
            <div className="text-center py-8 text-gray-500">
              <FileText className="w-12 h-12 mx-auto text-gray-300 mb-3" />
              <p>No templates available</p>
              <p className="text-sm mt-1">Contact admin to create email templates</p>
            </div>
          ) : (
            templates.map((template) => (
              <div
                key={template.id}
                onClick={() => applyTemplate(template)}
                className="p-4 border border-gray-200 rounded-lg hover:border-blue-500 hover:bg-blue-50 cursor-pointer transition"
              >
                <div className="flex items-start justify-between">
                  <div className="flex-1">
                    <p className="font-semibold text-gray-900">{template.template_name}</p>
                    <p className="text-sm text-gray-600 mt-1">{template.subject}</p>
                    {template.category && (
                      <span className="inline-block mt-2 px-2 py-1 bg-gray-100 text-gray-700 text-xs rounded">
                        {template.category}
                      </span>
                    )}
                  </div>
                </div>
              </div>
            ))
          )}
        </div>
      </Modal>
    </div>
  );
}
