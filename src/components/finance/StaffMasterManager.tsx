import { useEffect, useState } from 'react';
import { supabase } from '../../lib/supabase';
import {
  Plus, Search, UploadCloud, FileText, Trash2, Download, Paperclip, ExternalLink, Loader2,
  ShieldCheck, AlertTriangle
} from 'lucide-react';
import { FinanceModal } from './FinanceModal';
import { MoneyInput } from '../MoneyInput';
import { FinancePage } from './FinancePage';
import { FinanceTable } from './FinanceTable';
import { FinanceActionButton, FinanceBadge, FinanceButton } from './FinanceUI';
import { SapRow } from './SapLayout';
import { FloatingField, FLOAT_INPUT } from './FloatingField';
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
  nik: string | null;
  npwp: string | null;
  monthly_salary: number;
  salary_type: 'monthly' | 'daily' | 'hourly';
  pph21_applicable: boolean;
  pph21_method: 'percentage' | 'manual';
  pph21_percentage: number;
  bpjs_applicable?: boolean;
  bpjs_kpj_number?: string | null;
  bpjs_enrollment_status?: 'active' | 'suspended' | 'terminated';
  bpjs_enrollment_start_date?: string | null;
  bpjs_enrollment_end_date?: string | null;
  bpjs_wage_basis?: number | null;
  bpjs_program_jht?: boolean;
  bpjs_program_jkk?: boolean;
  bpjs_program_jkm?: boolean;
  bpjs_program_jp?: boolean;
  bpjs_jht_employee_rate?: number;
  bpjs_jht_employer_rate?: number;
  bpjs_jkk_employer_rate?: number;
  bpjs_jkm_employer_rate?: number;
  bpjs_jp_employee_rate?: number;
  bpjs_jp_employer_rate?: number;
  bpjs_notes?: string | null;
  bpjs_document_urls?: string[] | null;
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
  const [pendingBpjsFiles, setPendingBpjsFiles] = useState<File[]>([]);
  const [isSaving, setIsSaving] = useState(false);
  const [isDragging, setIsDragging] = useState(false);
  const [form, setForm] = useState({
    full_name: '',
    employee_code: '',
    department: '',
    default_gl_code: '',
    default_gl_name: '',
    default_gl_account_id: '',
    nik: '',
    npwp: '',
    monthly_salary: 0,
    salary_type: 'monthly' as Staff['salary_type'],
    pph21_applicable: false,
    pph21_method: 'percentage' as Staff['pph21_method'],
    pph21_percentage: 0,
    bpjs_applicable: false,
    bpjs_kpj_number: '',
    bpjs_enrollment_status: 'active' as 'active' | 'suspended' | 'terminated',
    bpjs_enrollment_start_date: '',
    bpjs_enrollment_end_date: '',
    bpjs_wage_basis: 0,
    bpjs_program_jht: true,
    bpjs_program_jkk: true,
    bpjs_program_jkm: true,
    bpjs_program_jp: false,
    bpjs_jht_employee_rate: 2.0,
    bpjs_jht_employer_rate: 3.7,
    bpjs_jkk_employer_rate: 0.24,
    bpjs_jkm_employer_rate: 0.30,
    bpjs_jp_employee_rate: 0.0,
    bpjs_jp_employer_rate: 0.0,
    bpjs_notes: '',
    bpjs_document_urls: [] as string[],
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
    setPendingBpjsFiles([]);
    setForm({
      full_name: '', employee_code: '', department: '',
      default_gl_code: '', default_gl_name: '', default_gl_account_id: '',
      nik: '', npwp: '', status: 'active', notes: '',
      monthly_salary: 0, salary_type: 'monthly', pph21_applicable: false,
      pph21_method: 'percentage', pph21_percentage: 0, default_payment_method: 'bank_transfer',
      bpjs_applicable: false,
      bpjs_kpj_number: '',
      bpjs_enrollment_status: 'active',
      bpjs_enrollment_start_date: '',
      bpjs_enrollment_end_date: '',
      bpjs_wage_basis: 0,
      bpjs_program_jht: true,
      bpjs_program_jkk: true,
      bpjs_program_jkm: true,
      bpjs_program_jp: false,
      bpjs_jht_employee_rate: 2.0,
      bpjs_jht_employer_rate: 3.7,
      bpjs_jkk_employer_rate: 0.24,
      bpjs_jkm_employer_rate: 0.30,
      bpjs_jp_employee_rate: 0.0,
      bpjs_jp_employer_rate: 0.0,
      bpjs_notes: '',
      bpjs_document_urls: [],
      document_urls: [],
    });
  };

  const openEdit = (r: Staff) => {
    setEditing(r);
    setPendingFiles([]);
    setPendingBpjsFiles([]);
    setForm({
      full_name: r.full_name,
      employee_code: r.employee_code || '',
      department: r.department || '',
      default_gl_code: r.default_gl_code || '',
      default_gl_name: r.default_gl_name || '',
      default_gl_account_id: r.default_gl_account_id || '',
      nik: r.nik || '',
      npwp: r.npwp || '',
      monthly_salary: Number(r.monthly_salary || 0),
      salary_type: r.salary_type || 'monthly',
      pph21_applicable: Boolean(r.pph21_applicable),
      pph21_method: r.pph21_method || 'percentage',
      pph21_percentage: Number(r.pph21_percentage || 0),
      bpjs_applicable: Boolean(r.bpjs_applicable),
      bpjs_kpj_number: r.bpjs_kpj_number || '',
      bpjs_enrollment_status: r.bpjs_enrollment_status || 'active',
      bpjs_enrollment_start_date: r.bpjs_enrollment_start_date || '',
      bpjs_enrollment_end_date: r.bpjs_enrollment_end_date || '',
      bpjs_wage_basis: r.bpjs_wage_basis ? Number(r.bpjs_wage_basis) : Number(r.monthly_salary || 0),
      bpjs_program_jht: r.bpjs_program_jht !== false,
      bpjs_program_jkk: r.bpjs_program_jkk !== false,
      bpjs_program_jkm: r.bpjs_program_jkm !== false,
      bpjs_program_jp: Boolean(r.bpjs_program_jp),
      bpjs_jht_employee_rate: Number(r.bpjs_jht_employee_rate ?? 2.0),
      bpjs_jht_employer_rate: Number(r.bpjs_jht_employer_rate ?? 3.7),
      bpjs_jkk_employer_rate: Number(r.bpjs_jkk_employer_rate ?? 0.24),
      bpjs_jkm_employer_rate: Number(r.bpjs_jkm_employer_rate ?? 0.30),
      bpjs_jp_employee_rate: Number(r.bpjs_jp_employee_rate ?? 0.0),
      bpjs_jp_employer_rate: Number(r.bpjs_jp_employer_rate ?? 0.0),
      bpjs_notes: r.bpjs_notes || '',
      bpjs_document_urls: r.bpjs_document_urls || [],
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

      let finalBpjsDocUrls = [...(form.bpjs_document_urls || [])];
      if (pendingBpjsFiles.length > 0) {
        showToast({ type: 'info', title: 'Uploading BPJS documents', message: `Uploading ${pendingBpjsFiles.length} BPJS document(s)...` });
        const uploadedBpjsUrls = await uploadFinanceDocuments(pendingBpjsFiles, 'staff_bpjs');
        finalBpjsDocUrls = [...finalBpjsDocUrls, ...uploadedBpjsUrls];
      }

      const payload: Partial<Staff> = {
        full_name: form.full_name.trim(),
        employee_code: form.employee_code.trim() || null,
        department: form.department.trim() || null,
        // Server derives the legacy display code/name from this canonical FK.
        default_gl_account_id: form.default_gl_account_id || null,
        nik: form.nik.trim() || null,
        npwp: form.npwp.trim() || null,
        monthly_salary: form.monthly_salary,
        salary_type: form.salary_type,
        pph21_applicable: form.pph21_applicable,
        pph21_method: form.pph21_method,
        pph21_percentage: form.pph21_applicable ? form.pph21_percentage : 0,
        bpjs_applicable: form.bpjs_applicable,
        bpjs_kpj_number: form.bpjs_kpj_number.trim() || null,
        bpjs_enrollment_status: form.bpjs_enrollment_status,
        bpjs_enrollment_start_date: form.bpjs_enrollment_start_date || null,
        bpjs_enrollment_end_date: form.bpjs_enrollment_end_date || null,
        bpjs_wage_basis: form.bpjs_applicable ? (form.bpjs_wage_basis || form.monthly_salary) : null,
        bpjs_program_jht: form.bpjs_program_jht,
        bpjs_program_jkk: form.bpjs_program_jkk,
        bpjs_program_jkm: form.bpjs_program_jkm,
        bpjs_program_jp: form.bpjs_program_jp,
        bpjs_jht_employee_rate: form.bpjs_jht_employee_rate,
        bpjs_jht_employer_rate: form.bpjs_jht_employer_rate,
        bpjs_jkk_employer_rate: form.bpjs_jkk_employer_rate,
        bpjs_jkm_employer_rate: form.bpjs_jkm_employer_rate,
        bpjs_jp_employee_rate: form.bpjs_jp_employee_rate,
        bpjs_jp_employer_rate: form.bpjs_jp_employer_rate,
        bpjs_notes: form.bpjs_notes.trim() || null,
        bpjs_document_urls: finalBpjsDocUrls,
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
          <input name="search" aria-label="Search name / code / dept..."
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
          {
            header: 'Tax ID (NIK/NPWP)',
            cell: (row) => (
              <div className="text-xs font-mono">
                {row.nik && <div><span className="text-[10px] text-gray-400">NIK: </span>{row.nik}</div>}
                {row.npwp && <div className="text-gray-600"><span className="text-[10px] text-gray-400">NPWP: </span>{row.npwp}</div>}
                {!row.nik && !row.npwp && <span className="text-gray-400">—</span>}
              </div>
            ),
          },
          {
            header: 'BPJS TK',
            cell: (row) => {
              if (!row.bpjs_applicable) {
                return <span className="text-xs text-gray-400">Not enrolled</span>;
              }
              const wage = Number(row.bpjs_wage_basis || row.monthly_salary || 0);
              const jhtEmp = wage * ((row.bpjs_jht_employee_rate ?? 2.0) / 100);
              const hasDiscrepancy = Boolean(row.bpjs_wage_basis && Number(row.bpjs_wage_basis) !== Number(row.monthly_salary));

              return (
                <div className="text-xs space-y-0.5">
                  <div className="flex items-center gap-1">
                    <span className="font-mono font-medium text-emerald-800 bg-emerald-50 px-1.5 py-0.5 rounded text-[11px] border border-emerald-200">
                      KPJ: {row.bpjs_kpj_number || 'Enrolled'}
                    </span>
                    {hasDiscrepancy && (
                      <span className="text-[10px] font-bold text-amber-800 bg-amber-50 px-1 py-0.2 rounded border border-amber-200" title={`Wage Discrepancy: BPJS Rp ${wage.toLocaleString('id-ID')} vs Salary Rp ${Number(row.monthly_salary).toLocaleString('id-ID')}`}>
                        Wage diff
                      </span>
                    )}
                  </div>
                  <div className="text-[11px] text-gray-600 font-mono">
                    JHT 2%: Rp {Math.round(jhtEmp).toLocaleString('id-ID')}
                  </div>
                </div>
              );
            },
          },
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
              <FloatingField label="Full Name" required span={8} filled={!!form.full_name}>
                <input name="full_name" aria-label="Full Name" required value={form.full_name} onChange={e => setForm({ ...form, full_name: e.target.value })}
                  className={FLOAT_INPUT} />
              </FloatingField>
              <FloatingField label="Emp Code" span={4} filled={!!form.employee_code}>
                <input name="employee_code" aria-label="Employee Code" value={form.employee_code} onChange={e => setForm({ ...form, employee_code: e.target.value })}
                  className={FLOAT_INPUT} />
              </FloatingField>
            </SapRow>
            <SapRow>
              <FloatingField label="Department" span={6} filled={!!form.department}>
                <input name="department" aria-label="Department" value={form.department} onChange={e => setForm({ ...form, department: e.target.value })}
                  className={FLOAT_INPUT} />
              </FloatingField>
              <FloatingField label="Status" span={6} filled={!!form.status}>
                <select name="status" aria-label="Status" value={form.status} onChange={e => setForm({ ...form, status: e.target.value as 'active' | 'inactive' })}
                  className={FLOAT_INPUT}>
                  <option value="active">Active</option>
                  <option value="inactive">Inactive</option>
                </select>
              </FloatingField>
            </SapRow>
            <SapRow>
              <FloatingField label="Monthly Salary" required span={4} filled={!!form.monthly_salary}>
                <MoneyInput required value={form.monthly_salary}
                  onChange={n => setForm({ ...form, monthly_salary: n })}
                  className={FLOAT_INPUT + ' !text-right !font-mono'} />
              </FloatingField>
              <FloatingField label="Salary Type" required span={4} filled={!!form.salary_type}>
                <select name="salary_type" aria-label="Salary Type" value={form.salary_type} onChange={e => setForm({ ...form, salary_type: e.target.value as Staff['salary_type'] })} className={FLOAT_INPUT}>
                  <option value="monthly">Monthly</option>
                  <option value="daily">Daily</option>
                  <option value="hourly">Hourly</option>
                </select>
              </FloatingField>
              <FloatingField label="Default Payment" required span={4} filled={!!form.default_payment_method}>
                <select name="default_payment_method" aria-label="Default Payment Method" value={form.default_payment_method} onChange={e => setForm({ ...form, default_payment_method: e.target.value as Staff['default_payment_method'] })} className={FLOAT_INPUT}>
                  <option value="bank_transfer">Bank Transfer</option>
                  <option value="cash">Cash</option>
                  <option value="check">Check</option>
                  <option value="giro">Giro</option>
                  <option value="other">Other</option>
                </select>
              </FloatingField>
            </SapRow>
            <SapRow>
              <FloatingField label="PPh21 Applicable" span={4} filled>
                <select name="pph21_applicable" aria-label="Pph21 Applicable" value={form.pph21_applicable ? 'yes' : 'no'} onChange={e => setForm({ ...form, pph21_applicable: e.target.value === 'yes' })} className={FLOAT_INPUT}>
                  <option value="no">No</option>
                  <option value="yes">Yes</option>
                </select>
              </FloatingField>
              <FloatingField label="PPh21 Method" span={4} filled={!!form.pph21_method}>
                <select name="pph21_method" aria-label="Pph21 Method" disabled={!form.pph21_applicable} value={form.pph21_method} onChange={e => setForm({ ...form, pph21_method: e.target.value as Staff['pph21_method'] })} className={FLOAT_INPUT}>
                  <option value="percentage">Percentage</option>
                  <option value="manual">Manual per Salary</option>
                </select>
              </FloatingField>
              <FloatingField label="PPh21 %" span={4} filled={!!form.pph21_percentage}>
                <input name="pph21_percentage" aria-label="Pph21 Percentage" type="number" min="0" max="100" step="0.0001" disabled={!form.pph21_applicable || form.pph21_method !== 'percentage'}
                  value={form.pph21_percentage || ''} onChange={e => setForm({ ...form, pph21_percentage: Number(e.target.value) || 0 })}
                  className={FLOAT_INPUT + ' !text-right !font-mono'} />
              </FloatingField>
            </SapRow>
            <SapRow>
              <FloatingField label="Salary GL" span={12} filled={!!form.default_gl_account_id}>
                <select name="default_gl_account_id" aria-label="Default Gl Account Id" value={form.default_gl_account_id} onChange={e => setForm({ ...form, default_gl_account_id: e.target.value })} className={FLOAT_INPUT}>
                  <option value="">Default — 6100 Salaries & Wages</option>
                  {coaAccounts.map(account => <option key={account.id} value={account.id}>{account.code} — {account.name}</option>)}
                </select>
              </FloatingField>
            </SapRow>
            <SapRow>
              <FloatingField label="NIK / KTP No (16 digits)" span={6} filled={!!form.nik}>
                <input name="nik" aria-label="16-digit Citizen ID (KTP / Akte)"
                  value={form.nik}
                  onChange={e => setForm({ ...form, nik: e.target.value })}
                  placeholder="16-digit Citizen ID (KTP / Akte)"
                  maxLength={16}
                  className={FLOAT_INPUT + ' !font-mono'}
                />
              </FloatingField>
              <FloatingField label="NPWP (Tax ID)" span={6} filled={!!form.npwp}>
                <input name="npwp" aria-label="15 or 16-digit NPWP"
                  value={form.npwp}
                  onChange={e => setForm({ ...form, npwp: e.target.value })}
                  placeholder="15 or 16-digit NPWP"
                  className={FLOAT_INPUT + ' !font-mono'}
                />
              </FloatingField>
            </SapRow>
            <SapRow>
              <FloatingField label="Notes" span={12} filled={!!form.notes}>
                <input name="notes" aria-label="Optional notes or remarks" value={form.notes} onChange={e => setForm({ ...form, notes: e.target.value })}
                  placeholder="Optional notes or remarks"
                  className={FLOAT_INPUT} />
              </FloatingField>
            </SapRow>

            {/* BPJS Ketenagakerjaan Section */}
            <div className="pt-3 border-t border-gray-200 space-y-3 bg-emerald-50/20 p-3 rounded-xl border border-emerald-100">
              <div className="flex items-center justify-between">
                <div>
                  <h3 className="text-xs font-bold uppercase tracking-wider text-emerald-900 flex items-center gap-1.5">
                    <ShieldCheck className="w-4 h-4 text-emerald-600" />
                    BPJS Ketenagakerjaan (Avira Parama Farma)
                  </h3>
                  <p className="text-[11px] text-gray-500 mt-0.5">
                    Configure statutory enrollment, reported wage basis, and contribution rates (NPP: 26719331).
                  </p>
                </div>
                <label className="flex items-center gap-2 text-xs font-medium text-gray-700 cursor-pointer">
                  <input
                    type="checkbox"
                    name="bpjs_applicable"
                    checked={form.bpjs_applicable}
                    onChange={(e) => {
                      const checked = e.target.checked;
                      setForm(prev => ({
                        ...prev,
                        bpjs_applicable: checked,
                        bpjs_wage_basis: checked ? (prev.bpjs_wage_basis || prev.monthly_salary) : prev.bpjs_wage_basis,
                      }));
                    }}
                    className="w-4 h-4 text-emerald-600 border-gray-300 rounded focus:ring-emerald-500"
                  />
                  <span>BPJS Ketenagakerjaan Applicable</span>
                </label>
              </div>

              {form.bpjs_applicable && (
                <div className="space-y-3 pt-2">
                  <SapRow>
                    <FloatingField label="Participant No (KPJ)" span={4} filled={!!form.bpjs_kpj_number}>
                      <input
                        name="bpjs_kpj_number"
                        aria-label="BPJS KPJ Number"
                        value={form.bpjs_kpj_number}
                        onChange={e => setForm({ ...form, bpjs_kpj_number: e.target.value })}
                        placeholder="e.g. 26010001"
                        className={FLOAT_INPUT + ' !font-mono'}
                      />
                    </FloatingField>
                    <FloatingField label="Enrollment Status" span={2} filled={!!form.bpjs_enrollment_status}>
                      <select
                        name="bpjs_enrollment_status"
                        value={form.bpjs_enrollment_status}
                        onChange={e => setForm({ ...form, bpjs_enrollment_status: e.target.value as any })}
                        className={FLOAT_INPUT}
                      >
                        <option value="active">Active</option>
                        <option value="suspended">Suspended</option>
                        <option value="terminated">Terminated</option>
                      </select>
                    </FloatingField>
                    <FloatingField label="Enrollment Start" span={3} filled={!!form.bpjs_enrollment_start_date}>
                      <input
                        type="date"
                        name="bpjs_enrollment_start_date"
                        value={form.bpjs_enrollment_start_date}
                        onChange={e => setForm({ ...form, bpjs_enrollment_start_date: e.target.value })}
                        className={FLOAT_INPUT}
                      />
                    </FloatingField>
                    <FloatingField label="Enrollment End" span={3} filled={!!form.bpjs_enrollment_end_date}>
                      <input
                        type="date"
                        name="bpjs_enrollment_end_date"
                        value={form.bpjs_enrollment_end_date}
                        onChange={e => setForm({ ...form, bpjs_enrollment_end_date: e.target.value })}
                        className={FLOAT_INPUT}
                      />
                    </FloatingField>
                  </SapRow>

                  <SapRow>
                    <FloatingField label="Reported BPJS Wage Basis (Rp)" span={6} filled={!!form.bpjs_wage_basis}
                      hint={`Monthly salary in master is Rp ${Number(form.monthly_salary || 0).toLocaleString('id-ID')}`}>
                      <MoneyInput
                        required={form.bpjs_applicable}
                        value={form.bpjs_wage_basis}
                        onChange={n => setForm({ ...form, bpjs_wage_basis: n })}
                        className={FLOAT_INPUT + ' !text-right !font-mono'}
                      />
                    </FloatingField>
                    <FloatingField label="BPJS Notes / Registration Details" span={6} filled={!!form.bpjs_notes}>
                      <input
                        name="bpjs_notes"
                        value={form.bpjs_notes}
                        onChange={e => setForm({ ...form, bpjs_notes: e.target.value })}
                        placeholder="Registration details or branch notes"
                        className={FLOAT_INPUT}
                      />
                    </FloatingField>
                  </SapRow>

                  {/* Discrepancy Alert Banner */}
                  {Boolean(form.bpjs_wage_basis && Number(form.bpjs_wage_basis) !== Number(form.monthly_salary)) && (
                    <div className="flex items-start gap-2 p-2.5 bg-amber-50 border border-amber-200 rounded-lg text-amber-900 text-xs">
                      <AlertTriangle className="w-4 h-4 text-amber-600 shrink-0 mt-0.5" />
                      <div>
                        <div className="font-semibold">Wage Discrepancy Flagged for Review</div>
                        <div>
                          Reported BPJS contribution wage (<strong>Rp {Number(form.bpjs_wage_basis).toLocaleString('id-ID')}</strong>)
                          differs from Staff Master monthly salary (<strong>Rp {Number(form.monthly_salary).toLocaleString('id-ID')}</strong>).
                          BPJS employee deductions and employer contributions will be based on the confirmed BPJS wage (Rp {Number(form.bpjs_wage_basis).toLocaleString('id-ID')}).
                        </div>
                      </div>
                    </div>
                  )}

                  {/* Prominent Calculation Summary */}
                  {(() => {
                    const wage = Number(form.bpjs_wage_basis || form.monthly_salary || 0);
                    const empRate = form.bpjs_program_jht ? (form.bpjs_jht_employee_rate ?? 2.0) : 0;
                    const erJhtRate = form.bpjs_program_jht ? (form.bpjs_jht_employer_rate ?? 3.7) : 0;
                    const erJkkRate = form.bpjs_program_jkk ? (form.bpjs_jkk_employer_rate ?? 0.24) : 0;
                    const erJkmRate = form.bpjs_program_jkm ? (form.bpjs_jkm_employer_rate ?? 0.30) : 0;
                    const erJpRate = form.bpjs_program_jp ? (form.bpjs_jp_employer_rate ?? 0) : 0;

                    const empDeduction = Math.round(wage * empRate / 100);
                    const erExpense = Math.round(wage * (erJhtRate + erJkkRate + erJkmRate + erJpRate) / 100);
                    const totalPayable = empDeduction + erExpense;

                    return (
                      <div className="bg-white rounded-lg p-3 border border-emerald-200 shadow-xs space-y-2">
                        <div className="text-[11px] font-semibold text-gray-500 uppercase tracking-wide">
                          Contribution Preview (Wage Basis: Rp {wage.toLocaleString('id-ID')})
                        </div>
                        <div className="grid grid-cols-1 md:grid-cols-3 gap-3">
                          <div className="bg-blue-50/70 p-2.5 rounded-lg border border-blue-100">
                            <div className="text-[10px] uppercase font-bold text-blue-700">Employee 2% JHT Deduction</div>
                            <div className="text-base font-bold font-mono text-blue-900 mt-0.5">
                              Rp {empDeduction.toLocaleString('id-ID')}
                            </div>
                            <div className="text-[10px] text-blue-600 mt-0.5">
                              Deducted from salary & payslip
                            </div>
                          </div>

                          <div className="bg-purple-50/70 p-2.5 rounded-lg border border-purple-100">
                            <div className="text-[10px] uppercase font-bold text-purple-700">Employer 4.24% Expense</div>
                            <div className="text-base font-bold font-mono text-purple-900 mt-0.5">
                              Rp {erExpense.toLocaleString('id-ID')}
                            </div>
                            <div className="text-[10px] text-purple-600 mt-0.5">
                              Company expense (JHT 3.7%, JKK 0.24%, JKM 0.30%)
                            </div>
                          </div>

                          <div className="bg-emerald-50/70 p-2.5 rounded-lg border border-emerald-100">
                            <div className="text-[10px] uppercase font-bold text-emerald-700">Total BPJS Payable</div>
                            <div className="text-base font-bold font-mono text-emerald-900 mt-0.5">
                              Rp {totalPayable.toLocaleString('id-ID')}
                            </div>
                            <div className="text-[10px] text-emerald-600 mt-0.5">
                              Combined bill to BPJS TK
                            </div>
                          </div>
                        </div>
                      </div>
                    );
                  })()}

                  {/* Programs & Rates */}
                  <div className="bg-gray-50/70 p-2.5 rounded-lg border border-gray-200">
                    <div className="text-[11px] font-semibold text-gray-700 mb-2">
                      Program Participation & Determination Rates
                    </div>
                    <div className="grid grid-cols-2 md:grid-cols-4 gap-2 text-xs">
                      <label className="flex items-center gap-1.5 p-1.5 bg-white rounded border border-gray-200">
                        <input
                          type="checkbox"
                          checked={form.bpjs_program_jht}
                          onChange={e => setForm({ ...form, bpjs_program_jht: e.target.checked })}
                          className="rounded text-emerald-600"
                        />
                        <span>JHT (Emp 2%, Er 3.7%)</span>
                      </label>
                      <label className="flex items-center gap-1.5 p-1.5 bg-white rounded border border-gray-200">
                        <input
                          type="checkbox"
                          checked={form.bpjs_program_jkk}
                          onChange={e => setForm({ ...form, bpjs_program_jkk: e.target.checked })}
                          className="rounded text-emerald-600"
                        />
                        <span>JKK (Er 0.24%)</span>
                      </label>
                      <label className="flex items-center gap-1.5 p-1.5 bg-white rounded border border-gray-200">
                        <input
                          type="checkbox"
                          checked={form.bpjs_program_jkm}
                          onChange={e => setForm({ ...form, bpjs_program_jkm: e.target.checked })}
                          className="rounded text-emerald-600"
                        />
                        <span>JKM (Er 0.30%)</span>
                      </label>
                      <label className="flex items-center gap-1.5 p-1.5 bg-white rounded border border-gray-200">
                        <input
                          type="checkbox"
                          checked={form.bpjs_program_jp}
                          onChange={e => setForm({ ...form, bpjs_program_jp: e.target.checked })}
                          className="rounded text-emerald-600"
                        />
                        <span>JP Pension (0%)</span>
                      </label>
                    </div>
                  </div>

                  {/* BPJS Documents Upload */}
                  <div className="space-y-2 pt-1">
                    <div className="flex items-center justify-between">
                      <span className="text-[11px] font-semibold text-gray-700 flex items-center gap-1">
                        <Paperclip className="w-3 h-3 text-emerald-600" />
                        BPJS Documents (Membership Card / Determination Letter / Statement)
                      </span>
                      <span className="text-[10px] text-gray-500">
                        {(form.bpjs_document_urls?.length || 0) + pendingBpjsFiles.length} file(s)
                      </span>
                    </div>

                    <div className="flex items-center gap-2">
                      <input
                        type="file"
                        id="bpjs-doc-upload"
                        multiple
                        accept="image/*,.pdf,.doc,.docx"
                        className="hidden"
                        onChange={(e) => {
                          const selected = Array.from(e.target.files || []);
                          if (selected.length > 0) {
                            setPendingBpjsFiles(prev => [...prev, ...selected]);
                          }
                          e.target.value = '';
                        }}
                      />
                      <button
                        type="button"
                        onClick={() => document.getElementById('bpjs-doc-upload')?.click()}
                        className="px-2.5 py-1 text-xs font-medium text-emerald-700 bg-emerald-50 hover:bg-emerald-100 rounded-lg border border-emerald-200 flex items-center gap-1.5"
                      >
                        <UploadCloud className="w-3.5 h-3.5" />
                        Attach BPJS Document
                      </button>
                    </div>

                    {/* Attached BPJS Files */}
                    {((form.bpjs_document_urls && form.bpjs_document_urls.length > 0) || pendingBpjsFiles.length > 0) && (
                      <div className="grid grid-cols-1 sm:grid-cols-2 gap-2 pt-1">
                        {form.bpjs_document_urls?.map((url, idx) => {
                          const name = getDocDisplayName(url, idx);
                          return (
                            <div key={url} className="flex items-center justify-between p-2 rounded-lg bg-white border border-emerald-200 text-xs">
                              <span className="truncate max-w-[180px] font-medium text-emerald-900" title={name}>{name}</span>
                              <div className="flex items-center gap-1">
                                <button
                                  type="button"
                                  onClick={() => openStorageDocument(url)}
                                  className="p-1 text-gray-400 hover:text-indigo-600"
                                  title="View"
                                >
                                  <ExternalLink className="w-3.5 h-3.5" />
                                </button>
                                <button
                                  type="button"
                                  onClick={() => downloadStorageDocument(url, name)}
                                  className="p-1 text-gray-400 hover:text-emerald-600"
                                  title="Download"
                                >
                                  <Download className="w-3.5 h-3.5" />
                                </button>
                                <button
                                  type="button"
                                  onClick={() => {
                                    setForm(prev => ({
                                      ...prev,
                                      bpjs_document_urls: prev.bpjs_document_urls?.filter(u => u !== url) || [],
                                    }));
                                  }}
                                  className="p-1 text-gray-400 hover:text-red-600"
                                  title="Remove"
                                >
                                  <Trash2 className="w-3.5 h-3.5" />
                                </button>
                              </div>
                            </div>
                          );
                        })}
                        {pendingBpjsFiles.map((file, idx) => (
                          <div key={`${file.name}-${idx}`} className="flex items-center justify-between p-2 rounded-lg bg-emerald-50/60 border border-emerald-200 text-xs">
                            <span className="truncate max-w-[180px] font-medium text-emerald-800">{file.name}</span>
                            <button
                              type="button"
                              onClick={() => setPendingBpjsFiles(prev => prev.filter((_, i) => i !== idx))}
                              className="p-1 text-gray-400 hover:text-red-600"
                              title="Cancel"
                            >
                              <Trash2 className="w-3.5 h-3.5" />
                            </button>
                          </div>
                        ))}
                      </div>
                    )}
                  </div>
                </div>
              )}
            </div>

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
