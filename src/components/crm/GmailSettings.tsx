import { useEffect, useState } from 'react';
import { supabase } from '../../lib/supabase';
import { Mail, CheckCircle, AlertCircle, RefreshCw, LogOut, Settings as SettingsIcon } from 'lucide-react';

interface GmailConnection {
  id: string;
  user_id: string;
  email_address: string;
  is_connected: boolean;
  last_sync: string | null;
  sync_enabled: boolean;
  access_token_expires_at: string | null;
}

export function GmailSettings() {
  const [connection, setConnection] = useState<GmailConnection | null>(null);
  const [loading, setLoading] = useState(true);
  const [syncing, setSyncing] = useState(false);

  useEffect(() => {
    loadConnection();

    const interval = setInterval(() => {
      loadConnection();
    }, 5000);

    return () => clearInterval(interval);
  }, []);

  const loadConnection = async () => {
    try {
      const { data: { user } } = await supabase.auth.getUser();
      if (!user) return;

      const { data, error } = await supabase
        .from('gmail_connections')
        .select('*')
        .eq('user_id', user.id)
        .maybeSingle();

      if (error && error.code !== 'PGRST116') throw error;
      setConnection(data);
    } catch (error) {
      console.error('Error loading Gmail connection:', error);
    } finally {
      setLoading(false);
    }
  };

  const handleConnectGmail = () => {
    const clientId = import.meta.env.VITE_GOOGLE_CLIENT_ID;
    const redirectUri = `${window.location.origin}/auth/gmail/callback`;

    if (!clientId) {
      alert('Gmail integration is not configured. Please add VITE_GOOGLE_CLIENT_ID to your .env file.\n\nSteps:\n1. Go to Google Cloud Console\n2. Create OAuth 2.0 credentials\n3. Add the Client ID to .env file\n4. Restart the dev server\n\nSee GMAIL_SETUP.md for detailed instructions.');
      return;
    }

    // Show user the redirect URI they need to configure
    console.log('🔑 Gmail OAuth Configuration:');
    console.log('Redirect URI:', redirectUri);
    console.log('\n📋 Add this to Google Cloud Console:');
    console.log('   https://console.cloud.google.com/apis/credentials');

    const confirmed = confirm(
      `⚠️ IMPORTANT: Before connecting Gmail\n\n` +
      `You must add this redirect URI to Google Cloud Console:\n\n` +
      `${redirectUri}\n\n` +
      `Steps:\n` +
      `1. Go to: https://console.cloud.google.com/apis/credentials\n` +
      `2. Click your OAuth Client ID\n` +
      `3. Under "Authorized redirect URIs", add:\n   ${redirectUri}\n` +
      `4. Click "Save"\n` +
      `5. Wait 5 minutes for changes to propagate\n\n` +
      `Have you completed these steps?`
    );

    if (!confirmed) {
      return;
    }

    const scope = [
      'https://www.googleapis.com/auth/gmail.readonly',
      'https://www.googleapis.com/auth/gmail.modify',
      'https://www.googleapis.com/auth/gmail.send',
      'https://www.googleapis.com/auth/userinfo.email',
      'https://www.googleapis.com/auth/userinfo.profile',
    ].join(' ');

    const authUrl = `https://accounts.google.com/o/oauth2/v2/auth?` +
      `client_id=${clientId}` +
      `&redirect_uri=${encodeURIComponent(redirectUri)}` +
      `&response_type=code` +
      `&scope=${encodeURIComponent(scope)}` +
      `&access_type=offline` +
      `&prompt=consent`;

    const width = 600;
    const height = 700;
    const left = window.screenX + (window.outerWidth - width) / 2;
    const top = window.screenY + (window.outerHeight - height) / 2;

    window.open(
      authUrl,
      'Gmail OAuth',
      `width=${width},height=${height},left=${left},top=${top},toolbar=no,menubar=no`
    );
  };

  const handleDisconnect = async () => {
    if (!confirm('Are you sure you want to disconnect your Gmail account? Email syncing will stop.')) {
      return;
    }

    try {
      const { data: { user } } = await supabase.auth.getUser();
      if (!user) return;

      const { error } = await supabase
        .from('gmail_connections')
        .update({
          is_connected: false,
          sync_enabled: false,
          access_token: null,
          refresh_token: null,
        })
        .eq('user_id', user.id);

      if (error) throw error;

      alert('Gmail account disconnected successfully');
      loadConnection();
    } catch (error) {
      console.error('Error disconnecting Gmail:', error);
      alert('Failed to disconnect Gmail account');
    }
  };

  const handleToggleSync = async () => {
    if (!connection) return;

    try {
      const { error } = await supabase
        .from('gmail_connections')
        .update({
          sync_enabled: !connection.sync_enabled,
        })
        .eq('id', connection.id);

      if (error) throw error;

      loadConnection();
    } catch (error) {
      console.error('Error toggling sync:', error);
      alert('Failed to update sync settings');
    }
  };

  const handleManualSync = async () => {
    if (syncing) return;

    setSyncing(true);

    // Show immediate feedback
    const notification = {
      title: 'Email Sync Started',
      message: 'Syncing emails in background. You can continue using the app.',
    };
    console.log(notification);

    try {
      const { data: { session } } = await supabase.auth.getSession();
      if (!session) {
        alert('Please sign in to sync emails');
        setSyncing(false);
        return;
      }

      const apiUrl = `${import.meta.env.VITE_SUPABASE_URL}/functions/v1/sync-gmail-emails`;

      // Use timeout to prevent hanging
      const controller = new AbortController();
      const timeoutId = setTimeout(() => controller.abort(), 120000); // 2 min timeout

      const response = await fetch(apiUrl, {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${session.access_token}`,
          'Content-Type': 'application/json',
        },
        signal: controller.signal,
      });

      clearTimeout(timeoutId);

      if (!response.ok) {
        const errorText = await response.text();
        throw new Error(`Server error (${response.status}): ${errorText}`);
      }

      const result = await response.json();

      if (result.success) {
        alert(`Email sync completed!\n\n✓ Total messages found: ${result.totalMessages}\n✓ New emails processed: ${result.processedCount}\n✓ New inquiries: ${result.newInquiriesCount}`);
        loadConnection();
      } else {
        throw new Error(result.error || 'Sync failed');
      }
    } catch (error) {
      console.error('Error syncing emails:', error);
      if (error instanceof Error && error.name === 'AbortError') {
        alert('Sync is taking longer than expected. It will continue in the background. Check back in a few minutes.');
      } else {
        alert(`Failed to sync emails: ${error instanceof Error ? error.message : 'Unknown error'}`);
      }
    } finally {
      setSyncing(false);
    }
  };

  if (loading) {
    return (
      <div className="flex justify-center items-center py-12">
        <div className="animate-spin rounded-full h-8 w-8 border-b-2 border-blue-600" />
      </div>
    );
  }

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-2">
          <SettingsIcon className="w-5 h-5 text-blue-600" />
          <h3 className="text-lg font-semibold">Gmail Integration</h3>
        </div>

        {connection?.is_connected ? (
          <div className="flex items-center gap-2 px-4 py-2 bg-green-50 border border-green-200 rounded-lg">
            <div className="w-2 h-2 bg-green-500 rounded-full animate-pulse" />
            <span className="text-sm font-medium text-green-700">Connected</span>
          </div>
        ) : (
          <div className="flex items-center gap-2 px-4 py-2 bg-gray-100 border border-gray-300 rounded-lg">
            <div className="w-2 h-2 bg-gray-400 rounded-full" />
            <span className="text-sm font-medium text-gray-600">Not Connected</span>
          </div>
        )}
      </div>

      {!connection?.is_connected ? (
        <div className="bg-white rounded-lg shadow p-6 space-y-4">
          <div className="flex items-start gap-4">
            <div className="p-3 bg-blue-50 rounded-lg">
              <Mail className="w-8 h-8 text-blue-600" />
            </div>
            <div className="flex-1">
              <h4 className="font-semibold text-gray-900 mb-2">Connect Your Gmail Account</h4>
              <p className="text-sm text-gray-600 mb-4">
                Securely connect your Gmail account to automatically fetch pharmaceutical inquiry emails.
                Your password is never stored - we use Google's OAuth2 for maximum security.
              </p>

              <div className="bg-blue-50 border border-blue-200 rounded-lg p-4 mb-4">
                <p className="text-sm font-medium text-blue-900 mb-2">What you'll get:</p>
                <ul className="text-sm text-blue-800 space-y-1">
                  <li>• Automatic email fetching every 10 minutes</li>
                  <li>• AI-powered inquiry extraction from emails</li>
                  <li>• Send emails directly from CRM</li>
                  <li>• Complete email activity tracking</li>
                </ul>
              </div>

              <button
                onClick={handleConnectGmail}
                className="flex items-center gap-2 bg-blue-600 text-white px-6 py-3 rounded-lg hover:bg-blue-700 transition font-medium"
              >
                <Mail className="w-5 h-5" />
                Connect Gmail Account
              </button>

              <p className="text-xs text-gray-500 mt-3">
                By connecting, you authorize this app to read and send emails on your behalf.
                You can revoke access anytime from your <a href="https://myaccount.google.com/permissions" target="_blank" rel="noopener noreferrer" className="text-blue-600 hover:underline">Google Account settings</a>.
              </p>
            </div>
          </div>
        </div>
      ) : (
        <div className="space-y-4">
          <div className="bg-white rounded-lg shadow p-6">
            <div className="flex items-start justify-between">
              <div className="flex items-start gap-4 flex-1">
                <div className="p-3 bg-green-50 rounded-lg">
                  <CheckCircle className="w-8 h-8 text-green-600" />
                </div>
                <div className="flex-1">
                  <h4 className="font-semibold text-gray-900 mb-1">Gmail Connected</h4>
                  <p className="text-sm text-gray-600 mb-3">
                    {connection.email_address}
                  </p>

                  {connection.last_sync && (
                    <p className="text-xs text-gray-500">
                      Last synced: {new Date(connection.last_sync).toLocaleString()}
                    </p>
                  )}

                  {connection.access_token_expires_at && (
                    <p className="text-xs text-gray-500">
                      Token expires: {new Date(connection.access_token_expires_at).toLocaleString()}
                    </p>
                  )}
                </div>
              </div>

              <button
                onClick={handleDisconnect}
                className="flex items-center gap-2 px-4 py-2 text-sm text-red-600 hover:bg-red-50 rounded-lg transition"
              >
                <LogOut className="w-4 h-4" />
                Disconnect
              </button>
            </div>
          </div>

          <div className="bg-white rounded-lg shadow p-6 space-y-4">
            <h4 className="font-semibold text-gray-900">Sync Settings</h4>

            <div className="flex items-center justify-between">
              <div>
                <p className="text-sm font-medium text-gray-900">Automatic Email Sync</p>
                <p className="text-xs text-gray-500">Fetch new emails every 10 minutes</p>
              </div>
              <label className="relative inline-flex items-center cursor-pointer">
                <input
                  type="checkbox"
                  checked={connection.sync_enabled}
                  onChange={handleToggleSync}
                  className="sr-only peer"
                />
                <div className="w-11 h-6 bg-gray-200 peer-focus:outline-none peer-focus:ring-4 peer-focus:ring-blue-300 rounded-full peer peer-checked:after:translate-x-full peer-checked:after:border-white after:content-[''] after:absolute after:top-[2px] after:left-[2px] after:bg-white after:border-gray-300 after:border after:rounded-full after:h-5 after:w-5 after:transition-all peer-checked:bg-blue-600"></div>
              </label>
            </div>

            <div className="pt-4 border-t">
              <button
                onClick={handleManualSync}
                disabled={syncing}
                className="flex items-center gap-2 px-4 py-2 bg-gray-100 hover:bg-gray-200 rounded-lg transition text-sm font-medium disabled:opacity-50"
              >
                <RefreshCw className={`w-4 h-4 ${syncing ? 'animate-spin' : ''}`} />
                {syncing ? 'Syncing...' : 'Sync Now'}
              </button>
            </div>
          </div>

          <div className="bg-yellow-50 border border-yellow-200 rounded-lg p-4">
            <div className="flex items-start gap-3">
              <AlertCircle className="w-5 h-5 text-yellow-600 flex-shrink-0 mt-0.5" />
              <div className="text-sm text-yellow-800">
                <p className="font-medium mb-1">Important Security Information</p>
                <ul className="space-y-1 text-xs">
                  <li>• Your Gmail password is never stored or accessed by this app</li>
                  <li>• Access tokens are encrypted in the database</li>
                  <li>• You can revoke access anytime from Google Account settings</li>
                  <li>• Only emails marked as inquiry-related are processed</li>
                </ul>
              </div>
            </div>
          </div>
        </div>
      )}

      {!import.meta.env.VITE_GOOGLE_CLIENT_ID && (
        <div className="bg-red-50 border border-red-200 rounded-lg p-4">
          <div className="flex items-start gap-3">
            <AlertCircle className="w-5 h-5 text-red-600 flex-shrink-0 mt-0.5" />
            <div className="text-sm text-red-800">
              <p className="font-medium mb-1">Gmail Integration Not Configured</p>
              <p>
                Gmail OAuth2 credentials are not set up. Please contact your administrator to configure
                the VITE_GOOGLE_CLIENT_ID environment variable. Refer to GMAIL_SETUP.md for setup instructions.
              </p>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
