import { useState } from 'react';
import { supabase } from '../../lib/supabase';
import { X, Send, Calendar, Clock, AlertCircle } from 'lucide-react';
import { showToast } from '../ToastNotification';

interface Inquiry {
  id: string;
  inquiry_number: string;
  company_name: string;
  contact_person?: string | null;
  contact_email?: string | null;
  product_name: string;
  specification?: string | null;
  quantity?: string | null;
  offered_price?: number | null;
  offered_price_currency?: string | null;
  quote_sent_at?: string | null;
  price_sent_at?: string | null;
  next_follow_up?: string | null;
}

interface Props {
  isOpen: boolean;
  onClose: () => void;
  inquiry: Inquiry;
  onRefresh: () => void;
}

export function CustomerFollowUpModal({ isOpen, onClose, inquiry, onRefresh }: Props) {
  const [followUpDate, setFollowUpDate] = useState(() => {
    const nextWeek = new Date();
    nextWeek.setDate(nextWeek.getDate() + 3);
    return nextWeek.toISOString().split('T')[0];
  });
  const [sendEmail, setSendEmail] = useState(true);
  const [recipientEmail, setRecipientEmail] = useState(inquiry.contact_email || '');
  const [subject, setSubject] = useState(
    `Follow-up: Quotation for ${inquiry.product_name} – ${inquiry.inquiry_number}`
  );
  const [notes, setNotes] = useState(
`Dear Team,

We had shared our offer for the below requirement.

Kindly let us know if there is any update from your end.

Regards,
Kunal`
  );
  const [saving, setSaving] = useState(false);

  if (!isOpen) return null;

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setSaving(true);
    try {
      const { data: { user } } = await supabase.auth.getUser();
      if (!user) throw new Error('Not authenticated');

      const now = new Date().toISOString();

      // 1. Send customer-facing follow up email from sales@avira.co.id if requested
      if (sendEmail && recipientEmail.trim()) {
        const { data: fnData, error: fnErr } = await supabase.functions.invoke('send-bulk-email', {
          body: {
            requiredSenderEmail: 'sales@avira.co.id',
            replyTo: 'sales@avira.co.id',
            workflowType: 'customer_quote',
            toEmails: [recipientEmail.trim()],
            subject,
            body: `<div style="font-family:Arial,sans-serif;font-size:13px;line-height:1.5;color:#1f2937;">
              ${notes.replace(/\n/g, '<br/>')}
              <hr style="margin:16px 0;border:0;border-top:1px solid #e2e8f0;"/>
              <p style="color:#64748b;font-size:12px;">
                <strong>Requirement Details:</strong><br/>
                Inquiry Ref: ${inquiry.inquiry_number}<br/>
                Product: ${inquiry.product_name}${inquiry.specification ? ` (${inquiry.specification})` : ''}<br/>
                Quantity: ${inquiry.quantity || '-'}<br/>
                Quoted Offer: ${inquiry.offered_price ? `${inquiry.offered_price_currency || 'USD'} ${inquiry.offered_price}` : 'As quoted'}
              </p>
            </div>`,
            isHtml: true,
          },
        });

        if (fnErr || !fnData?.success) {
          throw new Error(fnData?.error || fnErr?.message || 'Failed to send customer follow-up email');
        }

        // Record crm_email_activities
        await supabase.from('crm_email_activities').insert({
          inquiry_id: inquiry.id,
          email_type: 'sent',
          from_email: 'sales@avira.co.id',
          to_email: [recipientEmail.trim()],
          subject,
          body: notes,
          sent_date: now,
          created_by: user.id,
        });
      }

      // 2. Record CRM Activity Log
      await supabase.from('crm_activities').insert({
        inquiry_id: inquiry.id,
        activity_type: sendEmail ? 'email' : 'note',
        title: 'Customer Follow-up',
        description: notes,
        activity_date: now.split('T')[0],
        next_follow_up_date: followUpDate || null,
        is_completed: true,
        created_by: user.id,
      });

      // 3. Record Timeline event
      await supabase.from('crm_inquiry_timeline').insert({
        inquiry_id: inquiry.id,
        event_type: 'follow_up',
        event_title: sendEmail ? 'Follow-up email sent to customer' : 'Customer follow-up scheduled',
        event_description: `Next follow-up: ${followUpDate || 'Not set'}. ${sendEmail ? 'Email sent from sales@avira.co.id.' : ''}`,
        performed_by: user.id,
        event_timestamp: now,
      });

      // 4. Update Inquiry next_follow_up
      await supabase.from('crm_inquiries').update({
        next_follow_up: followUpDate ? new Date(followUpDate).toISOString() : null,
        last_contact_date: now,
        updated_at: now,
      }).eq('id', inquiry.id);

      showToast({
        type: 'success',
        title: 'Follow-up Recorded',
        message: sendEmail ? 'Customer follow-up email sent from sales@avira.co.id.' : 'Next follow-up date updated.',
      });

      onRefresh();
      onClose();
    } catch (err: any) {
      console.error('Follow-up error:', err);
      showToast({ type: 'error', title: 'Follow-up Failed', message: err.message || 'Unable to save follow-up.' });
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="fixed inset-0 bg-black/40 z-50 flex items-center justify-center p-4">
      <div className="bg-white rounded-lg shadow-xl max-w-lg w-full overflow-hidden flex flex-col">
        {/* Header */}
        <div className="px-4 py-3 bg-gray-900 text-white flex items-center justify-between">
          <div className="flex items-center gap-2">
            <Clock className="w-4 h-4 text-blue-400" />
            <h2 className="text-sm font-semibold">Customer Follow-up</h2>
          </div>
          <button onClick={onClose} className="p-1 rounded text-gray-400 hover:text-white transition">
            <X className="w-4 h-4" />
          </button>
        </div>

        {/* Sender banner */}
        <div className="px-4 py-2 bg-blue-50 border-b border-blue-200 text-xs text-blue-900 flex items-center justify-between">
          <span>Customer email sender:</span>
          <span className="font-mono font-bold bg-white px-2 py-0.5 rounded border border-blue-200">
            sales@avira.co.id
          </span>
        </div>

        {/* Form */}
        <form onSubmit={handleSubmit} className="p-4 space-y-3 flex-1 overflow-y-auto text-xs">
          <div>
            <label className="block text-gray-700 font-medium mb-1">Company / Customer</label>
            <div className="p-2 bg-gray-50 border border-gray-200 rounded text-gray-800 font-medium">
              {inquiry.company_name} · <span className="font-bold">{inquiry.product_name}</span> ({inquiry.inquiry_number})
            </div>
          </div>

          <div className="grid grid-cols-2 gap-3">
            <div>
              <label className="block text-gray-700 font-medium mb-1 flex items-center gap-1">
                <Calendar className="w-3.5 h-3.5 text-gray-500" /> Next Follow-up Date
              </label>
              <input
                type="date"
                value={followUpDate}
                onChange={e => setFollowUpDate(e.target.value)}
                className="w-full border border-gray-300 rounded px-2.5 py-1.5 focus:outline-none focus:ring-1 focus:ring-blue-500"
              />
            </div>
            <div className="flex flex-col justify-end">
              <label className="flex items-center gap-2 cursor-pointer pb-2">
                <input
                  type="checkbox"
                  checked={sendEmail}
                  onChange={e => setSendEmail(e.target.checked)}
                  className="rounded border-gray-300 text-blue-600 focus:ring-blue-500"
                />
                <span className="font-medium text-gray-700">Send follow-up email</span>
              </label>
            </div>
          </div>

          {sendEmail && (
            <>
              <div>
                <label className="block text-gray-700 font-medium mb-1">Customer Recipient Email</label>
                <input
                  type="email"
                  value={recipientEmail}
                  onChange={e => setRecipientEmail(e.target.value)}
                  placeholder="customer@example.com"
                  required={sendEmail}
                  className="w-full border border-gray-300 rounded px-2.5 py-1.5 focus:outline-none focus:ring-1 focus:ring-blue-500"
                />
              </div>

              <div>
                <label className="block text-gray-700 font-medium mb-1">Subject</label>
                <input
                  type="text"
                  value={subject}
                  onChange={e => setSubject(e.target.value)}
                  required={sendEmail}
                  className="w-full border border-gray-300 rounded px-2.5 py-1.5 focus:outline-none focus:ring-1 focus:ring-blue-500"
                />
              </div>
            </>
          )}

          <div>
            <label className="block text-gray-700 font-medium mb-1">
              {sendEmail ? 'Email Message' : 'Internal Follow-up Notes'}
            </label>
            <textarea
              value={notes}
              onChange={e => setNotes(e.target.value)}
              rows={6}
              required
              className="w-full border border-gray-300 rounded p-2.5 font-sans focus:outline-none focus:ring-1 focus:ring-blue-500 resize-y"
            />
          </div>
        </form>

        {/* Footer */}
        <div className="px-4 py-3 bg-gray-50 border-t border-gray-200 flex items-center justify-between">
          <div className="text-[11px] text-gray-500 flex items-center gap-1">
            <AlertCircle className="w-3.5 h-3.5 text-blue-500" />
            Threading & activity logged automatically
          </div>
          <div className="flex items-center gap-2">
            <button
              type="button"
              onClick={onClose}
              disabled={saving}
              className="px-3 py-1.5 text-xs border border-gray-300 rounded hover:bg-white transition"
            >
              Cancel
            </button>
            <button
              onClick={handleSubmit}
              disabled={saving}
              className="flex items-center gap-1.5 px-3.5 py-1.5 text-xs bg-blue-600 text-white rounded hover:bg-blue-700 transition font-medium disabled:opacity-50"
            >
              <Send className="w-3.5 h-3.5" />
              {saving ? 'Saving...' : sendEmail ? 'Send & Record' : 'Record Follow-up'}
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}
