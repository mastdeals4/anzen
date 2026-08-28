/**
 * Shared email formatting utilities reused across CRM email composers
 * and internal workflow emails (Kunal Pricing replies, etc.).
 */

import { type CompanySnapshot, FALLBACK_COMPANY } from '../types/company';

export interface IndiaRfqRow {
  aceerp_no?: string | null;
  company_name?: string | null;
  product_name: string;
  specification?: string | null;
  supplier_name?: string | null;
  quantity: string;
  delivery_date?: string | null;
  created_at?: string | null;
  coa_required?: boolean | null;
  sample_required?: boolean | null;
  agency_letter_required?: boolean | null;
  others_required?: boolean | null;
  remarks?: string | null;
}

function calcAgeing(createdAt?: string | null): string {
  if (!createdAt) return '-';
  const days = Math.floor((Date.now() - new Date(createdAt).getTime()) / 86400000);
  return days <= 0 ? '0d' : `${days}d`;
}

function extractMakeFromRemarks(remarks?: string | null): string {
  const text = remarks?.trim() || '';
  const match = text.match(/make\s*:\s*([^,;\n|]+)/i);
  return (match?.[1] || '').trim();
}

export function escapeHtml(value: unknown): string {
  return String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

export function buildCompanySignature(userName: string, co?: CompanySnapshot | null): string {
  const c = co ?? FALLBACK_COMPANY;
  const safeUserName = escapeHtml(userName || '');
  const emailLine = c.company_email
    ? `<span style="color:#0b66c3;">📧</span> <a href="mailto:${escapeHtml(c.company_email)}" style="color:#0b66c3;text-decoration:underline;">${escapeHtml(c.company_email)}</a>`
    : '';
  return `<div style="font-family:Arial,Helvetica,sans-serif;color:#1f2937;line-height:1.45;font-size:14px;margin-top:18px;">
    <p style="margin:0 0 6px 0;">Warm regards,</p>
    <p style="margin:0 0 6px 0;">${safeUserName}</p>
    <p style="margin:0 0 4px 0;color:#073763;font-size:20px;font-weight:700;">${escapeHtml(c.company_name)}</p>
    ${c.company_address ? `<p style="margin:0 0 6px 0;">${escapeHtml(c.company_address)}</p>` : ''}
    ${emailLine ? `<p style="margin:0 0 2px 0;">${emailLine}</p>` : ''}
    ${c.company_phone ? `<p style="margin:0 0 18px 0;color:#274e13;">📱 ${escapeHtml(c.company_phone)}</p>` : ''}
    <p style="margin:0;color:#073763;font-weight:700;font-style:italic;">APIs | Excipients | Formulations | Nutraceuticals | Herbal Extracts | Pharma Packaging Solutions | Technology Transfers</p>
  </div>`;
}

export function buildIndiaRfqSubject(rows: IndiaRfqRow[]): string {
  const refs = [...new Set(rows.map(row => row.aceerp_no).filter(Boolean))].join(', ');
  return `Pricing Request - ACE Ref ${refs}`;
}

export function buildIndiaRfqEmail(rows: IndiaRfqRow[], company?: CompanySnapshot | null): string {
  const headerStyle = 'padding:10px 12px;border:1px solid #b7c9df;background:#073763;color:#ffffff;text-align:left;font-weight:700;font-size:13px;';
  const cellBase = 'padding:9px 12px;border:1px solid #d1d5db;color:#1f2937;font-size:13px;vertical-align:top;';
  const priceCell = 'padding:9px 12px;border:1px solid #d1d5db;color:#1f2937;font-size:13px;vertical-align:top;background:#fafff5;min-width:80px;';
  const body = rows.map((row, index) => {
    const background = index % 2 === 0 ? '#ffffff' : '#f8fafc';
    const documents: string[] = [];
    if (row.coa_required) documents.push('COA');
    if (row.sample_required) documents.push('Sample');
    if (row.agency_letter_required) documents.push('Agency Letter');
    if (row.others_required) documents.push('Others');
    const deliveryDate = row.delivery_date
      ? new Date(row.delivery_date).toLocaleDateString('en-GB', { day: '2-digit', month: 'short', year: 'numeric' })
      : '-';
    const ageing = calcAgeing(row.created_at);
    return `<tr style="background:${background};">
      <td style="${cellBase}font-weight:600;white-space:nowrap;">${escapeHtml(row.aceerp_no?.trim() || '-')}</td>
      <td style="${cellBase}">${escapeHtml(row.company_name?.trim() || '-')}</td>
      <td style="${cellBase}font-weight:600;">${escapeHtml(row.product_name?.trim() || '-')}</td>
      <td style="${cellBase}">${escapeHtml(row.specification?.trim() || '-')}</td>
      <td style="${cellBase}">${escapeHtml(extractMakeFromRemarks(row.remarks) || row.supplier_name?.trim() || '-')}</td>
      <td style="${cellBase}white-space:nowrap;">${escapeHtml(row.quantity?.trim() || '-')}</td>
      <td style="${cellBase}white-space:nowrap;">${escapeHtml(deliveryDate)}</td>
      <td style="${cellBase}text-align:center;font-weight:600;color:${parseInt(ageing) > 30 ? '#b91c1c' : parseInt(ageing) > 14 ? '#d97706' : '#059669'};">${escapeHtml(ageing)}</td>
      <td style="${cellBase}">${escapeHtml(documents.length > 0 ? documents.join(', ') : '-')}</td>
      <td style="${priceCell}">&nbsp;</td>
      <td style="${cellBase}">${escapeHtml(row.remarks?.trim() || '-')}</td>
    </tr>`;
  }).join('');

  const table = `<table role="presentation" cellpadding="0" cellspacing="0" border="0" style="border-collapse:collapse;width:100%;max-width:1000px;font-family:Arial,Helvetica,sans-serif;font-size:13px;mso-table-lspace:0pt;mso-table-rspace:0pt;">
    <thead><tr>
      <th style="${headerStyle}">ACE ERP Ref</th><th style="${headerStyle}">Customer Name</th><th style="${headerStyle}">Product Name</th><th style="${headerStyle}">Specification</th><th style="${headerStyle}">Make</th><th style="${headerStyle}">Quantity</th><th style="${headerStyle}">Required Delivery Date</th><th style="${headerStyle}">Ageing (Days)</th><th style="${headerStyle}">Documents Required</th><th style="${headerStyle}">Price</th><th style="${headerStyle}">Remarks</th>
    </tr></thead><tbody>${body}</tbody>
  </table>`;
  const c = company ?? FALLBACK_COMPANY;
  let html = '<p>Dear Team,</p><p>Please provide your best quotation for the following requirement.</p>';
  html += table;
  html += `<div style="font-family:Arial,Helvetica,sans-serif;color:#1f2937;line-height:1.45;font-size:14px;margin-top:18px;"><p style="margin:0 0 6px 0;">Thank you.</p><p style="margin:0 0 6px 0;">Best Regards,</p><p style="margin:0 0 6px 0;">Kunal Lunkad</p><p style="margin:0 0 4px 0;color:#073763;font-size:20px;font-weight:700;">${escapeHtml(c.company_name)}</p>${c.company_address ? `<p style="margin:0 0 6px 0;">${escapeHtml(c.company_address)}</p>` : ''}${c.company_email ? `<p style="margin:0 0 2px 0;"><span style="color:#0b66c3;">📧</span> <a href="mailto:${escapeHtml(c.company_email)}" style="color:#0b66c3;text-decoration:underline;">${escapeHtml(c.company_email)}</a></p>` : ''}${c.company_phone ? `<p style="margin:0 0 18px 0;color:#274e13;">📱 ${escapeHtml(c.company_phone)}</p>` : ''}<p style="margin:0;color:#073763;font-weight:700;font-style:italic;">APIs | Excipients | Formulations | Nutraceuticals | Herbal Extracts | Pharma Packaging Solutions | Technology Transfers</p></div>`;
  return html;
}

export interface InternalPriceRow {
  inquiryNumber: string;
  aceerpNo: string | null;
  product: string;
  requiredMake: string | null;
  offeredMake: string | null;
  qty: string;
  inrSourcePrice: string;
  usdLandedCost: string;
  quotePrice: string;
  remarks: string | null;
}

/**
 * Build a Gmail/Outlook-compatible HTML table for internal pricing replies.
 * Same styling as the CRM customer quote table (blue header, alternating rows).
 */
export function buildInternalPriceTable(items: InternalPriceRow[]): string {
  const headerStyle =
    'padding:10px 12px;border:1px solid #b7c9df;background:#073763;color:#ffffff;text-align:left;font-weight:700;font-size:13px;';
  const cellBase =
    'padding:9px 12px;border:1px solid #d1d5db;color:#1f2937;font-size:13px;vertical-align:top;';

  const rows = items
    .map((row, idx) => {
      const bg = idx % 2 === 0 ? '#ffffff' : '#f8fafc';
      return `<tr style="background:${bg};">
      <td style="${cellBase}font-weight:600;">${escapeHtml(row.inquiryNumber)}</td>
      <td style="${cellBase}">${escapeHtml(row.aceerpNo || '-')}</td>
      <td style="${cellBase}font-weight:600;">${escapeHtml(row.product)}</td>
      <td style="${cellBase}">${escapeHtml(row.requiredMake || '-')}</td>
      <td style="${cellBase}">${escapeHtml(row.offeredMake || '-')}</td>
      <td style="${cellBase}">${escapeHtml(row.qty)}</td>
      <td style="${cellBase}white-space:nowrap;">${escapeHtml(row.inrSourcePrice)}</td>
      <td style="${cellBase}white-space:nowrap;">${escapeHtml(row.usdLandedCost)}</td>
      <td style="${cellBase}font-weight:600;white-space:nowrap;">${escapeHtml(row.quotePrice)}</td>
      <td style="${cellBase}">${escapeHtml(row.remarks || '-')}</td>
    </tr>`;
    })
    .join('');

  return `<table role="presentation" cellpadding="0" cellspacing="0" border="0" style="border-collapse:collapse;width:100%;max-width:760px;font-family:Arial,Helvetica,sans-serif;font-size:13px;mso-table-lspace:0pt;mso-table-rspace:0pt;">
    <thead><tr>
      <th style="${headerStyle}">Inquiry No</th>
      <th style="${headerStyle}">AC ERP#</th>
      <th style="${headerStyle}">Product</th>
      <th style="${headerStyle}">Required Make</th>
      <th style="${headerStyle}">Offered Make</th>
      <th style="${headerStyle}">Qty</th>
      <th style="${headerStyle}">INR Source Price</th>
      <th style="${headerStyle}">USD Landed Cost</th>
      <th style="${headerStyle}">Quote Price</th>
      <th style="${headerStyle}">Remarks</th>
    </tr></thead>
    <tbody>${rows}</tbody>
  </table>`;
}

export interface CustomerQuoteRow {
  product: string;
  make: string | null;
  origin: string | null;
  specification: string | null;
  moq: string | null;
  packing: string | null;
  leadTime: string | null;
  qty: string | null;
  quotePrice: string;
  remarks: string | null;
}

/**
 * Build a CUSTOMER-FACING quote table. Deliberately customer-safe: it exposes
 * only the selling price and commercial terms — never the INR source price or
 * USD landed cost that appear in the internal table above.
 */
export function buildCustomerQuoteTable(items: CustomerQuoteRow[]): string {
  const headerStyle =
    'padding:10px 12px;border:1px solid #b7c9df;background:#073763;color:#ffffff;text-align:left;font-weight:700;font-size:13px;';
  const cellBase =
    'padding:9px 12px;border:1px solid #d1d5db;color:#1f2937;font-size:13px;vertical-align:top;';

  const rows = items
    .map((row, idx) => {
      const bg = idx % 2 === 0 ? '#ffffff' : '#f8fafc';
      return `<tr style="background:${bg};">
      <td style="${cellBase}font-weight:600;">${escapeHtml(row.product)}</td>
      <td style="${cellBase}">${escapeHtml(row.make || '-')}</td>
      <td style="${cellBase}">${escapeHtml(row.origin || '-')}</td>
      <td style="${cellBase}">${escapeHtml(row.specification || '-')}</td>
      <td style="${cellBase}">${escapeHtml(row.moq || '-')}</td>
      <td style="${cellBase}">${escapeHtml(row.packing || '-')}</td>
      <td style="${cellBase}">${escapeHtml(row.leadTime || '-')}</td>
      <td style="${cellBase}">${escapeHtml(row.qty || '-')}</td>
      <td style="${cellBase}font-weight:600;white-space:nowrap;">${escapeHtml(row.quotePrice)}</td>
      <td style="${cellBase}">${escapeHtml(row.remarks || '-')}</td>
    </tr>`;
    })
    .join('');

  return `<table role="presentation" cellpadding="0" cellspacing="0" border="0" style="border-collapse:collapse;width:100%;max-width:820px;font-family:Arial,Helvetica,sans-serif;font-size:13px;mso-table-lspace:0pt;mso-table-rspace:0pt;">
    <thead><tr>
      <th style="${headerStyle}">Product</th>
      <th style="${headerStyle}">Make</th>
      <th style="${headerStyle}">Origin</th>
      <th style="${headerStyle}">Specification</th>
      <th style="${headerStyle}">MOQ</th>
      <th style="${headerStyle}">Packing</th>
      <th style="${headerStyle}">Lead Time</th>
      <th style="${headerStyle}">Qty</th>
      <th style="${headerStyle}">Price</th>
      <th style="${headerStyle}">Remarks</th>
    </tr></thead>
    <tbody>${rows}</tbody>
  </table>`;
}
