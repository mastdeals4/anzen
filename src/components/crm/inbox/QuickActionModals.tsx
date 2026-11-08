// src/components/crm/inbox/QuickActionModals.tsx
//
// Simple, focused modals for WhatsApp ERP Quick Actions:
// - Send Approved Quotation (with PDF generation)
// - Send Batch-Verified COA & Technical Documents
// - Real Inventory Stock Check
// - Auto-cancelling Follow-Up Task
// - Customer Disambiguation Selector

import React, { useState, useEffect } from 'react';
import {
  X,
  Send,
  FileText,
  Package,
  Clock,
  CheckCircle2,
  AlertTriangle,
  Building,
  User,
  Phone,
  DollarSign,
  Download,
  Loader,
  Calendar,
  Layers,
  Eye,
} from 'lucide-react';
import {
  ErpCommunicationsService,
  StockEnquiryResult,
  ProductDocumentItem,
  QuotationDetails,
  BatchStockItem,
} from '../../../services/crm/erpCommunicationsService';
import { PhoneMatchCandidate } from '../../../services/crm/phoneMatchingService';
import { showToast } from '../../ToastNotification';

/**
 * Parses numerical quantity from commercial strings such as "5,000 KG", "1.5 MT", "250".
 * Returns a finite number if valid, or null if empty, non-numeric, zero, negative, or invalid.
 */
export function parseNumericQuantity(rawQuantity: string | undefined | null): number | null {
  if (!rawQuantity || typeof rawQuantity !== 'string' || !rawQuantity.trim()) return null;
  // Clean commas for thousands formatting e.g. "5,000 KG" -> "5000 KG"
  const cleaned = rawQuantity.replace(/,/g, '').trim();
  // Match starting numerical value (supports positive, negative, and decimal)
  const match = cleaned.match(/^([+-]?\d+(?:\.\d+)?)/);
  if (!match) return null;
  const num = parseFloat(match[1]);
  if (!Number.isFinite(num)) return null;
  return num;
}

// ==========================================
// 1. SEND QUOTATION MODAL
// ==========================================
interface SendQuotationModalProps {
  isOpen: boolean;
  onClose: () => void;
  onSend: (text: string, documentUrl?: string, filename?: string) => Promise<void>;
  companyName: string;
  contactPerson?: string | null;
  inquiries: any[];
}

export function SendQuotationModal({
  isOpen,
  onClose,
  onSend,
  companyName,
  contactPerson,
  inquiries,
}: SendQuotationModalProps) {
  const [selectedInquiryId, setSelectedInquiryId] = useState<string>('');
  const [productName, setProductName] = useState('');
  const [quantity, setQuantity] = useState('');
  const [offeredPrice, setOfferedPrice] = useState<number | ''>('');
  const [currency, setCurrency] = useState('USD');
  const [make, setMake] = useState('');
  const [origin, setOrigin] = useState('India');
  const [deliveryTerms, setDeliveryTerms] = useState('Loco Jakarta Warehouse');
  const [paymentTerms, setPaymentTerms] = useState('30 Days Net');
  const [validityDays, setValidityDays] = useState(7);
  const [leadTime, setLeadTime] = useState('Ready Stock / 2-3 Weeks');
  const [includePdf, setIncludePdf] = useState(true);
  const [sending, setSending] = useState(false);
  const [pricingOptions, setPricingOptions] = useState<any[]>([]);
  const [selectedOptionId, setSelectedOptionId] = useState<string>('');
  const [loadingPricing, setLoadingPricing] = useState(false);
  const [showPdfPreviewModal, setShowPdfPreviewModal] = useState(false);
  const [reviewedByOperator, setReviewedByOperator] = useState(false);

  useEffect(() => {
    if (inquiries && inquiries.length > 0 && !selectedInquiryId) {
      const first = inquiries[0];
      setSelectedInquiryId(first.id);
      setProductName(first.product_name || '');
      setQuantity(first.quantity || '');
      if (first.offered_price && first.offered_price > 0) {
        setOfferedPrice(first.offered_price);
      } else if (first.purchase_price && first.purchase_price > 0) {
        setOfferedPrice(first.purchase_price);
      } else {
        setOfferedPrice('');
      }
      setCurrency(first.offered_price_currency || 'USD');
      loadPricingOptions(first.id);
    }
  }, [inquiries, selectedInquiryId]);

  const loadPricingOptions = async (inqId: string) => {
    if (!inqId) return;
    setLoadingPricing(true);
    try {
      const opts = await ErpCommunicationsService.getInquiryPricingOptions(inqId);
      setPricingOptions(opts);
      if (opts && opts.length > 0) {
        // Find accepted or default to first
        const chosen = opts.find((o) => o.is_accepted || o.include_in_customer_quote) || opts[0];
        applyPricingOption(chosen);
      }
    } finally {
      setLoadingPricing(false);
    }
  };

  const applyPricingOption = (opt: any) => {
    if (!opt) return;
    setSelectedOptionId(opt.id);
    if (opt.selling_price && parseFloat(opt.selling_price) > 0) {
      setOfferedPrice(parseFloat(opt.selling_price));
    }
    if (opt.selling_currency) setCurrency(opt.selling_currency);
    if (opt.offered_make) setMake(opt.offered_make);
    if (opt.origin) setOrigin(opt.origin);
    if (opt.delivery_terms) setDeliveryTerms(opt.delivery_terms);
    if (opt.payment_terms) setPaymentTerms(opt.payment_terms);
    if (opt.lead_time) setLeadTime(opt.lead_time);
  };

  const handleInquiryChange = (inqId: string) => {
    setSelectedInquiryId(inqId);
    const inq = inquiries.find((i) => i.id === inqId);
    if (inq) {
      setProductName(inq.product_name || '');
      setQuantity(inq.quantity || '');
      if (inq.offered_price && inq.offered_price > 0) {
        setOfferedPrice(inq.offered_price);
      } else if (inq.purchase_price && inq.purchase_price > 0) {
        setOfferedPrice(inq.purchase_price);
      } else {
        setOfferedPrice('');
      }
      setCurrency(inq.offered_price_currency || 'USD');
      loadPricingOptions(inqId);
    }
  };

  if (!isOpen) return null;

  const numericPrice = typeof offeredPrice === 'number' ? offeredPrice : parseFloat(offeredPrice) || 0;
  const numericQuantity = parseNumericQuantity(quantity);
  const isQuantityValid = numericQuantity !== null && Number.isFinite(numericQuantity) && numericQuantity > 0;
  const isPriceValid = !isNaN(numericPrice) && Number.isFinite(numericPrice) && numericPrice > 0;

  const isFormValid =
    productName.trim().length > 0 &&
    isQuantityValid &&
    currency.trim().length > 0 &&
    isPriceValid;

  const quoteDetails: QuotationDetails = {
    inquiryId: selectedInquiryId || 'draft',
    inquiryNumber: inquiries.find((i) => i.id === selectedInquiryId)?.inquiry_number || 'INQ-DIRECT',
    companyName,
    contactPerson,
    productName,
    quantity,
    offeredPrice: numericPrice,
    offeredPriceCurrency: currency,
    make,
    origin,
    deliveryTerms,
    paymentTerms,
    leadTime,
    validityDays,
  };

  const previewText = isFormValid
    ? ErpCommunicationsService.formatWhatsAppQuotation(quoteDetails)
    : '_Fill required fields (Product, Quantity, Price > 0) to generate quotation preview._';

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!isFormValid) {
      showToast({ type: 'warning', title: 'Input Required', message: 'Product, Quantity, and Valid Price (>0) are mandatory.' });
      return;
    }
    if (!reviewedByOperator) {
      showToast({ type: 'warning', title: 'Approval Required', message: 'Please confirm review of commercial terms before dispatching.' });
      return;
    }

    setSending(true);
    try {
      let pdfUrl: string | undefined;
      let pdfFilename: string | undefined;

      if (includePdf) {
        const gen = await ErpCommunicationsService.generateQuotationPdf(quoteDetails);
        pdfUrl = gen.signedUrl;
        pdfFilename = `Quotation_${quoteDetails.inquiryNumber}.pdf`;
      }

      await onSend(previewText, pdfUrl, pdfFilename);
      showToast({ type: 'success', title: 'Quotation Dispatched', message: 'Sent quotation via WhatsApp.' });
      onClose();
    } catch (err: any) {
      showToast({ type: 'error', title: 'Dispatch Error', message: err.message || 'Failed to send quotation.' });
    } finally {
      setSending(false);
    }
  };

  return (
    <div className="fixed inset-0 z-50 bg-slate-900/60 backdrop-blur-sm flex items-center justify-center p-4">
      <div className="bg-white rounded-xl shadow-2xl max-w-2xl w-full overflow-hidden flex flex-col max-h-[90vh] animate-in fade-in duration-150">
        <div className="px-5 py-4 border-b border-gray-200 flex items-center justify-between bg-emerald-800 text-white">
          <div className="flex items-center gap-2">
            <DollarSign className="w-5 h-5" />
            <div>
              <div className="flex items-center gap-2">
                <h3 className="text-sm font-bold">Send Commercial Quotation</h3>
                <span className="text-[10px] font-bold px-1.5 py-0.5 rounded bg-amber-400 text-slate-900">
                  SIMULATED — NOT SENT TO CUSTOMER
                </span>
              </div>
              <p className="text-xs text-emerald-200">Reuses Anzen Pricing Engine • Human Approval Gate</p>
            </div>
          </div>
          <button onClick={onClose} className="p-1 rounded hover:bg-emerald-700 text-emerald-200 hover:text-white">
            <X className="w-5 h-5" />
          </button>
        </div>

        <form onSubmit={handleSubmit} className="p-5 overflow-y-auto space-y-4 text-xs">
          {inquiries.length > 0 && (
            <div>
              <label className="font-semibold text-gray-700 block mb-1">Link to Company Inquiry</label>
              <select
                value={selectedInquiryId}
                onChange={(e) => handleInquiryChange(e.target.value)}
                className="w-full border border-gray-300 rounded px-2.5 py-1.5 focus:border-emerald-600 outline-none"
              >
                {inquiries.map((inq) => (
                  <option key={inq.id} value={inq.id}>
                    {inq.inquiry_number} — {inq.product_name} ({inq.quantity || 'Qty N/A'})
                  </option>
                ))}
              </select>
            </div>
          )}

          {/* Pricing Options from CRM Pricing Engine */}
          {loadingPricing ? (
            <div className="p-2.5 bg-slate-50 border border-slate-200 rounded flex items-center gap-2 text-gray-500 text-[11px]">
              <Loader className="w-3.5 h-3.5 animate-spin text-emerald-600" />
              <span>Checking approved pricing options...</span>
            </div>
          ) : pricingOptions.length > 0 ? (
            <div className="p-2.5 bg-emerald-50/60 border border-emerald-200 rounded">
              <label className="font-semibold text-emerald-950 block mb-1 flex items-center justify-between">
                <span>Select Approved Pricing Option ({pricingOptions.length} available)</span>
              </label>
              <div className="space-y-1.5">
                {pricingOptions.map((opt) => (
                  <label
                    key={opt.id}
                    className={`flex items-center justify-between p-2 rounded border cursor-pointer text-[11px] ${
                      selectedOptionId === opt.id
                        ? 'bg-white border-emerald-500 shadow-xs'
                        : 'bg-emerald-50/30 border-emerald-200 hover:bg-white'
                    }`}
                  >
                    <div className="flex items-center gap-2">
                      <input
                        type="radio"
                        name="pricingOption"
                        checked={selectedOptionId === opt.id}
                        onChange={() => applyPricingOption(opt)}
                        className="text-emerald-600 focus:ring-emerald-500"
                      />
                      <div>
                        <span className="font-bold text-gray-900">
                          {opt.selling_currency || 'USD'} {Number(opt.selling_price || 0).toLocaleString()}
                        </span>
                        <span className="text-gray-500 ml-1.5">
                          Make: {opt.offered_make || 'N/A'} • Origin: {opt.origin || 'N/A'}
                        </span>
                      </div>
                    </div>
                    {opt.is_accepted && (
                      <span className="px-1.5 py-0.5 rounded bg-emerald-100 text-emerald-800 text-[10px] font-bold">
                        Accepted
                      </span>
                    )}
                  </label>
                ))}
              </div>
            </div>
          ) : (
            <div className="p-2.5 bg-amber-50/80 border border-amber-200 rounded text-[11px] text-amber-900 flex items-start gap-2">
              <AlertTriangle className="w-4 h-4 text-amber-600 shrink-0 mt-0.5" />
              <div>
                <p className="font-bold">No Approved Pricing Options Recorded</p>
                <p className="text-amber-700 mt-0.5">
                  This inquiry does not have an approved pricing option in Enquiry Control Center. Specify commercial terms manually below.
                </p>
              </div>
            </div>
          )}

          <div className="grid grid-cols-2 gap-3">
            <div>
              <label className="font-semibold text-gray-700 block mb-1">Product Name *</label>
              <input
                type="text"
                value={productName}
                onChange={(e) => setProductName(e.target.value)}
                required
                placeholder="e.g. Paracetamol IP"
                className="w-full border border-gray-300 rounded px-2.5 py-1.5 focus:border-emerald-600 outline-none"
              />
            </div>
            <div>
              <label className="font-semibold text-gray-700 block mb-1">Quantity *</label>
              <input
                type="text"
                value={quantity}
                onChange={(e) => setQuantity(e.target.value)}
                placeholder="e.g. 5,000 KG"
                required
                className="w-full border border-gray-300 rounded px-2.5 py-1.5 focus:border-emerald-600 outline-none"
              />
            </div>
          </div>

          <div className="grid grid-cols-3 gap-3">
            <div className="col-span-2">
              <label className="font-semibold text-gray-700 block mb-1">Offered Price / Unit * (Must be &gt; 0)</label>
              <input
                type="number"
                step="0.01"
                min="0.01"
                value={offeredPrice === '' ? '' : offeredPrice}
                onChange={(e) => setOfferedPrice(e.target.value === '' ? '' : parseFloat(e.target.value) || '')}
                required
                placeholder="e.g. 6.85"
                className="w-full border border-gray-300 rounded px-2.5 py-1.5 font-bold text-gray-900 focus:border-emerald-600 outline-none"
              />
            </div>
            <div>
              <label className="font-semibold text-gray-700 block mb-1">Currency *</label>
              <select
                value={currency}
                onChange={(e) => setCurrency(e.target.value)}
                className="w-full border border-gray-300 rounded px-2.5 py-1.5 font-bold focus:border-emerald-600 outline-none"
              >
                <option value="USD">USD</option>
                <option value="IDR">IDR</option>
                <option value="EUR">EUR</option>
              </select>
            </div>
          </div>

          <div className="grid grid-cols-2 gap-3">
            <div>
              <label className="font-semibold text-gray-700 block mb-1">Make / Manufacturer</label>
              <input
                type="text"
                value={make}
                onChange={(e) => setMake(e.target.value)}
                placeholder="e.g. Megafine Pharma"
                className="w-full border border-gray-300 rounded px-2.5 py-1.5 focus:border-emerald-600 outline-none"
              />
            </div>
            <div>
              <label className="font-semibold text-gray-700 block mb-1">Country of Origin</label>
              <input
                type="text"
                value={origin}
                onChange={(e) => setOrigin(e.target.value)}
                className="w-full border border-gray-300 rounded px-2.5 py-1.5 focus:border-emerald-600 outline-none"
              />
            </div>
          </div>

          <div className="grid grid-cols-2 gap-3">
            <div>
              <label className="font-semibold text-gray-700 block mb-1">Delivery Terms</label>
              <input
                type="text"
                value={deliveryTerms}
                onChange={(e) => setDeliveryTerms(e.target.value)}
                className="w-full border border-gray-300 rounded px-2.5 py-1.5 focus:border-emerald-600 outline-none"
              />
            </div>
            <div>
              <label className="font-semibold text-gray-700 block mb-1">Payment Terms</label>
              <input
                type="text"
                value={paymentTerms}
                onChange={(e) => setPaymentTerms(e.target.value)}
                className="w-full border border-gray-300 rounded px-2.5 py-1.5 focus:border-emerald-600 outline-none"
              />
            </div>
          </div>

          <div className="flex items-center justify-between p-2.5 bg-slate-50 border border-slate-200 rounded">
            <div className="flex items-center gap-2">
              <input
                type="checkbox"
                id="includePdf"
                checked={includePdf}
                onChange={(e) => setIncludePdf(e.target.checked)}
                className="rounded text-emerald-600 focus:ring-emerald-500"
              />
              <label htmlFor="includePdf" className="text-gray-700 cursor-pointer">
                Generate & attach official PDF Quotation to WhatsApp message
              </label>
            </div>
            <button
              type="button"
              disabled={!isFormValid}
              onClick={() => {
                if (isFormValid) setShowPdfPreviewModal(true);
              }}
              className={`font-semibold flex items-center gap-1 text-[11px] ${
                isFormValid
                  ? 'text-emerald-700 hover:text-emerald-900 cursor-pointer'
                  : 'text-gray-400 cursor-not-allowed opacity-60'
              }`}
              title={!isFormValid ? 'Complete valid product, quantity, and price to preview PDF' : ''}
            >
              <Eye className="w-3.5 h-3.5" />
              Preview Quotation PDF
            </button>
          </div>

          {/* Validation Banner if incomplete */}
          {!isFormValid && (
            <div className="p-2 bg-rose-50 border border-rose-200 rounded text-rose-800 text-[11px] font-semibold flex items-center gap-1.5">
              <AlertTriangle className="w-3.5 h-3.5 text-rose-600 shrink-0" />
              <span>
                {!isQuantityValid && !isPriceValid
                  ? 'Valid Product Name, finite positive Quantity (> 0), Currency, and positive Price (> 0) are required before approval.'
                  : !isQuantityValid
                  ? 'A finite numerical quantity strictly greater than zero (e.g. "5,000 KG" or "1 KG") is required.'
                  : !isPriceValid
                  ? 'A positive unit price strictly greater than zero is required.'
                  : 'Valid Product Name, finite positive Quantity (> 0), Currency, and positive Price (> 0) are required before approval.'}
              </span>
            </div>
          )}

          {/* Explicit Human Review Gate */}
          <div className="flex items-start gap-2 p-2.5 bg-emerald-50/50 border border-emerald-200 rounded">
            <input
              type="checkbox"
              id="operatorConfirm"
              checked={reviewedByOperator}
              onChange={(e) => setReviewedByOperator(e.target.checked)}
              className="mt-0.5 rounded text-emerald-600 focus:ring-emerald-500"
            />
            <label htmlFor="operatorConfirm" className="text-gray-800 cursor-pointer font-medium text-[11px]">
              Human Approval Gate: I confirm I have verified these commercial terms against ERP policy and customer requirements before dispatch.
            </label>
          </div>

          <div>
            <label className="font-semibold text-gray-700 block mb-1">WhatsApp Message Preview</label>
            <pre className="p-3 bg-gray-50 border border-gray-200 rounded text-[11px] font-mono text-gray-800 whitespace-pre-wrap max-h-36 overflow-y-auto">
              {previewText}
            </pre>
          </div>

          {/* Modal for PDF Preview */}
          {showPdfPreviewModal && (
            <div className="p-3 bg-slate-100 border border-slate-300 rounded space-y-2">
              <div className="flex items-center justify-between">
                <span className="font-bold text-slate-800 flex items-center gap-1">
                  <FileText className="w-4 h-4 text-emerald-700" />
                  PDF Quotation Document Layout Preview
                </span>
                <button
                  type="button"
                  onClick={() => setShowPdfPreviewModal(false)}
                  className="text-gray-500 hover:text-gray-800 font-bold"
                >
                  Close Preview
                </button>
              </div>
              <div className="p-3 bg-white border border-gray-300 rounded shadow-inner text-[11px] space-y-1">
                <p className="font-bold text-emerald-800">PT. SHUBHAM ANZEN PHARMA JAYA</p>
                <p className="text-gray-500">Official Commercial Quotation • {quoteDetails.inquiryNumber}</p>
                <hr className="my-1 border-gray-200" />
                <p><strong>Customer:</strong> {quoteDetails.companyName} {quoteDetails.contactPerson ? `(Attn: ${quoteDetails.contactPerson})` : ''}</p>
                <p><strong>Product:</strong> {quoteDetails.productName} | <strong>Quantity:</strong> {quoteDetails.quantity}</p>
                <p><strong>Offered Price:</strong> {quoteDetails.offeredPriceCurrency} {quoteDetails.offeredPrice.toLocaleString()} / Unit</p>
                <p><strong>Make / Origin:</strong> {quoteDetails.make || '-'} / {quoteDetails.origin || '-'}</p>
                <p><strong>Terms:</strong> {quoteDetails.deliveryTerms} • {quoteDetails.paymentTerms}</p>
                <p className="text-[10px] text-amber-700 font-semibold mt-1">
                  Note: A high-resolution PDF will be auto-generated with company letterhead and attached to the WhatsApp payload upon approval.
                </p>
              </div>
            </div>
          )}

          <div className="pt-3 border-t border-gray-200 flex items-center justify-between">
            <span className="text-[10px] text-amber-800 font-bold bg-amber-50 px-2 py-1 rounded border border-amber-200">
              SIMULATED — NOT SENT TO CUSTOMER
            </span>
            <div className="flex items-center gap-2">
              <button
                type="button"
                onClick={onClose}
                disabled={sending}
                className="px-3.5 py-1.5 rounded border border-gray-300 text-gray-700 hover:bg-gray-50"
              >
                Cancel
              </button>
              <button
                type="submit"
                disabled={sending || !isFormValid || !reviewedByOperator}
                className="px-4 py-1.5 rounded bg-emerald-600 hover:bg-emerald-700 text-white font-semibold flex items-center gap-1.5 disabled:opacity-40 disabled:cursor-not-allowed"
              >
                {sending ? <Loader className="w-3.5 h-3.5 animate-spin" /> : <Send className="w-3.5 h-3.5" />}
                Approve & Send Quotation
              </button>
            </div>
          </div>
        </form>
      </div>
    </div>
  );
}

// ==========================================
// 2. SEND COA & TECHNICAL DOCUMENTS MODAL
// ==========================================
interface SendDocumentModalProps {
  isOpen: boolean;
  onClose: () => void;
  onSend: (text: string, documentUrl?: string, filename?: string) => Promise<void>;
  productName: string;
  inquiryId?: string | null;
}

export function SendDocumentModal({
  isOpen,
  onClose,
  onSend,
  productName,
  inquiryId,
}: SendDocumentModalProps) {
  const [loading, setLoading] = useState(false);
  const [coaList, setCoaList] = useState<ProductDocumentItem[]>([]);
  const [specList, setSpecList] = useState<ProductDocumentItem[]>([]);
  const [selectedDocId, setSelectedDocId] = useState<string>('');
  const [sending, setSending] = useState(false);
  const [customMessage, setCustomMessage] = useState('');
  const [batches, setBatches] = useState<BatchStockItem[]>([]);
  const [selectedBatchId, setSelectedBatchId] = useState<string>('');
  const [loadingBatches, setLoadingBatches] = useState(false);
  const [loadError, setLoadError] = useState<string | null>(null);

  useEffect(() => {
    if (isOpen) {
      loadBatchesAndDocuments();
    }
  }, [isOpen, productName, inquiryId]);

  const loadBatchesAndDocuments = async () => {
    setLoadingBatches(true);
    try {
      const stockRes = await ErpCommunicationsService.queryStock(productName);
      setBatches(stockRes?.batches || []);
      await loadDocuments(selectedBatchId || null);
    } finally {
      setLoadingBatches(false);
    }
  };

  const loadDocuments = async (batchId: string | null) => {
    setLoading(true);
    setLoadError(null);
    try {
      const res = await ErpCommunicationsService.queryTechnicalDocuments(productName, inquiryId, batchId);
      setCoaList(res.coaList);
      setSpecList(res.specList);
      const first = res.coaList[0] || res.specList[0];
      if (first) {
        setSelectedDocId(first.id);
        setCustomMessage(
          `Halo, berikut kami lampirkan dokumen ${first.documentType} resmi untuk produk ${first.productName || productName}. Silakan diperiksa. Terima kasih.`
        );
      } else {
        setSelectedDocId('');
      }
    } catch (err: any) {
      setLoadError(err.message || 'Failed to retrieve documents from database.');
    } finally {
      setLoading(false);
    }
  };

  const handleBatchChange = async (batchId: string) => {
    setSelectedBatchId(batchId);
    await loadDocuments(batchId || null);
  };

  const handleSelectDoc = (doc: ProductDocumentItem) => {
    setSelectedDocId(doc.id);
    setCustomMessage(
      `Halo, berikut kami lampirkan dokumen ${doc.documentType} resmi untuk produk ${doc.productName || productName}. Silakan diperiksa. Terima kasih.`
    );
  };

  if (!isOpen) return null;

  const allDocs = [...coaList, ...specList];
  const selectedDoc = allDocs.find((d) => d.id === selectedDocId);
  const selectedBatch = batches.find((b) => b.id === selectedBatchId);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!selectedDoc || !selectedDoc.signedUrl) {
      showToast({ type: 'warning', title: 'Document Required', message: 'Please select a document to attach.' });
      return;
    }

    setSending(true);
    try {
      await onSend(customMessage, selectedDoc.signedUrl, selectedDoc.displayFileName);
      showToast({ type: 'success', title: 'Document Sent', message: `Dispatched ${selectedDoc.displayFileName} via WhatsApp.` });
      onClose();
    } catch (err: any) {
      showToast({ type: 'error', title: 'Send Error', message: err.message || 'Failed to send document.' });
    } finally {
      setSending(false);
    }
  };

  return (
    <div className="fixed inset-0 z-50 bg-slate-900/60 backdrop-blur-sm flex items-center justify-center p-4">
      <div className="bg-white rounded-xl shadow-2xl max-w-xl w-full overflow-hidden flex flex-col max-h-[85vh] animate-in fade-in duration-150">
        <div className="px-5 py-4 border-b border-gray-200 flex items-center justify-between bg-sky-800 text-white">
          <div className="flex items-center gap-2">
            <FileText className="w-5 h-5" />
            <div>
              <div className="flex items-center gap-2">
                <h3 className="text-sm font-bold">Send COA / Technical Document</h3>
                <span className="text-[10px] font-bold px-1.5 py-0.5 rounded bg-amber-400 text-slate-900">
                  SIMULATED — NOT SENT TO CUSTOMER
                </span>
              </div>
              <p className="text-xs text-sky-200">Verified Product Batches & QA Records</p>
            </div>
          </div>
          <button onClick={onClose} className="p-1 rounded hover:bg-sky-700 text-sky-200 hover:text-white">
            <X className="w-5 h-5" />
          </button>
        </div>

        <form onSubmit={handleSubmit} className="p-5 overflow-y-auto space-y-4 text-xs">
          {/* Batch Selector from ERP stock */}
          <div>
            <label className="font-semibold text-gray-700 block mb-1 flex items-center justify-between">
              <span>Filter by Warehouse Batch (Optional)</span>
              {loadingBatches && <Loader className="w-3 h-3 animate-spin text-sky-600" />}
            </label>
            <select
              value={selectedBatchId}
              onChange={(e) => handleBatchChange(e.target.value)}
              className="w-full border border-gray-300 rounded px-2.5 py-1.5 focus:border-sky-600 outline-none"
            >
              <option value="">All / General Product Documents</option>
              {batches.map((b) => (
                <option key={b.id} value={b.id}>
                  Batch: {b.batchNumber} (Free: {b.freeStock} KG, Exp: {b.expiryDate || 'N/A'})
                </option>
              ))}
            </select>
          </div>

          {/* Selected Batch Status Banner */}
          {selectedBatch ? (
            <div className="p-2.5 bg-sky-50 border border-sky-200 rounded-lg flex items-center justify-between text-xs text-sky-900 animate-in fade-in">
              <div className="flex items-center gap-2">
                <Layers className="w-4 h-4 text-sky-700 shrink-0" />
                <div>
                  <span className="font-bold">Batch: {selectedBatch.batchNumber}</span>
                  <span className="text-gray-500 text-[11px] ml-1.5">• Ready Stock: {selectedBatch.freeStock.toLocaleString()} KG • Exp: {selectedBatch.expiryDate || 'N/A'}</span>
                </div>
              </div>
              <span className="text-[10px] font-bold bg-sky-200 text-sky-800 px-2 py-0.5 rounded-full shrink-0">
                Batch Isolated
              </span>
            </div>
          ) : (
            <div className="p-2 bg-gray-50 border border-gray-200 rounded text-[11px] text-gray-500 flex items-center gap-1.5">
              <span className="font-medium text-gray-600">Showing:</span>
              <span>All / General Product Documents (Select a warehouse batch above to isolate COA)</span>
            </div>
          )}

          {loading ? (
            <div className="py-8 text-center text-gray-500">
              <Loader className="w-6 h-6 animate-spin mx-auto mb-2 text-sky-600" />
              Loading verified documents from database...
            </div>
          ) : loadError ? (
            <div className="py-6 text-center text-rose-700 bg-rose-50 border border-rose-200 rounded p-4">
              <AlertTriangle className="w-6 h-6 mx-auto mb-2 text-rose-500" />
              <p className="font-semibold text-rose-900">Failed to Retrieve Documents</p>
              <p className="text-[11px] text-rose-600 mt-1 mb-3">{loadError}</p>
              <button
                type="button"
                onClick={() => loadDocuments(selectedBatchId || null)}
                className="px-3 py-1 bg-rose-600 hover:bg-rose-700 text-white rounded font-semibold text-xs"
              >
                Retry
              </button>
            </div>
          ) : allDocs.length === 0 ? (
            <div className="py-6 text-center text-gray-600 bg-amber-50/70 border border-amber-200 rounded p-4">
              <AlertTriangle className="w-6 h-6 mx-auto mb-2 text-amber-500" />
              <p className="font-semibold text-gray-800">
                {selectedBatch
                  ? `No documents linked to Batch ${selectedBatch.batchNumber}.`
                  : `No Documents Found for ${productName || 'this item'}`}
              </p>
              <p className="text-[11px] text-gray-500 mt-1">
                {selectedBatch
                  ? 'Upload or verify batch documents in Batch Management before sending. Do not send unverified batch records.'
                  : 'Upload approved COA or TDS in CRM Document Bank before dispatching.'}
              </p>
            </div>
          ) : (
            <>
              <div>
                <label className="font-semibold text-gray-700 block mb-1.5">
                  Select Verified Document ({allDocs.length} available)
                </label>
                <div className="space-y-1.5 max-h-48 overflow-y-auto border border-gray-200 rounded p-1.5 bg-gray-50">
                  {allDocs.map((doc) => {
                    const isSelected = doc.id === selectedDocId;
                    return (
                      <div
                        key={doc.id}
                        onClick={() => handleSelectDoc(doc)}
                        className={`p-2.5 rounded border cursor-pointer transition flex items-center justify-between ${
                          isSelected
                            ? 'bg-sky-50 border-sky-400 text-sky-900 shadow-sm'
                            : 'bg-white border-gray-200 hover:border-gray-300'
                        }`}
                      >
                        <div className="flex items-center gap-2 min-w-0">
                          <span
                            className={`px-1.5 py-0.5 rounded text-[10px] font-bold ${
                              doc.documentType === 'COA'
                                ? 'bg-purple-100 text-purple-700'
                                : 'bg-emerald-100 text-emerald-700'
                            }`}
                          >
                            {doc.documentType}
                          </span>
                          <span className="font-medium truncate">{doc.displayFileName}</span>
                        </div>
                        {isSelected && <CheckCircle2 className="w-4 h-4 text-sky-600 shrink-0" />}
                      </div>
                    );
                  })}
                </div>
              </div>

              <div>
                <label className="font-semibold text-gray-700 block mb-1">WhatsApp Message Body</label>
                <textarea
                  rows={3}
                  value={customMessage}
                  onChange={(e) => setCustomMessage(e.target.value)}
                  className="w-full border border-gray-300 rounded p-2 focus:border-sky-600 outline-none"
                />
              </div>

              {selectedDoc && (
                <div className="p-3 bg-sky-50/50 border border-sky-200 rounded flex items-center justify-between">
                  <div className="flex items-center gap-2">
                    <FileText className="w-4 h-4 text-sky-600" />
                    <span className="font-semibold text-sky-900">{selectedDoc.displayFileName}</span>
                  </div>
                  {selectedDoc.signedUrl && (
                    <a
                      href={selectedDoc.signedUrl}
                      target="_blank"
                      rel="noopener noreferrer"
                      className="text-sky-700 hover:text-sky-900 font-semibold underline text-[11px]"
                    >
                      Preview File
                    </a>
                  )}
                </div>
              )}
            </>
          )}

          <div className="pt-3 border-t border-gray-200 flex items-center justify-between">
            <span className="text-[10px] text-amber-800 font-bold bg-amber-50 px-2 py-1 rounded border border-amber-200">
              SIMULATED — NOT SENT TO CUSTOMER
            </span>
            <div className="flex items-center gap-2">
              <button
                type="button"
                onClick={onClose}
                disabled={sending}
                className="px-3.5 py-1.5 rounded border border-gray-300 text-gray-700 hover:bg-gray-50"
              >
                Cancel
              </button>
              <button
                type="submit"
                disabled={sending || allDocs.length === 0}
                className="px-4 py-1.5 rounded bg-sky-600 hover:bg-sky-700 text-white font-semibold flex items-center gap-1.5 disabled:opacity-50"
              >
                {sending ? <Loader className="w-3.5 h-3.5 animate-spin" /> : <Send className="w-3.5 h-3.5" />}
                Send Document to Customer
              </button>
            </div>
          </div>
        </form>
      </div>
    </div>
  );
}

// ==========================================
// 3. STOCK ENQUIRY MODAL
// ==========================================
interface StockCheckModalProps {
  isOpen: boolean;
  onClose: () => void;
  onInsertMessage: (text: string) => void;
  initialProduct: string;
}

export function StockCheckModal({
  isOpen,
  onClose,
  onInsertMessage,
  initialProduct,
}: StockCheckModalProps) {
  const [productSearch, setProductSearch] = useState(initialProduct || '');
  const [stockResult, setStockResult] = useState<StockEnquiryResult | null>(null);
  const [loading, setLoading] = useState(false);

  useEffect(() => {
    if (isOpen && initialProduct) {
      setProductSearch(initialProduct);
      performStockQuery(initialProduct);
    }
  }, [isOpen, initialProduct]);

  const performStockQuery = async (query: string) => {
    if (!query.trim()) return;
    setLoading(true);
    try {
      const res = await ErpCommunicationsService.queryStock(query);
      setStockResult(res);
    } finally {
      setLoading(false);
    }
  };

  if (!isOpen) return null;

  return (
    <div className="fixed inset-0 z-50 bg-slate-900/60 backdrop-blur-sm flex items-center justify-center p-4">
      <div className="bg-white rounded-xl shadow-2xl max-w-lg w-full overflow-hidden flex flex-col max-h-[85vh] animate-in fade-in duration-150">
        <div className="px-5 py-4 border-b border-gray-200 flex items-center justify-between bg-slate-800 text-white">
          <div className="flex items-center gap-2">
            <Package className="w-5 h-5 text-amber-400" />
            <div>
              <h3 className="text-sm font-bold">ERP Inventory Stock Check</h3>
              <p className="text-xs text-slate-300">Live Godown & Batch Balances</p>
            </div>
          </div>
          <button onClick={onClose} className="p-1 rounded hover:bg-slate-700 text-slate-300 hover:text-white">
            <X className="w-5 h-5" />
          </button>
        </div>

        <div className="p-5 overflow-y-auto space-y-4 text-xs">
          <div className="flex gap-2">
            <input
              type="text"
              value={productSearch}
              onChange={(e) => setProductSearch(e.target.value)}
              placeholder="Enter product name (e.g. Paracetamol, Minoxidil)"
              className="flex-1 border border-gray-300 rounded px-2.5 py-1.5 focus:border-slate-800 outline-none"
            />
            <button
              onClick={() => performStockQuery(productSearch)}
              disabled={loading}
              className="px-3.5 py-1.5 bg-slate-800 hover:bg-slate-900 text-white font-semibold rounded disabled:opacity-50"
            >
              Check
            </button>
          </div>

          {loading ? (
            <div className="py-8 text-center text-gray-500">
              <Loader className="w-5 h-5 animate-spin mx-auto mb-2 text-slate-700" />
              Reading real-time stock balances...
            </div>
          ) : stockResult ? (
            <div className="space-y-3">
              <div className="p-3 bg-slate-50 border border-slate-200 rounded flex items-center justify-between">
                <div>
                  <p className="font-bold text-gray-900">{stockResult.productName}</p>
                  <p className="text-[11px] text-gray-500 mt-0.5">
                    Physical Stock: {stockResult.totalCurrentStock.toLocaleString()} KG
                  </p>
                </div>
                <div className="text-right">
                  <span className="text-[10px] uppercase font-bold text-gray-500 block">Available (Free)</span>
                  <span
                    className={`text-base font-extrabold ${
                      stockResult.totalFreeStock > 0 ? 'text-emerald-600' : 'text-rose-600'
                    }`}
                  >
                    {stockResult.totalFreeStock.toLocaleString()} KG
                  </span>
                </div>
              </div>

              {stockResult.batches.length > 0 && (
                <div>
                  <label className="font-semibold text-gray-700 block mb-1">Batch Breakdown</label>
                  <div className="space-y-1.5 max-h-36 overflow-y-auto border border-gray-200 rounded p-1.5 bg-gray-50">
                    {stockResult.batches.map((b: any) => (
                      <div
                        key={b.id}
                        className="p-2 bg-white rounded border border-gray-200 flex items-center justify-between text-[11px]"
                      >
                        <div>
                          <span className="font-mono font-bold text-slate-900">{b.batchNumber}</span>
                          <span className="text-gray-400 ml-2">Exp: {b.expiryDate || 'N/A'}</span>
                        </div>
                        <span className="font-bold text-emerald-700">{b.freeStock.toLocaleString()} KG</span>
                      </div>
                    ))}
                  </div>
                </div>
              )}

              <div>
                <label className="font-semibold text-gray-700 block mb-1">Formatted Response Preview</label>
                <pre className="p-3 bg-gray-50 border border-gray-200 rounded text-[11px] font-mono text-gray-800 whitespace-pre-wrap max-h-32 overflow-y-auto">
                  {stockResult.suggestedReplyText}
                </pre>
              </div>

              <div className="pt-2 flex justify-end gap-2">
                <button
                  type="button"
                  onClick={onClose}
                  className="px-3.5 py-1.5 rounded border border-gray-300 text-gray-700 hover:bg-gray-50"
                >
                  Close
                </button>
                <button
                  type="button"
                  onClick={() => {
                    onInsertMessage(stockResult.suggestedReplyText);
                    onClose();
                  }}
                  className="px-4 py-1.5 rounded bg-emerald-600 hover:bg-emerald-700 text-white font-semibold"
                >
                  Insert Stock Info into Chat
                </button>
              </div>
            </div>
          ) : null}
        </div>
      </div>
    </div>
  );
}

// ==========================================
// 4. CREATE FOLLOW-UP MODAL
// ==========================================
interface CreateFollowUpModalProps {
  isOpen: boolean;
  onClose: () => void;
  conversationId: string;
  inquiryId?: string | null;
  customerId?: string | null;
  companyName: string;
}

export function CreateFollowUpModal({
  isOpen,
  onClose,
  conversationId,
  inquiryId,
  customerId,
  companyName,
}: CreateFollowUpModalProps) {
  const [days, setDays] = useState(2);
  const [instruction, setInstruction] = useState('Follow up after 2 days if no reply from customer');
  const [saving, setSaving] = useState(false);

  if (!isOpen) return null;

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setSaving(true);
    try {
      const res = await ErpCommunicationsService.createFollowUp({
        conversationId,
        inquiryId,
        customerId,
        daysFromNow: days,
        instruction,
      });
      showToast({
        type: 'success',
        title: 'Follow-Up Scheduled',
        message: `Task scheduled for ${new Date(res.deadline).toLocaleDateString()}. Auto-cancels if customer replies.`,
      });
      onClose();
    } catch (err: any) {
      showToast({ type: 'error', title: 'Task Error', message: err.message || 'Failed to schedule follow-up.' });
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="fixed inset-0 z-50 bg-slate-900/60 backdrop-blur-sm flex items-center justify-center p-4">
      <div className="bg-white rounded-xl shadow-2xl max-w-md w-full overflow-hidden animate-in fade-in duration-150">
        <div className="px-5 py-4 border-b border-gray-200 flex items-center justify-between bg-indigo-800 text-white">
          <div className="flex items-center gap-2">
            <Clock className="w-5 h-5 text-indigo-300" />
            <div>
              <h3 className="text-sm font-bold">Schedule Durable Follow-Up</h3>
              <p className="text-xs text-indigo-200">ERP Task Engine • Auto-Cancels on Reply</p>
            </div>
          </div>
          <button onClick={onClose} className="p-1 rounded hover:bg-indigo-700 text-indigo-200 hover:text-white">
            <X className="w-5 h-5" />
          </button>
        </div>

        <form onSubmit={handleSubmit} className="p-5 space-y-4 text-xs">
          <div>
            <label className="font-semibold text-gray-700 block mb-1">Company</label>
            <p className="font-bold text-gray-900 p-2 bg-gray-50 border border-gray-200 rounded">{companyName}</p>
          </div>

          <div>
            <label className="font-semibold text-gray-700 block mb-1">Follow-Up Schedule</label>
            <select
              value={days}
              onChange={(e) => {
                const d = parseInt(e.target.value, 10);
                setDays(d);
                setInstruction(`Follow up after ${d} days if no reply from customer`);
              }}
              className="w-full border border-gray-300 rounded px-2.5 py-1.5 focus:border-indigo-600 outline-none"
            >
              <option value={1}>Tomorrow (1 day)</option>
              <option value={2}>After 2 days (Recommended)</option>
              <option value={3}>After 3 days</option>
              <option value={5}>After 5 days</option>
              <option value={7}>After 1 week</option>
            </select>
          </div>

          <div>
            <label className="font-semibold text-gray-700 block mb-1">Action Instruction / Reminder Note</label>
            <textarea
              rows={3}
              value={instruction}
              onChange={(e) => setInstruction(e.target.value)}
              required
              className="w-full border border-gray-300 rounded p-2 focus:border-indigo-600 outline-none"
            />
          </div>

          <div className="p-2.5 bg-indigo-50 border border-indigo-200 rounded text-[11px] text-indigo-900 flex items-start gap-2">
            <CheckCircle2 className="w-4 h-4 text-indigo-600 shrink-0 mt-0.5" />
            <span>
              Smart Cancellation: If the customer replies on WhatsApp before the deadline, this task is
              automatically marked completed.
            </span>
          </div>

          <div className="pt-2 flex justify-end gap-2 border-t border-gray-200">
            <button
              type="button"
              onClick={onClose}
              disabled={saving}
              className="px-3.5 py-1.5 rounded border border-gray-300 text-gray-700 hover:bg-gray-50"
            >
              Cancel
            </button>
            <button
              type="submit"
              disabled={saving}
              className="px-4 py-1.5 rounded bg-indigo-600 hover:bg-indigo-700 text-white font-semibold flex items-center gap-1.5 disabled:opacity-50"
            >
              {saving ? <Loader className="w-3.5 h-3.5 animate-spin" /> : <Clock className="w-3.5 h-3.5" />}
              Set Follow-Up Task
            </button>
          </div>
        </form>
      </div>
    </div>
  );
}

// ==========================================
// 5. CUSTOMER DISAMBIGUATION DIALOG
// ==========================================
interface CustomerDisambiguationDialogProps {
  isOpen: boolean;
  onClose: () => void;
  phone: string;
  candidates: PhoneMatchCandidate[];
  onSelectCandidate: (candidate: PhoneMatchCandidate) => void;
}

export function CustomerDisambiguationDialog({
  isOpen,
  onClose,
  phone,
  candidates,
  onSelectCandidate,
}: CustomerDisambiguationDialogProps) {
  if (!isOpen) return null;

  return (
    <div className="fixed inset-0 z-50 bg-slate-900/60 backdrop-blur-sm flex items-center justify-center p-4">
      <div className="bg-white rounded-xl shadow-2xl max-w-md w-full overflow-hidden animate-in fade-in duration-150">
        <div className="px-5 py-4 border-b border-gray-200 flex items-center justify-between bg-amber-600 text-white">
          <div className="flex items-center gap-2">
            <AlertTriangle className="w-5 h-5" />
            <div>
              <h3 className="text-sm font-bold">Multiple Customer Matches</h3>
              <p className="text-xs text-amber-100">Select the intended company</p>
            </div>
          </div>
          <button onClick={onClose} className="p-1 rounded hover:bg-amber-700 text-amber-200 hover:text-white">
            <X className="w-5 h-5" />
          </button>
        </div>

        <div className="p-5 space-y-3 text-xs">
          <p className="text-gray-600">
            The phone number <span className="font-mono font-bold text-gray-900">{phone}</span> matches more than
            one customer record in the CRM database. Please select which customer this conversation belongs to:
          </p>

          <div className="space-y-2 max-h-56 overflow-y-auto">
            {candidates.map((cand, i) => (
              <div
                key={i}
                onClick={() => {
                  onSelectCandidate(cand);
                  onClose();
                }}
                className="p-3 bg-gray-50 hover:bg-amber-50 border border-gray-200 hover:border-amber-300 rounded-lg cursor-pointer transition flex items-center justify-between"
              >
                <div>
                  <div className="flex items-center gap-2">
                    <p className="font-bold text-gray-900">{cand.companyName}</p>
                    {cand.isFullMatch ? (
                      <span className="px-1.5 py-0.5 rounded text-[9px] font-bold bg-emerald-100 text-emerald-800 border border-emerald-300">
                        Exact Full Match
                      </span>
                    ) : (
                      <span className="px-1.5 py-0.5 rounded text-[9px] font-bold bg-amber-100 text-amber-800 border border-amber-300">
                        Suffix Candidate
                      </span>
                    )}
                  </div>
                  <p className="text-[11px] text-gray-500 mt-0.5">
                    Contact: {cand.contactPerson || 'General / Reception'} • Source: {cand.source}
                  </p>
                </div>
                <button className="px-2.5 py-1 bg-amber-600 hover:bg-amber-700 text-white rounded font-semibold text-[11px]">
                  Select
                </button>
              </div>
            ))}
          </div>
        </div>
      </div>
    </div>
  );
}
