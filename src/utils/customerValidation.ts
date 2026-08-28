import { supabase } from '../lib/supabase';

export const DUPLICATE_CUSTOMER_MESSAGE = 'A customer with this name already exists.';

export const normalizeCustomerName = (name: string) =>
  name.trim().toLowerCase().replace(/[^a-z0-9]+/g, '');

export const normalizeCustomerTaxId = (value: string | null | undefined) =>
  (value || '').replace(/[^0-9]/g, '');

export const normalizeCustomerEmail = (value: string | null | undefined) =>
  (value || '').trim().toLowerCase();

export const normalizeCustomerPhone = (value: string | null | undefined) =>
  (value || '').replace(/[^0-9]/g, '');

export type PossibleCustomerMatch = {
  id: string;
  company_name: string;
  npwp?: string | null;
  email?: string | null;
  phone?: string | null;
  address?: string | null;
  evidence: string[];
};

export const findPossibleCustomerMatches = (
  candidate: { company_name: string; npwp?: string | null; email?: string | null; phone?: string | null; address?: string | null },
  existing: PossibleCustomerMatch[],
  excludeId?: string,
): PossibleCustomerMatch[] => {
  const name = normalizeCustomerName(candidate.company_name);
  const tax = normalizeCustomerTaxId(candidate.npwp);
  const email = normalizeCustomerEmail(candidate.email);
  const phone = normalizeCustomerPhone(candidate.phone);
  const address = normalizeCustomerName(candidate.address || '');
  return existing.filter(row => {
    if (row.id === excludeId) return false;
    const hasStrongEvidence = Boolean(
      (tax && tax === normalizeCustomerTaxId(row.npwp)) ||
      (email && email === normalizeCustomerEmail(row.email)) ||
      (phone && phone === normalizeCustomerPhone(row.phone)) ||
      (name && name === normalizeCustomerName(row.company_name)),
    );
    return hasStrongEvidence;
  }).map(row => ({
    ...row,
    evidence: [
      ...(tax && tax === normalizeCustomerTaxId(row.npwp) ? ['same NPWP/tax ID'] : []),
      ...(email && email === normalizeCustomerEmail(row.email) ? ['same email'] : []),
      ...(phone && phone === normalizeCustomerPhone(row.phone) ? ['same phone'] : []),
      ...(name && name === normalizeCustomerName(row.company_name) ? ['same normalized legal name'] : []),
      ...(address && address === normalizeCustomerName(row.address || '') ? ['same address'] : []),
    ],
  }));
};

export const isDuplicateCustomerError = (error: unknown) => {
  const err = error as { code?: string; message?: string; details?: string } | null;
  const text = `${err?.message || ''} ${err?.details || ''}`.toLowerCase();
  return err?.code === '23505' && text.includes('customers_company_name_normalized');
};

export const ensureUniqueCustomerName = async (companyName: string, excludeCustomerId?: string) => {
  const normalizedName = normalizeCustomerName(companyName);

  if (!normalizedName) {
    return;
  }

  const { data, error } = await supabase.rpc('customer_name_exists', {
    p_company_name: companyName,
    p_exclude_customer_id: excludeCustomerId || null,
  });
  if (error) {
    const missingFunction = error.code === 'PGRST202' || error.message?.includes('customer_name_exists');
    if (!missingFunction) {
      throw error;
    }

    let query = supabase
      .from('customers')
      .select('id, company_name')
      .eq('is_active', true)
      .limit(10000);

    if (excludeCustomerId) {
      query = query.neq('id', excludeCustomerId);
    }

    const fallback = await query;
    if (fallback.error) throw fallback.error;

    const duplicate = (fallback.data || []).some(customer =>
      normalizeCustomerName((customer as { company_name?: string }).company_name || '') === normalizedName
    );

    if (duplicate) {
      throw new Error(DUPLICATE_CUSTOMER_MESSAGE);
    }

    return;
  }

  if (data) {
    throw new Error(DUPLICATE_CUSTOMER_MESSAGE);
  }
};

// ── CRM prospect (crm_contacts) duplicate check ────────────────────────────
// The ERP `customers` and CRM `crm_contacts` masters are independent. The
// helper below mirrors ensureUniqueCustomerName but scans crm_contacts,
// which has its own UNIQUE (company_name) constraint (see migration
// 20251120181805_auto_sync_customers_from_inquiries.sql).

export const DUPLICATE_CRM_CONTACT_MESSAGE = 'A CRM customer with this name already exists.';

export const isDuplicateCrmContactError = (error: unknown) => {
  const err = error as { code?: string; message?: string; details?: string } | null;
  const text = `${err?.message || ''} ${err?.details || ''}`.toLowerCase();
  return err?.code === '23505' && text.includes('crm_contacts_company_name');
};

export const ensureUniqueCrmContactName = async (companyName: string, excludeContactId?: string) => {
  const normalizedName = normalizeCustomerName(companyName);
  if (!normalizedName) return;

  let query = supabase
    .from('crm_contacts')
    .select('id, company_name')
    .eq('is_active', true)
    .limit(10000);

  if (excludeContactId) {
    query = query.neq('id', excludeContactId);
  }

  const { data, error } = await query;
  if (error) throw error;

  const duplicate = (data || []).some(row =>
    normalizeCustomerName((row as { company_name?: string }).company_name || '') === normalizedName
  );

  if (duplicate) {
    throw new Error(DUPLICATE_CRM_CONTACT_MESSAGE);
  }
};

// findOrCreateCrmContact: dedupe-on-write helper for CRM Add-Customer.
//
// If a crm_contacts row already exists for the same company_name
// (case/space-insensitive), return it — no INSERT. Otherwise create the row.
// This means "Add Customer" is idempotent and can never produce duplicate
// CRM prospects even under race conditions or repeated clicks. Also handles
// the unique-constraint race by falling back to a lookup on 23505.
export type CrmContactRow = {
  id: string;
  company_name: string;
  contact_person: string | null;
  email: string | null;
  phone: string | null;
  country: string | null;
  address: string | null;
  city: string | null;
};

export const findOrCreateCrmContact = async (
  fields: {
    company_name: string;
    contact_person?: string | null;
    email?: string | null;
    phone?: string | null;
    country?: string | null;
    address?: string | null;
    city?: string | null;
  },
): Promise<{ contact: CrmContactRow; created: boolean }> => {
  const normalized = normalizeCustomerName(fields.company_name);
  if (!normalized) {
    throw new Error('Customer name is required');
  }

  // Case-insensitive exact match. ilike escapes work well for company names;
  // still guarded by client-side normalisation before returning.
  const escaped = fields.company_name.trim().replace(/[%_]/g, m => `\\${m}`);
  const { data: existing, error: lookupError } = await supabase
    .from('crm_contacts')
    .select('id, company_name, contact_person, email, phone, country, address, city')
    .ilike('company_name', escaped)
    .limit(50);
  if (lookupError) throw lookupError;

  const match = (existing || []).find(row =>
    normalizeCustomerName(row.company_name || '') === normalized
  );
  if (match) {
    return { contact: match as CrmContactRow, created: false };
  }

  const { data: inserted, error: insertError } = await supabase
    .from('crm_contacts')
    .insert({
      company_name:   fields.company_name,
      contact_person: fields.contact_person || null,
      email:          fields.email || null,
      phone:          fields.phone || null,
      country:        fields.country || null,
      address:        fields.address || null,
      city:           fields.city || null,
      customer_type:  'prospect',
      is_active:      true,
    })
    .select('id, company_name, contact_person, email, phone, country, address, city')
    .single();

  if (insertError) {
    // Race: another writer created the row between our lookup and our
    // insert. Fall back to reading the winner rather than surfacing an
    // error to the user.
    if (isDuplicateCrmContactError(insertError)) {
      const { data: retry } = await supabase
        .from('crm_contacts')
        .select('id, company_name, contact_person, email, phone, country, address, city')
        .ilike('company_name', escaped)
        .limit(50);
      const winner = (retry || []).find(row =>
        normalizeCustomerName(row.company_name || '') === normalized
      );
      if (winner) return { contact: winner as CrmContactRow, created: false };
    }
    throw insertError;
  }

  return { contact: inserted as CrmContactRow, created: true };
};
