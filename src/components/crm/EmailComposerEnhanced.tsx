import { useState, useRef } from 'react';
import { supabase } from '../../lib/supabase';
import { Mail, Send, Paperclip, X, FileText, Loader, Globe } from 'lucide-react';
import { Modal } from '../Modal';

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

interface EmailComposerProps {
  isOpen: boolean;
  onClose: () => void;
  inquiry: Inquiry;
  replyTo?: string;
}

interface AttachedFile {
  file: File;
  name: string;
  size: number;
}

export function EmailComposerEnhanced({ isOpen, onClose, inquiry, replyTo }: EmailComposerProps) {
  const [language, setLanguage] = useState<'id' | 'en'>('id');
  const [toEmail, setToEmail] = useState(inquiry.contact_email || '');
  const [subject, setSubject] = useState(
    inquiry.email_subject
      ? `Re: ${inquiry.email_subject}`
      : `Re: Permintaan Penawaran Harga - ${inquiry.product_name}`
  );
  const [body, setBody] = useState(() => generateQuotationTemplate(inquiry, 'id'));
  const [attachments, setAttachments] = useState<AttachedFile[]>([]);
  const [sending, setSending] = useState(false);
  const fileInputRef = useRef<HTMLInputElement>(null);

  const handleLanguageChange = (newLang: 'id' | 'en') => {
    setLanguage(newLang);
    setBody(generateQuotationTemplate(inquiry, newLang));
    setSubject(
      inquiry.email_subject
        ? `Re: ${inquiry.email_subject}`
        : newLang === 'id'
          ? `Re: Permintaan Penawaran Harga - ${inquiry.product_name}`
          : `Re: Price Quotation Request - ${inquiry.product_name}`
    );
  };

  const handleFileSelect = (e: React.ChangeEvent<HTMLInputElement>) => {
    const files = e.target.files;
    if (!files) return;

    const newFiles: AttachedFile[] = [];
    for (let i = 0; i < files.length; i++) {
      const file = files[i];
      if (file.size > 10 * 1024 * 1024) { // 10MB limit
        alert(`File ${file.name} is too large. Maximum size is 10MB.`);
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

      // Upload attachments to Supabase Storage
      const uploadedFiles: string[] = [];
      for (const attachment of attachments) {
        const fileName = `${Date.now()}_${attachment.name}`;
        const filePath = `email-attachments/${user.id}/${fileName}`;

        const { error: uploadError } = await supabase.storage
          .from('crm-documents')
          .upload(filePath, attachment.file);

        if (uploadError) {
          console.error('Error uploading file:', uploadError);
        } else {
          uploadedFiles.push(filePath);
        }
      }

      // Save email to database
      const emailData = {
        inquiry_id: inquiry.id,
        email_type: 'sent',
        from_email: user.email,
        to_email: [toEmail],
        subject: subject,
        body: body,
        attachments: uploadedFiles.length > 0 ? uploadedFiles : null,
        sent_date: new Date().toISOString(),
        created_by: user.id,
      };

      const { error } = await supabase
        .from('crm_email_activities')
        .insert([emailData]);

      if (error) throw error;

      // Update inquiry - mark price quoted
      await supabase
        .from('crm_inquiries')
        .update({
          price_quoted: true,
          price_quoted_date: new Date().toISOString().split('T')[0],
          status: 'price_quoted',
        })
        .eq('id', inquiry.id);

      alert('Quotation email sent successfully!');
      onClose();
    } catch (error) {
      console.error('Error sending email:', error);
      alert('Failed to send email. Please try again.');
    } finally {
      setSending(false);
    }
  };

  return (
    <Modal isOpen={isOpen} onClose={onClose} title="Send Price Quotation">
      <div className="space-y-4">
        {/* Inquiry Info */}
        <div className="bg-blue-50 border border-blue-200 rounded-lg p-3">
          <p className="text-sm font-medium text-blue-900">
            Inquiry #{inquiry.inquiry_number} - {inquiry.company_name}
          </p>
          <p className="text-xs text-blue-700 mt-1">
            {inquiry.product_name} {inquiry.specification ? `(${inquiry.specification})` : ''} - {inquiry.quantity}
          </p>
        </div>

        {/* Language Toggle */}
        <div className="flex justify-end">
          <div className="inline-flex rounded-lg border border-gray-300 overflow-hidden">
            <button
              type="button"
              onClick={() => handleLanguageChange('id')}
              className={`px-4 py-2 text-sm font-medium flex items-center gap-2 transition ${
                language === 'id'
                  ? 'bg-blue-600 text-white'
                  : 'bg-white text-gray-700 hover:bg-gray-50'
              }`}
            >
              <Globe className="w-4 h-4" />
              Bahasa Indonesia
            </button>
            <button
              type="button"
              onClick={() => handleLanguageChange('en')}
              className={`px-4 py-2 text-sm font-medium flex items-center gap-2 transition border-l ${
                language === 'en'
                  ? 'bg-blue-600 text-white border-blue-600'
                  : 'bg-white text-gray-700 hover:bg-gray-50 border-gray-300'
              }`}
            >
              <Globe className="w-4 h-4" />
              English
            </button>
          </div>
        </div>

        {/* To Email */}
        <div>
          <label className="block text-sm font-medium text-gray-700 mb-1">
            To <span className="text-red-500">*</span>
          </label>
          <input
            type="email"
            value={toEmail}
            onChange={(e) => setToEmail(e.target.value)}
            className="w-full px-3 py-2 border border-gray-300 rounded-lg focus:ring-2 focus:ring-blue-500 focus:border-blue-500"
            placeholder="recipient@example.com"
            required
          />
        </div>

        {/* Subject */}
        <div>
          <label className="block text-sm font-medium text-gray-700 mb-1">
            Subject <span className="text-red-500">*</span>
          </label>
          <input
            type="text"
            value={subject}
            onChange={(e) => setSubject(e.target.value)}
            className="w-full px-3 py-2 border border-gray-300 rounded-lg focus:ring-2 focus:ring-blue-500 focus:border-blue-500"
            required
          />
        </div>

        {/* Message Body */}
        <div>
          <label className="block text-sm font-medium text-gray-700 mb-1">
            Message <span className="text-red-500">*</span>
          </label>
          <textarea
            value={body}
            onChange={(e) => setBody(e.target.value)}
            className="w-full px-3 py-2 border border-gray-300 rounded-lg focus:ring-2 focus:ring-blue-500 focus:border-blue-500 font-mono text-sm"
            rows={16}
            required
          />
          <p className="text-xs text-gray-500 mt-1">
            Edit the template above with actual prices and delivery details
          </p>
        </div>

        {/* Attachments */}
        <div>
          <label className="block text-sm font-medium text-gray-700 mb-2">
            Attachments
          </label>
          <div className="space-y-2">
            {attachments.map((file, index) => (
              <div
                key={index}
                className="flex items-center justify-between p-2 bg-gray-50 border border-gray-200 rounded-lg"
              >
                <div className="flex items-center gap-2">
                  <FileText className="w-4 h-4 text-gray-500" />
                  <div>
                    <p className="text-sm font-medium text-gray-700">{file.name}</p>
                    <p className="text-xs text-gray-500">{formatFileSize(file.size)}</p>
                  </div>
                </div>
                <button
                  onClick={() => removeAttachment(index)}
                  className="p-1 text-red-600 hover:bg-red-50 rounded"
                >
                  <X className="w-4 h-4" />
                </button>
              </div>
            ))}
            <input
              ref={fileInputRef}
              type="file"
              multiple
              onChange={handleFileSelect}
              className="hidden"
              accept=".pdf,.doc,.docx,.xls,.xlsx,.png,.jpg,.jpeg"
            />
            <button
              onClick={() => fileInputRef.current?.click()}
              className="flex items-center gap-2 px-4 py-2 border border-gray-300 rounded-lg hover:bg-gray-50 transition text-sm"
            >
              <Paperclip className="w-4 h-4" />
              Attach Files (PDF, Excel, Word, Images)
            </button>
          </div>
        </div>

        {/* Action Buttons */}
        <div className="flex justify-end gap-3 pt-4 border-t">
          <button
            onClick={onClose}
            disabled={sending}
            className="px-4 py-2 border border-gray-300 rounded-lg hover:bg-gray-50 transition disabled:opacity-50"
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
                Send Quotation
              </>
            )}
          </button>
        </div>
      </div>
    </Modal>
  );
}

// Generate business quotation template (Indonesian or English)
function generateQuotationTemplate(inquiry: Inquiry, language: 'id' | 'en' = 'id'): string {
  const greeting = inquiry.contact_person
    ? `Dear ${inquiry.contact_person},`
    : language === 'id' ? `Dear Bapak/Ibu,` : `Dear Sir/Madam,`;

  const today = new Date().toLocaleDateString(language === 'id' ? 'id-ID' : 'en-US', {
    day: '2-digit',
    month: '2-digit',
    year: 'numeric'
  });

  if (language === 'en') {
    return generateEnglishTemplate(inquiry, greeting, today);
  }

  return `${greeting}

Bersama email ini kami sampaikan kebutuhan Bahan Baku sebagai berikut:

┌────────┬──────────────────────────────────┬──────────────────────┬──────────────────────────┬──────────────┬────────────────────────────┐
│   NO   │              Item                │   Manufacturer/Ex    │      Specification       │   Quantity   │      Delivery Date         │
├────────┼──────────────────────────────────┼──────────────────────┼──────────────────────────┼──────────────┼────────────────────────────┤
│    1   │ ${inquiry.product_name.padEnd(32)} │ ${(inquiry.supplier_name || 'TBD').padEnd(20)} │ ${(inquiry.specification || 'Pharma Grade').padEnd(24)} │ ${inquiry.quantity.padEnd(12)} │ ${today.padEnd(26)} │
└────────┴──────────────────────────────────┴──────────────────────┴──────────────────────────┴──────────────┴────────────────────────────┘

QUOTATION DETAILS:
------------------
Product: ${inquiry.product_name}
Specification: ${inquiry.specification || 'Pharma Grade, USP/BP'}
Quantity: ${inquiry.quantity}
Origin: ${inquiry.supplier_country || '[Please specify]'}

PRICING:
--------
Unit Price (FOB): USD $_____ per KG
Unit Price (CIF Indonesia): USD $_____ per KG
Total Price: USD $_____
Payment Terms: [e.g., 30% advance, 70% upon shipment]

DELIVERY:
---------
Delivery Time: [e.g., 4-6 weeks from PO confirmation]
Expected Delivery: ${today}
Packaging: Standard export packaging
Minimum Order: ${inquiry.quantity}

DOCUMENTS PROVIDED:
-------------------
✓ Certificate of Analysis (COA)
✓ Material Safety Data Sheet (MSDS)
✓ Certificate of Origin
✓ Halal Certificate (if applicable)
✓ GMP Certificate

Sehubungan dengan kebutuhan kami tersebut diatas, kami mohon bantuan Bapak / Ibu untuk dapat memberikan support harga terbaik (Lokal dan Indent) beserta informasi expiry date dari barang yang Bapak/Ibu tawarkan.

Demi kelancaran bersama, apabila harga indent tidak dapat diberikan, maka kami mohon agar Bapak / Ibu dapat mengirimkan surat keagenan kepada kami.

Demikian yang dapat kami sampaikan. Kabar dari Bapak / Ibu kami tunggu segera.

Atas perhatian dan kerja samanya, kami ucapkan terima kasih.

Best Regards,

[Your Name]
[Your Company]
[Your Title]
[Your Phone/WhatsApp]
[Your Email]`;
}

// Generate English business quotation template
function generateEnglishTemplate(inquiry: Inquiry, greeting: string, today: string): string {
  return `${greeting}

We are pleased to submit our requirements for raw materials as follows:

┌────────┬──────────────────────────────────┬──────────────────────┬──────────────────────────┬──────────────┬────────────────────────────┐
│   NO   │              Item                │   Manufacturer/Ex    │      Specification       │   Quantity   │      Delivery Date         │
├────────┼──────────────────────────────────┼──────────────────────┼──────────────────────────┼──────────────┼────────────────────────────┤
│    1   │ ${inquiry.product_name.padEnd(32)} │ ${(inquiry.supplier_name || 'TBD').padEnd(20)} │ ${(inquiry.specification || 'Pharma Grade').padEnd(24)} │ ${inquiry.quantity.padEnd(12)} │ ${today.padEnd(26)} │
└────────┴──────────────────────────────────┴──────────────────────┴──────────────────────────┴──────────────┴────────────────────────────┘

QUOTATION DETAILS:
------------------
Product: ${inquiry.product_name}
Specification: ${inquiry.specification || 'Pharma Grade, USP/BP Standard'}
Quantity: ${inquiry.quantity}
Country of Origin: ${inquiry.supplier_country || '[Please specify]'}

PRICING:
--------
Unit Price (FOB): USD $_____ per KG
Unit Price (CIF Indonesia): USD $_____ per KG
Total Price: USD $_____
Payment Terms: [e.g., 30% advance, 70% upon shipment]

DELIVERY:
---------
Lead Time: [e.g., 4-6 weeks from PO confirmation]
Expected Delivery: ${today}
Packaging: Standard export packaging
Minimum Order Quantity: ${inquiry.quantity}

DOCUMENTS PROVIDED:
-------------------
✓ Certificate of Analysis (COA)
✓ Material Safety Data Sheet (MSDS)
✓ Certificate of Origin
✓ Halal Certificate (if applicable)
✓ GMP Certificate
✓ Test Report

We kindly request your best price quotation (both local stock and indent) along with information about expiry dates of the products you can offer.

For smooth cooperation, if indent pricing cannot be provided, we would appreciate receiving an agency letter from your company.

We look forward to receiving your prompt response.

Thank you for your attention and cooperation.

Best Regards,

[Your Name]
[Your Company]
[Your Title]
[Your Phone/WhatsApp]
[Your Email]`;
}
