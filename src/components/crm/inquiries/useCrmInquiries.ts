import { useState, useEffect, useCallback } from 'react';
import { supabase } from '../../../lib/supabase';

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
  customer_id?: string | null;
  contact_person: string | null;
  contact_email: string | null;
  contact_phone: string | null;
  email_subject: string | null;
  mail_subject?: string | null;
  status: string;
  pipeline_status?: string;
  assigned_to?: string | null;
  next_follow_up?: string | null;
  priority: string;
  coa_sent: boolean;
  coa_sent_date: string | null;
  msds_sent: boolean;
  msds_sent_date: string | null;
  sample_sent: boolean;
  sample_sent_date: string | null;
  price_quoted: boolean;
  price_quoted_date: string | null;
  price_required?: boolean;
  coa_required?: boolean;
  sample_required?: boolean;
  agency_letter_required?: boolean;
  price_sent_at?: string | null;
  coa_sent_at?: string | null;
  sample_sent_at?: string | null;
  agency_letter_sent_at?: string | null;
  others_required?: boolean;
  others_sent_at?: string | null;
  aceerp_no?: string | null;
  purchase_price?: number | null;
  purchase_price_currency?: string;
  offered_price?: number | null;
  offered_price_currency?: string;
  delivery_date?: string | null;
  delivery_terms?: string | null;
  lost_reason?: string | null;
  lost_at?: string | null;
  lost_reason_code?: string | null;
  competitor_name?: string | null;
  competitor_price?: number | null;
  remarks: string | null;
  internal_notes: string | null;
  created_at: string;
  updated_at?: string;
  price_ready?: boolean;
  source_type?: string | null;
  source_status?: string | null;
  document_status?: string | null;
  kunal_price_status?: string | null;
  quote_status?: string | null;
  quote_sent_at?: string | null;
  last_sourcing_sent_at?: string | null;
  last_reminder_sent_at?: string | null;
  reminder_count?: number | null;
  kunal_pricing_requested_at?: string | null;
  kunal_pricing_requested_by?: string | null;
  kunal_pricing_note?: string | null;
  is_multi_product?: boolean;
  has_items?: boolean;
  crm_contact_id?: string | null;
  sent_to_india?: boolean;
  sent_to_india_at?: string | null;
  sent_to_india_by?: string | null;
  sales_member_id?: string | null;
  target_price?: number | null;
  estimated_value?: number | null;
  quoted_price?: number | null;
  quoted_currency?: string | null;
  accepted_pricing_option_id?: string | null;
  user_profiles?: {
    full_name: string;
  } | Array<{ full_name: string }> | null;
  [key: string]: any;
}

/**
 * Explicit column selection to prevent massive payload over-fetching.
 * Heavy columns like `email_body` and large JSON attachments are excluded
 * from the operational workspace query.
 */
export const CRM_INQUIRY_SELECT_FIELDS = `
  id, inquiry_number, inquiry_date, product_name, specification, quantity,
  company_name, customer_id, contact_person, contact_email, contact_phone,
  supplier_name, supplier_country, status, pipeline_status, priority,
  purchase_price, purchase_price_currency, offered_price, offered_price_currency,
  delivery_date, delivery_terms, remarks, internal_notes, assigned_to, created_at,
  updated_at, next_follow_up, last_contact_date, price_ready, source_status,
  source_type, document_status, kunal_price_status, quote_status, quote_sent_at,
  last_sourcing_sent_at, last_reminder_sent_at, reminder_count, aceerp_no,
  lost_reason, lost_at, lost_reason_code, competitor_name, competitor_price,
  coa_required, coa_sent, coa_sent_at, coa_sent_date, msds_sent, msds_sent_date,
  sample_required, sample_sent, sample_sent_at, sample_sent_date, price_required,
  price_quoted, price_quoted_date, price_sent_at, agency_letter_required,
  agency_letter_sent_at, others_required, others_sent_at, mail_subject, email_subject,
  is_multi_product, has_items, crm_contact_id, kunal_pricing_requested_at,
  kunal_pricing_requested_by, kunal_pricing_note, sent_to_india, sent_to_india_at,
  sent_to_india_by, sales_member_id, target_price, estimated_value, quoted_price,
  quoted_currency, accepted_pricing_option_id,
  user_profiles:assigned_to (full_name)
`;

// Module-level singleton state for zero-duplicate in-flight requests & caching
let cachedInquiries: Inquiry[] | null = null;
let cachedStaffList: Array<{ id: string; full_name: string }> | null = null;
let inFlightInquiryPromise: Promise<Inquiry[]> | null = null;
let inFlightStaffPromise: Promise<Array<{ id: string; full_name: string }>> | null = null;
let lastFetchedAt: number = 0;
let lastError: string | null = null;
const subscribers = new Set<() => void>();

function notifySubscribers() {
  subscribers.forEach((cb) => {
    try {
      cb();
    } catch (err) {
      console.error('[useCrmInquiries] subscriber notification error:', err);
    }
  });
}

/**
 * Authoritative inquiry fetcher with in-flight deduplication and cache retention.
 */
export async function fetchInquiries(options?: { force?: boolean }): Promise<Inquiry[]> {
  const force = options?.force ?? false;
  const now = Date.now();

  // Return cached result if fresh and not forced
  if (!force && cachedInquiries !== null && now - lastFetchedAt < 30_000) {
    return cachedInquiries;
  }

  // Deduplicate in-flight requests across concurrent callers (e.g. StrictMode, CRM.tsx + Workspace)
  if (inFlightInquiryPromise) {
    return inFlightInquiryPromise;
  }

  inFlightInquiryPromise = (async () => {
    try {
      const { data, error } = await supabase
        .from('crm_inquiries')
        .select(CRM_INQUIRY_SELECT_FIELDS)
        .order('created_at', { ascending: false });

      if (error) {
        throw error;
      }

      cachedInquiries = (data as unknown as Inquiry[]) || [];
      lastFetchedAt = Date.now();
      lastError = null;
      notifySubscribers();
      return cachedInquiries;
    } catch (err: any) {
      console.error('[useCrmInquiries] Error loading inquiries:', err);
      lastError = err?.message || 'Failed to load inquiries';
      // PRESERVE previous cached inquiries on error so UI does not flash empty or zero counts!
      notifySubscribers();
      throw err;
    } finally {
      inFlightInquiryPromise = null;
    }
  })();

  return inFlightInquiryPromise;
}

/**
 * Fetch staff list with caching and in-flight deduplication.
 */
export async function fetchStaffList(options?: { force?: boolean }): Promise<Array<{ id: string; full_name: string }>> {
  if (!options?.force && cachedStaffList !== null) {
    return cachedStaffList;
  }
  if (inFlightStaffPromise) {
    return inFlightStaffPromise;
  }

  inFlightStaffPromise = (async () => {
    try {
      const { data, error } = await supabase
        .from('user_profiles')
        .select('id, full_name')
        .order('full_name', { ascending: true });

      if (error) throw error;
      if (Array.isArray(data)) {
        cachedStaffList = data;
      } else if (data && typeof data === 'object') {
        cachedStaffList = [data as any];
      } else {
        cachedStaffList = [];
      }
      notifySubscribers();
      return cachedStaffList;
    } catch (err) {
      console.error('[useCrmInquiries] Error loading staff list:', err);
      return cachedStaffList || [];
    } finally {
      inFlightStaffPromise = null;
    }
  })();

  return inFlightStaffPromise;
}

export function invalidateInquiriesCache(): void {
  lastFetchedAt = 0;
}

export function updateCachedInquiry(updated: Partial<Inquiry> & { id: string }): void {
  if (!cachedInquiries) return;
  cachedInquiries = cachedInquiries.map((inq) =>
    inq.id === updated.id ? { ...inq, ...updated } : inq
  );
  notifySubscribers();
}

/**
 * Shared React hook for CRM Inquiries data access.
 * Guarantees that only ONE network request is made even when multiple components
 * (or React StrictMode double mounts) request inquiries simultaneously.
 */
export function useCrmInquiries() {
  const [, setTick] = useState(0);
  const [loading, setLoading] = useState<boolean>(!cachedInquiries);

  useEffect(() => {
    let isMounted = true;
    const onChange = () => {
      if (isMounted) {
        setLoading(Boolean(inFlightInquiryPromise));
        setTick((t) => t + 1);
      }
    };

    subscribers.add(onChange);

    // Initial load if not cached or currently fetching
    if (!cachedInquiries) {
      setLoading(true);
      fetchInquiries()
        .catch(() => {})
        .finally(() => {
          if (isMounted) setLoading(false);
        });
    } else if (inFlightInquiryPromise) {
      setLoading(true);
      inFlightInquiryPromise
        .catch(() => {})
        .finally(() => {
          if (isMounted) setLoading(false);
        });
    }

    if (!cachedStaffList) {
      fetchStaffList().catch(() => {});
    }

    return () => {
      isMounted = false;
      subscribers.delete(onChange);
    };
  }, []);

  const refresh = useCallback(async (opts?: { force?: boolean }) => {
    setLoading(true);
    try {
      await Promise.allSettled([
        fetchInquiries({ force: opts?.force ?? true }),
        fetchStaffList({ force: opts?.force ?? false }),
      ]);
    } finally {
      setLoading(false);
    }
  }, []);

  return {
    inquiries: cachedInquiries || [],
    staffList: cachedStaffList || [],
    loading,
    error: lastError,
    refresh,
    updateInquiry: updateCachedInquiry,
  };
}
