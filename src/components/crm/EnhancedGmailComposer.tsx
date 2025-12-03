import { useState, useEffect, useRef, useCallback } from 'react';
import { supabase } from '../../lib/supabase';
import ReactQuill from 'react-quill';
import 'react-quill/dist/quill.snow.css';
import {
  Send, Paperclip, X, Loader, Minus, Maximize2, Minimize2,
  Link as LinkIcon, Type, Trash2, ChevronDown, Image as ImageIcon
} from 'lucide-react';

interface Customer {
  name: string;
  email: string;
  company?: string;
}

interface Recipient {
  name: string;
  email: string;
}

interface Attachment {
  file: File;
  name: string;
  size: number;
}

interface EnhancedGmailComposerProps {
  isOpen: boolean;
  onClose: () => void;
  mode?: 'compose' | 'reply' | 'forward';
  replyTo?: {
    id: string;
    subject: string;
    from: string;
    fromEmail: string;
    body?: string;
    htmlBody?: string;
    date: Date;
  };
  onSend?: (data: {
    to: string[];
    cc: string[];
    bcc: string[];
    subject: string;
    body: string;
    attachments: File[];
  }) => Promise<void>;
}

export function EnhancedGmailComposer({
  isOpen,
  onClose,
  mode = 'compose',
  replyTo,
  onSend
}: EnhancedGmailComposerProps) {
  const [toRecipients, setToRecipients] = useState<Recipient[]>([]);
  const [ccRecipients, setCcRecipients] = useState<Recipient[]>([]);
  const [bccRecipients, setBccRecipients] = useState<Recipient[]>([]);
  const [showCc, setShowCc] = useState(false);
  const [showBcc, setShowBcc] = useState(false);

  const [toInput, setToInput] = useState('');
  const [ccInput, setCcInput] = useState('');
  const [bccInput, setBccInput] = useState('');

  const [subject, setSubject] = useState('');
  const [body, setBody] = useState('');
  const [attachments, setAttachments] = useState<Attachment[]>([]);
  const [sending, setSending] = useState(false);
  const [minimized, setMinimized] = useState(false);
  const [fullscreen, setFullscreen] = useState(false);

  const [customerSuggestions, setCustomerSuggestions] = useState<Customer[]>([]);
  const [showSuggestions, setShowSuggestions] = useState(false);
  const [activeSuggestionField, setActiveSuggestionField] = useState<'to' | 'cc' | 'bcc' | null>(null);
  const [showQuotedText, setShowQuotedText] = useState(false);

  const fileInputRef = useRef<HTMLInputElement>(null);
  const quillRef = useRef<ReactQuill>(null);
  const toInputRef = useRef<HTMLInputElement>(null);
  const suggestionsRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (mode === 'reply' && replyTo) {
      setSubject(replyTo.subject.startsWith('Re: ') ? replyTo.subject : `Re: ${replyTo.subject}`);
      setToRecipients([{ name: replyTo.from, email: replyTo.fromEmail }]);

      const quotedHtml = generateQuotedReply(replyTo);
      setBody(quotedHtml);
    } else if (mode === 'forward' && replyTo) {
      setSubject(replyTo.subject.startsWith('Fwd: ') ? replyTo.subject : `Fwd: ${replyTo.subject}`);

      const forwardHtml = generateForwardedMessage(replyTo);
      setBody(forwardHtml);
    }
  }, [mode, replyTo]);

  useEffect(() => {
    const handleClickOutside = (event: MouseEvent) => {
      if (suggestionsRef.current && !suggestionsRef.current.contains(event.target as Node)) {
        setShowSuggestions(false);
      }
    };

    if (showSuggestions) {
      document.addEventListener('mousedown', handleClickOutside);
      return () => document.removeEventListener('mousedown', handleClickOutside);
    }
  }, [showSuggestions]);

  const generateQuotedReply = (email: typeof replyTo): string => {
    if (!email) return '';

    const dateStr = email.date.toLocaleDateString('en-US', {
      weekday: 'short',
      month: 'short',
      day: 'numeric',
      year: 'numeric'
    });

    const timeStr = email.date.toLocaleTimeString('en-US', {
      hour: 'numeric',
      minute: '2-digit',
      hour12: true
    });

    const replyHeader = `<div style="margin-top: 20px; color: #666;">On ${dateStr} at ${timeStr}, ${email.from} &lt;${email.fromEmail}&gt; wrote:</div>`;

    const quotedBody = `<blockquote style="margin: 10px 0 0 0; padding-left: 16px; border-left: 4px solid #ccc; color: #666;">${email.htmlBody || email.body?.replace(/\n/g, '<br>') || ''}</blockquote>`;

    return `<p><br></p><p><br></p>${replyHeader}${quotedBody}`;
  };

  const generateForwardedMessage = (email: typeof replyTo): string => {
    if (!email) return '';

    const dateStr = email.date.toLocaleString('en-US', {
      month: 'short',
      day: 'numeric',
      year: 'numeric',
      hour: 'numeric',
      minute: '2-digit'
    });

    const forwardHeader = `<div style="margin-top: 20px; padding-top: 20px; border-top: 1px solid #ccc;">
      <div style="color: #666; margin-bottom: 10px;">---------- Forwarded message ---------</div>
      <div style="color: #666;"><strong>From:</strong> ${email.from} &lt;${email.fromEmail}&gt;</div>
      <div style="color: #666;"><strong>Date:</strong> ${dateStr}</div>
      <div style="color: #666;"><strong>Subject:</strong> ${email.subject}</div>
      <div style="margin-top: 15px;">${email.htmlBody || email.body?.replace(/\n/g, '<br>') || ''}</div>
    </div>`;

    return `<p><br></p><p><br></p>${forwardHeader}`;
  };

  const searchCustomers = useCallback(async (query: string) => {
    if (!query || query.length < 2) {
      setCustomerSuggestions([]);
      return;
    }

    try {
      const { data: customers } = await supabase
        .from('customers')
        .select('customer_name, email, company_name')
        .eq('is_active', true)
        .or(`customer_name.ilike.%${query}%,email.ilike.%${query}%,company_name.ilike.%${query}%`)
        .limit(5);

      const { data: contacts } = await supabase
        .from('crm_contacts')
        .select('contact_person, email, company_name')
        .eq('is_active', true)
        .or(`contact_person.ilike.%${query}%,email.ilike.%${query}%,company_name.ilike.%${query}%`)
        .limit(5);

      const customerList: Customer[] = [
        ...(customers || []).map(c => ({
          name: c.customer_name,
          email: c.email,
          company: c.company_name
        })),
        ...(contacts || []).map(c => ({
          name: c.contact_person,
          email: c.email,
          company: c.company_name
        }))
      ];

      setCustomerSuggestions(customerList);
      setShowSuggestions(customerList.length > 0);
    } catch (error) {
      console.error('Error searching customers:', error);
    }
  }, []);

  const handleInputChange = (value: string, field: 'to' | 'cc' | 'bcc') => {
    if (field === 'to') setToInput(value);
    else if (field === 'cc') setCcInput(value);
    else setBccInput(value);

    setActiveSuggestionField(field);
    searchCustomers(value);
  };

  const addRecipient = (customer: Customer, field: 'to' | 'cc' | 'bcc') => {
    const recipient = { name: customer.name, email: customer.email };

    if (field === 'to') {
      setToRecipients([...toRecipients, recipient]);
      setToInput('');
    } else if (field === 'cc') {
      setCcRecipients([...ccRecipients, recipient]);
      setCcInput('');
    } else {
      setBccRecipients([...bccRecipients, recipient]);
      setBccInput('');
    }

    setShowSuggestions(false);
    setCustomerSuggestions([]);
  };

  const removeRecipient = (index: number, field: 'to' | 'cc' | 'bcc') => {
    if (field === 'to') {
      setToRecipients(toRecipients.filter((_, i) => i !== index));
    } else if (field === 'cc') {
      setCcRecipients(ccRecipients.filter((_, i) => i !== index));
    } else {
      setBccRecipients(bccRecipients.filter((_, i) => i !== index));
    }
  };

  const handleKeyDown = (e: React.KeyboardEvent<HTMLInputElement>, field: 'to' | 'cc' | 'bcc') => {
    const value = field === 'to' ? toInput : field === 'cc' ? ccInput : bccInput;

    if ((e.key === 'Enter' || e.key === ',' || e.key === ' ') && value.trim()) {
      e.preventDefault();

      if (validateEmail(value.trim())) {
        const recipient = { name: value.trim(), email: value.trim() };

        if (field === 'to') {
          setToRecipients([...toRecipients, recipient]);
          setToInput('');
        } else if (field === 'cc') {
          setCcRecipients([...ccRecipients, recipient]);
          setCcInput('');
        } else {
          setBccRecipients([...bccRecipients, recipient]);
          setBccInput('');
        }

        setShowSuggestions(false);
      }
    } else if (e.key === 'Backspace' && !value) {
      if (field === 'to' && toRecipients.length > 0) {
        setToRecipients(toRecipients.slice(0, -1));
      } else if (field === 'cc' && ccRecipients.length > 0) {
        setCcRecipients(ccRecipients.slice(0, -1));
      } else if (field === 'bcc' && bccRecipients.length > 0) {
        setBccRecipients(bccRecipients.slice(0, -1));
      }
    }
  };

  const validateEmail = (email: string): boolean => {
    return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email);
  };

  const handleFileSelect = (e: React.ChangeEvent<HTMLInputElement>) => {
    const files = e.target.files;
    if (!files) return;

    const newFiles: Attachment[] = [];
    for (let i = 0; i < files.length; i++) {
      const file = files[i];
      if (file.size > 25 * 1024 * 1024) {
        alert(`File ${file.name} is too large. Maximum size is 25MB.`);
        continue;
      }
      newFiles.push({
        file,
        name: file.name,
        size: file.size,
      });
    }
    setAttachments(prev => [...prev, ...newFiles]);
  };

  const removeAttachment = (index: number) => {
    setAttachments(prev => prev.filter((_, i) => i !== index));
  };

  const formatFileSize = (bytes: number): string => {
    if (bytes < 1024) return bytes + ' B';
    if (bytes < 1024 * 1024) return (bytes / 1024).toFixed(1) + ' KB';
    return (bytes / (1024 * 1024)).toFixed(1) + ' MB';
  };

  const handleSend = async () => {
    const allToEmails = [...toRecipients.map(r => r.email)];
    const allCcEmails = [...ccRecipients.map(r => r.email)];
    const allBccEmails = [...bccRecipients.map(r => r.email)];

    if (toInput.trim() && validateEmail(toInput.trim())) {
      allToEmails.push(toInput.trim());
    }

    if (ccInput.trim() && validateEmail(ccInput.trim())) {
      allCcEmails.push(ccInput.trim());
    }

    if (bccInput.trim() && validateEmail(bccInput.trim())) {
      allBccEmails.push(bccInput.trim());
    }

    if (allToEmails.length === 0 || !subject || !body) {
      alert('Please fill in recipient, subject, and message');
      return;
    }

    setSending(true);
    try {
      if (onSend) {
        await onSend({
          to: allToEmails,
          cc: allCcEmails,
          bcc: allBccEmails,
          subject,
          body,
          attachments: attachments.map(a => a.file)
        });
      }

      alert('Email sent successfully!');
      onClose();
    } catch (error) {
      console.error('Error sending email:', error);
      alert('Failed to send email. Please try again.');
    } finally {
      setSending(false);
    }
  };

  const modules = {
    toolbar: [
      [{ 'header': [1, 2, 3, false] }],
      ['bold', 'italic', 'underline', 'strike'],
      [{ 'color': [] }, { 'background': [] }],
      [{ 'list': 'ordered'}, { 'list': 'bullet' }],
      [{ 'align': [] }],
      ['link', 'image'],
      ['clean']
    ]
  };

  if (!isOpen) return null;

  if (minimized) {
    return (
      <div className="fixed bottom-0 right-4 w-64 bg-gray-800 text-white rounded-t-lg shadow-xl z-50">
        <div className="flex items-center justify-between px-4 py-2 cursor-pointer" onClick={() => setMinimized(false)}>
          <div className="flex items-center gap-2">
            <Send className="w-4 h-4" />
            <span className="text-sm font-medium truncate">{subject || 'New Message'}</span>
          </div>
          <div className="flex items-center gap-1">
            <button onClick={(e) => { e.stopPropagation(); setMinimized(false); }} className="p-1 hover:bg-gray-700 rounded">
              <Maximize2 className="w-4 h-4" />
            </button>
            <button onClick={(e) => { e.stopPropagation(); onClose(); }} className="p-1 hover:bg-gray-700 rounded">
              <X className="w-4 h-4" />
            </button>
          </div>
        </div>
      </div>
    );
  }

  return (
    <div className={`fixed ${fullscreen ? 'inset-0' : 'bottom-0 right-6 w-[480px] h-[600px]'} bg-white rounded-t-lg shadow-2xl z-40 flex flex-col`}>
      {/* Header */}
      <div className="flex items-center justify-between px-4 py-2 bg-gray-50 border-b border-gray-200 rounded-t-lg">
        <h3 className="text-sm font-semibold text-gray-900">
          {mode === 'reply' ? 'Reply' : mode === 'forward' ? 'Forward' : 'New Message'}
        </h3>
        <div className="flex items-center gap-1">
          <button
            onClick={() => setMinimized(true)}
            className="p-1.5 hover:bg-gray-200 rounded transition"
            title="Minimize"
          >
            <Minus className="w-4 h-4 text-gray-600" />
          </button>
          <button
            onClick={() => setFullscreen(!fullscreen)}
            className="p-1.5 hover:bg-gray-200 rounded transition"
            title={fullscreen ? 'Exit fullscreen' : 'Fullscreen'}
          >
            {fullscreen ? <Minimize2 className="w-4 h-4 text-gray-600" /> : <Maximize2 className="w-4 h-4 text-gray-600" />}
          </button>
          <button
            onClick={onClose}
            className="p-1.5 hover:bg-gray-200 rounded transition"
            title="Close"
          >
            <X className="w-4 h-4 text-gray-600" />
          </button>
        </div>
      </div>

      {/* Recipients */}
      <div className="border-b border-gray-200 bg-white">
        {/* To Field */}
        <div className="flex items-start px-4 py-2 border-b border-gray-100">
          <span className="text-sm text-gray-600 w-12 pt-1">To</span>
          <div className="flex-1 flex flex-wrap items-center gap-1">
            {toRecipients.map((recipient, index) => (
              <div key={index} className="flex items-center gap-1 px-2 py-0.5 bg-blue-100 text-blue-800 rounded-full text-xs">
                <span>{recipient.name}</span>
                <button onClick={() => removeRecipient(index, 'to')} className="hover:text-blue-900">
                  <X className="w-3 h-3" />
                </button>
              </div>
            ))}
            <input
              ref={toInputRef}
              type="text"
              value={toInput}
              onChange={(e) => handleInputChange(e.target.value, 'to')}
              onKeyDown={(e) => handleKeyDown(e, 'to')}
              onFocus={() => setActiveSuggestionField('to')}
              onBlur={() => {
                setTimeout(() => setShowSuggestions(false), 200);
              }}
              placeholder={toRecipients.length === 0 ? 'Type or search recipients' : ''}
              className="flex-1 min-w-[120px] outline-none text-sm py-1"
            />
          </div>
          <div className="flex items-center gap-2 text-xs ml-2">
            {!showCc && (
              <button onClick={() => setShowCc(true)} className="text-blue-600 hover:text-blue-700">
                Cc
              </button>
            )}
            {!showBcc && (
              <button onClick={() => setShowBcc(true)} className="text-blue-600 hover:text-blue-700">
                Bcc
              </button>
            )}
          </div>
        </div>

        {/* Cc Field */}
        {showCc && (
          <div className="flex items-start px-4 py-2 border-b border-gray-100">
            <span className="text-sm text-gray-600 w-12 pt-1">Cc</span>
            <div className="flex-1 flex flex-wrap items-center gap-1">
              {ccRecipients.map((recipient, index) => (
                <div key={index} className="flex items-center gap-1 px-2 py-0.5 bg-blue-100 text-blue-800 rounded-full text-xs">
                  <span>{recipient.name}</span>
                  <button onClick={() => removeRecipient(index, 'cc')} className="hover:text-blue-900">
                    <X className="w-3 h-3" />
                  </button>
                </div>
              ))}
              <input
                type="text"
                value={ccInput}
                onChange={(e) => handleInputChange(e.target.value, 'cc')}
                onKeyDown={(e) => handleKeyDown(e, 'cc')}
                onFocus={() => setActiveSuggestionField('cc')}
                onBlur={() => {
                  setTimeout(() => setShowSuggestions(false), 200);
                }}
                placeholder={ccRecipients.length === 0 ? 'Type or search Cc recipients' : ''}
                className="flex-1 min-w-[120px] outline-none text-sm py-1"
              />
            </div>
          </div>
        )}

        {/* Bcc Field */}
        {showBcc && (
          <div className="flex items-start px-4 py-2 border-b border-gray-100">
            <span className="text-sm text-gray-600 w-12 pt-1">Bcc</span>
            <div className="flex-1 flex flex-wrap items-center gap-1">
              {bccRecipients.map((recipient, index) => (
                <div key={index} className="flex items-center gap-1 px-2 py-0.5 bg-blue-100 text-blue-800 rounded-full text-xs">
                  <span>{recipient.name}</span>
                  <button onClick={() => removeRecipient(index, 'bcc')} className="hover:text-blue-900">
                    <X className="w-3 h-3" />
                  </button>
                </div>
              ))}
              <input
                type="text"
                value={bccInput}
                onChange={(e) => handleInputChange(e.target.value, 'bcc')}
                onKeyDown={(e) => handleKeyDown(e, 'bcc')}
                onFocus={() => setActiveSuggestionField('bcc')}
                onBlur={() => {
                  setTimeout(() => setShowSuggestions(false), 200);
                }}
                placeholder={bccRecipients.length === 0 ? 'Type or search Bcc recipients' : ''}
                className="flex-1 min-w-[120px] outline-none text-sm py-1"
              />
            </div>
          </div>
        )}

        {/* Autocomplete Suggestions */}
        {showSuggestions && customerSuggestions.length > 0 && activeSuggestionField && (
          <div ref={suggestionsRef} className="absolute bg-white border border-gray-200 shadow-lg rounded-lg mt-1 max-h-48 overflow-y-auto z-50 w-96 ml-16">
            {customerSuggestions.map((customer, index) => (
              <button
                key={index}
                onMouseDown={(e) => {
                  e.preventDefault();
                  addRecipient(customer, activeSuggestionField);
                }}
                className="w-full px-4 py-2 text-left hover:bg-gray-50 border-b border-gray-100 last:border-b-0"
              >
                <div className="text-sm font-medium text-gray-900">{customer.name}</div>
                <div className="text-xs text-gray-500">{customer.email}</div>
                {customer.company && <div className="text-xs text-gray-400">{customer.company}</div>}
              </button>
            ))}
          </div>
        )}

        {/* Helper Text */}
        <div className="px-4 pb-2 text-[11px] text-gray-500 italic">
          Tip: Type email addresses and press Enter, comma, or space to add. Or search from contacts.
        </div>

        {/* Subject */}
        <div className="flex items-center px-4 py-2">
          <span className="text-sm text-gray-600 w-12">Subject</span>
          <input
            type="text"
            value={subject}
            onChange={(e) => setSubject(e.target.value)}
            placeholder="Subject"
            className="flex-1 outline-none text-sm"
          />
        </div>
      </div>

      {/* Body - Rich Text Editor */}
      <div className="flex-1 overflow-hidden flex flex-col">
        <style>{`
          .quill-editor-container .ql-container {
            font-size: 14px;
            font-family: Arial, sans-serif;
            overflow-y: auto !important;
            max-height: 100%;
          }
          .quill-editor-container .ql-editor {
            min-height: 200px;
            overflow-y: auto !important;
          }
          .quill-editor-container .ql-editor table {
            border-collapse: collapse;
            width: 100%;
            margin: 12px 0;
          }
          .quill-editor-container .ql-editor table td,
          .quill-editor-container .ql-editor table th {
            border: 1px solid #ddd;
            padding: 8px;
          }
          .quill-editor-container .ql-editor blockquote {
            border-left: 4px solid #ccc;
            padding-left: 16px;
            color: #666;
            margin: 10px 0;
          }
          .quill-editor-container .ql-editor img {
            max-width: 100%;
            height: auto;
          }
        `}</style>
        <ReactQuill
          ref={quillRef}
          theme="snow"
          value={body}
          onChange={setBody}
          modules={modules}
          className="quill-editor-container flex-1"
          style={{ display: 'flex', flexDirection: 'column', height: '100%' }}
        />
      </div>

      {/* Attachments */}
      {attachments.length > 0 && (
        <div className="px-4 py-2 border-t border-gray-200 bg-gray-50 max-h-32 overflow-y-auto">
          <div className="space-y-1">
            {attachments.map((att, index) => (
              <div key={index} className="flex items-center justify-between p-2 bg-white rounded border border-gray-200">
                <div className="flex items-center gap-2 min-w-0">
                  <Paperclip className="w-4 h-4 text-gray-500 flex-shrink-0" />
                  <span className="text-sm text-gray-700 truncate">{att.name}</span>
                  <span className="text-xs text-gray-500 flex-shrink-0">({formatFileSize(att.size)})</span>
                </div>
                <button onClick={() => removeAttachment(index)} className="text-red-600 hover:text-red-700 ml-2">
                  <X className="w-4 h-4" />
                </button>
              </div>
            ))}
          </div>
        </div>
      )}

      {/* Bottom Toolbar */}
      <div className="flex items-center justify-between px-4 py-3 border-t border-gray-200 bg-white rounded-b-lg">
        <div className="flex items-center gap-2">
          <button
            onClick={handleSend}
            disabled={sending || (toRecipients.length === 0 && (!toInput.trim() || !validateEmail(toInput.trim()))) || !subject || !body}
            className="flex items-center gap-2 px-4 py-2 bg-blue-600 text-white rounded-lg hover:bg-blue-700 transition disabled:opacity-50 disabled:cursor-not-allowed text-sm font-medium"
          >
            {sending ? (
              <>
                <Loader className="w-4 h-4 animate-spin" />
                Sending...
              </>
            ) : (
              <>
                <Send className="w-4 h-4" />
                Send
              </>
            )}
          </button>

          <input
            ref={fileInputRef}
            type="file"
            multiple
            onChange={handleFileSelect}
            className="hidden"
          />
          <button
            onClick={() => fileInputRef.current?.click()}
            className="p-2 hover:bg-gray-100 rounded transition"
            title="Attach files"
          >
            <Paperclip className="w-5 h-5 text-gray-600" />
          </button>
        </div>

        <button
          onClick={onClose}
          className="p-2 hover:bg-gray-100 rounded transition"
          title="Discard"
        >
          <Trash2 className="w-5 h-5 text-gray-600" />
        </button>
      </div>
    </div>
  );
}
