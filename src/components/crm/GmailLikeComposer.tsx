import { useState, useEffect, useRef } from 'react';
import { supabase } from '../../lib/supabase';
import { Mail, Send, Paperclip, X, FileText, Loader, ChevronDown, Sparkles } from 'lucide-react';
import { Modal } from '../Modal';
import DOMPurify from 'dompurify';

interface Inquiry {
  id: string;
  inquiry_number: string;
  company_name: string;
  contact_person: string | null;
  contact_email: string | null;
  product_name: string;
  specification?: string | null;
  quantity: string;
  supplier_name?: string | null;
  supplier_country?: string | null;
  email_subject?: string | null;
}

interface EmailTemplate {
  id: string;
  template_name: string;
  subject: string;
  body: string;
  category: string;
  variables: string[];
}

interface GmailLikeComposerProps {
  isOpen: boolean;
  onClose: () => void;
  inquiry: Inquiry;
  replyTo?: {
    email_id: string;
    subject: string;
    from_email: string;
    body: string;
  };
}

interface AttachedFile {
  file: File;
  name: string;
  size: number;
}

export function GmailLikeComposer({ isOpen, onClose, inquiry, replyTo }: GmailLikeComposerProps) {
  const [toEmail, setToEmail] = useState(inquiry.contact_email || '');
  const [ccEmail, setCcEmail] = useState('');
  const [bccEmail, setBccEmail] = useState('');
  const [showCc, setShowCc] = useState(false);
  const [showBcc, setShowBcc] = useState(false);
  const [subject, setSubject] = useState(
    replyTo?.subject
      ? (replyTo.subject.startsWith('Re:') ? replyTo.subject : `Re: ${replyTo.subject}`)
      : `Re: ${inquiry.product_name} - Inquiry ${inquiry.inquiry_number}`
  );
  const [body, setBody] = useState('');
  const [attachments, setAttachments] = useState<AttachedFile[]>([]);
  const [sending, setSending] = useState(false);
  const [templates, setTemplates] = useState<EmailTemplate[]>([]);
  const [showTemplates, setShowTemplates] = useState(false);
  const [currentUserName, setCurrentUserName] = useState('');
  const fileInputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    loadTemplates();
    loadUserName();
    if (replyTo) {
      // Add quoted reply
      const quotedBody = `
        <br><br>
        <div style="border-left: 3px solid #ccc; padding-left: 15px; margin-left: 10px; color: #666;">
          <p><strong>On ${new Date().toLocaleDateString()}, ${replyTo.from_email} wrote:</strong></p>
          ${replyTo.body}
        </div>
      `;
      setBody(quotedBody);
    }
  }, [replyTo]);

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

  const loadUserName = async () => {
    try {
      const { data: { user } } = await supabase.auth.getUser();
      if (user) {
        const { data: profile } = await supabase
          .from('user_profiles')
          .select('full_name')
          .eq('id', user.id)
          .single();

        setCurrentUserName(profile?.full_name || '');
      }
    } catch (error) {
      console.error('Error loading user name:', error);
    }
  };

  const applyTemplate = (template: EmailTemplate) => {
    const variables: Record<string, string> = {
      '{{contact_person}}': inquiry.contact_person || '',
      '{{company_name}}': inquiry.company_name,
      '{{product_name}}': inquiry.product_name,
      '{{specification}}': inquiry.specification || '-',
      '{{quantity}}': inquiry.quantity,
      '{{supplier_name}}': inquiry.supplier_name || '-',
      '{{supplier_country}}': inquiry.supplier_country || '-',
      '{{inquiry_number}}': inquiry.inquiry_number,
      '{{user_name}}': currentUserName,
    };

    let processedSubject = template.subject;
    let processedBody = template.body;

    // Replace variables
    Object.entries(variables).forEach(([key, value]) => {
      const regex = new RegExp(key.replace(/[{}]/g, '\\$&'), 'g');
      processedSubject = processedSubject.replace(regex, value);
      processedBody = processedBody.replace(regex, value);
    });

    setSubject(processedSubject);
    setBody(processedBody);
    setShowTemplates(false);

    // Update template usage count
    supabase
      .from('crm_email_templates')
      .update({
        use_count: (template as any).use_count + 1,
        last_used: new Date().toISOString(),
      })
      .eq('id', template.id)
      .then(() => {});
  };

  const handleFileSelect = (e: React.ChangeEvent<HTMLInputElement>) => {
    const files = e.target.files;
    if (!files) return;

    const newFiles: AttachedFile[] = [];
    for (let i = 0; i < files.length; i++) {
      const file = files[i];
      if (file.size > 25 * 1024 * 1024) {
        alert(`File ${file.name} is too large. Maximum size is 25MB.`);
        continue;
      }
      newFiles.push({
        file,
        name: file.name,
        size: file.size,
      });
    }
    setAttachments(prev => [...prev, ...newFiles]);
  };

  const removeAttachment = (index: number) => {
    setAttachments(prev => prev.filter((_, i) => i !== index));
  };

  const formatFileSize = (bytes: number): string => {
    if (bytes < 1024) return bytes + ' B';
    if (bytes < 1024 * 1024) return (bytes / 1024).toFixed(1) + ' KB';
    return (bytes / (1024 * 1024)).toFixed(1) + ' MB';
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

      // Upload attachments
      const uploadedFiles: string[] = [];
      for (const attachment of attachments) {
        const fileName = `${Date.now()}_${attachment.name}`;
        const filePath = `email-attachments/${user.id}/${fileName}`;

        const { error: uploadError } = await supabase.storage
          .from('crm-documents')
          .upload(filePath, attachment.file);

        if (!uploadError) {
          uploadedFiles.push(filePath);
        }
      }

      // Save email to database
      const emailData = {
        inquiry_id: inquiry.id,
        email_type: 'sent',
        from_email: user.email,
        to_email: [toEmail, ...(ccEmail ? ccEmail.split(',').map(e => e.trim()) : [])],
        cc_email: ccEmail ? ccEmail.split(',').map(e => e.trim()) : null,
        bcc_email: bccEmail ? bccEmail.split(',').map(e => e.trim()) : null,
        subject: subject,
        body: body,
        attachments: uploadedFiles.length > 0 ? uploadedFiles : null,
        sent_date: new Date().toISOString(),
        created_by: user.id,
        reply_to_id: replyTo?.email_id || null,
      };

      const { error } = await supabase
        .from('crm_email_activities')
        .insert([emailData]);

      if (error) throw error;

      // Update inquiry status based on content
      const updateData: any = {};
      if (subject.toLowerCase().includes('price') || subject.toLowerCase().includes('quote')) {
        updateData.price_quoted = true;
        updateData.price_quoted_date = new Date().toISOString().split('T')[0];
        updateData.status = 'price_quoted';
      } else if (subject.toLowerCase().includes('coa') || subject.toLowerCase().includes('msds')) {
        updateData.coa_sent = true;
        updateData.coa_sent_date = new Date().toISOString().split('T')[0];
      }

      if (Object.keys(updateData).length > 0) {
        await supabase
          .from('crm_inquiries')
          .update(updateData)
          .eq('id', inquiry.id);
      }

      alert('Email sent successfully!');
      onClose();
    } catch (error) {
      console.error('Error sending email:', error);
      alert('Failed to send email. Please try again.');
    } finally {
      setSending(false);
    }
  };


  if (!isOpen) return null;

  return (
    <Modal isOpen={isOpen} onClose={onClose} title="">
      <div className="space-y-4">
        {/* Header */}
        <div className="flex items-center justify-between border-b pb-4">
          <h3 className="text-lg font-semibold flex items-center gap-2">
            <Mail className="w-5 h-5" />
            {replyTo ? 'Reply to Email' : 'New Message'}
          </h3>
          <button
            onClick={() => setShowTemplates(!showTemplates)}
            className="flex items-center gap-1 px-3 py-1.5 text-sm bg-gray-100 hover:bg-gray-200 text-gray-700 rounded transition"
          >
            <Sparkles className="w-4 h-4" />
            Templates
            <ChevronDown className="w-3 h-3" />
          </button>
        </div>

        {/* Template Selector */}
        {showTemplates && (
          <div className="bg-gray-50 border border-gray-200 rounded-lg p-3">
            <p className="text-sm font-medium text-gray-700 mb-2">Choose a template:</p>
            <div className="grid grid-cols-2 gap-2">
              {templates.map(template => (
                <button
                  key={template.id}
                  onClick={() => applyTemplate(template)}
                  className="px-3 py-2 text-left text-sm bg-white hover:bg-blue-50 border border-gray-200 rounded transition"
                >
                  <div className="font-medium text-gray-900">{template.template_name}</div>
                  <div className="text-xs text-gray-500">{template.category}</div>
                </button>
              ))}
            </div>
          </div>
        )}

        {/* To Field */}
        <div>
          <div className="flex items-center gap-2">
            <label className="text-sm font-medium text-gray-700 w-12">To:</label>
            <input
              type="email"
              value={toEmail}
              onChange={(e) => setToEmail(e.target.value)}
              className="flex-1 px-3 py-2 border border-gray-300 rounded-lg focus:ring-2 focus:ring-blue-500 text-sm"
              placeholder="recipient@example.com"
              required
            />
            <button
              onClick={() => setShowCc(!showCc)}
              className="text-sm text-blue-600 hover:text-blue-700"
            >
              Cc
            </button>
            <button
              onClick={() => setShowBcc(!showBcc)}
              className="text-sm text-blue-600 hover:text-blue-700"
            >
              Bcc
            </button>
          </div>
        </div>

        {/* Cc Field */}
        {showCc && (
          <div className="flex items-center gap-2">
            <label className="text-sm font-medium text-gray-700 w-12">Cc:</label>
            <input
              type="text"
              value={ccEmail}
              onChange={(e) => setCcEmail(e.target.value)}
              className="flex-1 px-3 py-2 border border-gray-300 rounded-lg focus:ring-2 focus:ring-blue-500 text-sm"
              placeholder="cc@example.com (comma separated)"
            />
          </div>
        )}

        {/* Bcc Field */}
        {showBcc && (
          <div className="flex items-center gap-2">
            <label className="text-sm font-medium text-gray-700 w-12">Bcc:</label>
            <input
              type="text"
              value={bccEmail}
              onChange={(e) => setBccEmail(e.target.value)}
              className="flex-1 px-3 py-2 border border-gray-300 rounded-lg focus:ring-2 focus:ring-blue-500 text-sm"
              placeholder="bcc@example.com (comma separated)"
            />
          </div>
        )}

        {/* Subject */}
        <div>
          <input
            type="text"
            value={subject}
            onChange={(e) => setSubject(e.target.value)}
            className="w-full px-3 py-2 border border-gray-300 rounded-lg focus:ring-2 focus:ring-blue-500"
            placeholder="Subject"
            required
          />
        </div>

        {/* Rich Text Editor */}
        <div>
          <textarea
            value={body.replace(/<[^>]*>/g, '')}
            onChange={(e) => setBody(e.target.value)}
            className="w-full px-3 py-2 border border-gray-300 rounded-lg focus:ring-2 focus:ring-blue-500"
            rows={15}
            placeholder="Compose your email..."
          />
        </div>

        {/* Attachments */}
        {attachments.length > 0 && (
          <div className="space-y-2">
            {attachments.map((att, index) => (
              <div
                key={index}
                className="flex items-center justify-between p-2 bg-gray-50 rounded border border-gray-200"
              >
                <div className="flex items-center gap-2">
                  <Paperclip className="w-4 h-4 text-gray-500" />
                  <span className="text-sm text-gray-700">{att.name}</span>
                  <span className="text-xs text-gray-500">({formatFileSize(att.size)})</span>
                </div>
                <button
                  onClick={() => removeAttachment(index)}
                  className="text-red-600 hover:text-red-700"
                >
                  <X className="w-4 h-4" />
                </button>
              </div>
            ))}
          </div>
        )}

        {/* Actions */}
        <div className="flex items-center justify-between pt-4 border-t">
          <div>
            <input
              ref={fileInputRef}
              type="file"
              multiple
              onChange={handleFileSelect}
              className="hidden"
            />
            <button
              onClick={() => fileInputRef.current?.click()}
              className="flex items-center gap-2 px-4 py-2 text-gray-700 bg-gray-100 rounded-lg hover:bg-gray-200 transition"
            >
              <Paperclip className="w-4 h-4" />
              Attach Files
            </button>
          </div>

          <div className="flex gap-3">
            <button
              onClick={onClose}
              className="px-4 py-2 border border-gray-300 rounded-lg hover:bg-gray-50 transition"
            >
              Cancel
            </button>
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
                  Send
                </>
              )}
            </button>
          </div>
        </div>

        {/* Context Info */}
        <div className="text-xs text-gray-500 pt-2 border-t">
          <strong>Inquiry:</strong> {inquiry.inquiry_number} | {inquiry.company_name} | {inquiry.product_name}
        </div>
      </div>
    </Modal>
  );
}
