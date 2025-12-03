import { useState, useEffect } from 'react';
import { supabase } from '../../lib/supabase';
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

  const handleEmailClick = (email: EmailListItem) => {
    setSelectedEmail(email);
    if (email.isUnread) {
      markAsRead(email.id);
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
      <div className="flex items-center justify-center h-64">
        <div className="text-center">
          <AlertCircle className="w-12 h-12 text-red-500 mx-auto mb-4" />
          <p className="text-gray-700 font-medium mb-2">Connection Error</p>
          <p className="text-sm text-gray-500">{error}</p>
        </div>
      </div>
    );
  }

  return (
    <div className="flex h-[calc(100vh-16rem)] bg-white rounded-lg border border-gray-200">
      {/* Left Sidebar - Folders */}
      <div className="w-56 border-r border-gray-200 flex flex-col bg-gray-50">
        <div className="p-4 border-b border-gray-200">
          <h3 className="text-sm font-semibold text-gray-700">Folders</h3>
        </div>
        <div className="flex-1 overflow-y-auto">
          <button
            onClick={() => setSelectedFolder('INBOX')}
            className={`w-full flex items-center gap-3 px-4 py-3 text-sm transition ${
              selectedFolder === 'INBOX'
                ? 'bg-blue-50 text-blue-700 font-medium border-r-2 border-blue-500'
                : 'text-gray-700 hover:bg-gray-100'
            }`}
          >
            <Inbox className="w-4 h-4" />
            <span>Inbox</span>
          </button>
          <button
            onClick={() => setSelectedFolder('STARRED')}
            className={`w-full flex items-center gap-3 px-4 py-3 text-sm transition ${
              selectedFolder === 'STARRED'
                ? 'bg-blue-50 text-blue-700 font-medium border-r-2 border-blue-500'
                : 'text-gray-700 hover:bg-gray-100'
            }`}
          >
            <Star className="w-4 h-4" />
            <span>Starred</span>
          </button>
          <button
            onClick={() => setSelectedFolder('SENT')}
            className={`w-full flex items-center gap-3 px-4 py-3 text-sm transition ${
              selectedFolder === 'SENT'
                ? 'bg-blue-50 text-blue-700 font-medium border-r-2 border-blue-500'
                : 'text-gray-700 hover:bg-gray-100'
            }`}
          >
            <Send className="w-4 h-4" />
            <span>Sent</span>
          </button>
          <button
            onClick={() => setSelectedFolder('DRAFT')}
            className={`w-full flex items-center gap-3 px-4 py-3 text-sm transition ${
              selectedFolder === 'DRAFT'
                ? 'bg-blue-50 text-blue-700 font-medium border-r-2 border-blue-500'
                : 'text-gray-700 hover:bg-gray-100'
            }`}
          >
            <Mail className="w-4 h-4" />
            <span>Drafts</span>
          </button>
          <button
            onClick={() => setSelectedFolder('ALL')}
            className={`w-full flex items-center gap-3 px-4 py-3 text-sm transition ${
              selectedFolder === 'ALL'
                ? 'bg-blue-50 text-blue-700 font-medium border-r-2 border-blue-500'
                : 'text-gray-700 hover:bg-gray-100'
            }`}
          >
            <Archive className="w-4 h-4" />
            <span>All Mail</span>
          </button>
          <button
            onClick={() => setSelectedFolder('TRASH')}
            className={`w-full flex items-center gap-3 px-4 py-3 text-sm transition ${
              selectedFolder === 'TRASH'
                ? 'bg-blue-50 text-blue-700 font-medium border-r-2 border-blue-500'
                : 'text-gray-700 hover:bg-gray-100'
            }`}
          >
            <Trash className="w-4 h-4" />
            <span>Trash</span>
          </button>
        </div>
        <div className="p-4 border-t border-gray-200">
          <button
            onClick={() => loadEmails()}
            disabled={loadingEmails}
            className="w-full flex items-center justify-center gap-2 px-3 py-2 text-xs font-medium text-gray-700 bg-white border border-gray-300 rounded-md hover:bg-gray-50 transition disabled:opacity-50"
          >
            <RefreshCw className={`w-3.5 h-3.5 ${loadingEmails ? 'animate-spin' : ''}`} />
            Refresh
          </button>
        </div>
      </div>

      {/* Middle Panel - Email List */}
      <div className="flex-1 flex flex-col border-r border-gray-200">
        <div className="p-4 border-b border-gray-200">
          <div className="relative">
            <Search className="absolute left-3 top-1/2 transform -translate-y-1/2 w-4 h-4 text-gray-400" />
            <input
              type="text"
              value={searchQuery}
              onChange={(e) => setSearchQuery(e.target.value)}
              placeholder="Search emails..."
              className="w-full pl-10 pr-4 py-2 text-sm border border-gray-300 rounded-md focus:outline-none focus:ring-2 focus:ring-blue-500"
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
                    className={`flex items-start gap-3 p-4 border-b border-gray-100 cursor-pointer transition ${
                      selectedEmail?.id === email.id
                        ? 'bg-blue-50'
                        : email.isUnread
                        ? 'bg-white hover:bg-gray-50'
                        : 'bg-gray-50 hover:bg-gray-100'
                    }`}
                  >
                    <button
                      onClick={(e) => {
                        e.stopPropagation();
                        toggleStar(email.id, email.isStarred);
                      }}
                      className="mt-1"
                    >
                      <Star
                        className={`w-4 h-4 ${
                          email.isStarred ? 'fill-yellow-400 text-yellow-400' : 'text-gray-300'
                        } hover:text-yellow-400 transition`}
                      />
                    </button>
                    <div className="flex-1 min-w-0">
                      <div className="flex items-baseline justify-between gap-2 mb-1">
                        <p className={`text-sm truncate ${email.isUnread ? 'font-semibold text-gray-900' : 'text-gray-700'}`}>
                          {email.from}
                        </p>
                        <span className="text-xs text-gray-500 whitespace-nowrap">
                          {formatDate(email.date)}
                        </span>
                      </div>
                      <p className={`text-sm truncate mb-1 ${email.isUnread ? 'font-medium text-gray-900' : 'text-gray-600'}`}>
                        {email.subject}
                      </p>
                      <p className="text-xs text-gray-500 truncate">{email.snippet}</p>
                    </div>
                    {email.isUnread && (
                      <div className="w-2 h-2 rounded-full bg-blue-500 mt-2"></div>
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

      {/* Right Panel - Email Detail */}
      <div className="w-1/2 flex flex-col bg-white">
        {selectedEmail ? (
          <>
            <div className="p-6 border-b border-gray-200">
              <h2 className="text-xl font-semibold text-gray-900 mb-4">{selectedEmail.subject}</h2>
              <div className="flex items-start justify-between">
                <div>
                  <p className="text-sm font-medium text-gray-900">{selectedEmail.from}</p>
                  <p className="text-xs text-gray-500">{selectedEmail.fromEmail}</p>
                </div>
                <p className="text-sm text-gray-500">
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
            <div className="flex-1 overflow-y-auto p-6">
              <div className="prose prose-sm max-w-none">
                <p className="text-gray-700 whitespace-pre-wrap">{selectedEmail.snippet}</p>
              </div>
            </div>
            <div className="p-4 border-t border-gray-200 bg-gray-50">
              <div className="flex items-center gap-2">
                <button className="flex items-center gap-1.5 px-3 py-2 text-sm font-medium text-gray-700 bg-white border border-gray-300 rounded-md hover:bg-gray-50 transition">
                  Reply
                </button>
                <button className="flex items-center gap-1.5 px-3 py-2 text-sm font-medium text-gray-700 bg-white border border-gray-300 rounded-md hover:bg-gray-50 transition">
                  Forward
                </button>
                <button className="flex items-center gap-1.5 px-3 py-2 text-sm font-medium text-blue-700 bg-blue-50 border border-blue-200 rounded-md hover:bg-blue-100 transition">
                  Create Inquiry
                </button>
              </div>
            </div>
          </>
        ) : (
          <div className="flex items-center justify-center h-full text-gray-400">
            <div className="text-center">
              <Mail className="w-16 h-16 mx-auto mb-4 text-gray-300" />
              <p className="text-sm">Select an email to view</p>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
