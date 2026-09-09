import React, { useEffect, useState, useMemo, useRef } from 'react';
import { supabase } from '../../lib/supabase';
import { showToast } from '../ToastNotification';
import {
  Users, Plus, Search, Edit2, CheckCircle, XCircle,
  Building2, CreditCard, Shield, AlertTriangle,
  UploadCloud, FileText, Image as ImageIcon, Trash2, Eye, Download, Paperclip, ExternalLink, Loader2
} from 'lucide-react';
import { uploadFinanceDocuments } from './FinanceDocumentAttachments';
import { openStorageDocument, downloadStorageDocument } from '../../utils/signedUrlCache';

export type PayeeBusinessRole =
  | 'sales_commission_recipient'
  | 'tax_consultant'
  | 'legal_counsel'
  | 'notary'
  | 'warehouse_labor'
  | 'property_owner'
  | 'freelance_specialist';

export type PayeeTaxClassification =
  | 'bukan_pegawai_imbalan'
  | 'tenaga_ahli'
  | 'pegawai_tidak_tetap'
  | 'pemilik_sewa_op';

export interface Payee {
  id: string;
  payee_code: string;
  full_name: string;
  business_role: PayeeBusinessRole;
  tax_classification: PayeeTaxClassification;
  nik: string | null;
  npwp: string | null;
  ptkp_status: string;
  default_pph_code_id: string | null;
  bank_name: string | null;
  bank_account_number: string | null;
  bank_account_holder: string | null;
  phone: string | null;
  email: string | null;
  address: string | null;
  notes: string | null;
  document_urls?: string[] | null;
  is_active: boolean;
  created_at: string;
  updated_at: string;
}

export const BUSINESS_ROLE_LABELS: Record<PayeeBusinessRole, string> = {
  sales_commission_recipient: 'Sales Commission Recipient',
  tax_consultant: 'Tax Consultant',
  legal_counsel: 'Legal Counsel',
  notary: 'Notary / PPAT',
  warehouse_labor: 'Warehouse / Casual Labor',
  property_owner: 'Property Owner / Landlord',
  freelance_specialist: 'Freelance Specialist',
};

export const TAX_CLASSIFICATION_LABELS: Record<PayeeTaxClassification, string> = {
  bukan_pegawai_imbalan: 'Bukan Pegawai (DPP 50% / Pasal 17)',
  tenaga_ahli: 'Tenaga Ahli (DPP 50% / Pasal 17)',
  pegawai_tidak_tetap: 'Pegawai Tidak Tetap (TER Harian)',
  pemilik_sewa_op: 'Sewa Tanah/Bangunan OP (PPh Final 4(2) 10%)',
};

export const DEFAULT_ROLE_TAX_MAP: Record<PayeeBusinessRole, PayeeTaxClassification> = {
  sales_commission_recipient: 'bukan_pegawai_imbalan',
  tax_consultant: 'tenaga_ahli',
  legal_counsel: 'tenaga_ahli',
  notary: 'tenaga_ahli',
  warehouse_labor: 'pegawai_tidak_tetap',
  property_owner: 'pemilik_sewa_op',
  freelance_specialist: 'bukan_pegawai_imbalan',
};

interface TaxCodeOption {
  id: string;
  code: string;
  name: string;
  tax_type: string;
}

interface Props {
  canManage: boolean;
}

export function PayeeMasterManager({ canManage }: Props) {
  const [payees, setPayees] = useState<Payee[]>([]);
  const [taxCodes, setTaxCodes] = useState<TaxCodeOption[]>([]);
  const [loading, setLoading] = useState(true);
  const [search, setSearch] = useState('');
  const [roleFilter, setRoleFilter] = useState<string>('all');
  const [statusFilter, setStatusFilter] = useState<string>('active');

  const [modalOpen, setModalOpen] = useState(false);
  const [editingPayee, setEditingPayee] = useState<Payee | null>(null);
  const [pendingFiles, setPendingFiles] = useState<File[]>([]);
  const [isSaving, setIsSaving] = useState(false);
  const [isDragging, setIsDragging] = useState(false);

  const [formData, setFormData] = useState({
    payee_code: '',
    full_name: '',
    business_role: 'sales_commission_recipient' as PayeeBusinessRole,
    tax_classification: 'bukan_pegawai_imbalan' as PayeeTaxClassification,
    nik: '',
    npwp: '',
    ptkp_status: 'TK/0',
    default_pph_code_id: '',
    bank_name: '',
    bank_account_number: '',
    bank_account_holder: '',
    phone: '',
    email: '',
    address: '',
    notes: '',
    document_urls: [] as string[],
    is_active: true,
  });

  useEffect(() => {
    loadPayees();
    loadTaxCodes();
  }, []);

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
            const filename = `ktp_paste_${Date.now()}_${i + 1}.${ext}`;
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
          message: `${files.length} file(s) attached. Click 'Save Changes' to store permanently.`,
        });
      }
    };

    window.addEventListener('paste', handlePaste);
    return () => window.removeEventListener('paste', handlePaste);
  }, [modalOpen]);

  const loadTaxCodes = async () => {
    const { data, error } = await supabase
      .from('tax_codes')
      .select('id, code, name, tax_type')
      .eq('is_active', true)
      .order('code');
    if (!error && data) {
      setTaxCodes(data);
    }
  };

  const loadPayees = async () => {
    setLoading(true);
    const { data, error } = await supabase
      .from('finance_payees')
      .select('*')
      .order('payee_code', { ascending: true });
    if (error) {
      showToast({ type: 'error', title: 'Failed to load payees', message: error.message });
    } else {
      setPayees(data || []);
    }
    setLoading(false);
  };

  const generateNextPayeeCode = (): string => {
    const maxNumber = payees.reduce((max, p) => {
      const match = p.payee_code?.match(/^PAY-(\d+)$/);
      if (match) {
        const num = parseInt(match[1], 10);
        return num > max ? num : max;
      }
      return max;
    }, 0);
    return `PAY-${String(maxNumber + 1).padStart(4, '0')}`;
  };

  const openCreateModal = () => {
    const defaultCode = generateNextPayeeCode();
    const defaultTaxCode = taxCodes.find(tc => tc.code === 'PPH21-NE')?.id || '';
    setEditingPayee(null);
    setPendingFiles([]);
    setFormData({
      payee_code: defaultCode,
      full_name: '',
      business_role: 'sales_commission_recipient',
      tax_classification: 'bukan_pegawai_imbalan',
      nik: '',
      npwp: '',
      ptkp_status: 'TK/0',
      default_pph_code_id: defaultTaxCode,
      bank_name: '',
      bank_account_number: '',
      bank_account_holder: '',
      phone: '',
      email: '',
      address: '',
      notes: '',
      document_urls: [],
      is_active: true,
    });
    setModalOpen(true);
  };

  const openEditModal = (p: Payee) => {
    setEditingPayee(p);
    setPendingFiles([]);
    setFormData({
      payee_code: p.payee_code,
      full_name: p.full_name,
      business_role: p.business_role,
      tax_classification: p.tax_classification,
      nik: p.nik || '',
      npwp: p.npwp || '',
      ptkp_status: p.ptkp_status || 'TK/0',
      default_pph_code_id: p.default_pph_code_id || '',
      bank_name: p.bank_name || '',
      bank_account_number: p.bank_account_number || '',
      bank_account_holder: p.bank_account_holder || '',
      phone: p.phone || '',
      email: p.email || '',
      address: p.address || '',
      notes: p.notes || '',
      document_urls: p.document_urls || [],
      is_active: p.is_active,
    });
    setModalOpen(true);
  };

  const handleRoleChange = (role: PayeeBusinessRole) => {
    const suggestedClass = DEFAULT_ROLE_TAX_MAP[role];
    let suggestedTaxCodeId = formData.default_pph_code_id;
    if (suggestedClass === 'pemilik_sewa_op') {
      suggestedTaxCodeId = taxCodes.find(tc => tc.code === 'PPH4(2)')?.id || suggestedTaxCodeId;
    } else if (suggestedClass === 'pegawai_tidak_tetap') {
      suggestedTaxCodeId = taxCodes.find(tc => tc.code === 'PPH21-TT')?.id || suggestedTaxCodeId;
    } else {
      suggestedTaxCodeId = taxCodes.find(tc => tc.code === 'PPH21-NE')?.id || suggestedTaxCodeId;
    }
    setFormData(prev => ({
      ...prev,
      business_role: role,
      tax_classification: suggestedClass,
      default_pph_code_id: suggestedTaxCodeId,
    }));
  };

  const handleSave = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!formData.full_name.trim()) {
      showToast({ type: 'error', title: 'Validation error', message: 'Payee full name is required.' });
      return;
    }

    // NIK validation if entered
    const cleanNik = formData.nik.trim();
    if (cleanNik && !/^\d{16}$/.test(cleanNik)) {
      showToast({
        type: 'error',
        title: 'Invalid NIK',
        message: 'Indonesian NIK must consist of exactly 16 numeric digits.',
      });
      return;
    }

    setIsSaving(true);
    try {
      let finalDocUrls = [...(formData.document_urls || [])];
      if (pendingFiles.length > 0) {
        showToast({ type: 'info', title: 'Uploading documents', message: `Uploading ${pendingFiles.length} document(s)...` });
        const uploadedUrls = await uploadFinanceDocuments(pendingFiles, 'payees');
        finalDocUrls = [...finalDocUrls, ...uploadedUrls];
      }

      const payload = {
        payee_code: formData.payee_code.trim(),
        full_name: formData.full_name.trim(),
        business_role: formData.business_role,
        tax_classification: formData.tax_classification,
        nik: cleanNik || null,
        npwp: formData.npwp.trim() || null,
        ptkp_status: formData.ptkp_status,
        default_pph_code_id: formData.default_pph_code_id || null,
        bank_name: formData.bank_name.trim() || null,
        bank_account_number: formData.bank_account_number.trim() || null,
        bank_account_holder: formData.bank_account_holder.trim() || null,
        phone: formData.phone.trim() || null,
        email: formData.email.trim() || null,
        address: formData.address.trim() || null,
        notes: formData.notes.trim() || null,
        document_urls: finalDocUrls,
        is_active: formData.is_active,
      };

      if (editingPayee) {
        const { error } = await supabase
          .from('finance_payees')
          .update(payload)
          .eq('id', editingPayee.id);
        if (error) {
          showToast({ type: 'error', title: 'Update failed', message: error.message });
        } else {
          showToast({ type: 'success', title: 'Payee updated', message: `Payee ${payload.payee_code} saved successfully with ${finalDocUrls.length} document(s).` });
          setModalOpen(false);
          setPendingFiles([]);
          loadPayees();
        }
      } else {
        const { error } = await supabase
          .from('finance_payees')
          .insert(payload);
        if (error) {
          showToast({ type: 'error', title: 'Creation failed', message: error.message });
        } else {
          showToast({ type: 'success', title: 'Payee created', message: `Payee ${payload.payee_code} created successfully.` });
          setModalOpen(false);
          setPendingFiles([]);
          loadPayees();
        }
      }
    } catch (err: any) {
      showToast({ type: 'error', title: 'Upload failed', message: err.message || 'Failed to upload attachments' });
    } finally {
      setIsSaving(false);
    }
  };

  const filteredPayees = useMemo(() => {
    return payees.filter(p => {
      const q = search.toLowerCase();
      const matchesSearch =
        !q ||
        p.full_name?.toLowerCase().includes(q) ||
        p.payee_code?.toLowerCase().includes(q) ||
        p.bank_account_number?.toLowerCase().includes(q) ||
        p.nik?.includes(q) ||
        p.npwp?.includes(q);

      const matchesRole = roleFilter === 'all' || p.business_role === roleFilter;
      const matchesStatus =
        statusFilter === 'all' ||
        (statusFilter === 'active' && p.is_active) ||
        (statusFilter === 'inactive' && !p.is_active);

      return matchesSearch && matchesRole && matchesStatus;
    });
  }, [payees, search, roleFilter, statusFilter]);

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

  return (
    <div className="p-6 max-w-7xl mx-auto space-y-6">
      {/* Header */}
      <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-4 border-b border-gray-200 pb-5">
        <div>
          <div className="flex items-center gap-3">
            <div className="p-2 bg-indigo-50 text-indigo-700 rounded-lg">
              <Users className="w-6 h-6" />
            </div>
            <div>
              <h1 className="text-2xl font-bold text-gray-900">Payee Master</h1>
              <p className="text-sm text-gray-500">
                Manage individual service providers, sales commission recipients, consultants, and landlords.
              </p>
            </div>
          </div>
        </div>

        {canManage && (
          <button
            onClick={openCreateModal}
            className="inline-flex items-center gap-2 px-4 py-2 bg-indigo-600 hover:bg-indigo-700 text-white text-sm font-medium rounded-lg shadow-sm transition-colors"
          >
            <Plus className="w-4 h-4" />
            New Payee
          </button>
        )}
      </div>

      {/* Filters Bar */}
      <div className="bg-white p-4 rounded-xl border border-gray-200 shadow-sm flex flex-col md:flex-row gap-4 justify-between items-center">
        <div className="relative w-full md:w-80">
          <Search className="w-4 h-4 text-gray-400 absolute left-3 top-1/2 -translate-y-1/2" />
          <input
            type="text"
            placeholder="Search name, code, bank, NIK/NPWP..."
            value={search}
            onChange={e => setSearch(e.target.value)}
            className="w-full pl-9 pr-4 py-2 border border-gray-300 rounded-lg text-sm focus:ring-2 focus:ring-indigo-500 focus:border-indigo-500"
          />
        </div>

        <div className="flex flex-wrap items-center gap-3 w-full md:w-auto">
          <div className="flex items-center gap-2">
            <span className="text-xs font-medium text-gray-500 uppercase">Role:</span>
            <select
              value={roleFilter}
              onChange={e => setRoleFilter(e.target.value)}
              className="text-sm border border-gray-300 rounded-lg px-3 py-1.5 bg-white text-gray-700 focus:ring-indigo-500 focus:border-indigo-500"
            >
              <option value="all">All Roles</option>
              {Object.entries(BUSINESS_ROLE_LABELS).map(([k, v]) => (
                <option key={k} value={k}>{v}</option>
              ))}
            </select>
          </div>

          <div className="flex items-center gap-2">
            <span className="text-xs font-medium text-gray-500 uppercase">Status:</span>
            <select
              value={statusFilter}
              onChange={e => setStatusFilter(e.target.value)}
              className="text-sm border border-gray-300 rounded-lg px-3 py-1.5 bg-white text-gray-700 focus:ring-indigo-500 focus:border-indigo-500"
            >
              <option value="active">Active</option>
              <option value="inactive">Inactive</option>
              <option value="all">All Status</option>
            </select>
          </div>
        </div>
      </div>

      {/* Payees Table */}
      <div className="bg-white rounded-xl border border-gray-200 shadow-sm overflow-hidden">
        {loading ? (
          <div className="p-12 text-center text-gray-500">Loading payees...</div>
        ) : filteredPayees.length === 0 ? (
          <div className="p-12 text-center text-gray-500">
            No payees found matching current filters.
          </div>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-left text-sm text-gray-700 divide-y divide-gray-200">
              <thead className="bg-gray-50 text-gray-600 font-medium">
                <tr>
                  <th className="px-4 py-3">Code</th>
                  <th className="px-4 py-3">Full Name</th>
                  <th className="px-4 py-3">Business Role</th>
                  <th className="px-4 py-3">Tax Classification</th>
                  <th className="px-4 py-3">Tax ID (NIK / NPWP)</th>
                  <th className="px-4 py-3">Bank Details</th>
                  <th className="px-4 py-3">KYC / Docs</th>
                  <th className="px-4 py-3">Status</th>
                  {canManage && <th className="px-4 py-3 text-right">Actions</th>}
                </tr>
              </thead>
              <tbody className="divide-y divide-gray-200">
                {filteredPayees.map(p => (
                  <tr key={p.id} className="hover:bg-gray-50/75 transition-colors">
                    <td className="px-4 py-3 font-mono font-medium text-indigo-600">
                      {p.payee_code}
                    </td>
                    <td className="px-4 py-3">
                      <div className="font-medium text-gray-900">{p.full_name}</div>
                      {p.phone && <div className="text-xs text-gray-500">{p.phone}</div>}
                    </td>
                    <td className="px-4 py-3">
                      <span className="inline-flex items-center px-2 py-0.5 rounded text-xs font-medium bg-blue-50 text-blue-700">
                        {BUSINESS_ROLE_LABELS[p.business_role] || p.business_role}
                      </span>
                    </td>
                    <td className="px-4 py-3">
                      <div className="text-xs text-gray-700 font-medium">
                        {TAX_CLASSIFICATION_LABELS[p.tax_classification] || p.tax_classification}
                      </div>
                      <div className="text-xs text-gray-400">PTKP: {p.ptkp_status}</div>
                    </td>
                    <td className="px-4 py-3">
                      {p.nik ? (
                        <div className="text-xs font-mono text-gray-800">
                          <span className="text-gray-400 mr-1">NIK:</span>{p.nik}
                        </div>
                      ) : p.npwp ? (
                        <div className="text-xs font-mono text-gray-800">
                          <span className="text-gray-400 mr-1">NPWP:</span>{p.npwp}
                        </div>
                      ) : (
                        <span className="inline-flex items-center gap-1 text-xs text-amber-600 font-medium">
                          <AlertTriangle className="w-3 h-3" /> Missing ID
                        </span>
                      )}
                    </td>
                    <td className="px-4 py-3">
                      {p.bank_name || p.bank_account_number ? (
                        <div className="text-xs">
                          <div className="font-medium text-gray-800">{p.bank_name || 'Bank'}</div>
                          <div className="font-mono text-gray-500">{p.bank_account_number}</div>
                          {p.bank_account_holder && (
                            <div className="text-gray-400 truncate max-w-[150px]">a.n. {p.bank_account_holder}</div>
                          )}
                        </div>
                      ) : (
                        <span className="text-xs text-gray-400">—</span>
                      )}
                    </td>
                    <td className="px-4 py-3">
                      {p.document_urls && p.document_urls.length > 0 ? (
                        <button
                          type="button"
                          onClick={() => openEditModal(p)}
                          className="inline-flex items-center gap-1.5 px-2.5 py-1 rounded-full text-xs font-medium bg-indigo-50 text-indigo-700 hover:bg-indigo-100 transition-colors border border-indigo-200/60"
                          title="Click to view and manage attached documents"
                        >
                          <Paperclip className="w-3.5 h-3.5" />
                          <span>{p.document_urls.length} doc{p.document_urls.length > 1 ? 's' : ''}</span>
                        </button>
                      ) : (
                        <span className="text-xs text-gray-400">—</span>
                      )}
                    </td>
                    <td className="px-4 py-3">
                      {p.is_active ? (
                        <span className="inline-flex items-center gap-1 text-xs font-medium text-emerald-700 bg-emerald-50 px-2 py-0.5 rounded">
                          <CheckCircle className="w-3 h-3" /> Active
                        </span>
                      ) : (
                        <span className="inline-flex items-center gap-1 text-xs font-medium text-gray-500 bg-gray-100 px-2 py-0.5 rounded">
                          <XCircle className="w-3 h-3" /> Inactive
                        </span>
                      )}
                    </td>
                    {canManage && (
                      <td className="px-4 py-3 text-right">
                        <button
                          onClick={() => openEditModal(p)}
                          className="p-1.5 text-gray-500 hover:text-indigo-600 hover:bg-indigo-50 rounded transition-colors"
                          title="Edit Payee"
                        >
                          <Edit2 className="w-4 h-4" />
                        </button>
                      </td>
                    )}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>

      {/* Create / Edit Modal */}
      {modalOpen && (
        <div className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-black/40 backdrop-blur-sm">
          <div className="bg-white rounded-2xl shadow-xl w-full max-w-2xl max-h-[90vh] overflow-y-auto border border-gray-100">
            <div className="sticky top-0 bg-white px-6 py-4 border-b border-gray-200 flex justify-between items-center z-10">
              <div className="flex items-center gap-2">
                <div className="p-2 bg-indigo-50 text-indigo-700 rounded-lg">
                  <Users className="w-5 h-5" />
                </div>
                <h2 className="text-lg font-bold text-gray-900">
                  {editingPayee ? `Edit Payee: ${editingPayee.payee_code}` : 'Add New Payee'}
                </h2>
              </div>
              <button
                onClick={() => setModalOpen(false)}
                className="text-gray-400 hover:text-gray-600 p-1 rounded-lg"
              >
                ✕
              </button>
            </div>

            <form onSubmit={handleSave} className="p-6 space-y-6">
              {/* Section 1: Basic Information */}
              <div className="space-y-4">
                <h3 className="text-xs font-bold uppercase tracking-wider text-gray-400">
                  1. Basic Information
                </h3>
                <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
                  <div>
                    <label className="block text-xs font-medium text-gray-700 mb-1">
                      Payee Code <span className="text-red-500">*</span>
                    </label>
                    <input
                      type="text"
                      required
                      value={formData.payee_code}
                      onChange={e => setFormData({ ...formData, payee_code: e.target.value })}
                      className="w-full px-3 py-2 border border-gray-300 rounded-lg text-sm font-mono focus:ring-2 focus:ring-indigo-500"
                      placeholder="PAY-0001"
                    />
                  </div>

                  <div>
                    <label className="block text-xs font-medium text-gray-700 mb-1">
                      Full Name <span className="text-red-500">*</span>
                    </label>
                    <input
                      type="text"
                      required
                      value={formData.full_name}
                      onChange={e => setFormData({ ...formData, full_name: e.target.value })}
                      className="w-full px-3 py-2 border border-gray-300 rounded-lg text-sm focus:ring-2 focus:ring-indigo-500"
                      placeholder="e.g. Rudi Kartono"
                    />
                  </div>

                  <div>
                    <label className="block text-xs font-medium text-gray-700 mb-1">
                      Business Role <span className="text-red-500">*</span>
                    </label>
                    <select
                      value={formData.business_role}
                      onChange={e => handleRoleChange(e.target.value as PayeeBusinessRole)}
                      className="w-full px-3 py-2 border border-gray-300 rounded-lg text-sm bg-white focus:ring-2 focus:ring-indigo-500"
                    >
                      {Object.entries(BUSINESS_ROLE_LABELS).map(([k, v]) => (
                        <option key={k} value={k}>{v}</option>
                      ))}
                    </select>
                  </div>

                  <div>
                    <label className="block text-xs font-medium text-gray-700 mb-1">
                      Tax Classification (DJP) <span className="text-red-500">*</span>
                    </label>
                    <select
                      value={formData.tax_classification}
                      onChange={e => setFormData({ ...formData, tax_classification: e.target.value as PayeeTaxClassification })}
                      className="w-full px-3 py-2 border border-gray-300 rounded-lg text-sm bg-white focus:ring-2 focus:ring-indigo-500"
                    >
                      {Object.entries(TAX_CLASSIFICATION_LABELS).map(([k, v]) => (
                        <option key={k} value={k}>{v}</option>
                      ))}
                    </select>
                  </div>
                </div>
              </div>

              {/* Section 2: Tax Identity & Default Regime */}
              <div className="space-y-4 pt-4 border-t border-gray-100">
                <h3 className="text-xs font-bold uppercase tracking-wider text-gray-400">
                  2. Tax Identity & Default PPh Profile
                </h3>
                <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
                  <div>
                    <label className="block text-xs font-medium text-gray-700 mb-1">
                      NIK (KTP 16 Digits)
                    </label>
                    <input
                      type="text"
                      maxLength={16}
                      value={formData.nik}
                      onChange={e => setFormData({ ...formData, nik: e.target.value.replace(/\D/g, '') })}
                      className="w-full px-3 py-2 border border-gray-300 rounded-lg text-sm font-mono focus:ring-2 focus:ring-indigo-500"
                      placeholder="3171xxxxxxxxxxxx (Optional)"
                    />
                    <p className="text-[11px] text-gray-400 mt-1">
                      Optional for creation; strictly required by DJP for month-end e-Bupot filing.
                    </p>
                  </div>

                  <div>
                    <label className="block text-xs font-medium text-gray-700 mb-1">
                      NPWP (Tax ID)
                    </label>
                    <input
                      type="text"
                      value={formData.npwp}
                      onChange={e => setFormData({ ...formData, npwp: e.target.value })}
                      className="w-full px-3 py-2 border border-gray-300 rounded-lg text-sm font-mono focus:ring-2 focus:ring-indigo-500"
                      placeholder="00.000.000.0-000.000 (Optional)"
                    />
                  </div>

                  <div>
                    <label className="block text-xs font-medium text-gray-700 mb-1">
                      PTKP Status
                    </label>
                    <select
                      value={formData.ptkp_status}
                      onChange={e => setFormData({ ...formData, ptkp_status: e.target.value })}
                      className="w-full px-3 py-2 border border-gray-300 rounded-lg text-sm bg-white focus:ring-2 focus:ring-indigo-500"
                    >
                      {['TK/0', 'TK/1', 'TK/2', 'TK/3', 'K/0', 'K/1', 'K/2', 'K/3'].map(s => (
                        <option key={s} value={s}>{s}</option>
                      ))}
                    </select>
                  </div>

                  <div>
                    <label className="block text-xs font-medium text-gray-700 mb-1">
                      Default Tax Code Recommendation
                    </label>
                    <select
                      value={formData.default_pph_code_id}
                      onChange={e => setFormData({ ...formData, default_pph_code_id: e.target.value })}
                      className="w-full px-3 py-2 border border-gray-300 rounded-lg text-sm bg-white focus:ring-2 focus:ring-indigo-500"
                    >
                      <option value="">No Default</option>
                      {taxCodes.map(tc => (
                        <option key={tc.id} value={tc.id}>
                          {tc.code} — {tc.name}
                        </option>
                      ))}
                    </select>
                  </div>
                </div>
              </div>

              {/* Section 3: Banking Details */}
              <div className="space-y-4 pt-4 border-t border-gray-100">
                <h3 className="text-xs font-bold uppercase tracking-wider text-gray-400">
                  3. Bank Account Information
                </h3>
                <div className="grid grid-cols-1 sm:grid-cols-3 gap-4">
                  <div>
                    <label className="block text-xs font-medium text-gray-700 mb-1">
                      Bank Name
                    </label>
                    <input
                      type="text"
                      value={formData.bank_name}
                      onChange={e => setFormData({ ...formData, bank_name: e.target.value })}
                      className="w-full px-3 py-2 border border-gray-300 rounded-lg text-sm focus:ring-2 focus:ring-indigo-500"
                      placeholder="e.g. BCA / Mandiri"
                    />
                  </div>

                  <div>
                    <label className="block text-xs font-medium text-gray-700 mb-1">
                      Account Number
                    </label>
                    <input
                      type="text"
                      value={formData.bank_account_number}
                      onChange={e => setFormData({ ...formData, bank_account_number: e.target.value })}
                      className="w-full px-3 py-2 border border-gray-300 rounded-lg text-sm font-mono focus:ring-2 focus:ring-indigo-500"
                      placeholder="1234567890"
                    />
                  </div>

                  <div>
                    <label className="block text-xs font-medium text-gray-700 mb-1">
                      Account Beneficiary Name
                    </label>
                    <input
                      type="text"
                      value={formData.bank_account_holder}
                      onChange={e => setFormData({ ...formData, bank_account_holder: e.target.value })}
                      className="w-full px-3 py-2 border border-gray-300 rounded-lg text-sm focus:ring-2 focus:ring-indigo-500"
                      placeholder="Name as in bank book"
                    />
                  </div>
                </div>
              </div>

              {/* Section 4: Contact & Notes */}
              <div className="space-y-4 pt-4 border-t border-gray-100">
                <h3 className="text-xs font-bold uppercase tracking-wider text-gray-400">
                  4. Contact Details & Notes
                </h3>
                <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
                  <div>
                    <label className="block text-xs font-medium text-gray-700 mb-1">
                      Phone Number
                    </label>
                    <input
                      type="text"
                      value={formData.phone}
                      onChange={e => setFormData({ ...formData, phone: e.target.value })}
                      className="w-full px-3 py-2 border border-gray-300 rounded-lg text-sm focus:ring-2 focus:ring-indigo-500"
                      placeholder="+62 812-xxxx-xxxx"
                    />
                  </div>

                  <div>
                    <label className="block text-xs font-medium text-gray-700 mb-1">
                      Email Address
                    </label>
                    <input
                      type="email"
                      value={formData.email}
                      onChange={e => setFormData({ ...formData, email: e.target.value })}
                      className="w-full px-3 py-2 border border-gray-300 rounded-lg text-sm focus:ring-2 focus:ring-indigo-500"
                      placeholder="payee@example.com"
                    />
                  </div>
                </div>

                <div>
                  <label className="block text-xs font-medium text-gray-700 mb-1">
                    Notes
                  </label>
                  <textarea
                    rows={2}
                    value={formData.notes}
                    onChange={e => setFormData({ ...formData, notes: e.target.value })}
                    className="w-full px-3 py-2 border border-gray-300 rounded-lg text-sm focus:ring-2 focus:ring-indigo-500"
                    placeholder="Additional context or service scope..."
                  />
                </div>

                <div className="flex items-center gap-2 pt-2">
                  <input
                    type="checkbox"
                    id="is_active"
                    checked={formData.is_active}
                    onChange={e => setFormData({ ...formData, is_active: e.target.checked })}
                    className="rounded border-gray-300 text-indigo-600 focus:ring-indigo-500 h-4 w-4"
                  />
                  <label htmlFor="is_active" className="text-sm font-medium text-gray-700">
                    Active (can be selected in Expense vouchers)
                  </label>
                </div>
              </div>

              {/* Section 5: Attachments & Identity Verification (KTP, NPWP, Bank Book, Contract) */}
              <div className="space-y-4 pt-4 border-t border-gray-100">
                <div className="flex items-center justify-between">
                  <div>
                    <h3 className="text-xs font-bold uppercase tracking-wider text-gray-400 flex items-center gap-1.5">
                      <Paperclip className="w-3.5 h-3.5 text-indigo-600" />
                      5. Identity Documents & Attachments (KTP, NPWP, Bank Book)
                    </h3>
                    <p className="text-[11px] text-gray-500 mt-0.5">
                      Attach photo or PDF of payee's KTP, NPWP, passbook, or agreement for compliance records.
                    </p>
                  </div>
                  <span className="text-[11px] text-indigo-700 font-medium bg-indigo-50 px-2 py-0.5 rounded-full border border-indigo-100">
                    {(formData.document_urls?.length || 0) + pendingFiles.length} file(s)
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
                  className={`border-2 border-dashed rounded-xl p-5 text-center transition-all ${
                    isDragging
                      ? 'border-indigo-500 bg-indigo-50/70 scale-[0.99]'
                      : 'border-gray-200 hover:border-indigo-300 hover:bg-gray-50/60'
                  }`}
                >
                  <input
                    type="file"
                    id="payee-doc-upload"
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
                    className="flex flex-col items-center justify-center gap-2 cursor-pointer"
                    onClick={() => document.getElementById('payee-doc-upload')?.click()}
                  >
                    <div className="p-3 bg-indigo-50 text-indigo-600 rounded-full shadow-xs">
                      <UploadCloud className="w-6 h-6" />
                    </div>
                    <div>
                      <span className="text-xs font-semibold text-gray-800 hover:text-indigo-600">
                        Click to browse
                      </span>
                      <span className="text-xs text-gray-500"> or drag & drop files here</span>
                    </div>
                    <div className="inline-flex items-center gap-1.5 text-[11px] text-indigo-700 bg-indigo-50 px-3 py-1.5 rounded-lg font-medium border border-indigo-100">
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
                {((formData.document_urls && formData.document_urls.length > 0) || pendingFiles.length > 0) && (
                  <div className="grid grid-cols-1 sm:grid-cols-2 gap-3 pt-1">
                    {/* Existing Saved Documents */}
                    {formData.document_urls?.map((url, idx) => {
                      const isImg = isImageUrl(url);
                      const name = getDocDisplayName(url, idx);
                      return (
                        <div
                          key={url}
                          className="group relative flex items-center gap-3 p-2.5 rounded-xl border border-gray-200 bg-white hover:border-indigo-200 hover:shadow-xs transition-all"
                        >
                          {/* Thumbnail / Icon */}
                          <div
                            className="w-12 h-12 rounded-lg bg-gray-100 overflow-hidden shrink-0 flex items-center justify-center border border-gray-100 cursor-pointer"
                            onClick={() => openStorageDocument(url)}
                            title="Click to view full size"
                          >
                            {isImg ? (
                              <img
                                src={url}
                                alt={name}
                                className="w-full h-full object-cover group-hover:scale-105 transition-transform"
                                onError={(e) => {
                                  // fallback if public url doesn't render directly
                                  (e.target as HTMLElement).style.display = 'none';
                                }}
                              />
                            ) : (
                              <FileText className="w-6 h-6 text-red-500" />
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
                                setFormData(prev => ({
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
                          <div className="w-12 h-12 rounded-lg bg-indigo-100/50 overflow-hidden shrink-0 flex items-center justify-center border border-indigo-100">
                            {isImg && objectUrl ? (
                              <img
                                src={objectUrl}
                                alt={file.name}
                                className="w-full h-full object-cover"
                              />
                            ) : (
                              <FileText className="w-6 h-6 text-indigo-500" />
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

              {/* Actions */}
              <div className="flex justify-end gap-3 pt-4 border-t border-gray-200">
                <button
                  type="button"
                  disabled={isSaving}
                  onClick={() => setModalOpen(false)}
                  className="px-4 py-2 border border-gray-300 rounded-lg text-sm font-medium text-gray-700 hover:bg-gray-50 transition-colors disabled:opacity-50"
                >
                  Cancel
                </button>
                <button
                  type="submit"
                  disabled={isSaving}
                  className="inline-flex items-center gap-2 px-5 py-2 bg-indigo-600 hover:bg-indigo-700 disabled:bg-indigo-400 text-white text-sm font-medium rounded-lg shadow-sm transition-colors"
                >
                  {isSaving && <Loader2 className="w-4 h-4 animate-spin" />}
                  {isSaving ? 'Uploading & Saving...' : (editingPayee ? 'Save Changes' : 'Create Payee')}
                </button>
              </div>
            </form>
          </div>
        </div>
      )}
    </div>
  );
}
