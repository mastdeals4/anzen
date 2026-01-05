interface Customer {
  id: string;
  company_name: string;
  email?: string;
  phone?: string;
  contact_person?: string;
}

interface MatchResult {
  customer: Customer;
  score: number;
  matchType: 'exact' | 'startsWith' | 'contains' | 'fuzzy';
  confidence: 'high' | 'medium' | 'low';
}

export function normalizeCompanyName(name: string): string {
  if (!name) return '';

  return name
    .toLowerCase()
    .trim()
    .replace(/\s+/g, ' ')
    .replace(/\b(ltd|limited|inc|incorporated|pvt|private|llc|corp|corporation|co|company|pte|sdn bhd|tbk|pt)\b\.?/gi, '')
    .replace(/[^\w\s]/g, '')
    .trim();
}

export function calculateLevenshteinDistance(str1: string, str2: string): number {
  const len1 = str1.length;
  const len2 = str2.length;
  const matrix: number[][] = [];

  if (len1 === 0) return len2;
  if (len2 === 0) return len1;

  for (let i = 0; i <= len1; i++) {
    matrix[i] = [i];
  }

  for (let j = 0; j <= len2; j++) {
    matrix[0][j] = j;
  }

  for (let i = 1; i <= len1; i++) {
    for (let j = 1; j <= len2; j++) {
      const cost = str1[i - 1] === str2[j - 1] ? 0 : 1;
      matrix[i][j] = Math.min(
        matrix[i - 1][j] + 1,
        matrix[i][j - 1] + 1,
        matrix[i - 1][j - 1] + cost
      );
    }
  }

  return matrix[len1][len2];
}

export function calculateSimilarity(str1: string, str2: string): number {
  const normalized1 = normalizeCompanyName(str1);
  const normalized2 = normalizeCompanyName(str2);

  if (normalized1 === normalized2) return 1.0;

  const maxLength = Math.max(normalized1.length, normalized2.length);
  if (maxLength === 0) return 1.0;

  const distance = calculateLevenshteinDistance(normalized1, normalized2);
  return 1 - distance / maxLength;
}

export function extractEmailDomain(email: string): string {
  if (!email) return '';
  const match = email.match(/@(.+)$/);
  return match ? match[1].toLowerCase() : '';
}

export function fuzzyMatchCompanyName(
  searchTerm: string,
  customers: Customer[]
): MatchResult[] {
  if (!searchTerm || !customers.length) return [];

  const normalizedSearch = normalizeCompanyName(searchTerm);
  const searchLower = searchTerm.toLowerCase().trim();
  const matches: MatchResult[] = [];

  for (const customer of customers) {
    const normalizedCustomer = normalizeCompanyName(customer.company_name);
    const customerLower = customer.company_name.toLowerCase().trim();

    let matchType: MatchResult['matchType'] = 'fuzzy';
    let score = 0;

    if (normalizedCustomer === normalizedSearch) {
      matchType = 'exact';
      score = 100;
    } else if (customerLower.startsWith(searchLower)) {
      matchType = 'startsWith';
      score = 90 - (customerLower.length - searchLower.length);
    } else if (customerLower.includes(searchLower)) {
      matchType = 'contains';
      score = 75 - (customerLower.indexOf(searchLower) * 2);
    } else {
      const similarity = calculateSimilarity(searchTerm, customer.company_name);
      if (similarity >= 0.6) {
        score = Math.round(similarity * 70);
      } else {
        continue;
      }
    }

    const emailDomainMatch = customer.email && searchTerm.includes('@')
      ? extractEmailDomain(customer.email) === extractEmailDomain(searchTerm)
      : false;

    if (emailDomainMatch) {
      score += 15;
    }

    let confidence: MatchResult['confidence'];
    if (score >= 90) confidence = 'high';
    else if (score >= 70) confidence = 'medium';
    else confidence = 'low';

    matches.push({
      customer,
      score: Math.min(score, 100),
      matchType,
      confidence,
    });
  }

  return matches.sort((a, b) => b.score - a.score);
}

export function findBestMatch(
  searchTerm: string,
  customers: Customer[]
): MatchResult | null {
  const matches = fuzzyMatchCompanyName(searchTerm, customers);
  return matches.length > 0 && matches[0].score >= 90 ? matches[0] : null;
}

export function groupMatchesByType(matches: MatchResult[]): {
  exact: MatchResult[];
  similar: MatchResult[];
  other: MatchResult[];
} {
  return {
    exact: matches.filter(m => m.matchType === 'exact'),
    similar: matches.filter(m => m.matchType === 'startsWith' || m.matchType === 'contains'),
    other: matches.filter(m => m.matchType === 'fuzzy'),
  };
}

export function detectCustomerChanges(
  formData: {
    contact_email?: string;
    contact_phone?: string;
    contact_person?: string;
  },
  existingCustomer: {
    email?: string;
    phone?: string;
    contact_person?: string;
  }
): {
  hasChanges: boolean;
  changedFields: string[];
  oldValues: Record<string, string>;
  newValues: Record<string, string>;
} {
  const changedFields: string[] = [];
  const oldValues: Record<string, string> = {};
  const newValues: Record<string, string> = {};

  const normalizeEmail = (email: string) => email?.toLowerCase().trim() || '';
  const normalizePhone = (phone: string) => phone?.replace(/\D/g, '') || '';
  const normalizeName = (name: string) => name?.trim() || '';

  if (formData.contact_email && existingCustomer.email) {
    const newEmail = normalizeEmail(formData.contact_email);
    const oldEmail = normalizeEmail(existingCustomer.email);
    if (newEmail !== oldEmail && newEmail !== '') {
      changedFields.push('email');
      oldValues.email = existingCustomer.email;
      newValues.email = formData.contact_email;
    }
  }

  if (formData.contact_phone && existingCustomer.phone) {
    const newPhone = normalizePhone(formData.contact_phone);
    const oldPhone = normalizePhone(existingCustomer.phone);
    if (newPhone !== oldPhone && newPhone !== '') {
      changedFields.push('phone');
      oldValues.phone = existingCustomer.phone;
      newValues.phone = formData.contact_phone;
    }
  }

  if (formData.contact_person && existingCustomer.contact_person) {
    const newName = normalizeName(formData.contact_person);
    const oldName = normalizeName(existingCustomer.contact_person);
    if (newName !== oldName && newName !== '') {
      changedFields.push('contact_person');
      oldValues.contact_person = existingCustomer.contact_person;
      newValues.contact_person = formData.contact_person;
    }
  }

  return {
    hasChanges: changedFields.length > 0,
    changedFields,
    oldValues,
    newValues,
  };
}
