export interface EmailRecipientLike {
  company_name?: string | null;
  contact_person?: string | null;
  product_name?: string | null;
  specification?: string | null;
  quantity?: string | null;
  supplier_name?: string | null;
  supplier_country?: string | null;
  inquiry_number?: string | null;
  user_name?: string | null;
  offered_price?: string | null;
}

function clean(value?: string | null): string {
  return value?.trim() || '';
}

export function getDisplayContactName(contactPerson?: string | null): string {
  return clean(contactPerson) || 'Sir/Madam';
}

export function getSalutation(contactPerson?: string | null): string {
  return `Dear ${getDisplayContactName(contactPerson)},`;
}

export function applyEmailTemplateVariables(input: string, recipient: EmailRecipientLike): string {
  const contactName = getDisplayContactName(recipient.contact_person);
  const variables: Record<string, string> = {
    '{{company_name}}': clean(recipient.company_name),
    '{{contact_person}}': contactName,
    '{{customer_name}}': contactName,
    '{{Customer_name}}': contactName,
    '{{salutation}}': getSalutation(recipient.contact_person),
    '{{greeting_line}}': getSalutation(recipient.contact_person),
    '{{product_name}}': clean(recipient.product_name),
    '{{product}}': clean(recipient.product_name),
    '{{specification}}': clean(recipient.specification) || '-',
    '{{quantity}}': clean(recipient.quantity),
    '{{supplier_name}}': clean(recipient.supplier_name) || '-',
    '{{supplier_country}}': clean(recipient.supplier_country) || '-',
    '{{inquiry_number}}': clean(recipient.inquiry_number),
    '{{user_name}}': clean(recipient.user_name),
    '{{offered_price}}': clean(recipient.offered_price),
  };

  let result = input;
  Object.entries(variables).forEach(([token, value]) => {
    const escaped = token.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    result = result.replace(new RegExp(escaped, 'g'), value);
  });

  // Normalize fallback greeting when name was missing.
  result = result.replace(/Dear\s+Sir\/Madam\s*,*/gi, 'Dear Sir/Madam,');

  return result;
}
