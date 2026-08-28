import { useState, useEffect } from 'react';
import { supabase } from '../../lib/supabase';
import { Mail, Download, Upload, RefreshCw, CheckCircle, Users, Trash2, Sparkles } from 'lucide-react';
import * as XLSX from 'xlsx';
import {
  DUPLICATE_CUSTOMER_MESSAGE,
  normalizeCustomerName,
} from '../../utils/customerValidation';
import { sanitizeExportRows } from '../../utils/csvSafe';

interface ExtractedContact {
  id?: string;
  companyName: string;
  customerName: string;
  emailIds: string;
  phone: string;
  mobile: string;
  website: string;
  address: string;
  source: string;
  confidence?: number;
  extracted_at?: string;
  created_at?: string;
}

export function ExtractData() {
  const [extracting, setExtracting] = useState(false);
  const [importing, setImporting] = useState(false);
  const [clearing, setClearing] = useState(false);
  const [loading, setLoading] = useState(true);
  const [contacts, setContacts] = useState<ExtractedContact[]>([]);
  const [newlyAddedIds, setNewlyAddedIds] = useState<Set<string>>(new Set());
  const [stats, setStats] = useState<{ total_emails: number; total_contacts: number; new_contacts: number } | null>(null);
  const [selectedContacts, setSelectedContacts] = useState<Set<number>>(new Set());
  const [extractAll, setExtractAll] = useState(true);
  const [maxEmails, setMaxEmails] = useState(500);
  const [filterNew, setFilterNew] = useState(false);

  useEffect(() => {
    loadSavedContacts();
  }, []);

  const loadSavedContacts = async (highlightIds?: string[]) => {
    setLoading(true);
    try {
      const { data: { user } } = await supabase.auth.getUser();
      if (!user) return;

      const { data, error } = await supabase
        .from('extracted_contacts')
        .select('*')
        .eq('user_id', user.id)
        .order('created_at', { ascending: false });

      if (error) throw error;

      if (data) {
        const formattedContacts = data.map((row: any) => ({
          id: row.id,
          companyName: row.company_name,
          customerName: row.customer_name,
          emailIds: row.email_ids,
          phone: row.phone,
          mobile: row.mobile,
          website: row.website,
          address: row.address,
          source: row.source,
          confidence: row.confidence,
          extracted_at: row.extracted_at,
          created_at: row.created_at,
        }));
        setContacts(formattedContacts);
        setSelectedContacts(new Set(formattedContacts.map((_, i) => i)));
        if (highlightIds && highlightIds.length > 0) {
          setNewlyAddedIds(new Set(highlightIds));
        }
      }
    } catch (error) {
      console.error('Error loading contacts:', error);
    } finally {
      setLoading(false);
    }
  };

  const extractContactsFromGmail = async () => {
    setExtracting(true);
    setStats(null);
    setNewlyAddedIds(new Set());
    setFilterNew(false);
    try {
      const [{ data: { user } }, { data: { session } }] = await Promise.all([
        supabase.auth.getUser(),
        supabase.auth.getSession(),
      ]);

      if (!user || !session) {
        alert('Please log in to extract contacts.');
        return;
      }

      // Safety: do NOT read Gmail access_token / refresh_token in the frontend.
      // The Edge Function must look up the connection server-side using the
      // caller's JWT. We only verify a connection exists here for a friendly
      // error message.
      // TODO: ensure extract-gmail-contacts is updated to derive sender from
      // the JWT and fetch its own tokens server-side. Until then this call
      // will fail with a clear error if the function still requires tokens
      // in the body — that is preferable to exposing tokens in the browser.
      const { data: connection, error: connectionError } = await supabase
        .from('gmail_connections')
        .select('id, is_connected')
        .eq('user_id', user.id)
        .eq('is_connected', true)
        .maybeSingle();

      if (connectionError && connectionError.code !== 'PGRST116') {
        alert(`Database error: ${connectionError.message}. Please contact support.`);
        return;
      }

      if (!connection) {
        alert('Gmail is not connected. Please connect Gmail in Settings → Gmail tab.');
        return;
      }

      const apiUrl = `${import.meta.env.VITE_SUPABASE_URL}/functions/v1/extract-gmail-contacts`;

      const response = await fetch(apiUrl, {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${session.access_token}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          max_emails: extractAll ? 5000 : maxEmails,
          connection_id: connection.id,
        }),
      });

      const result = await response.json();

      if (!response.ok) {
        throw new Error(result.error || `HTTP ${response.status}: ${response.statusText}`);
      }

      if (result.success) {
        let newlyInsertedIds: string[] = [];

        if (result.contacts && result.contacts.length > 0) {
          const seenEmailIds = new Map<string, any>();
          for (const contact of result.contacts) {
            const key = (contact.emailIds || '').toLowerCase();
            if (!seenEmailIds.has(key) || (contact.confidence || 0) > (seenEmailIds.get(key).confidence || 0)) {
              seenEmailIds.set(key, contact);
            }
          }

          const contactsToInsert = Array.from(seenEmailIds.values()).map((contact: any) => ({
            user_id: user.id,
            company_name: contact.companyName || '',
            customer_name: contact.customerName || '',
            email_ids: contact.emailIds || '',
            phone: contact.phone || '',
            mobile: contact.mobile || '',
            website: contact.website || '',
            address: contact.address || '',
            source: contact.source || 'Gmail',
            confidence: contact.confidence || 0.5,
            extracted_at: new Date().toISOString(),
          }));

          const existingEmails = new Set(contacts.map(c => c.emailIds?.toLowerCase()));

          const { data: inserted, error: insertError } = await supabase
            .from('extracted_contacts')
            .upsert(contactsToInsert, {
              onConflict: 'user_id,email_ids',
              ignoreDuplicates: false,
            })
            .select();

          if (insertError) {
            console.error('Error saving contacts:', insertError);
            alert('Contacts extracted but failed to save to database. Please try again.');
            return;
          }

          newlyInsertedIds = (inserted || [])
            .filter((row: any) => !existingEmails.has(row.email_ids?.toLowerCase()))
            .map((row: any) => row.id);

          setStats({
            total_emails: result.total_emails_scanned || result.total_emails,
            total_contacts: result.total_contacts,
            new_contacts: newlyInsertedIds.length,
          });

          await loadSavedContacts(newlyInsertedIds);

          if (newlyInsertedIds.length > 0) {
            setFilterNew(true);
          }
        } else {
          setStats({
            total_emails: result.total_emails_scanned || result.total_emails || 0,
            total_contacts: 0,
            new_contacts: 0,
          });
        }
      } else {
        throw new Error(result.error || 'Failed to extract contacts');
      }
    } catch (error: any) {
      console.error('Error extracting contacts:', error);
      alert(`Failed to extract contacts: ${error.message || 'Unknown error'}\n\nPlease check Gmail is connected in Settings → Gmail tab.`);
    } finally {
      setExtracting(false);
    }
  };

  const exportToExcel = () => {
    const dataToExport = displayedContacts.filter((_, i) => selectedContacts.has(contacts.indexOf(_)));

    if (dataToExport.length === 0) {
      alert('No contacts selected to export');
      return;
    }

    const worksheet = XLSX.utils.json_to_sheet(
      sanitizeExportRows(dataToExport.map(contact => ({
        'Company Name': contact.companyName,
        'Customer Name': contact.customerName,
        'Email IDs': contact.emailIds,
        'Phone': contact.phone,
        'Mobile': contact.mobile,
        'Website': contact.website,
        'Address': contact.address,
        'Source': contact.source,
      })))
    );

    const workbook = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(workbook, worksheet, 'Clients');
    worksheet['!cols'] = [
      { wch: 30 }, { wch: 25 }, { wch: 40 }, { wch: 18 },
      { wch: 18 }, { wch: 30 }, { wch: 40 }, { wch: 12 },
    ];

    XLSX.writeFile(workbook, `Extracted_Contacts_${new Date().toISOString().split('T')[0]}.xlsx`);
  };

  const importToCustomers = async () => {
    if (selectedContacts.size === 0) {
      alert('Please select contacts to import');
      return;
    }

    const confirmed = confirm(
      `Import ${selectedContacts.size} contact(s) to the Customers database?`
    );
    if (!confirmed) return;

    setImporting(true);
    try {
      const selectedData = contacts.filter((_, i) => selectedContacts.has(i));
      const customersToInsert = selectedData.map(contact => ({
        company_name: contact.companyName || 'Unknown Company',
        contact_person: contact.customerName || '',
        email: contact.emailIds.split(';')[0]?.trim() || '',
        phone: contact.phone || contact.mobile || '',
        website: contact.website || '',
        address: contact.address || '',
        country: 'Indonesia',
        city: 'Jakarta Pusat',
        is_active: true,
      }));

      const importNames = customersToInsert.map(customer => normalizeCustomerName(customer.company_name));
      if (new Set(importNames).size !== importNames.length) {
        alert(DUPLICATE_CUSTOMER_MESSAGE);
        return;
      }

      const { data: existingCustomers, error: existingError } = await supabase
        .from('customers')
        .select('company_name')
        .eq('is_active', true);

      if (existingError) throw existingError;

      const existingNames = new Set((existingCustomers || []).map(customer => normalizeCustomerName(customer.company_name || '')));
      if (importNames.some(name => existingNames.has(name))) {
        alert(DUPLICATE_CUSTOMER_MESSAGE);
        return;
      }

      const { data, error } = await supabase
        .from('customers')
        .insert(customersToInsert)
        .select();

      if (error) throw error;
      alert(`Successfully imported ${data?.length || selectedContacts.size} customer(s)!`);
    } catch (error) {
      console.error('Error importing customers:', error);
      alert('Failed to import some customers. They may already exist in the database.');
    } finally {
      setImporting(false);
    }
  };

  const clearAllData = async () => {
    if (contacts.length === 0) return;
    const confirmed = confirm(`Permanently delete all ${contacts.length} contacts? This cannot be undone.`);
    if (!confirmed) return;

    setClearing(true);
    try {
      const { data: { user } } = await supabase.auth.getUser();
      if (!user) return;

      const { error } = await supabase.from('extracted_contacts').delete().eq('user_id', user.id);
      if (error) throw error;

      setContacts([]);
      setSelectedContacts(new Set());
      setNewlyAddedIds(new Set());
      setStats(null);
      setFilterNew(false);
    } catch (error) {
      console.error('Error clearing contacts:', error);
      alert('Failed to clear contacts. Please try again.');
    } finally {
      setClearing(false);
    }
  };

  const toggleSelectAll = () => {
    if (selectedContacts.size === contacts.length) {
      setSelectedContacts(new Set());
    } else {
      setSelectedContacts(new Set(contacts.map((_, i) => i)));
    }
  };

  const toggleContact = (index: number) => {
    const newSelected = new Set(selectedContacts);
    if (newSelected.has(index)) {
      newSelected.delete(index);
    } else {
      newSelected.add(index);
    }
    setSelectedContacts(newSelected);
  };

  const displayedContacts = filterNew
    ? contacts.filter(c => c.id && newlyAddedIds.has(c.id))
    : contacts;

  if (loading) {
    return (
      <div className="flex items-center justify-center py-12">
        <RefreshCw className="h-8 w-8 animate-spin text-blue-600" />
        <span className="ml-3 text-gray-600">Loading extracted contacts...</span>
      </div>
    );
  }

  return (
    <div className="space-y-6">
      <div>
        <div className="flex items-center justify-between mb-2">
          <h2 className="text-lg font-semibold text-gray-900">Extract Data from Gmail</h2>
          <div className="flex items-center gap-2 px-4 py-2 bg-green-50 border border-green-200 rounded-lg">
            <Users className="h-5 w-5 text-green-600" />
            <span className="text-sm font-medium text-green-900">
              {contacts.length} Total Contacts Saved
            </span>
          </div>
        </div>
        <p className="text-sm text-gray-600">
          AI-powered extraction of contact information from Gmail. Tracks processed emails — each run picks up where the last left off. All contacts saved permanently.
        </p>
      </div>

      <div className="bg-white border border-gray-200 rounded-lg p-6 space-y-4">
        <div className="flex items-center gap-4 flex-wrap">
          <div className="flex-1 min-w-0">
            <label className="block text-sm font-medium text-gray-700 mb-2">Scan Mode</label>
            <div className="flex items-center gap-3 flex-wrap">
              <label className="flex items-center gap-2 cursor-pointer">
                <input
                  type="radio"
                  checked={extractAll}
                  onChange={() => setExtractAll(true)}
                  className="text-blue-600"
                />
                <span className="text-sm text-gray-700 font-medium">Extract All New Emails</span>
                <span className="text-xs text-gray-500">(recommended)</span>
              </label>
              <label className="flex items-center gap-2 cursor-pointer">
                <input
                  type="radio"
                  checked={!extractAll}
                  onChange={() => setExtractAll(false)}
                  className="text-blue-600"
                />
                <span className="text-sm text-gray-700">Limit to</span>
                <input
                  type="number"
                  value={maxEmails}
                  onChange={(e) => setMaxEmails(Math.max(50, Math.min(5000, parseInt(e.target.value) || 500)))}
                  disabled={extractAll}
                  min="50"
                  max="5000"
                  step="100"
                  className="w-24 px-2 py-1 border border-gray-300 rounded-lg text-sm focus:ring-2 focus:ring-blue-500 disabled:opacity-40"
                />
                <span className="text-sm text-gray-500">emails</span>
              </label>
            </div>
          </div>

          <div className="flex-shrink-0">
            <button
              onClick={extractContactsFromGmail}
              disabled={extracting}
              className="flex items-center gap-2 px-6 py-2 bg-blue-600 text-white rounded-lg hover:bg-blue-700 disabled:opacity-50 disabled:cursor-not-allowed"
            >
              {extracting ? (
                <>
                  <RefreshCw className="h-5 w-5 animate-spin" />
                  Extracting... (may take a few minutes)
                </>
              ) : (
                <>
                  <Mail className="h-5 w-5" />
                  Extract Contacts from Gmail
                </>
              )}
            </button>
          </div>
        </div>

        {stats && (
          <div className={`border rounded-lg p-4 ${stats.new_contacts > 0 ? 'bg-green-50 border-green-200' : 'bg-blue-50 border-blue-200'}`}>
            <div className="flex items-start justify-between">
              <div className="flex items-start gap-2">
                <CheckCircle className={`h-5 w-5 mt-0.5 flex-shrink-0 ${stats.new_contacts > 0 ? 'text-green-600' : 'text-blue-600'}`} />
                <div>
                  <p className={`text-sm font-semibold ${stats.new_contacts > 0 ? 'text-green-900' : 'text-blue-900'}`}>
                    Extraction complete — {stats.new_contacts > 0 ? `${stats.new_contacts} new contacts added!` : 'No new contacts found.'}
                  </p>
                  <p className={`text-xs mt-1 ${stats.new_contacts > 0 ? 'text-green-700' : 'text-blue-700'}`}>
                    Scanned {stats.total_emails} emails &bull; Found {stats.total_contacts} contacts &bull; <strong>{stats.new_contacts} newly added</strong> &bull; {contacts.length - stats.new_contacts} already existed
                  </p>
                </div>
              </div>
              {stats.new_contacts > 0 && (
                <button
                  onClick={() => setFilterNew(f => !f)}
                  className={`flex items-center gap-1 px-3 py-1 rounded-full text-xs font-medium border transition-colors ${
                    filterNew
                      ? 'bg-green-600 text-white border-green-600'
                      : 'bg-white text-green-700 border-green-400 hover:bg-green-50'
                  }`}
                >
                  <Sparkles className="h-3 w-3" />
                  {filterNew ? `Showing ${stats.new_contacts} new` : `Show ${stats.new_contacts} new`}
                </button>
              )}
            </div>
          </div>
        )}
      </div>

      {contacts.length > 0 && (
        <div className="bg-white border border-gray-200 rounded-lg p-4">
          <div className="flex items-center justify-between mb-3">
            <div className="flex items-center gap-3">
              <h3 className="text-md font-semibold text-gray-900">
                {filterNew ? `New Contacts (${displayedContacts.length})` : `All Contacts (${contacts.length})`}
              </h3>
              {filterNew && (
                <button
                  onClick={() => setFilterNew(false)}
                  className="text-xs text-gray-500 hover:text-gray-700 underline"
                >
                  Show all {contacts.length}
                </button>
              )}
              <button
                onClick={toggleSelectAll}
                className="text-sm text-blue-600 hover:text-blue-700"
              >
                {selectedContacts.size === contacts.length ? 'Deselect All' : 'Select All'}
              </button>
              <span className="text-sm text-gray-500">{selectedContacts.size} selected</span>
            </div>

            <div className="flex items-center gap-2">
              <button
                onClick={exportToExcel}
                disabled={selectedContacts.size === 0}
                className="flex items-center gap-2 px-4 py-2 bg-green-600 text-white rounded-lg hover:bg-green-700 disabled:opacity-50 disabled:cursor-not-allowed text-sm"
              >
                <Download className="h-4 w-4" />
                Export Excel
              </button>

              <button
                onClick={importToCustomers}
                disabled={importing || selectedContacts.size === 0}
                className="flex items-center gap-2 px-4 py-2 bg-blue-600 text-white rounded-lg hover:bg-blue-700 disabled:opacity-50 disabled:cursor-not-allowed text-sm"
              >
                {importing ? <RefreshCw className="h-4 w-4 animate-spin" /> : <Upload className="h-4 w-4" />}
                Import to Customers
              </button>

              <button
                onClick={clearAllData}
                disabled={clearing}
                className="flex items-center gap-2 px-4 py-2 bg-red-600 text-white rounded-lg hover:bg-red-700 disabled:opacity-50 disabled:cursor-not-allowed text-sm"
              >
                {clearing ? <RefreshCw className="h-4 w-4 animate-spin" /> : <Trash2 className="h-4 w-4" />}
                Clear All
              </button>
            </div>
          </div>

          <div className="overflow-x-auto overflow-y-auto border border-gray-200 rounded-lg" style={{ maxHeight: '60vh' }}>
            <table className="min-w-full divide-y divide-gray-200">
              <thead className="bg-gray-50 sticky top-0 z-10">
                <tr>
                  <th className="px-4 py-3 text-left w-8">
                    <input
                      type="checkbox"
                      checked={selectedContacts.size === contacts.length && contacts.length > 0}
                      onChange={toggleSelectAll}
                      className="rounded border-gray-300"
                    />
                  </th>
                  <th className="px-4 py-3 text-left text-xs font-medium text-gray-500 uppercase tracking-wider">#</th>
                  <th className="px-4 py-3 text-left text-xs font-medium text-gray-500 uppercase tracking-wider">Company</th>
                  <th className="px-4 py-3 text-left text-xs font-medium text-gray-500 uppercase tracking-wider">Contact Person</th>
                  <th className="px-4 py-3 text-left text-xs font-medium text-gray-500 uppercase tracking-wider">Email</th>
                  <th className="px-4 py-3 text-left text-xs font-medium text-gray-500 uppercase tracking-wider">Phone</th>
                  <th className="px-4 py-3 text-left text-xs font-medium text-gray-500 uppercase tracking-wider">Mobile</th>
                  <th className="px-4 py-3 text-left text-xs font-medium text-gray-500 uppercase tracking-wider">Website</th>
                </tr>
              </thead>
              <tbody className="bg-white divide-y divide-gray-200">
                {displayedContacts.map((contact, displayIndex) => {
                  const originalIndex = contacts.indexOf(contact);
                  const isNew = contact.id ? newlyAddedIds.has(contact.id) : false;
                  return (
                    <tr
                      key={contact.id || displayIndex}
                      className={`${
                        isNew
                          ? 'bg-green-50 hover:bg-green-100'
                          : selectedContacts.has(originalIndex)
                          ? 'bg-blue-50 hover:bg-blue-100'
                          : 'hover:bg-gray-50'
                      }`}
                    >
                      <td className="px-4 py-3">
                        <input
                          type="checkbox"
                          checked={selectedContacts.has(originalIndex)}
                          onChange={() => toggleContact(originalIndex)}
                          className="rounded border-gray-300"
                        />
                      </td>
                      <td className="px-4 py-3 text-xs text-gray-400">
                        {isNew ? (
                          <span className="inline-flex items-center px-1.5 py-0.5 rounded text-xs font-semibold bg-green-100 text-green-800">NEW</span>
                        ) : (
                          originalIndex + 1
                        )}
                      </td>
                      <td className="px-4 py-3 text-sm text-gray-900 font-medium">{contact.companyName || '-'}</td>
                      <td className="px-4 py-3 text-sm text-gray-700">{contact.customerName || '-'}</td>
                      <td className="px-4 py-3 text-sm text-gray-600 max-w-xs truncate" title={contact.emailIds}>
                        {contact.emailIds || '-'}
                      </td>
                      <td className="px-4 py-3 text-sm text-gray-600">{contact.phone || '-'}</td>
                      <td className="px-4 py-3 text-sm text-gray-600">{contact.mobile || '-'}</td>
                      <td className="px-4 py-3 text-sm text-blue-600 max-w-xs truncate" title={contact.website}>
                        {contact.website || '-'}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        </div>
      )}
    </div>
  );
}
