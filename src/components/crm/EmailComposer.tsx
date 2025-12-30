import { useEffect, useState } from 'react';
import { supabase } from '../../lib/supabase';
import { Mail, Send, Paperclip, Save, FileText, Loader } from 'lucide-react';
import { Modal } from '../Modal';

interface EmailTemplate {
  id: string;
  template_name: string;
  subject: string;
  body: string;
  category: string | null;
  variables: string[] | null;
}

interface Inquiry {
  id: string;
  inquiry_number: string;
  company_name: string;
  contact_person: string | null;
  contact_email: string | null;
  product_name: string;
  quantity: string;
}

interface EmailComposerProps {
  inquiry?: Inquiry;
  onClose?: () => void;
  onSent?: () => void;
}

export function EmailComposer({ inquiry, onClose, onSent }: EmailComposerProps) {
  const [templates, setTemplates] = useState<EmailTemplate[]>([]);
  const [selectedTemplate, setSelectedTemplate] = useState<EmailTemplate | null>(null);
  const [toEmail, setToEmail] = useState('');
  const [subject, setSubject] = useState('');
  const [body, setBody] = useState('');
  const [sending, setSending] = useState(false);
  const [showTemplates, setShowTemplates] = useState(false);

  useEffect(() => {
    loadTemplates();
    if (inquiry) {
      setToEmail(inquiry.contact_email || '');
    }
  }, [inquiry]);

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
    let filledSubject = template.subject;
    let filledBody = template.body;

    if (inquiry) {
      filledSubject = filledSubject
        .replace(/\{\{company_name\}\}/g, inquiry.company_name)
        .replace(/\{\{contact_person\}\}/g, inquiry.contact_person || '')
        .replace(/\{\{product\}\}/g, inquiry.product_name)
        .replace(/\{\{quantity\}\}/g, inquiry.quantity)
        .replace(/\{\{inquiry_number\}\}/g, inquiry.inquiry_number);

      filledBody = filledBody
        .replace(/\{\{company_name\}\}/g, inquiry.company_name)
        .replace(/\{\{contact_person\}\}/g, inquiry.contact_person || 'Sir/Madam')
        .replace(/\{\{product\}\}/g, inquiry.product_name)
        .replace(/\{\{quantity\}\}/g, inquiry.quantity)
        .replace(/\{\{inquiry_number\}\}/g, inquiry.inquiry_number);
    }

    setSubject(filledSubject);
    setBody(filledBody);
    setSelectedTemplate(template);
    setShowTemplates(false);
  };

  const sendEmail = async () => {
    if (!toEmail || !subject || !body) {
      alert('Please fill in all required fields');
      return;
    }

    setSending(true);
    try {
      const { data: { user } } = await supabase.auth.getUser();
      if (!user) throw new Error('Not authenticated');

      const emailAddresses = toEmail
        .split(';')
        .map(email => email.trim())
        .filter(email => email.length > 0);

      const emailData = {
        inquiry_id: inquiry?.id || null,
        contact_id: null,
        email_type: 'sent',
        from_email: user.email,
        to_email: emailAddresses,
        subject: subject,
        body: body,
        template_id: selectedTemplate?.id || null,
        sent_date: new Date().toISOString(),
        created_by: user.id,
      };

      const { error } = await supabase
        .from('crm_email_activities')
        .insert([emailData]);

      if (error) throw error;

      if (selectedTemplate) {
        await supabase
          .from('crm_email_templates')
          .update({
            use_count: (selectedTemplate as any).use_count + 1,
            last_used: new Date().toISOString(),
          })
          .eq('id', selectedTemplate.id);
      }

      alert('Email logged successfully! Note: Actual email sending requires SMTP configuration.');

      if (onSent) onSent();
      if (onClose) onClose();
    } catch (error) {
      console.error('Error sending email:', error);
      alert('Failed to send email. Please try again.');
    } finally {
      setSending(false);
    }
  };

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between">
        <h3 className="text-lg font-semibold flex items-center gap-2">
          <Mail className="w-5 h-5 text-blue-600" />
          Compose Email
        </h3>
        <button
          onClick={() => setShowTemplates(true)}
          className="flex items-center gap-2 px-3 py-1.5 text-sm bg-gray-100 hover:bg-gray-200 rounded-lg transition"
        >
          <FileText className="w-4 h-4" />
          Use Template
        </button>
      </div>

      {inquiry && (
        <div className="bg-blue-50 border border-blue-200 rounded-lg p-3">
          <p className="text-sm font-medium text-blue-900">
            Inquiry #{inquiry.inquiry_number} - {inquiry.company_name}
          </p>
          <p className="text-xs text-blue-700 mt-1">
            {inquiry.product_name} - {inquiry.quantity}
          </p>
        </div>
      )}

      <div>
        <label className="block text-sm font-medium text-gray-700 mb-1">
          To *
        </label>
        <input
          type="text"
          value={toEmail}
          onChange={(e) => setToEmail(e.target.value)}
          className="w-full px-3 py-2 border border-gray-300 rounded-lg focus:ring-2 focus:ring-blue-500"
          placeholder="recipient@example.com; recipient2@example.com"
          required
        />
        <p className="text-xs text-gray-500 mt-1">
          {toEmail.includes(';') ?
            `Sending to ${toEmail.split(';').filter(e => e.trim()).length} email addresses` :
            'Separate multiple emails with semicolon (;)'
          }
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
          className="w-full px-3 py-2 border border-gray-300 rounded-lg focus:ring-2 focus:ring-blue-500"
          placeholder="Email subject"
          required
        />
      </div>

      <div>
        <label className="block text-sm font-medium text-gray-700 mb-1">
          Message *
        </label>
        <textarea
          value={body}
          onChange={(e) => setBody(e.target.value)}
          className="w-full px-3 py-2 border border-gray-300 rounded-lg focus:ring-2 focus:ring-blue-500"
          rows={12}
          placeholder="Type your message here..."
          required
        />
      </div>

      <div className="flex justify-between items-center pt-4 border-t">
        <div className="flex gap-2">
          <button
            type="button"
            className="flex items-center gap-2 px-3 py-2 text-sm border border-gray-300 rounded-lg hover:bg-gray-50 transition"
            disabled
          >
            <Paperclip className="w-4 h-4" />
            Attach Files (Coming Soon)
          </button>
        </div>
        <div className="flex gap-2">
          {onClose && (
            <button
              onClick={onClose}
              className="px-4 py-2 border border-gray-300 rounded-lg hover:bg-gray-50 transition"
            >
              Cancel
            </button>
          )}
          <button
            onClick={sendEmail}
            disabled={sending || !toEmail || !subject || !body}
            className="flex items-center gap-2 px-6 py-2 bg-blue-600 text-white rounded-lg hover:bg-blue-700 transition disabled:opacity-50 disabled:cursor-not-allowed"
          >
            {sending ? (
              <>
                <Loader className="w-4 h-4 animate-spin" />
                Sending...
              </>
            ) : (
              <>
                <Send className="w-4 h-4" />
                Send Email
              </>
            )}
          </button>
        </div>
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
                {template.variables && template.variables.length > 0 && (
                  <div className="mt-2 pt-2 border-t border-gray-100">
                    <p className="text-xs text-gray-500">
                      Variables: {template.variables.join(', ')}
                    </p>
                  </div>
                )}
              </div>
            ))
          )}
        </div>
      </Modal>
    </div>
  );
}
