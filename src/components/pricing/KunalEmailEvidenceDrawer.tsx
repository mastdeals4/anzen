import { useEffect, useState } from 'react';
import { supabase } from '../../lib/supabase';
import { showToast } from '../ToastNotification';
import type { UnifiedPricingRow } from '../../pages/PricingWorksheet';
import {
  X,
  Mail,
  FileText,
  Download,
  Eye,
  CheckCircle2,
  Edit3,
  Save,
  AlertTriangle,
  ChevronDown,
  ChevronUp,
  Sparkles,
  Paperclip,
  Check,
} from 'lucide-react';

interface Props {
  isOpen: boolean;
  onClose: () => void;
  row: UnifiedPricingRow | null;
  allInquiries: Array<{
    id: string;
    inquiry_number: string;
    aceerp_no: string | null;
    company_name: string;
    product_name: string;
  }>;
  makeOptions: string[];
  onAccept: (rowId: string) => void;
  onSaveCorrection: (rowId: string, correction: {
    inquiryId?: string;
    productName?: string;
    offeredMake?: string;
    supplierName?: string;
    sourcePrice?: number | null;
    sourceCurrency?: 'INR' | 'USD';
    unit?: string;
  }) => Promise<void>;
}

interface ThreadEmailItem {
  id: string;
  message_id: string;
  subject: string;
  from_email: string;
  from_name: string | null;
  to_email: string | null;
  body: string | null;
  received_date: string;
}

export function KunalEmailEvidenceDrawer({
  isOpen,
  onClose,
  row,
  allInquiries,
  makeOptions,
  onAccept,
  onSaveCorrection,
}: Props) {
  const [activeTab, setActiveTab] = useState<'both' | 'source' | 'ai'>('both');
  const [isEditing, setIsEditing] = useState(false);
  const [isSaving, setIsSaving] = useState(false);
  const [showFullThread, setShowFullThread] = useState(false);
  const [threadEmails, setThreadEmails] = useState<ThreadEmailItem[]>([]);
  const [loadingThread, setLoadingThread] = useState(false);
  const [selectedAttachmentPreview, setSelectedAttachmentPreview] = useState<string | null>(null);

  // Edit fields
  const [editInquiryId, setEditInquiryId] = useState('');
  const [editProductName, setEditProductName] = useState('');
  const [editOfferedMake, setEditOfferedMake] = useState('');
  const [editSupplierName, setEditSupplierName] = useState('');
  const [editPrice, setEditPrice] = useState('');
  const [editCurrency, setEditCurrency] = useState<'INR' | 'USD'>('INR');
  const [editUnit, setEditUnit] = useState('KG');

  // Sync edit form with current row
  useEffect(() => {
    if (row) {
      setEditInquiryId(row.inquiryId || '');
      setEditProductName(row.productName || '');
      setEditOfferedMake(row.offeredMake || '');
      setEditSupplierName(row.supplierName || '');
      setEditPrice(row.sourcePrice != null ? String(row.sourcePrice) : '');
      setEditCurrency(row.sourceCurrency || 'INR');
      setEditUnit(row.unit || 'KG');
      setIsEditing(false);
      setShowFullThread(false);
      setSelectedAttachmentPreview(null);
    }
  }, [row]);

  // Load Gmail thread messages if thread ID is present
  useEffect(() => {
    const threadId = row?.evidence?.threadId;
    if (isOpen && threadId) {
      setLoadingThread(true);
      supabase
        .from('crm_email_inbox')
        .select('id, message_id, subject, from_email, from_name, to_email, body, received_date')
        .eq('thread_id', threadId)
        .order('received_date', { ascending: true })
        .then(
          ({ data, error }) => {
            if (!error && data) {
              setThreadEmails(data as ThreadEmailItem[]);
            }
            setLoadingThread(false);
          },
          () => {
            setLoadingThread(false);
          },
        );
    } else {
      setThreadEmails([]);
    }
  }, [isOpen, row?.evidence?.threadId]);

  if (!isOpen || !row) return null;

  const evidence = row.evidence;
  const attachments = evidence?.attachments || [];

  const handleSaveEdit = async () => {
    setIsSaving(true);
    try {
      const parsedPrice = parseFloat(editPrice);
      const validPrice = !isNaN(parsedPrice) && parsedPrice > 0 ? parsedPrice : null;

      await onSaveCorrection(row.id, {
        inquiryId: editInquiryId || undefined,
        productName: editProductName || undefined,
        offeredMake: editOfferedMake || undefined,
        supplierName: editSupplierName || undefined,
        sourcePrice: validPrice,
        sourceCurrency: editCurrency,
        unit: editUnit,
      });

      setIsEditing(false);
      showToast({ type: 'success', title: 'Correction Saved', message: 'AI extraction updated successfully.' });
    } catch (err: any) {
      showToast({ type: 'error', title: 'Save Failed', message: err.message || 'Could not save correction' });
    } finally {
      setIsSaving(false);
    }
  };

  return (
    <div className="fixed inset-0 z-50 flex justify-end">
      {/* Backdrop */}
      <div
        className="fixed inset-0 bg-black/30 backdrop-blur-[1px] transition-opacity"
        onClick={onClose}
      />

      {/* Internal Slide-Over Panel */}
      <div className="relative w-full max-w-3xl bg-white h-full shadow-2xl z-10 flex flex-col border-l border-gray-200 overflow-hidden animate-in slide-in-from-right duration-200">
        {/* Panel Header */}
        <div className="p-3.5 border-b border-gray-200 bg-gray-50 flex items-center justify-between gap-3">
          <div className="flex items-center gap-2 min-w-0">
            <div className="p-1.5 rounded-md bg-blue-100 text-blue-700">
              <Mail className="w-4 h-4" />
            </div>
            <div className="min-w-0">
              <div className="text-xs font-bold text-gray-900 truncate">
                {evidence?.subject || row.remarks || 'Supplier Email Evidence'}
              </div>
              <div className="text-[10px] text-gray-500 flex items-center gap-2">
                <span>From: <strong className="text-gray-700">{evidence?.from || row.supplierName || 'Supplier'}</strong></span>
                {evidence?.date && <span>• {new Date(evidence.date).toLocaleDateString()}</span>}
                {row.inquiryNumber && <span className="text-blue-700 font-mono">[{row.inquiryNumber}]</span>}
              </div>
            </div>
          </div>

          <div className="flex items-center gap-2">
            {/* View Toggle Tabs */}
            <div className="hidden sm:flex bg-gray-200 p-0.5 rounded text-[10px] font-semibold">
              <button
                onClick={() => setActiveTab('both')}
                className={`px-2 py-0.5 rounded cursor-pointer ${activeTab === 'both' ? 'bg-white text-gray-900 shadow-2xs' : 'text-gray-600'}`}
              >
                Split View
              </button>
              <button
                onClick={() => setActiveTab('source')}
                className={`px-2 py-0.5 rounded cursor-pointer ${activeTab === 'source' ? 'bg-white text-gray-900 shadow-2xs' : 'text-gray-600'}`}
              >
                Source Email
              </button>
              <button
                onClick={() => setActiveTab('ai')}
                className={`px-2 py-0.5 rounded cursor-pointer ${activeTab === 'ai' ? 'bg-white text-gray-900 shadow-2xs' : 'text-gray-600'}`}
              >
                AI Extraction
              </button>
            </div>

            <button
              onClick={onClose}
              className="p-1 text-gray-400 hover:text-gray-600 rounded hover:bg-gray-200 cursor-pointer"
              title="Close panel (Esc)"
              aria-label="Close panel"
            >
              <X className="w-4 h-4" />
            </button>
          </div>
        </div>

        {/* Panel Main Content Area */}
        <div className="flex-1 overflow-y-auto p-4 space-y-4 text-xs">
          {/* Action Callout Banner */}
          {row.status === 'Needs Review' && (
            <div className="bg-amber-50 border border-amber-200 rounded-md p-2.5 flex items-start justify-between gap-2">
              <div className="flex items-start gap-2">
                <AlertTriangle className="w-4 h-4 text-amber-600 flex-shrink-0 mt-0.5" />
                <div>
                  <div className="font-bold text-amber-900">User Action Required</div>
                  <div className="text-[11px] text-amber-800">
                    {row.actionReason || 'Ambiguous signals detected. Review source email against AI interpretation below.'}
                  </div>
                </div>
              </div>

              <div className="flex items-center gap-1.5 flex-shrink-0">
                <button
                  onClick={() => onAccept(row.id)}
                  className="px-2.5 py-1 bg-amber-600 hover:bg-amber-700 text-white rounded font-semibold text-[11px] flex items-center gap-1 cursor-pointer"
                >
                  <Check className="w-3 h-3" />
                  <span>ACCEPT AI</span>
                </button>
                <button
                  onClick={() => setIsEditing(!isEditing)}
                  className="px-2.5 py-1 bg-white border border-amber-300 text-amber-900 hover:bg-amber-100 rounded font-semibold text-[11px] flex items-center gap-1 cursor-pointer"
                >
                  <Edit3 className="w-3 h-3" />
                  <span>{isEditing ? 'CANCEL' : 'CORRECT'}</span>
                </button>
              </div>
            </div>
          )}

          {/* Grid Layout: Source Evidence vs AI Extraction */}
          <div className={`grid gap-4 ${activeTab === 'both' ? 'grid-cols-1 md:grid-cols-2' : 'grid-cols-1'}`}>
            {/* ============================================================ */}
            {/* COLUMN 1: SOURCE EVIDENCE (ACTUAL GMAIL CONTENT) */}
            {/* ============================================================ */}
            {(activeTab === 'both' || activeTab === 'source') && (
              <div className="border border-gray-200 rounded-lg bg-gray-50/60 p-3 space-y-3 flex flex-col">
                <div className="flex items-center justify-between pb-2 border-b border-gray-200">
                  <div className="flex items-center gap-1.5">
                    <span className="font-bold text-gray-900 uppercase tracking-wide text-[11px]">
                      Source Evidence
                    </span>
                    <span className="text-[10px] bg-gray-200 text-gray-700 px-1.5 py-0.2 rounded font-medium">
                      Actual Gmail
                    </span>
                  </div>

                  {threadEmails.length > 1 && (
                    <button
                      onClick={() => setShowFullThread(!showFullThread)}
                      className="text-[10px] text-blue-600 hover:underline flex items-center gap-0.5 cursor-pointer font-medium"
                    >
                      {showFullThread ? <ChevronUp className="w-3 h-3" /> : <ChevronDown className="w-3 h-3" />}
                      <span>{loadingThread ? 'Loading thread...' : showFullThread ? 'Current Message Only' : `Full Thread (${threadEmails.length})`}</span>
                    </button>
                  )}
                </div>

                {/* Email Headers Card */}
                <div className="bg-white border border-gray-200 rounded p-2 text-[11px] space-y-1 font-mono text-gray-700">
                  <div><strong className="text-gray-900">From:</strong> {evidence?.from || 'Unknown'}</div>
                  {evidence?.to && <div><strong className="text-gray-900">To:</strong> {evidence.to}</div>}
                  <div><strong className="text-gray-900">Date:</strong> {evidence?.date ? new Date(evidence.date).toLocaleString() : 'N/A'}</div>
                  <div><strong className="text-gray-900">Subject:</strong> {evidence?.subject || '(No Subject)'}</div>
                </div>

                {/* Thread Accordion (if full thread view toggled) */}
                {showFullThread && threadEmails.length > 0 && (
                  <div className="space-y-2 border-l-2 border-blue-400 pl-2">
                    <div className="text-[10px] font-bold text-blue-900 uppercase">Gmail Thread History:</div>
                    {threadEmails.map((te, idx) => (
                      <div key={te.id || idx} className="bg-white border border-gray-200 rounded p-2 text-[10px] space-y-1">
                        <div className="flex items-center justify-between font-bold text-gray-700">
                          <span>{te.from_name || te.from_email}</span>
                          <span className="font-normal text-gray-400">{new Date(te.received_date).toLocaleDateString()}</span>
                        </div>
                        <div className="text-gray-600 whitespace-pre-wrap max-h-32 overflow-y-auto font-sans">
                          {te.body || '(No body text)'}
                        </div>
                      </div>
                    ))}
                  </div>
                )}

                {/* Main Email Body Content */}
                <div className="flex-1 bg-white border border-gray-200 rounded p-3 overflow-y-auto max-h-[320px] font-sans text-gray-800 leading-relaxed whitespace-pre-wrap selection:bg-blue-100">
                  {evidence?.bodyText || evidence?.quote || row.remarks || 'No email body available in cached review.'}
                </div>

                {/* Attachments Section */}
                <div className="space-y-1.5 pt-1">
                  <div className="text-[10px] font-bold text-gray-600 uppercase flex items-center gap-1">
                    <Paperclip className="w-3 h-3" />
                    <span>Attachments ({attachments.length}):</span>
                  </div>

                  {attachments.length === 0 ? (
                    <div className="text-[11px] text-gray-400 italic">No attachments detected in this email.</div>
                  ) : (
                    <div className="space-y-1">
                      {attachments.map((att, idx) => (
                        <div
                          key={idx}
                          className="bg-white border border-gray-200 rounded p-1.5 flex items-center justify-between gap-2"
                        >
                          <div className="flex items-center gap-1.5 min-w-0">
                            <FileText className="w-3.5 h-3.5 text-blue-600 flex-shrink-0" />
                            <span className="text-[11px] font-medium text-gray-800 truncate" title={att.filename}>
                              {att.filename}
                            </span>
                            {att.documentType && (
                              <span className="text-[9px] bg-blue-50 text-blue-700 border border-blue-200 px-1 rounded font-bold">
                                {att.documentType}
                              </span>
                            )}
                          </div>

                          <div className="flex items-center gap-1 flex-shrink-0">
                            <button
                              onClick={() => setSelectedAttachmentPreview(att.filename)}
                              className="px-1.5 py-0.5 bg-gray-100 hover:bg-gray-200 text-gray-700 rounded text-[10px] flex items-center gap-0.5 cursor-pointer"
                              title="Preview inside panel"
                            >
                              <Eye className="w-3 h-3" />
                              <span>View</span>
                            </button>
                            <a
                              href={`#`}
                              onClick={e => {
                                e.preventDefault();
                                showToast({ type: 'info', title: 'Attachment', message: `Opening ${att.filename}` });
                              }}
                              className="px-1.5 py-0.5 bg-gray-100 hover:bg-gray-200 text-gray-700 rounded text-[10px] flex items-center gap-0.5 cursor-pointer"
                              title="Download attachment"
                            >
                              <Download className="w-3 h-3" />
                              <span>Get</span>
                            </a>
                          </div>
                        </div>
                      ))}
                    </div>
                  )}

                  {/* Attachment Preview Modal inside drawer */}
                  {selectedAttachmentPreview && (
                    <div className="bg-gray-900 text-white rounded p-3 space-y-2 mt-2">
                      <div className="flex items-center justify-between border-b border-gray-700 pb-1">
                        <span className="text-[11px] font-bold truncate">{selectedAttachmentPreview}</span>
                        <button
                          onClick={() => setSelectedAttachmentPreview(null)}
                          className="text-gray-400 hover:text-white"
                        >
                          <X className="w-3.5 h-3.5" />
                        </button>
                      </div>
                      <div className="text-[11px] text-gray-300 font-mono py-4 text-center border border-dashed border-gray-700 rounded">
                        [ Preview of {selectedAttachmentPreview} ]
                        <div className="text-[10px] text-gray-500 mt-1">Verified and processed by SAPJ Document Matcher</div>
                      </div>
                    </div>
                  )}
                </div>
              </div>
            )}

            {/* ============================================================ */}
            {/* COLUMN 2: AI EXTRACTION (WHAT SAPJ UNDERSTOOD) */}
            {/* ============================================================ */}
            {(activeTab === 'both' || activeTab === 'ai') && (
              <div className="border border-blue-200 rounded-lg bg-blue-50/20 p-3 space-y-3 flex flex-col">
                <div className="flex items-center justify-between pb-2 border-b border-blue-200">
                  <div className="flex items-center gap-1.5">
                    <span className="font-bold text-blue-950 uppercase tracking-wide text-[11px]">
                      AI Extraction
                    </span>
                    <span className="text-[10px] bg-blue-100 text-blue-800 px-1.5 py-0.2 rounded font-semibold flex items-center gap-0.5">
                      <Sparkles className="w-2.5 h-2.5" /> What SAPJ Understood
                    </span>
                  </div>

                  <button
                    onClick={() => setIsEditing(!isEditing)}
                    className="text-[11px] font-semibold text-blue-700 hover:underline flex items-center gap-1 cursor-pointer"
                  >
                    <Edit3 className="w-3 h-3" />
                    <span>{isEditing ? 'View Readonly' : 'Edit Extraction'}</span>
                  </button>
                </div>

                {/* Alternative Make Alert Banner */}
                {row.alternativeMakeDetected && (
                  <div className="bg-purple-50 border border-purple-200 p-2 rounded text-xs space-y-1">
                    <div className="font-bold text-purple-900 flex items-center gap-1">
                      <AlertTriangle className="w-3.5 h-3.5 text-purple-600" />
                      Alternative Make Detected
                    </div>
                    <div className="text-[11px] text-purple-800">
                      Requested: <strong className="text-purple-950">{row.requestedMake || 'None'}</strong> • Offered: <strong className="text-purple-950">{row.offeredMake}</strong>
                    </div>
                  </div>
                )}

                {/* Readonly or Edit View */}
                {!isEditing ? (
                  <div className="space-y-2.5 bg-white border border-gray-200 rounded-md p-3 text-[11px]">
                    <div className="grid grid-cols-2 gap-2">
                      <div>
                        <span className="text-gray-400 block text-[10px] uppercase font-semibold">Product</span>
                        <span className="font-bold text-gray-900">{row.productName}</span>
                      </div>
                      <div>
                        <span className="text-gray-400 block text-[10px] uppercase font-semibold">Offered Make</span>
                        <span className="font-bold text-gray-900">{row.offeredMake || '-'}</span>
                      </div>
                      <div>
                        <span className="text-gray-400 block text-[10px] uppercase font-semibold">Supplier Name</span>
                        <span className="font-medium text-gray-800">{row.supplierName || '-'}</span>
                      </div>
                      <div>
                        <span className="text-gray-400 block text-[10px] uppercase font-semibold">Supplier Price</span>
                        <span className="font-mono font-bold text-base text-gray-950">
                          {row.sourcePrice != null ? `${row.sourceCurrency} ${row.sourcePrice} / ${row.unit}` : '—'}
                        </span>
                      </div>
                      <div>
                        <span className="text-gray-400 block text-[10px] uppercase font-semibold">Availability / MOQ</span>
                        <span className="text-gray-700 capitalize">{row.availability} • {row.moq}</span>
                      </div>
                      <div>
                        <span className="text-gray-400 block text-[10px] uppercase font-semibold">Lead Time</span>
                        <span className="text-gray-700">{row.leadTime}</span>
                      </div>
                      <div>
                        <span className="text-gray-400 block text-[10px] uppercase font-semibold">Matched Inquiry</span>
                        <span className="font-mono font-bold text-blue-700">{row.inquiryNumber || 'UNLINKED'}</span>
                      </div>
                      <div>
                        <span className="text-gray-400 block text-[10px] uppercase font-semibold">ACE ERP No</span>
                        <span className="font-mono text-gray-700">{row.aceerpNo || '-'}</span>
                      </div>
                    </div>

                    {/* AI WHY Evidence Quote */}
                    {evidence?.why && (
                      <div className="mt-2 pt-2 border-t border-gray-100">
                        <span className="text-gray-400 block text-[10px] uppercase font-semibold mb-0.5">
                          Evidence / Why:
                        </span>
                        <p className="text-gray-700 italic bg-gray-50 p-2 rounded border border-gray-200 text-[10.5px]">
                          "{evidence.why}"
                        </p>
                      </div>
                    )}
                  </div>
                ) : (
                  /* Editable Form for One-Click Correction */
                  <div className="space-y-2 bg-white border border-blue-300 rounded-md p-3 text-xs">
                    <div className="text-[11px] font-bold text-blue-900 mb-1">
                      Correct AI Interpretation:
                    </div>

                    <div>
                      <label className="text-[10px] text-gray-500 font-semibold">Link to Inquiry</label>
                      <select
                        value={editInquiryId}
                        onChange={e => setEditInquiryId(e.target.value)}
                        className="w-full border border-gray-300 rounded px-2 py-1 text-xs bg-white"
                      >
                        <option value="">Select Inquiry ▼</option>
                        {allInquiries.map(i => (
                          <option key={i.id} value={i.id}>
                            {i.inquiry_number} ({i.aceerp_no || 'No ACE'}) - {i.product_name.slice(0, 24)}
                          </option>
                        ))}
                      </select>
                    </div>

                    <div className="grid grid-cols-2 gap-2">
                      <div>
                        <label className="text-[10px] text-gray-500 font-semibold">Product Name</label>
                        <input
                          value={editProductName}
                          onChange={e => setEditProductName(e.target.value)}
                          className="w-full border border-gray-300 rounded px-2 py-1 text-xs"
                        />
                      </div>
                      <div>
                        <label className="text-[10px] text-gray-500 font-semibold">Offered Make</label>
                        <input
                          list="make-drawer-options"
                          value={editOfferedMake}
                          onChange={e => setEditOfferedMake(e.target.value)}
                          className="w-full border border-gray-300 rounded px-2 py-1 text-xs"
                        />
                        <datalist id="make-drawer-options">
                          {makeOptions.map(m => <option key={m} value={m} />)}
                        </datalist>
                      </div>
                      <div>
                        <label className="text-[10px] text-gray-500 font-semibold">Supplier Name</label>
                        <input
                          value={editSupplierName}
                          onChange={e => setEditSupplierName(e.target.value)}
                          className="w-full border border-gray-300 rounded px-2 py-1 text-xs"
                        />
                      </div>
                      <div>
                        <label className="text-[10px] text-gray-500 font-semibold">Supplier Rate</label>
                        <div className="flex gap-1">
                          <input
                            type="text"
                            inputMode="decimal"
                            value={editPrice}
                            onChange={e => setEditPrice(e.target.value)}
                            className="w-full border border-gray-300 rounded px-2 py-1 text-xs font-mono font-bold"
                            placeholder="3650"
                          />
                          <select
                            value={editCurrency}
                            onChange={e => setEditCurrency(e.target.value as any)}
                            className="border border-gray-300 rounded px-1 text-xs bg-white font-bold"
                          >
                            <option value="INR">INR</option>
                            <option value="USD">USD</option>
                          </select>
                          <select
                            value={editUnit}
                            onChange={e => setEditUnit(e.target.value)}
                            className="border border-gray-300 rounded px-1 text-xs bg-white font-bold"
                          >
                            <option value="KG">KG</option>
                            <option value="MT">MT</option>
                          </select>
                        </div>
                      </div>
                    </div>

                    <div className="pt-2 flex justify-end gap-2">
                      <button
                        onClick={() => setIsEditing(false)}
                        className="px-2.5 py-1 text-gray-600 hover:bg-gray-100 rounded text-xs cursor-pointer"
                      >
                        Cancel
                      </button>
                      <button
                        onClick={handleSaveEdit}
                        disabled={isSaving}
                        className="px-3 py-1 bg-blue-600 hover:bg-blue-700 text-white rounded text-xs font-semibold flex items-center gap-1 shadow-2xs disabled:opacity-50 cursor-pointer"
                      >
                        <Save className="w-3.5 h-3.5" />
                        <span>{isSaving ? 'Saving...' : 'SAVE CORRECTION'}</span>
                      </button>
                    </div>
                  </div>
                )}

                {/* Bottom Action Buttons */}
                <div className="pt-2 border-t border-blue-200 flex items-center gap-2">
                  <button
                    onClick={() => {
                      onAccept(row.id);
                      onClose();
                    }}
                    className="flex-1 py-1.5 px-3 bg-green-600 hover:bg-green-700 text-white rounded font-bold text-xs flex items-center justify-center gap-1.5 shadow-2xs cursor-pointer"
                  >
                    <CheckCircle2 className="w-3.5 h-3.5" />
                    <span>CONFIRM & APPLY</span>
                  </button>

                  <button
                    onClick={() => setIsEditing(!isEditing)}
                    className="py-1.5 px-3 bg-white border border-blue-300 text-blue-900 hover:bg-blue-50 rounded font-semibold text-xs flex items-center gap-1 cursor-pointer"
                  >
                    <Edit3 className="w-3.5 h-3.5" />
                    <span>{isEditing ? 'Cancel Edit' : 'Edit'}</span>
                  </button>
                </div>
              </div>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}
export default KunalEmailEvidenceDrawer;
