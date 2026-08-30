import * as pdfjsLib from 'pdfjs-dist/legacy/build/pdf.mjs';
// Resolve the worker as a module URL so Vite can transform the dependency in
// both dev and production without requesting the source module through the
// dev server's `?url` plugin path (which can produce a 500 during lazy loads).
const pdfWorkerUrl = new URL('pdfjs-dist/legacy/build/pdf.worker.min.mjs', import.meta.url).toString();

// Vite bundles the worker as a hashed asset and rewrites this URL for both
// development and production deployments. Without this, pdfjs-dist throws
// "No GlobalWorkerOptions.workerSrc specified" when parsing in the browser.
pdfjsLib.GlobalWorkerOptions.workerSrc = pdfWorkerUrl;

export interface ExtractedPurchaseInvoiceLine {
  description: string;
  batchNumber?: string;
  expiryDate?: string;
  quantity?: number;
  unit?: string;
  unitPrice?: number;
  lineTotal?: number;
}

export interface ExtractedPurchaseInvoice {
  supplierName?: string;
  invoiceNumber?: string;
  invoiceDate?: string;
  dueDate?: string;
  currency?: string;
  exchangeRate?: number;
  poNumber?: string;
  taxNumber?: string;
  subtotal?: number;
  taxAmount?: number;
  totalAmount?: number;
  lines: ExtractedPurchaseInvoiceLine[];
  rawText: string;
}

const numberPattern = '[0-9][0-9.,]*';

function parseNumber(value: string | undefined): number | undefined {
  if (!value) return undefined;
  const cleaned = value.replace(/[^0-9,.-]/g, '');
  if (!cleaned) return undefined;
  // Supplier invoices commonly use either 1,234.56 or 1.234,56.
  let normalized = cleaned;
  if (cleaned.includes(',') && cleaned.includes('.')) {
    normalized = cleaned.lastIndexOf(',') > cleaned.lastIndexOf('.')
      ? cleaned.replace(/\./g, '').replace(',', '.')
      : cleaned.replace(/,/g, '');
  } else if (cleaned.includes(',')) {
    const parts = cleaned.split(',');
    normalized = parts.length > 2 || parts.slice(1).every(part => part.length === 3)
      ? parts.join('')
      : cleaned.replace(',', '.');
  } else if (cleaned.includes('.')) {
    const parts = cleaned.split('.');
    normalized = parts.length > 2 || parts.slice(1).every(part => part.length === 3)
      ? parts.join('')
      : cleaned;
  }
  const parsed = Number(normalized);
  return Number.isFinite(parsed) ? parsed : undefined;
}

function parseDate(value: string | undefined): string | undefined {
  if (!value) return undefined;
  const match = value.match(/(\d{1,2})[\/-](\d{1,2})[\/-](\d{2,4})|((?:20)\d{2})[\/-](\d{1,2})[\/-](\d{1,2})/);
  if (!match) return undefined;
  if (match[4]) return `${match[4]}-${match[5].padStart(2, '0')}-${match[6].padStart(2, '0')}`;
  const year = match[3].length === 2 ? `20${match[3]}` : match[3];
  return `${year}-${match[2].padStart(2, '0')}-${match[1].padStart(2, '0')}`;
}

function firstCapture(text: string, patterns: RegExp[]): string | undefined {
  for (const pattern of patterns) {
    const match = text.match(pattern);
    if (match?.[1]) return match[1].trim();
  }
  return undefined;
}

/**
 * Extracts a conservative draft from text-based PDFs. No values are written
 * to the database; callers must present and let the user review the result.
 */
export async function extractPurchaseInvoicePdf(file: File): Promise<ExtractedPurchaseInvoice> {
  const buffer = await file.arrayBuffer();
  const pdf = await pdfjsLib.getDocument({ data: new Uint8Array(buffer) }).promise;
  const pages: string[] = [];
  for (let pageNumber = 1; pageNumber <= pdf.numPages; pageNumber += 1) {
    const page = await pdf.getPage(pageNumber);
    const content = await page.getTextContent();
    pages.push(content.items.map((item: { str?: string; hasEOL?: boolean }) => `${item.str || ''}${item.hasEOL ? '\n' : ' '}`).join('').replace(/[ \t]+\n/g, '\n'));
  }
  const rawText = pages.join('\n');

  const invoiceNumber = firstCapture(rawText, [
    /(?:invoice\s*(?:no|number)|inv\.?\s*#?|faktur\s*(?:no|number))\s*[:#-]?\s*([^\n]+)/i,
  ]);
  const poNumber = firstCapture(rawText, [/(?:purchase\s*order|PO)\s*(?:no|number|#)?\s*[:#-]?\s*([A-Z0-9][A-Z0-9./_-]*)/i]);
  const supplierName = firstCapture(rawText, [/(?:supplier|vendor|from)\s*[:#-]\s*([^\n]+)/i]);
  const dateValue = firstCapture(rawText, [/(?:invoice\s*date|date)\s*[:#-]?\s*([^\n]+)/i]);
  const dueValue = firstCapture(rawText, [/(?:due\s*date|payment\s*due)\s*[:#-]?\s*([^\n]+)/i]);
  const taxNumber = firstCapture(rawText, [/(?:faktur\s*pajak|tax\s*(?:id|number|no))\s*[:#-]?\s*([^\n]+)/i]);
  const currency = /\bUSD\b|\$/i.test(rawText) ? 'USD' : /\bIDR\b|\bRP\b|Rp\.?/i.test(rawText) ? 'IDR' : undefined;
  const exchangeRate = parseNumber(firstCapture(rawText, [new RegExp(`(?:exchange\\s*rate|kurs)\\s*[:#-]?\\s*(${numberPattern})`, 'i')]));
  const subtotal = parseNumber(firstCapture(rawText, [new RegExp(`(?:sub\\s*total|subtotal)\\s*[:#-]?\\s*(${numberPattern})`, 'i')]));
  const taxAmount = parseNumber(firstCapture(rawText, [new RegExp(`(?:tax|ppn|vat)\\s*[:#-]?\\s*(${numberPattern})`, 'i')]));
  const totalAmount = parseNumber(firstCapture(rawText, [new RegExp(`(?:grand\\s*total|\\btotal\\s*(?:amount|due)?)\\s*[:#-]?\\s*(${numberPattern})`, 'i')]));

  const lines: ExtractedPurchaseInvoiceLine[] = [];
  for (const line of rawText.split(/\n+/)) {
    const match = line.match(new RegExp(`^(.{2,}?)\\s+(\\d+(?:[.,]\\d+)?)\\s*([A-Za-z]{1,8})?\\s+(${numberPattern})\\s+(${numberPattern})\\s*$`));
    if (match && !/(subtotal|total|tax|ppn|vat|amount|invoice)/i.test(match[1])) {
      const unit = match[3] && /^(kg|g|mg|l|ml|pcs?|unit|box|bag|drum|carton|pack|ton)$/i.test(match[3]) ? match[3] : undefined;
      if (match[3] && !unit) continue;
      const dateToken = match[1].match(/\b(\d{1,2}[\/-]\d{1,2}[\/-]\d{2,4}|\d{1,2}[\/-](?:\d{1,2}|jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)[\/-]?\d{0,4})\b/i);
      lines.push({ description: match[1].replace(dateToken?.[0] || '', '').trim(), expiryDate: dateToken ? parseDate(dateToken[0]) : undefined, quantity: parseNumber(match[2]), unit, unitPrice: parseNumber(match[4]), lineTotal: parseNumber(match[5]) });
    }
  }

  return { supplierName, invoiceNumber, invoiceDate: parseDate(dateValue), dueDate: parseDate(dueValue), currency, exchangeRate, poNumber, taxNumber, subtotal, taxAmount, totalAmount, lines, rawText };
}
