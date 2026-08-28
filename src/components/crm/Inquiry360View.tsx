import { useEffect, useMemo, useState } from 'react';
import { supabase } from '../../lib/supabase';
import { useNavigation } from '../../contexts/NavigationContext';
import { Modal } from '../Modal';
import { EmailComposer } from './EmailComposer';
import { Mail, Plus, UserRoundCheck, CalendarPlus } from 'lucide-react';
import { showToast } from '../ToastNotification';

type Inquiry = {
  id: string;
  inquiry_number: string;
  company_name: string;
  product_name: string;
  specification?: string | null;
  quantity?: string | null;
  status: string;
  pipeline_status?: string | null;
  inquiry_date: string;
  contact_person?: string | null;
  contact_email?: string | null;
  contact_phone?: string | null;
  supplier_name?: string | null;
  offered_price?: number | null;
  offered_price_currency?: string | null;
  delivery_date?: string | null;
  delivery_terms?: string | null;
  coa_required?: boolean | null;
  sample_required?: boolean | null;
  assigned_to?: string | null;
  customer_id?: string | null;    // FK to customers (ERP) — only when promoted
  crm_contact_id?: string | null; // FK to crm_contacts — the CRM prospect link
  converted_to_order?: string | null;
};

type TimelineItem = { id: string; type: 'activity' | 'email' | 'document' | 'reminder' | 'order'; title: string; detail?: string | null; at: string; };

type Reminder = { id: string; title: string; due_date: string; is_completed: boolean; };
type Email = { id: string; subject: string | null; from_email: string | null; to_email: string[] | string | null; sent_date: string | null; created_at: string; };

type StatusKey = 'new' | 'in_progress' | 'quoted' | 'follow_up_due' | 'won' | 'lost' | 'no_reply';

const statusChipMap: Record<StatusKey, string> = {
  new: 'bg-slate-100 text-slate-700',
  in_progress: 'bg-blue-100 text-blue-700',
  quoted: 'bg-indigo-100 text-indigo-700',
  follow_up_due: 'bg-amber-100 text-amber-700',
  won: 'bg-green-100 text-green-700',
  lost: 'bg-red-100 text-red-700',
  no_reply: 'bg-zinc-200 text-zinc-700',
};

const normalizeStatus = (status: string | null | undefined): StatusKey => {
  const s = (status || '').toLowerCase();
  if (['new'].includes(s)) return 'new';
  if (['won', 'po_received'].includes(s)) return 'won';
  if (['lost'].includes(s)) return 'lost';
  if (['price_quoted', 'quoted'].includes(s)) return 'quoted';
  if (['follow_up', 'negotiation'].includes(s)) return 'follow_up_due';
  if (['no_reply'].includes(s)) return 'no_reply';
  return 'in_progress';
};

const prettyStatus = (s: StatusKey) => s.replaceAll('_', ' ').replace(/\b\w/g, (m) => m.toUpperCase());

export function Inquiry360View({ inquiries }: { inquiries: Inquiry[] }) {
  const { setCurrentPage, setNavigationData } = useNavigation();
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [timeline, setTimeline] = useState<TimelineItem[]>([]);
  const [nextFollowUp, setNextFollowUp] = useState<string | null>(null);
  const [lastContactAt, setLastContactAt] = useState<string | null>(null);
  const [emails, setEmails] = useState<Email[]>([]);
  const [reminders, setReminders] = useState<Reminder[]>([]);
  const [orders, setOrders] = useState<any[]>([]);
  const [invoices, setInvoices] = useState<any[]>([]);
  const [documents, setDocuments] = useState<any[]>([]);
  const [requirements, setRequirements] = useState<any[]>([]);
  const [assigneeName, setAssigneeName] = useState<string>('Unassigned');
  const [productAvailability, setProductAvailability] = useState<{ matched: boolean; available: number; batches: number } | null>(null);
  const [emailOpen, setEmailOpen] = useState(false);
  const [promoting, setPromoting] = useState(false);

  const [filters, setFilters] = useState({ customer: '', product: '', status: 'all', assigned: '', nextDate: '' });

  const filteredInquiries = useMemo(() => inquiries.filter((i) => {
    const status = normalizeStatus(i.pipeline_status || i.status);
    if (filters.customer && !i.company_name.toLowerCase().includes(filters.customer.toLowerCase())) return false;
    if (filters.product && !i.product_name.toLowerCase().includes(filters.product.toLowerCase())) return false;
    if (filters.status !== 'all' && status !== filters.status) return false;
    if (filters.assigned && !(i.assigned_to || '').toLowerCase().includes(filters.assigned.toLowerCase())) return false;
    return true;
  }), [inquiries, filters]);

  const selected = useMemo(() => filteredInquiries.find(i => i.id === selectedId) || filteredInquiries[0], [filteredInquiries, selectedId]);

  useEffect(() => { if (filteredInquiries.length && !selectedId) setSelectedId(filteredInquiries[0].id); }, [filteredInquiries, selectedId]);

  useEffect(() => {
    const run = async () => {
      if (!selected?.id) return;
      // Two different FKs live on an inquiry:
      //   * crm_contact_id → crm_contacts   (CRM activities scope by this)
      //   * customer_id    → customers      (ERP: sales_orders, invoices, IRs)
      const crmContactId = selected.crm_contact_id;
      const erpCustomerId = selected.customer_id;
      const [activitiesRes, emailsRes, remindersRes, docsRes, ordersRes, invoicesRes, requirementsRes, assigneeRes] = await Promise.all([
        crmContactId
          ? supabase.from('crm_activities').select('id,subject,description,follow_up_date,created_at,activity_type').eq('customer_id', crmContactId).order('created_at', { ascending: false }).limit(80)
          : Promise.resolve({ data: [], error: null }),
        supabase.from('crm_email_activities').select('id,subject,from_email,to_email,sent_date,created_at').eq('inquiry_id', selected.id).order('created_at', { ascending: false }).limit(80),
        supabase.from('crm_reminders').select('id,title,due_date,is_completed').eq('inquiry_id', selected.id).order('due_date', { ascending: true }),
        supabase.from('crm_product_documents').select('id,document_type,display_file_name,created_at').eq('inquiry_id', selected.id).order('created_at', { ascending: false }).limit(80),
        erpCustomerId
          ? supabase.from('sales_orders').select('id,so_number,created_at,status').eq('customer_id', erpCustomerId).limit(20)
          : Promise.resolve({ data: [], error: null }),
        erpCustomerId
          ? supabase.from('sales_invoices').select('id,invoice_number,created_at,payment_status').eq('customer_id', erpCustomerId).limit(20)
          : Promise.resolve({ data: [], error: null }),
        erpCustomerId
          ? supabase.from('import_requirements').select('id,status,created_at').eq('customer_id', erpCustomerId).limit(20)
          : Promise.resolve({ data: [], error: null }),
        selected.assigned_to ? supabase.from('user_profiles').select('full_name').eq('id', selected.assigned_to).maybeSingle() : Promise.resolve({ data: null, error: null }),
      ]);

      const activityRows = activitiesRes.data || [];
      const emailRows = emailsRes.data || [];
      const reminderRows = remindersRes.data || [];
      const docRows = docsRes.data || [];
      setEmails(emailRows as Email[]);
      setReminders(reminderRows as Reminder[]);
      setOrders(ordersRes.data || []);
      setInvoices(invoicesRes.data || []);
      setDocuments(docRows || []);
      setRequirements(requirementsRes.data || []);
      setAssigneeName((assigneeRes as any)?.data?.full_name || 'Unassigned');

      const { data: matchedProducts } = await supabase.from('products').select('id').ilike('product_name', selected.product_name.trim()).limit(2);
      if ((matchedProducts || []).length === 1) {
        const { data: batches } = await supabase.from('batches').select('current_stock,reserved_stock').eq('product_id', matchedProducts![0].id).eq('is_active', true);
        setProductAvailability({ matched: true, available: (batches || []).reduce((sum: number, b: any) => sum + Math.max(0, Number(b.current_stock || 0) - Number(b.reserved_stock || 0)), 0), batches: (batches || []).length });
      } else {
        setProductAvailability({ matched: false, available: 0, batches: 0 });
      }

      const timelineItems: TimelineItem[] = [
        ...activityRows.map((a: any) => ({ id: a.id, type: 'activity' as const, title: a.subject || a.activity_type || 'Activity', detail: a.description, at: a.created_at })),
        ...emailRows.map((e: any) => ({ id: e.id, type: 'email' as const, title: e.subject || 'Email', detail: `${e.from_email || ''}`, at: e.sent_date || e.created_at })),
        ...docRows.map((d: any) => ({ id: d.id, type: 'document' as const, title: `${d.document_type}: ${d.display_file_name}`, at: d.created_at })),
        ...reminderRows.map((r: any) => ({ id: r.id, type: 'reminder' as const, title: r.title, detail: r.is_completed ? 'Completed' : 'Pending', at: r.due_date })),
        ...(ordersRes.data || []).map((o: any) => ({ id: o.id, type: 'order' as const, title: `SO ${o.so_number}`, detail: o.status, at: o.created_at })),
        ...(invoicesRes.data || []).map((o: any) => ({ id: o.id, type: 'order' as const, title: `Invoice ${o.invoice_number}`, detail: o.payment_status, at: o.created_at })),
      ].sort((a, b) => +new Date(b.at) - +new Date(a.at));

      setTimeline(timelineItems);
      const upcoming = reminderRows.filter((r: any) => !r.is_completed).map((r: any) => r.due_date).sort()[0] || null;
      setNextFollowUp(upcoming);
      const lastTouch = [...activityRows.map((a: any) => a.created_at), ...emailRows.map((e: any) => e.sent_date || e.created_at)].sort().reverse()[0] || null;
      setLastContactAt(lastTouch);
    };
    run();

    const channel = supabase.channel(`inquiry-360-${selected?.id}`)
      .on('postgres_changes', { event: '*', schema: 'public', table: 'crm_email_activities', filter: `inquiry_id=eq.${selected?.id}` }, run)
      .on('postgres_changes', { event: '*', schema: 'public', table: 'crm_reminders', filter: `inquiry_id=eq.${selected?.id}` }, run)
      .on('postgres_changes', { event: '*', schema: 'public', table: 'crm_inquiries', filter: `id=eq.${selected?.id}` }, run)
      .subscribe();

    return () => { supabase.removeChannel(channel); };
  }, [selected?.id]);

  const overdue = nextFollowUp ? new Date(nextFollowUp) < new Date() : false;
  const possibleSignals = selected ? [
    ...(orders.length === 0 && ['quoted', 'price_quoted'].includes((selected.pipeline_status || selected.status || '').toLowerCase()) ? ['Repeated/quoted inquiry has no linked order yet'] : []),
    ...(selected.coa_required && documents.length === 0 ? ['COA requested; no linked document is recorded'] : []),
    ...(selected.sample_required && documents.length === 0 ? ['Sample requested; no linked document is recorded'] : []),
    ...(productAvailability?.matched && productAvailability.available <= 0 ? ['Matched product has no available stock'] : []),
    ...(lastContactAt && (Date.now() - new Date(lastContactAt).getTime()) / 86400000 > 14 ? ['More than 14 days since recorded customer activity'] : []),
  ] : [];

  const createReminder = async () => {
    if (!selected) return;
    const due = new Date();
    due.setDate(due.getDate() + 1);
    const { data: auth } = await supabase.auth.getUser();
    if (!auth.user) return;
    const { error } = await supabase.from('crm_reminders').insert({
      inquiry_id: selected.id,
      reminder_type: 'follow_up',
      title: `Follow up: ${selected.company_name} — ${selected.product_name}`,
      description: `Review inquiry ${selected.inquiry_number} and contact the customer.`,
      due_date: due.toISOString(),
      assigned_to: selected.assigned_to || auth.user.id,
      created_by: auth.user.id,
    });
    if (error) {
      showToast({ type: 'error', title: 'Reminder', message: error.message });
      return;
    }
    showToast({ type: 'success', title: 'Reminder created', message: 'Follow-up added for tomorrow.' });
    setNextFollowUp(due.toISOString());
  };

  const promoteOrLinkCustomer = async () => {
    if (!selected || promoting) return;
    setPromoting(true);
    try {
      const contactId = selected.crm_contact_id;
      const { data: matches, error: matchError } = await supabase
        .from('customers')
        .select('id,company_name,contact_person,email,phone,address,city,country')
        .ilike('company_name', selected.company_name.trim());
      if (matchError) throw matchError;
      if ((matches || []).length > 1) {
        showToast({ type: 'error', title: 'Manual review required', message: 'More than one ERP customer matches this company name.' });
        return;
      }
      const customerId = matches?.[0]?.id;
      if (!customerId) {
        // CRM contacts remain CRM-only until an employee selects or creates
        // an ERP customer through the dedicated customer workflow. Do not
        // silently create or merge an ERP billing master from an inquiry.
        showToast({ type: 'error', title: 'Manual review required', message: 'No unambiguous ERP customer match was found. Keep this inquiry in CRM and link it after confirming the customer master.' });
        return;
      }
      const { error: inquiryError } = await supabase.from('crm_inquiries').update({ customer_id: customerId }).eq('id', selected.id);
      if (inquiryError) throw inquiryError;
      if (contactId) {
        await supabase.from('crm_inquiries').update({ customer_id: customerId }).eq('crm_contact_id', contactId).is('customer_id', null);
      }
      showToast({ type: 'success', title: 'Customer linked', message: 'This inquiry now uses the explicit ERP customer link.' });
    } catch (error: any) {
      showToast({ type: 'error', title: 'Customer link failed', message: error.message || 'Please review the customer master.' });
    } finally {
      setPromoting(false);
    }
  };

  const createSalesOrder = () => {
    if (!selected?.customer_id) return;
    setNavigationData({
      createSalesOrder: true,
      salesOrderPrefill: {
        inquiry_id: selected.id,
        customer_id: selected.customer_id,
        product_name: selected.product_name,
        quantity: Number(selected.quantity) || 1,
        unit_price: Number(selected.offered_price) || 0,
        quoted_usd_unit_price: selected.offered_price_currency === 'USD' ? Number(selected.offered_price) || null : null,
        expected_delivery_date: selected.delivery_date || '',
        notes: `Created from inquiry ${selected.inquiry_number}${selected.delivery_terms ? ` · ${selected.delivery_terms}` : ''}`,
      },
    });
    setCurrentPage('sales-orders');
  };

  return <div className="space-y-3">
    <div className="grid grid-cols-1 md:grid-cols-5 gap-2 bg-white border rounded-lg p-2">
      <input className="border rounded px-2 py-1 text-sm" placeholder="Customer" value={filters.customer} onChange={(e) => setFilters({ ...filters, customer: e.target.value })} />
      <input className="border rounded px-2 py-1 text-sm" placeholder="Product" value={filters.product} onChange={(e) => setFilters({ ...filters, product: e.target.value })} />
      <select className="border rounded px-2 py-1 text-sm" value={filters.status} onChange={(e) => setFilters({ ...filters, status: e.target.value })}>
        <option value="all">All Status</option><option value="new">New</option><option value="in_progress">In Progress</option><option value="quoted">Quoted</option><option value="follow_up_due">Follow-up Due</option><option value="won">Won</option><option value="lost">Lost</option><option value="no_reply">No Reply</option>
      </select>
      <input className="border rounded px-2 py-1 text-sm" placeholder="Assigned user id" value={filters.assigned} onChange={(e) => setFilters({ ...filters, assigned: e.target.value })} />
      <input type="date" className="border rounded px-2 py-1 text-sm" value={filters.nextDate} onChange={(e) => setFilters({ ...filters, nextDate: e.target.value })} />
    </div>

    <div className="grid grid-cols-1 lg:grid-cols-3 gap-3">
      <div className="bg-white border rounded-xl p-3 max-h-[72vh] overflow-auto">
        <h3 className="font-semibold mb-2">Inquiries</h3>
        <div className="space-y-2">{filteredInquiries.map(i => {
          const s = normalizeStatus(i.pipeline_status || i.status);
          return <button key={i.id} onClick={() => setSelectedId(i.id)} className={`w-full text-left p-2 rounded border ${selected?.id === i.id ? 'border-blue-500 bg-blue-50' : 'border-gray-200'}`}>
            <div className="text-xs text-gray-500">#{i.inquiry_number}</div><div className="font-medium text-sm">{i.company_name}</div>
            <div className="text-xs text-gray-600">{i.product_name}</div>
            <span className={`inline-flex px-2 py-0.5 rounded-full text-[11px] mt-1 ${statusChipMap[s]}`}>{prettyStatus(s)}</span>
          </button>;
        })}</div>
      </div>
      <div className="bg-white border rounded-xl p-3 lg:col-span-2 max-h-[72vh] overflow-auto">
        {!selected ? <div className="text-gray-500">No inquiry selected.</div> : <>
          <div className="flex justify-between items-start">
            <div>
              <h3 className="font-semibold">Inquiry 360 • #{selected.inquiry_number}</h3>
              <p className="text-sm text-gray-600">{selected.company_name} • {selected.contact_person || '-'} • {selected.contact_email || '-'}</p>
              <p className="text-xs text-gray-500">Product: {selected.product_name} {selected.specification ? `(${selected.specification})` : ''} | Qty: {selected.quantity || '-'}</p>
              <p className="text-xs text-gray-500">Assigned: {assigneeName}</p>
            </div>
            <div className={`text-xs px-2 py-1 rounded-full ${overdue ? 'bg-red-100 text-red-700' : 'bg-amber-100 text-amber-700'}`}>{nextFollowUp ? `Next: ${new Date(nextFollowUp).toLocaleDateString()}` : 'No follow-up'}</div>
          </div>
          <div className="mt-2 flex flex-wrap gap-2 text-xs">
            {selected.contact_email && <button onClick={() => setEmailOpen(true)} className="px-2 py-1 border rounded inline-flex items-center gap-1"><Mail className="w-3 h-3" />Send Email</button>}
            <button onClick={createReminder} className="px-2 py-1 border rounded inline-flex items-center gap-1"><CalendarPlus className="w-3 h-3" />Create Reminder</button>
            {!selected.customer_id && <button onClick={promoteOrLinkCustomer} disabled={promoting} className="px-2 py-1 border border-amber-300 text-amber-700 rounded inline-flex items-center gap-1"><UserRoundCheck className="w-3 h-3" />{promoting ? 'Linking…' : 'Promote / Link Customer'}</button>}
            {selected.customer_id && !selected.converted_to_order && normalizeStatus(selected.pipeline_status || selected.status) !== 'lost' && <button onClick={createSalesOrder} className="px-2 py-1 rounded bg-blue-600 text-white hover:bg-blue-700 font-medium inline-flex items-center gap-1"><Plus className="w-3 h-3" />Create Sales Order</button>}
          </div>

          <div className="grid md:grid-cols-2 gap-3 mt-3 text-sm">
            <div className="border rounded p-2"><div className="font-medium">Communication</div><div className="text-xs text-gray-600">Last contact: {lastContactAt ? new Date(lastContactAt).toLocaleString() : '-'}</div><div className="text-xs text-gray-600">Emails linked: {emails.length}</div></div>
            <div className="border rounded p-2"><div className="font-medium">Documents</div><div className="text-xs text-gray-600">Sent/pending COA, MSDS, Specs tracked in timeline.</div><div className="text-xs text-gray-600">Linked docs: {documents.length}</div></div>
            <div className="border rounded p-2">
              <div className="font-medium">Sales Links</div>
              {selected.customer_id ? (
                <div className="text-xs text-gray-600">SO: {orders.length} | Invoices: {invoices.length}</div>
              ) : (
                <div className="text-xs text-amber-700">This prospect has not yet been promoted to an ERP Customer.</div>
              )}
            </div>
            <div className="border rounded p-2">
              <div className="font-medium">Import Requirement</div>
              {selected.customer_id ? (
                <div className="text-xs text-gray-600">Linked requirements: {requirements.length}</div>
              ) : (
                <div className="text-xs text-amber-700">No ERP linkage — promote to an ERP Customer to track requirements.</div>
              )}
            </div>
            <div className="border rounded p-2">
              <div className="font-medium">Product intelligence</div>
              <div className="text-xs text-gray-600">{productAvailability?.matched ? `${productAvailability.available.toLocaleString()} available across ${productAvailability.batches} active batch(es)` : 'No unambiguous product match — keeping the inquiry product as free text.'}</div>
            </div>
            <div className="border rounded p-2">
              <div className="font-medium">Possible signals</div>
              {possibleSignals.length ? possibleSignals.map(signal => <div key={signal} className="text-xs text-amber-700">• {signal}</div>) : <div className="text-xs text-gray-500">No evidence-based conversion signal yet.</div>}
            </div>
          </div>

          <div className="mt-3">
            <h4 className="font-medium text-sm">Reminders / Follow-ups ({reminders.length})</h4>
            <div className="space-y-1 mt-1">{reminders.slice(0, 5).map((r) => <div key={r.id} className={`text-xs border rounded p-1 ${!r.is_completed && new Date(r.due_date) < new Date() ? 'bg-red-50 border-red-200' : ''}`}>{r.title} • {new Date(r.due_date).toLocaleDateString()} • {r.is_completed ? 'Done' : 'Open'}</div>)}</div>
          </div>

          <div className="mt-3">
            <h4 className="font-medium text-sm">Timeline</h4>
            <div className="space-y-1 mt-1">{timeline.map((item) => <div key={`${item.type}-${item.id}`} className="border rounded p-1 text-xs"><span className="font-medium">{item.title}</span> <span className="text-gray-500">{new Date(item.at).toLocaleString()}</span></div>)}</div>
          </div>
        </>}
      </div>
      {selected && emailOpen && <Modal isOpen={emailOpen} onClose={() => setEmailOpen(false)} title="Send Email"><EmailComposer inquiry={selected as any} contactId={selected.crm_contact_id} onClose={() => setEmailOpen(false)} onSent={() => setEmailOpen(false)} /></Modal>}
    </div>
  </div>;
}
