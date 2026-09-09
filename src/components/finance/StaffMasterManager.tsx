import { useEffect, useState } from 'react';
import { supabase } from '../../lib/supabase';
import {
  Plus, Search, UploadCloud, FileText, Trash2, Download, Paperclip, ExternalLink, Loader2
} from 'lucide-react';
import { FinanceModal } from './FinanceModal';
import { MoneyInput } from '../MoneyInput';
import { FinancePage } from './FinancePage';
import { FinanceTable } from './FinanceTable';
import { FinanceActionButton, FinanceBadge, FinanceButton } from './FinanceUI';
import { SapRow, SapField, SAP_INPUT } from './SapLayout';
import { showToast } from '../ToastNotification';
import { showConfirm } from '../ConfirmDialog';
import { uploadFinanceDocuments } from './FinanceDocumentAttachments';
import { openStorageDocument, downloadStorageDocument } from '../../utils/signedUrlCache';

/**
 * StaffMasterManager — CRUD for finance_staff_master.
 *
 * Payroll / staff-expense targets. Used by the Expense form when the
 * category is one of salary / staff_overtime / staff_welfare /
 * travel_conveyance. This screen is a pure lookup admin — no
 * calculations, no journal side-effects.
 */

interface Staff {
  id: string;
  full_name: string;
  employee_code: string | null;
  department: string | null;
  default_gl_code: string | null;
  default_gl_name: string | null;
  default_gl_account_id?: string | null;
  npwp: string | null;
  monthly_salary: number;
  salary_type: 'monthly' | 'daily' | 'hourly';
  pph21_applicable: boolean;
  pph21_method: 'percentage' | 'manual';
  pph21_percentage: number;
  default_payment_method: 'cash' | 'bank_transfer' | 'check' | 'giro' | 'other';
  status: 'active' | 'inactive';
  notes: string | null;
  document_urls?: string[] | null;
  created_at: string;
}

interface Props {
  canManage: boolean;
}

interface COA { id: string; code: string; name: string; }

export function StaffMasterManager({ canManage }: Props) {
  const [rows, setRows] = useState<Staff[]>([]);
  const [coaAccounts, setCoaAccounts] = useState<COA[]>([]);
  const [loading, setLoading] = useState(true);
  const [search, setSearch] = useState('');
  const [modalOpen, setModalOpen] = useState(false);
  const [editing, setEditing] = useState<Staff | null>(null);
  const [pendingFiles, setPendingFiles] = useState<File[]>([]);
  const [isSaving, setIsSaving] = useState(false);
  const [isDragging, setIsDragging] = useState(false);
  const [form, setForm] = useState({
    full_name: '',
    employee_code: '',
    department: '',
    default_gl_code: '',
    default_gl_name: '',
    default_gl_account_id: '',
    npwp: '',
    monthly_salary: 0,
    salary_type: 'monthly' as Staff['salary_type'],
    pph21_applicable: false,
    pph21_method: 'percentage' as Staff['pph21_method'],
    pph21_percentage: 0,
    default_payment_method: 'bank_transfer' as Staff['default_payment_method'],
    status: 'active' as 'active' | 'inactive',
    notes: '',
    document_urls: [] as string[],
  });

  useEffect(() => { load(); void loadCoa(); }, []);

  // Global paste handler for easy screenshot / file pasting (Ctrl+V / Cmd+V)
  useEffect(() => {
    if (!modalOpen) return;
    const handlePaste = (e: ClipboardEvent) => {
      const items = e.clipboardData?.items;
      if (!items) return;

      const files: File[] = [];
      for (let i = 0; i < items.length; i++) {
        if (items[i].kind === 'file') {
          const file = items[i].getAsFile();
          if (file) {
            const ext = file.type.split('/')[1]?.replace('jpeg', 'jpg') || 'png';
            const filename = `staff_doc_paste_${Date.now()}_${i + 1}.${ext}`;
            const renamed = new File([file], filename, { type: file.type });
            files.push(renamed);
          }
        }
      }

      if (files.length > 0) {
        e.preventDefault();
        setPendingFiles(prev => [...prev, ...files]);
        showToast({
          type: 'success',
          title: 'Document captured from clipboard',
          message: `${files.length} file(s) attached. Click '${editing ? 'Update' : 'Create'}' to store permanently.`,
        });
      }
    };

    window.addEventListener('paste', handlePaste);
    return () => window.removeEventListener('paste', handlePaste);
  }, [modalOpen, editing]);

  const loadCoa = async () => {
    const { data, error } = await supabase
      .from('chart_of_accounts')
      .select('id, code, name')
      .eq('is_active', true)
      .eq('is_header', false)
      .in('account_type', ['expense', 'Expense'])
      .order('code');
    if (error) showToast({ type: 'error', title: 'COA load failed', message: error.message });
    else setCoaAccounts(data || []);
  };

  const load = async () => {
    setLoading(true);
    const { data, error } = await supabase
      .from('finance_staff_master')
      .select('*')
      .order('full_name');
    if (error) showToast({ type: 'error', title: 'Load failed', message: error.message });
    else setRows(data || []);
    setLoading(false);
  };

  const reset = () => {
    setEditing(null);
    setPendingFiles([]);
    setForm({
      full_name: '', employee_code: '', department: '',
      default_gl_code: '', default_gl_name: '', default_gl_account_id: '',
      npwp: '', status: 'active', notes: '',
      monthly_salary: 0, salary_type: 'monthly', pph21_applicable: false,
      pph21_method: 'percentage', pph21_percentage: 0, default_payment_method: 'bank_transfer',
      document_urls: [],
    });
  };

  const openEdit = (r: Staff) => {
    setEditing(r);
    setPendingFiles([]);
    setForm({
      full_name: r.full_name,
      employee_code: r.employee_code || '',
      department: r.department || '',
      default_gl_code: r.default_gl_code || '',
      default_gl_name: r.default_gl_name || '',
      default_gl_account_id: r.default_gl_account_id || '',
      npwp: r.npwp || '',
      monthly_salary: Number(r.monthly_salary || 0),
      salary_type: r.salary_type || 'monthly',
      pph21_applicable: Boolean(r.pph21_applicable),
      pph21_method: r.pph21_method || 'percentage',
      pph21_percentage: Number(r.pph21_percentage || 0),
      default_payment_method: r.default_payment_method || 'bank_transfer',
      status: r.status,
      notes: r.notes || '',
      document_urls: r.document_urls || [],
    });
    setModalOpen(true);
  };

  const save = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!form.full_name.trim()) {
      showToast({ type: 'error', title: 'Name required', message: 'Enter the staff name.' });
      return;
    }

    setIsSaving(true);
    try {
      let finalDocUrls = [...(form.document_urls || [])];
      if (pendingFiles.length > 0) {
        showToast({ type: 'info', title: 'Uploading documents', message: `Uploading ${pendingFiles.length} document(s)...` });
        const uploadedUrls = await uploadFinanceDocuments(pendingFiles, 'staff');
        finalDocUrls = [...finalDocUrls, ...uploadedUrls];
      }

      const payload: Partial<Staff> = {
        full_name: form.full_name.trim(),
        employee_code: form.employee_code.trim() || null,
        department: form.department.trim() || null,
        // Server derives the legacy display code/name from this canonical FK.
        default_gl_account_id: form.default_gl_account_id || null,
        npwp: form.npwp.trim() || null,
        monthly_salary: form.monthly_salary,
        salary_type: form.salary_type,
        pph21_applicable: form.pph21_applicable,
        pph21_method: form.pph21_method,
        pph21_percentage: form.pph21_applicable ? form.pph21_percentage : 0,
        default_payment_method: form.default_payment_method,
        status: form.status,
        notes: form.notes.trim() || null,
        document_urls: finalDocUrls,
      };

      const { error } = editing
        ? await supabase.from('finance_staff_master').update(payload).eq('id', editing.id)
        : await supabase.from('finance_staff_master').insert(payload);

      if (error) {
        showToast({ type: 'error', title: 'Save failed', message: error.message });
        return;
      }

      showToast({
        type: 'success',
        title: editing ? 'Updated' : 'Created',
        message: `${form.full_name} saved with ${finalDocUrls.length} document(s).`,
      });
      setModalOpen(false);
      reset();
      load();
    } catch (err: any) {
      showToast({ type: 'error', title: 'Upload failed', message: err.message || 'Failed to upload attachments' });
    } finally {
      setIsSaving(false);
    }
  };

  const remove = async (r: Staff) => {
    const ok = await showConfirm({
      title: 'Delete staff record?',
      message: `Delete ${r.full_name}? Expenses already booked against this staff are NOT affected — this only removes the master record.`,
      confirmLabel: 'Delete',
      variant: 'danger',
    });
    if (!ok) return;
    const { error } = await supabase.from('finance_staff_master').delete().eq('id', r.id);
    if (error) showToast({ type: 'error', title: 'Delete failed', message: error.message });
    else { showToast({ type: 'success', title: 'Deleted', message: `${r.full_name} removed.` }); load(); }
  };

  const filtered = rows.filter(r => {
    if (!search) return true;
    const q = search.toLowerCase();
    return r.full_name.toLowerCase().includes(q)
      || (r.employee_code || '').toLowerCase().includes(q)
      || (r.department || '').toLowerCase().includes(q);
  });

  return (
    <FinancePage
      title="Staff Master"
      subtitle="Payroll / staff-expense targets"
      actions={canManage ? (
        <FinanceButton variant="primary" onClick={() => { reset(); setModalOpen(true); }}>
          <Plus className="w-3.5 h-3.5" /> New Staff
        </FinanceButton>
      ) : undefined}
      toolbar={(
        <>
        <div className="relative flex-1 max-w-sm">
          <Search className="absolute left-2 top-1/2 -translate-y-1/2 w-3 h-3 text-gray-400" />
          <input
            value={search}
            onChange={e => setSearch(e.target.value)}
            placeholder="Search name / code / dept..."
            className="w-full h-7 pl-7 pr-2 text-xs border border-gray-300 rounded"
          />
        </div>
        <span className="ml-auto text-xs text-gray-500">{filtered.length} staff</span>
        </>
      )}
    >
      <FinanceTable
        rows={filtered}
        rowKey={(row) => row.id}
        loading={loading}
        empty="No staff records."
        columns={[
          { header: 'Name', cell: (row) => <span className="font-medium text-gray-900">{row.full_name}</span> },
          { header: 'Code', cell: (row) => <span className="font-mono">{row.employee_code || '—'}</span> },
          { header: 'Department', cell: (row) => row.department || '—' },
          { header: 'Monthly Salary', align: 'right', cell: (row) => <span className="font-mono">Rp {Number(row.monthly_salary || 0).toLocaleString('id-ID')}</span> },
          { header: 'Default GL', cell: (row) => <span className="font-mono">{row.default_gl_code ? `${row.default_gl_code}${row.default_gl_name ? ` — ${row.default_gl_name}` : ''}` : '—'}</span> },
          { header: 'NPWP', cell: (row) => <span className="font-mono">{row.npwp || '—'}</span> },
          {
            header: 'KYC / Docs',
            align: 'center',
            cell: (row) => row.document_urls && row.document_urls.length > 0 ? (
              <button
                type="button"
                onClick={() => openEdit(row)}
                className="inline-flex items-center gap-1.5 px-2.5 py-0.5 rounded-full text-xs font-medium bg-indigo-50 text-indigo-700 hover:bg-indigo-100 transition-colors border border-indigo-200/60"
                title="Click to view and manage attached documents"
              >
                <Paperclip className="w-3 h-3" />
                <span>{row.document_urls.length} doc{row.document_urls.length > 1 ? 's' : ''}</span>
              </button>
            ) : (
              <span className="text-xs text-gray-400">—</span>
            ),
          },
          { header: 'Status', align: 'center', cell: (row) => <FinanceBadge status={row.status === 'active' ? 'approved' : 'draft'}>{row.status}</FinanceBadge> },
          ...(canManage ? [{
            header: 'Actions', align: 'center' as const, cell: (row: Staff) => (
              <div className="flex items-center justify-center gap-0.5">
                <FinanceActionButton action="edit" onClick={() => openEdit(row)} />
                <FinanceActionButton action="delete" onClick={() => remove(row)} />
              </div>
            ),
          }] : []),
        ]}
      />

      {/* Modal */}
      {modalOpen && (
        <FinanceModal
          isOpen={modalOpen}
          onClose={() => { if (!isSaving) { setModalOpen(false); reset(); } }}
          title={editing ? `Edit Staff: ${editing.full_name}` : 'New Staff'}
          size="lg"
          footer={(
            <>
              <FinanceButton type="button" disabled={isSaving} onClick={() => { setModalOpen(false); reset(); }}>
                Cancel
              </FinanceButton>
              <FinanceButton type="submit" form="staff-master-form" variant="primary" disabled={isSaving}>
                {isSaving ? (
                  <span className="flex items-center gap-1.5">
                    <Loader2 className="w-3.5 h-3.5 animate-spin" />
                    Saving...
                  </span>
                ) : (
                  editing ? 'Update' : 'Create'
                )}
              </FinanceButton>
            </>
          )}
        >
          <form id="staff-master-form" onSubmit={save} className="flex flex-col gap-3">
            <SapRow>
              <SapField label="Full Name" required span={8}>
                <input required value={form.full_name} onChange={e => setForm({ ...form, full_name: e.target.value })}
                  className={SAP_INPUT} />
              </SapField>
              <SapField label="Emp Code" span={4}>
                <input value={form.employee_code} onChange={e => setForm({ ...form, employee_code: e.target.value })}
                  className={SAP_INPUT} />
              </SapField>
            </SapRow>
            <SapRow>
              <SapField label="Department" span={6}>
                <input value={form.department} onChange={e => setForm({ ...form, department: e.target.value })}
                  className={SAP_INPUT} />
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
              <SapField label="Monthly Salary" required span={4}>
                <MoneyInput required value={form.monthly_salary}
                  onChange={n => setForm({ ...form, monthly_salary: n })}
                  className={SAP_INPUT + ' !text-right !font-mono'} />
              </SapField>
              <SapField label="Salary Type" required span={4}>
                <select value={form.salary_type} onChange={e => setForm({ ...form, salary_type: e.target.value as Staff['salary_type'] })} className={SAP_INPUT}>
                  <option value="monthly">Monthly</option>
                  <option value="daily">Daily</option>
                  <option value="hourly">Hourly</option>
                </select>
              </SapField>
              <SapField label="Default Payment" required span={4}>
                <select value={form.default_payment_method} onChange={e => setForm({ ...form, default_payment_method: e.target.value as Staff['default_payment_method'] })} className={SAP_INPUT}>
                  <option value="bank_transfer">Bank Transfer</option>
                  <option value="cash">Cash</option>
                  <option value="check">Check</option>
                  <option value="giro">Giro</option>
                  <option value="other">Other</option>
                </select>
              </SapField>
            </SapRow>
            <SapRow>
              <SapField label="PPh21 Applicable" span={4}>
                <select value={form.pph21_applicable ? 'yes' : 'no'} onChange={e => setForm({ ...form, pph21_applicable: e.target.value === 'yes' })} className={SAP_INPUT}>
                  <option value="no">No</option>
                  <option value="yes">Yes</option>
                </select>
              </SapField>
              <SapField label="PPh21 Method" span={4}>
                <select disabled={!form.pph21_applicable} value={form.pph21_method} onChange={e => setForm({ ...form, pph21_method: e.target.value as Staff['pph21_method'] })} className={SAP_INPUT}>
                  <option value="percentage">Percentage</option>
                  <option value="manual">Manual per Salary</option>
                </select>
              </SapField>
              <SapField label="PPh21 %" span={4}>
                <input type="number" min="0" max="100" step="0.0001" disabled={!form.pph21_applicable || form.pph21_method !== 'percentage'}
                  value={form.pph21_percentage || ''} onChange={e => setForm({ ...form, pph21_percentage: Number(e.target.value) || 0 })}
                  className={SAP_INPUT + ' !text-right !font-mono'} />
              </SapField>
            </SapRow>
            <SapRow>
              <SapField label="Salary GL" span={8}>
                <select value={form.default_gl_account_id} onChange={e => setForm({ ...form, default_gl_account_id: e.target.value })} className={SAP_INPUT}>
                  <option value="">Default — 6100 Salaries & Wages</option>
                  {coaAccounts.map(account => <option key={account.id} value={account.id}>{account.code} — {account.name}</option>)}
                </select>
              </SapField>
              <SapField label="NPWP" span={4}>
                <input value={form.npwp} onChange={e => setForm({ ...form, npwp: e.target.value })}
                  className={SAP_INPUT + ' !font-mono'} />
              </SapField>
            </SapRow>
            <SapRow>
              <SapField label="Notes" span={12}>
                <input value={form.notes} onChange={e => setForm({ ...form, notes: e.target.value })}
                  placeholder="Optional notes or remarks"
                  className={SAP_INPUT} />
              </SapField>
            </SapRow>

            {/* Identity & HR Documents (KTP, NPWP, Contract, Bank passbook) */}
            <div className="pt-3 border-t border-gray-200 space-y-3">
              <div className="flex items-center justify-between">
                <div>
                  <h3 className="text-xs font-bold uppercase tracking-wider text-gray-500 flex items-center gap-1.5">
                    <Paperclip className="w-3.5 h-3.5 text-indigo-600" />
                    Identity & HR Documents (KTP, NPWP, Contract, Bank Passbook)
                  </h3>
                  <p className="text-[11px] text-gray-500 mt-0.5">
                    Attach photo or PDF of staff KTP, NPWP, employment contract, or bank book for HR records.
                  </p>
                </div>
                <span className="text-[11px] text-indigo-700 font-medium bg-indigo-50 px-2 py-0.5 rounded-full border border-indigo-100">
                  {(form.document_urls?.length || 0) + pendingFiles.length} file(s)
                </span>
              </div>

              {/* Dropzone & Paste Box */}
              <div
                onDrop={(e) => {
                  e.preventDefault();
                  setIsDragging(false);
                  const droppedFiles = Array.from(e.dataTransfer.files);
                  if (droppedFiles.length > 0) {
                    setPendingFiles(prev => [...prev, ...droppedFiles]);
                  }
                }}
                onDragOver={(e) => {
                  e.preventDefault();
                  setIsDragging(true);
                }}
                onDragLeave={(e) => {
                  e.preventDefault();
                  setIsDragging(false);
                }}
                className={`border-2 border-dashed rounded-xl p-4 text-center transition-all ${
                  isDragging
                    ? 'border-indigo-500 bg-indigo-50/70 scale-[0.99]'
                    : 'border-gray-200 hover:border-indigo-300 hover:bg-gray-50/60'
                }`}
              >
                <input
                  type="file"
                  id="staff-doc-upload"
                  multiple
                  accept="image/*,.pdf,.doc,.docx"
                  className="hidden"
                  onChange={(e) => {
                    const selected = Array.from(e.target.files || []);
                    if (selected.length > 0) {
                      setPendingFiles(prev => [...prev, ...selected]);
                    }
                    e.target.value = '';
                  }}
                />
                <div
                  className="flex flex-col items-center justify-center gap-1.5 cursor-pointer"
                  onClick={() => document.getElementById('staff-doc-upload')?.click()}
                >
                  <div className="p-2 bg-indigo-50 text-indigo-600 rounded-full shadow-xs">
                    <UploadCloud className="w-5 h-5" />
                  </div>
                  <div>
                    <span className="text-xs font-semibold text-gray-800 hover:text-indigo-600">
                      Click to browse
                    </span>
                    <span className="text-xs text-gray-500"> or drag & drop files here</span>
                  </div>
                  <div className="inline-flex items-center gap-1.5 text-[11px] text-indigo-700 bg-indigo-50 px-2.5 py-1 rounded-lg font-medium border border-indigo-100">
                    <span>💡 Fast upload: Copy any image & press</span>
                    <kbd className="px-1.5 py-0.5 bg-white border border-gray-300 rounded text-[10px] font-mono shadow-xs text-gray-700">Ctrl+V</kbd>
                    <span>or</span>
                    <kbd className="px-1.5 py-0.5 bg-white border border-gray-300 rounded text-[10px] font-mono shadow-xs text-gray-700">⌘V</kbd>
                    <span>to paste directly!</span>
                  </div>
                  <p className="text-[10px] text-gray-400">
                    Supports JPG, PNG, WEBP, and PDF files
                  </p>
                </div>
              </div>

              {/* Attached & Pending Files Grid */}
              {((form.document_urls && form.document_urls.length > 0) || pendingFiles.length > 0) && (
                <div className="grid grid-cols-1 sm:grid-cols-2 gap-2.5 pt-1">
                  {/* Existing Saved Documents */}
                  {form.document_urls?.map((url, idx) => {
                    const isImg = isImageUrl(url);
                    const name = getDocDisplayName(url, idx);
                    return (
                      <div
                        key={url}
                        className="group relative flex items-center gap-3 p-2.5 rounded-xl border border-gray-200 bg-white hover:border-indigo-200 hover:shadow-xs transition-all"
                      >
                        {/* Thumbnail / Icon */}
                        <div
                          className="w-11 h-11 rounded-lg bg-gray-100 overflow-hidden shrink-0 flex items-center justify-center border border-gray-100 cursor-pointer"
                          onClick={() => openStorageDocument(url)}
                          title="Click to view full size"
                        >
                          {isImg ? (
                            <img
                              src={url}
                              alt={name}
                              className="w-full h-full object-cover group-hover:scale-105 transition-transform"
                              onError={(e) => {
                                (e.target as HTMLElement).style.display = 'none';
                              }}
                            />
                          ) : (
                            <FileText className="w-5 h-5 text-red-500" />
                          )}
                        </div>

                        {/* Info */}
                        <div className="flex-1 min-w-0">
                          <button
                            type="button"
                            onClick={() => openStorageDocument(url)}
                            className="text-xs font-medium text-gray-800 truncate block text-left hover:text-indigo-600 w-full"
                            title={name}
                          >
                            {name}
                          </button>
                          <div className="flex items-center gap-1.5 mt-0.5">
                            <span className="text-[10px] font-medium text-emerald-700 bg-emerald-50 px-1.5 py-0.2 rounded border border-emerald-100">
                              Saved
                            </span>
                            {isImg && <span className="text-[10px] text-gray-400">Image</span>}
                          </div>
                        </div>

                        {/* Action Buttons */}
                        <div className="flex items-center gap-0.5">
                          <button
                            type="button"
                            onClick={() => openStorageDocument(url)}
                            className="p-1.5 text-gray-400 hover:text-indigo-600 hover:bg-indigo-50 rounded-md transition-colors"
                            title="View Document"
                          >
                            <ExternalLink className="w-3.5 h-3.5" />
                          </button>
                          <button
                            type="button"
                            onClick={() => downloadStorageDocument(url, name)}
                            className="p-1.5 text-gray-400 hover:text-emerald-600 hover:bg-emerald-50 rounded-md transition-colors"
                            title="Download"
                          >
                            <Download className="w-3.5 h-3.5" />
                          </button>
                          <button
                            type="button"
                            onClick={() => {
                              setForm(prev => ({
                                ...prev,
                                document_urls: prev.document_urls?.filter(u => u !== url) || [],
                              }));
                            }}
                            className="p-1.5 text-gray-400 hover:text-red-600 hover:bg-red-50 rounded-md transition-colors"
                            title="Remove"
                          >
                            <Trash2 className="w-3.5 h-3.5" />
                          </button>
                        </div>
                      </div>
                    );
                  })}

                  {/* Pending Uploads (Pasted / Dropped) */}
                  {pendingFiles.map((file, idx) => {
                    const isImg = file.type.startsWith('image/');
                    let objectUrl: string | null = null;
                    try {
                      objectUrl = isImg ? URL.createObjectURL(file) : null;
                    } catch {
                      objectUrl = null;
                    }
                    return (
                      <div
                        key={`${file.name}-${idx}`}
                        className="group relative flex items-center gap-3 p-2.5 rounded-xl border border-indigo-200 bg-indigo-50/40 hover:shadow-xs transition-all"
                      >
                        {/* Thumbnail / Icon */}
                        <div className="w-11 h-11 rounded-lg bg-indigo-100/50 overflow-hidden shrink-0 flex items-center justify-center border border-indigo-100">
                          {isImg && objectUrl ? (
                            <img
                              src={objectUrl}
                              alt={file.name}
                              className="w-full h-full object-cover"
                            />
                          ) : (
                            <FileText className="w-5 h-5 text-indigo-500" />
                          )}
                        </div>

                        {/* Info */}
                        <div className="flex-1 min-w-0">
                          <div className="text-xs font-medium text-indigo-900 truncate" title={file.name}>
                            {file.name}
                          </div>
                          <div className="flex items-center gap-1.5 mt-0.5">
                            <span className="text-[10px] font-medium text-indigo-700 bg-indigo-100 px-1.5 py-0.2 rounded">
                              Ready to upload ({(file.size / 1024).toFixed(0)} KB)
                            </span>
                          </div>
                        </div>

                        {/* Remove Pending */}
                        <div className="flex items-center">
                          <button
                            type="button"
                            onClick={() => {
                              setPendingFiles(prev => prev.filter((_, i) => i !== idx));
                            }}
                            className="p-1.5 text-gray-400 hover:text-red-600 hover:bg-red-50 rounded-md transition-colors"
                            title="Cancel this file"
                          >
                            <Trash2 className="w-3.5 h-3.5" />
                          </button>
                        </div>
                      </div>
                    );
                  })}
                </div>
              )}
            </div>
          </form>
        </FinanceModal>
      )}
    </FinancePage>
  );
}

function isImageUrl(url: string): boolean {
  if (!url) return false;
  const clean = url.split('?')[0].toLowerCase();
  return clean.endsWith('.png') || clean.endsWith('.jpg') || clean.endsWith('.jpeg') || clean.endsWith('.webp') || clean.endsWith('.gif') || clean.endsWith('.svg');
}

function getDocDisplayName(url: string, index: number): string {
  if (!url) return `Document ${index + 1}`;
  try {
    const raw = decodeURIComponent(url.split('/').pop()?.split('?')[0] || '');
    const cleaned = raw.replace(/^\d+_[a-f0-9-]+_/, '');
    return cleaned || `Document ${index + 1}`;
  } catch {
    return `Document ${index + 1}`;
  }
}
