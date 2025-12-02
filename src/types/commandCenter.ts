export interface Email {
  id: string;
  from_email: string;
  from_name: string | null;
  subject: string;
  body: string;
  received_date: string;
  is_processed: boolean;
  is_inquiry: boolean;
}

export interface ParsedEmailData {
  productName: string;
  specification?: string;
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
  agencyLetterRequested?: boolean;
  purposeIcons: string[];
  deliveryDateExpected?: string;
  urgency: 'low' | 'medium' | 'high' | 'urgent';
  remarks?: string;
  confidence: 'high' | 'medium' | 'low';
  confidenceScore: number;
  detectedLanguage: string;
  autoDetectedCompany: boolean;
  autoDetectedContact: boolean;
}

export interface Inquiry {
  id: string;
  inquiry_number: string;
  inquiry_date: string;
  product_name: string;
  specification?: string | null;
  quantity: string;
  supplier_name: string | null;
  supplier_country: string | null;
  company_name: string;
  contact_person: string | null;
  contact_email: string | null;
  contact_phone: string | null;
  email_subject: string | null;
  status: string;
  priority: string;
  purpose_icons?: string[];
  delivery_date_expected?: string;
  ai_confidence_score?: number;
  auto_detected_company?: boolean;
  auto_detected_contact?: boolean;
  remarks: string | null;
  internal_notes: string | null;
  created_at: string;
}

export interface QuickAction {
  id: string;
  action_type: 'send_price' | 'send_coa' | 'send_msds' | 'send_sample' | 'follow_up' | 'send_agency_letter';
  label: string;
  icon: string;
  color: string;
}

export interface ActivityOutcome {
  value: 'customer_will_revert' | 'could_not_reach' | 'discussed_price' | 'discussed_coa' | 'discussed_sample' | 'positive' | 'negative' | 'other';
  label: string;
  followUpDays: number;
}
