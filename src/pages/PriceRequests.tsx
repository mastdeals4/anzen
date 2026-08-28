import { useState, useEffect, useCallback } from 'react';
import { Layout } from '../components/Layout';
import { supabase } from '../lib/supabase';
import { useAuth } from '../contexts/AuthContext';
import { useNavigation } from '../contexts/NavigationContext';
import { formatDate } from '../utils/dateFormat';
import { Plus, Search, ChevronRight, Clock, CheckCircle2, AlertCircle, Circle } from 'lucide-react';
import { PriceRequestDetail } from './PriceRequestDetail';

interface PriceRequest {
  id: string;
  pr_number: string;
  inquiry_id: string | null;
  customer_name: string | null;
  assigned_to: string | null;
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

const STATUS_META: Record<string, { label: string; color: string }> = {
  draft:    { label: 'Draft',    color: 'bg-gray-100 text-gray-600' },
  sourcing: { label: 'Sourcing', color: 'bg-blue-100 text-blue-700' },
  pricing:  { label: 'Pricing',  color: 'bg-amber-100 text-amber-700' },
  quoted:   { label: 'Quoted',   color: 'bg-green-100 text-green-700' },
  won:      { label: 'Won',      color: 'bg-emerald-100 text-emerald-700' },
  lost:     { label: 'Lost',     color: 'bg-red-100 text-red-600' },
};

function NewPRModal({ onClose, onCreated }: { onClose: () => void; onCreated: (id: string) => void }) {
  const { profile } = useAuth();
  const [inquiries, setInquiries] = useState<{ id: string; inquiry_number: string; customer_name: string | null }[]>([]);
  const [form, setForm] = useState({ inquiry_id: '', customer_name: '', notes: '' });
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    supabase.from('crm_inquiries').select('id, inquiry_number, customer_name').order('created_at', { ascending: false }).limit(100)
      .then(({ data }) => setInquiries(data || []));
  }, []);

  const handleInquiryChange = (id: string) => {
    const inq = inquiries.find(i => i.id === id);
    setForm(f => ({ ...f, inquiry_id: id, customer_name: inq?.customer_name || f.customer_name }));
  };

  const save = async () => {
    setSaving(true);
    if (form.inquiry_id) {
      const { data: existing } = await supabase
        .from('price_requests')
        .select('id')
        .eq('inquiry_id', form.inquiry_id)
        .maybeSingle();

      if (existing?.id) {
        setSaving(false);
        onCreated(existing.id);
        return;
      }
    }

    const { data, error } = await supabase.from('price_requests').insert({
      inquiry_id: form.inquiry_id || null,
      customer_name: form.customer_name || null,
      notes: form.notes || null,
      assigned_to: profile?.id || null,
      created_by: profile?.id || null,
    }).select('id').single();
    setSaving(false);
    if (!error && data) {
      onCreated(data.id);
      return;
    }

    if (form.inquiry_id) {
      const { data: existing } = await supabase
        .from('price_requests')
        .select('id')
        .eq('inquiry_id', form.inquiry_id)
        .maybeSingle();
      if (existing?.id) onCreated(existing.id);
    }
  };

  return (
    <div className="fixed inset-0 bg-black/40 z-50 flex items-center justify-center p-4">
      <div className="bg-white rounded-lg shadow-xl w-full max-w-md">
        <div className="px-5 py-4 border-b border-gray-200 flex items-center justify-between">
          <h2 className="text-sm font-semibold text-gray-800">New Price Request</h2>
          <button onClick={onClose} className="text-gray-400 hover:text-gray-600 text-lg leading-none">&times;</button>
        </div>
        <div className="px-5 py-4 space-y-3">
          <div>
            <label className="block text-xs font-medium text-gray-600 mb-1">Linked Inquiry (optional)</label>
            <select
              value={form.inquiry_id}
              onChange={e => handleInquiryChange(e.target.value)}
              className="w-full border border-gray-300 rounded px-2.5 py-1.5 text-sm focus:outline-none focus:ring-1 focus:ring-blue-500"
            >
              <option value="">-- Select inquiry --</option>
              {inquiries.map(i => (
                <option key={i.id} value={i.id}>{i.inquiry_number} {i.customer_name ? `- ${i.customer_name}` : ''}</option>
              ))}
            </select>
          </div>
          <div>
            <label className="block text-xs font-medium text-gray-600 mb-1">Customer Name</label>
            <input
              value={form.customer_name}
              onChange={e => setForm(f => ({ ...f, customer_name: e.target.value }))}
              className="w-full border border-gray-300 rounded px-2.5 py-1.5 text-sm focus:outline-none focus:ring-1 focus:ring-blue-500"
              placeholder="Customer name"
            />
          </div>
          <div>
            <label className="block text-xs font-medium text-gray-600 mb-1">Notes</label>
            <textarea
              value={form.notes}
              onChange={e => setForm(f => ({ ...f, notes: e.target.value }))}
              rows={2}
              className="w-full border border-gray-300 rounded px-2.5 py-1.5 text-sm focus:outline-none focus:ring-1 focus:ring-blue-500 resize-none"
            />
          </div>
        </div>
        <div className="px-5 py-3 border-t border-gray-200 flex justify-end gap-2">
          <button onClick={onClose} className="px-3 py-1.5 text-sm text-gray-600 hover:text-gray-800">Cancel</button>
          <button onClick={save} disabled={saving} className="px-4 py-1.5 text-sm bg-blue-600 text-white rounded hover:bg-blue-700 disabled:opacity-50">
            {saving ? 'Creating...' : 'Create'}
          </button>
        </div>
      </div>
    </div>
  );
}

export function PriceRequests() {
  const [list, setList] = useState<PriceRequest[]>([]);
  const [loading, setLoading] = useState(true);
  const [search, setSearch] = useState('');
  const [statusFilter, setStatusFilter] = useState('all');
  const [showNew, setShowNew] = useState(false);
  const [detailId, setDetailId] = useState<string | null>(null);
  const { setCurrentPage } = useNavigation();

  const load = useCallback(async () => {
    setLoading(true);
    const { data } = await supabase
      .from('price_requests')
      .select('*, pr_number:price_request_number, overall_status:status, inquiry:crm_inquiries(inquiry_number)')
      .order('created_at', { ascending: false });
    setList((data as PriceRequest[]) || []);
    setLoading(false);
  }, []);

  useEffect(() => { load(); }, [load]);

  const filtered = list.filter(pr => {
    const matchStatus = statusFilter === 'all' || pr.overall_status === statusFilter;
    const q = search.toLowerCase();
    const matchSearch = !q || (pr.pr_number || '').toLowerCase().includes(q)
      || (pr.customer_name || '').toLowerCase().includes(q)
      || (pr.inquiry?.inquiry_number || '').toLowerCase().includes(q);
    return matchStatus && matchSearch;
  });

  if (detailId) {
    return <PriceRequestDetail prId={detailId} onBack={() => { setDetailId(null); load(); }} />;
  }

  return (
    <Layout>
      <div className="p-4 md:p-6">
        <div className="flex items-center justify-between mb-4">
          <div>
            <h1 className="text-lg font-semibold text-gray-900">Price Requests</h1>
            <p className="text-xs text-gray-500 mt-0.5">Sourcing & pricing workflow linked to CRM inquiries</p>
          </div>
          <div className="flex items-center gap-2">
            <button onClick={() => setCurrentPage('pricing-desk')} className="px-3 py-1.5 text-xs border border-amber-300 bg-amber-50 text-amber-700 rounded hover:bg-amber-100 font-medium">
              Pricing Desk
            </button>
            <button onClick={() => setCurrentPage('pricing-ledger')} className="px-3 py-1.5 text-xs border border-gray-300 text-gray-600 rounded hover:bg-gray-50 font-medium">
              Ledger
            </button>
            <button onClick={() => setShowNew(true)} className="flex items-center gap-1.5 px-3 py-1.5 text-xs bg-blue-600 text-white rounded hover:bg-blue-700 font-medium">
              <Plus className="w-3.5 h-3.5" /> New PR
            </button>
          </div>
        </div>

        <div className="flex items-center gap-2 mb-4 flex-wrap">
          <div className="relative flex-1 min-w-[180px] max-w-xs">
            <Search className="absolute left-2.5 top-1/2 -translate-y-1/2 w-3.5 h-3.5 text-gray-400" />
            <input value={search} onChange={e => setSearch(e.target.value)} placeholder="Search PR, customer, inquiry..."
              className="w-full pl-8 pr-3 py-1.5 text-sm border border-gray-300 rounded focus:outline-none focus:ring-1 focus:ring-blue-500" />
          </div>
          {['all', 'draft', 'sourcing', 'pricing', 'quoted', 'won', 'lost'].map(s => (
            <button key={s} onClick={() => setStatusFilter(s)}
              className={`px-2.5 py-1 text-xs rounded font-medium transition-colors ${statusFilter === s ? 'bg-blue-600 text-white' : 'bg-gray-100 text-gray-600 hover:bg-gray-200'}`}>
              {s === 'all' ? 'All' : STATUS_META[s]?.label || s}
            </button>
          ))}
        </div>

        <div className="grid grid-cols-2 sm:grid-cols-4 gap-3 mb-4">
          {[
            { label: 'Total', value: list.length, icon: Circle, color: 'text-gray-500' },
            { label: 'Sourcing', value: list.filter(p => p.overall_status === 'sourcing').length, icon: Clock, color: 'text-blue-500' },
            { label: 'Pricing', value: list.filter(p => p.overall_status === 'pricing').length, icon: AlertCircle, color: 'text-amber-500' },
            { label: 'Quoted', value: list.filter(p => p.overall_status === 'quoted').length, icon: CheckCircle2, color: 'text-green-500' },
          ].map(c => (
            <div key={c.label} className="bg-white rounded-lg border border-gray-200 px-4 py-3 flex items-center gap-3">
              <c.icon className={`w-4 h-4 ${c.color}`} />
              <div>
                <p className="text-lg font-semibold text-gray-900 leading-none">{c.value}</p>
                <p className="text-xs text-gray-500 mt-0.5">{c.label}</p>
              </div>
            </div>
          ))}
        </div>

        <div className="bg-white rounded-lg border border-gray-200 overflow-hidden">
          {loading ? (
            <div className="py-16 text-center text-sm text-gray-400">Loading...</div>
          ) : filtered.length === 0 ? (
            <div className="py-16 text-center text-sm text-gray-400">
              No price requests found.
              <button onClick={() => setShowNew(true)} className="ml-2 text-blue-600 hover:underline">Create one</button>
            </div>
          ) : (
            <table className="w-full">
              <thead className="bg-gray-50 border-b border-gray-200">
                <tr>
                  {['PR #', 'Customer', 'Inquiry', 'Products', 'Source', 'Final', 'Status', 'Last Activity', ''].map(h => (
                    <th key={h} className="px-4 py-2.5 text-left text-xs font-medium text-gray-500 uppercase tracking-wider whitespace-nowrap">{h}</th>
                  ))}
                </tr>
              </thead>
              <tbody className="divide-y divide-gray-100">
                {filtered.map(pr => {
                  const sm = STATUS_META[pr.overall_status] || STATUS_META.draft;
                  const allQuoted = pr.total_products > 0 && pr.final_ready === pr.total_products;
                  return (
                    <tr key={pr.id} onClick={() => setDetailId(pr.id)} className="hover:bg-gray-50 cursor-pointer transition-colors">
                      <td className="px-4 py-2.5 text-xs font-medium text-blue-700 whitespace-nowrap">{pr.pr_number}</td>
                      <td className="px-4 py-2.5 text-xs text-gray-800 whitespace-nowrap max-w-[140px] truncate">{pr.customer_name || '-'}</td>
                      <td className="px-4 py-2.5 text-xs text-gray-500 whitespace-nowrap">{pr.inquiry?.inquiry_number || '-'}</td>
                      <td className="px-4 py-2.5 text-xs text-gray-700 text-center">{pr.total_products}</td>
                      <td className="px-4 py-2.5 whitespace-nowrap"><span className="text-xs text-gray-500">{pr.source_received}/{pr.total_products || '?'}</span></td>
                      <td className="px-4 py-2.5 whitespace-nowrap">
                        {allQuoted ? (
                          <span className="inline-flex items-center gap-0.5 text-[10px] font-semibold text-green-700 bg-green-100 px-1.5 py-0.5 rounded-full">
                            <CheckCircle2 className="w-2.5 h-2.5" /> Ready
                          </span>
                        ) : (
                          <span className="text-xs text-gray-500">{pr.final_ready}/{pr.total_products || '?'}</span>
                        )}
                      </td>
                      <td className="px-4 py-2.5 whitespace-nowrap"><span className={`inline-flex px-2 py-0.5 rounded text-[10px] font-medium ${sm.color}`}>{sm.label}</span></td>
                      <td className="px-4 py-2.5 text-xs text-gray-400 whitespace-nowrap">{formatDate(pr.last_activity_at)}</td>
                      <td className="px-4 py-2.5"><ChevronRight className="w-3.5 h-3.5 text-gray-400" /></td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          )}
        </div>
      </div>
      {showNew && <NewPRModal onClose={() => setShowNew(false)} onCreated={id => { setShowNew(false); setDetailId(id); load(); }} />}
    </Layout>
  );
}
