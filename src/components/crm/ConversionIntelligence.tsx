import { useEffect, useMemo, useState } from 'react';
import { supabase } from '../../lib/supabase';
import { AlertTriangle } from 'lucide-react';

type Row = {
  key: string; customer: string; product: string; inquiryCount: number; quoteCount: number; orderCount: number;
  lastInquiry?: string; lastQuote?: string; lastOrder?: string; lastOffered?: number | null; lastSold?: number | null;
  available: number | null; followUps: number; daysSinceActivity: number; signals: string[];
};

const asDate = (value?: string | null) => value ? new Date(value).getTime() : 0;
const dayDiff = (value?: string | null) => value ? Math.max(0, Math.floor((Date.now() - asDate(value)) / 86400000)) : 9999;

export function ConversionIntelligence() {
  const [rows, setRows] = useState<Row[]>([]);
  const [loading, setLoading] = useState(true);
  const [onlyNeverBought, setOnlyNeverBought] = useState(false);
  const [filter, setFilter] = useState('');

  useEffect(() => {
    const load = async () => {
      setLoading(true);
      const [{ data: inquiries }, { data: products }, { data: invoiceItems }, { data: orderItems }, { data: reminders }] = await Promise.all([
        supabase.from('crm_inquiries').select('id,customer_id,company_name,product_name,created_at,pipeline_status,status,price_quoted,quote_status,quote_sent_at,offered_price,coa_required,sample_required,converted_to_order'),
        supabase.from('products').select('id,product_name').eq('is_active', true),
        supabase.from('sales_invoice_items').select('product_id,unit_price,quantity,sales_invoices!inner(customer_id,invoice_date)').order('created_at', { ascending: false }),
        supabase.from('sales_order_items').select('product_id,unit_price,quantity,sales_orders!inner(customer_id,so_date,status)').order('created_at', { ascending: false }),
        supabase.from('crm_reminders').select('inquiry_id,created_at,is_completed').order('created_at', { ascending: false }),
      ]);
      const byProductName = new Map<string, any[]>();
      (products || []).forEach((p: any) => { const key = p.product_name.trim().toLowerCase(); byProductName.set(key, [...(byProductName.get(key) || []), p]); });
      const matchedIds = [...new Set((inquiries || []).flatMap((i: any) => (byProductName.get((i.product_name || '').trim().toLowerCase()) || []).length === 1 ? [byProductName.get((i.product_name || '').trim().toLowerCase())![0].id] : []))];
      const { data: batches } = matchedIds.length ? await supabase.from('batches').select('product_id,current_stock,reserved_stock').in('product_id', matchedIds).eq('is_active', true) : { data: [] };
      const availability = new Map<string, number>();
      (batches || []).forEach((b: any) => availability.set(b.product_id, (availability.get(b.product_id) || 0) + Math.max(0, Number(b.current_stock || 0) - Number(b.reserved_stock || 0))));
      const reminderCount = new Map<string, number>();
      (reminders || []).forEach((r: any) => { if (r.inquiry_id) reminderCount.set(r.inquiry_id, (reminderCount.get(r.inquiry_id) || 0) + 1); });
      const groups = new Map<string, any[]>();
      (inquiries || []).forEach((i: any) => { if (!i.customer_id) return; const key = `${i.customer_id}:${(i.product_name || '').trim().toLowerCase()}`; groups.set(key, [...(groups.get(key) || []), i]); });
      const output: Row[] = [...groups.entries()].map(([key, group]) => {
        const newest = [...group].sort((a, b) => asDate(b.created_at) - asDate(a.created_at))[0];
        const name = newest.company_name;
        const productsForName = byProductName.get((newest.product_name || '').trim().toLowerCase()) || [];
        const productId = productsForName.length === 1 ? productsForName[0].id : null;
        const customerId = newest.customer_id;
        const inv = (invoiceItems || []).filter((x: any) => x.product_id === productId && x.sales_invoices?.customer_id === customerId);
        const orders = (orderItems || []).filter((x: any) => x.product_id === productId && x.sales_orders?.customer_id === customerId);
        // A target/internal price is not a customer quote. Only an explicit sent
        // quote (or a recorded quote timestamp) counts as quoted/waiting.
        const quoted = group.filter((i: any) => Boolean(i.quote_sent_at) || ['sent', 'follow_up_due'].includes((i.quote_status || '').toLowerCase()));
        const lastInquiryValues = group.map((i: any) => i.created_at).sort();
        const lastQuoteValues = quoted.map((i: any) => i.quote_sent_at || i.created_at).sort();
        const lastOrderValues = orders.map((i: any) => i.sales_orders?.so_date).filter(Boolean).sort();
        const lastInquiry = lastInquiryValues[lastInquiryValues.length - 1];
        const lastQuote = lastQuoteValues[lastQuoteValues.length - 1];
        const lastOrder = lastOrderValues[lastOrderValues.length - 1];
        const lastOffered = [...group].sort((a, b) => asDate(b.created_at) - asDate(a.created_at)).find((i: any) => i.offered_price != null)?.offered_price ?? null;
        const lastSold = inv[0]?.unit_price ?? null;
        const followUps = group.reduce((sum: number, i: any) => sum + (reminderCount.get(i.id) || 0), 0);
        const daysSinceActivity = dayDiff(lastQuote || lastInquiry);
        const signals = [
          ...(group.length >= 2 && orders.length === 0 ? ['Repeated inquiries, no order'] : []),
          ...(quoted.length >= 2 && orders.length === 0 ? ['Repeated quotes, no order'] : []),
          ...(group.some((i: any) => (i.coa_required || i.sample_required)) && orders.length === 0 ? ['COA/sample requested, no order'] : []),
          ...(productId && (availability.get(productId) || 0) <= 0 ? ['Product unavailable'] : []),
          ...(daysSinceActivity > 14 && orders.length === 0 ? ['Long follow-up gap'] : []),
        ];
        return { key, customer: name, product: newest.product_name, inquiryCount: group.length, quoteCount: quoted.length, orderCount: orders.length, lastInquiry, lastQuote, lastOrder, lastOffered, lastSold, available: productId ? availability.get(productId) || 0 : null, followUps, daysSinceActivity, signals };
      });
      setRows(output.sort((a, b) => b.signals.length - a.signals.length || b.daysSinceActivity - a.daysSinceActivity));
      setLoading(false);
    };
    load();
  }, []);
  const visible = useMemo(() => rows.filter(r => (!onlyNeverBought || r.orderCount === 0) && `${r.customer} ${r.product}`.toLowerCase().includes(filter.toLowerCase())), [rows, onlyNeverBought, filter]);
  return <div className="space-y-3"><div className="flex flex-wrap items-center gap-2"><div><h2 className="text-lg font-semibold">Conversion Intelligence</h2><p className="text-sm text-gray-600">Evidence only. Signals are prompts for review, never confirmed reasons.</p></div><label className="ml-auto flex items-center gap-2 text-sm"><input type="checkbox" checked={onlyNeverBought} onChange={e => setOnlyNeverBought(e.target.checked)} />Asked but never bought</label><input value={filter} onChange={e => setFilter(e.target.value)} placeholder="Customer or product" className="border rounded px-2 py-1 text-sm" /></div>
    {loading ? <div className="text-sm text-gray-500">Loading CRM intelligence…</div> : <div className="overflow-auto border rounded-lg"><table className="min-w-full text-sm"><thead className="bg-gray-50 text-xs text-gray-500"><tr><th className="p-2 text-left">Customer / Product</th><th>Inq</th><th>Quotes</th><th>Orders</th><th>Last offer</th><th>Last sold</th><th>Available</th><th>Follow-ups</th><th>Signals</th></tr></thead><tbody>{visible.map(r => <tr key={r.key} className="border-t align-top"><td className="p-2"><div className="font-medium">{r.customer}</div><div className="text-xs text-gray-600">{r.product} · last inquiry {r.lastInquiry ? new Date(r.lastInquiry).toLocaleDateString() : '-'}</div></td><td className="text-center">{r.inquiryCount}</td><td className="text-center">{r.quoteCount}</td><td className="text-center">{r.orderCount}</td><td className="text-right px-2">{r.lastOffered == null ? '-' : r.lastOffered.toLocaleString()}</td><td className="text-right px-2">{r.lastSold == null ? '-' : r.lastSold.toLocaleString()}</td><td className="text-center">{r.available == null ? 'Unmatched' : r.available.toLocaleString()}</td><td className="text-center">{r.followUps}</td><td className="p-2">{r.signals.length ? r.signals.map(s => <div key={s} className="text-xs text-amber-700 flex gap-1"><AlertTriangle className="w-3 h-3 mt-0.5" />{s}</div>) : <span className="text-xs text-gray-400">No signal</span>}</td></tr>)}{visible.length === 0 && <tr><td colSpan={9} className="p-6 text-center text-gray-500">No evidence rows match this view.</td></tr>}</tbody></table></div>}</div>;
}
