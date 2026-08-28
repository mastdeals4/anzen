/**
 * AI India Price Review — Kunal Pricing tab body.
 *
 * Two-panel Gmail-like layout:
 *   - Left: Extraction Queue table (classified emails, filterable)
 *   - Right: Email Reader with full body + Analyze + Review & Save controls
 *
 * Reuses:
 *   - scanKunalIndiaInbox / analyzeIndiaPriceEmail / saveIndiaPriceExtraction / saveIndiaDocument
 *     (src/services/kunalIndiaPrice.ts)
 *   - findInquiryCandidates from sourceReplyParser (for manual re-link)
 *
 * Strict rules:
 *   - Never auto-save (button required)
 *   - Never modifies purchase_price / offered_price on crm_inquiries
 *   - Never modifies quote_status / price_quoted / quote_sent_at
 *   - Documents only saved on explicit confirm
 */

import { useEffect, useMemo, useRef, useState } from 'react';
import { Search, RefreshCw, Loader, FileText, Paperclip, AlertTriangle, CheckCircle2, Save, X, Eye, Download, FolderPlus, Sparkles } from 'lucide-react';
import { showToast } from '../ToastNotification';
import { MoneyInput } from '../MoneyInput';
// Reuse the Gmail-quality renderer that Command Center's InquiryFormPanel uses.
// Same iframe-based viewer with permissive DOMPurify, entity decoding,
// blockquote collapse, and Gmail-style CSS — no behavior change for Command Center.
import { EmailBodyViewer } from './EmailBodyViewer';
import { useAuth } from '../../contexts/AuthContext';
import { useNavigation } from '../../contexts/NavigationContext';
import { supabase } from '../../lib/supabase';
import {
  loadGmailMailbox,
  analyzeMessages,
  cleanupMisclassifiedReviews,
  llmReclassifyPersistedSuspects,
  analyzeIndiaPriceEmail,
  saveIndiaPriceExtraction,
  saveIndiaDocument,
  fetchAttachmentBlob,
  getRecentReviews,
  hydrateReviewAsRow,
  updateReviewStatus,
  type KunalIndiaReviewRow,
  type IndiaExtractionRow,
  type IndiaAiType,
} from '../../services/kunalIndiaPrice';
import { findInquiryCandidates } from '../../services/sourceReplyParser';
import {
  type TrackerBucket,
  AI_QUEUE_BUCKETS,
  getAiBucketRows,
} from './KunalPendingPriceTracker';

type AttachmentMeta = { filename: string; mimeType: string; size: number; attachmentId: string };
type ViewerState = {
  attachment: AttachmentMeta;
  url: string;
  loading: boolean;
} | null;
type DocType = 'COA' | 'MSDS' | 'COC' | 'GMP' | 'ISO' | 'DMF' | 'SPEC' | 'TDS' | 'MHD' | 'CATALOGUE' | 'PRICE_LIST' | 'OTHER';

// Detect a document type for an attachment before saving, so the user sees the
// AI's guess up-front and can override it. Order: the email-level AI documentType
// (from classify-sourcing-email) → filename keyword heuristic → OTHER.
const DOC_TYPE_LABELS: Record<DocType, string> = {
  COA: 'Certificate of Analysis',
  MSDS: 'Safety Data Sheet (MSDS/SDS)',
  COC: 'Certificate of Conformance',
  GMP: 'GMP Certificate',
  ISO: 'ISO Certificate',
  DMF: 'Drug Master File',
  SPEC: 'Specification Sheet',
  TDS: 'Technical Data Sheet',
  MHD: 'Method / Handling Doc',
  CATALOGUE: 'Product Catalogue',
  PRICE_LIST: 'Price List',
  OTHER: 'Other Document',
};

const DOC_TYPE_OPTIONS: DocType[] = ['COA','MSDS','COC','GMP','ISO','DMF','SPEC','TDS','CATALOGUE','PRICE_LIST','MHD','OTHER'];

function detectAttachmentDocType(filename: string, emailDocType?: string | null): { docType: DocType; source: 'ai' | 'filename' | 'default' } {
  const fname = (filename || '').toLowerCase();
  const fnameRules: Array<[RegExp, DocType]> = [
    [/coa|certificate of analysis/, 'COA'],
    [/msds|sds|safety data/, 'MSDS'],
    [/\bcoc\b|conformance|conformity/, 'COC'],
    [/gmp/, 'GMP'],
    [/\biso\b/, 'ISO'],
    [/dmf|drug master/, 'DMF'],
    [/tds|technical data/, 'TDS'],
    [/price\s*list|pricelist/, 'PRICE_LIST'],
    [/catalog(ue)?/, 'CATALOGUE'],
    [/spec(ification)?/, 'SPEC'],
  ];
  // Filename is the most specific signal for an individual attachment.
  for (const [re, dt] of fnameRules) {
    if (re.test(fname)) return { docType: dt, source: 'filename' };
  }
  // Fall back to the email-level AI classification, if usable.
  const valid = DOC_TYPE_OPTIONS as string[];
  if (emailDocType && valid.includes(emailDocType)) {
    return { docType: emailDocType as DocType, source: 'ai' };
  }
  return { docType: 'OTHER', source: 'default' };
}

// Map a 0–1 candidate score to a 1–5 star rating for an at-a-glance match
// strength badge on candidate cards.
function scoreToStars(score: number): number {
  if (score >= 0.75) return 5;
  if (score >= 0.60) return 4;
  if (score >= 0.45) return 3;
  if (score >= 0.30) return 2;
  return 1;
}

interface Props {
  /** Called whenever an extraction is saved or a document is linked, so PendingPriceTracker can refresh. */
  onChange?: () => void;
  /** Active tracker card filter from PendingPriceTracker (filters the queue when set). */
  activeBucket?: TrackerBucket | null;
  /** Clear the active tracker card filter. */
  onClearBucket?: () => void;
  /** Emits the latest in-memory rows so the parent tracker can derive AI-queue counts. */
  onRowsChange?: (rows: KunalIndiaReviewRow[]) => void;
}

const BUCKET_LABELS: Record<TrackerBucket, string> = {
  new_ai_reviews: 'New AI Reviews',
  documents_received: 'Documents Received',
  needs_manual_link: 'Needs Manual Link',
  india_received: 'India Price Emails',
  ready_for_calc: 'Ready for Calculation',
  reply_pending: 'Price Entered — Reply Pending',
  reply_sent: 'Internal Reply Sent',
};

// Single source of truth for "this email needs no Kunal action". Anything
// downstream (badges, headers, counts, filters) checks this — never repeats
// the literal comparison — so we can't get into contradictory states like
// the screenshot where the badge said No Action but the inquiry slot still
// said Needs Manual Link.
function isNoAction(r: { aiType: IndiaAiType }): boolean {
  return r.aiType === 'No Action';
}

const AI_TYPE_BADGE: Record<IndiaAiType, string> = {
  'India Price Received': 'bg-green-100 text-green-700 border-green-200',
  'India Query / Missing Info': 'bg-amber-100 text-amber-700 border-amber-200',
  'Document / Certificate Received': 'bg-sky-100 text-sky-700 border-sky-200',
  'Alternative Source / Not Available': 'bg-rose-100 text-rose-700 border-rose-200',
  'No Action': 'bg-slate-100 text-slate-600 border-slate-200',
  'Needs Review': 'bg-zinc-100 text-zinc-700 border-zinc-200',
};

type FilterKey =
  | 'actionable'
  | 'all'
  | 'pending_review'
  | 'price'
  | 'documents'
  | 'query'
  | 'no_action';

const TYPE_FILTERS: Array<{ key: FilterKey; label: string }> = [
  { key: 'actionable', label: 'Actionable' },
  { key: 'all', label: 'All' },
  { key: 'pending_review', label: 'Pending Review' },
  { key: 'price', label: 'Price' },
  { key: 'documents', label: 'Documents' },
  { key: 'query', label: 'Query' },
  { key: 'no_action', label: 'No Action' },
];

function rowMatchesFilter(r: KunalIndiaReviewRow, key: FilterKey): boolean {
  if (key === 'all') return true;
  if (key === 'actionable') return r.aiType !== 'No Action';
  if (key === 'pending_review') return !r.reviewed && r.aiType !== 'No Action';
  if (key === 'price') return r.aiType === 'India Price Received' || r.aiType === 'Alternative Source / Not Available';
  if (key === 'documents') return r.aiType === 'Document / Certificate Received';
  if (key === 'query') return r.aiType === 'India Query / Missing Info' || r.aiType === 'Needs Review';
  if (key === 'no_action') return r.aiType === 'No Action';
  return true;
}

type ListMode = 'mailbox' | 'queue';

export function KunalIndiaPriceReview({ onChange, activeBucket, onClearBucket, onRowsChange }: Props) {
  const { profile } = useAuth();
  const { setCurrentPage, setNavigationData } = useNavigation();
  const isManager = profile?.role === 'admin' || profile?.role === 'manager';

  const [query, setQuery] = useState('in:inbox');
  const [maxResults, setMaxResults] = useState(50);
  const [scanning, setScanning] = useState(false);
  const [analyzingBatch, setAnalyzingBatch] = useState(false);
  const [autoLoaded, setAutoLoaded] = useState(false);
  const [scanError, setScanError] = useState<string | null>(null);
  // Mailbox rows = live Gmail inbox (with AI status join). Default view.
  const [mailboxRows, setMailboxRows] = useState<KunalIndiaReviewRow[]>([]);
  // Queue rows = persisted AI reviews only.
  const [queueRows, setQueueRows] = useState<KunalIndiaReviewRow[]>([]);
  const [listMode, setListMode] = useState<ListMode>('mailbox');
  const rows = listMode === 'mailbox' ? mailboxRows : queueRows;
  const setRows: (next: KunalIndiaReviewRow[] | ((p: KunalIndiaReviewRow[]) => KunalIndiaReviewRow[])) => void =
    listMode === 'mailbox' ? setMailboxRows : setQueueRows;
  const [selectedId, setSelectedId] = useState<string | null>(null);

  const [search, setSearch] = useState('');
  const [typeFilter, setTypeFilter] = useState<FilterKey>('actionable');

  const [analyzingId, setAnalyzingId] = useState<string | null>(null);
  const [extractionRows, setExtractionRows] = useState<IndiaExtractionRow[]>([]);
  const [savingExtraction, setSavingExtraction] = useState(false);

  const [savingDocId, setSavingDocId] = useState<string | null>(null);
  const [manualSearchText, setManualSearchText] = useState<Record<number, string>>({});
  const [manualSearching, setManualSearching] = useState<Record<number, boolean>>({});
  const [showManualSearch, setShowManualSearch] = useState<Record<number, boolean>>({});
  const [viewMode, setViewMode] = useState<'rich' | 'plain'>('rich');
  // Fallback for the EmailBodyReader iframe — its sandboxed quote toggle can't
  // run scripts inside an `allow-same-origin`-only sandbox, so the collapsed
  // blue "..." trail never expands by click alone. This state drives an
  // external "Show full email trail" button that renders the full quoted /
  // forwarded thread outside the iframe (plain text + thread_messages list)
  // without touching EmailBodyViewer (Command Center still uses it as-is).
  const [showFullTrail, setShowFullTrail] = useState(false);
  const [viewer, setViewer] = useState<ViewerState>(null);
  const [downloadingId, setDownloadingId] = useState<string | null>(null);
  const [savePrompt, setSavePrompt] = useState<{ attachment: AttachmentMeta; docType: DocType } | null>(null);

  // Reset the per-email view mode when switching emails so we don't keep stale state.
  useEffect(() => {
    setViewMode('rich');
    setShowFullTrail(false);
  }, [selectedId]);

  // Lazy-fetch full body + attachments for rows that were hydrated from the
  // persisted review queue (those rows don't carry the body in-memory).
  useEffect(() => {
    if (!selectedId) return;
    const current = rows.find(r => r.messageId === selectedId);
    if (!current) return;
    if (current.body || current.bodyHtml) return; // already loaded
    let cancelled = false;
    (async () => {
      try {
        const { data } = await supabase.functions.invoke('gmail-inbox-message', {
          body: { messageId: selectedId, includeThread: true },
        });
        if (cancelled || !data?.message) return;
        setRows(prev => prev.map(r => r.messageId === selectedId ? {
          ...r,
          to: data.message.to || r.to,
          cc: data.message.cc || r.cc,
          body: data.message.body || r.snippet,
          bodyHtml: data.message.bodyHtml || '',
          bodyText: data.message.bodyText || data.message.body || '',
          attachments: data.message.attachments || [],
          hasAttachments: data.message.hasAttachments ?? r.hasAttachments,
          threadMessages: data.thread_messages || undefined,
        } : r));
      } catch { /* non-critical */ }
    })();
    return () => { cancelled = true; };
  }, [selectedId, listMode]);

  // Revoke blob URL when viewer closes or unmounts so we don't leak object URLs.
  useEffect(() => {
    return () => { if (viewer?.url) URL.revokeObjectURL(viewer.url); };
  }, [viewer?.url]);

  const filteredRows = useMemo(() => {
    const q = search.trim().toLowerCase();
    // When a tracker card is active we restrict to the SHARED predicate the
    // tracker used to count the card — guaranteeing card count === list count.
    // Only AI_QUEUE_BUCKETS reach this filter; workflow cards never set
    // activeBucket (they jump to a worksheet tab instead), so this branch
    // does not need a fall-through for ready_for_calc / reply_pending / reply_sent.
    const bucketScoped = activeBucket && AI_QUEUE_BUCKETS.has(activeBucket)
      ? getAiBucketRows(rows, activeBucket)
      : rows;
    return bucketScoped.filter(r => {
      if (!activeBucket && !rowMatchesFilter(r, typeFilter)) return false;
      if (!q) return true;
      // Search hits envelope fields, body (when loaded), AI-extracted fields,
      // and inquiry / AC ERP numbers. So "Folic Acid" finds a generic-subject
      // PERMINTAAN email whose body / extracted product contains it.
      const hay = [
        r.from, r.to, r.cc,
        r.subject, r.snippet,
        r.body, r.bodyText,
        r.product, r.make,
        r.summary, r.suggestedAction,
        r.matchedInquiryNumber, r.aceerpNo,
      ].filter(Boolean).join(' ').toLowerCase();
      return hay.includes(q);
    });
  }, [rows, search, typeFilter, activeBucket]);

  // Emit rows upward so the tracker can derive AI-queue counts from the
  // EXACT same array the list renders.
  useEffect(() => {
    onRowsChange?.(rows);
  }, [rows, onRowsChange]);

  // Stale-preview guard: whenever the active bucket / type filter / row data
  // changes, drop the selection if it's not in the filtered list. If the
  // bucket is empty, clear the selection entirely so the right pane shows
  // "No emails in this bucket." instead of a previously selected email.
  useEffect(() => {
    if (selectedId && !filteredRows.some(r => r.messageId === selectedId)) {
      setSelectedId(filteredRows[0]?.messageId || null);
    }
  }, [filteredRows, selectedId]);


  // Workflow buckets (ready_for_calc / reply_pending / reply_sent) no longer
  // filter this list — they jump to the Kunal Pricing worksheet tab instead.
  // So we no longer need to fetch per-row downstream inquiry state here.

  const selected = useMemo(
    () => rows.find(r => r.messageId === selectedId) || null,
    [rows, selectedId],
  );

  // ── Part 1: Auto-summary on open ──────────────────────────────────────────
  // When a manager opens an un-analyzed email, classify it automatically so the
  // AI summary, product, match and confidence appear without a manual click.
  // Explainable + safe: manager-only, once per message (ref guard prevents any
  // loop), waits until the body has loaded for full context, and the manual
  // "Analyze This Email" button stays available. Never auto-saves anything.
  const autoAnalyzeAttempted = useRef<Set<string>>(new Set());
  useEffect(() => {
    if (!isManager || !selected) return;
    if (selected.analyzed) return;                       // already classified
    if (analyzingBatch || analyzingId) return;           // don't race a manual run
    if (!(selected.body || selected.bodyHtml)) return;   // wait for body load
    if (autoAnalyzeAttempted.current.has(selected.messageId)) return;
    autoAnalyzeAttempted.current.add(selected.messageId);
    void analyzeOne(selected, { auto: true });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selectedId, selected?.body, selected?.bodyHtml, selected?.analyzed, isManager, analyzingBatch, analyzingId]);

  // Refresh Gmail (mailbox mode): pull the live Gmail inbox + join AI status.
  // No LLM here — that runs only on explicit Analyze / Rescan All.
  const refreshMailbox = async () => {
    setScanning(true);
    setScanError(null);
    try {
      const { rows: loaded } = await loadGmailMailbox({ query, maxResults });
      setMailboxRows(loaded);
      setSelectedId(prev => prev && loaded.some(r => r.messageId === prev) ? prev : (loaded[0]?.messageId || null));
      setExtractionRows([]);
      if (!autoLoaded) setAutoLoaded(true);
    } catch (err: any) {
      const msg = err?.message || 'Gmail load failed.';
      setScanError(msg);
      showToast({ type: 'error', title: 'Gmail load failed', message: msg });
    } finally {
      setScanning(false);
    }
  };

  // Refresh AI Queue: pull the persisted reviews table (no Gmail call needed).
  const refreshQueue = async () => {
    setScanning(true);
    setScanError(null);
    try {
      const persisted = await getRecentReviews(200);
      const hydrated = persisted.map(p => hydrateReviewAsRow(p, null));
      setQueueRows(hydrated);
      setSelectedId(prev => prev && hydrated.some(r => r.messageId === prev) ? prev : (hydrated[0]?.messageId || null));
      setExtractionRows([]);
    } catch (err: any) {
      showToast({ type: 'error', title: 'Queue load failed', message: err?.message || 'unknown' });
    } finally {
      setScanning(false);
    }
  };

  // Analyze the currently selected email via LLM. Errors are surfaced.
  // `msg` defaults to the selected row so existing button handlers keep working;
  // the auto-analyze effect passes an explicit row + { auto: true }.
  const analyzeOne = async (
    msg: KunalIndiaReviewRow | null | undefined = selected,
    opts?: { auto?: boolean },
  ) => {
    if (!msg) return;
    setAnalyzingBatch(true);
    try {
      const updated = await analyzeMessages([msg], profile?.id || null);
      const next = updated[0];
      if (next) {
        setMailboxRows(prev => prev.map(r => r.messageId === next.messageId ? { ...r, ...next } : r));
        setQueueRows(prev => prev.map(r => r.messageId === next.messageId ? { ...r, ...next } : r));
      }
      showToast({
        type: 'success',
        title: opts?.auto ? 'Auto-analyzed on open' : 'Analyzed',
        message: `Classified as ${next?.aiType}.`,
      });
      onChange?.();
    } catch (err: any) {
      console.error('[KunalAI] analyze failed:', err);
      // Auto-analyze failures stay quiet-ish: the manual Analyze button remains
      // available, so surface as info rather than a scary error on open.
      showToast({
        type: opts?.auto ? 'info' : 'error',
        title: opts?.auto ? 'Auto-analyze unavailable' : 'AI relevance classifier failed',
        message: err?.message || 'unknown',
      });
    } finally {
      setAnalyzingBatch(false);
    }
  };

  // Rescan All: run LLM on every currently visible Unanalyzed row, plus the
  // historical cleanup passes. Errors are surfaced; no silent No Action.
  const rescanAll = async () => {
    setAnalyzingBatch(true);
    try {
      let cleanedUp = 0;
      try { cleanedUp += (await cleanupMisclassifiedReviews()).updated; } catch { /* non-critical */ }
      try { cleanedUp += (await llmReclassifyPersistedSuspects(40)).updated; } catch { /* non-critical */ }
      const targets = filteredRows.filter(r => !r.analyzed);
      if (targets.length > 0) {
        const updated = await analyzeMessages(targets, profile?.id || null);
        const byId = new Map(updated.map(r => [r.messageId, r]));
        setMailboxRows(prev => prev.map(r => byId.get(r.messageId) || r));
        setQueueRows(prev => prev.map(r => byId.get(r.messageId) || r));
      }
      if (cleanedUp > 0) {
        showToast({ type: 'info', title: 'Cleanup applied', message: `${cleanedUp} previously mis-tagged email${cleanedUp === 1 ? '' : 's'} moved to No Action.` });
      } else if (targets.length === 0) {
        showToast({ type: 'info', title: 'Nothing to rescan', message: 'All visible emails already classified.' });
      }
      onChange?.();
    } catch (err: any) {
      console.error('[KunalAI] rescan failed:', err);
      showToast({ type: 'error', title: 'AI relevance classifier failed', message: err?.message || 'unknown' });
    } finally {
      setAnalyzingBatch(false);
    }
  };

  // Backward-compat alias for the existing button handlers. force=true → Rescan,
  // force=false → Refresh (in current list mode).
  const runScan = async (force = false) => {
    if (force) await rescanAll();
    else if (listMode === 'queue') await refreshQueue();
    else await refreshMailbox();
  };

  // Auto-mailbox: on mount, hydrate any persisted reviews then trigger a Gmail
  // fetch to pick up new messages. Skipping already-scanned messageIds is done
  // in autoScanKunalInbox().
  useEffect(() => {
    let cancelled = false;
    const init = async () => {
      // 1. Pre-fill the AI Queue tab from persisted reviews so the toggle is
      //    populated even before the user switches to it.
      try {
        const persisted = await getRecentReviews(200);
        if (!cancelled && persisted.length > 0) {
          setQueueRows(persisted.map(p => hydrateReviewAsRow(p, null)));
        }
      } catch { /* non-critical */ }
      // 2. Load the live Gmail inbox (mailbox-first). No LLM here — Kunal
      //    explicitly clicks Analyze / Rescan to classify.
      if (!cancelled) await refreshMailbox();
    };
    init();
    return () => { cancelled = true; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Reload the correct source whenever the user flips the list mode toggle.
  useEffect(() => {
    if (!autoLoaded) return;
    if (listMode === 'mailbox') refreshMailbox().catch(() => {});
    else refreshQueue().catch(() => {});
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [listMode]);

  const runAnalyze = async () => {
    if (!selected) return;
    setAnalyzingId(selected.messageId);
    setExtractionRows([]);
    try {
      if (selected.aiType === 'India Price Received' || selected.aiType === 'Alternative Source / Not Available') {
        const extracted = await analyzeIndiaPriceEmail(selected);
        setExtractionRows(extracted);
        if (extracted.length === 0) {
          showToast({ type: 'info', title: 'No rows extracted', message: 'No India price rows found in this email.' });
        }
      } else {
        showToast({ type: 'info', title: 'No price to extract', message: 'This email is not classified as a price reply.' });
      }
    } catch (err: any) {
      showToast({ type: 'error', title: 'Analyze failed', message: err?.message || 'Could not analyze email.' });
    } finally {
      setAnalyzingId(null);
    }
  };

  // Part 2: one-click "Create new inquiry" from an unmatched email. Hands the
  // extracted fields to CRM as a prefilled New Inquiry form (no silent writes —
  // the user reviews and saves there).
  const createNewInquiry = () => {
    if (!selected) return;
    const emailMatch = (selected.from || '').match(/<([^>]+)>/) || (selected.from || '').match(/[\w.+-]+@[\w.-]+\.\w+/);
    const contactEmail = emailMatch ? (emailMatch[1] || emailMatch[0]) : '';
    const prefill = {
      product_name: selected.product || '',
      mail_subject: selected.subject || '',
      aceerp_no: selected.aceerpNo || '',
      supplier_name: selected.make || '',
      contact_email: contactEmail,
      inquiry_source: 'email',
      pipeline_status: 'new',
      remarks: selected.subject ? `Created from AI Pricing email: ${selected.subject}`.slice(0, 300) : '',
    };
    setNavigationData({ crmCreateInquiry: prefill });
    setCurrentPage('crm');
    showToast({ type: 'info', title: 'Create inquiry', message: 'Opening a prefilled New Inquiry form in CRM.' });
  };

  const markNoAction = async () => {
    if (!selected) return;
    setRows(prev => prev.map(r => r.messageId === selected.messageId ? { ...r, reviewed: true, aiType: 'No Action' } : r));
    try {
      await updateReviewStatus(selected.messageId, 'no_action');
      onChange?.();
    } catch { /* non-critical */ }
    showToast({ type: 'info', title: 'Marked as No Action', message: 'Email will not be processed.' });
  };

  const updateExtractionRow = (idx: number, patch: Partial<IndiaExtractionRow>) => {
    setExtractionRows(prev => prev.map((r, i) => i === idx ? { ...r, ...patch } : r));
  };

  const reLinkExtractionRow = async (idx: number, hint: { inquiry_number?: string; aceerp_no?: string; product_name?: string }) => {
    const candidates = await findInquiryCandidates(hint);
    updateExtractionRow(idx, { candidates, selectedInquiryId: candidates[0]?.id || null, needsManualLink: !candidates[0] });
  };

  const handleManualSearch = async (idx: number) => {
    const text = (manualSearchText[idx] || '').trim();
    if (!text) return;
    setManualSearching(prev => ({ ...prev, [idx]: true }));
    try {
      await reLinkExtractionRow(idx, { inquiry_number: text });
      // If candidates were found, dismiss the manual search panel so the user sees the dropdown
      setExtractionRows(prev => {
        const found = prev[idx]?.candidates?.length > 0;
        if (found) setShowManualSearch(p => ({ ...p, [idx]: false }));
        return prev;
      });
    } finally {
      setManualSearching(prev => ({ ...prev, [idx]: false }));
    }
  };

  const confirmSaveExtraction = async () => {
    if (!isManager || !selected || extractionRows.length === 0) return;
    setSavingExtraction(true);
    let saved = 0;
    const next = [...extractionRows];
    for (let i = 0; i < next.length; i += 1) {
      const row = next[i];
      if (row.saved || !row.selectedInquiryId || !row.product_name.trim()) continue;
      const result = await saveIndiaPriceExtraction(row, {
        actorId: profile?.id || null,
        gmailMessageId: selected.messageId,
        gmailThreadId: selected.threadId,
      });
      if (result.ok) {
        next[i] = { ...row, saved: true, saveError: null };
        saved += 1;
      } else {
        next[i] = { ...row, saveError: result.error || 'Save failed' };
      }
    }
    setExtractionRows(next);
    setSavingExtraction(false);
    if (saved > 0) {
      // Find which inquiries were saved to
      const savedInquiries = [...new Set(
        next.filter(r => r.saved).map(r => {
          const c = r.candidates.find(x => x.id === r.selectedInquiryId);
          return c?.inquiry_number || r.selectedInquiryId?.slice(0, 8) || '?';
        })
      )];
      setRows(prev => prev.map(r => r.messageId === selected.messageId
        ? { ...r, reviewed: true, selectedInquiryId: next.find(x => x.saved)?.selectedInquiryId || r.selectedInquiryId }
        : r));
      const firstSaved = next.find(r => r.saved);
      try {
        await updateReviewStatus(selected.messageId, 'price_saved', {
          matched_inquiry_id: firstSaved?.selectedInquiryId || null,
          source_price: firstSaved?.source_price ?? null,
          source_currency: firstSaved?.source_currency || null,
          offered_make: firstSaved?.offered_make || null,
        });
      } catch { /* non-critical */ }
      showToast({
        type: 'success',
        title: 'Saved',
        message: `Saved source option to ${savedInquiries.join(', ')}. ${saved} row${saved === 1 ? '' : 's'} total.`,
      });
      onChange?.();
    }
  };

  const saveAttachmentAsDoc = async (att: { filename: string; mimeType: string; size: number; attachmentId: string }, docType: DocType) => {
    if (!isManager || !selected) return;
    const inquiryId = selected.selectedInquiryId;
    if (!inquiryId) {
      showToast({ type: 'error', title: 'No inquiry linked', message: 'Match this email to an inquiry first.' });
      return;
    }
    setSavingDocId(att.attachmentId);
    const result = await saveIndiaDocument({
      messageId: selected.messageId,
      threadId: selected.threadId,
      attachmentId: att.attachmentId,
      originalFileName: att.filename,
      mimeType: att.mimeType,
      inquiryId,
      productName: selected.product || selected.subject,
      make: selected.make,
      documentType: docType,
      sourceEmailSubject: selected.subject,
    });
    setSavingDocId(null);
    if (result.ok) {
      try {
        await updateReviewStatus(selected.messageId, 'document_saved', {
          matched_inquiry_id: selected.selectedInquiryId,
        });
      } catch { /* non-critical */ }
      setRows(prev => prev.map(r => r.messageId === selected.messageId ? { ...r, reviewed: true } : r));
      showToast({ type: 'success', title: 'Document saved', message: `${att.filename} linked to inquiry.` });
      setSavePrompt(null);
      onChange?.();
    } else {
      showToast({ type: 'error', title: 'Save failed', message: result.error || 'Could not save document.' });
    }
  };

  const handleViewAttachment = async (att: AttachmentMeta) => {
    if (!selected) return;
    setViewer({ attachment: att, url: '', loading: true });
    const result = await fetchAttachmentBlob({
      messageId: selected.messageId,
      attachmentId: att.attachmentId,
      filename: att.filename,
      mimeType: att.mimeType,
      disposition: 'inline',
    });
    if (!result.ok || !result.url) {
      setViewer(null);
      showToast({ type: 'error', title: 'Preview failed', message: result.error || 'Could not load attachment.' });
      return;
    }
    setViewer({ attachment: att, url: result.url, loading: false });
  };

  const handleDownloadAttachment = async (att: AttachmentMeta) => {
    if (!selected) return;
    setDownloadingId(att.attachmentId);
    const result = await fetchAttachmentBlob({
      messageId: selected.messageId,
      attachmentId: att.attachmentId,
      filename: att.filename,
      mimeType: att.mimeType,
      disposition: 'attachment',
    });
    setDownloadingId(null);
    if (!result.ok || !result.url) {
      showToast({ type: 'error', title: 'Download failed', message: result.error || 'Could not download attachment.' });
      return;
    }
    // Trigger browser download via temporary anchor
    const a = document.createElement('a');
    a.href = result.url;
    a.download = att.filename;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    setTimeout(() => URL.revokeObjectURL(result.url!), 5000);
  };

  const closeViewer = () => {
    if (viewer?.url) URL.revokeObjectURL(viewer.url);
    setViewer(null);
  };

  return (
    <div className="space-y-3">
      {/* Scan controls */}
      <div className="bg-white border border-gray-200 rounded-xl p-3">
        <div className="flex items-center gap-2 flex-wrap">
          {/* Mailbox vs AI Queue toggle */}
          <div className="inline-flex rounded border border-gray-200 overflow-hidden text-[11px]">
            <button
              onClick={() => setListMode('mailbox')}
              className={`px-2 py-1.5 ${listMode === 'mailbox' ? 'bg-blue-600 text-white' : 'bg-white text-gray-700 hover:bg-gray-50'}`}
              title="Show live Gmail inbox messages joined with AI status"
            >
              Mailbox
            </button>
            <button
              onClick={() => setListMode('queue')}
              className={`px-2 py-1.5 border-l border-gray-200 ${listMode === 'queue' ? 'bg-blue-600 text-white' : 'bg-white text-gray-700 hover:bg-gray-50'}`}
              title="Show only persisted AI review rows"
            >
              AI Queue
            </button>
          </div>
          <div className="relative flex-1 min-w-[220px]">
            <Search className="w-3.5 h-3.5 text-gray-400 absolute left-2.5 top-1/2 -translate-y-1/2" />
            <input
              value={query}
              onChange={e => setQuery(e.target.value)}
              placeholder={listMode === 'mailbox' ? 'Gmail search query (default: in:inbox)' : 'Filter queue (search-only in this mode)'}
              className="w-full border border-gray-300 rounded pl-8 pr-2 py-1.5 text-xs"
            />
          </div>
          <select
            value={maxResults}
            onChange={e => setMaxResults(parseInt(e.target.value))}
            className="border border-gray-300 rounded px-2 py-1.5 text-xs"
          >
            <option value={25}>25 emails</option>
            <option value={50}>50 emails</option>
            <option value={100}>100 emails</option>
          </select>
          <button
            onClick={() => runScan(false)}
            disabled={scanning}
            className="flex items-center gap-1 px-3 py-1.5 text-xs bg-blue-600 text-white rounded hover:bg-blue-700 disabled:opacity-50"
            title={listMode === 'mailbox' ? 'Reload the live Gmail inbox' : 'Reload persisted AI review rows'}
          >
            {scanning ? <Loader className="w-3.5 h-3.5 animate-spin" /> : <RefreshCw className="w-3.5 h-3.5" />}
            {scanning ? 'Loading…' : 'Refresh Gmail'}
          </button>
          <button
            onClick={() => runScan(true)}
            disabled={scanning || analyzingBatch}
            className="flex items-center gap-1 px-3 py-1.5 text-xs border border-gray-300 rounded hover:bg-gray-50 disabled:opacity-50"
            title="Run the LLM relevance judge on every visible Unanalyzed email + clean up historically mis-tagged rows"
          >
            {analyzingBatch ? <Loader className="w-3.5 h-3.5 animate-spin" /> : null}
            Rescan All
          </button>
        </div>
        <div className="text-[10px] text-gray-500 mt-1">
          {listMode === 'mailbox'
            ? 'Mailbox shows the live Gmail inbox joined with AI status. Click Analyze This Email or Rescan All to classify.'
            : 'AI Queue shows only persisted AI review rows.'}
        </div>
        {scanError && (
          <div className="mt-2 flex items-center gap-2 text-xs text-red-700 bg-red-50 border border-red-200 rounded p-2">
            <AlertTriangle className="w-3.5 h-3.5" />
            {scanError}
          </div>
        )}
      </div>

      {/* Extraction queue + Email reader split */}
      <div className="grid grid-cols-1 lg:grid-cols-3 gap-3">
        {/* Left: Queue */}
        <div className="lg:col-span-1 bg-white border border-gray-200 rounded-xl p-2 max-h-[72vh] overflow-auto">
          {activeBucket && (
            <div className="mb-2 flex items-center justify-between gap-2 bg-blue-50 border border-blue-200 rounded px-2 py-1.5">
              <div className="text-[11px] text-blue-800 truncate">
                <span className="text-blue-500">Tracker filter:</span>{' '}
                <strong>{BUCKET_LABELS[activeBucket]}</strong>{' '}
                <span className="text-blue-500">({filteredRows.length})</span>
              </div>
              {onClearBucket && (
                <button onClick={onClearBucket} className="text-[11px] text-blue-700 hover:underline whitespace-nowrap">
                  Clear
                </button>
              )}
            </div>
          )}
          <div className="flex items-center gap-2 mb-2">
            <input
              value={search}
              onChange={e => setSearch(e.target.value)}
              placeholder="Filter…"
              className="flex-1 border border-gray-300 rounded px-2 py-1 text-xs"
            />
            <select
              value={typeFilter}
              onChange={e => setTypeFilter(e.target.value as FilterKey)}
              disabled={!!activeBucket}
              title={activeBucket ? 'Clear the tracker filter to use type chips' : ''}
              className="border border-gray-300 rounded px-2 py-1 text-xs disabled:opacity-50"
            >
              {TYPE_FILTERS.map(t => <option key={t.key} value={t.key}>{t.label}</option>)}
            </select>
          </div>
          {!activeBucket && (
            <div className="text-[10px] text-gray-500 mb-1.5">
              Showing <strong>{filteredRows.length}</strong> of {rows.length} • {typeFilter === 'actionable' ? 'No Action items hidden — switch to All or No Action to view' : ''}
            </div>
          )}
          {filteredRows.length === 0 ? (
            <div className="text-xs text-gray-500 p-3">
              {scanning && rows.length === 0 ? 'Loading mailbox…' : rows.length === 0 ? 'No emails in queue yet. Click Refresh Gmail.' : 'No emails match current filter.'}
            </div>
          ) : (
            <div className="space-y-1">
              {filteredRows.map(r => {
                const isActive = selectedId === r.messageId;
                const showNeedsLink = r.needsManualLink && !isNoAction(r);
                const badgeClass = !r.analyzed
                  ? 'bg-gray-100 text-gray-700 border-gray-200'
                  : AI_TYPE_BADGE[r.aiType];
                const badgeText = !r.analyzed ? 'Unanalyzed' : r.aiType;
                return (
                  <button
                    key={r.messageId}
                    onClick={() => { setSelectedId(r.messageId); setExtractionRows([]); }}
                    className={`w-full text-left p-2 rounded border ${isActive ? 'border-blue-500 bg-blue-50' : 'border-gray-200 hover:bg-gray-50'}`}
                  >
                    <div className="flex items-center justify-between gap-1">
                      <span className={`inline-flex px-1.5 py-0.5 rounded text-[10px] font-medium border ${badgeClass}`}>
                        {badgeText}
                      </span>
                      {r.reviewed && <CheckCircle2 className="w-3 h-3 text-green-600" />}
                    </div>
                    <div className="text-xs font-medium text-gray-800 truncate mt-1">{r.subject}</div>
                    {r.product && (
                      <div className="text-[10px] text-blue-700 truncate mt-0.5">{r.product}</div>
                    )}
                    <div className="text-[10px] text-gray-500 truncate">{r.from}</div>
                    <div className="flex items-center justify-between mt-1">
                      <span className="text-[10px] text-gray-400">
                        {r.selectedInquiryId
                          ? `✓ ${r.candidates.find(c => c.id === r.selectedInquiryId)?.inquiry_number || r.matchedInquiryNumber || '-'}`
                          : r.matchedInquiryNumber
                            ? `→ ${r.matchedInquiryNumber}`
                            : (showNeedsLink ? 'Needs Manual Link' : '-')}
                      </span>
                      <span className="text-[10px] text-gray-400">
                        {r.analyzed ? `conf ${(r.confidence * 100).toFixed(0)}%` : ''}
                      </span>
                    </div>
                  </button>
                );
              })}
            </div>
          )}
        </div>

        {/* Right: Reader */}
        <div className="lg:col-span-2 bg-white border border-gray-200 rounded-xl p-3 max-h-[72vh] overflow-auto">
          {!selected ? (
            <div className="text-xs text-gray-500">
              {activeBucket && filteredRows.length === 0
                ? `No emails in this bucket — ${BUCKET_LABELS[activeBucket]}.`
                : 'Select an email from the queue.'}
            </div>
          ) : (
            <>
              {/* Header — Gmail-style envelope: Subject, From, To, Cc, Date */}
              <div className="flex items-start justify-between gap-2 mb-2">
                <div className="flex-1 min-w-0">
                  <h3 className="text-sm font-semibold text-gray-900 truncate" title={selected.subject}>{selected.subject}</h3>
                  <div className="mt-1 grid grid-cols-[44px_1fr] gap-x-2 gap-y-0.5 text-[11px] text-gray-700">
                    <span className="text-gray-400">From:</span>
                    <span className="truncate" title={selected.from}>{selected.from || '-'}</span>
                    <span className="text-gray-400">To:</span>
                    <span className="truncate" title={selected.to || ''}>{selected.to || '-'}</span>
                    {selected.cc && (
                      <>
                        <span className="text-gray-400">Cc:</span>
                        <span className="truncate" title={selected.cc}>{selected.cc}</span>
                      </>
                    )}
                    <span className="text-gray-400">Date:</span>
                    <span className="truncate">{selected.date || '-'}</span>
                    {selected.hasAttachments && (
                      <>
                        <span className="text-gray-400">Files:</span>
                        <span className="truncate">{(selected.attachments?.length ?? 0)} attachment{(selected.attachments?.length ?? 0) === 1 ? '' : 's'}</span>
                      </>
                    )}
                  </div>
                  {/* AI status row — completely separate from envelope. Hides
                      Needs Manual Link for No Action rows so we never show
                      the contradiction the user reported. */}
                  <div className="mt-2 flex items-center gap-2 flex-wrap">
                    <span className="text-[10px] text-gray-400 uppercase tracking-wide">AI Status</span>
                    <span className={`inline-flex px-2 py-0.5 rounded text-[10px] font-medium border ${selected.analyzed ? AI_TYPE_BADGE[selected.aiType] : 'bg-gray-100 text-gray-700 border-gray-200'}`}>
                      {selected.analyzed ? selected.aiType : 'Unanalyzed'}
                    </span>
                    {!selected.analyzed && analyzingBatch && (
                      <span className="inline-flex items-center gap-1 text-[10px] text-blue-600 font-medium">
                        <Loader className="w-3 h-3 animate-spin" /> Auto-analyzing on open…
                      </span>
                    )}
                    {selected.analyzed && (
                      <span className="text-[10px] text-gray-500">
                        Confidence <span className="font-semibold text-gray-700">{Math.round((selected.confidence || 0) * 100)}%</span>
                      </span>
                    )}
                    {!isNoAction(selected) && selected.analyzed && (
                      <span className="text-[10px] text-gray-500">
                        {selected.selectedInquiryId
                          ? <>Inquiry: <span className="text-green-700 font-semibold">{selected.candidates.find(c => c.id === selected.selectedInquiryId)?.inquiry_number || selected.matchedInquiryNumber}</span></>
                          : selected.matchedInquiryNumber
                            ? <>Suggested: <span className="text-blue-600">{selected.matchedInquiryNumber}</span></>
                            : <span className="text-amber-600 font-semibold">Needs Manual Link</span>
                        }
                      </span>
                    )}
                    {isNoAction(selected) && (
                      <span className="text-[10px] text-gray-500 italic">No inquiry needed.</span>
                    )}
                  </div>
                </div>
                <div className="flex items-center gap-1 flex-shrink-0 flex-wrap justify-end">
                  <button
                    onClick={() => void analyzeOne()}
                    disabled={!isManager || analyzingBatch}
                    className="flex items-center gap-1 px-2 py-1 text-xs bg-blue-600 text-white rounded hover:bg-blue-700 disabled:opacity-50"
                    title="Run the LLM relevance judge on this email and create/update its review row"
                  >
                    {analyzingBatch ? <Loader className="w-3 h-3 animate-spin" /> : <Search className="w-3 h-3" />}
                    Analyze This Email
                  </button>
                  {selected.analyzed && (selected.aiType === 'India Price Received' || selected.aiType === 'Alternative Source / Not Available') && (
                    <button
                      onClick={runAnalyze}
                      disabled={!isManager || analyzingId === selected.messageId}
                      className="flex items-center gap-1 px-2 py-1 text-xs border border-blue-200 bg-blue-50 text-blue-700 rounded hover:bg-blue-100 disabled:opacity-50"
                      title="Run the price-row extractor and let you review/save India price options"
                    >
                      {analyzingId === selected.messageId ? <Loader className="w-3 h-3 animate-spin" /> : null}
                      Extract Price Rows
                    </button>
                  )}
                  <button
                    onClick={markNoAction}
                    disabled={!isManager}
                    className="flex items-center gap-1 px-2 py-1 text-xs border border-gray-300 rounded hover:bg-gray-50 disabled:opacity-50"
                  >
                    <X className="w-3 h-3" /> Mark No Action
                  </button>
                </div>
              </div>

              {/* Suggested action + AI-extracted fields (surfaced on open) */}
              <div className="text-xs text-gray-700 bg-gray-50 border border-gray-200 rounded p-2 mb-2">
                <strong>Suggested:</strong> {selected.suggestedAction}
                {selected.summary && <div className="text-[11px] text-gray-500 mt-1">{selected.summary}</div>}
                {selected.analyzed && (selected.product || selected.make || selected.documentType) && (
                  <div className="flex flex-wrap gap-1.5 mt-1.5">
                    {selected.product && (
                      <span className="inline-flex items-center px-1.5 py-0.5 rounded text-[10px] bg-white border border-gray-200 text-gray-700">
                        Product: <span className="font-semibold ml-1">{selected.product}</span>
                      </span>
                    )}
                    {selected.make && (
                      <span className="inline-flex items-center px-1.5 py-0.5 rounded text-[10px] bg-white border border-gray-200 text-gray-700">
                        Make: <span className="font-semibold ml-1">{selected.make}</span>
                      </span>
                    )}
                    {selected.documentType && (
                      <span className="inline-flex items-center px-1.5 py-0.5 rounded text-[10px] bg-indigo-50 border border-indigo-200 text-indigo-700">
                        Doc: <span className="font-semibold ml-1">{selected.documentType}</span>
                      </span>
                    )}
                  </div>
                )}
                {selected.extractedQuestion && (
                  <div className="text-[11px] text-amber-700 mt-1.5 bg-amber-50 border border-amber-200 rounded p-1.5">
                    <strong>Question to answer:</strong> {selected.extractedQuestion}
                  </div>
                )}
              </div>

              {/* Full email body */}
              <div className="mb-3">
                <div className="flex items-center justify-between mb-1">
                  <div className="text-[11px] text-gray-500">Full Email Body</div>
                  <div className="flex items-center gap-2">
                    {/* Fallback for the iframe's non-clickable blue "..." trail
                        toggle — open the full quoted thread outside the iframe.
                        Visible whenever we have either thread_messages OR a
                        plain-text body with quoted content. */}
                    {((selected.threadMessages && selected.threadMessages.length > 1) || selected.bodyText || selected.body) && (
                      <button
                        onClick={() => setShowFullTrail(v => !v)}
                        className="text-[10px] px-2 py-0.5 border border-gray-300 rounded text-gray-700 hover:bg-gray-50"
                        title="Reveal the quoted / forwarded previous messages in this thread"
                      >
                        {showFullTrail ? 'Hide full email trail' : 'Show full email trail'}
                      </button>
                    )}
                    {selected.bodyHtml ? (
                      <div className="inline-flex rounded border border-gray-200 overflow-hidden text-[10px]">
                        <button
                          onClick={() => setViewMode('rich')}
                          className={`px-2 py-0.5 ${viewMode === 'rich' ? 'bg-blue-600 text-white' : 'bg-white text-gray-600 hover:bg-gray-50'}`}
                        >
                          Rich View
                        </button>
                        <button
                          onClick={() => setViewMode('plain')}
                          className={`px-2 py-0.5 ${viewMode === 'plain' ? 'bg-blue-600 text-white' : 'bg-white text-gray-600 hover:bg-gray-50'}`}
                        >
                          Plain Text
                        </button>
                      </div>
                    ) : (
                      <span className="text-[10px] text-gray-400">Plain text only</span>
                    )}
                  </div>
                </div>
                {viewMode === 'rich' && selected.bodyHtml ? (
                  <div className="bg-white border border-gray-200 rounded overflow-hidden">
                    <EmailBodyViewer htmlContent={selected.bodyHtml} className="max-h-[400px]" />
                  </div>
                ) : (
                  <pre className="whitespace-pre-wrap text-xs text-gray-800 font-sans bg-white border border-gray-200 rounded p-2 max-h-[260px] overflow-auto">
                    {selected.bodyText || selected.body || selected.snippet || '(no body)'}
                  </pre>
                )}
                {/* Email-trail fallback panel — renders the full quoted thread
                    outside the iframe so the user always has a way to read
                    previous messages even if the iframe quote toggle can't
                    fire. Uses thread_messages (preferred) or falls back to the
                    plain-text body, which on most Gmail messages already
                    contains the inline quoted thread. */}
                {showFullTrail && (
                  <div className="mt-2 border border-blue-200 rounded bg-blue-50/40 p-2">
                    <div className="text-[10px] font-semibold text-blue-700 mb-1 uppercase tracking-wide">
                      Full email trail
                    </div>
                    {selected.threadMessages && selected.threadMessages.length > 1 ? (
                      <div className="space-y-2 max-h-[400px] overflow-auto">
                        {selected.threadMessages.map((tm, i) => (
                          <div key={tm.messageId || i} className="border border-blue-100 rounded bg-white p-2">
                            <div className="text-[10px] text-gray-600 mb-1">
                              <div><span className="font-semibold">From:</span> {tm.from || '(unknown)'}</div>
                              {tm.to && <div><span className="font-semibold">To:</span> {tm.to}</div>}
                              {tm.cc && <div><span className="font-semibold">Cc:</span> {tm.cc}</div>}
                              <div><span className="font-semibold">Date:</span> {tm.date || '-'}</div>
                              <div><span className="font-semibold">Subject:</span> {tm.subject || '-'}</div>
                            </div>
                            <pre className="whitespace-pre-wrap text-[11px] text-gray-800 font-sans bg-gray-50 border border-gray-200 rounded p-2 max-h-[240px] overflow-auto">
                              {tm.bodyText || tm.body || tm.snippet || '(no body)'}
                            </pre>
                          </div>
                        ))}
                      </div>
                    ) : (
                      <pre className="whitespace-pre-wrap text-xs text-gray-800 font-sans bg-white border border-blue-100 rounded p-2 max-h-[400px] overflow-auto">
                        {selected.bodyText || selected.body || selected.snippet || '(no body)'}
                      </pre>
                    )}
                  </div>
                )}
              </div>

              {/* Attachments — View / Download / Save to CRM */}
              {selected.attachments && selected.attachments.length > 0 && (
                <div className="mb-3">
                  <div className="text-[11px] text-gray-500 mb-1 flex items-center gap-1"><Paperclip className="w-3 h-3" />Attachments</div>
                  <div className="text-[10px] text-gray-500 mb-1.5 italic">
                    View lets you read the attachment. Extract &amp; Save links it to the inquiry/product with the detected document type.
                  </div>
                  <div className="space-y-1">
                    {selected.attachments.map(att => {
                      const isDownloading = downloadingId === att.attachmentId;
                      const isSaving = savingDocId === att.attachmentId;
                      // Part 3: show the detected doc-type BEFORE extraction so the
                      // user sees the AI's guess and can override it.
                      const detected = detectAttachmentDocType(att.filename, selected.documentType);
                      return (
                        <div key={att.attachmentId} className="flex items-center gap-2 border border-gray-200 rounded p-2">
                          <FileText className="w-3.5 h-3.5 text-gray-400 flex-shrink-0" />
                          <div className="flex-1 min-w-0">
                            <div className="text-xs font-medium text-gray-800 truncate">{att.filename}</div>
                            <div className="text-[10px] text-gray-500 flex items-center gap-1.5 flex-wrap">
                              <span>{att.mimeType} • {Math.round(att.size / 1024)} KB</span>
                              <span
                                className="inline-flex items-center px-1.5 py-0.5 rounded bg-indigo-50 text-indigo-700 border border-indigo-200 font-medium"
                                title={`${DOC_TYPE_LABELS[detected.docType]} — detected from ${detected.source === 'ai' ? 'AI email classification' : detected.source === 'filename' ? 'the file name' : 'default (no strong signal)'}. Use "Change type…" to override.`}
                              >
                                {detected.docType}{detected.source !== 'default' ? ' · detected' : ''}
                              </span>
                            </div>
                          </div>
                          <button
                            onClick={() => handleViewAttachment(att)}
                            className="inline-flex items-center gap-1 px-2 py-1 text-[10px] border border-gray-300 rounded hover:bg-gray-50"
                            title="Preview without saving"
                          >
                            <Eye className="w-3 h-3" /> View
                          </button>
                          <button
                            onClick={() => handleDownloadAttachment(att)}
                            disabled={isDownloading}
                            className="inline-flex items-center gap-1 px-2 py-1 text-[10px] border border-gray-300 rounded hover:bg-gray-50 disabled:opacity-50"
                            title="Download original file"
                          >
                            {isDownloading ? <Loader className="w-3 h-3 animate-spin" /> : <Download className="w-3 h-3" />}
                            Download
                          </button>
                          <button
                            onClick={() => saveAttachmentAsDoc(att, detected.docType)}
                            disabled={!isManager || isSaving || !selected.selectedInquiryId}
                            className="inline-flex items-center gap-1 px-2 py-1 text-[10px] bg-blue-600 text-white rounded hover:bg-blue-700 disabled:opacity-50"
                            title={`Save as ${DOC_TYPE_LABELS[detected.docType]} and link to the inquiry in one click`}
                          >
                            {isSaving ? <Loader className="w-3 h-3 animate-spin" /> : <FolderPlus className="w-3 h-3" />}
                            Extract & Save
                          </button>
                          <button
                            onClick={() => setSavePrompt({ attachment: att, docType: detected.docType })}
                            disabled={!isManager || isSaving || !selected.selectedInquiryId}
                            className="inline-flex items-center gap-1 px-2 py-1 text-[10px] border border-gray-300 rounded hover:bg-gray-50 disabled:opacity-50"
                            title="Choose a different document type before saving"
                          >
                            Change type…
                          </button>
                        </div>
                      );
                    })}
                  </div>
                  {!selected.selectedInquiryId && (
                    <div className="text-[10px] text-amber-700 mt-1">Match this email to an inquiry below before saving to CRM.</div>
                  )}
                </div>
              )}

              {/* Inquiry linker — hidden entirely for No Action and Unanalyzed
                  rows so we never show the matched-inquiry warning that
                  contradicts a No Action AI status. */}
              {selected.analyzed && !isNoAction(selected) && (
              <div className="mb-3 border border-gray-200 rounded p-2">
                <div className="flex items-center justify-between mb-1">
                  <div className="text-[11px] text-gray-500">Confirm Inquiry</div>
                  {!selected.selectedInquiryId && selected.candidates.length > 0 && (
                    <span className="text-[10px] text-amber-600 font-medium">Select inquiry below</span>
                  )}
                  {selected.selectedInquiryId && (
                    <span className="text-[10px] text-green-600 font-medium">Inquiry confirmed</span>
                  )}
                </div>
                {/* Part 8 — reversible auto-link banner. AI linked a clear-winner
                    inquiry automatically; user can Undo to pick manually. */}
                {selected.autoLinked && selected.selectedInquiryId && (
                  <div className="mb-2 flex items-center justify-between gap-2 p-1.5 rounded border border-blue-300 bg-blue-50 text-[10px] text-blue-800">
                    <span className="flex items-center gap-1.5">
                      <Sparkles className="w-3 h-3 flex-shrink-0" />
                      Auto-linked to <span className="font-semibold">{selected.candidates.find(c => c.id === selected.selectedInquiryId)?.inquiry_number || selected.matchedInquiryNumber}</span> (high confidence). Not saved yet — review before saving.
                    </span>
                    <button
                      type="button"
                      onClick={async () => {
                        setRows(prev => prev.map(r => r.messageId === selected.messageId
                          ? { ...r, selectedInquiryId: null, autoLinked: false, needsManualLink: r.candidates.length === 0 }
                          : r));
                        try {
                          await updateReviewStatus(selected.messageId, 'pending_review', { matched_inquiry_id: null });
                          onChange?.();
                        } catch { /* non-critical */ }
                      }}
                      className="px-1.5 py-0.5 rounded border border-blue-300 bg-white text-blue-700 hover:bg-blue-100 font-medium whitespace-nowrap"
                    >
                      Undo
                    </button>
                  </div>
                )}
                {selected.candidates.length === 0 ? (
                  <div className="space-y-2">
                    <div className="text-xs text-amber-700">No matching inquiry found for this email.</div>
                    <button
                      type="button"
                      onClick={createNewInquiry}
                      className="inline-flex items-center gap-1.5 px-2.5 py-1.5 text-[11px] font-medium bg-emerald-600 text-white rounded hover:bg-emerald-700"
                      title="Open a prefilled New Inquiry form in CRM using this email's product, subject and sender"
                    >
                      <FolderPlus className="w-3.5 h-3.5" /> Create new inquiry from this email
                    </button>
                    <div className="text-[10px] text-gray-500">
                      Prefills product{selected.product ? ` “${selected.product}”` : ''}, subject and sender. You review &amp; save in CRM.
                    </div>
                  </div>
                ) : (
                  <>
                    {/* Safety warning — multiple similar active inquiries */}
                    {selected.hasMultipleSimilarCandidates && (
                      <div className="mb-2 flex items-center gap-1.5 p-1.5 rounded border border-amber-300 bg-amber-50 text-[10px] text-amber-800">
                        <AlertTriangle className="w-3 h-3 flex-shrink-0" />
                        Multiple similar active inquiries found. Confirm the correct one.
                      </div>
                    )}
                    {/* Candidate cards — up to 5, score >= 0.25 */}
                    <div className="space-y-1.5">
                      {selected.candidates.slice(0, 5).filter(c => c.score >= 0.20).map(c => {
                        const scorePct = Math.round(c.score * 100);
                        const isSuggested = c.id === selected.suggestedInquiryId;
                        const isSelected = c.id === selected.selectedInquiryId;
                        const hasSubject = c.email_subject || c.mail_subject;
                        const borderClass = isSelected
                          ? 'border-blue-500 bg-blue-50 ring-1 ring-blue-500'
                          : isSuggested
                            ? 'border-green-300 bg-green-50/60'
                            : 'border-gray-200 bg-white';
                        return (
                          <button
                            key={c.id}
                            type="button"
                            onClick={async () => {
                              const newId = c.id;
                              setRows(prev => prev.map(r => r.messageId === selected.messageId
                                ? { ...r, selectedInquiryId: newId, autoLinked: false, matchedInquiryNumber: newId ? r.candidates.find(x => x.id === newId)?.inquiry_number || null : null, needsManualLink: false }
                                : r));
                              try {
                                await updateReviewStatus(selected.messageId, 'pending_review', { matched_inquiry_id: newId });
                                onChange?.();
                              } catch { /* non-critical */ }
                            }}
                            className={`w-full text-left p-2 rounded border ${borderClass} hover:border-blue-400 transition-colors`}
                          >
                            <div className="flex items-start justify-between gap-2">
                              <div className="flex-1 min-w-0">
                                <div className="flex items-center gap-1.5 flex-wrap">
                                  <span className="text-xs font-semibold text-gray-800">{c.inquiry_number}</span>
                                  <span className="text-[11px] text-gray-600">· {c.product_name}</span>
                                  {isSuggested && (
                                    <span className="inline-flex px-1 py-0.5 rounded text-[9px] font-bold bg-green-600 text-white">Suggested</span>
                                  )}
                                  {isSelected && (
                                    <span className="inline-flex px-1 py-0.5 rounded text-[9px] font-bold bg-blue-600 text-white">Selected</span>
                                  )}
                                </div>
                                <div className="text-[10px] text-gray-600 mt-0.5">
                                  {c.company_name}
                                  {c.quantity && <span className="ml-2 text-gray-400">Qty: {c.quantity}</span>}
                                </div>
                                {c.specification && (
                                  <div className="text-[10px] text-gray-500 mt-0.5">Spec: {c.specification}</div>
                                )}
                                {hasSubject && (
                                  <div className="text-[10px] text-gray-500 mt-0.5" title={(c.email_subject || c.mail_subject || '')}>
                                    <span className="text-gray-400">Inquiry Subject:</span>{' '}
                                    <span className="italic truncate inline-block max-w-[300px] align-bottom">{c.email_subject || c.mail_subject}</span>
                                  </div>
                                )}
                                {c.mail_subject && c.email_subject && c.mail_subject !== c.email_subject && (
                                  <div className="text-[10px] text-gray-500 mt-0.5" title={c.mail_subject}>
                                    <span className="text-gray-400">Mail Subject:</span>{' '}
                                    <span className="italic truncate inline-block max-w-[300px] align-bottom">{c.mail_subject}</span>
                                  </div>
                                )}
                              </div>
                              <div className="text-right flex-shrink-0">
                                <span className={`text-[10px] font-bold px-1.5 py-0.5 rounded ${scorePct >= 75 ? 'bg-green-600 text-white' : scorePct >= 45 ? 'bg-blue-600 text-white' : 'bg-amber-600 text-white'}`}>
                                  {scorePct}%
                                </span>
                                <div className="text-[11px] leading-none mt-1 tracking-tight" title={`Match strength: ${scoreToStars(c.score)} of 5`}>
                                  <span className="text-amber-500">{'★'.repeat(scoreToStars(c.score))}</span>
                                  <span className="text-gray-300">{'★'.repeat(5 - scoreToStars(c.score))}</span>
                                </div>
                              </div>
                            </div>
                            {/* Reason chips */}
                            {c.reasons && c.reasons.length > 0 && (
                              <div className="flex flex-wrap gap-1 mt-1.5">
                                {c.reasons.map((reason, i) => (
                                  <span key={i} className="inline-flex px-1.5 py-0.5 rounded text-[9px] font-medium bg-white border border-gray-200 text-gray-700">
                                    {reason}
                                  </span>
                                ))}
                              </div>
                            )}
                            {/* Debug: raw score for top candidates */}
                            {scorePct < 75 && c.reasons && c.reasons.length <= 2 && (
                              <div className="text-[9px] text-gray-400 mt-1 italic">
                                Low confidence — verify before saving
                              </div>
                            )}
                          </button>
                        );
                      })}
                    </div>
                    {/* Show count of trimmed candidates */}
                    {selected.candidates.filter(c => c.score >= 0.20).length === 0 && selected.candidates.length > 0 && (
                      <div className="text-[10px] text-gray-400 mt-1">All candidates scored below 20% — manual link needed.</div>
                    )}
                  </>
                )}
              </div>
              )}

              {/* Extraction Review (after Analyze) */}
              {extractionRows.length > 0 && (
                <div className="border border-blue-200 bg-blue-50/40 rounded p-2">
                  <div className="text-xs font-semibold text-blue-900 mb-2">Extracted India Price Rows — Review & Save</div>
                  <div className="space-y-2">
                    {extractionRows.map((row, idx) => (
                      <div key={idx} className={`border rounded p-2 ${row.saved ? 'border-green-300 bg-green-50' : row.needsManualLink ? 'border-amber-300 bg-amber-50' : 'border-gray-200 bg-white'}`}>
                        <div className="grid grid-cols-2 md:grid-cols-4 gap-2 text-[11px]">
                          <div className="md:col-span-2">
                            <label className="block text-[10px] text-gray-500">
                              Inquiry
                              {row.hasMultipleSimilarCandidates && (
                                <span className="ml-1 text-amber-600" title="Multiple similar active inquiries">⚠️</span>
                              )}
                            </label>
                            {row.candidates.length === 0 ? (
                              /* No AI matches — show proper search UI */
                              <div className="space-y-1">
                                <div className="flex gap-1">
                                  <input
                                    value={manualSearchText[idx] || ''}
                                    onChange={e => setManualSearchText(prev => ({ ...prev, [idx]: e.target.value }))}
                                    onKeyDown={e => { if (e.key === 'Enter') handleManualSearch(idx); }}
                                    placeholder="Inquiry no. or product name…"
                                    className="flex-1 border border-amber-300 rounded px-1 py-0.5 text-[11px] focus:outline-none focus:ring-1 focus:ring-amber-400"
                                  />
                                  <button
                                    onClick={() => handleManualSearch(idx)}
                                    disabled={manualSearching[idx] || !manualSearchText[idx]?.trim()}
                                    className="inline-flex items-center gap-0.5 px-2 py-0.5 text-[10px] bg-amber-600 text-white rounded hover:bg-amber-700 disabled:opacity-50"
                                  >
                                    {manualSearching[idx] ? <Loader className="w-3 h-3 animate-spin" /> : <Search className="w-3 h-3" />}
                                    Search
                                  </button>
                                </div>
                                <div className="text-[10px] text-amber-700">No auto-match found — search by inquiry number or product name.</div>
                              </div>
                            ) : (
                              /* Candidates found — dropdown + option to search for a different one */
                              <div className="space-y-1">
                                <select
                                  value={row.selectedInquiryId || ''}
                                  onChange={e => updateExtractionRow(idx, { selectedInquiryId: e.target.value || null, needsManualLink: !e.target.value })}
                                  className="w-full border border-gray-300 rounded px-1 py-0.5 text-[11px]"
                                >
                                  <option value="">— pick —</option>
                                  {row.candidates.map(c => {
                                    const pct = Math.round((c.score || 0) * 100);
                                    const isSuggested = c.id === row.suggestedInquiryId;
                                    return (
                                      <option key={c.id} value={c.id}>[{pct}%] {c.inquiry_number} • {c.product_name}{isSuggested ? ' ★' : ''}</option>
                                    );
                                  })}
                                </select>
                                {!showManualSearch[idx] ? (
                                  <button
                                    onClick={() => setShowManualSearch(prev => ({ ...prev, [idx]: true }))}
                                    className="text-[10px] text-blue-600 hover:underline"
                                  >
                                    🔍 Link to a different inquiry
                                  </button>
                                ) : (
                                  <div className="flex gap-1 pt-0.5">
                                    <input
                                      value={manualSearchText[idx] || ''}
                                      onChange={e => setManualSearchText(prev => ({ ...prev, [idx]: e.target.value }))}
                                      onKeyDown={e => { if (e.key === 'Enter') handleManualSearch(idx); }}
                                      placeholder="Inquiry no. or product name…"
                                      className="flex-1 border border-blue-300 rounded px-1 py-0.5 text-[11px] focus:outline-none focus:ring-1 focus:ring-blue-400"
                                      autoFocus
                                    />
                                    <button
                                      onClick={() => handleManualSearch(idx)}
                                      disabled={manualSearching[idx] || !manualSearchText[idx]?.trim()}
                                      className="inline-flex items-center gap-0.5 px-2 py-0.5 text-[10px] bg-blue-600 text-white rounded hover:bg-blue-700 disabled:opacity-50"
                                    >
                                      {manualSearching[idx] ? <Loader className="w-3 h-3 animate-spin" /> : <Search className="w-3 h-3" />}
                                    </button>
                                    <button
                                      onClick={() => setShowManualSearch(prev => ({ ...prev, [idx]: false }))}
                                      className="px-2 py-0.5 text-[10px] border border-gray-300 rounded hover:bg-gray-50"
                                    >
                                      Cancel
                                    </button>
                                  </div>
                                )}
                              </div>
                            )}
                          </div>
                          <div>
                            <label className="block text-[10px] text-gray-500">Product</label>
                            <input value={row.product_name} onChange={e => updateExtractionRow(idx, { product_name: e.target.value })}
                              className="w-full border border-gray-300 rounded px-1 py-0.5 text-[11px]" />
                          </div>
                          <div>
                            <label className="block text-[10px] text-gray-500">Offered Make</label>
                            <input value={row.offered_make || ''} onChange={e => updateExtractionRow(idx, { offered_make: e.target.value })}
                              className="w-full border border-gray-300 rounded px-1 py-0.5 text-[11px]" />
                          </div>
                          <div>
                            <label className="block text-[10px] text-gray-500">INR Price</label>
                            <MoneyInput value={row.source_price} onChange={amount => updateExtractionRow(idx, { source_price: amount || null })}
                              className="w-full border border-gray-300 rounded px-1 py-0.5 text-[11px]" maximumFractionDigits={4} />
                          </div>
                          <div>
                            <label className="block text-[10px] text-gray-500">Currency</label>
                            <select value={row.source_currency} onChange={e => updateExtractionRow(idx, { source_currency: e.target.value })}
                              className="w-full border border-gray-300 rounded px-1 py-0.5 text-[11px]">
                              {['INR', 'USD', 'CNY', 'IDR', 'EUR', 'GBP'].map(c => <option key={c}>{c}</option>)}
                            </select>
                          </div>
                          <div>
                            <label className="block text-[10px] text-gray-500">Qty / MOQ</label>
                            <input value={row.quantity || ''} onChange={e => updateExtractionRow(idx, { quantity: e.target.value })}
                              className="w-full border border-gray-300 rounded px-1 py-0.5 text-[11px]" />
                          </div>
                          <div>
                            <label className="block text-[10px] text-gray-500">Availability</label>
                            <select value={row.availability} onChange={e => updateExtractionRow(idx, { availability: e.target.value as any })}
                              className="w-full border border-gray-300 rounded px-1 py-0.5 text-[11px]">
                              <option value="available">Available</option>
                              <option value="partial">Partial</option>
                              <option value="na">NA</option>
                            </select>
                          </div>
                          <div>
                            <label className="block text-[10px] text-gray-500">Doc Status</label>
                            <select value={row.document_status} onChange={e => updateExtractionRow(idx, { document_status: e.target.value as any })}
                              className="w-full border border-gray-300 rounded px-1 py-0.5 text-[11px]">
                              <option value="pending">Pending</option>
                              <option value="received">Received</option>
                              <option value="partial">Partial</option>
                              <option value="not_required">Not Required</option>
                            </select>
                          </div>
                          <div>
                            <label className="block text-[10px] text-gray-500">Lead Time</label>
                            <input value={row.lead_time || ''} onChange={e => updateExtractionRow(idx, { lead_time: e.target.value })}
                              className="w-full border border-gray-300 rounded px-1 py-0.5 text-[11px]" />
                          </div>
                          {/* Part 4 — product/body extracted fields (editable; low-confidence rows correctable) */}
                          <div>
                            <label className="block text-[10px] text-gray-500">Grade</label>
                            <input value={row.grade || ''} onChange={e => updateExtractionRow(idx, { grade: e.target.value })}
                              placeholder="USP / BP / IP…"
                              className="w-full border border-gray-300 rounded px-1 py-0.5 text-[11px]" />
                          </div>
                          <div>
                            <label className="block text-[10px] text-gray-500">CAS No.</label>
                            <input value={row.cas || ''} onChange={e => updateExtractionRow(idx, { cas: e.target.value })}
                              placeholder="e.g. 50-00-0"
                              className="w-full border border-gray-300 rounded px-1 py-0.5 text-[11px]" />
                          </div>
                          <div>
                            <label className="block text-[10px] text-gray-500">Unit</label>
                            <input value={row.unit || ''} onChange={e => updateExtractionRow(idx, { unit: e.target.value })}
                              placeholder="kg / MT / L"
                              className="w-full border border-gray-300 rounded px-1 py-0.5 text-[11px]" />
                          </div>
                          <div>
                            <label className="block text-[10px] text-gray-500">Preferred Mfr</label>
                            <input value={row.preferred_manufacturer || ''} onChange={e => updateExtractionRow(idx, { preferred_manufacturer: e.target.value })}
                              className="w-full border border-gray-300 rounded px-1 py-0.5 text-[11px]" />
                          </div>
                          <div>
                            <label className="block text-[10px] text-gray-500">Required Origin</label>
                            <input value={row.required_origin || ''} onChange={e => updateExtractionRow(idx, { required_origin: e.target.value })}
                              placeholder="European / Germany…"
                              className="w-full border border-gray-300 rounded px-1 py-0.5 text-[11px]" />
                          </div>
                          <div className="md:col-span-3">
                            <label className="block text-[10px] text-gray-500">Specification</label>
                            <input value={row.specification || ''} onChange={e => updateExtractionRow(idx, { specification: e.target.value })}
                              placeholder="e.g. min 99%, <10 ppm heavy metals"
                              className="w-full border border-gray-300 rounded px-1 py-0.5 text-[11px]" />
                          </div>
                          <div className="md:col-span-4">
                            <label className="block text-[10px] text-gray-500">India Comments / Remark</label>
                            <input value={row.remark || ''} onChange={e => updateExtractionRow(idx, { remark: e.target.value })}
                              className="w-full border border-gray-300 rounded px-1 py-0.5 text-[11px]" />
                          </div>
                        </div>
                        <div className="flex items-center justify-between mt-2">
                          <div className="text-[10px] text-gray-500">
                            Confidence {(row.confidence * 100).toFixed(0)}%
                            {row.needsManualLink && <span className="ml-2 text-amber-700 font-semibold">Needs Manual Link</span>}
                            {row.saved && (
                              <span className="ml-2 text-green-700 font-semibold">
                                Saved to {row.candidates.find(c => c.id === row.selectedInquiryId)?.inquiry_number || row.selectedInquiryId?.slice(0, 8) || 'inquiry'}
                              </span>
                            )}
                            {row.saveError && <span className="ml-2 text-red-700">{row.saveError}</span>}
                          </div>
                          {row.raw_excerpt && (
                            <div className="text-[10px] text-gray-400 italic truncate max-w-[280px]" title={row.raw_excerpt}>
                              "{row.raw_excerpt}"
                            </div>
                          )}
                        </div>
                      </div>
                    ))}
                  </div>
                  {/* Saved status banner */}
                  {extractionRows.some(r => r.saved) && (
                    <div className="mt-2 flex items-center gap-2 p-2 rounded border border-green-300 bg-green-50">
                      <CheckCircle2 className="w-3.5 h-3.5 text-green-600 flex-shrink-0" />
                      <div className="text-[11px] text-green-800">
                        {extractionRows.filter(r => r.saved).map(r => {
                          const inqNum = r.candidates.find(c => c.id === r.selectedInquiryId)?.inquiry_number || r.selectedInquiryId?.slice(0, 8) || '?';
                          return <div key={inqNum}>Saved source option to <strong>{inqNum}</strong> — {r.product_name} {r.source_price ? `@ ${r.source_currency} ${r.source_price}` : ''}</div>;
                        })}
                      </div>
                    </div>
                  )}
                  <div className="flex items-center justify-end mt-2">
                    <button
                      onClick={confirmSaveExtraction}
                      disabled={!isManager || savingExtraction || extractionRows.every(r => r.saved || !r.selectedInquiryId)}
                      className="flex items-center gap-1 px-3 py-1.5 text-xs bg-green-600 text-white rounded hover:bg-green-700 disabled:opacity-50"
                    >
                      {savingExtraction ? <Loader className="w-3 h-3 animate-spin" /> : <Save className="w-3 h-3" />}
                      Review & Save India Price
                    </button>
                  </div>
                  <div className="text-[10px] text-gray-500 mt-1">
                    Saves to crm_inquiry_pricing_options. Source price only — Kunal still enters USD landed cost + quote price manually in the worksheet. Never auto-sends.
                  </div>
                </div>
              )}
            </>
          )}
        </div>
      </div>

      {/* Attachment Preview Modal */}
      {viewer && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 p-4" onClick={closeViewer}>
          <div className="bg-white rounded-xl shadow-2xl w-full max-w-4xl max-h-[90vh] flex flex-col" onClick={e => e.stopPropagation()}>
            <div className="flex items-center justify-between px-4 py-3 border-b border-gray-200">
              <div className="min-w-0 flex-1">
                <h3 className="text-sm font-semibold text-gray-900 truncate">{viewer.attachment.filename}</h3>
                <p className="text-[11px] text-gray-500">{viewer.attachment.mimeType} • {Math.round(viewer.attachment.size / 1024)} KB</p>
              </div>
              <div className="flex items-center gap-2">
                <button
                  onClick={() => handleDownloadAttachment(viewer.attachment)}
                  className="inline-flex items-center gap-1 px-2 py-1 text-xs border border-gray-300 rounded hover:bg-gray-50"
                >
                  <Download className="w-3 h-3" /> Download
                </button>
                <button onClick={closeViewer} className="p-1 text-gray-400 hover:text-gray-600 rounded">
                  <X className="w-5 h-5" />
                </button>
              </div>
            </div>
            <div className="flex-1 overflow-auto bg-gray-100 p-2 min-h-[400px]">
              {viewer.loading ? (
                <div className="flex items-center justify-center h-full text-sm text-gray-500">
                  <Loader className="w-5 h-5 animate-spin mr-2" /> Loading attachment…
                </div>
              ) : viewer.attachment.mimeType.startsWith('image/') ? (
                <img src={viewer.url} alt={viewer.attachment.filename} className="max-w-full max-h-full mx-auto" />
              ) : viewer.attachment.mimeType === 'application/pdf' ? (
                <iframe src={viewer.url} title={viewer.attachment.filename} className="w-full h-full min-h-[500px] bg-white" />
              ) : viewer.attachment.mimeType.startsWith('text/') ? (
                <iframe src={viewer.url} title={viewer.attachment.filename} className="w-full h-full min-h-[500px] bg-white" />
              ) : (
                <div className="flex flex-col items-center justify-center h-full text-sm text-gray-600 p-6 text-center">
                  <FileText className="w-12 h-12 text-gray-400 mb-3" />
                  <div className="font-medium">Inline preview not supported for {viewer.attachment.mimeType}</div>
                  <div className="text-xs text-gray-500 mt-1">Use Download to open the file locally.</div>
                </div>
              )}
            </div>
          </div>
        </div>
      )}

      {/* Save to CRM — document type prompt */}
      {savePrompt && selected && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4" onClick={() => setSavePrompt(null)}>
          <div className="bg-white rounded-xl shadow-2xl w-full max-w-md" onClick={e => e.stopPropagation()}>
            <div className="flex items-center justify-between px-4 py-3 border-b border-gray-200">
              <h3 className="text-sm font-semibold text-gray-900">Save to CRM</h3>
              <button onClick={() => setSavePrompt(null)} className="p-1 text-gray-400 hover:text-gray-600 rounded">
                <X className="w-4 h-4" />
              </button>
            </div>
            <div className="p-4 space-y-3">
              <div className="text-xs text-gray-600">
                <div className="font-medium text-gray-800 truncate">{savePrompt.attachment.filename}</div>
                <div className="text-[11px] text-gray-500 mt-1">Inquiry: {selected.matchedInquiryNumber || selected.selectedInquiryId}</div>
              </div>
              <div>
                <label className="block text-[11px] text-gray-600 mb-1">Document Type</label>
                <select
                  value={savePrompt.docType}
                  onChange={e => setSavePrompt({ ...savePrompt, docType: e.target.value as DocType })}
                  className="w-full border border-gray-300 rounded px-2 py-1 text-xs"
                >
                  {DOC_TYPE_OPTIONS.map(t => (
                    <option key={t} value={t}>{t} — {DOC_TYPE_LABELS[t]}</option>
                  ))}
                </select>
                {(savePrompt.docType === 'CATALOGUE' || savePrompt.docType === 'PRICE_LIST') && (
                  <div className="text-[10px] text-amber-600 mt-1">Stored as “Other” until the document-type list is expanded in the database.</div>
                )}
              </div>
              <div className="text-[10px] text-gray-500 italic">
                This will upload the file to the private crm-documents bucket and link it to the inquiry/product. Cannot be undone from here.
              </div>
            </div>
            <div className="flex items-center justify-end gap-2 px-4 py-3 border-t border-gray-200 bg-gray-50 rounded-b-xl">
              <button
                onClick={() => setSavePrompt(null)}
                className="px-3 py-1.5 text-xs border border-gray-300 rounded hover:bg-gray-100"
              >
                Cancel
              </button>
              <button
                onClick={async () => {
                  setSavingDocId(savePrompt.attachment.attachmentId);
                  await saveAttachmentAsDoc(savePrompt.attachment, savePrompt.docType);
                  setSavingDocId(null);
                }}
                disabled={savingDocId === savePrompt.attachment.attachmentId}
                className="inline-flex items-center gap-1 px-3 py-1.5 text-xs bg-blue-600 text-white rounded hover:bg-blue-700 disabled:opacity-50"
              >
                {savingDocId === savePrompt.attachment.attachmentId ? <Loader className="w-3 h-3 animate-spin" /> : <Save className="w-3 h-3" />}
                Confirm Save
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
