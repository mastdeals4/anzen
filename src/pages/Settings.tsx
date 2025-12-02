import { useEffect, useState } from 'react';
import { Layout } from '../components/Layout';
import { useLanguage } from '../contexts/LanguageContext';
import { useAuth } from '../contexts/AuthContext';
import { supabase } from '../lib/supabase';
import { Save, Building2, Mail, DollarSign, Package, Users, Calendar, FileText } from 'lucide-react';
import { GmailSettings } from '../components/crm/GmailSettings';
import { UserManagement } from '../components/settings/UserManagement';
import { EmailTemplates } from '../components/settings/EmailTemplates';

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
}

interface UserProfile {
  id: string;
  username?: string;
  email: string;
  full_name: string;
  role: 'admin' | 'accounts' | 'sales' | 'warehouse';
  language?: string;
  is_active: boolean;
  created_at?: string;
}

export function Settings() {
  const { t } = useLanguage();
  const { profile } = useAuth();
  const [activeTab, setActiveTab] = useState<'company' | 'users' | 'system' | 'financial' | 'gmail' | 'templates'>('company');
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [settings, setSettings] = useState<AppSettings | null>(null);
  const [users, setUsers] = useState<UserProfile[]>([]);
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
  });

  useEffect(() => {
    if (profile?.role === 'admin') {
      loadSettings();
      loadUsers();
    }
  }, [profile]);

  const loadSettings = async () => {
    try {
      const { data, error } = await supabase
        .from('app_settings')
        .select('*')
        .limit(1)
        .maybeSingle();

      if (error) throw error;

      if (data) {
        setSettings(data);
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
        });
      }
    } catch (error) {
      console.error('Error loading settings:', error);
    } finally {
      setLoading(false);
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

  const handleSave = async (e: React.FormEvent) => {
    e.preventDefault();
    setSaving(true);

    try {
      if (settings) {
        const { error } = await supabase
          .from('app_settings')
          .update({
            ...formData,
            email_host: formData.email_host || null,
            email_username: formData.email_username || null,
          })
          .eq('id', settings.id);

        if (error) throw error;
      } else {
        const { error } = await supabase
          .from('app_settings')
          .insert([{
            ...formData,
            email_host: formData.email_host || null,
            email_username: formData.email_username || null,
          }]);

        if (error) throw error;
      }

      alert('Settings saved successfully!');
      loadSettings();
    } catch (error) {
      console.error('Error saving settings:', error);
      alert('Failed to save settings. Please try again.');
    } finally {
      setSaving(false);
    }
  };


  if (profile?.role !== 'admin') {
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
        <div>
          <h1 className="text-3xl font-bold text-gray-900">Settings</h1>
          <p className="text-gray-600 mt-1">Configure system settings and manage users</p>
        </div>

        <div className="bg-white rounded-lg shadow">
          <div className="border-b border-gray-200">
            <nav className="flex -mb-px">
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
            </nav>
          </div>

          <div className="p-6">
            {activeTab === 'gmail' && (
              <GmailSettings />
            )}

            {activeTab === 'templates' && (
              <EmailTemplates />
            )}

            {activeTab === 'company' && (
              <form onSubmit={handleSave} className="space-y-6">
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
            )}

            {activeTab === 'users' && (
              <UserManagement users={users} onRefresh={loadUsers} />
            )}

            {activeTab === 'financial' && (
              <form onSubmit={handleSave} className="space-y-6">
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
                      {new Date(formData.financial_year_start).toLocaleDateString()} - {new Date(formData.financial_year_end).toLocaleDateString()}
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
              <form onSubmit={handleSave} className="space-y-6">
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
    </Layout>
  );
}
