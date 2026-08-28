import { useState, useEffect, useCallback } from 'react';
import { Layout } from '../components/Layout';
import { supabase } from '../lib/supabase';
import { useAuth } from '../contexts/AuthContext';
import { Save, CheckCircle2 } from 'lucide-react';
import { MoneyInput } from '../components/MoneyInput';

interface DeskItem {
  id: string;
  product_name: string;
  specification: string | null;
  quantity: number | null;
  unit: string | null;
  source_type: string;
  source_price: number | null;
  source_currency: string;
  target_price: number | null;
  competitor_price: number | null;
  final_quote_price: number | null;
  final_quote_currency: string;
  remarks: string | null;
  price_request_id: string;
  pr?: { pr_number: string; customer_name: string | null; assigned_to: string | null } | null;
}

const SOURCE_COLORS: Record<string, string> = {
  india: 'bg-orange-100 text-orange-700',
  china: 'bg-red-100 text-red-700',
  local: 'bg-green-100 text-green-700',
  unknown: 'bg-gray-100 text-gray-500',
};

async function recalcPriceRequestCounters(priceRequestId: string) {
  const { data: prItems } = await supabase
    .from('price_request_items')
    .select('price_status, final_quote_price')
    .eq('price_request_id', priceRequestId);

  if (!prItems) return;

  const sourceReceived = prItems.filter(i => i.price_status === 'received').length;
  const finalReady = prItems.filter(i => !!i.final_quote_price).length;
  const allDone = finalReady === prItems.length && prItems.length > 0;

  const update: Record<string, unknown> = {
    total_products: prItems.length,
    source_pending: prItems.filter(i => ['pending', 'sourcing_request_sent', 'waiting_reply'].includes(i.price_status)).length,
    source_received: sourceReceived,
    final_ready: finalReady,
    final_pending: prItems.filter(i => !i.final_quote_price).length,
    last_activity_at: new Date().toISOString(),
    updated_at: new Date().toISOString(),
  };

  // "Ready for quote" ≠ "quote sent". We never auto-promote to 'quoted'
  // here — that only happens after the customer quote email is actually
  // sent (PrepareCustomerQuoteModal.sendQuote).
  const { data: pr } = await supabase
    .from('price_requests')
    .select('overall_status, inquiry_id')
    .eq('id', priceRequestId)
    .maybeSingle();
  const current = pr?.overall_status;
  if (!current || current === 'sourcing' || current === 'draft') {
    update.overall_status = 'pricing';
  }
  // If already 'pricing', 'quoted', 'won', 'lost' — leave it unchanged.

  await supabase.from('price_requests').update(update).eq('id', priceRequestId);

  // Mirror "price ready" flag on the linked inquiry. This represents the
  // sales-ready state (final price entered) — NOT that a quote has been
  // sent. When items become non-ready again, reset the flag.
  if (pr?.inquiry_id) {
    await supabase
      .from('crm_inquiries')
      .update({ price_ready: allDone, updated_at: new Date().toISOString() })
      .eq('id', pr.inquiry_id);
  }
}

async function notifyAssignedUser(priceRequestId: string, productName: string, finalPrice: number, currency: string) {
  try {
    const { data: pr } = await supabase
      .from('price_requests')
      .select('assigned_to, pr_number:price_request_number, customer_name')
      .eq('id', priceRequestId)
      .maybeSingle();

    if (!pr?.assigned_to) return;

    const insertResult = supabase.from('notifications').insert({
      user_id: pr.assigned_to,
      title: 'Final quote ready',
      message: `Final quote entered for ${productName} (${currency} ${finalPrice.toLocaleString()}) — ${pr.pr_number}${pr.customer_name ? ` · ${pr.customer_name}` : ''}`,
      type: 'pricing',
      reference_id: priceRequestId,
      reference_type: 'price_request',
    });
    await Promise.resolve(insertResult).catch(() => {}); // notifications table may not exist; suppress errors
  } catch {
    // ignore notification failures
  }
}

export function PricingDesk() {
  const { profile } = useAuth();
  const [items, setItems] = useState<DeskItem[]>([]);
  const [loading, setLoading] = useState(true);
  const [editing, setEditing] = useState<Record<string, { price: string; currency: string; remarks: string }>>({});
  const [saving, setSaving] = useState<string | null>(null);
  const [done, setDone] = useState<Set<string>>(new Set());

  const load = useCallback(async () => {
    setLoading(true);
    const { data } = await supabase
      .from('price_request_items')
      .select('*, pr:price_requests(pr_number:price_request_number, customer_name, assigned_to)')
      .eq('price_status', 'received')
      .is('final_quote_price', null)
      .order('created_at');
    setItems((data as DeskItem[]) || []);
    setLoading(false);
  }, []);

  useEffect(() => { load(); }, [load]);

  const startEdit = (item: DeskItem) => {
    setEditing(e => ({ ...e, [item.id]: { price: '', currency: item.final_quote_currency || 'USD', remarks: item.remarks || '' } }));
  };

  const saveItem = async (item: DeskItem) => {
    const e = editing[item.id];
    if (!e || !e.price) return;
    setSaving(item.id);
    const price = parseFloat(e.price);

    await supabase.from('price_request_items').update({
      final_quote_price: price,
      final_quote_currency: e.currency,
      remarks: e.remarks || null,
      final_entered_by: profile?.id || null,
      final_entered_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
    }).eq('id', item.id);

    await supabase.from('pricing_ledger').upsert({
      price_request_id: item.price_request_id,
      price_request_item_id: item.id,
      customer_name: item.pr?.customer_name || null,
      product_name: item.product_name,
      source_price: item.source_price,
      source_currency: item.source_currency,
      final_quoted_price: price,
      final_quote_currency: e.currency,
      target_price: item.target_price,
      competitor_price: item.competitor_price,
      remarks: e.remarks || null,
      created_by: profile?.id || null,
      quote_date: new Date().toISOString(),
      updated_at: new Date().toISOString(),
    }, { onConflict: 'price_request_item_id' });

    await supabase.from('communication_timeline').insert({
      price_request_id: item.price_request_id,
      event_type: 'final_price_entered',
      item_id: item.id,
      actor_id: profile?.id || null,
      actor_name: profile?.full_name || profile?.username || null,
      description: `Final quote entered for ${item.product_name}: ${e.currency} ${price.toLocaleString()}`,
      metadata: { final_quoted_price: price, currency: e.currency, source_price: item.source_price, source_currency: item.source_currency },
    });

    await recalcPriceRequestCounters(item.price_request_id);
    await notifyAssignedUser(item.price_request_id, item.product_name, price, e.currency);

    setDone(d => new Set([...d, item.id]));
    setEditing(e => { const n = { ...e }; delete n[item.id]; return n; });
    setSaving(null);
    setTimeout(() => { setDone(d => { const n = new Set(d); n.delete(item.id); return n; }); load(); }, 1200);
  };

  return (
    <Layout>
      <div className="p-4 md:p-6">
        <div className="mb-4">
          <h1 className="text-lg font-semibold text-gray-900">Pricing Desk</h1>
          <p className="text-xs text-gray-500 mt-0.5">Products with source price received — enter final USD quote</p>
        </div>

        <div className="bg-white border border-gray-200 rounded-lg overflow-hidden">
          {loading ? (
            <div className="py-16 text-center text-sm text-gray-400">Loading...</div>
          ) : items.length === 0 ? (
            <div className="py-16 text-center">
              <CheckCircle2 className="w-8 h-8 text-green-400 mx-auto mb-2" />
              <p className="text-sm text-gray-500">All caught up! No items waiting for final quote.</p>
            </div>
          ) : (
            <div className="overflow-x-auto">
              <table className="w-full">
                <thead className="bg-gray-50 border-b border-gray-200">
                  <tr>
                    {['PR #', 'Customer', 'Product', 'Spec', 'Qty', 'Source', 'Source Price', 'Target', 'Competitor', 'Remarks', 'Final Quote', ''].map(h => (
                      <th key={h} className="px-3 py-2.5 text-left text-xs font-medium text-gray-500 uppercase tracking-wider whitespace-nowrap">{h}</th>
                    ))}
                  </tr>
                </thead>
                <tbody className="divide-y divide-gray-100">
                  {items.map(item => {
                    const e = editing[item.id];
                    const isDone = done.has(item.id);
                    return (
                      <tr key={item.id} className={isDone ? 'bg-green-50' : 'hover:bg-gray-50'}>
                        <td className="px-3 py-2 text-xs font-medium text-blue-700 whitespace-nowrap">{item.pr?.pr_number || '-'}</td>
                        <td className="px-3 py-2 text-xs text-gray-700 max-w-[120px] truncate">{item.pr?.customer_name || '-'}</td>
                        <td className="px-3 py-2 text-xs font-medium text-gray-800 whitespace-nowrap">{item.product_name}</td>
                        <td className="px-3 py-2 text-xs text-gray-500 max-w-[100px] truncate">{item.specification || '-'}</td>
                        <td className="px-3 py-2 text-xs text-gray-600 whitespace-nowrap">{item.quantity ? `${item.quantity} ${item.unit || ''}` : '-'}</td>
                        <td className="px-3 py-2"><span className={`inline-flex px-1.5 py-0.5 rounded text-[10px] font-medium ${SOURCE_COLORS[item.source_type]}`}>{item.source_type}</span></td>
                        <td className="px-3 py-2 text-xs font-medium text-gray-800 whitespace-nowrap">
                          {item.source_price ? (
                            <span className="text-gray-800">{item.source_currency} {item.source_price.toLocaleString()}</span>
                          ) : (
                            <span className="text-gray-400">—</span>
                          )}
                        </td>
                        <td className="px-3 py-2 text-xs text-gray-500">{item.target_price ? `$${item.target_price}` : '-'}</td>
                        <td className="px-3 py-2 text-xs text-gray-500">{item.competitor_price ? `$${item.competitor_price}` : '-'}</td>
                        <td className="px-3 py-2 text-xs text-gray-500 max-w-[120px] truncate" title={item.remarks || ''}>{item.remarks || '-'}</td>
                        <td className="px-3 py-2 whitespace-nowrap">
                          {isDone ? (
                            <span className="text-xs text-green-600 font-medium flex items-center gap-1"><CheckCircle2 className="w-3 h-3" /> Saved</span>
                          ) : e ? (
                            <div className="flex gap-1">
                              <select value={e.currency} onChange={ev => setEditing(ed => ({ ...ed, [item.id]: { ...ed[item.id], currency: ev.target.value } }))} className="border border-gray-300 rounded px-1 py-0.5 text-xs w-14">
                                {['USD', 'IDR', 'INR', 'CNY'].map(c => <option key={c} value={c}>{c}</option>)}
                              </select>
                              <MoneyInput autoFocus value={Number(e.price) || 0} onChange={amount => setEditing(ed => ({ ...ed, [item.id]: { ...ed[item.id], price: String(amount) } }))}
                                onKeyDown={ev => { if (ev.key === 'Enter') saveItem(item); if (ev.key === 'Escape') setEditing(ed => { const n = { ...ed }; delete n[item.id]; return n; }); }}
                                placeholder="Price" className="w-24 border border-blue-400 rounded px-2 py-0.5 text-xs focus:outline-none focus:ring-1 focus:ring-blue-500" maximumFractionDigits={4} />
                            </div>
                          ) : (
                            <button onClick={() => startEdit(item)} className="text-xs text-blue-600 hover:text-blue-700 font-medium">Enter price</button>
                          )}
                        </td>
                        <td className="px-3 py-2">
                          {e && !isDone && (
                            <button onClick={() => saveItem(item)} disabled={saving === item.id || !e.price} className="flex items-center gap-1 px-2.5 py-1 text-xs bg-blue-600 text-white rounded hover:bg-blue-700 disabled:opacity-50">
                              <Save className="w-3 h-3" /> {saving === item.id ? '...' : 'Save'}
                            </button>
                          )}
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          )}
        </div>
      </div>
    </Layout>
  );
}
