import { useEffect, useMemo, useState } from 'react';
import { supabase } from '../../lib/supabase';
import { Phone, Mail, Clock3 } from 'lucide-react';
import { showToast } from '../ToastNotification';

type CustomerRow = { id: string; company_name: string; contact_person?: string | null; email?: string | null; phone?: string | null };
type CustomerIntel = CustomerRow & { erp?: any; inquiries: any[]; orders: any[]; deliveries: any[]; invoices: any[]; items: any[]; reminders: any[]; activities: any[]; lastPurchase: string | null; outstanding: number; purchaseFrequencyDays: number | null };

const daysSince = (date: string | null) => date ? Math.max(0, Math.floor((Date.now() - new Date(date).getTime()) / 86400000)) : null;

export function Customer360Panel() {
  const [rows, setRows] = useState<CustomerIntel[]>([]);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [filter, setFilter] = useState('');

  const load = async () => {
    setLoading(true);
    try {
      // The ERP customer master owns this view's default list. CRM contacts are
      // optional relationship records, so a CRM-contact query failure must not
      // hide the ERP customers that users need to work with.
      const [{ data: customers, error: customersError }, contactsResult] = await Promise.all([
        supabase.from('customers').select('id,company_name,contact_person,email,phone').eq('is_active', true).order('company_name'),
        supabase.from('crm_contacts').select('id,company_name,contact_person,email,phone').eq('is_active', true).order('company_name'),
      ]);
      if (customersError) throw customersError;
      if (contactsResult.error) console.warn('Customer 360 CRM contacts unavailable:', contactsResult.error.message);
      const contacts = contactsResult.data || [];
      const erpIds = (customers || []).map((erp: any) => erp.id);
      const [{ data: inquiries }, { data: orders }, { data: deliveries }, { data: invoices }] = await Promise.all([
        erpIds.length ? supabase.from('crm_inquiries').select('id,crm_contact_id,customer_id,product_name,quantity,offered_price,created_at,pipeline_status,status').in('customer_id', erpIds) : Promise.resolve({ data: [] }),
        erpIds.length ? supabase.from('sales_orders').select('id,customer_id,so_number,status,so_date,created_at,total_amount').in('customer_id', erpIds).order('created_at', { ascending: false }) : Promise.resolve({ data: [] }),
        erpIds.length ? supabase.from('delivery_challans').select('id,customer_id,challan_number,challan_date,approval_status').in('customer_id', erpIds).order('challan_date', { ascending: false }) : Promise.resolve({ data: [] }),
        erpIds.length ? supabase.from('sales_invoices').select('id,customer_id,invoice_number,invoice_date,total_amount,paid_amount,payment_status').in('customer_id', erpIds).order('invoice_date', { ascending: false }) : Promise.resolve({ data: [] }),
      ]);
      // Explicit link only: crm_inquiries.customer_id (ERP) + crm_contact_id (CRM).
      // crm_contacts has no erp_customer_id column; names are not auto-linked.
      const contactsById = new Map((contacts || []).map((c: any) => [c.id, c]));
      const contactByCustomerId = new Map<string, any>();
      (inquiries || []).forEach((inquiry: any) => {
        if (!inquiry.customer_id || !inquiry.crm_contact_id || contactByCustomerId.has(inquiry.customer_id)) return;
        const linked = contactsById.get(inquiry.crm_contact_id);
        if (linked) contactByCustomerId.set(inquiry.customer_id, linked);
      });
      const contactRows = (customers || []).map((erp: any) => {
        const linked = contactByCustomerId.get(erp.id);
        return { ...(linked || {}), id: linked?.id || `erp-${erp.id}`, company_name: erp.company_name, contact_person: linked?.contact_person || erp.contact_person, email: linked?.email || erp.email, phone: linked?.phone || erp.phone, erp };
      });
      const invoiceIds = (invoices || []).map((i: any) => i.id);
      const contactIds = (contacts || []).map((c: any) => c.id);
      const [{ data: items }, { data: reminders }, { data: activities }] = await Promise.all([
        invoiceIds.length ? supabase.from('sales_invoice_items').select('invoice_id,product_id,quantity,unit_price,products(product_name)').in('invoice_id', invoiceIds) : Promise.resolve({ data: [] }),
        supabase.from('crm_reminders').select('id,inquiry_id,title,due_date,is_completed,created_at').order('due_date', { ascending: false }),
        contactIds.length ? supabase.from('crm_activities').select('id,customer_id,subject,activity_type,created_at,is_completed').in('customer_id', contactIds).order('created_at', { ascending: false }) : Promise.resolve({ data: [] }),
      ]);
      setRows(contactRows.map((c: any) => {
        const ci = (inquiries || []).filter((i: any) => i.customer_id === c.erp?.id || i.crm_contact_id === c.id);
        const co = (orders || []).filter((o: any) => o.customer_id === c.erp?.id);
        const dc = (deliveries || []).filter((d: any) => d.customer_id === c.erp?.id);
        const inv = (invoices || []).filter((i: any) => i.customer_id === c.erp?.id);
        const invoiceItems = (items || []).filter((i: any) => inv.some((invoice: any) => invoice.id === i.invoice_id));
        const inquiryIds = new Set(ci.map((i: any) => i.id));
        const crmReminders = (reminders || []).filter((r: any) => inquiryIds.has(r.inquiry_id));
        const crmActivities = (activities || []).filter((a: any) => a.customer_id === c.id);
        const lastPurchase = inv[0]?.invoice_date || null;
        const purchaseIntervals = inv.slice(0, 6).map((invoice: any, index: number) => index > 0 ? Math.abs(new Date(inv[index - 1].invoice_date).getTime() - new Date(invoice.invoice_date).getTime()) / 86400000 : null).filter(Boolean) as number[];
        const purchaseFrequencyDays = purchaseIntervals.length ? Math.round(purchaseIntervals.reduce((a, b) => a + b, 0) / purchaseIntervals.length) : null;
        const outstanding = inv.reduce((sum: number, i: any) => sum + Math.max(0, Number(i.total_amount || 0) - Number(i.paid_amount || 0)), 0);
        return { ...c, inquiries: ci, orders: co, deliveries: dc, invoices: inv, items: invoiceItems, reminders: crmReminders, activities: crmActivities, lastPurchase, outstanding, purchaseFrequencyDays };
      }));
    } catch (e: any) {
      showToast({ type: 'error', title: 'Customer 360', message: e.message || 'Unable to load customer intelligence.' });
    } finally { setLoading(false); }
  };
  useEffect(() => { load(); }, []);
  const visible = useMemo(() => rows.filter(r => r.company_name.toLowerCase().includes(filter.toLowerCase())), [rows, filter]);
  const selected = visible.find(r => r.id === selectedId) || visible[0];
  const inactivity = selected ? daysSince(selected.lastPurchase) : null;
  return <div className="grid lg:grid-cols-3 gap-3">
    <div className="bg-white border rounded-lg p-3">
      <div className="flex items-center justify-between mb-2"><h3 className="font-semibold">Customer 360</h3><button onClick={load} className="text-xs text-blue-600">Refresh</button></div>
      <input value={filter} onChange={e => setFilter(e.target.value)} placeholder="Search customer" className="w-full border rounded px-2 py-1 text-sm mb-2" />
      <div className="space-y-1 max-h-[65vh] overflow-auto">{visible.map(r => { const d = daysSince(r.lastPurchase); const relationship = !r.invoices.length ? 'Never purchased' : d !== null && d >= 30 ? `Inactive customer · ${d}d` : 'Active customer'; return <button key={r.id} onClick={() => setSelectedId(r.id)} className={`w-full text-left border rounded p-2 ${selected?.id === r.id ? 'border-blue-500 bg-blue-50' : 'border-gray-200'}`}><div className="font-medium text-sm">{r.company_name}</div><div className="text-xs text-gray-500">{r.erp ? 'ERP linked' : 'CRM prospect'} · {relationship}</div></button>; })}</div>
    </div>
    <div className="lg:col-span-2 bg-white border rounded-lg p-4">{loading ? <div className="text-sm text-gray-500">Loading customer intelligence…</div> : !selected ? <div className="text-sm text-gray-500">No customers found.</div> : <>
      <div className="flex items-start justify-between"><div><h2 className="text-lg font-semibold">{selected.company_name}</h2><p className="text-sm text-gray-600">{selected.contact_person || 'No contact'} · {selected.email || 'No email'}</p></div><div className="flex gap-1">{selected.phone && <a href={`tel:${selected.phone}`} className="p-2 border rounded" title="Call"><Phone className="w-4 h-4" /></a>}{selected.email && <a href={`mailto:${selected.email}`} className="p-2 border rounded" title="Email"><Mail className="w-4 h-4" /></a>}</div></div>
      <div className="grid sm:grid-cols-5 gap-2 mt-4"><div className="border rounded p-2"><div className="text-xs text-gray-500">Inquiries</div><div className="text-lg font-semibold">{selected.inquiries.length}</div></div><div className="border rounded p-2"><div className="text-xs text-gray-500">Open SOs</div><div className="text-lg font-semibold">{selected.orders.filter((o: any) => !['closed','cancelled','rejected'].includes(o.status)).length}</div></div><div className="border rounded p-2"><div className="text-xs text-gray-500">Deliveries</div><div className="text-lg font-semibold">{selected.deliveries.length}</div></div><div className="border rounded p-2"><div className="text-xs text-gray-500">Invoices</div><div className="text-lg font-semibold">{selected.invoices.length}</div></div><div className="border rounded p-2"><div className="text-xs text-gray-500">Outstanding</div><div className="text-lg font-semibold">Rp {selected.outstanding.toLocaleString('id-ID')}</div></div></div>
      {!selected.erp && <div className="mt-3 bg-amber-50 border border-amber-200 rounded p-2 text-sm text-amber-800">This CRM contact is not linked to an ERP customer. Use Inquiry 360 → Promote / Link Customer after confirming identity.</div>}
      {!selected.invoices.length && <div className="mt-3 bg-slate-50 border border-slate-200 rounded p-2 text-sm text-slate-800">Never purchased. {selected.inquiries.length ? `${selected.inquiries.length} ${selected.inquiries.length === 1 ? 'inquiry' : 'inquiries'} provides a potential conversion opportunity.` : 'No purchase history is recorded.'}</div>}
      {selected.invoices.length > 0 && inactivity !== null && inactivity >= 30 && <div className={`mt-3 rounded p-2 text-sm ${inactivity >= 90 ? 'bg-red-50 text-red-800 border border-red-200' : 'bg-amber-50 text-amber-800 border border-amber-200'}`}><Clock3 className="inline w-4 h-4 mr-1" />Inactive customer: no order for {inactivity} days. Consider a call or follow-up.</div>}
      {selected.purchaseFrequencyDays && inactivity !== null && inactivity >= selected.purchaseFrequencyDays && <div className="mt-2 bg-blue-50 border border-blue-200 rounded p-2 text-sm text-blue-900">Customer may be due for reorder. Typical purchase interval: {selected.purchaseFrequencyDays} days.</div>}
      <div className="grid md:grid-cols-2 gap-3 mt-4"><div><h3 className="font-medium text-sm mb-1">Products bought / last price</h3>{selected.items.slice(0, 8).map((i: any, n: number) => <div key={`${i.invoice_id}-${n}`} className="text-xs border-b py-1">{i.products?.product_name || 'Product'} · {i.quantity} · Rp {Number(i.unit_price || 0).toLocaleString('id-ID')}</div>)}{!selected.items.length && <div className="text-xs text-gray-500">No invoice-line history.</div>}</div><div><h3 className="font-medium text-sm mb-1">Recent activity / follow-ups</h3>{[...selected.activities, ...selected.reminders].sort((a: any,b: any) => +new Date(b.created_at || b.due_date) - +new Date(a.created_at || a.due_date)).slice(0, 8).map((a: any) => <div key={a.id} className="text-xs border-b py-1">{a.subject || a.title} · {new Date(a.created_at || a.due_date).toLocaleDateString()}</div>)}{!selected.activities.length && !selected.reminders.length && <div className="text-xs text-gray-500">No CRM activity recorded.</div>}</div></div>
    </>}</div>
  </div>;
}
