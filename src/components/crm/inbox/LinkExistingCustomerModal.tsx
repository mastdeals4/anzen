import React, { useState, useEffect } from 'react';
import { supabase } from '../../../lib/supabase';
import { showToast } from '../../ToastNotification';
import {
  Search,
  Building,
  User,
  Phone,
  Link2,
  X,
  Check,
  Building2,
} from 'lucide-react';

interface Props {
  isOpen: boolean;
  onClose: () => void;
  conversationId: string;
  rawPhone: string;
  normalizedPhone: string;
  onSuccess: () => void;
}

interface CrmContactOption {
  id: string;
  company_name: string;
  contact_person: string | null;
  department?: string | null;
  designation?: string | null;
  phone: string | null;
  email: string | null;
  city: string | null;
}

export function LinkExistingCustomerModal({
  isOpen,
  onClose,
  conversationId,
  rawPhone,
  normalizedPhone,
  onSuccess,
}: Props) {
  const [search, setSearch] = useState('');
  const [contacts, setContacts] = useState<CrmContactOption[]>([]);
  const [selectedContact, setSelectedContact] = useState<CrmContactOption | null>(null);
  const [contactPerson, setContactPerson] = useState('');
  const [department, setDepartment] = useState('Purchasing');
  const [loading, setLoading] = useState(false);
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    if (!isOpen) return;
    searchContacts('');
  }, [isOpen]);

  const searchContacts = async (query: string) => {
    setLoading(true);
    try {
      let q = supabase
        .from('crm_contacts')
        .select('id, company_name, contact_person, designation, phone, email, city')
        .eq('is_active', true)
        .order('company_name', { ascending: true })
        .limit(25);

      if (query.trim()) {
        q = q.or(`company_name.ilike.%${query.trim()}%,contact_person.ilike.%${query.trim()}%,email.ilike.%${query.trim()}%`);
      }

      const { data, error } = await q;
      if (error) throw error;
      setContacts(data || []);
    } catch (err: any) {
      console.error('Error searching CRM contacts:', err);
    } finally {
      setLoading(false);
    }
  };

  const handleSelect = (c: CrmContactOption) => {
    setSelectedContact(c);
    setContactPerson(c.contact_person || '');
    if (c.designation) {
      setDepartment(c.designation);
    }
  };

  const handleSaveLink = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!selectedContact || !conversationId) return;

    setSaving(true);
    try {
      // 1. Insert or ensure phone record in crm_contact_phones
      const phonePayload = {
        contact_id: selectedContact.id,
        company_name: selectedContact.company_name,
        contact_person: contactPerson.trim() || selectedContact.contact_person || 'Representative',
        department: department.trim() || 'General',
        raw_phone: rawPhone || normalizedPhone,
        normalized_phone: normalizedPhone,
        country_code: '+62',
        country_name: 'Indonesia',
        phone_type: 'valid_mobile',
        is_whatsapp_eligible: true,
        is_primary: false,
        consent_status: 'opted_in',
      };

      const { error: phoneErr } = await supabase
        .from('crm_contact_phones')
        .insert(phonePayload);

      if (phoneErr && !phoneErr.message.includes('duplicate')) {
        console.warn('Could not insert crm_contact_phones record:', phoneErr);
      }

      // 2. Also check if ERP customer exists for linking
      const { data: erpCust } = await supabase
        .from('customers')
        .select('id')
        .ilike('company_name', selectedContact.company_name.trim())
        .maybeSingle();

      // 3. Update enquiry_conversations with crm_contact_id and customer_id
      const { error: convErr } = await supabase
        .from('enquiry_conversations')
        .update({
          crm_contact_id: selectedContact.id,
          customer_id: erpCust?.id || null,
          title: `WhatsApp: ${selectedContact.company_name} (${normalizedPhone})`,
          updated_at: new Date().toISOString(),
        })
        .eq('id', conversationId);

      if (convErr) throw convErr;

      showToast({
        type: 'success',
        title: 'Customer Linked',
        message: `Linked WhatsApp thread to ${selectedContact.company_name}`,
      });

      onSuccess();
      onClose();
    } catch (err: any) {
      console.error('Error linking customer to WhatsApp conversation:', err);
      showToast({
        type: 'error',
        title: 'Linking Failed',
        message: err.message || 'Unable to link customer to this conversation.',
      });
    } finally {
      setSaving(false);
    }
  };

  if (!isOpen) return null;

  return (
    <div className="fixed inset-0 z-50 overflow-y-auto bg-black/50 backdrop-blur-xs flex items-center justify-center p-4">
      <div className="bg-white rounded-xl shadow-2xl border border-slate-200 w-full max-w-lg overflow-hidden animate-in fade-in zoom-in-95 duration-150">
        {/* Header */}
        <div className="px-5 py-4 border-b border-slate-200 bg-slate-50/80 flex items-center justify-between">
          <div className="flex items-center gap-2.5">
            <div className="w-8 h-8 rounded-lg bg-blue-100 text-blue-700 flex items-center justify-center font-bold">
              <Link2 className="w-4 h-4" />
            </div>
            <div>
              <h3 className="text-sm font-bold text-slate-900">Link to Existing Customer</h3>
              <p className="text-xs text-slate-500">Connect this WhatsApp number to a saved CRM company</p>
            </div>
          </div>
          <button
            onClick={onClose}
            className="p-1 text-slate-400 hover:text-slate-600 rounded transition"
          >
            <X className="w-5 h-5" />
          </button>
        </div>

        {/* Form Body */}
        <form onSubmit={handleSaveLink} className="p-5 space-y-4">
          {/* Target Phone Pill */}
          <div className="p-2.5 bg-emerald-50 border border-emerald-200 rounded-lg flex items-center justify-between text-xs">
            <span className="text-emerald-800 font-semibold flex items-center gap-1.5">
              <Phone className="w-3.5 h-3.5" />
              WhatsApp Sender Number:
            </span>
            <span className="font-mono font-bold text-emerald-950 bg-white px-2 py-0.5 rounded border border-emerald-300">
              {normalizedPhone || rawPhone}
            </span>
          </div>

          {/* Search Box */}
          <div>
            <label className="block text-xs font-semibold text-slate-700 mb-1">
              Search Companies & Contacts
            </label>
            <div className="relative">
              <Search className="w-3.5 h-3.5 absolute left-3 top-2.5 text-slate-400" />
              <input
                type="text"
                value={search}
                onChange={(e) => {
                  setSearch(e.target.value);
                  searchContacts(e.target.value);
                }}
                placeholder="Type company name, contact, or email..."
                className="w-full pl-9 pr-3 py-1.5 text-xs border border-slate-300 rounded-md focus:outline-blue-500"
                autoFocus
              />
            </div>
          </div>

          {/* Results List */}
          <div className="border border-slate-200 rounded-md max-h-44 overflow-y-auto divide-y divide-slate-100 bg-slate-50/50">
            {loading ? (
              <div className="p-4 text-center text-xs text-slate-500">Searching contacts...</div>
            ) : contacts.length === 0 ? (
              <div className="p-4 text-center text-xs text-slate-500">No matching contacts found.</div>
            ) : (
              contacts.map((c) => {
                const isSelected = selectedContact?.id === c.id;
                return (
                  <button
                    key={c.id}
                    type="button"
                    onClick={() => handleSelect(c)}
                    className={`w-full text-left px-3 py-2 flex items-center justify-between transition text-xs ${
                      isSelected
                        ? 'bg-blue-50 text-blue-900 font-semibold border-l-4 border-blue-600'
                        : 'hover:bg-white text-slate-800'
                    }`}
                  >
                    <div className="min-w-0 pr-2">
                      <div className="font-bold flex items-center gap-1.5 truncate">
                        <Building2 className="w-3.5 h-3.5 text-blue-600 shrink-0" />
                        <span>{c.company_name}</span>
                      </div>
                      <div className="text-[11px] text-slate-500 truncate mt-0.5">
                        {c.contact_person || 'No contact named'} {c.city ? `• ${c.city}` : ''} {c.email ? `• ${c.email}` : ''}
                      </div>
                    </div>
                    {isSelected && <Check className="w-4 h-4 text-blue-600 shrink-0" />}
                  </button>
                );
              })
            )}
          </div>

          {/* Contact Person & Department specification for this number */}
          {selectedContact && (
            <div className="p-3 bg-slate-50 border border-slate-200 rounded-lg space-y-3">
              <div className="text-xs font-bold text-slate-800">
                Contact Person & Department for this number:
              </div>
              <div className="grid grid-cols-2 gap-2">
                <div>
                  <label className="block text-[11px] font-semibold text-slate-600 mb-1">
                    Contact Person Name
                  </label>
                  <input
                    type="text"
                    value={contactPerson}
                    onChange={(e) => setContactPerson(e.target.value)}
                    placeholder="e.g. Ibu Dewi / Willy"
                    className="w-full px-2.5 py-1 text-xs border border-slate-300 rounded bg-white"
                  />
                </div>
                <div>
                  <label className="block text-[11px] font-semibold text-slate-600 mb-1">
                    Department
                  </label>
                  <select
                    value={department}
                    onChange={(e) => setDepartment(e.target.value)}
                    className="w-full px-2 py-1 text-xs border border-slate-300 rounded bg-white"
                  >
                    <option value="Purchasing">Purchasing / Procurement</option>
                    <option value="Import">Import / Sourcing</option>
                    <option value="QA / QC">QA / QC</option>
                    <option value="Production">Production / Factory</option>
                    <option value="Sales">Sales / Commercial</option>
                    <option value="Management">Management / Director</option>
                    <option value="General">General Office</option>
                  </select>
                </div>
              </div>
            </div>
          )}

          {/* Actions */}
          <div className="flex items-center justify-end gap-2 pt-3 border-t border-slate-200">
            <button
              type="button"
              onClick={onClose}
              className="px-3 py-1.5 text-xs font-semibold text-slate-600 hover:bg-slate-100 rounded transition"
            >
              Cancel
            </button>
            <button
              type="submit"
              disabled={!selectedContact || saving}
              className="px-4 py-1.5 text-xs font-semibold bg-blue-600 text-white rounded hover:bg-blue-700 shadow-2xs disabled:opacity-50 transition flex items-center gap-1.5"
            >
              <Link2 className="w-3.5 h-3.5" />
              <span>{saving ? 'Linking...' : 'Save & Link Conversation'}</span>
            </button>
          </div>
        </form>
      </div>
    </div>
  );
}
