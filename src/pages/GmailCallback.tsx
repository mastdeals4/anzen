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

      console.log('[GmailCallback] === CHECKING AUTH ===');
      const { data: { user } } = await supabase.auth.getUser();
      console.log('[GmailCallback] Current user:', user?.id);
      if (!user) {
        console.error('[GmailCallback] No user found!');
        setStatus('error');
        setMessage('User not authenticated');
        setTimeout(() => window.close(), 3000);
        return;
      }

      const redirectUri = `${window.location.origin}/auth/gmail/callback`;

      const { data: { session } } = await supabase.auth.getSession();
      if (!session) {
        throw new Error('User session not found');
      }

      const edgeUrl = `${import.meta.env.VITE_SUPABASE_URL}/functions/v1/gmail-oauth-callback`;
      const edgeResponse = await fetch(edgeUrl, {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${session.access_token}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ code, redirect_uri: redirectUri }),
      });

      const edgeResult = await edgeResponse.json();
      if (!edgeResponse.ok || edgeResult.error) {
        throw new Error(edgeResult.error || 'Failed to connect Gmail');
      }

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
