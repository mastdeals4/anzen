import { useState } from 'react';
import { supabase } from '../../lib/supabase';
import { UserPlus, Trash2, CheckCircle, XCircle, Mail, Lock, User as UserIcon, Briefcase, Edit2, X as XIcon } from 'lucide-react';
import { Modal } from '../Modal';

interface UserProfile {
  id: string;
  username: string;
  email: string;
  full_name: string;
  role: 'admin' | 'sales' | 'accounts' | 'warehouse';
  is_active: boolean;
  created_at: string;
}

interface UserManagementProps {
  users: UserProfile[];
  onRefresh: () => void;
}

export function UserManagement({ users, onRefresh }: UserManagementProps) {
  const [showAddModal, setShowAddModal] = useState(false);
  const [showEditModal, setShowEditModal] = useState(false);
  const [editingUser, setEditingUser] = useState<UserProfile | null>(null);
  const [loading, setLoading] = useState(false);
  const [formData, setFormData] = useState({
    username: '',
    email: '',
    password: '',
    full_name: '',
    role: 'sales' as 'admin' | 'sales' | 'accounts' | 'warehouse',
  });

  const handleAddUser = async (e: React.FormEvent) => {
    e.preventDefault();
    setLoading(true);

    try {
      // Create auth user
      const { data: authData, error: authError } = await supabase.auth.signUp({
        email: formData.email,
        password: formData.password,
        options: {
          data: {
            full_name: formData.full_name,
            email_verified: true,
          },
        },
      });

      if (authError) throw authError;
      if (!authData.user) throw new Error('Failed to create user');

      // Create user profile
      const { error: profileError } = await supabase
        .from('user_profiles')
        .insert([{
          id: authData.user.id,
          username: formData.username.toLowerCase(),
          email: formData.email,
          full_name: formData.full_name,
          role: formData.role,
          is_active: true,
        }]);

      if (profileError) throw profileError;

      alert(`User ${formData.full_name} created successfully! Username: ${formData.username}`);
      setShowAddModal(false);
      setFormData({
        username: '',
        email: '',
        password: '',
        full_name: '',
        role: 'sales',
      });
      onRefresh();
    } catch (error: any) {
      console.error('Error creating user:', error);
      alert(error.message || 'Failed to create user. Please try again.');
    } finally {
      setLoading(false);
    }
  };

  const handleEditUser = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!editingUser) return;

    setLoading(true);

    try {
      const { error } = await supabase
        .from('user_profiles')
        .update({
          username: formData.username.toLowerCase(),
          full_name: formData.full_name,
          role: formData.role,
        })
        .eq('id', editingUser.id);

      if (error) throw error;

      alert(`User ${formData.full_name} updated successfully!`);
      setShowEditModal(false);
      setEditingUser(null);
      setFormData({
        username: '',
        email: '',
        password: '',
        full_name: '',
        role: 'sales',
      });
      onRefresh();
    } catch (error: any) {
      console.error('Error updating user:', error);
      alert(error.message || 'Failed to update user. Please try again.');
    } finally {
      setLoading(false);
    }
  };

  const openEditModal = (user: UserProfile) => {
    setEditingUser(user);
    setFormData({
      username: user.username,
      email: user.email,
      password: '',
      full_name: user.full_name,
      role: user.role,
    });
    setShowEditModal(true);
  };

  const toggleUserStatus = async (userId: string, currentStatus: boolean) => {
    const action = currentStatus ? 'deactivate' : 'activate';
    if (!confirm(`Are you sure you want to ${action} this user?`)) {
      return;
    }

    try {
      const { error } = await supabase
        .from('user_profiles')
        .update({ is_active: !currentStatus })
        .eq('id', userId);

      if (error) throw error;

      alert(`User ${currentStatus ? 'deactivated' : 'activated'} successfully!`);
      onRefresh();
    } catch (error) {
      console.error('Error updating user status:', error);
      alert('Failed to update user status.');
    }
  };

  const deleteUser = async (userId: string, username: string) => {
    if (!confirm(`Are you sure you want to permanently delete user "${username}"? This action cannot be undone.`)) {
      return;
    }

    try {
      // First, delete user profile
      const { error: profileError } = await supabase
        .from('user_profiles')
        .delete()
        .eq('id', userId);

      if (profileError) throw profileError;

      alert('User deleted successfully!');
      onRefresh();
    } catch (error) {
      console.error('Error deleting user:', error);
      alert('Failed to delete user. The user may have associated records.');
    }
  };

  const getRoleBadgeColor = (role: string) => {
    switch (role) {
      case 'admin':
        return 'bg-purple-100 text-purple-800 border-purple-300';
      case 'sales':
        return 'bg-blue-100 text-blue-800 border-blue-300';
      case 'accounts':
        return 'bg-green-100 text-green-800 border-green-300';
      case 'warehouse':
        return 'bg-orange-100 text-orange-800 border-orange-300';
      default:
        return 'bg-gray-100 text-gray-800 border-gray-300';
    }
  };

  return (
    <div className="space-y-6">
      {/* Header */}
      <div className="flex items-center justify-between">
        <div>
          <h3 className="text-lg font-semibold flex items-center gap-2">
            <UserIcon className="w-5 h-5" />
            User Management
          </h3>
          <p className="text-sm text-gray-600 mt-1">
            Manage system users, roles, and access permissions
          </p>
        </div>
        <button
          onClick={() => setShowAddModal(true)}
          className="px-4 py-2 bg-blue-600 text-white rounded-lg hover:bg-blue-700 transition flex items-center gap-2"
        >
          <UserPlus className="w-4 h-4" />
          Add New User
        </button>
      </div>

      {/* User List */}
      <div className="space-y-3">
        {users.length === 0 ? (
          <div className="text-center py-12 bg-gray-50 rounded-lg border border-gray-200">
            <UserIcon className="w-12 h-12 text-gray-400 mx-auto mb-3" />
            <p className="text-gray-600">No users found</p>
            <button
              onClick={() => setShowAddModal(true)}
              className="mt-4 text-blue-600 hover:text-blue-700 font-medium"
            >
              Add your first user
            </button>
          </div>
        ) : (
          users.map((user) => (
            <div
              key={user.id}
              className="flex items-center justify-between p-4 bg-white rounded-lg border border-gray-200 hover:border-gray-300 transition"
            >
              <div className="flex items-center gap-4">
                <div className="w-12 h-12 rounded-full bg-gradient-to-br from-blue-500 to-blue-600 flex items-center justify-center shadow-md">
                  <span className="text-white font-bold text-lg">
                    {user.full_name.charAt(0).toUpperCase()}
                  </span>
                </div>
                <div>
                  <p className="font-semibold text-gray-900">{user.full_name}</p>
                  <p className="text-sm text-gray-600 font-mono">@{user.username}</p>
                  <p className="text-sm text-gray-500 flex items-center gap-1 mt-0.5">
                    <Mail className="w-3 h-3" />
                    {user.email}
                  </p>
                  <p className="text-xs text-gray-400 mt-0.5">
                    Created: {new Date(user.created_at).toLocaleDateString()}
                  </p>
                </div>
              </div>

              <div className="flex items-center gap-3">
                <span className={`px-3 py-1 border rounded-full text-xs font-medium capitalize flex items-center gap-1.5 ${getRoleBadgeColor(user.role)}`}>
                  <Briefcase className="w-3 h-3" />
                  {user.role}
                </span>

                <button
                  onClick={() => openEditModal(user)}
                  className="p-2 text-blue-600 hover:bg-blue-50 rounded-lg transition"
                  title="Edit user"
                >
                  <Edit2 className="w-4 h-4" />
                </button>

                <button
                  onClick={() => toggleUserStatus(user.id, user.is_active)}
                  className={`px-4 py-1.5 rounded-lg text-sm font-medium transition flex items-center gap-1.5 ${
                    user.is_active
                      ? 'bg-green-100 text-green-800 hover:bg-green-200 border border-green-300'
                      : 'bg-red-100 text-red-800 hover:bg-red-200 border border-red-300'
                  }`}
                  title={user.is_active ? 'Click to deactivate' : 'Click to activate'}
                >
                  {user.is_active ? (
                    <>
                      <CheckCircle className="w-3.5 h-3.5" />
                      Active
                    </>
                  ) : (
                    <>
                      <XCircle className="w-3.5 h-3.5" />
                      Inactive
                    </>
                  )}
                </button>

                <button
                  onClick={() => deleteUser(user.id, user.username)}
                  className="p-2 text-red-600 hover:bg-red-50 rounded-lg transition"
                  title="Delete user"
                >
                  <Trash2 className="w-4 h-4" />
                </button>
              </div>
            </div>
          ))
        )}
      </div>

      {/* Add User Modal */}
      <Modal
        isOpen={showAddModal}
        onClose={() => {
          setShowAddModal(false);
          setFormData({
            username: '',
            email: '',
            password: '',
            full_name: '',
            role: 'sales',
          });
        }}
        title="Add New User"
      >
        <form onSubmit={handleAddUser} className="space-y-4">
          <div className="bg-blue-50 border border-blue-200 rounded-lg p-3 mb-4">
            <p className="text-sm text-blue-800">
              Create a new user account. The user will be able to log in with their username and password.
            </p>
          </div>

          <div>
            <label className="block text-sm font-medium text-gray-700 mb-1 flex items-center gap-1.5">
              <UserIcon className="w-4 h-4" />
              Full Name <span className="text-red-500">*</span>
            </label>
            <input
              type="text"
              value={formData.full_name}
              onChange={(e) => setFormData({ ...formData, full_name: e.target.value })}
              className="w-full px-3 py-2 border border-gray-300 rounded-lg focus:ring-2 focus:ring-blue-500 focus:border-blue-500"
              placeholder="John Doe"
              required
            />
          </div>

          <div>
            <label className="block text-sm font-medium text-gray-700 mb-1 flex items-center gap-1.5">
              <UserIcon className="w-4 h-4" />
              Username <span className="text-red-500">*</span>
            </label>
            <input
              type="text"
              value={formData.username}
              onChange={(e) => setFormData({ ...formData, username: e.target.value.toLowerCase().replace(/[^a-z0-9]/g, '') })}
              className="w-full px-3 py-2 border border-gray-300 rounded-lg focus:ring-2 focus:ring-blue-500 focus:border-blue-500 font-mono"
              placeholder="johndoe"
              pattern="[a-z0-9]+"
              required
            />
            <p className="text-xs text-gray-500 mt-1">
              Lowercase letters and numbers only. This will be used to log in.
            </p>
          </div>

          <div>
            <label className="block text-sm font-medium text-gray-700 mb-1 flex items-center gap-1.5">
              <Mail className="w-4 h-4" />
              Email Address <span className="text-red-500">*</span>
            </label>
            <input
              type="email"
              value={formData.email}
              onChange={(e) => setFormData({ ...formData, email: e.target.value })}
              className="w-full px-3 py-2 border border-gray-300 rounded-lg focus:ring-2 focus:ring-blue-500 focus:border-blue-500"
              placeholder="user@company.com"
              required
            />
            <p className="text-xs text-gray-500 mt-1">
              For system notifications only. Login uses username.
            </p>
          </div>

          <div>
            <label className="block text-sm font-medium text-gray-700 mb-1 flex items-center gap-1.5">
              <Lock className="w-4 h-4" />
              Password <span className="text-red-500">*</span>
            </label>
            <input
              type="password"
              value={formData.password}
              onChange={(e) => setFormData({ ...formData, password: e.target.value })}
              className="w-full px-3 py-2 border border-gray-300 rounded-lg focus:ring-2 focus:ring-blue-500 focus:border-blue-500"
              placeholder="Minimum 6 characters"
              minLength={6}
              required
            />
            <p className="text-xs text-gray-500 mt-1">
              Minimum 6 characters. User can change this after logging in.
            </p>
          </div>

          <div>
            <label className="block text-sm font-medium text-gray-700 mb-1 flex items-center gap-1.5">
              <Briefcase className="w-4 h-4" />
              Role <span className="text-red-500">*</span>
            </label>
            <select
              value={formData.role}
              onChange={(e) => setFormData({ ...formData, role: e.target.value as any })}
              className="w-full px-3 py-2 border border-gray-300 rounded-lg focus:ring-2 focus:ring-blue-500 focus:border-blue-500"
              required
            >
              <option value="sales">Sales - CRM, customers, and sales invoices</option>
              <option value="accounts">Accounts - Finance and invoicing</option>
              <option value="warehouse">Warehouse - Inventory management</option>
              <option value="admin">Admin - Full system access</option>
            </select>
            <p className="text-xs text-gray-500 mt-1">
              Role determines which modules the user can access
            </p>
          </div>

          <div className="flex justify-end gap-3 pt-4 border-t">
            <button
              type="button"
              onClick={() => {
                setShowAddModal(false);
                setFormData({
                  username: '',
                  email: '',
                  password: '',
                  full_name: '',
                  role: 'sales',
                });
              }}
              className="px-4 py-2 text-gray-700 bg-gray-100 rounded-lg hover:bg-gray-200 transition"
              disabled={loading}
            >
              Cancel
            </button>
            <button
              type="submit"
              className="px-4 py-2 bg-blue-600 text-white rounded-lg hover:bg-blue-700 transition flex items-center gap-2 disabled:opacity-50 disabled:cursor-not-allowed"
              disabled={loading}
            >
              {loading ? (
                <>
                  <div className="w-4 h-4 border-2 border-white border-t-transparent rounded-full animate-spin" />
                  Creating...
                </>
              ) : (
                <>
                  <UserPlus className="w-4 h-4" />
                  Create User
                </>
              )}
            </button>
          </div>
        </form>
      </Modal>

      {/* Edit User Modal */}
      <Modal
        isOpen={showEditModal}
        onClose={() => {
          setShowEditModal(false);
          setEditingUser(null);
          setFormData({
            username: '',
            email: '',
            password: '',
            full_name: '',
            role: 'sales',
          });
        }}
        title="Edit User"
      >
        <form onSubmit={handleEditUser} className="space-y-4">
          <div className="bg-amber-50 border border-amber-200 rounded-lg p-3 mb-4">
            <p className="text-sm text-amber-800">
              Editing user profile. Email cannot be changed. To reset password, user must use password reset feature.
            </p>
          </div>

          <div>
            <label className="block text-sm font-medium text-gray-700 mb-1 flex items-center gap-1.5">
              <UserIcon className="w-4 h-4" />
              Full Name <span className="text-red-500">*</span>
            </label>
            <input
              type="text"
              value={formData.full_name}
              onChange={(e) => setFormData({ ...formData, full_name: e.target.value })}
              className="w-full px-3 py-2 border border-gray-300 rounded-lg focus:ring-2 focus:ring-blue-500 focus:border-blue-500"
              placeholder="John Doe"
              required
            />
          </div>

          <div>
            <label className="block text-sm font-medium text-gray-700 mb-1 flex items-center gap-1.5">
              <UserIcon className="w-4 h-4" />
              Username <span className="text-red-500">*</span>
            </label>
            <input
              type="text"
              value={formData.username}
              onChange={(e) => setFormData({ ...formData, username: e.target.value.toLowerCase().replace(/[^a-z0-9]/g, '') })}
              className="w-full px-3 py-2 border border-gray-300 rounded-lg focus:ring-2 focus:ring-blue-500 focus:border-blue-500 font-mono"
              placeholder="johndoe"
              pattern="[a-z0-9]+"
              required
            />
            <p className="text-xs text-gray-500 mt-1">
              Lowercase letters and numbers only. This will be used to log in.
            </p>
          </div>

          <div>
            <label className="block text-sm font-medium text-gray-700 mb-1 flex items-center gap-1.5">
              <Mail className="w-4 h-4" />
              Email Address
            </label>
            <input
              type="email"
              value={formData.email}
              className="w-full px-3 py-2 border border-gray-200 rounded-lg bg-gray-50 text-gray-500 cursor-not-allowed"
              disabled
            />
            <p className="text-xs text-gray-500 mt-1">
              Email cannot be changed
            </p>
          </div>

          <div>
            <label className="block text-sm font-medium text-gray-700 mb-1 flex items-center gap-1.5">
              <Briefcase className="w-4 h-4" />
              Role <span className="text-red-500">*</span>
            </label>
            <select
              value={formData.role}
              onChange={(e) => setFormData({ ...formData, role: e.target.value as any })}
              className="w-full px-3 py-2 border border-gray-300 rounded-lg focus:ring-2 focus:ring-blue-500 focus:border-blue-500"
              required
            >
              <option value="sales">Sales - CRM, customers, and sales invoices</option>
              <option value="accounts">Accounts - Finance and invoicing</option>
              <option value="warehouse">Warehouse - Inventory management</option>
              <option value="admin">Admin - Full system access</option>
            </select>
            <p className="text-xs text-gray-500 mt-1">
              Role determines which modules the user can access
            </p>
          </div>

          <div className="flex justify-end gap-3 pt-4 border-t">
            <button
              type="button"
              onClick={() => {
                setShowEditModal(false);
                setEditingUser(null);
                setFormData({
                  username: '',
                  email: '',
                  password: '',
                  full_name: '',
                  role: 'sales',
                });
              }}
              className="px-4 py-2 text-gray-700 bg-gray-100 rounded-lg hover:bg-gray-200 transition"
              disabled={loading}
            >
              Cancel
            </button>
            <button
              type="submit"
              className="px-4 py-2 bg-blue-600 text-white rounded-lg hover:bg-blue-700 transition flex items-center gap-2 disabled:opacity-50 disabled:cursor-not-allowed"
              disabled={loading}
            >
              {loading ? (
                <>
                  <div className="w-4 h-4 border-2 border-white border-t-transparent rounded-full animate-spin" />
                  Saving...
                </>
              ) : (
                <>
                  <Edit2 className="w-4 h-4" />
                  Save Changes
                </>
              )}
            </button>
          </div>
        </form>
      </Modal>
    </div>
  );
}
