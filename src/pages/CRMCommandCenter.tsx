import { useState } from 'react';
import { Layout } from '../components/Layout';
import { EmailListPanel } from '../components/commandCenter/EmailListPanel';
import { InquiryFormPanel, InquiryFormData } from '../components/commandCenter/InquiryFormPanel';
import { QuickActionsPanel } from '../components/commandCenter/QuickActionsPanel';
import { supabase } from '../lib/supabase';
import { useAuth } from '../contexts/AuthContext';
import type { Email, ParsedEmailData, Inquiry } from '../types/commandCenter';
import { CheckCircle2, Zap } from 'lucide-react';

function parseDeliveryDate(dateStr: string | undefined | null): string | null {
  if (!dateStr) return null;

  const trimmed = dateStr.trim();
  if (!trimmed) return null;

  // Already in YYYY-MM-DD format
  if (/^\d{4}-\d{2}-\d{2}$/.test(trimmed)) {
    return trimmed;
  }

  // Handle DD.MM.YY format (e.g., "03.04.26" -> "2026-04-03")
  const ddmmyyDot = trimmed.match(/^(\d{1,2})\.(\d{1,2})\.(\d{2})$/);
  if (ddmmyyDot) {
    const day = ddmmyyDot[1].padStart(2, '0');
    const month = ddmmyyDot[2].padStart(2, '0');
    const year = parseInt(ddmmyyDot[3]) < 50 ? `20${ddmmyyDot[3]}` : `19${ddmmyyDot[3]}`;
    return `${year}-${month}-${day}`;
  }

  // Handle DD/MM/YY format
  const ddmmyySlash = trimmed.match(/^(\d{1,2})\/(\d{1,2})\/(\d{2})$/);
  if (ddmmyySlash) {
    const day = ddmmyySlash[1].padStart(2, '0');
    const month = ddmmyySlash[2].padStart(2, '0');
    const year = parseInt(ddmmyySlash[3]) < 50 ? `20${ddmmyySlash[3]}` : `19${ddmmyySlash[3]}`;
    return `${year}-${month}-${day}`;
  }

  // Handle DD/MM/YYYY format
  const ddmmyyyySlash = trimmed.match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})$/);
  if (ddmmyyyySlash) {
    const day = ddmmyyyySlash[1].padStart(2, '0');
    const month = ddmmyyyySlash[2].padStart(2, '0');
    const year = ddmmyyyySlash[3];
    return `${year}-${month}-${day}`;
  }

  // Handle DD-MM-YYYY format
  const ddmmyyyyDash = trimmed.match(/^(\d{1,2})-(\d{1,2})-(\d{4})$/);
  if (ddmmyyyyDash) {
    const day = ddmmyyyyDash[1].padStart(2, '0');
    const month = ddmmyyyyDash[2].padStart(2, '0');
    const year = ddmmyyyyDash[3];
    return `${year}-${month}-${day}`;
  }

  // Try parsing as ISO date
  try {
    const date = new Date(trimmed);
    if (!isNaN(date.getTime())) {
      return date.toISOString().split('T')[0];
    }
  } catch (e) {
    console.warn('Could not parse date:', trimmed);
  }

  return null;
}

export function CRMCommandCenter() {
  const { profile } = useAuth();
  const [selectedEmail, setSelectedEmail] = useState<Email | null>(null);
  const [parsedData, setParsedData] = useState<ParsedEmailData | null>(null);
  const [createdInquiry, setCreatedInquiry] = useState<Inquiry | null>(null);
  const [saving, setSaving] = useState(false);

  const handleEmailSelect = (email: Email, data: ParsedEmailData | null) => {
    setSelectedEmail(email);
    setParsedData(data);
    setCreatedInquiry(null);
  };

  const handleSave = async (formData: InquiryFormData) => {
    if (!selectedEmail || !profile) return;

    setSaving(true);

    try {
      const { data: { user } } = await supabase.auth.getUser();
      if (!user) throw new Error('Not authenticated');

      // Check if customer exists by email or company name
      let customerId = null;
      const { data: existingCustomers } = await supabase
        .from('customers')
        .select('id, company_name, email, contact_person, phone, address')
        .or(`email.eq.${formData.contactEmail},company_name.ilike.${formData.companyName}`)
        .limit(1)
        .maybeSingle();

      if (existingCustomers) {
        customerId = existingCustomers.id;

        // Update customer info if we have new data
        const updates: any = {};
        if (formData.contactPerson && !existingCustomers.contact_person) {
          updates.contact_person = formData.contactPerson;
        }
        if (formData.contactPhone && !existingCustomers.phone) {
          updates.phone = formData.contactPhone;
        }
        if (formData.contactEmail && formData.contactEmail !== existingCustomers.email) {
          updates.email = formData.contactEmail;
        }

        if (Object.keys(updates).length > 0) {
          await supabase
            .from('customers')
            .update({ ...updates, updated_at: new Date().toISOString() })
            .eq('id', customerId);
        }
      } else {
        // Create new customer
        const { data: newCustomer, error: customerError } = await supabase
          .from('customers')
          .insert({
            customer_name: formData.companyName,
            company_name: formData.companyName,
            contact_person: formData.contactPerson || null,
            email: formData.contactEmail,
            phone: formData.contactPhone || null,
            is_active: true,
            created_by: user.id,
          })
          .select()
          .single();

        if (!customerError && newCustomer) {
          customerId = newCustomer.id;
        }
      }

      const inquiryData = {
        customer_id: customerId,
        inquiry_date: new Date().toISOString().split('T')[0],
        product_name: formData.productName,
        specification: formData.specification || null,
        quantity: formData.quantity,
        supplier_name: formData.supplierName || null,
        supplier_country: formData.supplierCountry || null,
        company_name: formData.companyName,
        contact_person: formData.contactPerson || null,
        contact_email: formData.contactEmail,
        contact_phone: formData.contactPhone || null,
        mail_subject: selectedEmail.subject,
        email_body: selectedEmail.body,
        inquiry_source: 'email',
        status: 'new',
        pipeline_status: 'new',
        priority: formData.priority,
        purpose_icons: formData.purposeIcons,
        delivery_date_expected: parseDeliveryDate(formData.deliveryDateExpected),
        ai_confidence_score: parsedData?.confidenceScore || 0.0,
        auto_detected_company: parsedData?.autoDetectedCompany || false,
        auto_detected_contact: parsedData?.autoDetectedContact || false,
        coa_sent: false,
        msds_sent: false,
        sample_sent: false,
        price_quoted: false,
        // New fields for unified tracking
        price_required: formData.priceRequested,
        coa_required: formData.coaRequested,
        sample_required: formData.sampleRequested,
        agency_letter_required: formData.agencyLetterRequested || false,
        aceerp_no: formData.aceerp_no || null,
        purchase_price: formData.purchasePrice ? parseFloat(formData.purchasePrice) : null,
        purchase_price_currency: formData.purchasePriceCurrency || 'USD',
        offered_price: formData.offeredPrice ? parseFloat(formData.offeredPrice) : null,
        offered_price_currency: formData.offeredPriceCurrency || 'USD',
        delivery_date: formData.deliveryDate || null,
        delivery_terms: formData.deliveryTerms || null,
        remarks: formData.remarks || null,
        assigned_to: user.id,
        created_by: user.id,
        source: 'email',
        source_email_id: selectedEmail.id,
      };

      const { data: inquiry, error: inquiryError } = await supabase
        .from('crm_inquiries')
        .insert([inquiryData])
        .select()
        .single();

      if (inquiryError) throw inquiryError;

      await supabase
        .from('crm_email_inbox')
        .update({
          is_processed: true,
          is_inquiry: true,
          converted_to_inquiry: inquiry.id,
        })
        .eq('id', selectedEmail.id);

      if (formData.coaRequested || formData.msdsRequested || formData.sampleRequested || formData.priceRequested || formData.agencyLetterRequested) {
        const reminders = [];

        if (formData.priceRequested) {
          reminders.push({
            inquiry_id: inquiry.id,
            reminder_type: 'send_price',
            title: 'Send price quote to customer',
            due_date: new Date(Date.now() + 1 * 24 * 60 * 60 * 1000).toISOString(),
            assigned_to: user.id,
            created_by: user.id,
          });
        }

        if (formData.coaRequested) {
          reminders.push({
            inquiry_id: inquiry.id,
            reminder_type: 'send_coa',
            title: 'Send COA to customer',
            due_date: new Date(Date.now() + 2 * 24 * 60 * 60 * 1000).toISOString(),
            assigned_to: user.id,
            created_by: user.id,
          });
        }

        if (formData.msdsRequested) {
          reminders.push({
            inquiry_id: inquiry.id,
            reminder_type: 'send_msds',
            title: 'Send MSDS to customer',
            due_date: new Date(Date.now() + 2 * 24 * 60 * 60 * 1000).toISOString(),
            assigned_to: user.id,
            created_by: user.id,
          });
        }

        if (formData.sampleRequested) {
          reminders.push({
            inquiry_id: inquiry.id,
            reminder_type: 'send_sample',
            title: 'Send sample to customer',
            due_date: new Date(Date.now() + 3 * 24 * 60 * 60 * 1000).toISOString(),
            assigned_to: user.id,
            created_by: user.id,
          });
        }

        if (formData.agencyLetterRequested) {
          reminders.push({
            inquiry_id: inquiry.id,
            reminder_type: 'send_agency_letter',
            title: 'Send agency letter to customer',
            due_date: new Date(Date.now() + 1 * 24 * 60 * 60 * 1000).toISOString(),
            assigned_to: user.id,
            created_by: user.id,
          });
        }

        if (reminders.length > 0) {
          await supabase.from('crm_reminders').insert(reminders);
        }
      }

      setCreatedInquiry(inquiry);
      setParsedData(null);

      alert(`Inquiry #${inquiry.inquiry_number} created successfully!\n\nUse Quick Actions to send documents.`);
    } catch (error: any) {
      console.error('Error creating inquiry:', error);
      if (error.message?.includes('duplicate key')) {
        alert('This inquiry number already exists. Please use a different number.');
      } else {
        alert('Failed to create inquiry. Please try again.');
      }
    } finally {
      setSaving(false);
    }
  };

  const handleActionComplete = () => {
    setCreatedInquiry(null);
    setSelectedEmail(null);
    setParsedData(null);
  };

  return (
    <Layout>
      <div className="h-screen flex flex-col">
        <div className="flex-shrink-0 bg-gradient-to-r from-blue-600 to-blue-700 px-4 py-2 border-b border-blue-800">
          <div className="flex items-center justify-between">
            <div className="flex items-center gap-2">
              <Zap className="w-5 h-5 text-white" />
              <div>
                <h1 className="text-lg font-bold text-white">CRM Command Center</h1>
                <p className="text-blue-100 text-xs">AI-powered inquiry processing</p>
              </div>
            </div>
            <div className="text-right">
              <p className="text-xs text-blue-200">Quick Actions</p>
              <p className="text-xl font-bold text-white">2 Clicks</p>
            </div>
          </div>
        </div>

        <div className="flex-1 flex overflow-hidden">
          <div className="w-1/4 min-w-[300px] max-w-[400px]">
            <EmailListPanel
              onEmailSelect={handleEmailSelect}
              selectedEmailId={selectedEmail?.id || null}
            />
          </div>

          <div className="flex-1">
            <InquiryFormPanel
              email={selectedEmail}
              parsedData={parsedData}
              onSave={handleSave}
              saving={saving}
            />
          </div>

          <div className="w-1/4 min-w-[300px] max-w-[400px]">
            <QuickActionsPanel
              inquiry={createdInquiry}
              onActionComplete={handleActionComplete}
            />
          </div>
        </div>

        {createdInquiry && (
          <div className="flex-shrink-0 bg-green-50 border-t border-green-200 px-6 py-3">
            <div className="flex items-center justify-center gap-2 text-green-800">
              <CheckCircle2 className="w-5 h-5" />
              <span className="font-medium">
                Inquiry #{createdInquiry.inquiry_number} created successfully! Use Quick Actions on the right →
              </span>
            </div>
          </div>
        )}
      </div>
    </Layout>
  );
}
