import { useState } from 'react';
import { supabase } from '../lib/supabase';
import { UserPlus, CheckCircle, XCircle } from 'lucide-react';

interface UserToCreate {
  email: string;
  password: string;
  fullName: string;
  role: 'admin' | 'accounts' | 'sales' | 'warehouse';
}

const usersToCreate: UserToCreate[] = [
  {
    email: 'admin@pharma.com',
    password: 'admin123',
    fullName: 'Admin User',
    role: 'admin',
  },
  {
    email: 'accounts@pharma.com',
    password: 'accounts123',
    fullName: 'Accounts Manager',
    role: 'accounts',
  },
  {
    email: 'sales@pharma.com',
    password: 'sales123',
    fullName: 'Sales Representative',
    role: 'sales',
  },
  {
    email: 'warehouse@pharma.com',
    password: 'warehouse123',
    fullName: 'Warehouse Staff',
    role: 'warehouse',
  },
];

export function Setup() {
  const [creating, setCreating] = useState(false);
  const [results, setResults] = useState<Array<{ email: string; success: boolean; message: string }>>([]);
  const [showInstructions, setShowInstructions] = useState(true);

  const createUsers = async () => {
    setCreating(true);
    setResults([]);
    const newResults: Array<{ email: string; success: boolean; message: string }> = [];

    for (const user of usersToCreate) {
      try {
        const { data: authData, error: authError } = await supabase.auth.signUp({
          email: user.email,
          password: user.password,
        });

        if (authError) {
          newResults.push({
            email: user.email,
            success: false,
            message: `Auth error: ${authError.message}`,
          });
          continue;
        }

        if (!authData.user) {
          newResults.push({
            email: user.email,
            success: false,
            message: 'No user data returned',
          });
          continue;
        }

        const { error: profileError } = await supabase.from('user_profiles').insert({
          id: authData.user.id,
          email: user.email,
          full_name: user.fullName,
          role: user.role,
          language: 'en',
          is_active: true,
        });

        if (profileError) {
          newResults.push({
            email: user.email,
            success: false,
            message: `Profile error: ${profileError.message}`,
          });
          continue;
        }

        newResults.push({
          email: user.email,
          success: true,
          message: `Created successfully (${user.role})`,
        });
      } catch (error: any) {
        newResults.push({
          email: user.email,
          success: false,
          message: `Error: ${error.message}`,
        });
      }

      setResults([...newResults]);
    }

    setCreating(false);
  };

  return (
    <div className="min-h-screen bg-gradient-to-br from-blue-50 to-slate-100 flex items-center justify-center p-4">
      <div className="bg-white rounded-xl shadow-xl w-full max-w-2xl p-8">
        <div className="flex items-center justify-center mb-6">
          <div className="bg-blue-600 p-3 rounded-full">
            <UserPlus className="w-8 h-8 text-white" />
          </div>
        </div>

        <h1 className="text-3xl font-bold text-center text-gray-900 mb-2">
          Database Setup
        </h1>
        <p className="text-gray-600 text-center mb-8">
          Create sample users for your Pharma Trading System
        </p>

        {showInstructions && (
          <div className="bg-blue-50 border border-blue-200 rounded-lg p-4 mb-6">
            <h3 className="font-semibold text-blue-900 mb-2">Important Instructions:</h3>
            <ol className="text-sm text-blue-800 space-y-2 list-decimal list-inside">
              <li>This page will create 4 test users with their profiles</li>
              <li>Make sure your Supabase email confirmation is disabled in your project settings</li>
              <li>If email confirmation is enabled, you'll need to confirm emails manually</li>
              <li>Click the button below to create all users at once</li>
            </ol>
            <button
              onClick={() => setShowInstructions(false)}
              className="mt-3 text-sm text-blue-600 hover:text-blue-700 font-medium"
            >
              Got it, hide this
            </button>
          </div>
        )}

        <div className="mb-6">
          <h3 className="font-semibold text-gray-900 mb-3">Users to create:</h3>
          <div className="space-y-2">
            {usersToCreate.map((user) => (
              <div key={user.email} className="flex items-center justify-between bg-gray-50 p-3 rounded-lg">
                <div>
                  <div className="font-medium text-gray-900">{user.email}</div>
                  <div className="text-sm text-gray-600">
                    Password: {user.password} | Role: {user.role}
                  </div>
                </div>
                <span className={`px-2 py-1 text-xs rounded ${
                  user.role === 'admin' ? 'bg-red-100 text-red-700' :
                  user.role === 'accounts' ? 'bg-green-100 text-green-700' :
                  user.role === 'sales' ? 'bg-blue-100 text-blue-700' :
                  'bg-yellow-100 text-yellow-700'
                }`}>
                  {user.role}
                </span>
              </div>
            ))}
          </div>
        </div>

        <button
          onClick={createUsers}
          disabled={creating}
          className="w-full bg-blue-600 text-white py-3 px-4 rounded-lg hover:bg-blue-700 transition disabled:opacity-50 disabled:cursor-not-allowed font-medium text-lg mb-6"
        >
          {creating ? 'Creating Users...' : 'Create All Users'}
        </button>

        {results.length > 0 && (
          <div className="space-y-2">
            <h3 className="font-semibold text-gray-900 mb-3">Results:</h3>
            {results.map((result, index) => (
              <div
                key={index}
                className={`flex items-start gap-3 p-3 rounded-lg ${
                  result.success ? 'bg-green-50 border border-green-200' : 'bg-red-50 border border-red-200'
                }`}
              >
                {result.success ? (
                  <CheckCircle className="w-5 h-5 text-green-600 flex-shrink-0 mt-0.5" />
                ) : (
                  <XCircle className="w-5 h-5 text-red-600 flex-shrink-0 mt-0.5" />
                )}
                <div className="flex-1">
                  <div className={`font-medium ${result.success ? 'text-green-900' : 'text-red-900'}`}>
                    {result.email}
                  </div>
                  <div className={`text-sm ${result.success ? 'text-green-700' : 'text-red-700'}`}>
                    {result.message}
                  </div>
                </div>
              </div>
            ))}
          </div>
        )}

        {results.length > 0 && results.every(r => r.success) && (
          <div className="mt-6 bg-green-50 border border-green-200 rounded-lg p-4">
            <h3 className="font-semibold text-green-900 mb-2">Success!</h3>
            <p className="text-sm text-green-800 mb-3">
              All users created successfully. You can now navigate to the login page and use any of these credentials:
            </p>
            <div className="text-sm text-green-800 space-y-1">
              {usersToCreate.map(u => (
                <div key={u.email}>• {u.email} / {u.password}</div>
              ))}
            </div>
            <button
              onClick={() => window.location.href = '/'}
              className="mt-4 w-full bg-green-600 text-white py-2 px-4 rounded-lg hover:bg-green-700 transition font-medium"
            >
              Go to Login
            </button>
          </div>
        )}

        {results.length > 0 && results.some(r => !r.success) && (
          <div className="mt-6 bg-yellow-50 border border-yellow-200 rounded-lg p-4">
            <h3 className="font-semibold text-yellow-900 mb-2">Partial Success</h3>
            <p className="text-sm text-yellow-800 mb-2">
              Some users failed to create. This is usually because:
            </p>
            <ul className="text-sm text-yellow-800 list-disc list-inside space-y-1">
              <li>The email already exists</li>
              <li>Email confirmation is required (check Supabase Auth settings)</li>
              <li>RLS policies prevented profile creation</li>
            </ul>
            <p className="text-sm text-yellow-800 mt-3">
              See CREATE_USERS.md for manual setup instructions.
            </p>
          </div>
        )}
      </div>
    </div>
  );
}
