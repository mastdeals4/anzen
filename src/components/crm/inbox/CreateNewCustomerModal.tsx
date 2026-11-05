import React, { useState } from 'react';
import { supabase } from '../../../lib/supabase';
import { showToast } from '../../ToastNotification';
import {
  UserPlus,
  Building2,
  User,
  Phone,
  Mail,
  MapPin,
  X,
  Briefcase,
} from 'lucide-react';

interface Props {
  isOpen: boolean;
  onClose: () => void;
  conversationId: string;
  rawPhone: string;
  normalizedPhone: string;
  onSuccess: () => void;
}

export function CreateNewCustomerModal({
  isOpen,
  onClose,
  conversationId,
  rawPhone,
  normalizedPhone,
  onSuccess,
}: Props) {
  const [companyName, setCompanyName] = useState('');
  const [contactPerson, setContactPerson] = useState('');
  const [department, setDepartment] = useState('Purchasing');
  const [email, setEmail] = useState('');
  const [city, setCity] = useState('Jakarta');
  const [address, setAddress] = useState('');
  const [customerType, setCustomerType] = useState('Pharma Manufacturer');
  const [saving, setSaving] = useState(false);

  const handleCreateCustomer = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!companyName.trim() || !contactPerson.trim() || !conversationId) {
      showToast({
        type: 'error',
        title: 'Validation Error',
        message: 'Company name and contact person are required.',
      });
      return;
    }

    setSaving(true);
    try {
      const phoneToSave = normalizedPhone || rawPhone;

      // 1. Insert into crm_contacts
      const { data: newContact, error: contactErr } = await supabase
        .from('crm_contacts')
        .insert({
          company_name: companyName.trim(),
          contact_person: contactPerson.trim(),
          designation: department,
          department: department,
          phone: phoneToSave,
          mobile: phoneToSave,
          email: email.trim() || null,
          city: city.trim() || null,
          address: address.trim() || null,
          customer_type: customerType,
          is_active: true,
        })
        .select('id, company_name')
        .single();

      if (contactErr) throw contactErr;

      // 2. Insert into crm_contact_phones
      const { error: phoneErr } = await supabase
        .from('crm_contact_phones')
        .insert({
          contact_id: newContact.id,
          company_name: newContact.company_name,
          contact_person: contactPerson.trim(),
          department: department,
          raw_phone: rawPhone || phoneToSave,
          normalized_phone: phoneToSave,
          country_code: '+62',
          country_name: 'Indonesia',
          phone_type: 'valid_mobile',
          is_whatsapp_eligible: true,
          is_primary: true,
          consent_status: 'opted_in',
        });

      if (phoneErr && !phoneErr.message.includes('duplicate')) {
        console.warn('Could not insert crm_contact_phones record:', phoneErr);
      }

      // 3. Update enquiry_conversations to link to this new contact
      const { error: convErr } = await supabase
        .from('enquiry_conversations')
        .update({
          crm_contact_id: newContact.id,
          title: `WhatsApp: ${newContact.company_name} (${phoneToSave})`,
          updated_at: new Date().toISOString(),
        })
        .eq('id', conversationId);

      if (convErr) throw convErr;

      showToast({
        type: 'success',
        title: 'Customer Created',
        message: `Created ${newContact.company_name} and linked WhatsApp conversation.`,
      });

      onSuccess();
      onClose();
    } catch (err: any) {
      console.error('Error creating customer from WhatsApp:', err);
      showToast({
        type: 'error',
        title: 'Creation Failed',
        message: err.message || 'Unable to create customer.',
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
            <div className="w-8 h-8 rounded-lg bg-emerald-100 text-emerald-700 flex items-center justify-center font-bold">
              <UserPlus className="w-4 h-4" />
            </div>
            <div>
              <h3 className="text-sm font-bold text-slate-900">Create New Customer</h3>
              <p className="text-xs text-slate-500">Save new customer profile & link this WhatsApp thread</p>
            </div>
          </div>
          <button
            onClick={onClose}
            className="p-1 text-slate-400 hover:text-slate-600 rounded transition"
          >
            <X className="w-5 h-5" />
          </button>
        </div>

        {/* Form */}
        <form onSubmit={handleCreateCustomer} className="p-5 space-y-3.5">
          {/* Target Phone Pill */}
          <div className="p-2.5 bg-emerald-50 border border-emerald-200 rounded-lg flex items-center justify-between text-xs">
            <span className="text-emerald-800 font-semibold flex items-center gap-1.5">
              <Phone className="w-3.5 h-3.5" />
              Incoming WhatsApp Number:
            </span>
            <span className="font-mono font-bold text-emerald-950 bg-white px-2 py-0.5 rounded border border-emerald-300">
              {normalizedPhone || rawPhone}
            </span>
          </div>

          {/* Company Name */}
          <div>
            <label className="block text-xs font-semibold text-slate-700 mb-1">
              Company Name <span className="text-red-500">*</span>
            </label>
            <div className="relative">
              <Building2 className="w-3.5 h-3.5 absolute left-3 top-2.5 text-slate-400" />
              <input
                type="text"
                required
                value={companyName}
                onChange={(e) => setCompanyName(e.target.value)}
                placeholder="e.g. PT Kimia Sejahtera"
                className="w-full pl-9 pr-3 py-1.5 text-xs border border-slate-300 rounded-md focus:outline-blue-500"
                autoFocus
              />
            </div>
          </div>

          {/* Contact Person & Department */}
          <div className="grid grid-cols-2 gap-3">
            <div>
              <label className="block text-xs font-semibold text-slate-700 mb-1">
                Contact Person <span className="text-red-500">*</span>
              </label>
              <div className="relative">
                <User className="w-3.5 h-3.5 absolute left-3 top-2.5 text-slate-400" />
                <input
                  type="text"
                  required
                  value={contactPerson}
                  onChange={(e) => setContactPerson(e.target.value)}
                  placeholder="e.g. Dr. Budi Santoso"
                  className="w-full pl-9 pr-3 py-1.5 text-xs border border-slate-300 rounded-md focus:outline-blue-500"
                />
              </div>
            </div>

            <div>
              <label className="block text-xs font-semibold text-slate-700 mb-1">
                Department
              </label>
              <select
                value={department}
                onChange={(e) => setDepartment(e.target.value)}
                className="w-full px-2.5 py-1.5 text-xs border border-slate-300 rounded-md focus:outline-blue-500 bg-white"
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

          {/* Email & Customer Type */}
          <div className="grid grid-cols-2 gap-3">
            <div>
              <label className="block text-xs font-semibold text-slate-700 mb-1">
                Email Address
              </label>
              <div className="relative">
                <Mail className="w-3.5 h-3.5 absolute left-3 top-2.5 text-slate-400" />
                <input
                  type="email"
                  value={email}
                  onChange={(e) => setEmail(e.target.value)}
                  placeholder="purchasing@company.com"
                  className="w-full pl-9 pr-3 py-1.5 text-xs border border-slate-300 rounded-md focus:outline-blue-500"
                />
              </div>
            </div>

            <div>
              <label className="block text-xs font-semibold text-slate-700 mb-1">
                Customer Type
              </label>
              <select
                value={customerType}
                onChange={(e) => setCustomerType(e.target.value)}
                className="w-full px-2.5 py-1.5 text-xs border border-slate-300 rounded-md focus:outline-blue-500 bg-white"
              >
                <option value="Pharma Manufacturer">Pharma Manufacturer</option>
                <option value="Food & Bev Manufacturer">Food & Bev Manufacturer</option>
                <option value="Cosmetics Manufacturer">Cosmetics Manufacturer</option>
                <option value="Distributor / Trader">Distributor / Trader</option>
                <option value="Other">Other</option>
              </select>
            </div>
          </div>

          {/* City & Address */}
          <div className="grid grid-cols-2 gap-3">
            <div>
              <label className="block text-xs font-semibold text-slate-700 mb-1">
                City / Region
              </label>
              <div className="relative">
                <MapPin className="w-3.5 h-3.5 absolute left-3 top-2.5 text-slate-400" />
                <input
                  type="text"
                  value={city}
                  onChange={(e) => setCity(e.target.value)}
                  placeholder="Jakarta, Surabaya, etc."
                  className="w-full pl-9 pr-3 py-1.5 text-xs border border-slate-300 rounded-md focus:outline-blue-500"
                />
              </div>
            </div>

            <div>
              <label className="block text-xs font-semibold text-slate-700 mb-1">
                Street Address (Optional)
              </label>
              <input
                type="text"
                value={address}
                onChange={(e) => setAddress(e.target.value)}
                placeholder="Jl. Industri No. ..."
                className="w-full px-3 py-1.5 text-xs border border-slate-300 rounded-md focus:outline-blue-500"
              />
            </div>
          </div>

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
              disabled={saving}
              className="px-4 py-1.5 text-xs font-semibold bg-emerald-600 text-white rounded hover:bg-emerald-700 shadow-2xs disabled:opacity-50 transition flex items-center gap-1.5"
            >
              <UserPlus className="w-3.5 h-3.5" />
              <span>{saving ? 'Creating...' : 'Create & Link Customer'}</span>
            </button>
          </div>
        </form>
      </div>
    </div>
  );
}
