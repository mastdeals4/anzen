import React, { useState } from 'react';
import { supabase } from '../../../lib/supabase';
import { showToast } from '../../ToastNotification';
import { ShieldCheck, CheckCircle2, XCircle, AlertCircle, X, Info } from 'lucide-react';

export interface PermissionTarget {
  id?: string;
  name?: string;
  company?: string;
  phone?: string;
  phoneRecordIds?: string[];
}

interface Props {
  isOpen: boolean;
  onClose: () => void;
  target: PermissionTarget | null;
  onSaved: () => void;
}

export function PermissionRecordingModal({ isOpen, onClose, target, onSaved }: Props) {
  const [source, setSource] = useState<string>('web_inquiry');
  const [evidence, setEvidence] = useState<string>('');
  const [categories, setCategories] = useState<string[]>(['price_alerts', 'customer_service']);
  const [saving, setSaving] = useState(false);

  if (!isOpen || !target) return null;

  const handleToggleCategory = (cat: string) => {
    setCategories(prev =>
      prev.includes(cat) ? prev.filter(c => c !== cat) : [...prev, cat]
    );
  };

  const handleSave = async (consentStatus: 'opted_in' | 'opted_out') => {
    if (consentStatus === 'opted_in' && !evidence.trim()) {
      showToast({
        type: 'warning',
        title: 'Evidence Required',
        message: 'Please provide genuine evidence or reference details for this opt-in permission.',
      });
      return;
    }

    setSaving(true);
    try {
      const nowIso = new Date().toISOString();
      const targetPhoneIds = target.phoneRecordIds || (target.id ? [target.id] : []);

      let query = supabase.from('crm_contact_phones').update({
        consent_status: consentStatus,
        opt_in_source: consentStatus === 'opted_in' ? source : null,
        opt_in_timestamp: consentStatus === 'opted_in' ? nowIso : null,
        opt_in_evidence: consentStatus === 'opted_in' ? evidence.trim() : 'Operator recorded opt-out suppression',
        permitted_categories: consentStatus === 'opted_in' ? categories : [],
        updated_at: nowIso,
      });

      if (targetPhoneIds.length > 0) {
        query = query.in('id', targetPhoneIds);
      } else if (target.phone) {
        query = query.eq('normalized_phone', target.phone);
      }

      const { error } = await query;
      if (error) throw error;

      showToast({
        type: 'success',
        title: consentStatus === 'opted_in' ? 'Permission Verified & Recorded' : 'Contact Opted Out',
        message:
          consentStatus === 'opted_in'
            ? 'Genuine opt-in permission recorded. Recipient is now cleared for live campaign dispatch.'
            : 'Contact marked as opted-out. All future WhatsApp broadcasts suppressed.',
      });

      onSaved();
      onClose();
    } catch (err: any) {
      showToast({
        type: 'error',
        title: 'Save Failed',
        message: err.message || 'Could not update contact consent status in database',
      });
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="fixed inset-0 z-50 bg-black/50 backdrop-blur-xs flex items-center justify-center p-4">
      <div className="bg-white rounded-xl shadow-2xl border border-gray-200 w-full max-w-lg p-5 space-y-4">
        {/* Header */}
        <div className="flex items-center justify-between border-b pb-3">
          <div className="flex items-center gap-2">
            <div className="p-2 bg-emerald-50 text-emerald-700 rounded-lg border border-emerald-200">
              <ShieldCheck className="w-5 h-5" />
            </div>
            <div>
              <h3 className="text-sm font-bold text-gray-900">Record Genuine Messaging Permission</h3>
              <p className="text-xs text-gray-500">
                Target: <span className="font-semibold text-gray-800">{target.company || target.name || 'Selected Contact(s)'}</span>
                {target.phone && <span className="font-mono text-gray-600 ml-1">({target.phone})</span>}
              </p>
            </div>
          </div>
          <button onClick={onClose} className="text-gray-400 hover:text-gray-600 p-1">
            <X className="w-4 h-4" />
          </button>
        </div>

        {/* Form Body */}
        <div className="space-y-3.5 text-xs text-gray-700">
          <div className="bg-blue-50/70 border border-blue-200 rounded-lg p-3 text-[11px] text-blue-900 flex items-start gap-2">
            <Info className="w-4 h-4 text-blue-600 shrink-0 mt-0.5" />
            <div>
              <strong>Compliance Rule:</strong> WhatsApp bulk messaging requires explicit, verifiable consent from the customer. Never fabricate consent or convert unverified contacts without actual business permission records.
            </div>
          </div>

          <div>
            <label className="font-bold text-gray-800 uppercase block mb-1">
              Permission Source / Evidence Channel
            </label>
            <select
              value={source}
              onChange={e => setSource(e.target.value)}
              className="w-full border border-gray-300 rounded-md p-2 bg-slate-50 text-gray-900 font-medium focus:bg-white"
            >
              <option value="web_inquiry">Website Inquiry Form / Catalog Download</option>
              <option value="customer_request">Direct Customer RFQ / Quotation Request</option>
              <option value="inbound_whatsapp">Inbound WhatsApp Chat Initiated by Customer</option>
              <option value="contract">Signed Commercial Agreement / Purchase Contract</option>
              <option value="trade_show">Trade Show / Physical Business Card Exchange</option>
              <option value="existing_business_consent">Documented Written B2B Messaging Permission</option>
            </select>
          </div>

          <div>
            <label className="font-bold text-gray-800 uppercase block mb-1">
              Evidence Reference / Notes <span className="text-rose-500">*</span>
            </label>
            <textarea
              value={evidence}
              onChange={e => setEvidence(e.target.value)}
              placeholder="e.g. Customer submitted inquiry form #1089 on 2026-11-10 requesting ready stock price list; or WhatsApp inquiry from Ms. Wulan."
              rows={3}
              className="w-full border border-gray-300 rounded-md p-2 text-xs focus:outline-blue-500"
              required
            />
          </div>

          <div>
            <label className="font-bold text-gray-800 uppercase block mb-1.5">
              Permitted Communication Categories
            </label>
            <div className="grid grid-cols-2 gap-2">
              <label className="flex items-center gap-2 p-2 rounded border border-gray-200 hover:bg-slate-50 cursor-pointer">
                <input
                  type="checkbox"
                  checked={categories.includes('price_alerts')}
                  onChange={() => handleToggleCategory('price_alerts')}
                  className="rounded text-emerald-600 focus:ring-emerald-500"
                />
                <span className="font-medium text-gray-800">Price Alerts & Stock</span>
              </label>

              <label className="flex items-center gap-2 p-2 rounded border border-gray-200 hover:bg-slate-50 cursor-pointer">
                <input
                  type="checkbox"
                  checked={categories.includes('customer_service')}
                  onChange={() => handleToggleCategory('customer_service')}
                  className="rounded text-emerald-600 focus:ring-emerald-500"
                />
                <span className="font-medium text-gray-800">Customer Service</span>
              </label>

              <label className="flex items-center gap-2 p-2 rounded border border-gray-200 hover:bg-slate-50 cursor-pointer">
                <input
                  type="checkbox"
                  checked={categories.includes('product_catalog')}
                  onChange={() => handleToggleCategory('product_catalog')}
                  className="rounded text-emerald-600 focus:ring-emerald-500"
                />
                <span className="font-medium text-gray-800">COA & Tech Catalog</span>
              </label>
            </div>
          </div>
        </div>

        {/* Footer Actions */}
        <div className="flex items-center justify-between pt-3 border-t">
          <button
            type="button"
            onClick={() => handleSave('opted_out')}
            disabled={saving}
            className="inline-flex items-center gap-1.5 px-3 py-1.5 bg-rose-50 hover:bg-rose-100 text-rose-800 border border-rose-200 rounded text-xs font-semibold transition cursor-pointer"
          >
            <XCircle className="w-3.5 h-3.5 text-rose-600" />
            Record Opt-Out (Suppress)
          </button>

          <div className="flex items-center gap-2">
            <button
              type="button"
              onClick={onClose}
              disabled={saving}
              className="px-3 py-1.5 text-xs text-gray-600 hover:bg-gray-100 rounded"
            >
              Cancel
            </button>
            <button
              type="button"
              onClick={() => handleSave('opted_in')}
              disabled={saving}
              className="inline-flex items-center gap-1.5 px-4 py-1.5 bg-emerald-600 hover:bg-emerald-700 text-white rounded text-xs font-bold shadow-xs transition cursor-pointer"
            >
              <CheckCircle2 className="w-3.5 h-3.5" />
              {saving ? 'Saving...' : 'Record Opt-In & Clear for Dispatch'}
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}
