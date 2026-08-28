import { useEffect, useState, useCallback } from 'react';
import { Layout } from '../components/Layout';
import { supabase } from '../lib/supabase';
import { useAuth } from '../contexts/AuthContext';
import { formatDate } from '../utils/dateFormat';
import { CheckCircle2, XCircle, AlertCircle, RefreshCw } from 'lucide-react';
import { showToast } from '../components/ToastNotification';

interface ParserResult {
  id: string;
  email_thread_map_id: string | null;
  price_request_id: string | null;
  price_request_item_id: string | null;
  suggested_source_price: number | null;
  suggested_source_currency: string | null;
  suggested_doc_status: string | null;
  suggested_remarks: string | null;
  raw_snippet: string | null;
  confidence: number | null;
  review_status: 'pending_review' | 'accepted' | 'rejected';
  review_notes: string | null;
  created_at: string;
  pr?: { pr_number: string; customer_name: string | null } | null;
  item?: { product_name: string; specification: string | null; source_type: string } | null;
}

const STATUS_META: Record<string, { label: string; color: string }> = {
  pending_review: { label: 'Pending', color: 'bg-amber-100 text-amber-700' },
  accepted: { label: 'Accepted', color: 'bg-green-100 text-green-700' },
  rejected: { label: 'Rejected', color: 'bg-red-100 text-red-700' },
};

export function PricingParserReview() {
  const { profile } = useAuth();
  const isManager = profile?.role === 'admin' || profile?.role === 'manager';
  const [results, setResults] = useState<ParserResult[]>([]);
  const [loading, setLoading] = useState(true);
  const [filter, setFilter] = useState<'pending_review' | 'accepted' | 'rejected' | 'all'>('pending_review');
  const [busyId, setBusyId] = useState<string | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    let q = supabase
      .from('sourcing_parser_results')
      .select(`
        *,
        pr:price_requests(pr_number:price_request_number, customer_name),
        item:price_request_items(product_name, specification, source_type)
      `)
      .order('created_at', { ascending: false })
      .limit(200);
    if (filter !== 'all') q = q.eq('review_status', filter);
    const { data, error } = await q;
    if (error) {
      console.error('Parser results load error:', error);
      setResults([]);
    } else {
      setResults((data as ParserResult[]) || []);
    }
    setLoading(false);
  }, [filter]);

  useEffect(() => { load(); }, [load]);

  const accept = async (r: ParserResult) => {
    if (!isManager) {
      showToast({ type: 'error', title: 'Not allowed', message: 'Only admin/manager can accept parser results.' });
      return;
    }
    if (!r.price_request_item_id || !r.suggested_source_price) {
      showToast({ type: 'error', title: 'Cannot accept', message: 'Missing target item or suggested price.' });
      return;
    }
    setBusyId(r.id);
    // Update the price_request_item with suggested values (same shape as Update Source Reply)
    const { error: itemErr } = await supabase
      .from('price_request_items')
      .update({
        source_price: r.suggested_source_price,
        source_currency: r.suggested_source_currency || 'USD',
        doc_status: r.suggested_doc_status || 'pending',
        remarks: r.suggested_remarks || null,
        price_status: 'received',
        updated_at: new Date().toISOString(),
      })
      .eq('id', r.price_request_item_id);

    if (itemErr) {
      console.error(itemErr);
      showToast({ type: 'error', title: 'Update failed', message: itemErr.message });
      setBusyId(null);
      return;
    }

    await supabase.from('sourcing_parser_results').update({
      review_status: 'accepted',
      reviewed_by: profile?.id || null,
      reviewed_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
    }).eq('id', r.id);

    // Recalculate PR counters now that an item moved to 'received'. We do
    // NOT auto-advance to 'quoted' — that only happens after the customer
    // quote is sent.
    if (r.price_request_id) {
      const { data: allItems } = await supabase
        .from('price_request_items')
        .select('price_status, final_quote_price')
        .eq('price_request_id', r.price_request_id);
      if (allItems) {
        const finalReady = allItems.filter(i => !!i.final_quote_price).length;
        const allDone = finalReady === allItems.length && allItems.length > 0;
        const { data: prRow } = await supabase
          .from('price_requests')
          .select('overall_status, inquiry_id')
          .eq('id', r.price_request_id)
          .maybeSingle();
        const protectedStatuses = ['won', 'lost', 'quoted'];
        const newStatus = prRow && protectedStatuses.includes(prRow.overall_status)
          ? prRow.overall_status
          : 'pricing';
        await supabase.from('price_requests').update({
          source_received: allItems.filter(i => i.price_status === 'received').length,
          source_pending: allItems.filter(i => ['pending', 'sourcing_request_sent', 'waiting_reply'].includes(i.price_status)).length,
          final_ready: finalReady,
          final_pending: allItems.filter(i => !i.final_quote_price).length,
          total_products: allItems.length,
          overall_status: newStatus,
          last_activity_at: new Date().toISOString(),
          last_activity_note: 'Parser result accepted',
          updated_at: new Date().toISOString(),
        }).eq('id', r.price_request_id);
        if (prRow?.inquiry_id) {
          await Promise.resolve(supabase.from('crm_inquiries')
            .update({ price_ready: allDone, updated_at: new Date().toISOString() })
            .eq('id', prRow.inquiry_id)).catch(() => {});
        }
      }
    }

    if (r.price_request_id) {
      await supabase.from('communication_timeline').insert({
        price_request_id: r.price_request_id,
        item_id: r.price_request_item_id,
        event_type: 'source_reply_updated',
        actor_id: profile?.id || null,
        actor_name: profile?.full_name || profile?.username || null,
        description: `Parser result accepted for ${r.item?.product_name || 'item'}: ${r.suggested_source_currency || 'USD'} ${r.suggested_source_price?.toLocaleString()}`,
        metadata: {
          source_price: r.suggested_source_price,
          source_currency: r.suggested_source_currency,
          parser_result_id: r.id,
        },
      });

      // Notify admin(s) about pending final pricing — best-effort
      try {
        const { data: admins } = await supabase
          .from('user_profiles')
          .select('id')
          .eq('role', 'admin')
          .eq('is_active', true);
        const targets = (admins || []).map(a => a.id);
        if (targets.length === 0 && profile?.id) targets.push(profile.id);
        for (const uid of targets) {
          await Promise.resolve(supabase.from('notifications').insert({
            user_id: uid,
            title: 'Source price accepted from parser',
            message: `${r.item?.product_name || 'Item'} → ${r.suggested_source_currency || 'USD'} ${r.suggested_source_price?.toLocaleString()}. Pending final quote in Pricing Desk.`,
            type: 'pricing',
            reference_id: r.price_request_id,
            reference_type: 'price_request',
          })).catch(() => {});
        }
      } catch { /* notifications optional */ }
    }

    setBusyId(null);
    showToast({ type: 'success', title: 'Accepted', message: 'Source price applied to item.' });
    load();
  };

  const reject = async (r: ParserResult) => {
    if (!isManager) {
      showToast({ type: 'error', title: 'Not allowed', message: 'Only admin/manager can reject parser results.' });
      return;
    }
    setBusyId(r.id);
    await supabase.from('sourcing_parser_results').update({
      review_status: 'rejected',
      reviewed_by: profile?.id || null,
      reviewed_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
    }).eq('id', r.id);
    setBusyId(null);
    showToast({ type: 'success', title: 'Rejected', message: 'Parser result rejected — item unchanged.' });
    load();
  };

  return (
    <Layout>
      <div className="p-4 md:p-6">
        <div className="flex items-center justify-between mb-4 flex-wrap gap-2">
          <div>
            <h1 className="text-lg font-semibold text-gray-900">Parser Review</h1>
            <p className="text-xs text-gray-500 mt-0.5">AI-parsed sourcing replies pending human review. Source prices update only after accept.</p>
          </div>
          <div className="flex items-center gap-2">
            <div className="flex bg-white border border-gray-200 rounded-lg p-0.5">
              {(['pending_review', 'accepted', 'rejected', 'all'] as const).map(f => (
                <button key={f} onClick={() => setFilter(f)}
                  className={`px-2.5 py-1 text-xs rounded font-medium transition-colors ${filter === f ? 'bg-blue-600 text-white' : 'text-gray-600 hover:bg-gray-50'}`}>
                  {f === 'pending_review' ? 'Pending' : f === 'all' ? 'All' : f.charAt(0).toUpperCase() + f.slice(1)}
                </button>
              ))}
            </div>
            <button onClick={load} className="p-1.5 rounded hover:bg-gray-100 text-gray-500" title="Refresh">
              <RefreshCw className="w-4 h-4" />
            </button>
          </div>
        </div>

        <div className="bg-white border border-gray-200 rounded-lg overflow-hidden">
          {loading ? (
            <div className="py-16 text-center text-sm text-gray-400">Loading...</div>
          ) : results.length === 0 ? (
            <div className="py-12 text-center px-6">
              <p className="text-sm text-gray-700 font-medium">
                {filter === 'pending_review'
                  ? 'No parser results yet.'
                  : filter === 'accepted' ? 'No accepted parser results yet.'
                  : filter === 'rejected' ? 'No rejected parser results yet.'
                  : 'No parser results yet.'}
              </p>
              <p className="text-xs text-gray-500 mt-1 max-w-md mx-auto">
                This page will populate after the email parser is connected. Until then, you can keep updating source replies manually from each Price Request.
              </p>
            </div>
          ) : (
            <div className="divide-y divide-gray-100">
              {results.map(r => {
                const sm = STATUS_META[r.review_status];
                return (
                  <div key={r.id} className="p-4 hover:bg-gray-50">
                    <div className="flex items-start gap-3">
                      <div className="flex-1 min-w-0">
                        <div className="flex items-center gap-2 flex-wrap mb-1">
                          <span className={`inline-flex px-1.5 py-0.5 rounded text-[10px] font-medium ${sm.color}`}>{sm.label}</span>
                          {r.pr?.pr_number && <span className="text-xs font-medium text-blue-700">{r.pr.pr_number}</span>}
                          {r.pr?.customer_name && <span className="text-xs text-gray-600">· {r.pr.customer_name}</span>}
                          {r.item?.source_type && (
                            <span className="text-[10px] text-gray-500 bg-gray-100 px-1.5 py-0.5 rounded">{r.item.source_type}</span>
                          )}
                          {typeof r.confidence === 'number' && (
                            <span className="text-[10px] text-gray-500">conf: {(r.confidence * 100).toFixed(0)}%</span>
                          )}
                        </div>
                        <p className="text-sm font-medium text-gray-800">{r.item?.product_name || 'Unmatched item'}</p>
                        {r.item?.specification && <p className="text-[11px] text-gray-500">{r.item.specification}</p>}
                        <div className="mt-2 grid grid-cols-2 md:grid-cols-4 gap-x-4 gap-y-1 text-xs">
                          <div>
                            <span className="text-[10px] text-gray-400 uppercase">Price</span>
                            <p className="font-medium text-gray-800">
                              {r.suggested_source_price
                                ? `${r.suggested_source_currency || 'USD'} ${r.suggested_source_price.toLocaleString()}`
                                : <span className="text-gray-400">—</span>}
                            </p>
                          </div>
                          <div>
                            <span className="text-[10px] text-gray-400 uppercase">Doc Status</span>
                            <p className="text-gray-700">{r.suggested_doc_status || '—'}</p>
                          </div>
                          <div className="col-span-2">
                            <span className="text-[10px] text-gray-400 uppercase">Remarks</span>
                            <p className="text-gray-700 truncate">{r.suggested_remarks || '—'}</p>
                          </div>
                        </div>
                        {r.raw_snippet && (
                          <details className="mt-2">
                            <summary className="text-[10px] text-blue-600 cursor-pointer hover:underline">View raw snippet</summary>
                            <pre className="mt-1 text-[11px] text-gray-600 whitespace-pre-wrap bg-gray-50 border border-gray-200 rounded p-2 max-h-32 overflow-y-auto">{r.raw_snippet}</pre>
                          </details>
                        )}
                        <p className="text-[10px] text-gray-400 mt-2">Created {formatDate(r.created_at)}</p>
                      </div>

                      {r.review_status === 'pending_review' && (
                        <div className="flex flex-col gap-1.5">
                          <button onClick={() => accept(r)} disabled={busyId === r.id || !isManager}
                            className="flex items-center gap-1.5 px-3 py-1.5 text-xs bg-green-600 text-white rounded hover:bg-green-700 disabled:opacity-50">
                            <CheckCircle2 className="w-3.5 h-3.5" /> Accept
                          </button>
                          <button onClick={() => reject(r)} disabled={busyId === r.id || !isManager}
                            className="flex items-center gap-1.5 px-3 py-1.5 text-xs border border-red-200 text-red-600 rounded hover:bg-red-50 disabled:opacity-50">
                            <XCircle className="w-3.5 h-3.5" /> Reject
                          </button>
                        </div>
                      )}
                    </div>
                  </div>
                );
              })}
            </div>
          )}
        </div>

        {!isManager && (
          <div className="mt-3 text-[11px] text-gray-500 flex items-center gap-1.5">
            <AlertCircle className="w-3 h-3" />
            Only admin/manager can accept or reject. You can review entries here in read-only mode.
          </div>
        )}
      </div>
    </Layout>
  );
}
