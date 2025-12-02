import { useState, useEffect } from 'react';
import { FileText, Sparkles, AlertTriangle, CheckCircle2, Calendar, Package, Building2, Mail, ChevronDown, ChevronUp } from 'lucide-react';
import type { Email, ParsedEmailData } from '../../types/commandCenter';
import { CompactInquiryForm } from '../crm/CompactInquiryForm';
import { EmailBodyViewer } from '../crm/EmailBodyViewer';

interface InquiryFormPanelProps {
  email: Email | null;
  parsedData: ParsedEmailData | null;
  onSave: (data: InquiryFormData) => Promise<void>;
  saving: boolean;
}

export interface InquiryFormData {
  inquiryNumber: string;
  productName: string;
  specification: string;
  quantity: string;
  supplierName: string;
  supplierCountry: string;
  companyName: string;
  contactPerson: string;
  contactEmail: string;
  contactPhone: string;
  priority: 'low' | 'medium' | 'high' | 'urgent';
  purposeIcons: string[];
  deliveryDateExpected: string;
  remarks: string;
  coaRequested: boolean;
  msdsRequested: boolean;
  sampleRequested: boolean;
  priceRequested: boolean;
  agencyLetterRequested: boolean;
  aceerp_no: string;
  purchasePrice: string;
  purchasePriceCurrency: string;
  offeredPrice: string;
  offeredPriceCurrency: string;
  deliveryDate: string;
  deliveryTerms: string;
}

export function InquiryFormPanel({ email, parsedData, onSave, saving }: InquiryFormPanelProps) {
  const [showEmailBody, setShowEmailBody] = useState(false);
  const [initialData, setInitialData] = useState<any>(null);

  useEffect(() => {
    if (parsedData) {
      setInitialData({
        product_name: parsedData.productName || '',
        specification: parsedData.specification || '',
        quantity: parsedData.quantity || '',
        supplier_name: parsedData.supplierName || '',
        supplier_country: parsedData.supplierCountry || '',
        company_name: parsedData.companyName || '',
        contact_person: parsedData.contactPerson || '',
        contact_email: parsedData.contactEmail || '',
        contact_phone: parsedData.contactPhone || '',
        priority: parsedData.urgency || 'medium',
        delivery_date: parsedData.deliveryDateExpected || '',
        remarks: parsedData.remarks || '',
        coa_required: parsedData.coaRequested || false,
        sample_required: parsedData.sampleRequested || false,
        price_required: parsedData.priceRequested || true,
        agency_letter_required: parsedData.agencyLetterRequested || false,
        aceerp_no: '',
        purchase_price: '',
        purchase_price_currency: 'USD',
        offered_price: '',
        offered_price_currency: 'USD',
        delivery_terms: '',
        inquiry_source: 'email',
        mail_subject: email?.subject || '',
      });
    }
  }, [parsedData, email]);

  const handleFormSubmit = async (formData: any) => {
    const convertedData: InquiryFormData = {
      inquiryNumber: '',
      productName: formData.product_name,
      specification: formData.specification || '',
      quantity: formData.quantity,
      supplierName: formData.supplier_name || '',
      supplierCountry: formData.supplier_country || '',
      companyName: formData.company_name,
      contactPerson: formData.contact_person || '',
      contactEmail: formData.contact_email || '',
      contactPhone: formData.contact_phone || '',
      priority: formData.priority,
      purposeIcons: [],
      deliveryDateExpected: formData.delivery_date || '',
      remarks: formData.remarks || '',
      coaRequested: formData.coa_required || false,
      msdsRequested: false,
      sampleRequested: formData.sample_required || false,
      priceRequested: formData.price_required || false,
      agencyLetterRequested: formData.agency_letter_required || false,
      aceerp_no: formData.aceerp_no || '',
      purchasePrice: formData.purchase_price || '',
      purchasePriceCurrency: formData.purchase_price_currency || 'USD',
      offeredPrice: formData.offered_price || '',
      offeredPriceCurrency: formData.offered_price_currency || 'USD',
      deliveryDate: formData.delivery_date || '',
      deliveryTerms: formData.delivery_terms || '',
    };

    await onSave(convertedData);
  };

  const confidenceColor = {
    high: 'text-green-600 bg-green-50 border-green-200',
    medium: 'text-yellow-600 bg-yellow-50 border-yellow-200',
    low: 'text-red-600 bg-red-50 border-red-200',
  };

  if (!email || !parsedData) {
    return (
      <div className="flex flex-col items-center justify-center h-full text-center px-8 bg-gray-50">
        <FileText className="w-20 h-20 text-gray-300 mb-4" />
        <h3 className="text-lg font-semibold text-gray-900 mb-2">No Email Selected</h3>
        <p className="text-gray-600 max-w-md">
          Click on an email from the left panel to automatically parse and fill this inquiry form with AI
        </p>
        <div className="mt-6 text-sm text-gray-500 space-y-1">
          <p className="flex items-center gap-2 justify-center">
            <Sparkles className="w-4 h-4 text-blue-500" />
            <span>AI extracts product, quantity, company, contact</span>
          </p>
          <p className="flex items-center gap-2 justify-center">
            <CheckCircle2 className="w-4 h-4 text-green-500" />
            <span>Only inquiry number needs manual input</span>
          </p>
        </div>
      </div>
    );
  }

  return (
    <div className="flex flex-col h-full bg-white">
      <div className="px-6 py-4 border-b border-gray-200 bg-gradient-to-r from-blue-50 to-transparent">
        <div className="flex items-center justify-between mb-2">
          <h2 className="text-lg font-semibold text-gray-900">Create Inquiry</h2>
          {parsedData && (
            <div className={`px-3 py-1 rounded-lg text-sm font-medium border ${confidenceColor[parsedData.confidence]}`}>
              <div className="flex items-center gap-1.5">
                <Sparkles className="w-3.5 h-3.5" />
                <span>AI Confidence: {parsedData.confidence.toUpperCase()}</span>
                <span className="text-xs">({Math.round(parsedData.confidenceScore * 100)}%)</span>
              </div>
            </div>
          )}
        </div>

        {email && (
          <div className="mt-3 bg-white border border-gray-300 rounded-lg shadow-sm overflow-hidden">
            <button
              type="button"
              onClick={() => setShowEmailBody(!showEmailBody)}
              className="w-full flex items-center justify-between px-5 py-3 hover:bg-gray-50 transition border-b border-gray-200"
            >
              <div className="flex items-center gap-3 flex-1">
                <div className="w-10 h-10 rounded-full bg-blue-100 flex items-center justify-center flex-shrink-0">
                  <span className="text-sm font-bold text-blue-700">
                    {(email.from_name || email.from_email).charAt(0).toUpperCase()}
                  </span>
                </div>
                <div className="text-left flex-1 min-w-0">
                  <p className="text-base font-semibold text-gray-900 truncate">{email.subject}</p>
                  <div className="flex items-center gap-2 mt-0.5">
                    <p className="text-sm text-gray-900 font-medium">{email.from_name || 'Unknown'}</p>
                    <span className="text-gray-400 text-xs">•</span>
                    <p className="text-xs text-gray-500 truncate">&lt;{email.from_email}&gt;</p>
                  </div>
                </div>
              </div>
              {showEmailBody ? (
                <ChevronUp className="w-5 h-5 text-gray-500 flex-shrink-0 ml-2" />
              ) : (
                <ChevronDown className="w-5 h-5 text-gray-500 flex-shrink-0 ml-2" />
              )}
            </button>
            {showEmailBody && (
              <div className="bg-white">
                <div className="px-5 py-3 border-b border-gray-100 bg-gray-50">
                  <p className="text-xs text-gray-500 uppercase tracking-wide font-semibold">
                    {new Date(email.received_date).toLocaleString('en-US', {
                      weekday: 'short',
                      year: 'numeric',
                      month: 'short',
                      day: 'numeric',
                      hour: '2-digit',
                      minute: '2-digit'
                    })}
                  </p>
                </div>
                <div className="px-5 py-4">
                  <EmailBodyViewer htmlContent={email.body} className="max-h-[600px]" />
                </div>
                <div className="px-5 py-3 bg-blue-50 border-t border-blue-100">
                  <div className="flex items-center gap-2 text-sm text-blue-700">
                    <Sparkles className="w-4 h-4" />
                    <span className="font-medium">AI has extracted data from this email. Review the form fields below.</span>
                  </div>
                </div>
              </div>
            )}
          </div>
        )}

        {parsedData?.autoDetectedCompany && (
          <div className="flex items-center gap-2 text-sm text-green-700 bg-green-50 px-3 py-1.5 rounded-lg mt-3">
            <CheckCircle2 className="w-4 h-4" />
            <span>Company auto-detected from email domain</span>
          </div>
        )}
      </div>

      <div className="flex-1 overflow-y-auto px-6 py-4">
        <div className="space-y-4">
          <div className="bg-green-50 border border-green-200 rounded-lg p-4 mb-4">
            <div className="flex items-start gap-3">
              <CheckCircle2 className="w-5 h-5 text-green-600 mt-0.5 flex-shrink-0" />
              <div>
                <p className="text-sm font-medium text-green-900 mb-1">Auto-Generated Inquiry Number</p>
                <p className="text-xs text-green-700">
                  Inquiry number will be automatically generated when you save (format: INQ-2025-NNNN)
                </p>
              </div>
            </div>
          </div>

          {initialData && (
            <CompactInquiryForm
              onSubmit={handleFormSubmit}
              onCancel={() => {}}
              initialData={initialData}
              isEditing={false}
            />
          )}
        </div>
      </div>
    </div>
  );
}
