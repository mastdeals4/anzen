import { useState, useEffect } from 'react';
import { supabase } from '../../lib/supabase';
import { UserPlus, Trash2, CheckCircle, XCircle, UserX, Lock, User as UserIcon, Pencil as Edit2, Shield, ChevronDown, ChevronUp } from 'lucide-react';
import { Modal } from '../Modal';
import { showToast } from '../ToastNotification';
import { showConfirm } from '../ConfirmDialog';
import { ALL_MODULES, buildPermissionsFromRole, type ModuleId } from '../../utils/permissions';
import type { UserRole } from '../../lib/supabase';

interface UserProfile {
  id: string;
  username: string;
  email: string;
  full_name: string;
  role: UserRole;
  is_active: boolean;
  created_at: string;
}

interface UserPermissionRow {
  module: string;
  can_access: boolean;
}

interface UserManagementProps {
  users: UserProfile[];
  onRefresh: () => void;
}

const ROLE_LABELS: Record<UserRole, string> = {
  admin: 'Admin',
  manager: 'Manager',
  sales: 'Sales',
  accounts: 'Accounts',
  warehouse: 'Warehouse',
  auditor_ca: 'Auditor CA',
};

const ROLE_COLORS: Record<UserRole, string> = {
  admin: 'bg-blue-100 text-blue-800 border-blue-300',
  manager: 'bg-purple-100 text-purple-800 border-purple-300',
  sales: 'bg-green-100 text-green-800 border-green-300',
  accounts: 'bg-amber-100 text-amber-800 border-amber-300',
  warehouse: 'bg-orange-100 text-orange-800 border-orange-300',
  auditor_ca: 'bg-gray-100 text-gray-700 border-gray-300',
};

export function UserManagement({ users, onRefresh }: UserManagementProps) {
  const [showAddModal, setShowAddModal] = useState(false);
  const [showEditModal, setShowEditModal] = useState(false);
  const [showPasswordModal, setShowPasswordModal] = useState(false);
  const [editingUser, setEditingUser] = useState<UserProfile | null>(null);
  const [passwordUser, setPasswordUser] = useState<UserProfile | null>(null);
  const [loading, setLoading] = useState(false);
  const [newPassword, setNewPassword] = useState('');
  const [expandedUser, setExpandedUser] = useState<string | null>(null);
  const [formData, setFormData] = useState({
    username: '',
    email: '',
    password: '',
    full_name: '',
    role: 'sales' as UserRole,
  });

  const handleAddUser = async (e: React.FormEvent) => {
    e.preventDefault();
    setLoading(true);
    try {
      const { data: authData, error: authError } = await supabase.auth.signUp({
        email: formData.email,
        password: formData.password,
        options: {
          data: {
            username: formData.username.toLowerCase(),
            full_name: formData.full_name,
            role: formData.role,
            email_verified: true,
          },
        },
      });

      if (authError) throw authError;
      if (!authData.user) throw new Error('Failed to create user');

      await new Promise(resolve => setTimeout(resolve, 500));

      await supabase
        .from('user_profiles')
        .update({ is_active: true })
        .eq('id', authData.user.id);

      showToast({ type: 'success', title: 'Success', message: `User ${formData.full_name} created successfully!` });
      setShowAddModal(false);
      resetForm();
      onRefresh();
    } catch (error: any) {
      showToast({ type: 'error', title: 'Error', message: error.message || 'Failed to create user.' });
    } finally {
      setLoading(false);
    }
  };

  const handleEditUser = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!editingUser) return;
    setLoading(true);
    try {
      const { data: { session } } = await supabase.auth.getSession();
      if (!session) throw new Error('Not authenticated');

      const response = await fetch(`${import.meta.env.VITE_SUPABASE_URL}/functions/v1/admin-update-user`, {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${session.access_token}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          user_id: editingUser.id,
          email: formData.email,
          username: formData.username,
          full_name: formData.full_name,
          role: formData.role,
        }),
      });

      const result = await response.json();
      if (!response.ok) throw new Error(result.error || 'Failed to update user');

      showToast({ type: 'success', title: 'Success', message: `User ${formData.full_name} updated successfully!` });
      setShowEditModal(false);
      setEditingUser(null);
      resetForm();
      onRefresh();
    } catch (error: any) {
      showToast({ type: 'error', title: 'Error', message: error.message || 'Failed to update user.' });
    } finally {
      setLoading(false);
    }
  };

  const openEditModal = (user: UserProfile) => {
    setEditingUser(user);
    setFormData({ username: user.username, email: user.email, password: '', full_name: user.full_name, role: user.role });
    setShowEditModal(true);
  };

  const toggleUserStatus = async (userId: string, currentStatus: boolean) => {
    const action = currentStatus ? 'deactivate' : 'activate';
    if (!await showConfirm({ title: 'Confirm', message: `Are you sure you want to ${action} this user?`, variant: 'warning', confirmLabel: action.charAt(0).toUpperCase() + action.slice(1) })) return;

    try {
      const { error } = await supabase.from('user_profiles').update({ is_active: !currentStatus }).eq('id', userId);
      if (error) throw error;
      showToast({ type: 'success', title: 'Success', message: `User ${currentStatus ? 'deactivated' : 'activated'} successfully!` });
      onRefresh();
    } catch {
      showToast({ type: 'error', title: 'Error', message: 'Failed to update user status.' });
    }
  };

  const deleteUser = async (userId: string, username: string) => {
    if (!await showConfirm({ title: 'Confirm', message: `Are you sure you want to permanently delete user "${username}"? This cannot be undone.`, variant: 'danger', confirmLabel: 'Delete' })) return;

    try {
      const { data: { session } } = await supabase.auth.getSession();
      if (!session) throw new Error('Not authenticated');

      const response = await fetch(`${import.meta.env.VITE_SUPABASE_URL}/functions/v1/admin-delete-user`, {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${session.access_token}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ user_id: userId }),
      });

      const result = await response.json();
      if (!response.ok) throw new Error(result.error || 'Failed to delete user');

      showToast({ type: 'success', title: 'Success', message: 'User deleted successfully!' });
      onRefresh();
    } catch (error: any) {
      showToast({ type: 'error', title: 'Error', message: error.message || 'Failed to delete user.' });
    }
  };

  const openPasswordModal = (user: UserProfile) => {
    setPasswordUser(user);
    setNewPassword('');
    setShowPasswordModal(true);
  };

  const handleChangePassword = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!passwordUser) return;
    if (newPassword.length < 6) {
      showToast({ type: 'error', title: 'Error', message: 'Password must be at least 6 characters' });
      return;
    }
    setLoading(true);
    try {
      const { data: { session } } = await supabase.auth.getSession();
      if (!session) throw new Error('Not authenticated');

      const response = await fetch(`${import.meta.env.VITE_SUPABASE_URL}/functions/v1/admin-update-password`, {
        method: 'POST',
        headers: { 'Authorization': `Bearer ${session.access_token}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ user_id: passwordUser.id, new_password: newPassword }),
      });

      const result = await response.json();
      if (!response.ok) throw new Error(result.error || 'Failed to update password');

      showToast({ type: 'success', title: 'Success', message: `Password updated for ${passwordUser.full_name}!` });
      setShowPasswordModal(false);
      setPasswordUser(null);
      setNewPassword('');
    } catch (error: any) {
      showToast({ type: 'error', title: 'Error', message: error.message || 'Failed to change password.' });
    } finally {
      setLoading(false);
    }
  };

  const resetForm = () => setFormData({ username: '', email: '', password: '', full_name: '', role: 'sales' });

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <div>
          <h3 className="text-lg font-semibold flex items-center gap-2">
            <UserIcon className="w-5 h-5" />
            User Management
          </h3>
          <p className="text-sm text-gray-500 mt-0.5">Manage users and their module access permissions</p>
        </div>
        <button
          onClick={() => setShowAddModal(true)}
          className="px-4 py-2 bg-blue-600 text-white rounded-lg hover:bg-blue-700 transition flex items-center gap-2 text-sm font-medium"
        >
          <UserPlus className="w-4 h-4" />
          Add User
        </button>
      </div>

      {/* User List */}
      <div className="space-y-2">
        {users.length === 0 ? (
          <div className="text-center py-12 bg-gray-50 rounded-xl border border-dashed border-gray-300">
            <UserIcon className="w-10 h-10 text-gray-300 mx-auto mb-3" />
            <p className="text-gray-500 text-sm">No users found</p>
            <button onClick={() => setShowAddModal(true)} className="mt-3 text-blue-600 hover:text-blue-700 text-sm font-medium">
              Add your first user
            </button>
          </div>
        ) : (
          users.map((user) => (
            <div key={user.id} className="bg-white rounded-xl border border-gray-200 overflow-hidden">
              <div className="flex items-center justify-between px-4 py-3">
                <div className="flex items-center gap-3 min-w-0">
                  <div className="w-10 h-10 rounded-full bg-gradient-to-br from-blue-500 to-blue-700 flex items-center justify-center flex-shrink-0">
                    <span className="text-white font-bold text-sm">{user.full_name.charAt(0).toUpperCase()}</span>
                  </div>
                  <div className="min-w-0">
                    <div className="flex items-center gap-2 flex-wrap">
                      <p className="font-semibold text-gray-900 text-sm">{user.full_name}</p>
                      <span className={`px-2 py-0.5 border rounded-full text-xs font-medium ${ROLE_COLORS[user.role]}`}>
                        {ROLE_LABELS[user.role]}
                      </span>
                      {!user.is_active && (
                        <span className="px-2 py-0.5 bg-red-50 border border-red-200 text-red-600 rounded-full text-xs">Inactive</span>
                      )}
                    </div>
                    <p className="text-xs text-gray-500 font-mono">@{user.username} &middot; {user.email}</p>
                  </div>
                </div>

                <div className="flex items-center gap-1 flex-shrink-0 ml-2">
                  <button
                    onClick={() => setExpandedUser(expandedUser === user.id ? null : user.id)}
                    className="p-2 text-blue-600 hover:bg-blue-50 rounded-lg transition text-xs flex items-center gap-1 font-medium"
                    title="Manage permissions"
                  >
                    <Shield className="w-4 h-4" />
                    <span className="hidden sm:inline">Permissions</span>
                    {expandedUser === user.id ? <ChevronUp className="w-3 h-3" /> : <ChevronDown className="w-3 h-3" />}
                  </button>
                  <button onClick={() => openEditModal(user)} className="p-2 text-gray-500 hover:bg-gray-100 rounded-lg transition" title="Edit user">
                    <Edit2 className="w-4 h-4" />
                  </button>
                  <button onClick={() => openPasswordModal(user)} className="p-2 text-gray-500 hover:bg-gray-100 rounded-lg transition" title="Change password">
                    <Lock className="w-4 h-4" />
                  </button>
                  <button
                    onClick={() => toggleUserStatus(user.id, user.is_active)}
                    className={`p-2 rounded-lg transition ${user.is_active ? 'text-green-600 hover:bg-green-50' : 'text-red-500 hover:bg-red-50'}`}
                    title={user.is_active ? 'Deactivate' : 'Activate'}
                  >
                    {user.is_active ? <UserX className="w-4 h-4" /> : <CheckCircle className="w-4 h-4" />}
                  </button>
                  <button onClick={() => deleteUser(user.id, user.username)} className="p-2 text-gray-400 hover:text-red-600 hover:bg-red-50 rounded-lg transition" title="Delete user">
                    <Trash2 className="w-4 h-4" />
                  </button>
                </div>
              </div>

              {/* Inline permissions panel */}
              {expandedUser === user.id && (
                <InlinePermissionsPanel user={user} onClose={() => setExpandedUser(null)} onSaved={onRefresh} />
              )}
            </div>
          ))
        )}
      </div>

      {/* Add User Modal */}
      <Modal isOpen={showAddModal} onClose={() => { setShowAddModal(false); resetForm(); }} title="New User">
        <form onSubmit={handleAddUser} className="space-y-4">
          <div>
            <label className="block text-sm font-medium text-gray-700 mb-1">Full Name <span className="text-red-500">*</span></label>
            <input type="text" value={formData.full_name} onChange={(e) => setFormData({ ...formData, full_name: e.target.value })}
              className="w-full px-3 py-2 border border-gray-300 rounded-lg focus:ring-2 focus:ring-blue-500 focus:border-blue-500 text-sm" placeholder="John Doe" required />
          </div>
          <div>
            <label className="block text-sm font-medium text-gray-700 mb-1">Username <span className="text-red-500">*</span></label>
            <input type="text" value={formData.username} onChange={(e) => setFormData({ ...formData, username: e.target.value.toLowerCase().replace(/[^a-z0-9]/g, '') })}
              className="w-full px-3 py-2 border border-gray-300 rounded-lg focus:ring-2 focus:ring-blue-500 focus:border-blue-500 text-sm font-mono\" placeholder="johndoe\" pattern="[a-z0-9]+\" required />
            <p className="text-xs text-gray-400 mt-1">Lowercase letters and numbers only. Used for login.</p>
          </div>
          <div>
            <label className="block text-sm font-medium text-gray-700 mb-1">Email <span className="text-red-500">*</span></label>
            <input type="email" value={formData.email} onChange={(e) => setFormData({ ...formData, email: e.target.value })}
              className="w-full px-3 py-2 border border-gray-300 rounded-lg focus:ring-2 focus:ring-blue-500 focus:border-blue-500 text-sm" placeholder="user@company.com" required />
          </div>
          <div>
            <label className="block text-sm font-medium text-gray-700 mb-1">Password <span className="text-red-500">*</span></label>
            <input type="password" value={formData.password} onChange={(e) => setFormData({ ...formData, password: e.target.value })}
              className="w-full px-3 py-2 border border-gray-300 rounded-lg focus:ring-2 focus:ring-blue-500 focus:border-blue-500 text-sm" placeholder="Minimum 6 characters" minLength={6} required />
          </div>
          <div>
            <label className="block text-sm font-medium text-gray-700 mb-1">Role <span className="text-red-500">*</span></label>
            <select value={formData.role} onChange={(e) => setFormData({ ...formData, role: e.target.value as UserRole })}
              className="w-full px-3 py-2 border border-gray-300 rounded-lg focus:ring-2 focus:ring-blue-500 focus:border-blue-500 text-sm" required>
              <option value="sales">Sales</option>
              <option value="accounts">Accounts</option>
              <option value="warehouse">Warehouse</option>
              <option value="auditor_ca">Auditor CA</option>
              <option value="admin">Admin</option>
            </select>
            <p className="text-xs text-gray-400 mt-1">Sets default module permissions. You can customize them after creating the user.</p>
          </div>
          <div className="flex justify-end gap-3 pt-3 border-t">
            <button type="button" onClick={() => { setShowAddModal(false); resetForm(); }} className="px-4 py-2 text-gray-700 bg-gray-100 rounded-lg hover:bg-gray-200 transition text-sm" disabled={loading}>Cancel</button>
            <button type="submit" className="px-4 py-2 bg-blue-600 text-white rounded-lg hover:bg-blue-700 transition flex items-center gap-2 text-sm disabled:opacity-50" disabled={loading}>
              {loading ? <><div className="w-4 h-4 border-2 border-white border-t-transparent rounded-full animate-spin" />Creating...</> : <><UserPlus className="w-4 h-4" />Create User</>}
            </button>
          </div>
        </form>
      </Modal>

      {/* Edit User Modal */}
      <Modal isOpen={showEditModal} onClose={() => { setShowEditModal(false); setEditingUser(null); resetForm(); }} title="Edit User">
        <form onSubmit={handleEditUser} className="space-y-4">
          <div>
            <label className="block text-sm font-medium text-gray-700 mb-1">Full Name <span className="text-red-500">*</span></label>
            <input type="text" value={formData.full_name} onChange={(e) => setFormData({ ...formData, full_name: e.target.value })}
              className="w-full px-3 py-2 border border-gray-300 rounded-lg focus:ring-2 focus:ring-blue-500 focus:border-blue-500 text-sm" required />
          </div>
          <div>
            <label className="block text-sm font-medium text-gray-700 mb-1">Username <span className="text-red-500">*</span></label>
            <input type="text" value={formData.username} onChange={(e) => setFormData({ ...formData, username: e.target.value.toLowerCase().replace(/[^a-z0-9]/g, '') })}
              className="w-full px-3 py-2 border border-gray-300 rounded-lg focus:ring-2 focus:ring-blue-500 focus:border-blue-500 text-sm font-mono\" pattern="[a-z0-9]+\" required />
          </div>
          <div>
            <label className="block text-sm font-medium text-gray-700 mb-1">Email <span className="text-red-500">*</span></label>
            <input type="email" value={formData.email} onChange={(e) => setFormData({ ...formData, email: e.target.value })}
              className="w-full px-3 py-2 border border-gray-300 rounded-lg focus:ring-2 focus:ring-blue-500 focus:border-blue-500 text-sm" required />
          </div>
          <div>
            <label className="block text-sm font-medium text-gray-700 mb-1">Role <span className="text-red-500">*</span></label>
            <select value={formData.role} onChange={(e) => setFormData({ ...formData, role: e.target.value as UserRole })}
              className="w-full px-3 py-2 border border-gray-300 rounded-lg focus:ring-2 focus:ring-blue-500 focus:border-blue-500 text-sm" required>
              <option value="sales">Sales</option>
              <option value="accounts">Accounts</option>
              <option value="warehouse">Warehouse</option>
              <option value="auditor_ca">Auditor CA</option>
              <option value="admin">Admin</option>
            </select>
          </div>
          <div className="flex justify-end gap-3 pt-3 border-t">
            <button type="button" onClick={() => { setShowEditModal(false); setEditingUser(null); resetForm(); }} className="px-4 py-2 text-gray-700 bg-gray-100 rounded-lg hover:bg-gray-200 transition text-sm" disabled={loading}>Cancel</button>
            <button type="submit" className="px-4 py-2 bg-blue-600 text-white rounded-lg hover:bg-blue-700 transition flex items-center gap-2 text-sm disabled:opacity-50" disabled={loading}>
              {loading ? <><div className="w-4 h-4 border-2 border-white border-t-transparent rounded-full animate-spin" />Saving...</> : <><Edit2 className="w-4 h-4" />Save Changes</>}
            </button>
          </div>
        </form>
      </Modal>

      {/* Change Password Modal */}
      <Modal isOpen={showPasswordModal} onClose={() => { setShowPasswordModal(false); setPasswordUser(null); setNewPassword(''); }} title="Change Password">
        <form onSubmit={handleChangePassword} className="space-y-4">
          <div className="bg-amber-50 border border-amber-200 rounded-lg p-3 text-sm text-amber-800">
            Changing password for <strong>{passwordUser?.full_name}</strong> (@{passwordUser?.username})
          </div>
          <div>
            <label className="block text-sm font-medium text-gray-700 mb-1">New Password <span className="text-red-500">*</span></label>
            <input type="password" value={newPassword} onChange={(e) => setNewPassword(e.target.value)}
              className="w-full px-3 py-2 border border-gray-300 rounded-lg focus:ring-2 focus:ring-blue-500 focus:border-blue-500 text-sm"
              placeholder="Minimum 6 characters" minLength={6} required autoFocus />
          </div>
          <div className="flex justify-end gap-3 pt-3 border-t">
            <button type="button" onClick={() => { setShowPasswordModal(false); setPasswordUser(null); setNewPassword(''); }} className="px-4 py-2 text-gray-700 bg-gray-100 rounded-lg hover:bg-gray-200 transition text-sm" disabled={loading}>Cancel</button>
            <button type="submit" className="px-4 py-2 bg-blue-600 text-white rounded-lg hover:bg-blue-700 transition flex items-center gap-2 text-sm disabled:opacity-50" disabled={loading}>
              {loading ? <><div className="w-4 h-4 border-2 border-white border-t-transparent rounded-full animate-spin" />Updating...</> : <><Lock className="w-4 h-4" />Update Password</>}
            </button>
          </div>
        </form>
      </Modal>
    </div>
  );
}

interface InlinePermissionsPanelProps {
  user: UserProfile;
  onClose: () => void;
  onSaved: () => void;
}

function InlinePermissionsPanel({ user, onClose, onSaved }: InlinePermissionsPanelProps) {
  const [perms, setPerms] = useState<Record<ModuleId, boolean> | null>(null);
  const [saving, setSaving] = useState(false);
  const [showAdvancedModules, setShowAdvancedModules] = useState(false);

  useEffect(() => {
    (async () => {
      const { data } = await supabase
        .from('user_permissions')
        .select('module, can_access')
        .eq('user_id', user.id);

      const existing = (data ?? []) as { module: string; can_access: boolean }[];
      const base = buildPermissionsFromRole(user.role);

      if (existing.length > 0) {
        for (const row of existing) {
          base[row.module as ModuleId] = row.can_access;
        }
      }
      setPerms(base);
    })();
  }, [user.id, user.role]);

  const handleSave = async () => {
    if (!perms) return;
    setSaving(true);
    try {
      const rows = ALL_MODULES.map(mod => ({
        user_id: user.id,
        module: mod.id,
        can_access: perms[mod.id] ?? false,
      }));

      const { error } = await supabase
        .from('user_permissions')
        .upsert(rows, { onConflict: 'user_id,module' });

      if (error) throw error;

      showToast({ type: 'success', title: 'Saved', message: `Permissions updated for ${user.full_name}` });
      onClose();
      onSaved();
    } catch (error: any) {
      showToast({ type: 'error', title: 'Error', message: error.message || 'Failed to save permissions.' });
    } finally {
      setSaving(false);
    }
  };

  const toggleAll = (value: boolean) => {
    if (!perms) return;
    const updated = { ...perms };
    for (const mod of ALL_MODULES) {
      updated[mod.id] = value;
    }
    setPerms(updated);
  };

  if (!perms) {
    return (
      <div className="border-t border-gray-100 px-4 py-4 bg-gray-50 flex items-center justify-center">
        <div className="w-5 h-5 border-2 border-blue-600 border-t-transparent rounded-full animate-spin" />
      </div>
    );
  }

  const allOn = ALL_MODULES.every(m => perms[m.id]);
  const allOff = ALL_MODULES.every(m => !perms[m.id]);

  return (
    <div className="border-t border-gray-100 bg-gray-50 px-4 py-4">
      <div className="flex items-center justify-between mb-3">
        <div className="flex items-center gap-2">
          <Shield className="w-4 h-4 text-blue-600" />
          <span className="text-sm font-semibold text-gray-800">Module Permissions</span>
          <span className="text-xs text-gray-400">— {user.full_name}</span>
        </div>
        <div className="flex items-center gap-2">
          <label className="text-[11px] flex items-center gap-1.5 text-gray-600 mr-2 cursor-pointer">
            <input type="checkbox" checked={showAdvancedModules} onChange={e => setShowAdvancedModules(e.target.checked)}
              className="rounded border-gray-300 text-blue-600 focus:ring-blue-500" />
            Show advanced
          </label>
          <button onClick={() => toggleAll(true)} disabled={allOn}
            className="text-xs px-2 py-1 bg-green-50 text-green-700 border border-green-200 rounded hover:bg-green-100 transition disabled:opacity-40">
            Enable All
          </button>
          <button onClick={() => toggleAll(false)} disabled={allOff}
            className="text-xs px-2 py-1 bg-red-50 text-red-600 border border-red-200 rounded hover:bg-red-100 transition disabled:opacity-40">
            Disable All
          </button>
        </div>
      </div>

      <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-4 gap-2 mb-4">
        {ALL_MODULES
          .filter((mod) => !('advanced' in mod) || !mod.advanced || showAdvancedModules)
          .map(mod => (
          <label key={mod.id} className={`flex items-center gap-2 px-3 py-2 rounded-lg border cursor-pointer transition-colors ${
            perms[mod.id]
              ? 'bg-white border-green-300 text-gray-800'
              : 'bg-white border-gray-200 text-gray-400'
          }`}>
            <div className={`w-4 h-4 rounded border flex-shrink-0 flex items-center justify-center transition-colors ${
              perms[mod.id] ? 'bg-green-500 border-green-500' : 'border-gray-300 bg-white'
            }`}>
              {perms[mod.id] && (
                <svg className="w-3 h-3 text-white" fill="none" viewBox="0 0 12 12">
                  <path d="M2 6l3 3 5-5" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" />
                </svg>
              )}
            </div>
            <input
              type="checkbox"
              className="sr-only"
              checked={perms[mod.id] ?? false}
              onChange={(e) => setPerms({ ...perms, [mod.id]: e.target.checked })}
            />
            <span className="text-xs font-medium truncate">{mod.label}</span>
          </label>
        ))}
      </div>

      <div className="flex items-center justify-end gap-2">
        <button onClick={onClose} className="px-3 py-1.5 text-gray-600 bg-white border border-gray-200 rounded-lg hover:bg-gray-100 transition text-xs">
          Cancel
        </button>
        <button onClick={handleSave} disabled={saving}
          className="px-4 py-1.5 bg-blue-600 text-white rounded-lg hover:bg-blue-700 transition text-xs font-medium flex items-center gap-1.5 disabled:opacity-50">
          {saving ? <><div className="w-3 h-3 border-2 border-white border-t-transparent rounded-full animate-spin" />Saving...</> : <><Shield className="w-3 h-3" />Save Permissions</>}
        </button>
      </div>
    </div>
  );
}
