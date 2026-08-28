import { useEffect, useMemo, useState } from 'react';
import { X, Plus, Trash2, AlertCircle, CheckCircle2, Search, Loader, Sparkles } from 'lucide-react';
import {
  parseSourceReplyEmail, saveSourceReplyRow, findInquiryCandidates,
  type ParsedSourceRow, type SourceType, type InquiryCandidate,
} from '../../services/sourceReplyParser';
import { showToast } from '../ToastNotification';
import { useAuth } from '../../contexts/AuthContext';
import { MoneyInput } from '../MoneyInput';

interface Props {
  open: boolean;
  onClose: () => void;
  onSaved?: () => void;
  /** Email content to parse */
  email: {
    subject: string;
    body: string;
    fromEmail?: string;
    fromName?: string;
    receivedAt?: string;
    gmailMessageId?: string | null;
    gmailThreadId?: string | null;
  };
  sourceTypeHint?: SourceType;
}

interface ReviewRow extends ParsedSourceRow {
  // Local-only fields
  selectedInquiryId: string | null;
  candidates: InquiryCandidate[];
  candidatesLoading: boolean;
  saved: boolean;
  saveError: string | null;
}

const SOURCE_COLOR: Record<string, string> = {
  india: 'bg-orange-100 text-orange-700',
  china: 'bg-red-100 text-red-700',
  local: 'bg-green-100 text-green-700',
};

const LOW_CONFIDENCE = 0.55;

export function SourceReplyReviewModal({ open, onClose, onSaved, email, sourceTypeHint }: Props) {
  const { profile } = useAuth();
  const isManager = profile?.role === 'admin' || profile?.role === 'manager';
  const [loading, setLoading] = useState(false);
  const [parseError, setParseError] = useState<string | null>(null);
  const [rows, setRows] = useState<ReviewRow[]>([]);
  const [sourceType, setSourceType] = useState<SourceType>(sourceTypeHint || 'india');
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    if (!open) return;
    let cancelled = false;
    (async () => {
      setLoading(true);
      setParseError(null);
      setRows([]);
      const res = await parseSourceReplyEmail({
        emailSubject: email.subject,
        emailBody: email.body,
        fromEmail: email.fromEmail,
        fromName: email.fromName,
        receivedAt: email.receivedAt,
        gmailMessageId: email.gmailMessageId,
        gmailThreadId: email.gmailThreadId,
        sourceTypeHint: sourceTypeHint || 'india',
      });
      if (cancelled) return;
      if (!res.success) {
        setParseError(res.error || 'Failed to parse email');
        setLoading(false);
        return;
      }
      setSourceType(res.source_type || 'india');
      // Initialise review rows and start candidate lookups
      const initial: ReviewRow[] = res.rows.map(r => ({
        ...r,
        selectedInquiryId: null,
        candidates: [],
        candidatesLoading: true,
        saved: false,
        saveError: null,
      }));
      setRows(initial);
      setLoading(false);
      // fire candidate lookups in parallel
      initial.forEach((r, idx) => {
        findInquiryCandidates({
          inquiry_number: r.inquiry_number,
          aceerp_no: r.aceerp_no,
          product_name: r.product_name,
        }).then(cands => {
          setRows(curr => curr.map((row, i) => {
            if (i !== idx) return row;
            const preferred = cands[0]?.id || null;
            return { ...row, candidates: cands, candidatesLoading: false, selectedInquiryId: preferred };
          }));
        });
      });
    })();
    return () => { cancelled = true; };
  }, [open, email.subject, email.body, sourceTypeHint, email.fromEmail, email.fromName, email.gmailMessageId, email.gmailThreadId, email.receivedAt]);

  const updateRow = (idx: number, patch: Partial<ReviewRow>) => {
    setRows(curr => curr.map((row, i) => i === idx ? { ...row, ...patch } : row));
  };

  const removeRow = (idx: number) => {
    setRows(curr => curr.filter((_, i) => i !== idx));
  };

  const addRow = () => {
    setRows(curr => [...curr, {
      product_name: '',
      inquiry_number: null,
      aceerp_no: null,
      offered_make: null,
      source_price: null,
      source_currency: 'INR',
      quantity: null,
      availability: 'available',
      document_status: 'pending',
      lead_time: null,
      remark: null,
      confidence: 0.5,
      raw_excerpt: '',
      selectedInquiryId: null,
      candidates: [],
      candidatesLoading: false,
      saved: false,
      saveError: null,
    }]);
  };

  const readyToSave = useMemo(
    () => rows.some(r => !r.saved && r.selectedInquiryId && r.product_name.trim()),
    [rows]
  );

  const confirmSave = async () => {
    if (!isManager) {
      showToast({ type: 'error', title: 'Not allowed', message: 'Only admin/manager can save parser results.' });
      return;
    }
    setSaving(true);
    let successCount = 0;
    let failCount = 0;
    const next = [...rows];
    for (let i = 0; i < next.length; i++) {
      const r = next[i];
      if (r.saved || !r.selectedInquiryId || !r.product_name.trim()) continue;
      const res = await saveSourceReplyRow({
        inquiryId: r.selectedInquiryId,
        sourceType,
        row: r,
        gmailMessageId: email.gmailMessageId,
        gmailThreadId: email.gmailThreadId,
        parserConfidence: r.confidence,
        actorId: profile?.id || null,
      });
      if (res.ok) { next[i] = { ...r, saved: true, saveError: null }; successCount++; }
      else { next[i] = { ...r, saveError: res.error || 'Save failed' }; failCount++; }
    }
    setRows(next);
    setSaving(false);
    if (successCount > 0) {
      showToast({
        type: failCount > 0 ? 'warning' : 'success',
        title: 'Source reply saved',
        message: `${successCount} row${successCount !== 1 ? 's' : ''} saved${failCount > 0 ? `, ${failCount} failed` : ''}.`,
      });
      onSaved?.();
    } else if (failCount > 0) {
      showToast({ type: 'error', title: 'Save failed', message: `${failCount} rows could not be saved.` });
    }
  };

  if (!open) return null;

  return (
    <div className="fixed inset-0 bg-black/40 z-50 flex items-center justify-center p-4">
      <div className="bg-white rounded-lg shadow-xl w-full max-w-6xl max-h-[90vh] flex flex-col">
        <div className="px-4 py-3 border-b border-gray-200 flex items-center justify-between">
          <div className="flex items-center gap-2">
            <Sparkles className="w-4 h-4 text-purple-600" />
            <div>
              <h2 className="text-sm font-semibold text-gray-900">Source Reply Review</h2>
              <p className="text-[11px] text-gray-500">AI-parsed supplier reply — confirm each row before saving to CRM.</p>
            </div>
          </div>
          <div className="flex items-center gap-2">
            <label className="text-[11px] text-gray-600">Route:</label>
            <select value={sourceType} onChange={e => setSourceType(e.target.value as SourceType)}
              className="border border-gray-200 rounded px-1.5 py-0.5 text-xs">
              <option value="india">India</option>
              <option value="china">China</option>
              <option value="local">Local</option>
            </select>
            <button onClick={onClose} className="p-1 rounded hover:bg-gray-100"><X className="w-4 h-4" /></button>
          </div>
        </div>

        <div className="flex-1 overflow-y-auto p-4 space-y-2">
          {loading && (
            <div className="flex items-center gap-2 text-sm text-gray-500 py-10 justify-center">
              <Loader className="w-4 h-4 animate-spin" /> Parsing supplier reply with AI…
            </div>
          )}
          {parseError && (
            <div className="bg-amber-50 border border-amber-200 rounded px-3 py-2 text-xs text-amber-800 flex items-start gap-2">
              <AlertCircle className="w-4 h-4 mt-0.5" />
              <div>
                <p className="font-medium">{parseError}</p>
                <p>You can still enter source details manually — add a row below, pick the inquiry, fill in price and availability.</p>
              </div>
            </div>
          )}

          {!loading && !parseError && rows.length === 0 && (
            <div className="text-xs text-gray-500 py-8 text-center">
              No rows were extracted from this email. You can add rows manually.
            </div>
          )}

          {rows.map((r, idx) => {
            const lowConf = r.confidence < LOW_CONFIDENCE;
            return (
              <div key={idx} className={`border rounded p-2 space-y-1.5 ${r.saved ? 'border-green-300 bg-green-50/40' : lowConf ? 'border-amber-300 bg-amber-50/40' : 'border-gray-200'}`}>
                <div className="flex items-center gap-2 flex-wrap text-[11px]">
                  <span className={`inline-flex px-1.5 py-0.5 rounded text-[10px] font-medium ${SOURCE_COLOR[sourceType]}`}>{sourceType}</span>
                  {r.inquiry_number && <span className="text-gray-700"><strong>{r.inquiry_number}</strong></span>}
                  {r.aceerp_no && <span className="text-gray-500">AC ERP# {r.aceerp_no}</span>}
                  <span className={`ml-auto text-[10px] ${lowConf ? 'text-amber-700' : 'text-gray-500'}`}>
                    conf {(r.confidence * 100).toFixed(0)}%
                  </span>
                  {r.saved
                    ? <span className="text-[10px] text-green-700 font-medium flex items-center gap-0.5"><CheckCircle2 className="w-3 h-3" /> saved</span>
                    : (
                      <button onClick={() => removeRow(idx)} className="text-gray-400 hover:text-red-600" title="Remove row">
                        <Trash2 className="w-3.5 h-3.5" />
                      </button>
                    )}
                </div>

                <div className="grid grid-cols-12 gap-1.5 items-center text-xs">
                  <input value={r.product_name}
                    onChange={e => updateRow(idx, { product_name: e.target.value })}
                    placeholder="Product name *"
                    className="col-span-3 border border-gray-200 rounded px-2 py-1" disabled={r.saved} />
                  <input value={r.offered_make || ''}
                    onChange={e => updateRow(idx, { offered_make: e.target.value })}
                    placeholder="Offered make"
                    className="col-span-2 border border-gray-200 rounded px-2 py-1" disabled={r.saved} />
                  <div className="col-span-2 flex gap-1">
                    <select value={r.source_currency}
                      onChange={e => updateRow(idx, { source_currency: e.target.value })}
                      className="border border-gray-200 rounded px-1 py-1 text-xs w-14" disabled={r.saved}>
                      {['INR','USD','CNY','IDR','EUR','GBP'].map(c => <option key={c}>{c}</option>)}
                    </select>
                    <MoneyInput value={r.source_price}
                      onChange={amount => updateRow(idx, { source_price: amount || null })}
                      placeholder="Price"
                      className="flex-1 border border-gray-200 rounded px-2 py-1 text-xs" disabled={r.saved} maximumFractionDigits={4} />
                  </div>
                  <select value={r.availability}
                    onChange={e => updateRow(idx, { availability: e.target.value as 'available' | 'partial' | 'na' })}
                    className="col-span-1 border border-gray-200 rounded px-1 py-1 text-xs" disabled={r.saved}>
                    {['available','partial','na'].map(s => <option key={s}>{s}</option>)}
                  </select>
                  <select value={r.document_status}
                    onChange={e => updateRow(idx, { document_status: e.target.value as ParsedSourceRow['document_status'] })}
                    className="col-span-2 border border-gray-200 rounded px-1 py-1 text-xs" disabled={r.saved}>
                    {['pending','received','not_required','partial'].map(s => <option key={s}>{s}</option>)}
                  </select>
                  <input value={r.lead_time || ''}
                    onChange={e => updateRow(idx, { lead_time: e.target.value })}
                    placeholder="Lead time"
                    className="col-span-2 border border-gray-200 rounded px-2 py-1 text-xs" disabled={r.saved} />
                </div>

                <div className="grid grid-cols-12 gap-1.5 items-start text-xs">
                  <textarea value={r.remark || ''}
                    onChange={e => updateRow(idx, { remark: e.target.value })}
                    placeholder="Remark"
                    rows={1}
                    className="col-span-6 border border-gray-200 rounded px-2 py-1 text-xs" disabled={r.saved} />
                  <div className="col-span-6 flex items-center gap-1.5">
                    <Search className="w-3 h-3 text-gray-400 flex-shrink-0" />
                    {r.candidatesLoading ? (
                      <span className="text-[10px] text-gray-400">Finding inquiry…</span>
                    ) : r.candidates.length === 0 ? (
                      <span className="text-[10px] text-amber-700">No matching inquiry — pick manually</span>
                    ) : (
                      <select value={r.selectedInquiryId || ''}
                        onChange={e => updateRow(idx, { selectedInquiryId: e.target.value || null })}
                        className="flex-1 border border-gray-200 rounded px-1 py-1 text-xs" disabled={r.saved}>
                        <option value="">— Select inquiry —</option>
                        {r.candidates.map(c => (
                          <option key={c.id} value={c.id}>
                            {c.inquiry_number}{c.aceerp_no ? ` · ${c.aceerp_no}` : ''} · {c.product_name} · {c.company_name}
                          </option>
                        ))}
                      </select>
                    )}
                  </div>
                </div>

                {r.raw_excerpt && (
                  <details className="text-[10px] text-gray-500">
                    <summary className="cursor-pointer hover:underline">Raw excerpt</summary>
                    <pre className="mt-1 whitespace-pre-wrap bg-white border border-gray-200 rounded p-1.5 max-h-20 overflow-y-auto">{r.raw_excerpt}</pre>
                  </details>
                )}

                {r.saveError && (
                  <p className="text-[10px] text-red-700 bg-red-50 border border-red-200 rounded px-2 py-1">Error: {r.saveError}</p>
                )}
              </div>
            );
          })}

          <button onClick={addRow} className="w-full flex items-center justify-center gap-1 text-[11px] text-blue-600 hover:underline py-1">
            <Plus className="w-3 h-3" /> Add row manually
          </button>
        </div>

        <div className="px-4 py-3 border-t border-gray-200 flex items-center justify-between bg-gray-50">
          <p className="text-[11px] text-gray-500">
            Saves pricing options on the matched CRM inquiry. Purchase / Selling prices stay blank — Kunal enters them in Kunal Pricing.
          </p>
          <div className="flex items-center gap-2">
            <button onClick={onClose} className="text-xs text-gray-600 hover:text-gray-800 px-2 py-1">Cancel</button>
            <button onClick={confirmSave} disabled={!readyToSave || saving || !isManager}
              className="flex items-center gap-1.5 px-3 py-1.5 text-xs bg-blue-600 text-white rounded hover:bg-blue-700 disabled:opacity-50">
              {saving ? <><Loader className="w-3.5 h-3.5 animate-spin" /> Saving…</> : <><CheckCircle2 className="w-3.5 h-3.5" /> Confirm & Save</>}
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}
