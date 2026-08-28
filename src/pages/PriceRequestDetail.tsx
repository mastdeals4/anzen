import { useState, useEffect, useCallback } from 'react';
import { Layout } from '../components/Layout';
import { supabase } from '../lib/supabase';
import { useAuth } from '../contexts/AuthContext';
import { formatDate } from '../utils/dateFormat';
import { MoneyInput } from '../components/MoneyInput';
import {
  ArrowLeft, Plus, Save, Clock, CheckCircle2, FileText, MessageSquare,
  Send, Mail, AlertCircle, RefreshCw,
} from 'lucide-react';
import { sendPricingWorkflowEmail, userHasConnectedGmail } from '../services/pricingEmail';
import {
  loadAllRouteRecipients,
  recipientConfigurationError,
  type RouteRecipients,
  type SourcingRoute,
} from '../services/sourcingRecipients';

interface PriceRequest {
  id: string;
  pr_number: string;
  inquiry_id: string | null;
  customer_name: string | null;
  assigned_to: string | null;
  created_by: string | null;
  overall_status: string;
  total_products: number;
  source_pending: number;
  source_received: number;
  final_pending: number;
  final_ready: number;
  notes: string | null;
  last_activity_at: string;
  last_activity_note: string | null;
  created_at: string;
  inquiry?: { inquiry_number: string } | null;
}

interface PRItem {
  id: string;
  price_request_id: string;
  product_name: string;
  specification: string | null;
  quantity: number | null;
  unit: string | null;
  source_type: string;
  source_contact: string | null;
  price_status: string;
  doc_status: string;
  source_price: number | null;
  source_currency: string;
  final_quote_price: number | null;
  final_quote_currency: string;
  target_price: number | null;
  competitor_price: number | null;
  remarks: string | null;
  pending_reason: string | null;
  created_at: string;
}

interface TimelineEvent {
  id: string;
  event_type: string;
  actor_name: string | null;
  description: string;
  created_at: string;
}

const SOURCE_COLORS: Record<string, string> = {
  india: 'bg-orange-100 text-orange-700',
  china: 'bg-red-100 text-red-700',
  local: 'bg-green-100 text-green-700',
  unknown: 'bg-gray-100 text-gray-500',
};

const PRICE_STATUS_META: Record<string, { label: string; color: string }> = {
  pending: { label: 'Pending', color: 'bg-amber-100 text-amber-700' },
  sourcing_request_sent: { label: 'Sent', color: 'bg-blue-100 text-blue-700' },
  waiting_reply: { label: 'Waiting', color: 'bg-purple-100 text-purple-700' },
  received: { label: 'Received', color: 'bg-green-100 text-green-700' },
};

const EVENT_ICONS: Record<string, React.ElementType> = {
  sourcing_request_sent: Send,
  source_reply_updated: RefreshCw,
  reply_received: MessageSquare,
  price_updated: CheckCircle2,
  final_price_entered: CheckCircle2,
  customer_quote_prepared: FileText,
  customer_quote_sent: FileText,
  reminder_prepared: Clock,
  status_changed: Clock,
  note_added: MessageSquare,
};

const STATUS_OPTIONS = ['draft', 'sourcing', 'pricing', 'quoted', 'won', 'lost'];

// ─── ItemRow ────────────────────────────────────────────────────────────────
function ItemRow({ item, onSave }: { item: PRItem; onSave: (updated: Partial<PRItem>) => Promise<void> }) {
  const [editing, setEditing] = useState(false);
  const [form, setForm] = useState({ ...item });
  const [saving, setSaving] = useState(false);

  const save = async () => {
    setSaving(true);
    await onSave({
      product_name: form.product_name,
      specification: form.specification,
      quantity: form.quantity,
      unit: form.unit,
      source_type: form.source_type,
      source_contact: form.source_contact,
      price_status: form.price_status,
      doc_status: form.doc_status,
      source_price: form.source_price,
      source_currency: form.source_currency,
      target_price: form.target_price,
      competitor_price: form.competitor_price,
      remarks: form.remarks,
      pending_reason: form.pending_reason,
    });
    setSaving(false);
    setEditing(false);
  };

  const psm = PRICE_STATUS_META[item.price_status] || PRICE_STATUS_META.pending;

  if (!editing) {
    return (
      <tr className="hover:bg-gray-50 cursor-pointer" onClick={() => setEditing(true)}>
        <td className="px-3 py-2 text-xs font-medium text-gray-800">{item.product_name}</td>
        <td className="px-3 py-2 text-xs text-gray-500">{item.specification || '-'}</td>
        <td className="px-3 py-2 text-xs text-gray-600">{item.quantity ? `${item.quantity} ${item.unit || ''}` : '-'}</td>
        <td className="px-3 py-2"><span className={`inline-flex px-1.5 py-0.5 rounded text-[10px] font-medium ${SOURCE_COLORS[item.source_type]}`}>{item.source_type}</span></td>
        <td className="px-3 py-2 text-xs text-gray-500">{item.source_contact || '-'}</td>
        <td className="px-3 py-2"><span className={`inline-flex px-1.5 py-0.5 rounded text-[10px] font-medium ${psm.color}`}>{psm.label}</span></td>
        <td className="px-3 py-2"><span className={`inline-flex px-1.5 py-0.5 rounded text-[10px] font-medium ${item.doc_status === 'received' ? 'bg-green-100 text-green-700' : item.doc_status === 'pending' ? 'bg-amber-100 text-amber-700' : 'bg-gray-100 text-gray-500'}`}>{item.doc_status}</span></td>
        <td className="px-3 py-2 text-xs text-gray-600">{item.source_price ? `${item.source_currency} ${item.source_price.toLocaleString()}` : '-'}</td>
        <td className="px-3 py-2 text-xs font-medium text-blue-700">
          {item.final_quote_price ? (
            <span className="flex items-center gap-1">
              <CheckCircle2 className="w-3 h-3 text-green-500" />
              {item.final_quote_currency} {item.final_quote_price.toLocaleString()}
            </span>
          ) : '-'}
        </td>
        <td className="px-3 py-2 text-xs text-gray-400 max-w-[120px] truncate">{item.remarks || '-'}</td>
      </tr>
    );
  }

  return (
    <tr className="bg-blue-50">
      <td colSpan={10} className="px-3 py-3">
        <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-4 gap-2 mb-3">
          <div>
            <label className="block text-[10px] font-medium text-gray-500 mb-0.5">Product</label>
            <input value={form.product_name} onChange={e => setForm(f => ({ ...f, product_name: e.target.value }))} className="w-full border border-gray-300 rounded px-2 py-1 text-xs focus:outline-none focus:ring-1 focus:ring-blue-500" />
          </div>
          <div>
            <label className="block text-[10px] font-medium text-gray-500 mb-0.5">Specification</label>
            <input value={form.specification || ''} onChange={e => setForm(f => ({ ...f, specification: e.target.value }))} className="w-full border border-gray-300 rounded px-2 py-1 text-xs focus:outline-none focus:ring-1 focus:ring-blue-500" />
          </div>
          <div>
            <label className="block text-[10px] font-medium text-gray-500 mb-0.5">Quantity</label>
            <input type="number" value={form.quantity || ''} onChange={e => setForm(f => ({ ...f, quantity: e.target.value ? +e.target.value : null }))} className="w-full border border-gray-300 rounded px-2 py-1 text-xs focus:outline-none focus:ring-1 focus:ring-blue-500" />
          </div>
          <div>
            <label className="block text-[10px] font-medium text-gray-500 mb-0.5">Unit</label>
            <input value={form.unit || ''} onChange={e => setForm(f => ({ ...f, unit: e.target.value }))} className="w-full border border-gray-300 rounded px-2 py-1 text-xs focus:outline-none focus:ring-1 focus:ring-blue-500" />
          </div>
          <div>
            <label className="block text-[10px] font-medium text-gray-500 mb-0.5">Source Type</label>
            <select value={form.source_type} onChange={e => setForm(f => ({ ...f, source_type: e.target.value }))} className="w-full border border-gray-300 rounded px-2 py-1 text-xs focus:outline-none focus:ring-1 focus:ring-blue-500">
              {['india', 'china', 'local', 'unknown'].map(s => <option key={s} value={s}>{s}</option>)}
            </select>
          </div>
          <div>
            <label className="block text-[10px] font-medium text-gray-500 mb-0.5">Source Contact</label>
            <input value={form.source_contact || ''} onChange={e => setForm(f => ({ ...f, source_contact: e.target.value }))} className="w-full border border-gray-300 rounded px-2 py-1 text-xs focus:outline-none focus:ring-1 focus:ring-blue-500" />
          </div>
          <div>
            <label className="block text-[10px] font-medium text-gray-500 mb-0.5">Price Status</label>
            <select value={form.price_status} onChange={e => setForm(f => ({ ...f, price_status: e.target.value }))} className="w-full border border-gray-300 rounded px-2 py-1 text-xs focus:outline-none focus:ring-1 focus:ring-blue-500">
              <option value="pending">pending</option>
              <option value="sourcing_request_sent">sourcing request sent</option>
              <option value="waiting_reply">waiting reply</option>
              <option value="received">received</option>
            </select>
          </div>
          <div>
            <label className="block text-[10px] font-medium text-gray-500 mb-0.5">Doc Status</label>
            <select value={form.doc_status} onChange={e => setForm(f => ({ ...f, doc_status: e.target.value }))} className="w-full border border-gray-300 rounded px-2 py-1 text-xs focus:outline-none focus:ring-1 focus:ring-blue-500">
              <option value="not_required">not required</option>
              <option value="pending">pending</option>
              <option value="received">received</option>
            </select>
          </div>
          <div>
            <label className="block text-[10px] font-medium text-gray-500 mb-0.5">Source Price</label>
            <div className="flex gap-1">
              <select value={form.source_currency} onChange={e => setForm(f => ({ ...f, source_currency: e.target.value }))} className="border border-gray-300 rounded px-1.5 py-1 text-xs w-16 focus:outline-none focus:ring-1 focus:ring-blue-500">
                {['USD', 'INR', 'CNY', 'IDR'].map(c => <option key={c} value={c}>{c}</option>)}
              </select>
              <MoneyInput value={form.source_price} onChange={amount => setForm(f => ({ ...f, source_price: amount || null }))} placeholder="0.00" className="flex-1 border border-gray-300 rounded px-2 py-1 text-xs focus:outline-none focus:ring-1 focus:ring-blue-500" maximumFractionDigits={4} />
            </div>
          </div>
          <div>
            <label className="block text-[10px] font-medium text-gray-500 mb-0.5">Target Price</label>
            <MoneyInput value={form.target_price} onChange={amount => setForm(f => ({ ...f, target_price: amount || null }))} className="w-full border border-gray-300 rounded px-2 py-1 text-xs focus:outline-none focus:ring-1 focus:ring-blue-500" placeholder="USD" maximumFractionDigits={4} />
          </div>
          <div>
            <label className="block text-[10px] font-medium text-gray-500 mb-0.5">Competitor Price</label>
            <MoneyInput value={form.competitor_price} onChange={amount => setForm(f => ({ ...f, competitor_price: amount || null }))} className="w-full border border-gray-300 rounded px-2 py-1 text-xs focus:outline-none focus:ring-1 focus:ring-blue-500" placeholder="USD" maximumFractionDigits={4} />
          </div>
          <div className="col-span-2">
            <label className="block text-[10px] font-medium text-gray-500 mb-0.5">Remarks</label>
            <input value={form.remarks || ''} onChange={e => setForm(f => ({ ...f, remarks: e.target.value }))} className="w-full border border-gray-300 rounded px-2 py-1 text-xs focus:outline-none focus:ring-1 focus:ring-blue-500" />
          </div>
          <div className="col-span-2">
            <label className="block text-[10px] font-medium text-gray-500 mb-0.5">Pending Reason</label>
            <input value={form.pending_reason || ''} onChange={e => setForm(f => ({ ...f, pending_reason: e.target.value }))} className="w-full border border-gray-300 rounded px-2 py-1 text-xs focus:outline-none focus:ring-1 focus:ring-blue-500" />
          </div>
        </div>
        <div className="flex gap-2 justify-end">
          <button onClick={() => setEditing(false)} className="px-3 py-1 text-xs text-gray-600 hover:text-gray-800">Cancel</button>
          <button onClick={save} disabled={saving} className="flex items-center gap-1 px-3 py-1 text-xs bg-blue-600 text-white rounded hover:bg-blue-700 disabled:opacity-50">
            <Save className="w-3 h-3" /> {saving ? 'Saving...' : 'Save'}
          </button>
        </div>
      </td>
    </tr>
  );
}

// ─── SourcingRequestModal ────────────────────────────────────────────────────
interface SourcingGroup {
  sourceType: 'india' | 'china';
  recipients: RouteRecipients;
  items: PRItem[];
}

function buildSourcingEmailBody(items: PRItem[], customerName: string | null, prNumber: string): string {
  const rows = items.map(it => {
    const qtyStr = it.quantity ? `${it.quantity} ${it.unit || ''}` : '-';
    const specStr = it.specification || '-';
    return `• ${it.product_name} | Spec: ${specStr} | Qty: ${qtyStr}`;
  }).join('\n');

  return `Hi,

Please provide pricing for the following product(s) for customer ${customerName || 'our client'} (Ref: ${prNumber}):

${rows}

Kindly include:
- Unit price (with currency)
- Lead time
- Document availability (COA / MSDS)

Please reply at the earliest.

Thanks & regards`;
}

function SourcingRequestModal({
  pr,
  items,
  onClose,
  onSent,
}: {
  pr: PriceRequest;
  items: PRItem[];
  onClose: () => void;
  onSent: (sentItemIds: string[]) => void;
}) {
  const { profile } = useAuth();
  const [allowResend, setAllowResend] = useState(false);
  const [routeRecipients, setRouteRecipients] = useState<Record<SourcingRoute, RouteRecipients>>({
    india: { route: 'india', to: [], cc: [], bcc: [] },
    china: { route: 'china', to: [], cc: [], bcc: [] },
    local: { route: 'local', to: [], cc: [], bcc: [] },
  });

  useEffect(() => {
    loadAllRouteRecipients().then(recipients => {
      setRouteRecipients(recipients);
      const missingRoute = (['india', 'china'] as const).find(route =>
        pendingItems.some(item => item.source_type === route) && recipients[route].to.length === 0
      );
      if (missingRoute) setError(recipientConfigurationError(missingRoute));
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Eligible items: india/china and not already received.
  // By default, also exclude items that already have a sourcing_request_sent
  // or waiting_reply status — they require an explicit "Resend" opt-in.
  const eligibleItems = items.filter(i =>
    (i.source_type === 'india' || i.source_type === 'china') &&
    i.price_status !== 'received'
  );
  const pendingItems = eligibleItems.filter(i =>
    allowResend || (i.price_status !== 'sourcing_request_sent' && i.price_status !== 'waiting_reply')
  );

  const groups: SourcingGroup[] = (['india', 'china'] as const)
    .map(src => ({
      sourceType: src,
      recipients: routeRecipients[src],
      items: pendingItems.filter(i => i.source_type === src),
    }))
    .filter(g => g.items.length > 0);

  const [selectedIds, setSelectedIds] = useState<Set<string>>(
    new Set(pendingItems.map(i => i.id))
  );
  const [previewGroup, setPreviewGroup] = useState<SourcingGroup | null>(groups[0] || null);
  const [sending, setSending] = useState(false);
  const [error, setError] = useState('');

  // Keep selection in sync when resend toggle changes the eligible set
  useEffect(() => {
    setSelectedIds(new Set(pendingItems.map(i => i.id)));
    setPreviewGroup(groups[0] || null);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [allowResend, routeRecipients]);

  const toggleItem = (id: string) => {
    setSelectedIds(prev => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id); else next.add(id);
      return next;
    });
  };

  const getPreviewSubject = (group: SourcingGroup) =>
    `Sourcing Request: ${group.items.filter(i => selectedIds.has(i.id)).map(i => i.product_name).join(', ')} – ${pr.pr_number}`;

  const getPreviewBody = (group: SourcingGroup) => {
    const groupSelected = group.items.filter(i => selectedIds.has(i.id));
    return buildSourcingEmailBody(groupSelected, pr.customer_name, pr.pr_number);
  };

  const send = async () => {
    if (selectedIds.size === 0) { setError('Select at least one item.'); return; }
    setSending(true);
    setError('');

    const { data: { user } } = await supabase.auth.getUser();
    if (!user) { setError('Not authenticated.'); setSending(false); return; }

    const sentIds: string[] = [];

    for (const group of groups) {
      const groupItems = group.items.filter(i => selectedIds.has(i.id));
      if (groupItems.length === 0) continue;
      if (group.recipients.to.length === 0) {
        setError(recipientConfigurationError(group.sourceType));
        setSending(false);
        return;
      }

      const subject = getPreviewSubject({ ...group, items: groupItems });
      const body = getPreviewBody({ ...group, items: groupItems });

      // Central helper: handles fallback sender server-side and writes
      // email_thread_map (incl. messageId/threadId) on success.
      const result = await sendPricingWorkflowEmail({
        workflowType: 'sourcing_request',
        priceRequestId: pr.id,
        itemIds: groupItems.map(i => i.id),
        sourceType: group.sourceType,
        to: group.recipients.to,
        cc: group.recipients.cc,
        bcc: group.recipients.bcc,
        subject,
        body: body.replace(/\n/g, '<br/>'),
        isHtml: true,
        senderName: profile?.full_name || '',
      });

      if (!result.success) {
        setError(`Failed to send to ${group.sourceType}: ${result.error || 'Unknown error'}`);
        setSending(false);
        return;
      }

      // Mark items as sourcing_request_sent
      for (const item of groupItems) {
        await supabase.from('price_request_items').update({
          price_status: 'sourcing_request_sent',
          updated_at: new Date().toISOString(),
        }).eq('id', item.id);
        sentIds.push(item.id);
      }

      // Log to timeline
      await supabase.from('communication_timeline').insert({
        price_request_id: pr.id,
        event_type: 'sourcing_request_sent',
        actor_id: profile?.id || null,
        actor_name: profile?.full_name || profile?.username || null,
        description: `Sourcing request sent to ${group.sourceType} (${group.recipients.to.join(', ')}) for: ${groupItems.map(i => i.product_name).join(', ')}${allowResend ? ' (resend)' : ''}`,
        metadata: {
          source_type: group.sourceType,
          to: group.recipients.to,
          cc: group.recipients.cc,
          bcc: group.recipients.bcc,
          item_count: groupItems.length,
          resend: allowResend,
          sender_mode: result.senderMode,
          gmail_message_id: result.messageId,
          gmail_thread_id: result.threadId,
        },
      });
    }

    // Update PR last_activity — only advance to 'sourcing', never demote from pricing/quoted/won/lost
    const statusPriority: Record<string, number> = { draft: 0, sourcing: 1, pricing: 2, quoted: 3, won: 4, lost: 4 };
    const currentPriority = statusPriority[pr.overall_status] ?? 0;
    const newStatus = currentPriority < statusPriority['sourcing'] ? 'sourcing' : pr.overall_status;
    await supabase.from('price_requests').update({
      last_activity_at: new Date().toISOString(),
      last_activity_note: `Sourcing request sent for ${sentIds.length} item(s)`,
      overall_status: newStatus,
      updated_at: new Date().toISOString(),
    }).eq('id', pr.id);

    setSending(false);
    onSent(sentIds);
  };

  if (groups.length === 0) {
    return (
      <div className="fixed inset-0 bg-black/40 z-50 flex items-center justify-center p-4">
        <div className="bg-white rounded-lg shadow-xl w-full max-w-md p-6 text-center">
          <AlertCircle className="w-8 h-8 text-amber-500 mx-auto mb-2" />
          <p className="text-sm text-gray-700 mb-4">No India or China items pending sourcing request.</p>
          <button onClick={onClose} className="px-4 py-1.5 text-sm bg-gray-100 text-gray-700 rounded hover:bg-gray-200">Close</button>
        </div>
      </div>
    );
  }

  return (
    <div className="fixed inset-0 bg-black/40 z-50 flex items-center justify-center p-4 overflow-y-auto">
      <div className="bg-white rounded-lg shadow-xl w-full max-w-3xl">
        <div className="px-5 py-4 border-b border-gray-200 flex items-center justify-between">
          <div>
            <h2 className="text-sm font-semibold text-gray-800">Send Sourcing Request</h2>
            <p className="text-xs text-gray-500 mt-0.5">{pr.pr_number} · {pr.customer_name || 'No customer'}</p>
          </div>
          <button onClick={onClose} className="text-gray-400 hover:text-gray-600 text-lg leading-none">&times;</button>
        </div>

        {eligibleItems.some(i => i.price_status === 'sourcing_request_sent' || i.price_status === 'waiting_reply') && (
          <div className="px-5 py-2 border-b border-gray-200 bg-amber-50 flex items-center gap-2 text-xs text-amber-800">
            <label className="inline-flex items-center gap-1.5 cursor-pointer">
              <input type="checkbox" checked={allowResend} onChange={e => setAllowResend(e.target.checked)}
                className="rounded border-gray-300 text-amber-600 focus:ring-amber-500" />
              <span>Include items already sent / waiting reply (resend)</span>
            </label>
          </div>
        )}

        <div className="grid grid-cols-1 md:grid-cols-2 divide-y md:divide-y-0 md:divide-x divide-gray-200">
          {/* Left: item selection */}
          <div className="px-5 py-4 space-y-4">
            {groups.map(group => (
              <div key={group.sourceType}>
                <div className="flex items-center gap-2 mb-2">
                  <span className={`inline-flex px-2 py-0.5 rounded text-[10px] font-medium ${SOURCE_COLORS[group.sourceType]}`}>{group.sourceType}</span>
                  <span className="text-xs text-gray-600">→ {group.sourceType} ({group.recipients.to.join(', ')})</span>
                </div>
                <div className="space-y-1.5">
                  {group.items.map(item => (
                    <label key={item.id} className="flex items-start gap-2 cursor-pointer group">
                      <input
                        type="checkbox"
                        checked={selectedIds.has(item.id)}
                        onChange={() => toggleItem(item.id)}
                        className="mt-0.5 rounded border-gray-300 text-blue-600 focus:ring-blue-500"
                      />
                      <div className="flex-1 min-w-0">
                        <p className="text-xs font-medium text-gray-800 truncate">{item.product_name}</p>
                        {item.specification && <p className="text-[10px] text-gray-500 truncate">{item.specification}</p>}
                        {item.quantity && <p className="text-[10px] text-gray-400">{item.quantity} {item.unit || ''}</p>}
                        {item.price_status === 'sourcing_request_sent' && (
                          <span className="text-[10px] text-blue-600 font-medium">Already sent</span>
                        )}
                      </div>
                    </label>
                  ))}
                </div>
                {previewGroup?.sourceType !== group.sourceType && (
                  <button onClick={() => setPreviewGroup(group)} className="mt-2 text-[10px] text-blue-600 hover:underline">Preview email →</button>
                )}
              </div>
            ))}
          </div>

          {/* Right: email preview */}
          <div className="px-5 py-4">
            {previewGroup && groups.find(g => g.sourceType === previewGroup.sourceType) ? (
              <>
                <div className="flex items-center gap-2 mb-3">
                  {groups.map(g => (
                    <button key={g.sourceType} onClick={() => setPreviewGroup(g)}
                      className={`px-2.5 py-1 text-xs rounded font-medium transition-colors ${previewGroup.sourceType === g.sourceType ? 'bg-blue-600 text-white' : 'bg-gray-100 text-gray-600 hover:bg-gray-200'}`}>
                      {g.sourceType}
                    </button>
                  ))}
                </div>
                <div className="text-[10px] text-gray-500 mb-1">To: {previewGroup.sourceType} &lt;{previewGroup.recipients.to.join(', ')}&gt;</div>
                {previewGroup.recipients.cc.length > 0 && <div className="text-[10px] text-gray-500 mb-1">CC: {previewGroup.recipients.cc.join(', ')}</div>}
                <div className="text-xs font-medium text-gray-700 mb-2 border-b border-gray-200 pb-2">
                  Subject: {getPreviewSubject(previewGroup)}
                </div>
                <pre className="text-xs text-gray-700 whitespace-pre-wrap font-sans leading-relaxed max-h-64 overflow-y-auto">
                  {getPreviewBody(previewGroup)}
                </pre>
              </>
            ) : (
              <div className="flex items-center justify-center h-full text-xs text-gray-400">Select a group to preview</div>
            )}
          </div>
        </div>

        {error && <div className="mx-5 mb-3 text-xs text-red-600 bg-red-50 border border-red-200 rounded px-3 py-2">{error}</div>}

        <div className="px-5 py-3 border-t border-gray-200 flex items-center justify-between">
          <p className="text-xs text-gray-500">{selectedIds.size} item(s) selected</p>
          <div className="flex gap-2">
            <button onClick={onClose} className="px-3 py-1.5 text-sm text-gray-600 hover:text-gray-800">Cancel</button>
            <button onClick={send} disabled={sending || selectedIds.size === 0}
              className="flex items-center gap-1.5 px-4 py-1.5 text-sm bg-blue-600 text-white rounded hover:bg-blue-700 disabled:opacity-50">
              <Send className="w-3.5 h-3.5" /> {sending ? 'Sending...' : 'Send'}
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}

// ─── SourceReplyModal ────────────────────────────────────────────────────────
function SourceReplyModal({
  pr,
  items,
  onClose,
  onUpdated,
}: {
  pr: PriceRequest;
  items: PRItem[];
  onClose: () => void;
  onUpdated: () => void;
}) {
  const { profile } = useAuth();

  const eligibleItems = items.filter(i =>
    i.price_status !== 'received' || !i.source_price
  );

  const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set());
  const [replies, setReplies] = useState<Record<string, {
    source_price: string;
    source_currency: string;
    doc_status: string;
    remarks: string;
  }>>({});
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');

  const toggleItem = (id: string) => {
    setSelectedIds(prev => {
      const next = new Set(prev);
      if (next.has(id)) {
        next.delete(id);
      } else {
        next.add(id);
        if (!replies[id]) {
          const item = items.find(i => i.id === id)!;
          setReplies(r => ({ ...r, [id]: { source_price: '', source_currency: item.source_currency || 'USD', doc_status: item.doc_status, remarks: item.remarks || '' } }));
        }
      }
      return next;
    });
  };

  const updateReply = (id: string, field: string, value: string) => {
    setReplies(r => ({ ...r, [id]: { ...r[id], [field]: value } }));
  };

  const save = async () => {
    if (selectedIds.size === 0) { setError('Select at least one item.'); return; }
    for (const id of selectedIds) {
      const r = replies[id];
      if (!r?.source_price) { setError('Enter source price for all selected items.'); return; }
    }
    setSaving(true);
    setError('');

    for (const id of selectedIds) {
      const r = replies[id];
      const item = items.find(i => i.id === id)!;

      await supabase.from('price_request_items').update({
        source_price: parseFloat(r.source_price),
        source_currency: r.source_currency,
        doc_status: r.doc_status,
        remarks: r.remarks || null,
        price_status: 'received',
        updated_at: new Date().toISOString(),
      }).eq('id', id);

      await supabase.from('communication_timeline').insert({
        price_request_id: pr.id,
        item_id: id,
        event_type: 'source_reply_updated',
        actor_id: profile?.id || null,
        actor_name: profile?.full_name || profile?.username || null,
        description: `Source reply updated for ${item.product_name}: ${r.source_currency} ${r.source_price}${r.remarks ? ` — ${r.remarks}` : ''}`,
        metadata: { source_price: parseFloat(r.source_price), source_currency: r.source_currency, doc_status: r.doc_status },
      });
    }

    // Recalc counters & update PR
    const { data: allItems } = await supabase.from('price_request_items').select('price_status, final_quote_price').eq('price_request_id', pr.id);
    if (allItems) {
      const receivedCount = allItems.filter(i => i.price_status === 'received').length;
      const finalReadyCount = allItems.filter(i => !!i.final_quote_price).length;
      // "All final quotes entered" ≠ "customer quote sent". We never auto-set
      // status to 'quoted' here — that only happens when the customer quote
      // email is actually sent (sendQuote in PrepareCustomerQuoteModal).
      const protectedStatuses = ['won', 'lost', 'quoted'];
      const newStatus = protectedStatuses.includes(pr.overall_status)
        ? pr.overall_status
        : 'pricing';
      await supabase.from('price_requests').update({
        source_received: receivedCount,
        source_pending: allItems.filter(i => ['pending', 'sourcing_request_sent', 'waiting_reply'].includes(i.price_status)).length,
        final_ready: finalReadyCount,
        final_pending: allItems.filter(i => !i.final_quote_price).length,
        last_activity_at: new Date().toISOString(),
        last_activity_note: `Source reply updated for ${selectedIds.size} item(s)`,
        overall_status: newStatus,
        updated_at: new Date().toISOString(),
      }).eq('id', pr.id);
    }

    setSaving(false);
    onUpdated();
  };

  return (
    <div className="fixed inset-0 bg-black/40 z-50 flex items-center justify-center p-4 overflow-y-auto">
      <div className="bg-white rounded-lg shadow-xl w-full max-w-2xl">
        <div className="px-5 py-4 border-b border-gray-200 flex items-center justify-between">
          <div>
            <h2 className="text-sm font-semibold text-gray-800">Update Source Reply</h2>
            <p className="text-xs text-gray-500 mt-0.5">{pr.pr_number} · {pr.customer_name || 'No customer'}</p>
          </div>
          <button onClick={onClose} className="text-gray-400 hover:text-gray-600 text-lg leading-none">&times;</button>
        </div>

        <div className="px-5 py-4 space-y-3 max-h-[60vh] overflow-y-auto">
          {eligibleItems.length === 0 && (
            <p className="text-sm text-gray-500 text-center py-4">All items have already received prices.</p>
          )}
          {eligibleItems.map(item => {
            const selected = selectedIds.has(item.id);
            const r = replies[item.id];
            const psm = PRICE_STATUS_META[item.price_status] || PRICE_STATUS_META.pending;
            return (
              <div key={item.id} className={`border rounded-lg p-3 transition-colors ${selected ? 'border-blue-300 bg-blue-50' : 'border-gray-200'}`}>
                <div className="flex items-start gap-2">
                  <input type="checkbox" checked={selected} onChange={() => toggleItem(item.id)}
                    className="mt-0.5 rounded border-gray-300 text-blue-600 focus:ring-blue-500" />
                  <div className="flex-1 min-w-0">
                    <div className="flex items-center gap-2 mb-1">
                      <p className="text-xs font-medium text-gray-800">{item.product_name}</p>
                      <span className={`inline-flex px-1.5 py-0.5 rounded text-[10px] font-medium ${SOURCE_COLORS[item.source_type]}`}>{item.source_type}</span>
                      <span className={`inline-flex px-1.5 py-0.5 rounded text-[10px] font-medium ${psm.color}`}>{psm.label}</span>
                    </div>
                    {item.specification && <p className="text-[10px] text-gray-500 mb-2">{item.specification}</p>}
                    {selected && r && (
                      <div className="grid grid-cols-2 gap-2 mt-2">
                        <div>
                          <label className="block text-[10px] font-medium text-gray-500 mb-0.5">Source Price *</label>
                          <div className="flex gap-1">
                            <select value={r.source_currency} onChange={e => updateReply(item.id, 'source_currency', e.target.value)}
                              className="border border-gray-300 rounded px-1.5 py-1 text-xs w-14 focus:outline-none focus:ring-1 focus:ring-blue-500">
                              {['USD', 'INR', 'CNY', 'IDR'].map(c => <option key={c}>{c}</option>)}
                            </select>
                            <MoneyInput autoFocus value={Number(r.source_price) || 0} onChange={amount => updateReply(item.id, 'source_price', String(amount))}
                              placeholder="0.00" className="flex-1 border border-gray-300 rounded px-2 py-1 text-xs focus:outline-none focus:ring-1 focus:ring-blue-500" />
                          </div>
                        </div>
                        <div>
                          <label className="block text-[10px] font-medium text-gray-500 mb-0.5">Doc Status</label>
                          <select value={r.doc_status} onChange={e => updateReply(item.id, 'doc_status', e.target.value)}
                            className="w-full border border-gray-300 rounded px-2 py-1 text-xs focus:outline-none focus:ring-1 focus:ring-blue-500">
                            <option value="not_required">not required</option>
                            <option value="pending">pending</option>
                            <option value="received">received</option>
                          </select>
                        </div>
                        <div className="col-span-2">
                          <label className="block text-[10px] font-medium text-gray-500 mb-0.5">Remarks</label>
                          <input value={r.remarks} onChange={e => updateReply(item.id, 'remarks', e.target.value)}
                            placeholder="Optional notes..." className="w-full border border-gray-300 rounded px-2 py-1 text-xs focus:outline-none focus:ring-1 focus:ring-blue-500" />
                        </div>
                      </div>
                    )}
                  </div>
                </div>
              </div>
            );
          })}
        </div>

        {error && <div className="mx-5 mb-3 text-xs text-red-600 bg-red-50 border border-red-200 rounded px-3 py-2">{error}</div>}

        <div className="px-5 py-3 border-t border-gray-200 flex items-center justify-between">
          <p className="text-xs text-gray-500">{selectedIds.size} item(s) selected</p>
          <div className="flex gap-2">
            <button onClick={onClose} className="px-3 py-1.5 text-sm text-gray-600 hover:text-gray-800">Cancel</button>
            <button onClick={save} disabled={saving || selectedIds.size === 0}
              className="flex items-center gap-1.5 px-4 py-1.5 text-sm bg-green-600 text-white rounded hover:bg-green-700 disabled:opacity-50">
              <RefreshCw className="w-3.5 h-3.5" /> {saving ? 'Saving...' : 'Update Reply'}
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}

// ─── PrepareCustomerQuoteModal ───────────────────────────────────────────────
function PrepareCustomerQuoteModal({
  pr,
  items,
  onClose,
  onLogged,
}: {
  pr: PriceRequest;
  items: PRItem[];
  onClose: () => void;
  onLogged: () => void;
}) {
  const { profile } = useAuth();
  const quotedItems = items.filter(i => !!i.final_quote_price);
  const [toEmail, setToEmail] = useState('');
  const [ccEmail, setCcEmail] = useState('');
  const [sending, setSending] = useState(false);
  const [sendError, setSendError] = useState('');
  const [sentInfo, setSentInfo] = useState<{ mode: string | null } | null>(null);
  const [subject, setSubject] = useState(
    `Price Quotation — ${quotedItems.map(i => i.product_name).join(', ')} — ${pr.pr_number}`
  );

  const [hasGmail, setHasGmail] = useState<boolean | null>(null);

  useEffect(() => {
    // Best-effort: fetch customer contact email from the linked inquiry
    (async () => {
      if (!pr.inquiry_id) return;
      const { data } = await supabase
        .from('crm_inquiries')
        .select('contact_email')
        .eq('id', pr.inquiry_id)
        .maybeSingle();
      if (data?.contact_email) setToEmail(data.contact_email);
    })();
    (async () => {
      if (profile?.id) setHasGmail(await userHasConnectedGmail(profile.id));
    })();
  }, [pr.inquiry_id, profile?.id]);
  const [body, setBody] = useState(() => {
    const rows = quotedItems.map(i => {
      const priceStr = `${i.final_quote_currency} ${i.final_quote_price!.toLocaleString()}`;
      const specStr = i.specification ? ` (${i.specification})` : '';
      const qtyStr = i.quantity ? ` | Qty: ${i.quantity} ${i.unit || ''}` : '';
      const remStr = i.remarks ? ` | Note: ${i.remarks}` : '';
      return `• ${i.product_name}${specStr}${qtyStr} — ${priceStr}${remStr}`;
    }).join('\n');
    return `Dear ${pr.customer_name || 'Customer'},

Please find below our price quotation for your reference (Ref: ${pr.pr_number}):

${rows}

Prices are indicative and subject to final confirmation. Please feel free to reach out for any clarifications.

Best regards`;
  });
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState(false);

  const logDraft = async () => {
    setSaving(true);
    await supabase.from('communication_timeline').insert({
      price_request_id: pr.id,
      event_type: 'customer_quote_prepared',
      actor_id: profile?.id || null,
      actor_name: profile?.full_name || profile?.username || null,
      description: `Customer quote draft prepared for ${pr.customer_name || 'customer'} (${quotedItems.length} item${quotedItems.length !== 1 ? 's' : ''})`,
      metadata: { subject, item_count: quotedItems.length },
    });
    setSaving(false);
    setSaved(true);
    setTimeout(() => { onLogged(); }, 800);
  };

  const sendQuote = async () => {
    setSendError('');
    if (!toEmail.trim()) { setSendError('Enter a recipient email.'); return; }
    setSending(true);

    const cc = ccEmail.split(',').map(s => s.trim()).filter(Boolean);
    const result = await sendPricingWorkflowEmail({
      workflowType: 'customer_quote',
      priceRequestId: pr.id,
      itemIds: quotedItems.map(i => i.id),
      to: [toEmail.trim()],
      cc,
      subject,
      body: body.replace(/\n/g, '<br/>'),
      isHtml: true,
      senderName: profile?.full_name || '',
    });

    if (!result.success) {
      setSending(false);
      setSendError(result.error || 'Failed to send quote.');
      return;
    }

    // Timeline log
    await supabase.from('communication_timeline').insert({
      price_request_id: pr.id,
      event_type: 'customer_quote_sent',
      actor_id: profile?.id || null,
      actor_name: profile?.full_name || profile?.username || null,
      description: `Customer quote sent to ${toEmail} for ${quotedItems.length} item${quotedItems.length !== 1 ? 's' : ''} (${result.senderMode === 'fallback' ? 'via default sender' : 'from your Gmail'})`,
      metadata: {
        subject,
        item_count: quotedItems.length,
        to: toEmail,
        cc,
        sender_mode: result.senderMode,
        gmail_message_id: result.messageId,
      },
    });

    // Mark PR last activity and quoted state
    await supabase.from('price_requests').update({
      last_activity_at: new Date().toISOString(),
      last_activity_note: `Customer quote sent to ${toEmail}`,
      overall_status: 'quoted',
      updated_at: new Date().toISOString(),
    }).eq('id', pr.id);

    // Mirror clean summary on the linked inquiry (no heavy details)
    if (pr.inquiry_id) {
      await Promise.resolve(
        supabase.from('crm_inquiries').update({
          price_ready: true,
          updated_at: new Date().toISOString(),
        }).eq('id', pr.inquiry_id)
      ).catch(() => {});
    }

    setSending(false);
    setSentInfo({ mode: result.senderMode });
    setTimeout(() => { onLogged(); }, 900);
  };

  return (
    <div className="fixed inset-0 bg-black/40 z-50 flex items-center justify-center p-4 overflow-y-auto">
      <div className="bg-white rounded-lg shadow-xl w-full max-w-2xl">
        <div className="px-5 py-4 border-b border-gray-200 flex items-center justify-between">
          <div>
            <h2 className="text-sm font-semibold text-gray-800">Prepare Customer Quote</h2>
            <p className="text-xs text-gray-500 mt-0.5">{pr.pr_number} · {pr.customer_name || 'No customer'} · {quotedItems.length} item{quotedItems.length !== 1 ? 's' : ''}</p>
          </div>
          <button onClick={onClose} className="text-gray-400 hover:text-gray-600 text-lg leading-none">&times;</button>
        </div>

        <div className="px-5 py-4 space-y-3">
          <div className="grid grid-cols-2 gap-2">
            <div>
              <label className="block text-[10px] font-medium text-gray-500 mb-1 uppercase tracking-wide">To *</label>
              <input value={toEmail} onChange={e => setToEmail(e.target.value)} placeholder="customer@example.com"
                className="w-full border border-gray-300 rounded px-2.5 py-1.5 text-xs focus:outline-none focus:ring-1 focus:ring-blue-500" />
            </div>
            <div>
              <label className="block text-[10px] font-medium text-gray-500 mb-1 uppercase tracking-wide">CC (comma-separated)</label>
              <input value={ccEmail} onChange={e => setCcEmail(e.target.value)} placeholder="optional"
                className="w-full border border-gray-300 rounded px-2.5 py-1.5 text-xs focus:outline-none focus:ring-1 focus:ring-blue-500" />
            </div>
          </div>
          <div>
            <label className="block text-[10px] font-medium text-gray-500 mb-1 uppercase tracking-wide">Subject</label>
            <input value={subject} onChange={e => setSubject(e.target.value)}
              className="w-full border border-gray-300 rounded px-2.5 py-1.5 text-xs focus:outline-none focus:ring-1 focus:ring-blue-500" />
          </div>
          <div>
            <label className="block text-[10px] font-medium text-gray-500 mb-1 uppercase tracking-wide">Email Draft</label>
            <textarea value={body} onChange={e => setBody(e.target.value)} rows={12}
              className="w-full border border-gray-300 rounded px-2.5 py-1.5 text-xs font-mono focus:outline-none focus:ring-1 focus:ring-blue-500 resize-y" />
          </div>
          {sendError && <div className="text-xs text-red-600 bg-red-50 border border-red-200 rounded px-3 py-2">{sendError}</div>}
          {sentInfo && (
            <div className="text-xs text-green-700 bg-green-50 border border-green-200 rounded px-3 py-2">
              Quote sent {sentInfo.mode === 'fallback' ? 'via company fallback sender' : 'from your connected Gmail'}.
            </div>
          )}
          <div className={`text-[11px] rounded px-2.5 py-1.5 border ${hasGmail ? 'bg-green-50 border-green-200 text-green-800' : 'bg-amber-50 border-amber-200 text-amber-800'}`}>
            {hasGmail === null ? 'Checking sender…' : hasGmail ? 'Sending from your connected Gmail.' : 'Using company fallback sender (no Gmail connected for your account).'}
          </div>
          <p className="text-[10px] text-gray-400">"Log Draft" only writes a timeline entry. "Send Quote" actually delivers the email.</p>
        </div>

        <div className="px-5 py-3 border-t border-gray-200 flex items-center justify-between">
          <div />
          <div className="flex gap-2">
            <button onClick={onClose} className="px-3 py-1.5 text-sm text-gray-600 hover:text-gray-800">Cancel</button>
            <button onClick={logDraft} disabled={saving || saved || sending}
              className="flex items-center gap-1.5 px-3 py-1.5 text-sm border border-gray-300 text-gray-700 rounded hover:bg-gray-50 disabled:opacity-50">
              {saved ? <><CheckCircle2 className="w-3.5 h-3.5" /> Logged</> : saving ? 'Saving...' : <><FileText className="w-3.5 h-3.5" /> Log Draft</>}
            </button>
            <button onClick={sendQuote} disabled={sending || !!sentInfo || quotedItems.length === 0}
              className="flex items-center gap-1.5 px-4 py-1.5 text-sm bg-green-600 text-white rounded hover:bg-green-700 disabled:opacity-50">
              {sentInfo ? <><CheckCircle2 className="w-3.5 h-3.5" /> Sent</> : sending ? 'Sending...' : <><Send className="w-3.5 h-3.5" /> Send Quote</>}
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}

// ─── PendingReminderModal ────────────────────────────────────────────────────
function PendingReminderModal({
  pr,
  items,
  onClose,
  onLogged,
}: {
  pr: PriceRequest;
  items: PRItem[];
  onClose: () => void;
  onLogged: () => void;
}) {
  const { profile } = useAuth();
  const [routeRecipients, setRouteRecipients] = useState<Record<SourcingRoute, RouteRecipients>>({
    india: { route: 'india', to: [], cc: [], bcc: [] },
    china: { route: 'china', to: [], cc: [], bcc: [] },
    local: { route: 'local', to: [], cc: [], bcc: [] },
  });

  useEffect(() => {
    loadAllRouteRecipients().then(recipients => {
      setRouteRecipients(recipients);
      const missingRoute = (['india', 'china'] as const).find(route =>
        pendingItems.some(item => item.source_type === route) && recipients[route].to.length === 0
      );
      if (missingRoute) setSendError(recipientConfigurationError(missingRoute));
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Only items still pending a source reply
  const pendingItems = items.filter(i =>
    (i.source_type === 'india' || i.source_type === 'china') &&
    i.price_status !== 'received'
  );

  // Group by source_type for per-contact preview
  const groups = (['india', 'china'] as const)
    .map(src => ({ sourceType: src, items: pendingItems.filter(i => i.source_type === src) }))
    .filter(g => g.items.length > 0);

  const buildReminderBody = (sourceType: 'india' | 'china') => {
    const groupItems = pendingItems.filter(i => i.source_type === sourceType);
    const rows = groupItems.map(i => {
      const qtyStr = i.quantity ? `${i.quantity} ${i.unit || ''}` : '-';
      const specStr = i.specification || '-';
      const daysSinceSent = i.price_status === 'sourcing_request_sent' ? ' (request already sent)' : '';
      return `• ${i.product_name} | Spec: ${specStr} | Qty: ${qtyStr}${daysSinceSent}`;
    }).join('\n');
    return `Hi ${sourceType} Team,

This is a gentle reminder for pricing on the below products for ${pr.customer_name || 'our client'} (Ref: ${pr.pr_number}):

${rows}

Please share the unit price, lead time, and document availability at the earliest.

Thanks & regards`;
  };

  const [activeGroup, setActiveGroup] = useState<'india' | 'china' | null>(groups[0]?.sourceType || null);
  const [saving, setSaving] = useState(false);
  const [sent, setSent] = useState(false);
  const [sending, setSending] = useState(false);
  const [sendError, setSendError] = useState('');
  const [sentInfo, setSentInfo] = useState<{ mode: string | null } | null>(null);
  const [hasGmail, setHasGmail] = useState<boolean | null>(null);
  useEffect(() => {
    (async () => {
      if (profile?.id) setHasGmail(await userHasConnectedGmail(profile.id));
    })();
  }, [profile?.id]);

  const logReminder = async () => {
    if (!activeGroup) return;
    setSaving(true);
    const groupItems = pendingItems.filter(i => i.source_type === activeGroup);
    await supabase.from('communication_timeline').insert({
      price_request_id: pr.id,
      event_type: 'reminder_prepared',
      actor_id: profile?.id || null,
      actor_name: profile?.full_name || profile?.username || null,
      description: `Reminder draft prepared for ${activeGroup} (${groupItems.length} item${groupItems.length !== 1 ? 's' : ''} still pending): ${groupItems.map(i => i.product_name).join(', ')}`,
      metadata: { source_type: activeGroup, item_count: groupItems.length, pending_items: groupItems.map(i => i.id) },
    });
    setSaving(false);
    setSent(true);
    setTimeout(() => { onLogged(); }, 800);
  };

  const sendReminder = async () => {
    if (!activeGroup) return;
    setSendError('');
    setSending(true);

    const recipients = routeRecipients[activeGroup];
    if (recipients.to.length === 0) {
      setSending(false);
      setSendError(recipientConfigurationError(activeGroup));
      return;
    }

    // Filter out anything already received — defensive, pendingItems already excludes received
    const groupItems = pendingItems.filter(i =>
      i.source_type === activeGroup && i.price_status !== 'received'
    );
    if (groupItems.length === 0) {
      setSending(false);
      setSendError('No pending items to remind for.');
      return;
    }

    const subject = `Reminder: Pricing pending — ${groupItems.map(i => i.product_name).join(', ')} — ${pr.pr_number}`;
    const body = buildReminderBody(activeGroup);

    const result = await sendPricingWorkflowEmail({
      workflowType: 'sourcing_reminder',
      priceRequestId: pr.id,
      itemIds: groupItems.map(i => i.id),
      sourceType: activeGroup,
      to: recipients.to,
      cc: recipients.cc,
      bcc: recipients.bcc,
      subject,
      body: body.replace(/\n/g, '<br/>'),
      isHtml: true,
      senderName: profile?.full_name || '',
    });

    if (!result.success) {
      setSending(false);
      setSendError(result.error || 'Failed to send reminder.');
      return;
    }

    await supabase.from('communication_timeline').insert({
      price_request_id: pr.id,
      event_type: 'reminder_sent',
      actor_id: profile?.id || null,
      actor_name: profile?.full_name || profile?.username || null,
      description: `Reminder sent to ${activeGroup} (${recipients.to.join(', ')}) for ${groupItems.length} pending item${groupItems.length !== 1 ? 's' : ''}: ${groupItems.map(i => i.product_name).join(', ')}`,
      metadata: {
        source_type: activeGroup,
        to: recipients.to,
        cc: recipients.cc,
        bcc: recipients.bcc,
        item_count: groupItems.length,
        pending_items: groupItems.map(i => i.id),
        sender_mode: result.senderMode,
        gmail_message_id: result.messageId,
      },
    });

    await supabase.from('price_requests').update({
      last_activity_at: new Date().toISOString(),
      last_activity_note: `Pending reminder sent for ${groupItems.length} item(s) to ${activeGroup}`,
      updated_at: new Date().toISOString(),
    }).eq('id', pr.id);

    setSending(false);
    setSentInfo({ mode: result.senderMode });
    setTimeout(() => { onLogged(); }, 900);
  };

  if (pendingItems.length === 0) {
    return (
      <div className="fixed inset-0 bg-black/40 z-50 flex items-center justify-center p-4">
        <div className="bg-white rounded-lg shadow-xl w-full max-w-md p-6 text-center">
          <CheckCircle2 className="w-8 h-8 text-green-400 mx-auto mb-2" />
          <p className="text-sm text-gray-700 mb-4">No pending items — all source prices received.</p>
          <button onClick={onClose} className="px-4 py-1.5 text-sm bg-gray-100 text-gray-700 rounded hover:bg-gray-200">Close</button>
        </div>
      </div>
    );
  }

  return (
    <div className="fixed inset-0 bg-black/40 z-50 flex items-center justify-center p-4 overflow-y-auto">
      <div className="bg-white rounded-lg shadow-xl w-full max-w-2xl">
        <div className="px-5 py-4 border-b border-gray-200 flex items-center justify-between">
          <div>
            <h2 className="text-sm font-semibold text-gray-800">Pending Reminder</h2>
            <p className="text-xs text-gray-500 mt-0.5">{pr.pr_number} · {pendingItems.length} item{pendingItems.length !== 1 ? 's' : ''} still awaiting source price</p>
          </div>
          <button onClick={onClose} className="text-gray-400 hover:text-gray-600 text-lg leading-none">&times;</button>
        </div>

        <div className="px-5 py-4">
          {groups.length > 1 && (
            <div className="flex gap-2 mb-3">
              {groups.map(g => (
                <button key={g.sourceType} onClick={() => setActiveGroup(g.sourceType)}
                  className={`px-2.5 py-1 text-xs rounded font-medium transition-colors ${activeGroup === g.sourceType ? 'bg-blue-600 text-white' : 'bg-gray-100 text-gray-600 hover:bg-gray-200'}`}>
                  {g.sourceType} ({g.items.length})
                </button>
              ))}
            </div>
          )}

          <div className="mb-3">
            <div className="flex flex-wrap gap-1 mb-2">
              {pendingItems.filter(i => i.source_type === activeGroup).map(i => (
                <span key={i.id} className="inline-flex items-center gap-1 text-[10px] bg-amber-100 text-amber-700 px-2 py-0.5 rounded-full">
                  <AlertCircle className="w-2.5 h-2.5" /> {i.product_name}
                  <span className="text-amber-500">({PRICE_STATUS_META[i.price_status]?.label || i.price_status})</span>
                </span>
              ))}
            </div>
          </div>

          {activeGroup && (
            <pre className="bg-gray-50 border border-gray-200 rounded-lg p-3 text-xs font-sans whitespace-pre-wrap leading-relaxed max-h-72 overflow-y-auto">
              {buildReminderBody(activeGroup)}
            </pre>
          )}
          {activeGroup && (
            <p className="mt-1 text-[10px] text-gray-500">
              To: {activeGroup} &lt;{routeRecipients[activeGroup].to.join(', ')}&gt;
              {routeRecipients[activeGroup].cc.length > 0 && ` · CC: ${routeRecipients[activeGroup].cc.join(', ')}`}
            </p>
          )}
          {sendError && <div className="mt-2 text-xs text-red-600 bg-red-50 border border-red-200 rounded px-3 py-2">{sendError}</div>}
          {sentInfo && (
            <div className="mt-2 text-xs text-green-700 bg-green-50 border border-green-200 rounded px-3 py-2">
              Reminder sent {sentInfo.mode === 'fallback' ? 'via company fallback sender' : 'from your connected Gmail'}.
            </div>
          )}
          <div className={`mt-2 text-[11px] rounded px-2.5 py-1.5 border ${hasGmail ? 'bg-green-50 border-green-200 text-green-800' : 'bg-amber-50 border-amber-200 text-amber-800'}`}>
            {hasGmail === null ? 'Checking sender…' : hasGmail ? 'Sending from your connected Gmail.' : 'Using company fallback sender (no Gmail connected for your account).'}
          </div>
          <p className="mt-1 text-[10px] text-gray-400">"Log Reminder" only writes a timeline entry. "Send Reminder" delivers the email to the configured {activeGroup || 'sourcing'} recipients.</p>
        </div>

        <div className="px-5 py-3 border-t border-gray-200 flex items-center justify-between">
          <p className="text-xs text-gray-500">{pendingItems.length} item{pendingItems.length !== 1 ? 's' : ''} pending</p>
          <div className="flex gap-2">
            <button onClick={onClose} className="px-3 py-1.5 text-sm text-gray-600 hover:text-gray-800">Cancel</button>
            <button onClick={logReminder} disabled={saving || sent || !activeGroup || sending}
              className="flex items-center gap-1.5 px-3 py-1.5 text-sm border border-gray-300 text-gray-700 rounded hover:bg-gray-50 disabled:opacity-50">
              {sent ? <><CheckCircle2 className="w-3.5 h-3.5" /> Logged</> : saving ? 'Saving...' : <><Clock className="w-3.5 h-3.5" /> Log Reminder</>}
            </button>
            <button onClick={sendReminder} disabled={sending || !!sentInfo || !activeGroup}
              className="flex items-center gap-1.5 px-4 py-1.5 text-sm bg-amber-600 text-white rounded hover:bg-amber-700 disabled:opacity-50">
              {sentInfo ? <><CheckCircle2 className="w-3.5 h-3.5" /> Sent</> : sending ? 'Sending...' : <><Send className="w-3.5 h-3.5" /> Send Reminder</>}
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}
interface Props { prId: string; onBack: () => void; }

export function PriceRequestDetail({ prId, onBack }: Props) {
  const { profile } = useAuth();
  const isManager = profile?.role === 'admin' || profile?.role === 'manager';
  const [pr, setPr] = useState<PriceRequest | null>(null);
  const [items, setItems] = useState<PRItem[]>([]);
  const [timeline, setTimeline] = useState<TimelineEvent[]>([]);
  const [loading, setLoading] = useState(true);
  const [newNote, setNewNote] = useState('');
  const [addingItem, setAddingItem] = useState(false);
  const [newItemName, setNewItemName] = useState('');
  const [showSourcingModal, setShowSourcingModal] = useState(false);
  const [showReplyModal, setShowReplyModal] = useState(false);
  const [showQuoteModal, setShowQuoteModal] = useState(false);
  const [showReminderModal, setShowReminderModal] = useState(false);

  const load = useCallback(async () => {
    setLoading(true);
    const [prRes, itemsRes, timelineRes] = await Promise.all([
      supabase.from('price_requests').select('*, pr_number:price_request_number, overall_status:status, inquiry:crm_inquiries(inquiry_number)').eq('id', prId).maybeSingle(),
      supabase.from('price_request_items').select('*').eq('price_request_id', prId).order('created_at'),
      supabase.from('communication_timeline').select('*').eq('price_request_id', prId).order('created_at', { ascending: false }),
    ]);
    setPr(prRes.data as PriceRequest);
    setItems(itemsRes.data || []);
    setTimeline(timelineRes.data || []);
    setLoading(false);
  }, [prId]);

  useEffect(() => { load(); }, [load]);

  const updatePR = async (patch: Record<string, unknown>) => {
    await supabase.from('price_requests').update({ ...patch, updated_at: new Date().toISOString(), last_activity_at: new Date().toISOString() }).eq('id', prId);
    load();
  };

  const recalcCounters = async () => {
    const { data: allItems } = await supabase.from('price_request_items').select('price_status, final_quote_price').eq('price_request_id', prId);
    if (allItems) {
      await supabase.from('price_requests').update({
        total_products: allItems.length,
        source_pending: allItems.filter(i => ['pending', 'sourcing_request_sent', 'waiting_reply'].includes(i.price_status)).length,
        source_received: allItems.filter(i => i.price_status === 'received').length,
        final_pending: allItems.filter(i => !i.final_quote_price).length,
        final_ready: allItems.filter(i => !!i.final_quote_price).length,
        updated_at: new Date().toISOString(),
        last_activity_at: new Date().toISOString(),
      }).eq('id', prId);
    }
  };

  const updateItem = async (itemId: string, patch: Partial<PRItem>) => {
    await supabase.from('price_request_items').update({ ...patch, updated_at: new Date().toISOString() }).eq('id', itemId);
    await recalcCounters();
    load();
  };

  const addItem = async () => {
    if (!newItemName.trim()) return;
    await supabase.from('price_request_items').insert({ price_request_id: prId, product_name: newItemName.trim() });
    await recalcCounters();
    setNewItemName('');
    setAddingItem(false);
    load();
  };

  const addNote = async () => {
    if (!newNote.trim()) return;
    await supabase.from('communication_timeline').insert({
      price_request_id: prId,
      event_type: 'note_added',
      actor_id: profile?.id || null,
      actor_name: profile?.full_name || profile?.username || null,
      description: newNote.trim(),
    });
    setNewNote('');
    load();
  };

  if (loading) return <Layout><div className="flex items-center justify-center h-64 text-sm text-gray-400">Loading...</div></Layout>;
  if (!pr) return <Layout><div className="p-6 text-sm text-gray-500">Not found.</div></Layout>;

  const quoteReadyItems = items.filter(i => !!i.final_quote_price);
  const quoteReady = quoteReadyItems.length > 0 && quoteReadyItems.length === items.length;
  const hasPendingSourcingItems = items.some(i =>
    (i.source_type === 'india' || i.source_type === 'china') &&
    i.price_status !== 'received'
  );
  // Show "Update Source Reply" when any item still needs a source price
  // (mirrors the eligibleItems filter inside SourceReplyModal)
  const hasItemsNeedingSourceReply = items.some(i =>
    i.price_status !== 'received' || !i.source_price
  );

  return (
    <Layout>
      <div className="p-4 md:p-6 max-w-6xl">
        <div className="flex items-start justify-between mb-4 flex-wrap gap-2">
          <div className="flex items-center gap-3">
            <button onClick={onBack} className="p-1 rounded hover:bg-gray-100 text-gray-500"><ArrowLeft className="w-4 h-4" /></button>
            <div>
              <div className="flex items-center gap-2 flex-wrap">
                <h1 className="text-base font-semibold text-gray-900">{pr.pr_number}</h1>
                {pr.inquiry?.inquiry_number && <span className="text-xs text-gray-500 bg-gray-100 px-2 py-0.5 rounded">{pr.inquiry.inquiry_number}</span>}
                {quoteReady && (
                  <span className="inline-flex items-center gap-1 text-[10px] font-semibold text-green-700 bg-green-100 px-2 py-0.5 rounded-full">
                    <CheckCircle2 className="w-3 h-3" /> Ready for Customer Quote
                  </span>
                )}
                {!quoteReady && quoteReadyItems.length > 0 && (
                  <span className="inline-flex items-center gap-1 text-[10px] font-medium text-amber-700 bg-amber-100 px-2 py-0.5 rounded-full">
                    {quoteReadyItems.length}/{items.length} Quoted
                  </span>
                )}
              </div>
              <p className="text-xs text-gray-500 mt-0.5">{pr.customer_name || 'No customer'}</p>
            </div>
          </div>
          <div className="flex items-center gap-2 flex-wrap">
            {/* Buttons appear in workflow order: Sourcing → Reply → Reminder → Quote */}
            <button onClick={() => setShowSourcingModal(true)} disabled={!hasPendingSourcingItems}
              title={hasPendingSourcingItems ? 'Send sourcing request to India/China' : 'No pending india/china items'}
              className="flex items-center gap-1.5 px-3 py-1.5 text-xs bg-blue-600 text-white rounded hover:bg-blue-700 font-medium disabled:bg-gray-200 disabled:text-gray-400 disabled:cursor-not-allowed">
              <Mail className="w-3 h-3" /> Send Sourcing Request
            </button>
            <button onClick={() => setShowReplyModal(true)} disabled={!hasItemsNeedingSourceReply}
              title={hasItemsNeedingSourceReply ? 'Enter received source price' : 'All items have a source price'}
              className="flex items-center gap-1.5 px-3 py-1.5 text-xs border rounded font-medium disabled:bg-gray-100 disabled:text-gray-400 disabled:border-gray-200 disabled:cursor-not-allowed border-green-300 bg-green-50 text-green-700 hover:bg-green-100">
              <RefreshCw className="w-3 h-3" /> Update Source Reply
            </button>
            <button onClick={() => setShowReminderModal(true)} disabled={!hasPendingSourcingItems}
              title={hasPendingSourcingItems ? 'Send reminder for pending source replies' : 'Nothing pending to remind for'}
              className="flex items-center gap-1.5 px-3 py-1.5 text-xs border rounded font-medium disabled:bg-gray-100 disabled:text-gray-400 disabled:border-gray-200 disabled:cursor-not-allowed border-amber-300 bg-amber-50 text-amber-700 hover:bg-amber-100">
              <Clock className="w-3 h-3" /> Pending Reminder
            </button>
            <button onClick={() => setShowQuoteModal(true)} disabled={quoteReadyItems.length === 0}
              title={quoteReady ? 'All items quoted — prepare customer quote' : quoteReadyItems.length > 0 ? `${quoteReadyItems.length}/${items.length} items have a final quote` : 'No items have a final quote yet'}
              className="flex items-center gap-1.5 px-3 py-1.5 text-xs rounded font-medium disabled:bg-gray-200 disabled:text-gray-400 disabled:cursor-not-allowed bg-green-600 text-white hover:bg-green-700">
              <FileText className="w-3 h-3" /> Prepare Customer Quote
            </button>
            {isManager && (
              <select value={pr.overall_status} onChange={e => updatePR({ overall_status: e.target.value })}
                className="border border-gray-300 rounded px-2 py-1 text-xs focus:outline-none focus:ring-1 focus:ring-blue-500">
                {STATUS_OPTIONS.map(s => <option key={s} value={s}>{s.charAt(0).toUpperCase() + s.slice(1)}</option>)}
              </select>
            )}
            {!isManager && (
              <span className="inline-flex px-2 py-1 text-xs rounded bg-gray-100 text-gray-600 font-medium">
                {pr.overall_status.charAt(0).toUpperCase() + pr.overall_status.slice(1)}
              </span>
            )}
          </div>
        </div>

        {(() => {
          let nextStep = '';
          if (items.length === 0) nextStep = 'Add products to this price request to get started.';
          else if (hasPendingSourcingItems && items.some(i => i.price_status === 'pending')) nextStep = 'Next step: send sourcing request to India/China for pending items.';
          else if (hasItemsNeedingSourceReply) nextStep = 'Next step: update source reply once sourcing contact responds.';
          else if (!quoteReady && pr.final_pending > 0) nextStep = 'Next step: enter final quote in Pricing Desk.';
          else if (quoteReady && pr.overall_status !== 'quoted' && pr.overall_status !== 'won' && pr.overall_status !== 'lost') nextStep = 'Next step: prepare and send customer quote.';
          else if (pr.overall_status === 'quoted') nextStep = 'Quote sent — awaiting customer decision.';
          return nextStep ? (
            <div className="bg-blue-50 border border-blue-200 rounded-md px-3 py-1.5 mb-3 text-xs text-blue-800">{nextStep}</div>
          ) : null;
        })()}

        <div className="grid grid-cols-4 gap-3 mb-5">
          {[
            { label: 'Total Products', value: pr.total_products },
            { label: 'Source Pending', value: pr.source_pending },
            { label: 'Source Received', value: pr.source_received },
            { label: 'Final Ready', value: pr.final_ready },
          ].map(s => (
            <div key={s.label} className="bg-white border border-gray-200 rounded-lg px-3 py-2.5 text-center">
              <p className="text-xl font-semibold text-gray-900">{s.value}</p>
              <p className="text-[10px] text-gray-500 mt-0.5">{s.label}</p>
            </div>
          ))}
        </div>

        <div className="grid grid-cols-1 lg:grid-cols-3 gap-5">
          <div className="lg:col-span-2">
            <div className="bg-white border border-gray-200 rounded-lg overflow-hidden">
              <div className="flex items-center justify-between px-4 py-2.5 border-b border-gray-200">
                <h2 className="text-xs font-semibold text-gray-700 uppercase tracking-wide">Products</h2>
                <button onClick={() => setAddingItem(true)} className="flex items-center gap-1 text-xs text-blue-600 hover:text-blue-700 font-medium">
                  <Plus className="w-3 h-3" /> Add product
                </button>
              </div>
              {addingItem && (
                <div className="px-4 py-2 border-b border-gray-200 bg-blue-50 flex gap-2">
                  <input autoFocus value={newItemName} onChange={e => setNewItemName(e.target.value)}
                    onKeyDown={e => { if (e.key === 'Enter') addItem(); if (e.key === 'Escape') setAddingItem(false); }}
                    placeholder="Product name..." className="flex-1 border border-gray-300 rounded px-2 py-1 text-xs focus:outline-none focus:ring-1 focus:ring-blue-500" />
                  <button onClick={addItem} className="px-2.5 py-1 text-xs bg-blue-600 text-white rounded hover:bg-blue-700">Add</button>
                  <button onClick={() => setAddingItem(false)} className="px-2 py-1 text-xs text-gray-500 hover:text-gray-700">Cancel</button>
                </div>
              )}
              {items.length === 0 ? (
                <div className="py-10 text-center text-xs text-gray-400">No products yet. Add one above.</div>
              ) : (
                <div className="overflow-x-auto">
                  <table className="w-full">
                    <thead className="bg-gray-50">
                      <tr>
                        {['Product', 'Spec', 'Qty', 'Source', 'Contact', 'Price', 'Doc', 'Source Price', 'Final Quote', 'Remarks'].map(h => (
                          <th key={h} className="px-3 py-2 text-left text-[10px] font-medium text-gray-500 uppercase whitespace-nowrap">{h}</th>
                        ))}
                      </tr>
                    </thead>
                    <tbody className="divide-y divide-gray-100">
                      {items.map(item => <ItemRow key={item.id} item={item} onSave={patch => updateItem(item.id, patch)} />)}
                    </tbody>
                  </table>
                </div>
              )}
            </div>
          </div>

          <div className="lg:col-span-1">
            <div className="bg-white border border-gray-200 rounded-lg overflow-hidden">
              <div className="px-4 py-2.5 border-b border-gray-200">
                <h2 className="text-xs font-semibold text-gray-700 uppercase tracking-wide">Timeline</h2>
              </div>
              <div className="px-3 py-2 border-b border-gray-200">
                <div className="flex gap-2">
                  <input value={newNote} onChange={e => setNewNote(e.target.value)} onKeyDown={e => { if (e.key === 'Enter') addNote(); }}
                    placeholder="Add a note..." className="flex-1 border border-gray-300 rounded px-2 py-1 text-xs focus:outline-none focus:ring-1 focus:ring-blue-500" />
                  <button onClick={addNote} className="px-2.5 py-1 text-xs bg-blue-600 text-white rounded hover:bg-blue-700">Add</button>
                </div>
              </div>
              <div className="overflow-y-auto max-h-[400px]">
                {timeline.length === 0 ? (
                  <p className="py-8 text-center text-xs text-gray-400">No activity yet.</p>
                ) : (
                  <div className="divide-y divide-gray-100">
                    {timeline.map(ev => {
                      const Icon = EVENT_ICONS[ev.event_type] || Clock;
                      return (
                        <div key={ev.id} className="px-4 py-2.5 flex gap-2.5">
                          <div className="mt-0.5 shrink-0"><Icon className="w-3.5 h-3.5 text-gray-400" /></div>
                          <div className="min-w-0">
                            <p className="text-xs text-gray-700 leading-relaxed">{ev.description}</p>
                            <p className="text-[10px] text-gray-400 mt-0.5">
                              {ev.actor_name && <span className="font-medium">{ev.actor_name} — </span>}
                              {formatDate(ev.created_at)}
                            </p>
                          </div>
                        </div>
                      );
                    })}
                  </div>
                )}
              </div>
            </div>
            {pr.notes && (
              <div className="mt-3 bg-amber-50 border border-amber-200 rounded-lg px-3 py-2.5">
                <p className="text-[10px] font-semibold text-amber-700 uppercase mb-1">Notes</p>
                <p className="text-xs text-amber-800">{pr.notes}</p>
              </div>
            )}
          </div>
        </div>
      </div>

      {showSourcingModal && pr && (
        <SourcingRequestModal
          pr={pr}
          items={items}
          onClose={() => setShowSourcingModal(false)}
          onSent={() => { setShowSourcingModal(false); load(); }}
        />
      )}
      {showReplyModal && pr && (
        <SourceReplyModal
          pr={pr}
          items={items}
          onClose={() => setShowReplyModal(false)}
          onUpdated={() => { setShowReplyModal(false); load(); }}
        />
      )}
      {showQuoteModal && pr && (
        <PrepareCustomerQuoteModal
          pr={pr}
          items={items}
          onClose={() => setShowQuoteModal(false)}
          onLogged={() => { setShowQuoteModal(false); load(); }}
        />
      )}
      {showReminderModal && pr && (
        <PendingReminderModal
          pr={pr}
          items={items}
          onClose={() => setShowReminderModal(false)}
          onLogged={() => { setShowReminderModal(false); load(); }}
        />
      )}
    </Layout>
  );
}
