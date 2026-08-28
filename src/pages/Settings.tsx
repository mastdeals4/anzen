import React, { useEffect, useState } from 'react';
import { Layout } from '../components/Layout';
import { useLanguage } from '../contexts/LanguageContext';
import { useAuth } from '../contexts/AuthContext';
import { supabase } from '../lib/supabase';
import { Save, Building2, Mail, DollarSign, Package, Users, Calendar, FileText, Download, Upload, X, CheckCircle, AlertCircle, Info } from 'lucide-react';
import { GmailSettings } from '../components/crm/GmailSettings';
import { GmailVisibilityPanel } from '../components/crm/GmailVisibilityPanel';
import { UserManagement } from '../components/settings/UserManagement';
import { EmailTemplates } from '../components/settings/EmailTemplates';
import { ExtractData } from '../components/settings/ExtractData';
import { SuppliersManager } from '../components/settings/SuppliersManager';
import { AboutSystem } from '../components/settings/AboutSystem';
import { formatDate } from '../utils/dateFormat';
import { MoneyInput } from '../components/MoneyInput';

interface AppSettings {
  id: string;
  company_name: string;
  company_address: string;
  company_phone: string;
  company_email: string;
  tax_rate: number;
  invoice_prefix: string;
  invoice_start_number: number;
  email_host: string | null;
  email_port: number | null;
  email_username: string | null;
  low_stock_threshold: number;
  expiry_alert_days: number;
  default_language: string;
  financial_year_start: string;
  financial_year_end: string;
  current_financial_year: string;
  rounding_tolerance_amount: number;
  rounding_writeoff_account_id: string | null;
  rounding_gain_account_id: string | null;
  bulk_email_batch_size: number;
  bulk_email_batch_delay_seconds: number;
  bulk_email_worker_url: string | null;
  bulk_email_worker_secret: string | null;
  setup_mode?: boolean;
}

interface ChartAccount {
  id: string;
  code: string;
  name: string;
  account_type: string;
}

interface UserProfile {
  id: string;
  username: string;
  email: string;
  full_name: string;
  role: 'admin' | 'manager' | 'accounts' | 'sales' | 'warehouse' | 'auditor_ca';
  language?: string;
  is_active: boolean;
  created_at: string;
}

export function Settings() {
  const { t } = useLanguage();
  const { profile } = useAuth();

  const getDefaultTab = () => {
    if (profile?.role === 'sales') return 'gmail';
    if (profile?.role === 'warehouse') return 'suppliers';
    if (profile?.role === 'accounts') return 'company';
    return 'company';
  };

  const [activeTab, setActiveTab] = useState<'company' | 'users' | 'suppliers' | 'system' | 'financial' | 'gmail' | 'templates' | 'extract' | 'about'>(getDefaultTab());
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [settings, setSettings] = useState<AppSettings | null>(null);

  // Company identity versioning
  interface CompanyProfileRow {
    id: string;
    effective_from: string;
    company_name: string;
    company_legal_name: string | null;
    company_address: string | null;
    company_phone: string | null;
    company_email: string | null;
    company_website: string | null;
    company_tax_id: string | null;
    company_logo_url: string | null;
    company_stamp_url: string | null;
    pbf_license: string | null;
    cdob_certificate: string | null;
    notes: string | null;
  }
  type ProfileFormData = {
    effective_from: string;
    company_name: string;
    company_legal_name: string;
    company_address: string;
    company_phone: string;
    company_email: string;
    company_website: string;
    company_tax_id: string;
    company_logo_url: string;
    company_stamp_url: string;
    pbf_license: string;
    cdob_certificate: string;
    notes: string;
  };
  const emptyProfileForm = (): ProfileFormData => ({
    effective_from: new Date().toISOString().split('T')[0],
    company_name: '',
    company_legal_name: '',
    company_address: '',
    company_phone: '',
    company_email: '',
    company_website: '',
    company_tax_id: '',
    company_logo_url: '',
    company_stamp_url: '',
    pbf_license: '',
    cdob_certificate: '',
    notes: '',
  });
  const [companyProfiles, setCompanyProfiles] = useState<CompanyProfileRow[]>([]);
  const [profileRefCounts, setProfileRefCounts] = useState<Record<string, number>>({});
  const [setupMode, setSetupMode] = useState(false);
  const [togglingSetupMode, setTogglingSetupMode] = useState(false);
  const [showNewProfileForm, setShowNewProfileForm] = useState(false);
  const [newProfileData, setNewProfileData] = useState<ProfileFormData>(emptyProfileForm());
  const [editingProfile, setEditingProfile] = useState<CompanyProfileRow | null>(null);
  const [editProfileData, setEditProfileData] = useState<ProfileFormData>(emptyProfileForm());
  const [uploadingAsset, setUploadingAsset] = useState<null | 'logo' | 'stamp'>(null);
  const [savingProfile, setSavingProfile] = useState(false);
  const [deletingProfileId, setDeletingProfileId] = useState<string | null>(null);
  const [users, setUsers] = useState<UserProfile[]>([]);
  const [accounts, setAccounts] = useState<ChartAccount[]>([]);
  const [formData, setFormData] = useState({
    company_name: '',
    company_address: '',
    company_phone: '',
    company_email: '',
    tax_rate: 11,
    invoice_prefix: 'SAPJ',
    invoice_start_number: 1,
    email_host: '',
    email_port: 587,
    email_username: '',
    low_stock_threshold: 100,
    expiry_alert_days: 30,
    default_language: 'en',
    financial_year_start: '2024-01-01',
    financial_year_end: '2024-12-31',
    current_financial_year: '2024',
    rounding_tolerance_amount: 100,
    rounding_writeoff_account_id: '',
    rounding_gain_account_id: '',
    bulk_email_batch_size: 10,
    bulk_email_batch_delay_seconds: 30,
    bulk_email_worker_url: '',
    bulk_email_worker_secret: '',
  });

  useEffect(() => {
    if (profile?.role === 'admin') {
      loadSettings();
      loadUsers();
      loadAccounts();
      loadCompanyProfiles();
    } else if (profile?.role === 'accounts') {
      loadSettings();
      loadAccounts();
      loadCompanyProfiles();
    } else if (profile?.role === 'warehouse') {
      setLoading(false);
    } else {
      setLoading(false);
    }
  }, [profile]);

  const loadSettings = async () => {
    try {
      const { data, error } = await supabase
        .from('app_settings')
        .select('*')
        .order('created_at', { ascending: true })
        .limit(1)
        .maybeSingle();

      if (error) throw error;

      if (data) {
        setSettings(data);
        setSetupMode(Boolean(data.setup_mode));
        setFormData({
          company_name: data.company_name || '',
          company_address: data.company_address || '',
          company_phone: data.company_phone || '',
          company_email: data.company_email || '',
          tax_rate: data.tax_rate || 11,
          invoice_prefix: data.invoice_prefix || 'SAPJ',
          invoice_start_number: data.invoice_start_number || 1,
          email_host: data.email_host || '',
          email_port: data.email_port || 587,
          email_username: data.email_username || '',
          low_stock_threshold: data.low_stock_threshold || 100,
          expiry_alert_days: data.expiry_alert_days || 30,
          default_language: data.default_language || 'en',
          financial_year_start: data.financial_year_start || '2024-01-01',
          financial_year_end: data.financial_year_end || '2024-12-31',
          current_financial_year: data.current_financial_year || '2024',
          rounding_tolerance_amount: Number(data.rounding_tolerance_amount ?? 100),
          rounding_writeoff_account_id: data.rounding_writeoff_account_id || '',
          rounding_gain_account_id: data.rounding_gain_account_id || '',
          bulk_email_batch_size: Number(data.bulk_email_batch_size ?? 10),
          bulk_email_batch_delay_seconds: Number(data.bulk_email_batch_delay_seconds ?? 30),
          bulk_email_worker_url: data.bulk_email_worker_url || '',
          bulk_email_worker_secret: data.bulk_email_worker_secret || '',
        });
      }
    } catch (error) {
      console.error('Error loading settings:', error);
    } finally {
      setLoading(false);
    }
  };

  const loadCompanyProfiles = async () => {
    const [{ data: profiles }, { data: refs }] = await Promise.all([
      supabase
        .from('company_profiles')
        .select('id, effective_from, company_name, company_legal_name, company_address, company_phone, company_email, company_website, company_tax_id, company_logo_url, company_stamp_url, pbf_license, cdob_certificate, notes')
        .order('effective_from', { ascending: false }),
      supabase.rpc('get_company_profile_reference_counts'),
    ]);
    setCompanyProfiles(profiles || []);
    const refMap: Record<string, number> = {};
    for (const r of (refs as { profile_id: string; ref_count: number | string }[] | null) || []) {
      refMap[r.profile_id] = Number(r.ref_count) || 0;
    }
    setProfileRefCounts(refMap);
  };

  const profileToFormData = (cp: CompanyProfileRow): ProfileFormData => ({
    effective_from: cp.effective_from,
    company_name: cp.company_name || '',
    company_legal_name: cp.company_legal_name || '',
    company_address: cp.company_address || '',
    company_phone: cp.company_phone || '',
    company_email: cp.company_email || '',
    company_website: cp.company_website || '',
    company_tax_id: cp.company_tax_id || '',
    company_logo_url: cp.company_logo_url || '',
    company_stamp_url: cp.company_stamp_url || '',
    pbf_license: cp.pbf_license || '',
    cdob_certificate: cp.cdob_certificate || '',
    notes: cp.notes || '',
  });

  const formToPayload = (fd: ProfileFormData) => ({
    effective_from: fd.effective_from,
    company_name: fd.company_name,
    company_legal_name: fd.company_legal_name || null,
    company_address: fd.company_address || null,
    company_phone: fd.company_phone || null,
    company_email: fd.company_email || null,
    company_website: fd.company_website || null,
    company_tax_id: fd.company_tax_id || null,
    company_logo_url: fd.company_logo_url || null,
    company_stamp_url: fd.company_stamp_url || null,
    pbf_license: fd.pbf_license || null,
    cdob_certificate: fd.cdob_certificate || null,
    notes: fd.notes || null,
  });

  // Uploads use UUID-named paths so historical logos/stamps embedded in
  // old document snapshots keep working after a new asset is uploaded.
  const uploadCompanyAsset = async (kind: 'logo' | 'stamp', file: File): Promise<string | null> => {
    setUploadingAsset(kind);
    try {
      const ext = (file.name.split('.').pop() || 'bin').toLowerCase();
      const rand = (globalThis.crypto?.randomUUID?.() || Math.random().toString(36).slice(2));
      const path = `${kind}/${rand}.${ext}`;
      const { error } = await supabase.storage.from('company-assets').upload(path, file, {
        contentType: file.type || undefined,
        upsert: false,
      });
      if (error) throw error;
      return path;
    } catch (err: any) {
      alert(`Failed to upload ${kind}: ${err.message || JSON.stringify(err)}`);
      return null;
    } finally {
      setUploadingAsset(null);
    }
  };

  const saveNewProfile = async () => {
    setSavingProfile(true);
    try {
      if (companyProfiles.some(p => p.effective_from === newProfileData.effective_from)) {
        throw new Error('A Company Profile already exists for this effective date.');
      }
      const { error } = await supabase.from('company_profiles').insert(formToPayload(newProfileData));
      if (error) throw error;
      setShowNewProfileForm(false);
      setNewProfileData(emptyProfileForm());
      await loadCompanyProfiles();
    } catch (err: any) {
      alert(err.message || 'Failed to save company profile');
    } finally {
      setSavingProfile(false);
    }
  };

  const toggleSetupMode = async (next: boolean) => {
    if (!settings) return;
    // Confirm before turning production protections off. Silent no-confirm
    // when switching back to Production Mode.
    if (next && !window.confirm(
      'Enable Setup Mode?\n\n' +
      'Historical Company Profile protections will be temporarily disabled while the ERP is being configured. Admins will be able to edit referenced profiles, change logos/stamps/NPWP, and delete profiles that documents already point at.\n\n' +
      'Switch back to Production Mode before going live.'
    )) return;

    setTogglingSetupMode(true);
    try {
      const { error } = await supabase
        .from('app_settings')
        .update({ setup_mode: next })
        .eq('id', settings.id);
      if (error) throw error;
      setSetupMode(next);
    } catch (err: any) {
      alert(err.message || 'Failed to toggle Setup Mode');
    } finally {
      setTogglingSetupMode(false);
    }
  };

  const startEditProfile = (cp: CompanyProfileRow) => {
    setEditingProfile(cp);
    setEditProfileData(profileToFormData(cp));
  };

  const cancelEditProfile = () => {
    setEditingProfile(null);
    setEditProfileData(emptyProfileForm());
  };

  const saveEditProfile = async () => {
    if (!editingProfile) return;
    setSavingProfile(true);
    try {
      if (companyProfiles.some(p => p.id !== editingProfile.id && p.effective_from === editProfileData.effective_from)) {
        throw new Error('Another Company Profile already exists for this effective date.');
      }
      const { error } = await supabase
        .from('company_profiles')
        .update(formToPayload(editProfileData))
        .eq('id', editingProfile.id);
      if (error) throw error;
      cancelEditProfile();
      await loadCompanyProfiles();
    } catch (err: any) {
      const msg = String(err?.message || err);
      alert(msg.startsWith('PROFILE_REFERENCED:') ? msg.replace(/^PROFILE_REFERENCED:\s*/, '') : msg);
    } finally {
      setSavingProfile(false);
    }
  };

  const deleteProfile = async (cp: CompanyProfileRow) => {
    const refCount = profileRefCounts[cp.id] || 0;
    if (refCount > 0) {
      alert('This Company Profile is referenced by business documents and cannot be deleted.\n\nHistorical company identities must remain permanently available.');
      return;
    }
    const today = new Date().toISOString().split('T')[0];
    const isActiveProfile = cp.effective_from <= today && cp.id === (companyProfiles.find(p => p.effective_from <= today)?.id);
    if (isActiveProfile) {
      alert('The active Company Profile cannot be deleted while it is in effect.');
      return;
    }
    const ok = window.confirm(`Delete this Company Profile?\n\n"${cp.company_name}" (effective ${cp.effective_from})\n\nThis action cannot be undone.`);
    if (!ok) return;
    setDeletingProfileId(cp.id);
    try {
      const { error } = await supabase.rpc('delete_company_profile', { p_id: cp.id });
      if (error) throw error;
      await loadCompanyProfiles();
    } catch (err: any) {
      const msg = String(err?.message || err);
      alert(msg.startsWith('PROFILE_REFERENCED:') ? msg.replace(/^PROFILE_REFERENCED:\s*/, '') : msg);
    } finally {
      setDeletingProfileId(null);
    }
  };

  const loadAccounts = async () => {
    const { data, error } = await supabase
      .from('chart_of_accounts')
      .select('id, code, name, account_type')
      .eq('is_header', false)
      .order('code');

    if (!error) {
      setAccounts(data || []);
    }
  };

  const loadUsers = async () => {
    try {
      const { data, error } = await supabase
        .from('user_profiles')
        .select('id, email, full_name, role, is_active, created_at, username')
        .order('created_at', { ascending: false });

      if (error) throw error;
      setUsers(data || []);
    } catch (error) {
      console.error('Error loading users:', error);
      setUsers([]);
    }
  };

  const saveToDb = async (payload: Partial<typeof formData>) => {
    if (settings) {
      const { error } = await supabase
        .from('app_settings')
        .update(payload)
        .eq('id', settings.id);
      if (error) throw error;
    } else {
      const { error } = await supabase
        .from('app_settings')
        .insert([{ ...formData, ...payload }]);
      if (error) throw error;
    }
  };

  const handleSaveCompany = async (e: React.FormEvent) => {
    e.preventDefault();
    setSaving(true);
    try {
      await saveToDb({
        company_name: formData.company_name,
        company_address: formData.company_address,
        company_phone: formData.company_phone,
        company_email: formData.company_email,
        tax_rate: formData.tax_rate,
        invoice_prefix: formData.invoice_prefix,
        invoice_start_number: formData.invoice_start_number,
      });
      alert('Settings saved successfully!');
      loadSettings();
    } catch (error) {
      console.error('Error saving settings:', error);
      alert('Failed to save settings. Please try again.');
    } finally {
      setSaving(false);
    }
  };

  const handleSaveFinancial = async (e: React.FormEvent) => {
    e.preventDefault();
    setSaving(true);
    try {
      await saveToDb({
        financial_year_start: formData.financial_year_start,
        financial_year_end: formData.financial_year_end,
        current_financial_year: formData.current_financial_year,
      });
      alert('Settings saved successfully!');
      loadSettings();
    } catch (error) {
      console.error('Error saving settings:', error);
      alert('Failed to save settings. Please try again.');
    } finally {
      setSaving(false);
    }
  };

  const handleSaveSystem = async (e: React.FormEvent) => {
    e.preventDefault();
    setSaving(true);
    try {
      // Worker URL/secret: if the field is empty but the DB had a value, preserve
      // the existing value — browser credential autofill can wipe these silently.
      await saveToDb({
        low_stock_threshold: formData.low_stock_threshold,
        expiry_alert_days: formData.expiry_alert_days,
        email_host: formData.email_host || undefined,
        email_port: formData.email_port,
        email_username: formData.email_username || undefined,
        rounding_tolerance_amount: formData.rounding_tolerance_amount,
        rounding_writeoff_account_id: formData.rounding_writeoff_account_id || undefined,
        rounding_gain_account_id: formData.rounding_gain_account_id || undefined,
        bulk_email_batch_size: formData.bulk_email_batch_size,
        bulk_email_batch_delay_seconds: formData.bulk_email_batch_delay_seconds,
        bulk_email_worker_url:
          formData.bulk_email_worker_url || settings?.bulk_email_worker_url || undefined,
        bulk_email_worker_secret:
          formData.bulk_email_worker_secret || settings?.bulk_email_worker_secret || undefined,
        default_language: formData.default_language,
      });
      alert('Settings saved successfully!');
      loadSettings();
    } catch (error) {
      console.error('Error saving settings:', error);
      alert('Failed to save settings. Please try again.');
    } finally {
      setSaving(false);
    }
  };


  const handleDownloadBackup = async () => {
    try {
      const { data: { session } } = await supabase.auth.getSession();
      const url = `${import.meta.env.VITE_SUPABASE_URL}/functions/v1/backup-export`;
      const response = await fetch(url, {
        headers: {
          Authorization: `Bearer ${session?.access_token}`,
          'Content-Type': 'application/json',
        },
      });
      if (!response.ok) throw new Error('Backup export failed');
      const json = await response.json();
      const blob = new Blob([JSON.stringify(json, null, 2)], { type: 'application/json' });
      const a = document.createElement('a');
      a.href = URL.createObjectURL(blob);
      a.download = `backup-${new Date().toISOString().slice(0, 10)}.json`;
      a.click();
      URL.revokeObjectURL(a.href);
    } catch (error) {
      console.error('Backup error:', error);
      alert('Failed to download backup. Please try again.');
    }
  };

  const [showRestoreModal, setShowRestoreModal] = useState(false);
  const [restoreFile, setRestoreFile] = useState<File | null>(null);
  const [restoring, setRestoring] = useState(false);
  const [restoreResult, setRestoreResult] = useState<{ success: boolean; message: string; imported?: Record<string, number> } | null>(null);
  const [confirmStep, setConfirmStep] = useState<0 | 1 | 2>(0);

  const handleRestoreBackup = async () => {
    if (!restoreFile) return;
    setRestoring(true);
    setRestoreResult(null);
    try {
      const text = await restoreFile.text();
      let payload: unknown;
      try {
        payload = JSON.parse(text);
      } catch {
        setRestoreResult({ success: false, message: 'Invalid JSON file. Please select a valid backup file.' });
        return;
      }
      if (
        typeof payload !== 'object' ||
        payload === null ||
        (payload as Record<string, unknown>)['version'] !== '1.0'
      ) {
        setRestoreResult({ success: false, message: 'Invalid backup version. Only version 1.0 backups are supported.' });
        return;
      }
      const { data: { session } } = await supabase.auth.getSession();
      const url = `${import.meta.env.VITE_SUPABASE_URL}/functions/v1/backup-import`;
      const response = await fetch(url, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${session?.access_token}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify(payload),
      });
      const json = await response.json();
      if (!response.ok) {
        setRestoreResult({ success: false, message: json.error ?? 'Import failed. Please try again.' });
      } else {
        setRestoreResult({ success: true, message: 'Backup restored successfully.', imported: json.imported });
      }
    } catch (error) {
      setRestoreResult({ success: false, message: (error as Error).message ?? 'Unexpected error during restore.' });
    } finally {
      setRestoring(false);
      setConfirmStep(0);
    }
  };

  const handleCloseRestoreModal = () => {
    setShowRestoreModal(false);
    setRestoreFile(null);
    setRestoreResult(null);
    setConfirmStep(0);
  };

  const isAdmin = profile?.role === 'admin';
  const isSales = profile?.role === 'sales';
  const isAccountant = profile?.role === 'accounts';
  const isWarehouse = profile?.role === 'warehouse';

  if (!isAdmin && !isSales && !isAccountant && !isWarehouse) {
    return (
      <Layout>
        <div className="text-center py-12">
          <p className="text-xl text-gray-600">You do not have permission to access settings.</p>
          <p className="text-sm text-gray-500 mt-2">Only administrators can view and modify system settings.</p>
        </div>
      </Layout>
    );
  }

  if (loading) {
    return (
      <Layout>
        <div className="flex items-center justify-center py-12">
          <div className="animate-spin rounded-full h-12 w-12 border-b-2 border-blue-600" />
        </div>
      </Layout>
    );
  }

  return (
    <Layout>
      <div className="space-y-6">
        <div className="flex items-center justify-between">
          <div>
            <h1 className="text-3xl font-bold text-gray-900">Settings</h1>
            <p className="text-gray-600 mt-1">Configure system settings and manage users</p>
          </div>
          {isAdmin && (
            <div className="flex items-center gap-2">
              <button
                onClick={() => setShowRestoreModal(true)}
                className="flex items-center gap-2 px-4 py-2 bg-blue-600 text-white rounded-lg hover:bg-blue-700 transition text-sm font-medium"
              >
                <Upload className="w-4 h-4" />
                Restore Backup
              </button>
              <button
                onClick={handleDownloadBackup}
                className="flex items-center gap-2 px-4 py-2 bg-gray-800 text-white rounded-lg hover:bg-gray-900 transition text-sm font-medium"
              >
                <Download className="w-4 h-4" />
                Download Backup
              </button>
            </div>
          )}
        </div>

        <div className="bg-white rounded-lg shadow">
          <div className="border-b border-gray-200">
            <nav className="flex -mb-px">
              {(isAdmin || isAccountant) && (
                <button
                  onClick={() => setActiveTab('company')}
                  className={`px-6 py-3 text-sm font-medium border-b-2 transition ${
                    activeTab === 'company'
                      ? 'border-blue-600 text-blue-600'
                      : 'border-transparent text-gray-500 hover:text-gray-700 hover:border-gray-300'
                  }`}
                >
                  <div className="flex items-center gap-2">
                    <Building2 className="w-4 h-4" />
                    Company Profile
                  </div>
                </button>
              )}
              {isAdmin && (
                <button
                  onClick={() => setActiveTab('users')}
                  className={`px-6 py-3 text-sm font-medium border-b-2 transition ${
                    activeTab === 'users'
                      ? 'border-blue-600 text-blue-600'
                      : 'border-transparent text-gray-500 hover:text-gray-700 hover:border-gray-300'
                  }`}
                >
                  <div className="flex items-center gap-2">
                    <Users className="w-4 h-4" />
                    Users
                  </div>
                </button>
              )}
              {(isAdmin || isAccountant || isSales || isWarehouse) && (
                <button
                  onClick={() => setActiveTab('suppliers')}
                  className={`px-6 py-3 text-sm font-medium border-b-2 transition ${
                    activeTab === 'suppliers'
                      ? 'border-blue-600 text-blue-600'
                      : 'border-transparent text-gray-500 hover:text-gray-700 hover:border-gray-300'
                  }`}
                >
                  <div className="flex items-center gap-2">
                    <Package className="w-4 h-4" />
                    Suppliers
                  </div>
                </button>
              )}
              {isAdmin && (
                <button
                  onClick={() => setActiveTab('financial')}
                  className={`px-6 py-3 text-sm font-medium border-b-2 transition ${
                    activeTab === 'financial'
                      ? 'border-blue-600 text-blue-600'
                      : 'border-transparent text-gray-500 hover:text-gray-700 hover:border-gray-300'
                  }`}
                >
                  <div className="flex items-center gap-2">
                    <Calendar className="w-4 h-4" />
                    Financial Year
                  </div>
                </button>
              )}
              {isAdmin && (
                <button
                  onClick={() => setActiveTab('system')}
                  className={`px-6 py-3 text-sm font-medium border-b-2 transition ${
                    activeTab === 'system'
                      ? 'border-blue-600 text-blue-600'
                      : 'border-transparent text-gray-500 hover:text-gray-700 hover:border-gray-300'
                  }`}
                >
                  <div className="flex items-center gap-2">
                    <Package className="w-4 h-4" />
                    System
                  </div>
                </button>
              )}
              {(isAdmin || isSales) && (
                <button
                  onClick={() => setActiveTab('gmail')}
                  className={`px-6 py-3 text-sm font-medium border-b-2 transition ${
                    activeTab === 'gmail'
                      ? 'border-blue-600 text-blue-600'
                      : 'border-transparent text-gray-500 hover:text-gray-700 hover:border-gray-300'
                  }`}
                >
                  <div className="flex items-center gap-2">
                    <Mail className="w-4 h-4" />
                    Gmail
                  </div>
                </button>
              )}
              {(isAdmin || isSales) && (
                <button
                  onClick={() => setActiveTab('templates')}
                  className={`px-6 py-3 text-sm font-medium border-b-2 transition ${
                    activeTab === 'templates'
                      ? 'border-blue-600 text-blue-600'
                      : 'border-transparent text-gray-500 hover:text-gray-700 hover:border-gray-300'
                  }`}
                >
                  <div className="flex items-center gap-2">
                    <FileText className="w-4 h-4" />
                    Email Templates
                  </div>
                </button>
              )}
              {(isAdmin || isSales) && (
                <button
                  onClick={() => setActiveTab('extract')}
                  className={`px-6 py-3 text-sm font-medium border-b-2 transition ${
                    activeTab === 'extract'
                      ? 'border-blue-600 text-blue-600'
                      : 'border-transparent text-gray-500 hover:text-gray-700 hover:border-gray-300'
                  }`}
                >
                  <div className="flex items-center gap-2">
                    <Download className="w-4 h-4" />
                    Extract Data
                  </div>
                </button>
              )}
              <button
                onClick={() => setActiveTab('about')}
                className={`px-6 py-3 text-sm font-medium border-b-2 transition ${
                  activeTab === 'about'
                    ? 'border-blue-600 text-blue-600'
                    : 'border-transparent text-gray-500 hover:text-gray-700 hover:border-gray-300'
                }`}
              >
                <div className="flex items-center gap-2">
                  <Info className="w-4 h-4" />
                  About
                </div>
              </button>
            </nav>
          </div>

          <div className="p-6">
            {activeTab === 'gmail' && (
              <div className="space-y-6">
                <GmailSettings />
                <GmailVisibilityPanel />
              </div>
            )}

            {activeTab === 'templates' && (
              <EmailTemplates />
            )}

            {activeTab === 'extract' && (
              <ExtractData />
            )}

            {activeTab === 'about' && (
              <AboutSystem />
            )}

            {activeTab === 'suppliers' && (
              <SuppliersManager />
            )}

            {activeTab === 'company' && (<>
              <form onSubmit={handleSaveCompany} className="space-y-6">
                <div>
                  <h3 className="text-lg font-semibold mb-4 flex items-center gap-2">
                    <Building2 className="w-5 h-5" />
                    Company Information
                  </h3>
                  <div className="grid grid-cols-2 gap-4">
                    <div className="col-span-2">
                      <label className="block text-sm font-medium text-gray-700 mb-1">
                        Company Name *
                      </label>
                      <input
                        type="text"
                        value={formData.company_name}
                        onChange={(e) => setFormData({ ...formData, company_name: e.target.value })}
                        className="w-full px-3 py-2 border border-gray-300 rounded-lg focus:ring-2 focus:ring-blue-500"
                        required
                      />
                    </div>

                    <div className="col-span-2">
                      <label className="block text-sm font-medium text-gray-700 mb-1">
                        Address
                      </label>
                      <textarea
                        value={formData.company_address}
                        onChange={(e) => setFormData({ ...formData, company_address: e.target.value })}
                        className="w-full px-3 py-2 border border-gray-300 rounded-lg focus:ring-2 focus:ring-blue-500"
                        rows={3}
                      />
                    </div>

                    <div>
                      <label className="block text-sm font-medium text-gray-700 mb-1">
                        Phone
                      </label>
                      <input
                        type="text"
                        value={formData.company_phone}
                        onChange={(e) => setFormData({ ...formData, company_phone: e.target.value })}
                        className="w-full px-3 py-2 border border-gray-300 rounded-lg focus:ring-2 focus:ring-blue-500"
                      />
                    </div>

                    <div>
                      <label className="block text-sm font-medium text-gray-700 mb-1">
                        Email
                      </label>
                      <input
                        type="email"
                        value={formData.company_email}
                        onChange={(e) => setFormData({ ...formData, company_email: e.target.value })}
                        className="w-full px-3 py-2 border border-gray-300 rounded-lg focus:ring-2 focus:ring-blue-500"
                      />
                    </div>
                  </div>
                </div>

                <div className="border-t pt-6">
                  <h3 className="text-lg font-semibold mb-4 flex items-center gap-2">
                    <DollarSign className="w-5 h-5" />
                    Financial Settings
                  </h3>
                  <div className="grid grid-cols-3 gap-4">
                    <div>
                      <label className="block text-sm font-medium text-gray-700 mb-1">
                        Default Tax Rate (%)
                      </label>
                      <input
                        type="number"
                        value={formData.tax_rate}
                        onChange={(e) => setFormData({ ...formData, tax_rate: Number(e.target.value) })}
                        className="w-full px-3 py-2 border border-gray-300 rounded-lg focus:ring-2 focus:ring-blue-500"
                        min="0"
                        max="100"
                        step="0.1"
                      />
                    </div>

                    <div>
                      <label className="block text-sm font-medium text-gray-700 mb-1">
                        Invoice Prefix
                      </label>
                      <input
                        type="text"
                        value={formData.invoice_prefix}
                        onChange={(e) => setFormData({ ...formData, invoice_prefix: e.target.value })}
                        className="w-full px-3 py-2 border border-gray-300 rounded-lg focus:ring-2 focus:ring-blue-500"
                      />
                    </div>

                    <div>
                      <label className="block text-sm font-medium text-gray-700 mb-1">
                        Invoice Start Number
                      </label>
                      <input
                        type="number"
                        value={formData.invoice_start_number}
                        onChange={(e) => setFormData({ ...formData, invoice_start_number: Number(e.target.value) })}
                        className="w-full px-3 py-2 border border-gray-300 rounded-lg focus:ring-2 focus:ring-blue-500"
                        min="1"
                      />
                    </div>
                  </div>
                </div>

                <div className="flex justify-end">
                  <button
                    type="submit"
                    disabled={saving}
                    className="flex items-center gap-2 bg-blue-600 text-white px-6 py-2 rounded-lg hover:bg-blue-700 transition disabled:opacity-50"
                  >
                    <Save className="w-5 h-5" />
                    {saving ? 'Saving...' : 'Save Settings'}
                  </button>
                </div>
              </form>

              {/* Setup Mode — admin-only feature flag that bypasses historical
                  protections while the ERP is being configured. Backed by
                  app_settings.setup_mode and the is_setup_mode() DB helper so
                  the trigger + delete RPC apply the same bypass server-side. */}
              {profile?.role === 'admin' && (
                <div className={`mt-8 border-t pt-6`}>
                  <div className={`border rounded-lg p-3 flex items-center justify-between gap-3 ${setupMode ? 'bg-amber-50 border-amber-300' : 'bg-gray-50 border-gray-200'}`}>
                    <div>
                      <div className={`text-sm font-semibold ${setupMode ? 'text-amber-900' : 'text-gray-800'}`}>
                        {setupMode ? 'Setup Mode is ENABLED' : 'Setup Mode'}
                      </div>
                      <div className="text-xs text-gray-600 mt-0.5">
                        {setupMode
                          ? 'Historical protections are temporarily disabled. Referenced Company Profiles can be edited or deleted. Switch back to Production Mode before going live.'
                          : 'Production Mode is active — historical Company Profiles are read-only when referenced by documents.'}
                      </div>
                    </div>
                    <button
                      onClick={() => void toggleSetupMode(!setupMode)}
                      disabled={togglingSetupMode || !settings}
                      className={`text-xs font-medium px-3 py-1.5 rounded-lg border transition disabled:opacity-40 ${
                        setupMode
                          ? 'border-amber-400 text-amber-900 hover:bg-amber-100'
                          : 'border-blue-600 text-blue-700 hover:bg-blue-50'
                      }`}
                    >
                      {togglingSetupMode ? 'Saving…' : setupMode ? 'Switch to Production Mode' : 'Enable Setup Mode'}
                    </button>
                  </div>
                </div>
              )}

              {/* Company Identity History */}
              <div className={`${profile?.role === 'admin' ? 'mt-6' : 'mt-8 border-t pt-6'}`}>
                <div className="flex items-center justify-between mb-2">
                  <div>
                    <h3 className="text-base font-semibold text-gray-900">Company Identity History</h3>
                    <p className="text-xs text-gray-500 mt-0.5">Creating a new version affects only documents created on or after its effective date. Existing documents retain their original snapshot permanently.</p>
                  </div>
                  {profile?.role === 'admin' && (
                    <button
                      onClick={() => setShowNewProfileForm(v => !v)}
                      className="text-sm bg-blue-600 text-white px-3 py-1.5 rounded-lg hover:bg-blue-700 transition"
                    >
                      {showNewProfileForm ? 'Cancel' : '+ Add New Version'}
                    </button>
                  )}
                </div>

                {showNewProfileForm && (
                  <CompanyProfileForm
                    title="New Company Profile Version"
                    data={newProfileData}
                    onChange={setNewProfileData}
                    onUploadAsset={uploadCompanyAsset}
                    uploadingAsset={uploadingAsset}
                    onSubmit={saveNewProfile}
                    onCancel={() => { setShowNewProfileForm(false); setNewProfileData(emptyProfileForm()); }}
                    submitLabel="Save Version"
                    saving={savingProfile}
                    readOnly={false}
                  />
                )}

                <div className="overflow-x-auto">
                  <table className="w-full text-sm">
                    <thead>
                      <tr className="border-b text-left text-xs text-gray-500">
                        <th className="pb-2 pr-4">Effective From</th>
                        <th className="pb-2 pr-4">Company Name</th>
                        <th className="pb-2 pr-4">Phone</th>
                        <th className="pb-2 pr-4">Status</th>
                        <th className="pb-2 pr-4">Usage</th>
                        <th className="pb-2">Actions</th>
                      </tr>
                    </thead>
                    <tbody>
                      {companyProfiles.map((cp, idx) => {
                        const today = new Date().toISOString().split('T')[0];
                        const isActive = cp.effective_from <= today && idx === companyProfiles.findIndex(p => p.effective_from <= today);
                        const isFuture = cp.effective_from > today;
                        const refCount = profileRefCounts[cp.id] || 0;
                        const isReferenced = refCount > 0;
                        const isAdmin = profile?.role === 'admin';
                        // Setup Mode: allow admins to Edit / Delete any profile,
                        // even Active or Referenced. The DB trigger + delete RPC
                        // apply the same bypass, so the two layers stay aligned.
                        const canDelete = isAdmin && (setupMode || (!isReferenced && !isActive));
                        // Referenced profiles: accounting fields are immutable but branding/contact
                        // fields (logo, stamp, address, phone, email, website) can still be updated.
                        // The trigger allows these changes; only name/tax-id/licenses are blocked.
                        const openLabel = 'Edit';
                        return (
                          <tr key={cp.id} className="border-b last:border-0 hover:bg-gray-50">
                            <td className="py-2 pr-4 font-mono text-xs">{cp.effective_from}</td>
                            <td className="py-2 pr-4 font-medium">{cp.company_name}</td>
                            <td className="py-2 pr-4 text-gray-600">{cp.company_phone || '—'}</td>
                            <td className="py-2 pr-4">
                              {isFuture ? (
                                <span className="inline-flex items-center px-2 py-0.5 rounded text-xs font-medium bg-yellow-100 text-yellow-800">Future</span>
                              ) : isActive ? (
                                <span className="inline-flex items-center px-2 py-0.5 rounded text-xs font-medium bg-green-100 text-green-800">Active</span>
                              ) : (
                                <span className="inline-flex items-center px-2 py-0.5 rounded text-xs font-medium bg-gray-100 text-gray-600">Historical</span>
                              )}
                            </td>
                            <td className="py-2 pr-4">
                              {isReferenced ? (
                                <span
                                  className="inline-flex items-center px-2 py-0.5 rounded text-xs font-medium bg-blue-100 text-blue-800"
                                  title="Referenced by business documents — profile is read-only."
                                >
                                  Used by {refCount} document{refCount === 1 ? '' : 's'}
                                </span>
                              ) : (
                                <span className="inline-flex items-center px-2 py-0.5 rounded text-xs font-medium bg-gray-50 text-gray-500 border border-gray-200">
                                  Unused
                                </span>
                              )}
                            </td>
                            <td className="py-2">
                              <div className="flex items-center gap-2">
                                <button
                                  onClick={() => startEditProfile(cp)}
                                  disabled={!isAdmin || editingProfile?.id === cp.id}
                                  title={
                                    isReferenced && !setupMode
                                      ? 'Referenced by documents — branding/contact fields editable; accounting fields locked'
                                      : 'Edit profile'
                                  }
                                  className="text-xs px-2 py-1 rounded border border-gray-300 text-gray-700 hover:bg-gray-100 disabled:opacity-40 disabled:cursor-not-allowed"
                                >
                                  {openLabel}
                                </button>
                                <button
                                  onClick={() => deleteProfile(cp)}
                                  disabled={!canDelete || deletingProfileId === cp.id}
                                  title={
                                    setupMode
                                      ? 'Setup Mode: deletion allowed'
                                      : isReferenced
                                        ? 'Referenced by documents — cannot delete'
                                        : isActive ? 'Active profile — cannot delete' : 'Delete profile'
                                  }
                                  className="text-xs px-2 py-1 rounded border border-red-300 text-red-700 hover:bg-red-50 disabled:opacity-40 disabled:cursor-not-allowed"
                                >
                                  {deletingProfileId === cp.id ? 'Deleting…' : 'Delete'}
                                </button>
                              </div>
                            </td>
                          </tr>
                        );
                      })}
                      {companyProfiles.length === 0 && (
                        <tr><td colSpan={6} className="py-4 text-center text-gray-400 text-sm">No company profiles found.</td></tr>
                      )}
                    </tbody>
                  </table>
                </div>
              </div>

              {editingProfile && (
                <CompanyProfileEditModal
                  profile={editingProfile}
                  data={editProfileData}
                  onChange={setEditProfileData}
                  onUploadAsset={uploadCompanyAsset}
                  uploadingAsset={uploadingAsset}
                  onSubmit={saveEditProfile}
                  onCancel={cancelEditProfile}
                  saving={savingProfile}
                  brandingOnly={!setupMode && (profileRefCounts[editingProfile.id] || 0) > 0}
                  refCount={profileRefCounts[editingProfile.id] || 0}
                />
              )}
            </>)}

            {activeTab === 'users' && (
              <UserManagement users={users} onRefresh={loadUsers} />
            )}

            {activeTab === 'financial' && (
              <form onSubmit={handleSaveFinancial} className="space-y-6">
                <div>
                  <h3 className="text-lg font-semibold mb-4 flex items-center gap-2">
                    <Calendar className="w-5 h-5" />
                    Financial Year Configuration
                  </h3>

                  <div className="bg-blue-50 border border-blue-200 rounded-lg p-4 mb-6">
                    <p className="text-sm text-blue-800">
                      Configure your company's financial year period. This will be used to filter reports and dashboard statistics.
                      The system will automatically organize data based on the selected financial year.
                    </p>
                  </div>

                  <div className="grid grid-cols-3 gap-4">
                    <div>
                      <label className="block text-sm font-medium text-gray-700 mb-1">
                        Current Financial Year *
                      </label>
                      <select
                        value={formData.current_financial_year}
                        onChange={(e) => {
                          const year = e.target.value;
                          setFormData({
                            ...formData,
                            current_financial_year: year,
                            financial_year_start: `${year}-01-01`,
                            financial_year_end: `${year}-12-31`,
                          });
                        }}
                        className="w-full px-3 py-2 border border-gray-300 rounded-lg focus:ring-2 focus:ring-blue-500"
                        required
                      >
                        <option value="2023">2023</option>
                        <option value="2024">2024</option>
                        <option value="2025">2025</option>
                        <option value="2026">2026</option>
                        <option value="2027">2027</option>
                      </select>
                      <p className="text-xs text-gray-500 mt-1">
                        Select the active financial year
                      </p>
                    </div>

                    <div>
                      <label className="block text-sm font-medium text-gray-700 mb-1">
                        Start Date *
                      </label>
                      <input
                        type="date"
                        value={formData.financial_year_start}
                        onChange={(e) => setFormData({ ...formData, financial_year_start: e.target.value })}
                        className="w-full px-3 py-2 border border-gray-300 rounded-lg focus:ring-2 focus:ring-blue-500"
                        required
                      />
                      <p className="text-xs text-gray-500 mt-1">
                        Financial year start date
                      </p>
                    </div>

                    <div>
                      <label className="block text-sm font-medium text-gray-700 mb-1">
                        End Date *
                      </label>
                      <input
                        type="date"
                        value={formData.financial_year_end}
                        onChange={(e) => setFormData({ ...formData, financial_year_end: e.target.value })}
                        className="w-full px-3 py-2 border border-gray-300 rounded-lg focus:ring-2 focus:ring-blue-500"
                        required
                      />
                      <p className="text-xs text-gray-500 mt-1">
                        Financial year end date
                      </p>
                    </div>
                  </div>

                  <div className="mt-6 p-4 bg-green-50 border border-green-200 rounded-lg">
                    <p className="text-sm font-medium text-green-800 mb-2">Active Financial Year Period:</p>
                    <p className="text-lg font-bold text-green-900">
                      {formatDate(formData.financial_year_start)} - {formatDate(formData.financial_year_end)}
                    </p>
                  </div>
                </div>

                <div className="flex justify-end">
                  <button
                    type="submit"
                    disabled={saving}
                    className="flex items-center gap-2 bg-blue-600 text-white px-6 py-2 rounded-lg hover:bg-blue-700 transition disabled:opacity-50"
                  >
                    <Save className="w-5 h-5" />
                    {saving ? 'Saving...' : 'Save Financial Year'}
                  </button>
                </div>
              </form>
            )}

            {activeTab === 'system' && (
              <form onSubmit={handleSaveSystem} className="space-y-6">
                <div>
                  <h3 className="text-lg font-semibold mb-4 flex items-center gap-2">
                    <Package className="w-5 h-5" />
                    Inventory Alerts
                  </h3>
                  <div className="grid grid-cols-2 gap-4">
                    <div>
                      <label className="block text-sm font-medium text-gray-700 mb-1">
                        Low Stock Threshold
                      </label>
                      <input
                        type="number"
                        value={formData.low_stock_threshold}
                        onChange={(e) => setFormData({ ...formData, low_stock_threshold: Number(e.target.value) })}
                        className="w-full px-3 py-2 border border-gray-300 rounded-lg focus:ring-2 focus:ring-blue-500"
                        min="0"
                      />
                      <p className="text-xs text-gray-500 mt-1">
                        Alert when stock falls below this quantity
                      </p>
                    </div>

                    <div>
                      <label className="block text-sm font-medium text-gray-700 mb-1">
                        Expiry Alert Days
                      </label>
                      <input
                        type="number"
                        value={formData.expiry_alert_days}
                        onChange={(e) => setFormData({ ...formData, expiry_alert_days: Number(e.target.value) })}
                        className="w-full px-3 py-2 border border-gray-300 rounded-lg focus:ring-2 focus:ring-blue-500"
                        min="0"
                      />
                      <p className="text-xs text-gray-500 mt-1">
                        Alert when products will expire within this many days
                      </p>
                    </div>
                  </div>
                </div>

                <div className="border-t pt-6">
                  <h3 className="text-lg font-semibold mb-4 flex items-center gap-2">
                    <Mail className="w-5 h-5" />
                    Email Configuration (Optional)
                  </h3>
                  <div className="grid grid-cols-2 gap-4">
                    <div>
                      <label className="block text-sm font-medium text-gray-700 mb-1">
                        SMTP Host
                      </label>
                      <input
                        type="text"
                        value={formData.email_host}
                        onChange={(e) => setFormData({ ...formData, email_host: e.target.value })}
                        className="w-full px-3 py-2 border border-gray-300 rounded-lg focus:ring-2 focus:ring-blue-500"
                        placeholder="smtp.example.com"
                      />
                    </div>

                    <div>
                      <label className="block text-sm font-medium text-gray-700 mb-1">
                        SMTP Port
                      </label>
                      <input
                        type="number"
                        value={formData.email_port}
                        onChange={(e) => setFormData({ ...formData, email_port: Number(e.target.value) })}
                        className="w-full px-3 py-2 border border-gray-300 rounded-lg focus:ring-2 focus:ring-blue-500"
                      />
                    </div>

                    <div className="col-span-2">
                      <label className="block text-sm font-medium text-gray-700 mb-1">
                        Email Username
                      </label>
                      <input
                        type="text"
                        value={formData.email_username}
                        onChange={(e) => setFormData({ ...formData, email_username: e.target.value })}
                        className="w-full px-3 py-2 border border-gray-300 rounded-lg focus:ring-2 focus:ring-blue-500"
                        placeholder="user@example.com"
                      />
                    </div>
                  </div>
                </div>

                <div className="border-t pt-6">
                  <h3 className="text-lg font-semibold mb-4 flex items-center gap-2">
                    <DollarSign className="w-5 h-5" />
                    Invoice Rounding
                  </h3>
                  <div className="grid grid-cols-3 gap-4">
                    <div>
                      <label className="block text-sm font-medium text-gray-700 mb-1">
                        Rounding Tolerance (Rp)
                      </label>
                      <MoneyInput
                        value={formData.rounding_tolerance_amount}
                        onChange={(amount) => setFormData({ ...formData, rounding_tolerance_amount: amount })}
                        className="w-full px-3 py-2 border border-gray-300 rounded-lg focus:ring-2 focus:ring-blue-500"
                        min="0"
                      />
                    </div>
                    <div>
                      <label className="block text-sm font-medium text-gray-700 mb-1">
                        Write-off Account
                      </label>
                      <select
                        value={formData.rounding_writeoff_account_id}
                        onChange={(e) => setFormData({ ...formData, rounding_writeoff_account_id: e.target.value })}
                        className="w-full px-3 py-2 border border-gray-300 rounded-lg focus:ring-2 focus:ring-blue-500"
                      >
                        <option value="">Default account</option>
                        {accounts.map(account => (
                          <option key={account.id} value={account.id}>{account.code} - {account.name}</option>
                        ))}
                      </select>
                    </div>
                    <div>
                      <label className="block text-sm font-medium text-gray-700 mb-1">
                        Gain Account
                      </label>
                      <select
                        value={formData.rounding_gain_account_id}
                        onChange={(e) => setFormData({ ...formData, rounding_gain_account_id: e.target.value })}
                        className="w-full px-3 py-2 border border-gray-300 rounded-lg focus:ring-2 focus:ring-blue-500"
                      >
                        <option value="">Default account</option>
                        {accounts.map(account => (
                          <option key={account.id} value={account.id}>{account.code} - {account.name}</option>
                        ))}
                      </select>
                    </div>
                  </div>
                </div>

                <div className="border-t pt-6">
                  <h3 className="text-lg font-semibold mb-4 flex items-center gap-2">
                    <Mail className="w-5 h-5" />
                    Bulk Email Worker
                  </h3>
                  <div className="grid grid-cols-2 gap-4">
                    <div>
                      <label className="block text-sm font-medium text-gray-700 mb-1">
                        Batch Size
                      </label>
                      <input
                        type="number"
                        value={formData.bulk_email_batch_size}
                        onChange={(e) => setFormData({ ...formData, bulk_email_batch_size: Number(e.target.value) })}
                        className="w-full px-3 py-2 border border-gray-300 rounded-lg focus:ring-2 focus:ring-blue-500"
                        min="1"
                        max="25"
                      />
                    </div>

                    <div>
                      <label className="block text-sm font-medium text-gray-700 mb-1">
                        Batch Delay Seconds
                      </label>
                      <input
                        type="number"
                        value={formData.bulk_email_batch_delay_seconds}
                        onChange={(e) => setFormData({ ...formData, bulk_email_batch_delay_seconds: Number(e.target.value) })}
                        className="w-full px-3 py-2 border border-gray-300 rounded-lg focus:ring-2 focus:ring-blue-500"
                        min="0"
                      />
                    </div>

                    <div className="col-span-2">
                      <label className="block text-sm font-medium text-gray-700 mb-1">
                        Worker URL
                      </label>
                      <input
                        type="text"
                        value={formData.bulk_email_worker_url}
                        onChange={(e) => setFormData({ ...formData, bulk_email_worker_url: e.target.value })}
                        className="w-full px-3 py-2 border border-gray-300 rounded-lg focus:ring-2 focus:ring-blue-500"
                        placeholder="https://PROJECT.supabase.co/functions/v1/process-bulk-email-campaign"
                        autoComplete="off"
                      />
                    </div>

                    <div className="col-span-2">
                      <label className="block text-sm font-medium text-gray-700 mb-1">
                        Worker Secret
                      </label>
                      <input
                        type="password"
                        value={formData.bulk_email_worker_secret}
                        onChange={(e) => setFormData({ ...formData, bulk_email_worker_secret: e.target.value })}
                        className="w-full px-3 py-2 border border-gray-300 rounded-lg focus:ring-2 focus:ring-blue-500"
                        placeholder="Same value as BULK_EMAIL_WORKER_SECRET"
                        autoComplete="new-password"
                      />
                    </div>
                  </div>
                </div>

                <div className="border-t pt-6">
                  <h3 className="text-lg font-semibold mb-4">Language Preference</h3>
                  <div>
                    <label className="block text-sm font-medium text-gray-700 mb-1">
                      Default Language
                    </label>
                    <select
                      value={formData.default_language}
                      onChange={(e) => setFormData({ ...formData, default_language: e.target.value })}
                      className="w-full md:w-1/3 px-3 py-2 border border-gray-300 rounded-lg focus:ring-2 focus:ring-blue-500"
                    >
                      <option value="en">English</option>
                      <option value="id">Indonesian</option>
                    </select>
                  </div>
                </div>

                <div className="flex justify-end">
                  <button
                    type="submit"
                    disabled={saving}
                    className="flex items-center gap-2 bg-blue-600 text-white px-6 py-2 rounded-lg hover:bg-blue-700 transition disabled:opacity-50"
                  >
                    <Save className="w-5 h-5" />
                    {saving ? 'Saving...' : 'Save Settings'}
                  </button>
                </div>
              </form>
            )}
          </div>
        </div>
      </div>

      {showRestoreModal && (
        <div className="fixed inset-0 bg-black bg-opacity-50 flex items-center justify-center z-50 p-4">
          <div className="bg-white rounded-xl shadow-xl w-full max-w-md">
            <div className="flex items-center justify-between p-6 border-b border-gray-200">
              <div>
                <h2 className="text-lg font-semibold text-gray-900">Restore Backup</h2>
                <p className="text-sm text-gray-500 mt-0.5">Upload a JSON backup file to restore data</p>
              </div>
              <button
                onClick={handleCloseRestoreModal}
                className="text-gray-400 hover:text-gray-600 transition"
              >
                <X className="w-5 h-5" />
              </button>
            </div>

            <div className="p-6 space-y-4">
              {/* Step 0: file picker */}
              {confirmStep === 0 && !restoreResult && (
                <>
                  <div
                    className="border-2 border-dashed border-gray-300 rounded-lg p-6 text-center cursor-pointer hover:border-blue-400 hover:bg-blue-50 transition"
                    onClick={() => document.getElementById('restore-file-input')?.click()}
                  >
                    <Upload className="w-8 h-8 text-gray-400 mx-auto mb-2" />
                    {restoreFile ? (
                      <div>
                        <p className="text-sm font-medium text-gray-900">{restoreFile.name}</p>
                        <p className="text-xs text-gray-500 mt-1">{(restoreFile.size / 1024).toFixed(1)} KB</p>
                      </div>
                    ) : (
                      <div>
                        <p className="text-sm font-medium text-gray-700">Click to select backup file</p>
                        <p className="text-xs text-gray-500 mt-1">JSON files only</p>
                      </div>
                    )}
                  </div>
                  <input
                    id="restore-file-input"
                    type="file"
                    accept=".json,application/json"
                    className="hidden"
                    onChange={(e) => {
                      setRestoreFile(e.target.files?.[0] ?? null);
                      e.target.value = '';
                    }}
                  />
                </>
              )}

              {/* Step 1: first confirmation */}
              {confirmStep === 1 && !restoreResult && (
                <div className="space-y-3">
                  <div className="flex items-start gap-3 bg-red-50 border border-red-200 rounded-lg p-4">
                    <AlertCircle className="w-5 h-5 text-red-600 flex-shrink-0 mt-0.5" />
                    <p className="text-sm text-red-800">
                      <strong>This will REPLACE all existing data.</strong> This action cannot be undone. All current products, customers, batches, invoices, and transactions will be permanently deleted and replaced with the backup data.
                    </p>
                  </div>
                  <p className="text-sm text-gray-600 text-center">Do you want to proceed?</p>
                </div>
              )}

              {/* Step 2: second confirmation */}
              {confirmStep === 2 && !restoreResult && (
                <div className="space-y-3">
                  <div className="flex items-start gap-3 bg-red-50 border border-red-200 rounded-lg p-4">
                    <AlertCircle className="w-5 h-5 text-red-600 flex-shrink-0 mt-0.5" />
                    <p className="text-sm font-semibold text-red-800">
                      Are you absolutely sure you want to restore this backup?
                    </p>
                  </div>
                  <p className="text-xs text-gray-500 text-center">
                    Restoring: <span className="font-medium text-gray-700">{restoreFile?.name}</span>
                  </p>
                </div>
              )}

              {/* Result */}
              {restoreResult && (
                <div className={`rounded-lg p-4 ${restoreResult.success ? 'bg-green-50 border border-green-200' : 'bg-red-50 border border-red-200'}`}>
                  <div className="flex items-start gap-3">
                    {restoreResult.success
                      ? <CheckCircle className="w-5 h-5 text-green-600 flex-shrink-0 mt-0.5" />
                      : <AlertCircle className="w-5 h-5 text-red-600 flex-shrink-0 mt-0.5" />
                    }
                    <div>
                      <p className={`text-sm font-medium ${restoreResult.success ? 'text-green-800' : 'text-red-800'}`}>
                        {restoreResult.message}
                      </p>
                      {restoreResult.imported && (
                        <ul className="mt-2 space-y-0.5">
                          {Object.entries(restoreResult.imported).map(([table, count]) => (
                            <li key={table} className="text-xs text-green-700">
                              {table}: {count} record{count !== 1 ? 's' : ''}
                            </li>
                          ))}
                        </ul>
                      )}
                    </div>
                  </div>
                </div>
              )}
            </div>

            <div className="flex items-center justify-end gap-3 px-6 pb-6">
              <button
                onClick={handleCloseRestoreModal}
                className="px-4 py-2 text-sm font-medium text-gray-700 bg-gray-100 rounded-lg hover:bg-gray-200 transition"
              >
                {restoreResult?.success ? 'Close' : 'Cancel'}
              </button>

              {/* Step 0 action */}
              {confirmStep === 0 && !restoreResult && (
                <button
                  onClick={() => setConfirmStep(1)}
                  disabled={!restoreFile}
                  className="flex items-center gap-2 px-4 py-2 text-sm font-medium text-white bg-blue-600 rounded-lg hover:bg-blue-700 transition disabled:opacity-50 disabled:cursor-not-allowed"
                >
                  <Upload className="w-4 h-4" />
                  Restore
                </button>
              )}

              {/* Step 1 action */}
              {confirmStep === 1 && !restoreResult && (
                <button
                  onClick={() => setConfirmStep(2)}
                  className="flex items-center gap-2 px-4 py-2 text-sm font-medium text-white bg-red-600 rounded-lg hover:bg-red-700 transition"
                >
                  Yes, continue
                </button>
              )}

              {/* Step 2 action */}
              {confirmStep === 2 && !restoreResult && (
                <button
                  onClick={handleRestoreBackup}
                  disabled={restoring}
                  className="flex items-center gap-2 px-4 py-2 text-sm font-medium text-white bg-red-700 rounded-lg hover:bg-red-800 transition disabled:opacity-50 disabled:cursor-not-allowed"
                >
                  {restoring ? (
                    <>
                      <div className="w-4 h-4 border-2 border-white border-t-transparent rounded-full animate-spin" />
                      Restoring...
                    </>
                  ) : (
                    'Yes, I am absolutely sure'
                  )}
                </button>
              )}
            </div>
          </div>
        </div>
      )}
    </Layout>
  );
}

// ─── Company Profile shared form data + resolver for logo/stamp preview ─────
interface ProfileFormShape {
  effective_from: string;
  company_name: string;
  company_legal_name: string;
  company_address: string;
  company_phone: string;
  company_email: string;
  company_website: string;
  company_tax_id: string;
  company_logo_url: string;
  company_stamp_url: string;
  pbf_license: string;
  cdob_certificate: string;
  notes: string;
}

// Resolves a stored path or URL into something an <img> tag can render.
// Full URLs (http/https/data) render as-is. Bare storage paths get a signed
// URL from the company-assets bucket.
function useCompanyAssetPreview(pathOrUrl: string) {
  const [preview, setPreview] = React.useState<string | null>(null);
  React.useEffect(() => {
    let cancelled = false;
    if (!pathOrUrl) { setPreview(null); return; }
    if (/^(data:|blob:|https?:\/\/)/i.test(pathOrUrl)) {
      setPreview(pathOrUrl);
      return;
    }
    (async () => {
      const { data, error } = await supabase.storage
        .from('company-assets')
        .createSignedUrl(pathOrUrl, 3600);
      if (!cancelled) setPreview(error ? null : data?.signedUrl ?? null);
    })();
    return () => { cancelled = true; };
  }, [pathOrUrl]);
  return preview;
}

// ─── Company Profile Form (inline, used for New) ────────────────────────────
interface CompanyProfileFormProps {
  title: string;
  data: ProfileFormShape;
  onChange: React.Dispatch<React.SetStateAction<ProfileFormShape>>;
  onUploadAsset: (kind: 'logo' | 'stamp', file: File) => Promise<string | null>;
  uploadingAsset: null | 'logo' | 'stamp';
  onSubmit: () => void;
  onCancel: () => void;
  submitLabel: string;
  saving: boolean;
  readOnly: boolean;
}

function CompanyProfileForm({ title, data, onChange, onUploadAsset, uploadingAsset, onSubmit, onCancel, submitLabel, saving, readOnly }: CompanyProfileFormProps) {
  return (
    <div className="mb-4 p-4 border rounded-lg bg-gray-50 space-y-3">
      <h4 className="text-sm font-semibold text-gray-700">{title}</h4>
      <CompanyProfileFields data={data} onChange={onChange} onUploadAsset={onUploadAsset} uploadingAsset={uploadingAsset} readOnly={readOnly} />
      <div className="flex justify-end gap-2">
        <button onClick={onCancel} className="border border-gray-300 text-gray-700 px-4 py-1.5 rounded-lg text-sm hover:bg-gray-100">Cancel</button>
        {!readOnly && (
          <button
            onClick={onSubmit}
            disabled={saving || uploadingAsset !== null || !data.company_name || !data.effective_from}
            className="bg-blue-600 text-white px-4 py-1.5 rounded-lg text-sm hover:bg-blue-700 disabled:opacity-50"
          >
            {saving ? 'Saving...' : submitLabel}
          </button>
        )}
      </div>
    </div>
  );
}

// ─── Edit Modal (opens for Edit / View-Historical) ──────────────────────────
interface CompanyProfileEditModalProps {
  profile: { id: string; company_name: string; effective_from: string };
  data: ProfileFormShape;
  onChange: React.Dispatch<React.SetStateAction<ProfileFormShape>>;
  onUploadAsset: (kind: 'logo' | 'stamp', file: File) => Promise<string | null>;
  uploadingAsset: null | 'logo' | 'stamp';
  onSubmit: () => void;
  onCancel: () => void;
  saving: boolean;
  /** True when the profile is referenced by documents: accounting fields
   *  (name, tax-id, licenses) are locked but branding/contact fields
   *  (logo, stamp, address, phone, email, website) remain editable. */
  brandingOnly?: boolean;
  refCount: number;
}

function CompanyProfileEditModal({ profile, data, onChange, onUploadAsset, uploadingAsset, onSubmit, onCancel, saving, brandingOnly = false, refCount }: CompanyProfileEditModalProps) {
  return (
    <div className="fixed inset-0 z-50 bg-black/40 flex items-start justify-center p-4 overflow-y-auto">
      <div className="w-full max-w-3xl bg-white rounded-lg shadow-xl mt-8">
        <div className="flex items-center justify-between border-b px-5 py-3">
          <div>
            <h3 className="text-base font-semibold text-gray-900">Edit Company Profile</h3>
            <p className="text-xs text-gray-500">
              {profile.company_name} · effective {profile.effective_from}
            </p>
          </div>
          <button onClick={onCancel} className="text-gray-400 hover:text-gray-600 text-2xl leading-none">&times;</button>
        </div>
        {brandingOnly && (
          <div className="mx-5 mt-4 rounded border border-blue-200 bg-blue-50 px-3 py-2 text-xs text-blue-900">
            This profile is referenced by {refCount} business document{refCount === 1 ? '' : 's'}.
            Accounting fields (company name, tax ID, licenses) are locked to preserve historical accuracy.
            Branding and contact fields (logo, stamp, address, phone, email, website) can be updated —
            existing document snapshots are not affected.
          </div>
        )}
        <div className="p-5">
          <CompanyProfileFields data={data} onChange={onChange} onUploadAsset={onUploadAsset} uploadingAsset={uploadingAsset} brandingOnly={brandingOnly} />
        </div>
        <div className="flex justify-end gap-2 border-t px-5 py-3">
          <button onClick={onCancel} className="border border-gray-300 text-gray-700 px-4 py-1.5 rounded-lg text-sm hover:bg-gray-100">
            Cancel
          </button>
          <button
            onClick={onSubmit}
            disabled={saving || uploadingAsset !== null || !data.company_name || !data.effective_from}
            className="bg-blue-600 text-white px-4 py-1.5 rounded-lg text-sm hover:bg-blue-700 disabled:opacity-50"
          >
            {saving ? 'Saving...' : 'Save Changes'}
          </button>
        </div>
      </div>
    </div>
  );
}

// ─── Shared field layout used by both New form and Edit modal ───────────────
interface CompanyProfileFieldsProps {
  data: ProfileFormShape;
  onChange: React.Dispatch<React.SetStateAction<ProfileFormShape>>;
  onUploadAsset: (kind: 'logo' | 'stamp', file: File) => Promise<string | null>;
  uploadingAsset: null | 'logo' | 'stamp';
  /** Fully read-only — no edits allowed (unused in practice now; kept for the
   *  new CompanyProfileForm which passes readOnly=false). */
  readOnly?: boolean;
  /** When true: accounting-critical fields (name, tax-id, licenses) are disabled
   *  but branding/contact fields (logo, stamp, address, phone, email, website)
   *  remain editable. Used for referenced profiles in production mode. */
  brandingOnly?: boolean;
}

function CompanyProfileFields({ data, onChange, onUploadAsset, uploadingAsset, readOnly = false, brandingOnly = false }: CompanyProfileFieldsProps) {
  const setField = (patch: Partial<ProfileFormShape>) => onChange(p => ({ ...p, ...patch }));
  const logoPreview  = useCompanyAssetPreview(data.company_logo_url);
  const stampPreview = useCompanyAssetPreview(data.company_stamp_url);

  const handleAssetUpload = async (kind: 'logo' | 'stamp', e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    e.target.value = '';
    if (!file) return;
    const path = await onUploadAsset(kind, file);
    if (path) {
      setField(kind === 'logo' ? { company_logo_url: path } : { company_stamp_url: path });
    }
  };

  // Accounting-critical: locked when readOnly OR brandingOnly.
  const acctCls = `w-full border rounded px-2 py-1.5 text-sm ${(readOnly || brandingOnly) ? 'bg-gray-100 text-gray-600' : ''}`;
  // Branding/contact: locked only when readOnly (not when brandingOnly).
  const brandCls = `w-full border rounded px-2 py-1.5 text-sm ${readOnly ? 'bg-gray-100 text-gray-600' : ''}`;
  const canEditBranding = !readOnly;

  return (
    <div className="grid grid-cols-2 gap-3">
      <div>
        <label className="block text-xs font-medium text-gray-600 mb-1">
          Effective From *{brandingOnly && <span className="ml-1 text-gray-400">(locked)</span>}
        </label>
        <input type="date" value={data.effective_from} onChange={e => setField({ effective_from: e.target.value })} disabled={readOnly || brandingOnly} className={acctCls} required />
      </div>
      <div>
        <label className="block text-xs font-medium text-gray-600 mb-1">
          Company Name *{brandingOnly && <span className="ml-1 text-gray-400">(locked)</span>}
        </label>
        <input type="text" value={data.company_name} onChange={e => setField({ company_name: e.target.value })} disabled={readOnly || brandingOnly} className={acctCls} placeholder="PT. ..." />
      </div>
      <div>
        <label className="block text-xs font-medium text-gray-600 mb-1">
          Legal Name{brandingOnly && <span className="ml-1 text-gray-400">(locked)</span>}
        </label>
        <input type="text" value={data.company_legal_name} onChange={e => setField({ company_legal_name: e.target.value })} disabled={readOnly || brandingOnly} className={acctCls} placeholder="Legal registered name" />
      </div>
      <div>
        <label className="block text-xs font-medium text-gray-600 mb-1">
          Tax ID (NPWP){brandingOnly && <span className="ml-1 text-gray-400">(locked)</span>}
        </label>
        <input type="text" value={data.company_tax_id} onChange={e => setField({ company_tax_id: e.target.value })} disabled={readOnly || brandingOnly} className={acctCls} />
      </div>
      <div className="col-span-2">
        <label className="block text-xs font-medium text-gray-600 mb-1">Address</label>
        <input type="text" value={data.company_address} onChange={e => setField({ company_address: e.target.value })} disabled={readOnly} className={brandCls} />
      </div>
      <div>
        <label className="block text-xs font-medium text-gray-600 mb-1">Phone</label>
        <input type="text" value={data.company_phone} onChange={e => setField({ company_phone: e.target.value })} disabled={readOnly} className={brandCls} />
      </div>
      <div>
        <label className="block text-xs font-medium text-gray-600 mb-1">Email</label>
        <input type="email" value={data.company_email} onChange={e => setField({ company_email: e.target.value })} disabled={readOnly} className={brandCls} />
      </div>
      <div>
        <label className="block text-xs font-medium text-gray-600 mb-1">Website</label>
        <input type="url" value={data.company_website} onChange={e => setField({ company_website: e.target.value })} disabled={readOnly} className={brandCls} placeholder="https://..." />
      </div>
      <div>
        <label className="block text-xs font-medium text-gray-600 mb-1">
          PBF License No.{brandingOnly && <span className="ml-1 text-gray-400">(locked)</span>}
        </label>
        <input type="text" value={data.pbf_license} onChange={e => setField({ pbf_license: e.target.value })} disabled={readOnly || brandingOnly} className={acctCls} placeholder="No izin PBF: ..." />
      </div>
      <div className="col-span-2">
        <label className="block text-xs font-medium text-gray-600 mb-1">
          CDOB Certificate No.{brandingOnly && <span className="ml-1 text-gray-400">(locked)</span>}
        </label>
        <input type="text" value={data.cdob_certificate} onChange={e => setField({ cdob_certificate: e.target.value })} disabled={readOnly || brandingOnly} className={acctCls} placeholder="No Sertifikasi CDOB: ..." />
      </div>

      {/* Logo */}
      <div className="col-span-1 border rounded p-3 bg-white">
        <label className="block text-xs font-medium text-gray-600 mb-2">Company Logo</label>
        <div className="w-full h-24 flex items-center justify-center bg-gray-50 border rounded mb-2">
          {logoPreview ? (
            <img src={logoPreview} alt="Company logo" className="max-h-full max-w-full object-contain" />
          ) : (
            <span className="text-xs text-gray-400">No logo uploaded</span>
          )}
        </div>
        {canEditBranding && (
          <div className="flex flex-wrap gap-2 items-center">
            <label className="text-xs px-2 py-1 rounded border border-gray-300 text-gray-700 hover:bg-gray-100 cursor-pointer">
              {data.company_logo_url ? 'Replace' : 'Upload'}
              <input type="file" accept="image/*" onChange={e => handleAssetUpload('logo', e)} disabled={uploadingAsset !== null} className="hidden" />
            </label>
            {data.company_logo_url && (
              <button
                type="button"
                onClick={() => setField({ company_logo_url: '' })}
                className="text-xs px-2 py-1 rounded border border-red-300 text-red-700 hover:bg-red-50"
              >
                Remove
              </button>
            )}
            {uploadingAsset === 'logo' && <span className="text-xs text-gray-500">Uploading…</span>}
          </div>
        )}
      </div>

      {/* Stamp */}
      <div className="col-span-1 border rounded p-3 bg-white">
        <label className="block text-xs font-medium text-gray-600 mb-2">Company Stamp</label>
        <div className="w-full h-24 flex items-center justify-center bg-gray-50 border rounded mb-2">
          {stampPreview ? (
            <img src={stampPreview} alt="Company stamp" className="max-h-full max-w-full object-contain" />
          ) : (
            <span className="text-xs text-gray-400">No stamp uploaded</span>
          )}
        </div>
        {canEditBranding && (
          <div className="flex flex-wrap gap-2 items-center">
            <label className="text-xs px-2 py-1 rounded border border-gray-300 text-gray-700 hover:bg-gray-100 cursor-pointer">
              {data.company_stamp_url ? 'Replace' : 'Upload'}
              <input type="file" accept="image/*" onChange={e => handleAssetUpload('stamp', e)} disabled={uploadingAsset !== null} className="hidden" />
            </label>
            {data.company_stamp_url && (
              <button
                type="button"
                onClick={() => setField({ company_stamp_url: '' })}
                className="text-xs px-2 py-1 rounded border border-red-300 text-red-700 hover:bg-red-50"
              >
                Remove
              </button>
            )}
            {uploadingAsset === 'stamp' && <span className="text-xs text-gray-500">Uploading…</span>}
          </div>
        )}
      </div>

      <div className="col-span-2">
        <label className="block text-xs font-medium text-gray-600 mb-1">Notes</label>
        <input type="text" value={data.notes} onChange={e => setField({ notes: e.target.value })} disabled={readOnly} className={brandCls} placeholder="Reason for change..." />
      </div>
    </div>
  );
}
