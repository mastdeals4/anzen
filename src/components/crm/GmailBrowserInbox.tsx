import { useState, useEffect } from 'react';
import { supabase } from '../../lib/supabase';
import DOMPurify from 'dompurify';
import {
  Inbox, Send, Star, Mail, Trash, Archive, RefreshCw,
  Search, ChevronRight, Loader, AlertCircle, CheckCircle
} from 'lucide-react';

interface GmailConnection {
  id: string;
  email: string;
  access_token: string;
  refresh_token: string;
  access_token_expires_at: string;
  is_connected: boolean;
}

interface GmailMessage {
  id: string;
  threadId: string;
  snippet: string;
  internalDate: string;
  labelIds: string[];
  payload: {
    headers: Array<{ name: string; value: string }>;
    body?: { data?: string };
    parts?: any[];
  };
}

interface EmailListItem {
  id: string;
  threadId: string;
  subject: string;
  from: string;
  fromEmail: string;
  snippet: string;
  body?: string;
  date: Date;
  isUnread: boolean;
  isStarred: boolean;
  labels: string[];
}

type FolderType = 'INBOX' | 'SENT' | 'STARRED' | 'ALL' | 'TRASH' | 'DRAFT';

export function GmailBrowserInbox() {
  const [connection, setConnection] = useState<GmailConnection | null>(null);
  const [loading, setLoading] = useState(true);
  const [loadingEmails, setLoadingEmails] = useState(false);
  const [emails, setEmails] = useState<EmailListItem[]>([]);
  const [selectedEmail, setSelectedEmail] = useState<EmailListItem | null>(null);
  const [selectedFolder, setSelectedFolder] = useState<FolderType>('INBOX');
  const [searchQuery, setSearchQuery] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [nextPageToken, setNextPageToken] = useState<string | null>(null);
  const [loadingEmailBody, setLoadingEmailBody] = useState(false);

  useEffect(() => {
    loadGmailConnection();
  }, []);

  useEffect(() => {
    if (connection) {
      loadEmails();
    }
  }, [connection, selectedFolder]);

  const loadGmailConnection = async () => {
    try {
      const { data: { user } } = await supabase.auth.getUser();
      if (!user) {
        setError('Not authenticated');
        setLoading(false);
        return;
      }

      const { data, error } = await supabase
        .from('gmail_connections')
        .select('*')
        .eq('user_id', user.id)
        .eq('is_connected', true)
        .maybeSingle();

      if (error) throw error;

      if (!data) {
        setError('No Gmail account connected. Please connect your Gmail account in Settings.');
        setLoading(false);
        return;
      }

      setConnection(data);
    } catch (err) {
      console.error('Error loading Gmail connection:', err);
      setError('Failed to load Gmail connection');
    } finally {
      setLoading(false);
    }
  };

  const refreshAccessToken = async (conn: GmailConnection): Promise<string> => {
    const tokenExpiry = new Date(conn.access_token_expires_at);

    if (tokenExpiry > new Date()) {
      return conn.access_token;
    }

    const response = await fetch('https://oauth2.googleapis.com/token', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        client_id: import.meta.env.VITE_GOOGLE_CLIENT_ID,
        client_secret: import.meta.env.VITE_GOOGLE_CLIENT_SECRET,
        refresh_token: conn.refresh_token,
        grant_type: 'refresh_token',
      }),
    });

    if (!response.ok) {
      throw new Error('Failed to refresh token');
    }

    const data = await response.json();
    const newAccessToken = data.access_token;
    const expiresAt = new Date(Date.now() + data.expires_in * 1000).toISOString();

    await supabase
      .from('gmail_connections')
      .update({
        access_token: newAccessToken,
        access_token_expires_at: expiresAt,
      })
      .eq('id', conn.id);

    setConnection({ ...conn, access_token: newAccessToken, access_token_expires_at: expiresAt });

    return newAccessToken;
  };

  const getQueryForFolder = (folder: FolderType): string => {
    switch (folder) {
      case 'INBOX':
        return 'in:inbox';
      case 'SENT':
        return 'in:sent';
      case 'STARRED':
        return 'is:starred';
      case 'TRASH':
        return 'in:trash';
      case 'DRAFT':
        return 'in:drafts';
      case 'ALL':
        return 'in:anywhere';
      default:
        return 'in:inbox';
    }
  };

  const loadEmails = async (pageToken?: string) => {
    if (!connection) return;

    setLoadingEmails(true);
    setError(null);

    try {
      const accessToken = await refreshAccessToken(connection);
      const query = getQueryForFolder(selectedFolder);
      const maxResults = 50;

      let url = `https://gmail.googleapis.com/gmail/v1/users/me/messages?maxResults=${maxResults}&q=${encodeURIComponent(query)}`;
      if (pageToken) {
        url += `&pageToken=${pageToken}`;
      }

      const response = await fetch(url, {
        headers: { 'Authorization': `Bearer ${accessToken}` },
      });

      if (!response.ok) {
        throw new Error('Failed to fetch emails from Gmail');
      }

      const data = await response.json();
      const messageList = data.messages || [];
      setNextPageToken(data.nextPageToken || null);

      const emailPromises = messageList.map(async (msg: { id: string }) => {
        const msgResponse = await fetch(
          `https://gmail.googleapis.com/gmail/v1/users/me/messages/${msg.id}?format=full`,
          {
            headers: { 'Authorization': `Bearer ${accessToken}` },
          }
        );

        if (!msgResponse.ok) return null;

        const msgData: GmailMessage = await msgResponse.json();
        return parseEmailFromGmail(msgData);
      });

      const parsedEmails = await Promise.all(emailPromises);
      const validEmails = parsedEmails.filter((e): e is EmailListItem => e !== null);

      setEmails(pageToken ? [...emails, ...validEmails] : validEmails);
    } catch (err) {
      console.error('Error loading emails:', err);
      setError('Failed to load emails from Gmail');
    } finally {
      setLoadingEmails(false);
    }
  };

  const parseEmailFromGmail = (msg: GmailMessage): EmailListItem | null => {
    try {
      const headers = msg.payload.headers;
      const subject = getHeader(headers, 'subject') || '(No Subject)';
      const from = getHeader(headers, 'from') || '';
      const fromEmail = from.match(/<(.+?)>/)?.[1] || from;
      const fromName = from.replace(/<.+?>/, '').trim() || fromEmail;
      const date = new Date(parseInt(msg.internalDate));
      const isUnread = msg.labelIds?.includes('UNREAD') || false;
      const isStarred = msg.labelIds?.includes('STARRED') || false;

      return {
        id: msg.id,
        threadId: msg.threadId,
        subject,
        from: fromName,
        fromEmail,
        snippet: msg.snippet || '',
        date,
        isUnread,
        isStarred,
        labels: msg.labelIds || [],
      };
    } catch (err) {
      console.error('Error parsing email:', err);
      return null;
    }
  };

  const getHeader = (headers: Array<{ name: string; value: string }>, name: string): string => {
    const header = headers.find(h => h.name.toLowerCase() === name.toLowerCase());
    return header?.value || '';
  };

  const getEmailBody = (payload: any): string => {
    let body = '';

    const decodeBody = (data: string): string => {
      try {
        const base64 = data.replace(/-/g, '+').replace(/_/g, '/');
        const binaryString = atob(base64);
        const bytes = new Uint8Array(binaryString.length);
        for (let i = 0; i < binaryString.length; i++) {
          bytes[i] = binaryString.charCodeAt(i);
        }
        return new TextDecoder('utf-8').decode(bytes);
      } catch (e) {
        try {
          return atob(data.replace(/-/g, '+').replace(/_/g, '/'));
        } catch (e2) {
          return data;
        }
      }
    };

    if (payload.body?.data) {
      body = decodeBody(payload.body.data);
    } else if (payload.parts) {
      for (const part of payload.parts) {
        if (part.mimeType === 'text/html' && part.body?.data) {
          body = decodeBody(part.body.data);
          break;
        } else if (part.mimeType === 'text/plain' && part.body?.data && !body) {
          body = decodeBody(part.body.data);
        } else if (part.parts) {
          const nestedBody = getEmailBody(part);
          if (nestedBody) {
            body = nestedBody;
            if (part.mimeType === 'text/html') break;
          }
        }
      }
    }

    return body;
  };

  const handleEmailClick = async (email: EmailListItem) => {
    setSelectedEmail(email);
    if (email.isUnread) {
      markAsRead(email.id);
    }

    if (!email.body && connection) {
      setLoadingEmailBody(true);
      try {
        const accessToken = await refreshAccessToken(connection);
        const msgResponse = await fetch(
          `https://gmail.googleapis.com/gmail/v1/users/me/messages/${email.id}?format=full`,
          {
            headers: { 'Authorization': `Bearer ${accessToken}` },
          }
        );

        if (msgResponse.ok) {
          const msgData: GmailMessage = await msgResponse.json();
          const body = getEmailBody(msgData.payload);
          const updatedEmail = { ...email, body };
          setSelectedEmail(updatedEmail);
          setEmails(emails.map(e => e.id === email.id ? updatedEmail : e));
        }
      } catch (err) {
        console.error('Error loading email body:', err);
      } finally {
        setLoadingEmailBody(false);
      }
    }
  };

  const markAsRead = async (messageId: string) => {
    if (!connection) return;

    try {
      const accessToken = await refreshAccessToken(connection);

      await fetch(
        `https://gmail.googleapis.com/gmail/v1/users/me/messages/${messageId}/modify`,
        {
          method: 'POST',
          headers: {
            'Authorization': `Bearer ${accessToken}`,
            'Content-Type': 'application/json',
          },
          body: JSON.stringify({
            removeLabelIds: ['UNREAD'],
          }),
        }
      );

      setEmails(emails.map(e => e.id === messageId ? { ...e, isUnread: false } : e));
      if (selectedEmail?.id === messageId) {
        setSelectedEmail({ ...selectedEmail, isUnread: false });
      }
    } catch (err) {
      console.error('Error marking as read:', err);
    }
  };

  const toggleStar = async (messageId: string, isStarred: boolean) => {
    if (!connection) return;

    try {
      const accessToken = await refreshAccessToken(connection);

      await fetch(
        `https://gmail.googleapis.com/gmail/v1/users/me/messages/${messageId}/modify`,
        {
          method: 'POST',
          headers: {
            'Authorization': `Bearer ${accessToken}`,
            'Content-Type': 'application/json',
          },
          body: JSON.stringify({
            addLabelIds: isStarred ? [] : ['STARRED'],
            removeLabelIds: isStarred ? ['STARRED'] : [],
          }),
        }
      );

      setEmails(emails.map(e => e.id === messageId ? { ...e, isStarred: !isStarred } : e));
      if (selectedEmail?.id === messageId) {
        setSelectedEmail({ ...selectedEmail, isStarred: !isStarred });
      }
    } catch (err) {
      console.error('Error toggling star:', err);
    }
  };

  const formatDate = (date: Date): string => {
    const now = new Date();
    const diff = now.getTime() - date.getTime();
    const dayDiff = Math.floor(diff / (1000 * 60 * 60 * 24));

    if (dayDiff === 0) {
      return date.toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit', hour12: true });
    } else if (dayDiff < 7) {
      return date.toLocaleDateString('en-US', { weekday: 'short' });
    } else {
      return date.toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
    }
  };

  if (loading) {
    return (
      <div className="flex items-center justify-center h-64">
        <Loader className="w-6 h-6 animate-spin text-blue-500" />
      </div>
    );
  }

  if (error) {
    return (
      <div className="flex items-center justify-center min-h-[400px]">
        <div className="text-center max-w-md px-6">
          <AlertCircle className="w-16 h-16 text-amber-500 mx-auto mb-4" />
          <p className="text-lg font-semibold text-gray-900 mb-2">Gmail Not Connected</p>
          <p className="text-sm text-gray-600 mb-4">{error}</p>
          <div className="bg-blue-50 border border-blue-200 rounded-lg p-4 text-left">
            <p className="text-sm font-medium text-blue-900 mb-2">To connect Gmail:</p>
            <ol className="text-sm text-blue-800 space-y-1 list-decimal list-inside">
              <li>Go to Settings page</li>
              <li>Navigate to Gmail Settings section</li>
              <li>Click "Connect Gmail Account"</li>
              <li>Authorize access to your Gmail account</li>
            </ol>
          </div>
          <button
            onClick={() => window.location.reload()}
            className="mt-4 px-4 py-2 text-sm font-medium text-white bg-blue-600 rounded-md hover:bg-blue-700 transition"
          >
            Refresh Page
          </button>
        </div>
      </div>
    );
  }

  return (
    <div className="flex h-[calc(100vh-16rem)] bg-white rounded-lg border border-gray-200 overflow-hidden">
      {/* Left Sidebar - Folders (10%) */}
      <div className="w-[10%] min-w-[140px] border-r border-gray-200 flex flex-col bg-gray-50">
        <div className="p-3 border-b border-gray-200">
          <h3 className="text-xs font-semibold text-gray-700 uppercase tracking-wider">Folders</h3>
        </div>
        <div className="flex-1 overflow-y-auto py-1">
          <button
            onClick={() => setSelectedFolder('INBOX')}
            className={`w-full flex items-center gap-2 px-3 py-2 text-xs transition ${
              selectedFolder === 'INBOX'
                ? 'bg-blue-100 text-blue-700 font-semibold'
                : 'text-gray-700 hover:bg-gray-100'
            }`}
          >
            <Inbox className="w-3.5 h-3.5" />
            <span>Inbox</span>
          </button>
          <button
            onClick={() => setSelectedFolder('STARRED')}
            className={`w-full flex items-center gap-2 px-3 py-2 text-xs transition ${
              selectedFolder === 'STARRED'
                ? 'bg-blue-100 text-blue-700 font-semibold'
                : 'text-gray-700 hover:bg-gray-100'
            }`}
          >
            <Star className="w-3.5 h-3.5" />
            <span>Starred</span>
          </button>
          <button
            onClick={() => setSelectedFolder('SENT')}
            className={`w-full flex items-center gap-2 px-3 py-2 text-xs transition ${
              selectedFolder === 'SENT'
                ? 'bg-blue-100 text-blue-700 font-semibold'
                : 'text-gray-700 hover:bg-gray-100'
            }`}
          >
            <Send className="w-3.5 h-3.5" />
            <span>Sent</span>
          </button>
          <button
            onClick={() => setSelectedFolder('DRAFT')}
            className={`w-full flex items-center gap-2 px-3 py-2 text-xs transition ${
              selectedFolder === 'DRAFT'
                ? 'bg-blue-100 text-blue-700 font-semibold'
                : 'text-gray-700 hover:bg-gray-100'
            }`}
          >
            <Mail className="w-3.5 h-3.5" />
            <span>Drafts</span>
          </button>
          <button
            onClick={() => setSelectedFolder('ALL')}
            className={`w-full flex items-center gap-2 px-3 py-2 text-xs transition ${
              selectedFolder === 'ALL'
                ? 'bg-blue-100 text-blue-700 font-semibold'
                : 'text-gray-700 hover:bg-gray-100'
            }`}
          >
            <Archive className="w-3.5 h-3.5" />
            <span>All Mail</span>
          </button>
          <button
            onClick={() => setSelectedFolder('TRASH')}
            className={`w-full flex items-center gap-2 px-3 py-2 text-xs transition ${
              selectedFolder === 'TRASH'
                ? 'bg-blue-100 text-blue-700 font-semibold'
                : 'text-gray-700 hover:bg-gray-100'
            }`}
          >
            <Trash className="w-3.5 h-3.5" />
            <span>Trash</span>
          </button>
        </div>
        <div className="p-2 border-t border-gray-200">
          <button
            onClick={() => loadEmails()}
            disabled={loadingEmails}
            className="w-full flex items-center justify-center gap-1.5 px-2 py-1.5 text-xs font-medium text-gray-700 bg-white border border-gray-300 rounded hover:bg-gray-50 transition disabled:opacity-50"
          >
            <RefreshCw className={`w-3 h-3 ${loadingEmails ? 'animate-spin' : ''}`} />
            Refresh
          </button>
        </div>
      </div>

      {/* Middle Panel - Email List (30%) */}
      <div className="w-[30%] min-w-[320px] flex flex-col border-r border-gray-200 bg-white">
        <div className="p-3 border-b border-gray-200 bg-gray-50">
          <div className="relative">
            <Search className="absolute left-2.5 top-1/2 transform -translate-y-1/2 w-3.5 h-3.5 text-gray-400" />
            <input
              type="text"
              value={searchQuery}
              onChange={(e) => setSearchQuery(e.target.value)}
              placeholder="Search emails..."
              className="w-full pl-8 pr-3 py-1.5 text-xs border border-gray-300 rounded bg-white focus:outline-none focus:ring-1 focus:ring-blue-500 focus:border-blue-500"
            />
          </div>
        </div>

        <div className="flex-1 overflow-y-auto">
          {loadingEmails && emails.length === 0 ? (
            <div className="flex items-center justify-center h-full">
              <Loader className="w-6 h-6 animate-spin text-blue-500" />
            </div>
          ) : emails.length === 0 ? (
            <div className="flex flex-col items-center justify-center h-full text-gray-500">
              <Mail className="w-12 h-12 mb-4 text-gray-300" />
              <p className="text-sm">No emails found</p>
            </div>
          ) : (
            <div>
              {emails
                .filter(email =>
                  searchQuery === '' ||
                  email.subject.toLowerCase().includes(searchQuery.toLowerCase()) ||
                  email.from.toLowerCase().includes(searchQuery.toLowerCase()) ||
                  email.snippet.toLowerCase().includes(searchQuery.toLowerCase())
                )
                .map((email) => (
                  <div
                    key={email.id}
                    onClick={() => handleEmailClick(email)}
                    className={`flex items-start gap-2 px-3 py-2.5 border-b border-gray-100 cursor-pointer transition ${
                      selectedEmail?.id === email.id
                        ? 'bg-blue-50 border-l-2 border-l-blue-500'
                        : email.isUnread
                        ? 'bg-white hover:bg-gray-50'
                        : 'bg-white hover:bg-gray-50'
                    }`}
                  >
                    <button
                      onClick={(e) => {
                        e.stopPropagation();
                        toggleStar(email.id, email.isStarred);
                      }}
                      className="mt-0.5 flex-shrink-0"
                    >
                      <Star
                        className={`w-3.5 h-3.5 ${
                          email.isStarred ? 'fill-yellow-400 text-yellow-400' : 'text-gray-300'
                        } hover:text-yellow-400 transition`}
                      />
                    </button>
                    <div className="flex-1 min-w-0">
                      <div className="flex items-baseline justify-between gap-2 mb-0.5">
                        <p className={`text-xs truncate ${email.isUnread ? 'font-bold text-gray-900' : 'font-medium text-gray-700'}`}>
                          {email.from}
                        </p>
                        <span className="text-[10px] text-gray-500 whitespace-nowrap flex-shrink-0">
                          {formatDate(email.date)}
                        </span>
                      </div>
                      <p className={`text-xs truncate mb-0.5 ${email.isUnread ? 'font-semibold text-gray-900' : 'text-gray-600'}`}>
                        {email.subject}
                      </p>
                      <p className="text-[10px] text-gray-500 line-clamp-1">{email.snippet}</p>
                    </div>
                    {email.isUnread && (
                      <div className="w-1.5 h-1.5 rounded-full bg-blue-500 mt-1.5 flex-shrink-0"></div>
                    )}
                  </div>
                ))}
              {nextPageToken && (
                <div className="p-4 text-center">
                  <button
                    onClick={() => loadEmails(nextPageToken)}
                    disabled={loadingEmails}
                    className="px-4 py-2 text-sm text-blue-600 hover:text-blue-700 font-medium disabled:opacity-50"
                  >
                    {loadingEmails ? 'Loading...' : 'Load More'}
                  </button>
                </div>
              )}
            </div>
          )}
        </div>
      </div>

      {/* Right Panel - Email Preview (60%) */}
      <div className="flex-1 w-[60%] flex flex-col bg-white overflow-hidden">
        {selectedEmail ? (
          <>
            <div className="px-6 py-4 border-b border-gray-200 bg-white">
              <h2 className="text-lg font-semibold text-gray-900 mb-3 leading-tight">{selectedEmail.subject}</h2>
              <div className="flex items-start justify-between gap-4">
                <div className="flex items-start gap-3">
                  <div className="w-10 h-10 rounded-full bg-gradient-to-br from-blue-500 to-blue-600 flex items-center justify-center text-white font-semibold text-sm flex-shrink-0">
                    {selectedEmail.from.charAt(0).toUpperCase()}
                  </div>
                  <div className="min-w-0">
                    <p className="text-sm font-semibold text-gray-900">{selectedEmail.from}</p>
                    <p className="text-xs text-gray-500 truncate">{selectedEmail.fromEmail}</p>
                  </div>
                </div>
                <p className="text-xs text-gray-500 whitespace-nowrap">
                  {selectedEmail.date.toLocaleDateString('en-US', {
                    month: 'short',
                    day: 'numeric',
                    year: 'numeric',
                    hour: 'numeric',
                    minute: '2-digit',
                  })}
                </p>
              </div>
            </div>
            <div className="flex-1 overflow-y-auto px-6 py-4 bg-gray-50">
              {loadingEmailBody ? (
                <div className="flex items-center justify-center h-full">
                  <Loader className="w-6 h-6 animate-spin text-blue-500" />
                </div>
              ) : selectedEmail.body ? (
                <div
                  className="prose prose-sm max-w-none bg-white rounded-lg p-4 shadow-sm"
                  style={{ fontSize: '13px', lineHeight: '1.6' }}
                  dangerouslySetInnerHTML={{
                    __html: DOMPurify.sanitize(selectedEmail.body, {
                      ADD_ATTR: ['target'],
                      ADD_TAGS: ['style']
                    })
                  }}
                />
              ) : (
                <div className="bg-white rounded-lg p-4 shadow-sm">
                  <p className="text-sm text-gray-700 whitespace-pre-wrap">{selectedEmail.snippet}</p>
                </div>
              )}
            </div>
            <div className="px-4 py-3 border-t border-gray-200 bg-white">
              <div className="flex items-center gap-2">
                <button className="flex items-center gap-1.5 px-4 py-2 text-sm font-medium text-white bg-blue-600 rounded hover:bg-blue-700 transition">
                  Reply
                </button>
                <button className="flex items-center gap-1.5 px-4 py-2 text-sm font-medium text-gray-700 bg-white border border-gray-300 rounded hover:bg-gray-50 transition">
                  Forward
                </button>
                <button className="flex items-center gap-1.5 px-4 py-2 text-sm font-medium text-blue-700 bg-blue-50 border border-blue-200 rounded hover:bg-blue-100 transition">
                  Create Inquiry
                </button>
              </div>
            </div>
          </>
        ) : (
          <div className="flex items-center justify-center h-full text-gray-400 bg-gray-50">
            <div className="text-center">
              <Mail className="w-20 h-20 mx-auto mb-4 text-gray-300" />
              <p className="text-sm text-gray-500 font-medium">Select an email to view</p>
              <p className="text-xs text-gray-400 mt-1">Choose a message from your inbox</p>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
