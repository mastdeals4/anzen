import { useState, useEffect } from 'react';
import { supabase } from '../../lib/supabase';
import { Mail, Download, Upload, RefreshCw, CheckCircle, AlertCircle, Users, Trash2 } from 'lucide-react';
import * as XLSX from 'xlsx';

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
}

export function ExtractData() {
  const [extracting, setExtracting] = useState(false);
  const [importing, setImporting] = useState(false);
  const [clearing, setClearing] = useState(false);
  const [loading, setLoading] = useState(true);
  const [contacts, setContacts] = useState<ExtractedContact[]>([]);
  const [stats, setStats] = useState<{ total_emails: number; total_contacts: number } | null>(null);
  const [selectedContacts, setSelectedContacts] = useState<Set<number>>(new Set());
  const [maxEmails, setMaxEmails] = useState(100);

  useEffect(() => {
    loadSavedContacts();
  }, []);

  const loadSavedContacts = async () => {
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
        }));
        setContacts(formattedContacts);
        setSelectedContacts(new Set(formattedContacts.map((_, i) => i)));
      }
    } catch (error) {
      console.error('Error loading contacts:', error);
    } finally {
      setLoading(false);
    }
  };

  const extractContactsFromGmail = async () => {
    setExtracting(true);
    try {
      const { data: { user } } = await supabase.auth.getUser();

      if (!user) {
        alert('Please log in to extract contacts.');
        return;
      }

      const { data: connection, error: connectionError } = await supabase
        .from('gmail_connections')
        .select('*')
        .eq('user_id', user.id)
        .eq('is_connected', true)
        .maybeSingle();

      if (connectionError && connectionError.code !== 'PGRST116') {
        console.error('Error fetching Gmail connection:', connectionError);
        alert(`Database error: ${connectionError.message}. Please contact support.`);
        return;
      }

      if (!connection || !connection.access_token || !connection.refresh_token) {
        alert('Gmail is not connected properly. Please reconnect Gmail in Settings → Gmail tab.');
        return;
      }

      const apiUrl = `${import.meta.env.VITE_SUPABASE_URL}/functions/v1/extract-gmail-contacts`;

      console.log('Calling edge function:', apiUrl);

      const response = await fetch(apiUrl, {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${import.meta.env.VITE_SUPABASE_ANON_KEY}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          access_token: connection.access_token,
          refresh_token: connection.refresh_token,
          max_emails: maxEmails,
          user_id: user.id,
          connection_id: connection.id,
        }),
      });

      console.log('Response status:', response.status);

      const result = await response.json();
      console.log('Response data:', result);

      if (!response.ok) {
        throw new Error(result.error || `HTTP ${response.status}: ${response.statusText}`);
      }

      if (result.success) {
        // Save new contacts to database
        if (result.contacts && result.contacts.length > 0) {
          const contactsToInsert = result.contacts.map((contact: any) => ({
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

          const { error: insertError } = await supabase
            .from('extracted_contacts')
            .insert(contactsToInsert);

          if (insertError) {
            console.error('Error saving contacts:', insertError);
            alert('Contacts extracted but failed to save to database. Please try again.');
            return;
          }

          // Reload all contacts from database
          await loadSavedContacts();
        }

        setStats({
          total_emails: result.total_emails_scanned || result.total_emails,
          total_contacts: result.total_contacts,
        });

        if (result.message) {
          alert(`Success! ${result.message}\n\nContacts saved to database and will persist across refreshes.`);
        }
      } else {
        throw new Error(result.error || 'Failed to extract contacts');
      }
    } catch (error: any) {
      console.error('Error extracting contacts:', error);
      const errorMessage = error.message || 'Unknown error occurred';
      alert(`Failed to extract contacts: ${errorMessage}\n\nPlease check:\n1. Gmail is connected in Settings → Gmail tab\n2. Your Gmail connection hasn't expired\n3. Try reconnecting Gmail if issues persist`);
    } finally {
      setExtracting(false);
    }
  };

  const exportToExcel = () => {
    if (contacts.length === 0) {
      alert('No contacts to export');
      return;
    }

    const selectedData = contacts.filter((_, i) => selectedContacts.has(i));

    const worksheet = XLSX.utils.json_to_sheet(
      selectedData.map(contact => ({
        'Company Name': contact.companyName,
        'Customer Name': contact.customerName,
        'Email IDs': contact.emailIds,
        'Phone': contact.phone,
        'Mobile': contact.mobile,
        'Website': contact.website,
        'Address': contact.address,
        'Source': contact.source,
      }))
    );

    const workbook = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(workbook, worksheet, 'Clients');

    const colWidths = [
      { wch: 30 },
      { wch: 25 },
      { wch: 40 },
      { wch: 18 },
      { wch: 18 },
      { wch: 30 },
      { wch: 40 },
      { wch: 12 },
    ];
    worksheet['!cols'] = colWidths;

    XLSX.writeFile(workbook, `Extracted_Contacts_${new Date().toISOString().split('T')[0]}.xlsx`);
  };

  const importToCustomers = async () => {
    if (selectedContacts.size === 0) {
      alert('Please select contacts to import');
      return;
    }

    const confirmed = confirm(
      `Are you sure you want to import ${selectedContacts.size} contact(s) to the Customers database?\n\nThis will create new customer records for selected contacts.`
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

      const { data, error } = await supabase
        .from('customers')
        .upsert(customersToInsert, {
          onConflict: 'email',
          ignoreDuplicates: false,
        })
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
    if (contacts.length === 0) {
      alert('No contacts to clear');
      return;
    }

    const confirmed = confirm(
      `Are you sure you want to PERMANENTLY DELETE all ${contacts.length} extracted contact(s)?\n\nThis action cannot be undone!`
    );

    if (!confirmed) return;

    setClearing(true);
    try {
      const { data: { user } } = await supabase.auth.getUser();
      if (!user) return;

      const { error } = await supabase
        .from('extracted_contacts')
        .delete()
        .eq('user_id', user.id);

      if (error) throw error;

      setContacts([]);
      setSelectedContacts(new Set());
      setStats(null);
      alert('All extracted contacts have been cleared successfully!');
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
          AI-powered extraction of contact information from Gmail using OpenAI. The system intelligently extracts company names, contacts, phone numbers, and websites from email signatures. All extracted data is saved to database and persists across page refreshes.
        </p>
        <div className="mt-2 bg-blue-50 border border-blue-200 rounded-lg p-3">
          <p className="text-xs text-blue-900 font-medium">
            AI-Powered Features:
          </p>
          <ul className="text-xs text-blue-700 mt-1 space-y-1 ml-4 list-disc">
            <li>AI extracts REAL company names from signatures (e.g., "PT Genero Pharmaceuticals")</li>
            <li>Filters out email greetings, body text, and system emails</li>
            <li>Tracks processed emails - click again to get NEXT batch of NEW emails</li>
            <li>All extracted contacts are saved permanently in database</li>
            <li>High-quality extraction - processes 100-500 emails (takes time for AI quality)</li>
          </ul>
        </div>
      </div>

      <div className="bg-white border border-gray-200 rounded-lg p-6 space-y-4">
        <div className="flex items-center gap-4">
          <div className="flex-1">
            <label className="block text-sm font-medium text-gray-700 mb-2">
              Maximum Emails to Scan
            </label>
            <input
              type="number"
              value={maxEmails}
              onChange={(e) => setMaxEmails(Math.max(50, Math.min(500, parseInt(e.target.value) || 100)))}
              min="50"
              max="500"
              step="50"
              className="w-48 px-3 py-2 border border-gray-300 rounded-lg focus:ring-2 focus:ring-blue-500"
            />
            <p className="text-xs text-gray-500 mt-1">Range: 50 - 500 emails. Recommended: 100-200 for quality</p>
          </div>

          <div className="flex-shrink-0 pt-6">
            <button
              onClick={extractContactsFromGmail}
              disabled={extracting}
              className="flex items-center gap-2 px-6 py-2 bg-blue-600 text-white rounded-lg hover:bg-blue-700 disabled:opacity-50 disabled:cursor-not-allowed"
            >
              {extracting ? (
                <>
                  <RefreshCw className="h-5 w-5 animate-spin" />
                  Extracting...
                </>
              ) : (
                <>
                  <Mail className="h-5 w-5" />
                  Extract Contacts
                </>
              )}
            </button>
          </div>
        </div>

        {stats && (
          <div className="bg-blue-50 border border-blue-200 rounded-lg p-4">
            <div className="flex items-start">
              <CheckCircle className="h-5 w-5 text-blue-600 mr-2 mt-0.5 flex-shrink-0" />
              <div>
                <p className="text-sm text-blue-900 font-medium">
                  AI Extraction completed successfully!
                </p>
                <p className="text-xs text-blue-700 mt-1">
                  AI processed {stats.total_emails} NEW unprocessed emails and extracted {stats.total_contacts} high-quality contacts
                </p>
                <p className="text-xs text-blue-600 mt-1">
                  Click "Extract Contacts" again to process the next batch of NEW emails
                </p>
              </div>
            </div>
          </div>
        )}
      </div>

      {contacts.length > 0 && (
        <>
          <div className="bg-white border border-gray-200 rounded-lg p-4">
            <div className="flex items-center justify-between mb-4">
              <div className="flex items-center gap-3">
                <h3 className="text-md font-semibold text-gray-900">
                  Extracted Contacts ({selectedContacts.size} selected)
                </h3>
                <button
                  onClick={toggleSelectAll}
                  className="text-sm text-blue-600 hover:text-blue-700"
                >
                  {selectedContacts.size === contacts.length ? 'Deselect All' : 'Select All'}
                </button>
              </div>

              <div className="flex items-center gap-2">
                <button
                  onClick={exportToExcel}
                  disabled={selectedContacts.size === 0}
                  className="flex items-center gap-2 px-4 py-2 bg-green-600 text-white rounded-lg hover:bg-green-700 disabled:opacity-50 disabled:cursor-not-allowed"
                >
                  <Download className="h-4 w-4" />
                  Export to Excel
                </button>

                <button
                  onClick={importToCustomers}
                  disabled={importing || selectedContacts.size === 0}
                  className="flex items-center gap-2 px-4 py-2 bg-blue-600 text-white rounded-lg hover:bg-blue-700 disabled:opacity-50 disabled:cursor-not-allowed"
                >
                  {importing ? (
                    <>
                      <RefreshCw className="h-4 w-4 animate-spin" />
                      Importing...
                    </>
                  ) : (
                    <>
                      <Upload className="h-4 w-4" />
                      Import to Customers
                    </>
                  )}
                </button>

                <button
                  onClick={clearAllData}
                  disabled={clearing || contacts.length === 0}
                  className="flex items-center gap-2 px-4 py-2 bg-red-600 text-white rounded-lg hover:bg-red-700 disabled:opacity-50 disabled:cursor-not-allowed"
                >
                  {clearing ? (
                    <>
                      <RefreshCw className="h-4 w-4 animate-spin" />
                      Clearing...
                    </>
                  ) : (
                    <>
                      <Trash2 className="h-4 w-4" />
                      Clear All Data
                    </>
                  )}
                </button>
              </div>
            </div>

            <div className="overflow-x-auto max-h-96 overflow-y-auto border border-gray-200 rounded-lg">
              <table className="min-w-full divide-y divide-gray-200">
                <thead className="bg-gray-50 sticky top-0">
                  <tr>
                    <th className="px-4 py-3 text-left">
                      <input
                        type="checkbox"
                        checked={selectedContacts.size === contacts.length}
                        onChange={toggleSelectAll}
                        className="rounded border-gray-300"
                      />
                    </th>
                    <th className="px-4 py-3 text-left text-xs font-medium text-gray-500 uppercase">Company</th>
                    <th className="px-4 py-3 text-left text-xs font-medium text-gray-500 uppercase">Contact Person</th>
                    <th className="px-4 py-3 text-left text-xs font-medium text-gray-500 uppercase">Email IDs</th>
                    <th className="px-4 py-3 text-left text-xs font-medium text-gray-500 uppercase">Phone</th>
                    <th className="px-4 py-3 text-left text-xs font-medium text-gray-500 uppercase">Mobile</th>
                    <th className="px-4 py-3 text-left text-xs font-medium text-gray-500 uppercase">Website</th>
                  </tr>
                </thead>
                <tbody className="bg-white divide-y divide-gray-200">
                  {contacts.map((contact, index) => (
                    <tr
                      key={index}
                      className={`hover:bg-gray-50 ${selectedContacts.has(index) ? 'bg-blue-50' : ''}`}
                    >
                      <td className="px-4 py-3">
                        <input
                          type="checkbox"
                          checked={selectedContacts.has(index)}
                          onChange={() => toggleContact(index)}
                          className="rounded border-gray-300"
                        />
                      </td>
                      <td className="px-4 py-3 text-sm text-gray-900">{contact.companyName || '-'}</td>
                      <td className="px-4 py-3 text-sm text-gray-900">{contact.customerName || '-'}</td>
                      <td className="px-4 py-3 text-sm text-gray-600 max-w-xs truncate" title={contact.emailIds}>
                        {contact.emailIds || '-'}
                      </td>
                      <td className="px-4 py-3 text-sm text-gray-600">{contact.phone || '-'}</td>
                      <td className="px-4 py-3 text-sm text-gray-600">{contact.mobile || '-'}</td>
                      <td className="px-4 py-3 text-sm text-blue-600 max-w-xs truncate" title={contact.website}>
                        {contact.website || '-'}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </div>

          <div className="bg-yellow-50 border border-yellow-200 rounded-lg p-4">
            <div className="flex items-start">
              <AlertCircle className="h-5 w-5 text-yellow-600 mr-2 mt-0.5 flex-shrink-0" />
              <div>
                <p className="text-sm text-yellow-900 font-medium">
                  Review before importing
                </p>
                <p className="text-xs text-yellow-700 mt-1">
                  Please review the extracted contacts carefully. The system attempts to deduplicate and merge contacts from the same company, but you should verify the data before importing to your customer database.
                </p>
              </div>
            </div>
          </div>
        </>
      )}
    </div>
  );
}
