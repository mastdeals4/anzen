import { useEffect, useState } from 'react';
import { supabase } from '../../lib/supabase';
import { X, Send, Loader, Paperclip } from 'lucide-react';
import { showToast } from '../ToastNotification';
import {
  buildCompanySignature,
  buildCustomerQuoteTable,
  escapeHtml,
  type CustomerQuoteRow,
} from '../../utils/emailFormatting';
import { type CompanySnapshot, FALLBACK_COMPANY } from '../../types/company';
import { sendPricingWorkflowEmail, type PricingEmailAttachment } from '../../services/pricingEmail';
import { getSignedUrlCached } from '../../utils/signedUrlCache';

export interface CustomerQuoteInquiry {
  id: string;
  inquiry_number: string;
  aceerp_no: string | null;
  product_name: string;
  quantity: string | null;
  email_subject?: string | null;
  contact_email?: string | null;
  company_name?: string | null;
}

/** Selected pricing option — customer-safe fields only. */
export interface CustomerQuoteOption {
  offered_make: string | null;
  origin: string | null;
  specification: string | null;
  moq: string | null;
  packing: string | null;
  lead_time: string | null;
  selling_price: number | null;
  selling_currency: string | null;
  source_currency: string;
  remark: string | null;
}

interface DocItem {
  id: string;
  document_type: string;
  display_file_name: string | null;
  original_file_name: string | null;
  storage_path: string;
}

interface Props {
  isOpen: boolean;
  onClose: () => void;
  inquiry: CustomerQuoteInquiry;
  option: CustomerQuoteOption | null;
}

function parseRecipients(raw: string): string[] {
  return raw.split(/[,;]/).map(s => s.trim()).filter(Boolean);
}

function fmtPrice(price: number | null, currency: string): string {
  if (price == null || isNaN(price) || price <= 0) return 'On request';
  return `${currency || 'USD'} ${price.toLocaleString()}`;
}

function buildBody(
  inquiry: CustomerQuoteInquiry,
  option: CustomerQuoteOption | null,
  userName: string,
  co?: CompanySnapshot | null,
): string {
  const row: CustomerQuoteRow = {
    product: inquiry.product_name,
    make: option?.offered_make ?? null,
    origin: option?.origin ?? null,
    specification: option?.specification ?? null,
    moq: option?.moq ?? null,
    packing: option?.packing ?? null,
    leadTime: option?.lead_time ?? null,
    qty: inquiry.quantity,
    quotePrice: fmtPrice(option?.selling_price ?? null, option?.selling_currency || option?.source_currency || 'USD'),
    remarks: option?.remark ?? null,
  };
  const greeting = inquiry.company_name ? `Dear ${escapeHtml(inquiry.company_name)} team,` : 'Dear Sir/Madam,';
  return (
    `<p>${greeting}</p>` +
    `<p>Thank you for your inquiry. Please find our quotation for <strong>${escapeHtml(inquiry.product_name)}</strong> below:</p>` +
    buildCustomerQuoteTable([row]) +
    `<p style="margin-top:12px;">Prices are subject to confirmation at the time of order. We look forward to your valued order.</p>` +
    buildCompanySignature(userName, co)
  );
}

function buildSubject(inquiry: CustomerQuoteInquiry): string {
  if (inquiry.email_subject) {
    return inquiry.email_subject.startsWith('Re:') ? inquiry.email_subject : `Re: ${inquiry.email_subject}`;
  }
  return `Quotation: ${inquiry.product_name} — ${inquiry.inquiry_number}`;
}

export function KunalCustomerQuoteModal({ isOpen, onClose, inquiry, option }: Props) {
  const [toEmail, setToEmail] = useState('');
  const [ccEmail, setCcEmail] = useState('');
  const [bccEmail, setBccEmail] = useState('');
  const [showCc, setShowCc] = useState(false);
  const [showBcc, setShowBcc] = useState(false);
  const [subject, setSubject] = useState('');
  const [body, setBody] = useState('');
  const [sending, setSending] = useState(false);
  const [userName, setUserName] = useState('');
  const [docs, setDocs] = useState<DocItem[]>([]);
  const [selectedDocs, setSelectedDocs] = useState<Set<string>>(new Set());

  useEffect(() => {
    if (!isOpen) return;
    const init = async () => {
      const { data: { user } } = await supabase.auth.getUser();
      let name = '';
      if (user) {
        const { data: profile } = await supabase.from('user_profiles').select('full_name').eq('id', user.id).maybeSingle();
        name = profile?.full_name || '';
      }
      setUserName(name);

      const [coResult, docResult] = await Promise.all([
        supabase.from('company_profiles')
          .select('company_name, company_address, company_phone, company_email, company_tax_id, company_logo_url, pbf_license, cdob_certificate')
          .lte('effective_from', new Date().toISOString().split('T')[0])
          .order('effective_from', { ascending: false })
          .limit(1)
          .maybeSingle(),
        supabase.from('crm_product_documents')
          .select('id,document_type,display_file_name,original_file_name,storage_path')
          .eq('inquiry_id', inquiry.id)
          .order('created_at', { ascending: false }),
      ]);
      const co = (coResult.data as CompanySnapshot | null) ?? FALLBACK_COMPANY;
      setDocs((docResult.data as DocItem[]) || []);
      setSelectedDocs(new Set());
      setToEmail(inquiry.contact_email || '');
      setSubject(buildSubject(inquiry));
      setBody(buildBody(inquiry, option, name, co));
    };
    init();
  }, [isOpen, inquiry.id]);

  const toggleDoc = (id: string) => {
    setSelectedDocs(cur => {
      const next = new Set(cur);
      if (next.has(id)) next.delete(id); else next.add(id);
      return next;
    });
  };

  const handleSend = async () => {
    const toList = parseRecipients(toEmail);
    if (toList.length === 0) {
      showToast({ type: 'error', title: 'Missing recipient', message: 'Please enter at least one TO email address.' });
      return;
    }
    if (!subject.trim()) {
      showToast({ type: 'error', title: 'Missing subject', message: 'Please enter a subject line.' });
      return;
    }

    setSending(true);
    try {
      // Resolve signed URLs for the selected attachments (private bucket).
      const attachments: PricingEmailAttachment[] = [];
      for (const doc of docs) {
        if (!selectedDocs.has(doc.id)) continue;
        const url = await getSignedUrlCached('crm-documents', doc.storage_path, 3600);
        if (!url) continue;
        attachments.push({
          url,
          storagePath: doc.storage_path,
          filename: doc.display_file_name || doc.original_file_name || `${doc.document_type}.pdf`,
        });
      }

      const result = await sendPricingWorkflowEmail({
        workflowType: 'customer_quote',
        to: toList,
        cc: parseRecipients(ccEmail),
        bcc: parseRecipients(bccEmail),
        subject,
        body,
        isHtml: true,
        senderName: userName,
        attachmentUrls: attachments,
      });

      if (!result.success) {
        throw new Error(result.error || 'Failed to send quotation.');
      }

      // Record threading + timeline (best-effort).
      const { data: { user } } = await supabase.auth.getUser();
      if (user && (result.messageId || result.threadId)) {
        supabase.from('email_inquiry_links').insert({
          gmail_message_id: result.messageId,
          gmail_thread_id: result.threadId,
          inquiry_id: inquiry.id,
          link_type: 'generic',
        }).then(() => {}, () => {});
        supabase.from('crm_inquiry_timeline').insert({
          inquiry_id: inquiry.id,
          event_type: 'email_sent',
          event_title: 'Customer quotation sent',
          event_description: `Quotation sent to ${toList.join(', ')}${attachments.length ? ` with ${attachments.length} attachment(s)` : ''}`,
          performed_by: user.id,
        }).then(() => {}, () => {});
      }

      showToast({ type: 'success', title: 'Quotation sent', message: `Sent to ${toList.join(', ')}.` });
      onClose();
    } catch (err: any) {
      showToast({ type: 'error', title: 'Send failed', message: err.message || 'Failed to send quotation.' });
    } finally {
      setSending(false);
    }
  };

  if (!isOpen) return null;

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40">
      <div className="bg-white rounded-xl shadow-2xl w-full max-w-[820px] max-h-[90vh] overflow-auto mx-4">
        <div className="flex items-center justify-between px-5 py-4 border-b border-gray-200">
          <h3 className="text-lg font-semibold text-gray-900">Send Customer Quotation</h3>
          <button onClick={onClose} className="p-1 text-gray-400 hover:text-gray-600 rounded"><X className="w-5 h-5" /></button>
        </div>

        <div className="px-5 py-4 space-y-3">
          <div>
            <div className="flex items-center gap-2 mb-1">
              <label className="text-xs font-medium text-gray-600 w-8">To:</label>
              <input type="text" value={toEmail} onChange={e => setToEmail(e.target.value)}
                placeholder="customer@example.com"
                className="flex-1 border border-gray-300 rounded px-2 py-1.5 text-sm" />
              <button type="button" onClick={() => setShowCc(!showCc)} className="text-xs text-blue-600 hover:underline whitespace-nowrap">Cc</button>
              <button type="button" onClick={() => setShowBcc(!showBcc)} className="text-xs text-blue-600 hover:underline whitespace-nowrap">Bcc</button>
            </div>
          </div>

          {showCc && (
            <div className="flex items-center gap-2">
              <label className="text-xs font-medium text-gray-600 w-8">Cc:</label>
              <input type="text" value={ccEmail} onChange={e => setCcEmail(e.target.value)}
                placeholder="cc@example.com" className="flex-1 border border-gray-300 rounded px-2 py-1.5 text-sm" />
            </div>
          )}

          {showBcc && (
            <div className="flex items-center gap-2">
              <label className="text-xs font-medium text-gray-600 w-8">Bcc:</label>
              <input type="text" value={bccEmail} onChange={e => setBccEmail(e.target.value)}
                placeholder="bcc@example.com" className="flex-1 border border-gray-300 rounded px-2 py-1.5 text-sm" />
            </div>
          )}

          <div className="flex items-center gap-2">
            <label className="text-xs font-medium text-gray-600 w-8">Subject:</label>
            <input type="text" value={subject} onChange={e => setSubject(e.target.value)}
              className="flex-1 border border-gray-300 rounded px-2 py-1.5 text-sm" />
          </div>

          {/* Attachment picker */}
          {docs.length > 0 && (
            <div>
              <label className="text-xs font-medium text-gray-600 mb-1 flex items-center gap-1">
                <Paperclip className="w-3.5 h-3.5 text-gray-400" /> Attach documents:
              </label>
              <div className="flex flex-wrap gap-2">
                {docs.map(doc => (
                  <label key={doc.id} className={`flex items-center gap-1.5 px-2 py-1 rounded border text-xs cursor-pointer ${selectedDocs.has(doc.id) ? 'border-blue-400 bg-blue-50 text-blue-700' : 'border-gray-200 text-gray-600'}`}>
                    <input type="checkbox" checked={selectedDocs.has(doc.id)} onChange={() => toggleDoc(doc.id)} className="text-blue-600" />
                    <span className="font-medium">{doc.document_type}</span>
                    <span className="truncate max-w-[180px]" title={doc.display_file_name || doc.original_file_name || ''}>{doc.display_file_name || doc.original_file_name || 'file'}</span>
                  </label>
                ))}
              </div>
            </div>
          )}

          <div>
            <label className="text-xs font-medium text-gray-600 mb-1 block">Preview (customer-safe — no source cost shown):</label>
            <div className="border border-gray-200 rounded-lg p-4 bg-white max-h-[400px] overflow-auto"
              dangerouslySetInnerHTML={{ __html: body }} />
          </div>
        </div>

        <div className="flex items-center justify-end gap-2 px-5 py-3 border-t border-gray-200 bg-gray-50 rounded-b-xl">
          <button onClick={onClose} disabled={sending} className="px-4 py-2 text-sm border border-gray-300 rounded-lg hover:bg-gray-100 disabled:opacity-50">
            Cancel
          </button>
          <button onClick={handleSend} disabled={sending}
            className="flex items-center gap-1.5 px-5 py-2 text-sm bg-blue-600 text-white rounded-lg hover:bg-blue-700 disabled:opacity-50">
            {sending ? <Loader className="w-4 h-4 animate-spin" /> : <Send className="w-4 h-4" />}
            {sending ? 'Sending...' : 'Confirm Send'}
          </button>
        </div>
      </div>
    </div>
  );
}
