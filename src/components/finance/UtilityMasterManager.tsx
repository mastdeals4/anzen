import { useEffect, useState } from 'react';
import { supabase } from '../../lib/supabase';
import { Plus, Pencil, Trash2, Search, Zap } from 'lucide-react';
import { FinanceModal as Modal } from './FinanceModal';
import { SearchableSelect } from '../SearchableSelect';
import { SapRow, SapField, SAP_INPUT } from './SapLayout';
import { showToast } from '../ToastNotification';
import { showConfirm } from '../ConfirmDialog';

/**
 * UtilityMasterManager — CRUD for finance_utility_master.
 *
 * Utility providers (PLN electricity, PAM water, Telkom internet/phone,
 * Biznet, gas, office rent, cleaning, security, etc). Used by the Expense
 * form when the category is `utilities`. The optional supplier_id link
 * lets a utility flow through the standard AP pipeline.
 */

const UTILITY_TYPES = [
  { value: 'electricity', label: 'Electricity' },
  { value: 'water',       label: 'Water' },
  { value: 'internet',    label: 'Internet' },
  { value: 'phone',       label: 'Phone' },
  { value: 'gas',         label: 'Gas' },
  { value: 'rent',        label: 'Rent' },
  { value: 'cleaning',    label: 'Cleaning' },
  { value: 'security',    label: 'Security' },
  { value: 'other',       label: 'Other' },
];

interface Utility {
  id: string;
  provider_name: string;
  utility_type: string;
  account_number: string | null;
  default_gl_code: string | null;
  default_gl_name: string | null;
  supplier_id: string | null;
  status: 'active' | 'inactive';
  notes: string | null;
  created_at: string;
  suppliers?: { company_name: string } | null;
}

interface Supplier { id: string; company_name: string; }

interface Props {
  canManage: boolean;
}

export function UtilityMasterManager({ canManage }: Props) {
  const [rows, setRows] = useState<Utility[]>([]);
  const [suppliers, setSuppliers] = useState<Supplier[]>([]);
  const [loading, setLoading] = useState(true);
  const [search, setSearch] = useState('');
  const [modalOpen, setModalOpen] = useState(false);
  const [editing, setEditing] = useState<Utility | null>(null);
  const [form, setForm] = useState({
    provider_name: '',
    utility_type: 'electricity',
    account_number: '',
    default_gl_code: '',
    default_gl_name: '',
    supplier_id: '',
    status: 'active' as 'active' | 'inactive',
    notes: '',
  });

  useEffect(() => { load(); loadSuppliers(); }, []);

  const load = async () => {
    setLoading(true);
    const { data, error } = await supabase
      .from('finance_utility_master')
      .select('*, suppliers(company_name)')
      .order('provider_name');
    if (error) showToast({ type: 'error', title: 'Load failed', message: error.message });
    else setRows(data || []);
    setLoading(false);
  };

  const loadSuppliers = async () => {
    const { data } = await supabase.from('suppliers').select('id, company_name').order('company_name');
    setSuppliers(data || []);
  };

  const reset = () => {
    setEditing(null);
    setForm({
      provider_name: '', utility_type: 'electricity',
      account_number: '', default_gl_code: '', default_gl_name: '',
      supplier_id: '', status: 'active', notes: '',
    });
  };

  const openEdit = (r: Utility) => {
    setEditing(r);
    setForm({
      provider_name: r.provider_name,
      utility_type: r.utility_type,
      account_number: r.account_number || '',
      default_gl_code: r.default_gl_code || '',
      default_gl_name: r.default_gl_name || '',
      supplier_id: r.supplier_id || '',
      status: r.status,
      notes: r.notes || '',
    });
    setModalOpen(true);
  };

  const save = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!form.provider_name.trim()) {
      showToast({ type: 'error', title: 'Provider required', message: 'Enter the provider name.' });
      return;
    }
    const payload = {
      provider_name: form.provider_name.trim(),
      utility_type: form.utility_type,
      account_number: form.account_number.trim() || null,
      default_gl_code: form.default_gl_code.trim() || null,
      default_gl_name: form.default_gl_name.trim() || null,
      supplier_id: form.supplier_id || null,
      status: form.status,
      notes: form.notes.trim() || null,
    };
    const { error } = editing
      ? await supabase.from('finance_utility_master').update(payload).eq('id', editing.id)
      : await supabase.from('finance_utility_master').insert(payload);
    if (error) {
      showToast({ type: 'error', title: 'Save failed', message: error.message });
      return;
    }
    showToast({ type: 'success', title: editing ? 'Updated' : 'Created', message: `${form.provider_name} saved.` });
    setModalOpen(false);
    reset();
    load();
  };

  const remove = async (r: Utility) => {
    const ok = await showConfirm({
      title: 'Delete utility record?',
      message: `Delete ${r.provider_name}? Utility expenses already booked are NOT affected — this only removes the master record.`,
      confirmLabel: 'Delete',
      variant: 'danger',
    });
    if (!ok) return;
    const { error } = await supabase.from('finance_utility_master').delete().eq('id', r.id);
    if (error) showToast({ type: 'error', title: 'Delete failed', message: error.message });
    else { showToast({ type: 'success', title: 'Deleted', message: `${r.provider_name} removed.` }); load(); }
  };

  const filtered = rows.filter(r => {
    if (!search) return true;
    const q = search.toLowerCase();
    return r.provider_name.toLowerCase().includes(q)
      || (r.utility_type || '').toLowerCase().includes(q)
      || (r.account_number || '').toLowerCase().includes(q);
  });

  return (
    <div className="flex flex-col gap-1.5">
      {/* Shared title strip */}
      <div className="flex items-center justify-between h-8 px-2 bg-white border border-gray-200 rounded">
        <div className="flex items-baseline gap-2 min-w-0">
          <h1 className="text-xs font-bold text-gray-900 truncate flex items-center gap-1.5">
            <Zap className="w-3 h-3 text-amber-600" /> Utility Master
          </h1>
          <span className="text-[10px] text-gray-400 truncate">PLN / PAM / Telkom / Biznet / Rent / etc.</span>
        </div>
        {canManage && (
          <button
            onClick={() => { reset(); setModalOpen(true); }}
            className="inline-flex items-center gap-1 h-7 px-2 bg-blue-600 text-white rounded text-xs font-semibold hover:bg-blue-700"
          >
            <Plus className="w-3 h-3" /> New
          </button>
        )}
      </div>

      {/* Toolbar */}
      <div className="flex items-center gap-1.5 min-h-8 px-2 py-1 bg-white border border-gray-200 rounded">
        <div className="relative flex-1 max-w-sm">
          <Search className="absolute left-2 top-1/2 -translate-y-1/2 w-3 h-3 text-gray-400" />
          <input
            value={search}
            onChange={e => setSearch(e.target.value)}
            placeholder="Search provider / type / account..."
            className="w-full h-7 pl-7 pr-2 text-xs border border-gray-300 rounded"
          />
        </div>
        <span className="ml-auto text-xs text-gray-500">{filtered.length} providers</span>
      </div>

      {/* Table */}
      <div className="bg-white border border-gray-200 rounded overflow-hidden">
        <table className="w-full text-xs border-collapse">
          <thead className="bg-gray-50 border-b border-gray-200">
            <tr className="h-8">
              <th className="px-2 py-1 text-left font-semibold text-[11px] text-gray-600 uppercase tracking-wide">Provider</th>
              <th className="px-2 py-1 text-left font-semibold text-[11px] text-gray-600 uppercase tracking-wide">Type</th>
              <th className="px-2 py-1 text-left font-semibold text-[11px] text-gray-600 uppercase tracking-wide">Account #</th>
              <th className="px-2 py-1 text-left font-semibold text-[11px] text-gray-600 uppercase tracking-wide">Default GL</th>
              <th className="px-2 py-1 text-left font-semibold text-[11px] text-gray-600 uppercase tracking-wide">Supplier</th>
              <th className="px-2 py-1 text-center font-semibold text-[11px] text-gray-600 uppercase tracking-wide">Status</th>
              {canManage && <th className="px-2 py-1 text-center font-semibold text-[11px] text-gray-600 uppercase tracking-wide">Actions</th>}
            </tr>
          </thead>
          <tbody>
            {loading ? (
              <tr><td colSpan={canManage ? 7 : 6} className="py-8 text-center text-xs text-gray-400">Loading…</td></tr>
            ) : filtered.length === 0 ? (
              <tr><td colSpan={canManage ? 7 : 6} className="py-8 text-center text-xs text-gray-400">No utility providers.</td></tr>
            ) : filtered.map(r => (
              <tr key={r.id} className="h-8 border-b border-gray-100 hover:bg-blue-50/40">
                <td className="px-2 py-1 text-gray-900 font-medium">{r.provider_name}</td>
                <td className="px-2 py-1 text-gray-700 capitalize">{r.utility_type}</td>
                <td className="px-2 py-1 text-gray-700 font-mono">{r.account_number || '—'}</td>
                <td className="px-2 py-1 text-gray-700 font-mono">{r.default_gl_code ? `${r.default_gl_code}${r.default_gl_name ? ' — ' + r.default_gl_name : ''}` : '—'}</td>
                <td className="px-2 py-1 text-gray-700">{r.suppliers?.company_name || '—'}</td>
                <td className="px-2 py-1 text-center">
                  <span className={`inline-flex items-center px-1.5 py-0.5 text-[10px] font-semibold uppercase tracking-wide rounded ${r.status === 'active' ? 'bg-green-100 text-green-700' : 'bg-gray-100 text-gray-600'}`}>
                    {r.status}
                  </span>
                </td>
                {canManage && (
                  <td className="px-1 py-0.5">
                    <div className="flex items-center justify-center gap-0.5">
                      <button onClick={() => openEdit(r)} className="p-1 text-gray-400 hover:text-blue-600 hover:bg-blue-50 rounded" title="Edit">
                        <Pencil className="w-3.5 h-3.5" />
                      </button>
                      <button onClick={() => remove(r)} className="p-1 text-gray-400 hover:text-red-600 hover:bg-red-50 rounded" title="Delete">
                        <Trash2 className="w-3.5 h-3.5" />
                      </button>
                    </div>
                  </td>
                )}
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      {/* Modal */}
      {modalOpen && (
        <Modal isOpen={modalOpen} onClose={() => { setModalOpen(false); reset(); }}
          title={editing ? `Edit Utility: ${editing.provider_name}` : 'New Utility Provider'} size="md">
          <form onSubmit={save} className="flex flex-col gap-1.5">
            <SapRow>
              <SapField label="Provider" required span={8}>
                <input required value={form.provider_name} onChange={e => setForm({ ...form, provider_name: e.target.value })}
                  className={SAP_INPUT} />
              </SapField>
              <SapField label="Type" span={4}>
                <select value={form.utility_type} onChange={e => setForm({ ...form, utility_type: e.target.value })}
                  className={SAP_INPUT}>
                  {UTILITY_TYPES.map(t => <option key={t.value} value={t.value}>{t.label}</option>)}
                </select>
              </SapField>
            </SapRow>
            <SapRow>
              <SapField label="Acct #" span={6}>
                <input value={form.account_number} onChange={e => setForm({ ...form, account_number: e.target.value })}
                  className={SAP_INPUT + ' !font-mono'} />
              </SapField>
              <SapField label="Status" span={6}>
                <select value={form.status} onChange={e => setForm({ ...form, status: e.target.value as 'active' | 'inactive' })}
                  className={SAP_INPUT}>
                  <option value="active">Active</option>
                  <option value="inactive">Inactive</option>
                </select>
              </SapField>
            </SapRow>
            <SapRow>
              <SapField label="GL Code" span={4}>
                <input value={form.default_gl_code} onChange={e => setForm({ ...form, default_gl_code: e.target.value })}
                  placeholder="e.g. 6200"
                  className={SAP_INPUT + ' !font-mono'} />
              </SapField>
              <SapField label="GL Name" span={8}>
                <input value={form.default_gl_name} onChange={e => setForm({ ...form, default_gl_name: e.target.value })}
                  placeholder="Utilities Expense"
                  className={SAP_INPUT} />
              </SapField>
            </SapRow>
            <SapRow>
              <SapField label="Supplier" span={12}>
                <SearchableSelect
                  value={form.supplier_id}
                  onChange={(v) => setForm({ ...form, supplier_id: v })}
                  options={[{ value: '', label: '— None —' }, ...suppliers.map(s => ({ value: s.id, label: s.company_name }))]}
                  placeholder="Optional — links utility to AP..."
                />
              </SapField>
            </SapRow>
            <SapRow>
              <SapField label="Notes" span={12}>
                <input value={form.notes} onChange={e => setForm({ ...form, notes: e.target.value })}
                  className={SAP_INPUT} />
              </SapField>
            </SapRow>
            <div className="flex justify-end gap-2 pt-2 border-t border-gray-200 mt-1">
              <button type="button" onClick={() => { setModalOpen(false); reset(); }}
                className="h-7 px-3 text-xs text-gray-700 bg-white hover:bg-gray-50 border border-gray-300 rounded">Cancel</button>
              <button type="submit"
                className="h-7 px-3 text-xs bg-blue-600 text-white hover:bg-blue-700 rounded font-semibold">
                {editing ? 'Update' : 'Create'}
              </button>
            </div>
          </form>
        </Modal>
      )}
    </div>
  );
}
