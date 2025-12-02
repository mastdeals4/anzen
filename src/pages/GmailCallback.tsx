import { useEffect, useState } from 'react';
import { CheckCircle, XCircle, Loader } from 'lucide-react';
import { supabase } from '../lib/supabase';

export function GmailCallback() {
  const [status, setStatus] = useState<'loading' | 'success' | 'error'>('loading');
  const [message, setMessage] = useState('Processing Gmail connection...');

  useEffect(() => {
    handleCallback();
  }, []);

  const handleCallback = async () => {
    try {
      console.log('Starting Gmail OAuth callback...');
      const urlParams = new URLSearchParams(window.location.search);
      const code = urlParams.get('code');
      const error = urlParams.get('error');

      console.log('Callback params:', { hasCode: !!code, error });

      if (error) {
        setStatus('error');
        setMessage(`Authorization failed: ${error}`);
        setTimeout(() => window.close(), 3000);
        return;
      }

      if (!code) {
        setStatus('error');
        setMessage('No authorization code received');
        setTimeout(() => window.close(), 3000);
        return;
      }

      const { data: { user } } = await supabase.auth.getUser();
      if (!user) {
        setStatus('error');
        setMessage('User not authenticated');
        setTimeout(() => window.close(), 3000);
        return;
      }

      const clientId = import.meta.env.VITE_GOOGLE_CLIENT_ID;
      const clientSecret = import.meta.env.VITE_GOOGLE_CLIENT_SECRET;
      const redirectUri = `${window.location.origin}/auth/gmail/callback`;

      console.log('OAuth config:', {
        hasClientId: !!clientId,
        hasClientSecret: !!clientSecret,
        redirectUri
      });

      if (!clientId || !clientSecret) {
        throw new Error('Google OAuth credentials not configured. Please check your .env file.');
      }

      console.log('Exchanging code for token...');

      const tokenResponse = await fetch('https://oauth2.googleapis.com/token', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/x-www-form-urlencoded',
        },
        body: new URLSearchParams({
          code,
          client_id: clientId,
          client_secret: clientSecret,
          redirect_uri: redirectUri,
          grant_type: 'authorization_code',
        }),
      });

      if (!tokenResponse.ok) {
        const errorData = await tokenResponse.text();
        console.error('Token exchange failed:', errorData);
        throw new Error(`Token exchange failed: ${errorData}`);
      }

      const tokenData = await tokenResponse.json();
      console.log('Token received, fetching profile...');

      const profileResponse = await fetch('https://www.googleapis.com/oauth2/v2/userinfo', {
        headers: {
          'Authorization': `Bearer ${tokenData.access_token}`,
        },
      });

      if (!profileResponse.ok) {
        const errorText = await profileResponse.text();
        console.error('Profile fetch failed:', {
          status: profileResponse.status,
          statusText: profileResponse.statusText,
          body: errorText
        });
        throw new Error(`Failed to fetch Gmail profile (${profileResponse.status}): ${errorText}`);
      }

      const profileData = await profileResponse.json();
      console.log('Profile fetched:', profileData.email);

      const expiresAt = new Date();
      expiresAt.setSeconds(expiresAt.getSeconds() + tokenData.expires_in);

      const { error: dbError } = await supabase
        .from('gmail_connections')
        .upsert({
          user_id: user.id,
          email_address: profileData.email,
          access_token: tokenData.access_token,
          refresh_token: tokenData.refresh_token,
          access_token_expires_at: expiresAt.toISOString(),
          is_connected: true,
          sync_enabled: true,
          last_sync: null,
        }, {
          onConflict: 'user_id,email_address'
        });

      if (dbError) {
        console.error('Database error:', dbError);
        throw dbError;
      }

      console.log('Gmail connection saved to database');

      setStatus('success');
      setMessage('Gmail connected successfully! You can close this window.');

      setTimeout(() => {
        if (window.opener) {
          window.opener.location.reload();
        }
        window.close();
      }, 2000);

    } catch (error) {
      console.error('Callback error:', error);
      setStatus('error');
      setMessage(error instanceof Error ? error.message : 'Failed to connect Gmail');
      setTimeout(() => window.close(), 5000);
    }
  };

  return (
    <div className="min-h-screen bg-gray-50 flex items-center justify-center p-4">
      <div className="bg-white rounded-lg shadow-lg p-8 max-w-md w-full text-center">
        {status === 'loading' && (
          <>
            <Loader className="w-16 h-16 text-blue-600 mx-auto mb-4 animate-spin" />
            <h2 className="text-xl font-semibold text-gray-900 mb-2">
              Connecting Gmail...
            </h2>
            <p className="text-gray-600">{message}</p>
          </>
        )}

        {status === 'success' && (
          <>
            <CheckCircle className="w-16 h-16 text-green-600 mx-auto mb-4" />
            <h2 className="text-xl font-semibold text-gray-900 mb-2">
              Success!
            </h2>
            <p className="text-gray-600">{message}</p>
          </>
        )}

        {status === 'error' && (
          <>
            <XCircle className="w-16 h-16 text-red-600 mx-auto mb-4" />
            <h2 className="text-xl font-semibold text-gray-900 mb-2">
              Connection Failed
            </h2>
            <p className="text-gray-600">{message}</p>
            <button
              onClick={() => window.close()}
              className="mt-4 px-4 py-2 bg-gray-200 hover:bg-gray-300 rounded-lg transition"
            >
              Close Window
            </button>
          </>
        )}
      </div>
    </div>
  );
}
