import { showToast } from '../ToastNotification';

export function openGmailReconnectPopup(): boolean {
  const clientId = import.meta.env.VITE_GOOGLE_CLIENT_ID;
  const redirectUri = `${window.location.origin}/auth/gmail/callback`;

  if (!clientId) {
    showToast({
      type: 'error',
      title: 'Gmail Not Configured',
      message: 'Missing VITE_GOOGLE_CLIENT_ID. Please configure Gmail OAuth and try again.',
    });
    return false;
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

  showToast({
    type: 'warning',
    title: 'Reconnect Gmail',
    message: 'Complete Gmail sign-in in the popup, then retry sending your email.',
  });

  return true;
}
