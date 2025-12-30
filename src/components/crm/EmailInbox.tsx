import { useEffect, useState } from 'react';
import { supabase } from '../../lib/supabase';
import { Mail, RefreshCw, CheckCircle, Loader, Sparkles, AlertCircle } from 'lucide-react';
import { Modal } from '../Modal';

interface EmailInboxProps {
  onInquiryCreated?: () => void;
}

interface Email {
  id: string;
  from_email: string;
  from_name: string | null;
  subject: string;
  body: string;
  received_date: string;
  is_processed: boolean;
  is_inquiry: boolean;
}

interface ParsedData {
  productName: string;
  quantity: string;
  supplierName?: string;
  supplierCountry?: string;
  companyName: string;
  contactPerson?: string;
  contactEmail: string;
  contactPhone?: string;
  coaRequested: boolean;
  msdsRequested: boolean;
  sampleRequested: boolean;
  priceRequested: boolean;
  urgency: 'low' | 'medium' | 'high' | 'urgent';
  remarks?: string;
  confidence: 'high' | 'medium' | 'low';
  detectedLanguage: string;
}

export function EmailInbox({ onInquiryCreated }: EmailInboxProps) {
  const [emails, setEmails] = useState<Email[]>([]);
  const [loading, setLoading] = useState(true);
  const [parsing, setParsing] = useState(false);
  const [selectedEmail, setSelectedEmail] = useState<Email | null>(null);
  const [parsedData, setParsedData] = useState<ParsedData | null>(null);
  const [showInquiryModal, setShowInquiryModal] = useState(false);
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    loadEmails();
  }, []);

  const loadEmails = async () => {
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
    }
  };

  const parseEmail = async (email: Email) => {
    setParsing(true);
    setSelectedEmail(email);

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

      if (!response.ok) {
        throw new Error('Failed to parse email');
      }

      const result = await response.json();

      if (result.success) {
        setParsedData(result.data);
        setShowInquiryModal(true);
      } else {
        alert('Failed to parse email: ' + result.error);
      }
    } catch (error) {
      console.error('Error parsing email:', error);
      alert('Failed to parse email. Please try again.');
    } finally {
      setParsing(false);
    }
  };

  const createInquiry = async () => {
    if (!parsedData || !selectedEmail) return;

    setSaving(true);
    try {
      const { data: { user } } = await supabase.auth.getUser();
      if (!user) throw new Error('Not authenticated');

      const lastInquiry = await supabase
        .from('crm_inquiries')
        .select('inquiry_number')
        .order('created_at', { ascending: false })
        .limit(1)
        .maybeSingle();

      let nextNumber = 500;
      if (lastInquiry.data?.inquiry_number) {
        const num = parseInt(lastInquiry.data.inquiry_number);
        if (!isNaN(num)) {
          nextNumber = num + 1;
        }
      }

      const inquiryData = {
        inquiry_number: nextNumber.toString(),
        inquiry_date: new Date().toISOString().split('T')[0],
        product_name: parsedData.productName,
        quantity: parsedData.quantity,
        supplier_name: parsedData.supplierName || null,
        supplier_country: parsedData.supplierCountry || null,
        company_name: parsedData.companyName,
        contact_person: parsedData.contactPerson || null,
        contact_email: parsedData.contactEmail,
        contact_phone: parsedData.contactPhone || null,
        email_subject: selectedEmail.subject,
        inquiry_source: 'email',
        email_body: selectedEmail.body,
        status: 'new',
        priority: parsedData.urgency,
        coa_sent: false,
        msds_sent: false,
        sample_sent: false,
        price_quoted: false,
        remarks: parsedData.remarks || null,
        assigned_to: user.id,
        created_by: user.id,
        source: 'email',
        source_email_id: selectedEmail.id,
      };

      const { error: inquiryError } = await supabase
        .from('crm_inquiries')
        .insert([inquiryData]);

      if (inquiryError) throw inquiryError;

      await supabase
        .from('crm_email_inbox')
        .update({
          is_processed: true,
          is_inquiry: true
        })
        .eq('id', selectedEmail.id);

      if (parsedData.coaRequested || parsedData.msdsRequested || parsedData.sampleRequested) {
        const reminders = [];

        if (parsedData.coaRequested) {
          reminders.push({
            reminder_type: 'send_coa',
            title: 'Send COA to customer',
            due_date: new Date(Date.now() + 2 * 24 * 60 * 60 * 1000).toISOString(),
            assigned_to: user.id,
            created_by: user.id,
          });
        }

        if (parsedData.msdsRequested) {
          reminders.push({
            reminder_type: 'send_coa',
            title: 'Send MSDS to customer',
            due_date: new Date(Date.now() + 2 * 24 * 60 * 60 * 1000).toISOString(),
            assigned_to: user.id,
            created_by: user.id,
          });
        }

        if (parsedData.sampleRequested) {
          reminders.push({
            reminder_type: 'send_sample',
            title: 'Send sample to customer',
            due_date: new Date(Date.now() + 3 * 24 * 60 * 60 * 1000).toISOString(),
            assigned_to: user.id,
            created_by: user.id,
          });
        }

        if (reminders.length > 0) {
          await supabase.from('crm_reminders').insert(reminders);
        }
      }

      setShowInquiryModal(false);
      setParsedData(null);
      setSelectedEmail(null);
      loadEmails();

      if (onInquiryCreated) {
        onInquiryCreated();
      }

      alert('Inquiry created successfully!');
    } catch (error) {
      console.error('Error creating inquiry:', error);
      alert('Failed to create inquiry. Please try again.');
    } finally {
      setSaving(false);
    }
  };

  const markAsProcessed = async (emailId: string) => {
    try {
      await supabase
        .from('crm_email_inbox')
        .update({ is_processed: true })
        .eq('id', emailId);

      loadEmails();
    } catch (error) {
      console.error('Error marking email as processed:', error);
    }
  };

  const confidenceColor = {
    high: 'text-green-600 bg-green-50',
    medium: 'text-yellow-600 bg-yellow-50',
    low: 'text-red-600 bg-red-50',
  };

  const urgencyColor = {
    urgent: 'bg-red-100 text-red-800',
    high: 'bg-orange-100 text-orange-800',
    medium: 'bg-yellow-100 text-yellow-800',
    low: 'bg-gray-100 text-gray-800',
  };

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-2">
          <Mail className="w-5 h-5 text-gray-600" />
          <h3 className="text-lg font-semibold">Email Inbox</h3>
          <span className="text-sm text-gray-500">({emails.length} unprocessed)</span>
        </div>
        <button
          onClick={loadEmails}
          disabled={loading}
          className="flex items-center gap-2 px-3 py-1.5 text-sm bg-gray-100 hover:bg-gray-200 rounded-lg transition"
        >
          <RefreshCw className={`w-4 h-4 ${loading ? 'animate-spin' : ''}`} />
          Refresh
        </button>
      </div>

      {loading ? (
        <div className="flex justify-center items-center py-12">
          <Loader className="w-8 h-8 animate-spin text-blue-600" />
        </div>
      ) : emails.length === 0 ? (
        <div className="text-center py-12 bg-gray-50 rounded-lg">
          <Mail className="w-12 h-12 mx-auto text-gray-300 mb-3" />
          <p className="text-gray-500">No unprocessed emails</p>
        </div>
      ) : (
        <div className="space-y-2">
          {emails.map((email) => (
            <div
              key={email.id}
              className="bg-white border border-gray-200 rounded-lg p-4 hover:shadow-md transition"
            >
              <div className="flex items-start justify-between">
                <div className="flex-1">
                  <div className="flex items-center gap-2 mb-1">
                    <span className="font-semibold text-gray-900">
                      {email.from_name || email.from_email}
                    </span>
                    <span className="text-xs text-gray-500">
                      {new Date(email.received_date).toLocaleString()}
                    </span>
                  </div>
                  <p className="text-sm text-gray-600 mb-1">{email.from_email}</p>
                  <p className="font-medium text-gray-900 mb-2">{email.subject}</p>
                  <p className="text-sm text-gray-600 line-clamp-2">{email.body.substring(0, 200)}...</p>
                </div>
                <div className="flex gap-2 ml-4">
                  <button
                    onClick={() => parseEmail(email)}
                    disabled={parsing}
                    className="flex items-center gap-2 px-4 py-2 bg-blue-600 text-white rounded-lg hover:bg-blue-700 transition disabled:opacity-50 text-sm"
                  >
                    <Sparkles className="w-4 h-4" />
                    {parsing && selectedEmail?.id === email.id ? 'Parsing...' : 'AI Parse'}
                  </button>
                  <button
                    onClick={() => markAsProcessed(email.id)}
                    className="p-2 text-gray-600 hover:bg-gray-100 rounded-lg transition"
                    title="Mark as processed"
                  >
                    <CheckCircle className="w-5 h-5" />
                  </button>
                </div>
              </div>
            </div>
          ))}
        </div>
      )}

      <Modal
        isOpen={showInquiryModal}
        onClose={() => {
          setShowInquiryModal(false);
          setParsedData(null);
          setSelectedEmail(null);
        }}
        title="AI Parsed Inquiry - Confirm & Create"
      >
        {parsedData && (
          <div className="space-y-4">
            <div className="bg-blue-50 border border-blue-200 rounded-lg p-4">
              <div className="flex items-start gap-3">
                <Sparkles className="w-5 h-5 text-blue-600 mt-0.5" />
                <div className="flex-1">
                  <p className="font-medium text-blue-900 mb-1">AI Detection Complete</p>
                  <div className="flex items-center gap-2">
                    <span className={`text-xs px-2 py-1 rounded-full ${confidenceColor[parsedData.confidence]}`}>
                      {parsedData.confidence.toUpperCase()} Confidence
                    </span>
                    <span className="text-xs text-blue-700">
                      Language: {parsedData.detectedLanguage}
                    </span>
                  </div>
                </div>
              </div>
            </div>

            <div className="grid grid-cols-2 gap-4">
              <div className="col-span-2">
                <label className="block text-sm font-medium text-gray-700 mb-1">
                  Product Name
                </label>
                <input
                  type="text"
                  value={parsedData.productName}
                  onChange={(e) => setParsedData({ ...parsedData, productName: e.target.value })}
                  className="w-full px-3 py-2 border border-gray-300 rounded-lg focus:ring-2 focus:ring-blue-500"
                />
              </div>

              <div>
                <label className="block text-sm font-medium text-gray-700 mb-1">
                  Quantity
                </label>
                <input
                  type="text"
                  value={parsedData.quantity}
                  onChange={(e) => setParsedData({ ...parsedData, quantity: e.target.value })}
                  className="w-full px-3 py-2 border border-gray-300 rounded-lg focus:ring-2 focus:ring-blue-500"
                />
              </div>

              <div>
                <label className="block text-sm font-medium text-gray-700 mb-1">
                  Priority
                </label>
                <div className="flex items-center gap-2">
                  <select
                    value={parsedData.urgency}
                    onChange={(e) => setParsedData({ ...parsedData, urgency: e.target.value as any })}
                    className="flex-1 px-3 py-2 border border-gray-300 rounded-lg focus:ring-2 focus:ring-blue-500"
                  >
                    <option value="low">Low</option>
                    <option value="medium">Medium</option>
                    <option value="high">High</option>
                    <option value="urgent">Urgent</option>
                  </select>
                  <span className={`text-xs px-2 py-1 rounded-full ${urgencyColor[parsedData.urgency]}`}>
                    {parsedData.urgency.toUpperCase()}
                  </span>
                </div>
              </div>

              <div>
                <label className="block text-sm font-medium text-gray-700 mb-1">
                  Supplier / Manufacturer
                </label>
                <input
                  type="text"
                  value={parsedData.supplierName || ''}
                  onChange={(e) => setParsedData({ ...parsedData, supplierName: e.target.value })}
                  className="w-full px-3 py-2 border border-gray-300 rounded-lg focus:ring-2 focus:ring-blue-500"
                  placeholder="Optional"
                />
              </div>

              <div>
                <label className="block text-sm font-medium text-gray-700 mb-1">
                  Country of Origin
                </label>
                <input
                  type="text"
                  value={parsedData.supplierCountry || ''}
                  onChange={(e) => setParsedData({ ...parsedData, supplierCountry: e.target.value })}
                  className="w-full px-3 py-2 border border-gray-300 rounded-lg focus:ring-2 focus:ring-blue-500"
                  placeholder="Optional"
                />
              </div>

              <div>
                <label className="block text-sm font-medium text-gray-700 mb-1">
                  Company Name
                </label>
                <input
                  type="text"
                  value={parsedData.companyName}
                  onChange={(e) => setParsedData({ ...parsedData, companyName: e.target.value })}
                  className="w-full px-3 py-2 border border-gray-300 rounded-lg focus:ring-2 focus:ring-blue-500"
                />
              </div>

              <div>
                <label className="block text-sm font-medium text-gray-700 mb-1">
                  Contact Person
                </label>
                <input
                  type="text"
                  value={parsedData.contactPerson || ''}
                  onChange={(e) => setParsedData({ ...parsedData, contactPerson: e.target.value })}
                  className="w-full px-3 py-2 border border-gray-300 rounded-lg focus:ring-2 focus:ring-blue-500"
                  placeholder="Optional"
                />
              </div>

              <div>
                <label className="block text-sm font-medium text-gray-700 mb-1">
                  Contact Phone / WhatsApp
                </label>
                <input
                  type="text"
                  value={parsedData.contactPhone || ''}
                  onChange={(e) => setParsedData({ ...parsedData, contactPhone: e.target.value })}
                  className="w-full px-3 py-2 border border-gray-300 rounded-lg focus:ring-2 focus:ring-blue-500"
                  placeholder="Optional"
                />
              </div>

              <div className="col-span-2">
                <label className="block text-sm font-medium text-gray-700 mb-2">
                  Documents Requested
                </label>
                <div className="flex flex-wrap gap-3">
                  <label className="flex items-center gap-2">
                    <input
                      type="checkbox"
                      checked={parsedData.coaRequested}
                      onChange={(e) => setParsedData({ ...parsedData, coaRequested: e.target.checked })}
                      className="w-4 h-4 text-blue-600 rounded"
                    />
                    <span className="text-sm">COA Requested</span>
                  </label>
                  <label className="flex items-center gap-2">
                    <input
                      type="checkbox"
                      checked={parsedData.msdsRequested}
                      onChange={(e) => setParsedData({ ...parsedData, msdsRequested: e.target.checked })}
                      className="w-4 h-4 text-blue-600 rounded"
                    />
                    <span className="text-sm">MSDS Requested</span>
                  </label>
                  <label className="flex items-center gap-2">
                    <input
                      type="checkbox"
                      checked={parsedData.sampleRequested}
                      onChange={(e) => setParsedData({ ...parsedData, sampleRequested: e.target.checked })}
                      className="w-4 h-4 text-blue-600 rounded"
                    />
                    <span className="text-sm">Sample Requested</span>
                  </label>
                  <label className="flex items-center gap-2">
                    <input
                      type="checkbox"
                      checked={parsedData.priceRequested}
                      onChange={(e) => setParsedData({ ...parsedData, priceRequested: e.target.checked })}
                      className="w-4 h-4 text-blue-600 rounded"
                    />
                    <span className="text-sm">Price Quote Requested</span>
                  </label>
                </div>
              </div>

              {parsedData.remarks && (
                <div className="col-span-2">
                  <label className="block text-sm font-medium text-gray-700 mb-1">
                    Additional Remarks
                  </label>
                  <textarea
                    value={parsedData.remarks}
                    onChange={(e) => setParsedData({ ...parsedData, remarks: e.target.value })}
                    className="w-full px-3 py-2 border border-gray-300 rounded-lg focus:ring-2 focus:ring-blue-500"
                    rows={3}
                  />
                </div>
              )}
            </div>

            {parsedData.confidence === 'low' && (
              <div className="bg-yellow-50 border border-yellow-200 rounded-lg p-3 flex items-start gap-2">
                <AlertCircle className="w-5 h-5 text-yellow-600 mt-0.5" />
                <div>
                  <p className="text-sm font-medium text-yellow-900">Low Confidence Detection</p>
                  <p className="text-xs text-yellow-700 mt-1">
                    Please review and correct the extracted information before creating the inquiry.
                  </p>
                </div>
              </div>
            )}

            <div className="flex justify-end gap-3 pt-4 border-t">
              <button
                type="button"
                onClick={() => {
                  setShowInquiryModal(false);
                  setParsedData(null);
                  setSelectedEmail(null);
                }}
                className="px-4 py-2 border border-gray-300 rounded-lg hover:bg-gray-50 transition"
              >
                Cancel
              </button>
              <button
                onClick={createInquiry}
                disabled={saving}
                className="flex items-center gap-2 px-6 py-2 bg-blue-600 text-white rounded-lg hover:bg-blue-700 transition disabled:opacity-50"
              >
                {saving ? (
                  <>
                    <Loader className="w-4 h-4 animate-spin" />
                    Creating...
                  </>
                ) : (
                  <>
                    <CheckCircle className="w-4 h-4" />
                    Confirm & Create Inquiry
                  </>
                )}
              </button>
            </div>
          </div>
        )}
      </Modal>
    </div>
  );
}
