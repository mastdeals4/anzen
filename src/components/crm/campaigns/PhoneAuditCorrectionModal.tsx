import React, { useState, useMemo, useCallback } from 'react';
import { supabase } from '../../../lib/supabase';
import { showToast } from '../../ToastNotification';
import {
  VerifiedContactItem,
  PhoneAuditResult,
  PhoneValidationResult,
  validatePhoneNumber,
  suggestCleanMobileNumber,
  detectCountryInfo,
  groupDuplicates,
  DuplicateGroup,
  getBulkNormalizationCandidates,
  BulkNormalizationCandidate,
} from '../../../utils/phoneValidation';
import {
  X,
  Search,
  Filter,
  CheckCircle2,
  AlertTriangle,
  Phone,
  Smartphone,
  Copy,
  Check,
  RotateCcw,
  Sparkles,
  ExternalLink,
  Building,
  User,
  ShieldCheck,
  AlertCircle,
  ArrowRight,
  Info,
  SlidersHorizontal,
  ChevronDown,
  Layers,
  FileCheck,
  Loader2,
} from 'lucide-react';

export type AuditCategory = 'total' | 'eligible' | 'landline' | 'missing' | 'invalid' | 'duplicates';

interface ContactRecipient {
  id: string;
  company_name: string;
  contact_person: string | null;
  email: string | null;
  phone: string | null;
  mobile: string | null;
  city: string | null;
  customer_type?: string | null;
  is_active: boolean;
}

interface PhoneAuditCorrectionModalProps {
  isOpen: boolean;
  onClose: () => void;
  initialCategory: AuditCategory;
  contacts: ContactRecipient[];
  phoneAudit: PhoneAuditResult;
  onContactUpdated: (updatedContact: ContactRecipient) => void;
  onContactsBatchUpdated: (updatedContacts: ContactRecipient[]) => void;
}

export function PhoneAuditCorrectionModal({
  isOpen,
  onClose,
  initialCategory,
  contacts,
  phoneAudit,
  onContactUpdated,
  onContactsBatchUpdated,
}: PhoneAuditCorrectionModalProps) {
  const [selectedCategory, setSelectedCategory] = useState<AuditCategory>(initialCategory);
  const [searchQuery, setSearchQuery] = useState('');
  const [reasonFilter, setReasonFilter] = useState<string>('all');
  const [countryFilter, setCountryFilter] = useState<string>('all');
  const [sortField, setSortField] = useState<'company' | 'phone' | 'status'>('company');
  const [sortAsc, setSortAsc] = useState(true);
  const [duplicateViewMode, setDuplicateViewMode] = useState<'grouped' | 'flat'>('grouped');

  // Inline edit state: contactId -> edited phone string
  const [editedPhones, setEditedPhones] = useState<Record<string, string>>({});
  const [savingRows, setSavingRows] = useState<Record<string, boolean>>({});
  const [copiedId, setCopiedId] = useState<string | null>(null);

  // Bulk normalization preview modal state
  const [showBulkPreview, setShowBulkPreview] = useState(false);
  const [selectedBulkCandidateIds, setSelectedBulkCandidateIds] = useState<Set<string>>(new Set());
  const [isApplyingBulk, setIsApplyingBulk] = useState(false);

  // Sync initial category when opening
  React.useEffect(() => {
    setSelectedCategory(initialCategory);
  }, [initialCategory]);

  // Copy phone number helper
  const handleCopyPhone = useCallback((phone: string, id: string) => {
    if (!phone) return;
    navigator.clipboard.writeText(phone);
    setCopiedId(id);
    setTimeout(() => setCopiedId(null), 2000);
  }, []);

  // Filter items based on selected category
  const categoryItems = useMemo(() => {
    switch (selectedCategory) {
      case 'eligible':
        return phoneAudit.items.filter(i => i.is_eligible);
      case 'landline':
        return phoneAudit.items.filter(i => i.validation.type === 'landline');
      case 'missing':
        return phoneAudit.items.filter(i => i.validation.type === 'missing_number');
      case 'invalid':
        return phoneAudit.items.filter(i => i.validation.type === 'invalid_number');
      case 'duplicates':
        return phoneAudit.items.filter(i => i.is_duplicate);
      case 'total':
      default:
        return phoneAudit.items;
    }
  }, [phoneAudit.items, selectedCategory]);

  // Extract distinct reasons for filter dropdown in current category
  const distinctReasons = useMemo(() => {
    const reasons = new Set<string>();
    categoryItems.forEach(i => {
      if (i.validation.reason) reasons.add(i.validation.reason);
    });
    return Array.from(reasons).sort();
  }, [categoryItems]);

  // Extract distinct countries
  const distinctCountries = useMemo(() => {
    const countries = new Set<string>();
    categoryItems.forEach(i => {
      const info = detectCountryInfo(i.raw_phone, i.city);
      countries.add(info.name);
    });
    return Array.from(countries).sort();
  }, [categoryItems]);

  // Filter and sort items for the table
  const filteredItems = useMemo(() => {
    let list = categoryItems;

    // Search query
    if (searchQuery.trim()) {
      const q = searchQuery.toLowerCase().trim();
      list = list.filter(item => {
        const comp = (item.company_name || '').toLowerCase();
        const contact = (item.contact_person || '').toLowerCase();
        const raw = (item.raw_phone || '').toLowerCase();
        const norm = (item.validation.normalized || '').toLowerCase();
        return comp.includes(q) || contact.includes(q) || raw.includes(q) || norm.includes(q);
      });
    }

    // Reason filter
    if (reasonFilter !== 'all') {
      list = list.filter(item => item.validation.reason === reasonFilter);
    }

    // Country filter
    if (countryFilter !== 'all') {
      list = list.filter(item => {
        const info = detectCountryInfo(item.raw_phone, item.city);
        return info.name === countryFilter;
      });
    }

    // Sorting
    return [...list].sort((a, b) => {
      let cmp = 0;
      if (sortField === 'company') {
        cmp = a.company_name.localeCompare(b.company_name);
      } else if (sortField === 'phone') {
        const pA = a.raw_phone || '';
        const pB = b.raw_phone || '';
        cmp = pA.localeCompare(pB);
      } else if (sortField === 'status') {
        cmp = a.validation.type.localeCompare(b.validation.type);
      }
      return sortAsc ? cmp : -cmp;
    });
  }, [categoryItems, searchQuery, reasonFilter, countryFilter, sortField, sortAsc]);

  // Grouped duplicates structure
  const duplicateGroups = useMemo(() => {
    return groupDuplicates(phoneAudit.items);
  }, [phoneAudit.items]);

  // Filtered duplicate groups for search
  const filteredDuplicateGroups = useMemo(() => {
    if (!searchQuery.trim()) return duplicateGroups;
    const q = searchQuery.toLowerCase().trim();
    return duplicateGroups.filter(group => {
      const matchPhone = group.normalizedPhone.toLowerCase().includes(q);
      const matchComp = group.companies.some(c => c.toLowerCase().includes(q));
      const matchContact = group.contacts.some(c => (c.contact_person || '').toLowerCase().includes(q));
      return matchPhone || matchComp || matchContact;
    });
  }, [duplicateGroups, searchQuery]);

  // Bulk normalization candidates across all contacts
  const bulkCandidates = useMemo(() => {
    return getBulkNormalizationCandidates(phoneAudit.items);
  }, [phoneAudit.items]);

  // Initialize selected candidates when preview opens
  const handleOpenBulkPreview = useCallback(() => {
    setSelectedBulkCandidateIds(new Set(bulkCandidates.map(c => c.contactId)));
    setShowBulkPreview(true);
  }, [bulkCandidates]);

  // Inline value getter: returns user-typed value or current raw value
  const getInputValue = useCallback((item: VerifiedContactItem): string => {
    if (editedPhones[item.id] !== undefined) {
      return editedPhones[item.id];
    }
    return item.raw_phone || '';
  }, [editedPhones]);

  // Handle inline change
  const handleInputChange = useCallback((contactId: string, value: string) => {
    setEditedPhones(prev => ({ ...prev, [contactId]: value }));
  }, []);

  // Quick auto-clean button per row
  const handleApplyQuickClean = useCallback((item: VerifiedContactItem) => {
    const raw = item.raw_phone || '';
    const suggested = suggestCleanMobileNumber(raw);
    if (suggested) {
      setEditedPhones(prev => ({ ...prev, [item.id]: suggested }));
    }
  }, []);

  // Save single contact phone update to Supabase
  const handleSaveContact = async (item: VerifiedContactItem) => {
    const newNumber = (editedPhones[item.id] !== undefined ? editedPhones[item.id] : item.raw_phone || '').trim();
    const oldRaw = item.raw_phone || '';

    if (newNumber === oldRaw) {
      showToast({ type: 'info', title: 'No Changes', message: 'Phone number has not been modified.' });
      return;
    }

    setSavingRows(prev => ({ ...prev, [item.id]: true }));
    try {
      // Validate the new number
      const newValidation = validatePhoneNumber(newNumber);

      // In crm_contacts, if it is a mobile number, save to mobile column; otherwise update mobile or phone
      const updatePayload: Record<string, any> = {
        updated_at: new Date().toISOString(),
      };

      if (newValidation.type === 'valid_mobile' || newValidation.type === 'international_number') {
        updatePayload.mobile = newValidation.normalized;
      } else if (newValidation.type === 'landline') {
        updatePayload.phone = newValidation.normalized;
        updatePayload.landline = newValidation.normalized;
      } else {
        updatePayload.mobile = newNumber || null;
      }

      // 1. Update Supabase crm_contacts
      const { error: updateError } = await supabase
        .from('crm_contacts')
        .update(updatePayload)
        .eq('id', item.id);

      if (updateError) throw updateError;

      // 2. Insert audit note in crm_activities
      try {
        await supabase.from('crm_activities').insert({
          customer_id: item.id,
          activity_type: 'note',
          subject: 'Phone Number Audit Correction',
          description: `Phone audit correction: Mobile updated from "${oldRaw || 'None'}" to "${updatePayload.mobile || updatePayload.phone || newNumber}". Classification: ${newValidation.type} (${newValidation.reason}).`,
          is_completed: true,
          completed_at: new Date().toISOString(),
        });
      } catch (logErr: any) {
        console.warn('Activity log note warning:', logErr);
      }

      // 3. Update local state
      const targetContact = contacts.find(c => c.id === item.id);
      if (targetContact) {
        const updatedContact: ContactRecipient = {
          ...targetContact,
          mobile: updatePayload.mobile !== undefined ? updatePayload.mobile : targetContact.mobile,
          phone: updatePayload.phone !== undefined ? updatePayload.phone : targetContact.phone,
        };
        onContactUpdated(updatedContact);
      }

      // Clear edit cache for this row
      setEditedPhones(prev => {
        const next = { ...prev };
        delete next[item.id];
        return next;
      });

      showToast({
        type: 'success',
        title: 'Phone Saved & Verified',
        message: `${item.company_name} updated to ${updatePayload.mobile || updatePayload.phone || newNumber} (${newValidation.type === 'valid_mobile' ? 'WhatsApp Eligible' : newValidation.type})`,
      });
    } catch (err: any) {
      console.error('Failed to update contact phone:', err);
      showToast({
        type: 'error',
        title: 'Update Failed',
        message: err.message || 'Could not update CRM contact record',
      });
    } finally {
      setSavingRows(prev => ({ ...prev, [item.id]: false }));
    }
  };

  // Bulk Normalization Execution
  const handleApplyBulkNormalization = async () => {
    const toApply = bulkCandidates.filter(c => selectedBulkCandidateIds.has(c.contactId));
    if (toApply.length === 0) {
      showToast({ type: 'info', title: 'None Selected', message: 'Select at least one candidate to normalize.' });
      return;
    }

    setIsApplyingBulk(true);
    const updatedContactsList: ContactRecipient[] = [];
    let successCount = 0;
    let failCount = 0;

    for (const cand of toApply) {
      try {
        const { error } = await supabase
          .from('crm_contacts')
          .update({
            mobile: cand.proposedNormalized,
            updated_at: new Date().toISOString(),
          })
          .eq('id', cand.contactId);

        if (error) throw error;

        // Audit note
        try {
          await supabase.from('crm_activities').insert({
            customer_id: cand.contactId,
            activity_type: 'note',
            subject: 'Bulk Phone Formatting Normalization',
            description: `Bulk normalized mobile from "${cand.currentRaw}" to "${cand.proposedNormalized}".`,
            is_completed: true,
            completed_at: new Date().toISOString(),
          });
        } catch {
          // ignore non-critical activity log failure
        }

        const target = contacts.find(c => c.id === cand.contactId);
        if (target) {
          updatedContactsList.push({
            ...target,
            mobile: cand.proposedNormalized,
          });
        }
        successCount++;
      } catch (err) {
        console.error(`Failed to normalize ${cand.companyName}:`, err);
        failCount++;
      }
    }

    if (updatedContactsList.length > 0) {
      onContactsBatchUpdated(updatedContactsList);
    }

    setIsApplyingBulk(false);
    setShowBulkPreview(false);

    showToast({
      type: successCount > 0 ? 'success' : 'error',
      title: 'Bulk Normalization Complete',
      message: `Successfully normalized ${successCount} contact mobile numbers${failCount > 0 ? ` (${failCount} failed)` : ''}.`,
    });
  };

  if (!isOpen) return null;

  return (
    <div className="fixed inset-0 z-50 bg-slate-900/60 backdrop-blur-xs flex items-center justify-center p-2 sm:p-4 overflow-hidden animate-in fade-in duration-150">
      <div className="bg-white w-full max-w-7xl max-h-[94vh] rounded-xl shadow-2xl flex flex-col border border-slate-200 overflow-hidden">
        
        {/* ==================================================================== */}
        {/* 1. MODAL HEADER & SUMMARY STRIP                                      */}
        {/* ==================================================================== */}
        <div className="px-5 py-3.5 bg-slate-50 border-b border-slate-200 flex flex-col sm:flex-row sm:items-center justify-between gap-3 shrink-0">
          <div className="flex items-center gap-2.5">
            <div className="w-9 h-9 rounded-lg bg-emerald-600 text-white flex items-center justify-center shadow-xs">
              <Smartphone className="w-5 h-5" />
            </div>
            <div>
              <div className="flex items-center gap-2">
                <h2 className="text-sm font-bold text-gray-900 uppercase tracking-wide">
                  Contact Phone Audit & Correction Centre
                </h2>
                <span className="text-[11px] font-semibold bg-emerald-100 text-emerald-800 px-2 py-0.5 rounded border border-emerald-300">
                  {phoneAudit.stats.total} Records Analyzed
                </span>
              </div>
              <p className="text-[11px] text-gray-500">
                Inspect, format, correct, and verify customer mobile numbers directly for WhatsApp Business compliance
              </p>
            </div>
          </div>

          <div className="flex items-center gap-2">
            {bulkCandidates.length > 0 && (
              <button
                type="button"
                onClick={handleOpenBulkPreview}
                className="inline-flex items-center gap-1.5 px-3 py-1.5 bg-indigo-50 hover:bg-indigo-100 text-indigo-700 border border-indigo-200 rounded-md text-xs font-bold transition shadow-2xs cursor-pointer"
                title="Preview and bulk-normalize unambiguous 08... and 628... formatting errors"
              >
                <Sparkles className="w-3.5 h-3.5 text-indigo-600" />
                Bulk Normalization ({bulkCandidates.length})
              </button>
            )}

            <button
              type="button"
              onClick={onClose}
              className="p-1.5 text-gray-400 hover:text-gray-700 hover:bg-gray-200 rounded-md transition"
              title="Close Audit Centre"
            >
              <X className="w-5 h-5" />
            </button>
          </div>
        </div>

        {/* ==================================================================== */}
        {/* 2. SIX INTERACTIVE CATEGORY PILLS                                   */}
        {/* ==================================================================== */}
        <div className="px-5 py-2.5 bg-white border-b border-slate-200 flex items-center justify-between gap-2 overflow-x-auto shrink-0">
          <div className="flex items-center gap-1.5 text-xs">
            {/* Total Directory */}
            <button
              type="button"
              onClick={() => { setSelectedCategory('total'); setReasonFilter('all'); }}
              className={`px-3 py-1.5 rounded-md font-bold transition flex items-center gap-1.5 cursor-pointer border ${
                selectedCategory === 'total'
                  ? 'bg-slate-800 text-white border-slate-900 shadow-xs'
                  : 'bg-slate-50 text-slate-700 border-slate-200 hover:bg-slate-100'
              }`}
            >
              <span>Total Directory</span>
              <span className={`text-[10px] px-1.5 py-0.2 rounded font-extrabold ${
                selectedCategory === 'total' ? 'bg-slate-700 text-white' : 'bg-slate-200 text-slate-800'
              }`}>
                {phoneAudit.stats.total}
              </span>
            </button>

            {/* WA Eligible */}
            <button
              type="button"
              onClick={() => { setSelectedCategory('eligible'); setReasonFilter('all'); }}
              className={`px-3 py-1.5 rounded-md font-bold transition flex items-center gap-1.5 cursor-pointer border ${
                selectedCategory === 'eligible'
                  ? 'bg-emerald-600 text-white border-emerald-700 shadow-xs'
                  : 'bg-emerald-50 text-emerald-800 border-emerald-200 hover:bg-emerald-100'
              }`}
            >
              <CheckCircle2 className="w-3.5 h-3.5" />
              <span>WhatsApp Eligible</span>
              <span className={`text-[10px] px-1.5 py-0.2 rounded font-extrabold ${
                selectedCategory === 'eligible' ? 'bg-emerald-700 text-white' : 'bg-emerald-200 text-emerald-900'
              }`}>
                {phoneAudit.stats.eligible}
              </span>
            </button>

            {/* Landlines */}
            <button
              type="button"
              onClick={() => { setSelectedCategory('landline'); setReasonFilter('all'); }}
              className={`px-3 py-1.5 rounded-md font-bold transition flex items-center gap-1.5 cursor-pointer border ${
                selectedCategory === 'landline'
                  ? 'bg-amber-600 text-white border-amber-700 shadow-xs'
                  : 'bg-amber-50 text-amber-800 border-amber-200 hover:bg-amber-100'
              }`}
            >
              <Phone className="w-3.5 h-3.5" />
              <span>Landlines</span>
              <span className={`text-[10px] px-1.5 py-0.2 rounded font-extrabold ${
                selectedCategory === 'landline' ? 'bg-amber-700 text-white' : 'bg-amber-200 text-amber-900'
              }`}>
                {phoneAudit.stats.landline}
              </span>
            </button>

            {/* Missing Number */}
            <button
              type="button"
              onClick={() => { setSelectedCategory('missing'); setReasonFilter('all'); }}
              className={`px-3 py-1.5 rounded-md font-bold transition flex items-center gap-1.5 cursor-pointer border ${
                selectedCategory === 'missing'
                  ? 'bg-slate-600 text-white border-slate-700 shadow-xs'
                  : 'bg-slate-100 text-slate-700 border-slate-200 hover:bg-slate-200'
              }`}
            >
              <AlertCircle className="w-3.5 h-3.5" />
              <span>Missing Number</span>
              <span className={`text-[10px] px-1.5 py-0.2 rounded font-extrabold ${
                selectedCategory === 'missing' ? 'bg-slate-700 text-white' : 'bg-slate-200 text-slate-800'
              }`}>
                {phoneAudit.stats.missing}
              </span>
            </button>

            {/* Invalid Formats */}
            <button
              type="button"
              onClick={() => { setSelectedCategory('invalid'); setReasonFilter('all'); }}
              className={`px-3 py-1.5 rounded-md font-bold transition flex items-center gap-1.5 cursor-pointer border ${
                selectedCategory === 'invalid'
                  ? 'bg-rose-600 text-white border-rose-700 shadow-xs'
                  : 'bg-rose-50 text-rose-800 border-rose-200 hover:bg-rose-100'
              }`}
            >
              <AlertTriangle className="w-3.5 h-3.5" />
              <span>Invalid Formats</span>
              <span className={`text-[10px] px-1.5 py-0.2 rounded font-extrabold ${
                selectedCategory === 'invalid' ? 'bg-rose-700 text-white' : 'bg-rose-200 text-rose-900'
              }`}>
                {phoneAudit.stats.invalid}
              </span>
            </button>

            {/* Duplicates (Overlapping Flag) */}
            <button
              type="button"
              onClick={() => { setSelectedCategory('duplicates'); setReasonFilter('all'); }}
              className={`px-3 py-1.5 rounded-md font-bold transition flex items-center gap-1.5 cursor-pointer border ${
                selectedCategory === 'duplicates'
                  ? 'bg-orange-600 text-white border-orange-700 shadow-xs'
                  : 'bg-orange-50 text-orange-800 border-orange-200 hover:bg-orange-100'
              }`}
              title="Duplicate telephone numbers shared across multiple CRM contacts"
            >
              <Layers className="w-3.5 h-3.5" />
              <span>Duplicates</span>
              <span className={`text-[10px] px-1.5 py-0.2 rounded font-extrabold ${
                selectedCategory === 'duplicates' ? 'bg-orange-700 text-white' : 'bg-orange-200 text-orange-900'
              }`}>
                {phoneAudit.stats.duplicates}
              </span>
              <span className="text-[9px] uppercase px-1 py-0.2 bg-orange-100 text-orange-900 rounded font-bold border border-orange-300">
                Overlapping
              </span>
            </button>
          </div>

          {/* Reconciliation Explanatory Pill */}
          <div className="hidden xl:flex items-center gap-1 text-[11px] text-gray-500 bg-gray-50 px-2.5 py-1 rounded border border-gray-200 whitespace-nowrap">
            <Info className="w-3.5 h-3.5 text-blue-500 shrink-0" />
            <span>
              65 Eligible + 315 Landlines + 110 Missing + 31 Invalid = <strong>521 Total Directory</strong>
            </span>
          </div>
        </div>

        {/* ==================================================================== */}
        {/* 3. TOOLBAR: SEARCH, FILTERS, DUPLICATE TOGGLE, SORTING               */}
        {/* ==================================================================== */}
        <div className="px-5 py-2.5 bg-slate-50 border-b border-slate-200 flex flex-wrap items-center justify-between gap-2.5 text-xs shrink-0">
          <div className="flex items-center gap-2 flex-1 min-w-[280px] max-w-md">
            <div className="relative w-full">
              <Search className="w-3.5 h-3.5 text-gray-400 absolute left-2.5 top-1/2 -translate-y-1/2" />
              <input
                type="text"
                placeholder="Search company, contact person, or phone number..."
                value={searchQuery}
                onChange={e => setSearchQuery(e.target.value)}
                className="w-full pl-8 pr-7 py-1.5 text-xs bg-white border border-gray-300 rounded-md focus:outline-hidden focus:ring-1 focus:ring-emerald-500 focus:border-emerald-500"
              />
              {searchQuery && (
                <button
                  type="button"
                  onClick={() => setSearchQuery('')}
                  className="absolute right-2 top-1/2 -translate-y-1/2 text-gray-400 hover:text-gray-600"
                >
                  <X className="w-3 h-3" />
                </button>
              )}
            </div>
          </div>

          <div className="flex items-center gap-2 flex-wrap">
            {/* Reason Filter */}
            {distinctReasons.length > 1 && (
              <div className="flex items-center gap-1.5">
                <span className="text-[11px] text-gray-500 font-medium">Reason:</span>
                <select
                  value={reasonFilter}
                  onChange={e => setReasonFilter(e.target.value)}
                  className="bg-white border border-gray-300 rounded-md px-2 py-1 text-xs text-gray-700 max-w-[200px] truncate focus:outline-hidden focus:ring-1 focus:ring-emerald-500"
                >
                  <option value="all">All Reasons ({categoryItems.length})</option>
                  {distinctReasons.map(r => (
                    <option key={r} value={r} title={r}>
                      {r.length > 35 ? r.slice(0, 35) + '…' : r}
                    </option>
                  ))}
                </select>
              </div>
            )}

            {/* Country Filter */}
            {distinctCountries.length > 1 && (
              <div className="flex items-center gap-1.5">
                <span className="text-[11px] text-gray-500 font-medium">Country:</span>
                <select
                  value={countryFilter}
                  onChange={e => setCountryFilter(e.target.value)}
                  className="bg-white border border-gray-300 rounded-md px-2 py-1 text-xs text-gray-700 focus:outline-hidden focus:ring-1 focus:ring-emerald-500"
                >
                  <option value="all">All Countries</option>
                  {distinctCountries.map(c => (
                    <option key={c} value={c}>{c}</option>
                  ))}
                </select>
              </div>
            )}

            {/* Duplicates View Mode Toggle */}
            {selectedCategory === 'duplicates' && (
              <div className="flex items-center rounded-md border border-gray-300 bg-white p-0.5">
                <button
                  type="button"
                  onClick={() => setDuplicateViewMode('grouped')}
                  className={`px-2 py-0.5 text-xs font-semibold rounded ${
                    duplicateViewMode === 'grouped' ? 'bg-orange-100 text-orange-800' : 'text-gray-600 hover:text-gray-900'
                  }`}
                >
                  Grouped by Phone ({duplicateGroups.length})
                </button>
                <button
                  type="button"
                  onClick={() => setDuplicateViewMode('flat')}
                  className={`px-2 py-0.5 text-xs font-semibold rounded ${
                    duplicateViewMode === 'flat' ? 'bg-orange-100 text-orange-800' : 'text-gray-600 hover:text-gray-900'
                  }`}
                >
                  Flat Table ({categoryItems.length})
                </button>
              </div>
            )}

            {/* Sort Toggle */}
            <button
              type="button"
              onClick={() => setSortAsc(!sortAsc)}
              className="inline-flex items-center gap-1 px-2.5 py-1 bg-white hover:bg-gray-100 text-gray-700 border border-gray-300 rounded-md text-xs font-medium transition cursor-pointer"
              title={`Sorting ${sortAsc ? 'Ascending' : 'Descending'}`}
            >
              <SlidersHorizontal className="w-3 h-3 text-gray-500" />
              <span>Sort: {sortField === 'company' ? 'Company' : sortField === 'phone' ? 'Phone' : 'Status'} ({sortAsc ? 'A-Z' : 'Z-A'})</span>
            </button>
          </div>
        </div>

        {/* ==================================================================== */}
        {/* 4. MAIN CONTENT AREA (TABLE OR GROUPED DUPLICATES)                   */}
        {/* ==================================================================== */}
        <div className="flex-1 overflow-y-auto bg-slate-100/50 min-h-[350px] max-h-[calc(94vh-220px)] p-4 space-y-4">

          {/* 4A. DUPLICATES GROUPED VIEW */}
          {selectedCategory === 'duplicates' && duplicateViewMode === 'grouped' ? (
            <div className="space-y-3">
              <div className="bg-orange-50 border border-orange-200 rounded-lg p-3 text-xs text-orange-900 flex items-start gap-2.5">
                <Info className="w-4 h-4 text-orange-600 shrink-0 mt-0.5" />
                <div>
                  <span className="font-bold">Duplicate Phone Group Analysis</span>
                  <p className="text-[11px] text-orange-800 mt-0.5">
                    Identifies repeated telephone numbers across contacts. Distinguishes whether duplicate records belong to the same enterprise group (sister companies/same offices) or across distinct customer companies. Do not delete or merge records automatically.
                  </p>
                </div>
              </div>

              {filteredDuplicateGroups.length === 0 ? (
                <div className="bg-white rounded-lg border border-gray-200 p-8 text-center text-gray-500 text-xs">
                  No duplicate groups match the search query.
                </div>
              ) : (
                filteredDuplicateGroups.map(group => (
                  <div key={group.normalizedPhone} className="bg-white rounded-lg border border-orange-200 shadow-xs overflow-hidden">
                    {/* Group Header Card */}
                    <div className="bg-orange-50/70 border-b border-orange-200 px-4 py-2.5 flex flex-wrap items-center justify-between gap-2">
                      <div className="flex items-center gap-2">
                        <span className="font-mono font-extrabold text-sm text-gray-900 bg-white px-2 py-0.5 rounded border border-orange-200">
                          {group.normalizedPhone}
                        </span>
                        <span className="text-[11px] font-bold px-2 py-0.5 rounded bg-orange-100 text-orange-800 border border-orange-300">
                          {group.count} Contacts Sharing Number
                        </span>
                        <span className={`text-[10px] font-bold px-2 py-0.5 rounded border ${
                          group.groupType === 'same_company'
                            ? 'bg-blue-50 text-blue-800 border-blue-200'
                            : 'bg-rose-50 text-rose-800 border-rose-200'
                        }`}>
                          {group.groupType === 'same_company' ? '🏢 Same-Group / Sister Companies' : '⚠️ Cross-Customer Shared Number'}
                        </span>
                      </div>

                      <div className="text-[11px] text-gray-500 font-medium">
                        Companies: {group.companies.join(' · ')}
                      </div>
                    </div>

                    {/* Group Contacts Table */}
                    <div className="overflow-x-auto">
                      <table className="w-full text-left text-xs border-collapse">
                        <thead>
                          <tr className="bg-gray-50 border-b border-gray-200 text-[10px] uppercase font-bold text-gray-500">
                            <th className="py-2 px-3">Company</th>
                            <th className="py-2 px-3">Contact Person</th>
                            <th className="py-2 px-3">Raw Phone</th>
                            <th className="py-2 px-3">Country</th>
                            <th className="py-2 px-3">Classification</th>
                            <th className="py-2 px-3 w-[260px]">Correct Mobile / Differentiate</th>
                            <th className="py-2 px-3 text-right">Action</th>
                          </tr>
                        </thead>
                        <tbody className="divide-y divide-gray-100">
                          {group.contacts.map(contact => {
                            const currentVal = getInputValue(contact);
                            const valResult = validatePhoneNumber(currentVal);
                            const isChanged = currentVal !== (contact.raw_phone || '');
                            const isSaving = savingRows[contact.id] || false;
                            const countryInfo = detectCountryInfo(contact.raw_phone, contact.city);

                            return (
                              <tr key={contact.id} className="hover:bg-slate-50 transition">
                                <td className="py-2 px-3 font-semibold text-gray-900">
                                  {contact.company_name}
                                  {contact.city && (
                                    <span className="block text-[10px] text-gray-400 font-normal">{contact.city}</span>
                                  )}
                                </td>
                                <td className="py-2 px-3 text-gray-700">
                                  {contact.contact_person || '—'}
                                  {contact.email && (
                                    <span className="block text-[10px] text-gray-400">{contact.email}</span>
                                  )}
                                </td>
                                <td className="py-2 px-3 font-mono text-gray-800">
                                  <div className="flex items-center gap-1.5">
                                    <span>{contact.raw_phone || '—'}</span>
                                    {contact.raw_phone && (
                                      <button
                                        type="button"
                                        onClick={() => handleCopyPhone(contact.raw_phone || '', contact.id)}
                                        className="text-gray-400 hover:text-gray-700 p-0.5 rounded transition"
                                        title="Copy phone"
                                      >
                                        {copiedId === contact.id ? <Check className="w-3 h-3 text-emerald-600" /> : <Copy className="w-3 h-3" />}
                                      </button>
                                    )}
                                  </div>
                                </td>
                                <td className="py-2 px-3 text-gray-700">
                                  <span className="inline-flex items-center gap-1 text-[11px]">
                                    <span>{countryInfo.flag}</span>
                                    <span>{countryInfo.name}</span>
                                  </span>
                                </td>
                                <td className="py-2 px-3">
                                  <span className={`inline-flex items-center gap-1 px-1.5 py-0.5 rounded text-[10px] font-bold border ${
                                    contact.validation.type === 'valid_mobile'
                                      ? 'bg-emerald-50 text-emerald-800 border-emerald-200'
                                      : contact.validation.type === 'landline'
                                      ? 'bg-amber-50 text-amber-800 border-amber-200'
                                      : 'bg-rose-50 text-rose-800 border-rose-200'
                                  }`}>
                                    {contact.validation.type}
                                  </span>
                                </td>
                                <td className="py-2 px-3">
                                  <div className="flex items-center gap-1">
                                    <input
                                      type="text"
                                      value={currentVal}
                                      onChange={e => handleInputChange(contact.id, e.target.value)}
                                      placeholder="e.g. +6281234567890"
                                      className={`w-full px-2 py-1 text-xs font-mono rounded border transition focus:outline-hidden ${
                                        valResult.type === 'valid_mobile' || valResult.type === 'international_number'
                                          ? 'border-emerald-300 focus:border-emerald-500 bg-emerald-50/30'
                                          : valResult.type === 'landline'
                                          ? 'border-amber-300 focus:border-amber-500 bg-amber-50/30'
                                          : 'border-rose-300 focus:border-rose-500 bg-rose-50/30'
                                      }`}
                                    />
                                    {suggestCleanMobileNumber(contact.raw_phone || '') &&
                                      suggestCleanMobileNumber(contact.raw_phone || '') !== currentVal && (
                                        <button
                                          type="button"
                                          onClick={() => handleApplyQuickClean(contact)}
                                          className="p-1 text-indigo-600 hover:text-indigo-800 hover:bg-indigo-50 rounded transition"
                                          title={`Format to ${suggestCleanMobileNumber(contact.raw_phone || '')}`}
                                        >
                                          <Sparkles className="w-3.5 h-3.5" />
                                        </button>
                                      )}
                                  </div>
                                </td>
                                <td className="py-2 px-3 text-right">
                                  <button
                                    type="button"
                                    onClick={() => handleSaveContact(contact)}
                                    disabled={!isChanged || isSaving}
                                    className={`px-2.5 py-1 rounded text-xs font-bold transition inline-flex items-center gap-1 ${
                                      isChanged
                                        ? 'bg-emerald-600 hover:bg-emerald-700 text-white cursor-pointer shadow-xs'
                                        : 'bg-gray-100 text-gray-400 cursor-not-allowed'
                                    }`}
                                  >
                                    {isSaving ? <Loader2 className="w-3 h-3 animate-spin" /> : <Check className="w-3 h-3" />}
                                    <span>Save</span>
                                  </button>
                                </td>
                              </tr>
                            );
                          })}
                        </tbody>
                      </table>
                    </div>
                  </div>
                ))
              )}
            </div>
          ) : (

            /* 4B. STANDARD COMPACT AUDIT TABLE VIEW */
            <div className="bg-white rounded-lg border border-gray-200 shadow-xs overflow-hidden">
              <div className="overflow-x-auto">
                <table className="w-full text-left text-xs border-collapse">
                  <thead className="sticky top-0 bg-slate-100 border-b border-gray-200 z-10">
                    <tr className="text-[10px] uppercase font-bold text-gray-600">
                      <th className="py-2.5 px-3 w-10">#</th>
                      <th className="py-2.5 px-3 min-w-[180px]">Company</th>
                      <th className="py-2.5 px-3 min-w-[130px]">Contact Person</th>
                      <th className="py-2.5 px-3 min-w-[160px]">Current Mobile / Phone</th>
                      <th className="py-2.5 px-3 min-w-[110px]">Country</th>
                      <th className="py-2.5 px-3 min-w-[130px]">Validation Result</th>
                      <th className="py-2.5 px-3 min-w-[220px]">Reason & Diagnostics</th>
                      <th className="py-2.5 px-3 min-w-[240px]">Corrected Mobile</th>
                      <th className="py-2.5 px-3 text-right min-w-[80px]">Action</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-gray-100">
                    {filteredItems.length === 0 ? (
                      <tr>
                        <td colSpan={9} className="py-10 text-center text-gray-500 text-xs">
                          No contact records found matching the current category and filters.
                        </td>
                      </tr>
                    ) : (
                      filteredItems.map((item, idx) => {
                        const currentVal = getInputValue(item);
                        const valResult = validatePhoneNumber(currentVal);
                        const isChanged = currentVal !== (item.raw_phone || '');
                        const isSaving = savingRows[item.id] || false;
                        const countryInfo = detectCountryInfo(item.raw_phone, item.city);
                        const cleanSuggestion = suggestCleanMobileNumber(item.raw_phone || '');

                        return (
                          <tr key={item.id} className="hover:bg-slate-50/80 transition">
                            {/* # */}
                            <td className="py-2.5 px-3 text-[11px] text-gray-400 font-mono">
                              {idx + 1}
                            </td>

                            {/* Company */}
                            <td className="py-2.5 px-3">
                              <span className="font-bold text-gray-900 block leading-tight">
                                {item.company_name}
                              </span>
                              <div className="flex items-center gap-1.5 mt-0.5">
                                {item.city && (
                                  <span className="text-[10px] text-gray-500">{item.city}</span>
                                )}
                                {item.customer_type && (
                                  <span className="text-[9px] px-1 py-0.2 bg-gray-100 text-gray-600 rounded">
                                    {item.customer_type}
                                  </span>
                                )}
                              </div>
                            </td>

                            {/* Contact Person */}
                            <td className="py-2.5 px-3 text-gray-800">
                              <span className="font-medium block">
                                {item.contact_person || '—'}
                              </span>
                              {item.email && (
                                <a
                                  href={`mailto:${item.email}`}
                                  className="text-[10px] text-blue-600 hover:underline block truncate max-w-[150px]"
                                  title={item.email}
                                >
                                  {item.email}
                                </a>
                              )}
                            </td>

                            {/* Current Mobile / Phone */}
                            <td className="py-2.5 px-3 font-mono text-gray-900">
                              <div className="flex items-center gap-1.5">
                                <span className={item.raw_phone ? 'font-semibold' : 'text-gray-400 italic'}>
                                  {item.raw_phone || '(Missing)'}
                                </span>
                                {item.raw_phone && (
                                  <button
                                    type="button"
                                    onClick={() => handleCopyPhone(item.raw_phone || '', item.id)}
                                    className="text-gray-400 hover:text-gray-700 p-0.5 rounded transition"
                                    title="Copy raw phone number"
                                  >
                                    {copiedId === item.id ? (
                                      <Check className="w-3.5 h-3.5 text-emerald-600" />
                                    ) : (
                                      <Copy className="w-3.5 h-3.5" />
                                    )}
                                  </button>
                                )}
                              </div>
                            </td>

                            {/* Country */}
                            <td className="py-2.5 px-3">
                              <span className="inline-flex items-center gap-1 text-xs text-gray-800 font-medium">
                                <span className="text-sm">{countryInfo.flag}</span>
                                <span>{countryInfo.name}</span>
                              </span>
                              <span className="block text-[10px] text-gray-400 font-mono">
                                {countryInfo.code}
                              </span>
                            </td>

                            {/* Validation Result */}
                            <td className="py-2.5 px-3">
                              <div className="space-y-1">
                                {item.validation.type === 'valid_mobile' && (
                                  <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-[10px] font-bold bg-emerald-100 text-emerald-800 border border-emerald-300">
                                    <CheckCircle2 className="w-3 h-3 text-emerald-600" />
                                    Valid Mobile
                                  </span>
                                )}
                                {item.validation.type === 'international_number' && (
                                  <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-[10px] font-bold bg-blue-100 text-blue-800 border border-blue-300">
                                    <CheckCircle2 className="w-3 h-3 text-blue-600" />
                                    International
                                  </span>
                                )}
                                {item.validation.type === 'landline' && (
                                  <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-[10px] font-bold bg-amber-100 text-amber-800 border border-amber-300">
                                    <Phone className="w-3 h-3 text-amber-600" />
                                    Landline
                                  </span>
                                )}
                                {item.validation.type === 'missing_number' && (
                                  <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-[10px] font-bold bg-slate-100 text-slate-700 border border-slate-300">
                                    <AlertCircle className="w-3 h-3 text-slate-500" />
                                    Missing
                                  </span>
                                )}
                                {item.validation.type === 'invalid_number' && (
                                  <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-[10px] font-bold bg-rose-100 text-rose-800 border border-rose-300">
                                    <AlertTriangle className="w-3 h-3 text-rose-600" />
                                    Invalid
                                  </span>
                                )}

                                {item.is_duplicate && (
                                  <span className="inline-flex items-center gap-1 px-1.5 py-0.2 rounded text-[9px] font-extrabold bg-orange-100 text-orange-900 border border-orange-300">
                                    Duplicate
                                  </span>
                                )}
                              </div>
                            </td>

                            {/* Reason & Diagnostics */}
                            <td className="py-2.5 px-3">
                              <span className="text-[11px] text-gray-700 block leading-normal">
                                {item.validation.reason}
                              </span>
                              {item.exclusion_reason && item.exclusion_reason !== item.validation.reason && (
                                <span className="text-[10px] text-gray-500 block mt-0.5">
                                  {item.exclusion_reason}
                                </span>
                              )}
                            </td>

                            {/* Corrected Mobile (Inline Edit) */}
                            <td className="py-2.5 px-3">
                              <div className="space-y-1">
                                <div className="flex items-center gap-1">
                                  <input
                                    type="text"
                                    value={currentVal}
                                    onChange={e => handleInputChange(item.id, e.target.value)}
                                    placeholder="e.g. +6281234567890"
                                    className={`w-full px-2.5 py-1 text-xs font-mono rounded-md border transition focus:outline-hidden ${
                                      valResult.type === 'valid_mobile' || valResult.type === 'international_number'
                                        ? 'border-emerald-300 focus:border-emerald-500 bg-emerald-50/20 text-emerald-900'
                                        : valResult.type === 'landline'
                                        ? 'border-amber-300 focus:border-amber-500 bg-amber-50/20 text-amber-900'
                                        : valResult.type === 'missing_number'
                                        ? 'border-gray-300 focus:border-gray-500 bg-white'
                                        : 'border-rose-300 focus:border-rose-500 bg-rose-50/20 text-rose-900'
                                    }`}
                                  />

                                  {cleanSuggestion && cleanSuggestion !== currentVal && (
                                    <button
                                      type="button"
                                      onClick={() => handleApplyQuickClean(item)}
                                      className="p-1 bg-indigo-50 hover:bg-indigo-100 text-indigo-700 border border-indigo-200 rounded transition cursor-pointer shrink-0"
                                      title={`Quick clean formatting: "${cleanSuggestion}"`}
                                    >
                                      <Sparkles className="w-3.5 h-3.5 text-indigo-600" />
                                    </button>
                                  )}
                                </div>

                                {/* Live Diagnostic Tag for typed value */}
                                {isChanged && (
                                  <div className="flex items-center gap-1 text-[10px]">
                                    <span className="text-gray-400">Live preview:</span>
                                    {valResult.type === 'valid_mobile' ? (
                                      <span className="text-emerald-700 font-bold">✓ Valid Mobile ({valResult.normalized})</span>
                                    ) : valResult.type === 'landline' ? (
                                      <span className="text-amber-700 font-bold">⚠️ Landline ({valResult.normalized})</span>
                                    ) : (
                                      <span className="text-rose-700 font-bold">✕ {valResult.reason}</span>
                                    )}
                                  </div>
                                )}
                              </div>
                            </td>

                            {/* Action */}
                            <td className="py-2.5 px-3 text-right">
                              <button
                                type="button"
                                onClick={() => handleSaveContact(item)}
                                disabled={!isChanged || isSaving}
                                className={`px-3 py-1 rounded-md text-xs font-bold transition inline-flex items-center gap-1 shadow-2xs ${
                                  isChanged
                                    ? 'bg-emerald-600 hover:bg-emerald-700 text-white cursor-pointer'
                                    : 'bg-gray-100 text-gray-400 cursor-not-allowed'
                                }`}
                                title={isChanged ? 'Save correction to CRM database' : 'Modify number to enable saving'}
                              >
                                {isSaving ? (
                                  <Loader2 className="w-3 h-3 animate-spin" />
                                ) : (
                                  <Check className="w-3 h-3" />
                                )}
                                <span>Save</span>
                              </button>
                            </td>
                          </tr>
                        );
                      })
                    )}
                  </tbody>
                </table>
              </div>
            </div>
          )}
        </div>

        {/* ==================================================================== */}
        {/* 5. MODAL FOOTER                                                     */}
        {/* ==================================================================== */}
        <div className="px-5 py-3 bg-slate-50 border-t border-slate-200 flex flex-col sm:flex-row sm:items-center justify-between gap-3 text-xs shrink-0">
          <div className="flex items-center gap-3 text-gray-500">
            <span>Showing <strong>{filteredItems.length}</strong> of {categoryItems.length} records in <strong>{selectedCategory.toUpperCase()}</strong></span>
            <span>·</span>
            <span className="text-emerald-700 font-semibold">
              Eligible WhatsApp Targets: {phoneAudit.stats.eligible}
            </span>
          </div>

          <div className="flex items-center gap-2">
            <button
              type="button"
              onClick={() => { setSelectedCategory('total'); setReasonFilter('all'); setSearchQuery(''); }}
              className="px-3 py-1.5 bg-white hover:bg-gray-100 text-gray-700 border border-gray-300 rounded-md text-xs font-semibold transition cursor-pointer"
            >
              Reset Filters & View Full Directory
            </button>

            <button
              type="button"
              onClick={onClose}
              className="px-4 py-1.5 bg-slate-800 hover:bg-slate-900 text-white rounded-md text-xs font-bold transition cursor-pointer shadow-xs"
            >
              Done / Close
            </button>
          </div>
        </div>
      </div>

      {/* ==================================================================== */}
      {/* 6. SAFE BULK NORMALIZATION PREVIEW MODAL                              */}
      {/* ==================================================================== */}
      {showBulkPreview && (
        <div className="fixed inset-0 z-60 bg-black/60 backdrop-blur-xs flex items-center justify-center p-3 animate-in fade-in duration-100">
          <div className="bg-white w-full max-w-4xl max-h-[85vh] rounded-xl shadow-2xl border border-slate-200 flex flex-col overflow-hidden">
            
            <div className="px-5 py-3.5 bg-indigo-50/70 border-b border-indigo-200 flex items-center justify-between">
              <div className="flex items-center gap-2">
                <Sparkles className="w-5 h-5 text-indigo-600" />
                <div>
                  <h3 className="text-sm font-bold text-gray-900">
                    Safe Bulk Mobile Normalization Preview
                  </h3>
                  <p className="text-[11px] text-gray-600">
                    Staff approval required. Only unambiguous formatting errors (08... & 628... to +628...) will be updated. Landlines and missing numbers are excluded.
                  </p>
                </div>
              </div>
              <button
                type="button"
                onClick={() => setShowBulkPreview(false)}
                className="text-gray-400 hover:text-gray-600 p-1"
              >
                <X className="w-5 h-5" />
              </button>
            </div>

            <div className="px-5 py-2.5 bg-gray-50 border-b border-gray-200 flex items-center justify-between text-xs">
              <div className="flex items-center gap-2">
                <input
                  type="checkbox"
                  id="select_all_candidates"
                  checked={selectedBulkCandidateIds.size === bulkCandidates.length && bulkCandidates.length > 0}
                  onChange={e => {
                    if (e.target.checked) {
                      setSelectedBulkCandidateIds(new Set(bulkCandidates.map(c => c.contactId)));
                    } else {
                      setSelectedBulkCandidateIds(new Set());
                    }
                  }}
                  className="rounded text-indigo-600 focus:ring-indigo-500 cursor-pointer"
                />
                <label htmlFor="select_all_candidates" className="font-semibold text-gray-700 cursor-pointer">
                  Select All ({selectedBulkCandidateIds.size} of {bulkCandidates.length} Selected)
                </label>
              </div>

              <span className="text-[11px] text-gray-500">
                All proposed changes result in certified <strong>+62 valid_mobile</strong> numbers
              </span>
            </div>

            <div className="flex-1 overflow-y-auto p-4 max-h-[calc(85vh-180px)]">
              <table className="w-full text-left text-xs border-collapse">
                <thead>
                  <tr className="bg-slate-100 text-[10px] uppercase font-bold text-gray-600 border-b">
                    <th className="py-2 px-3 w-8"></th>
                    <th className="py-2 px-3">Company</th>
                    <th className="py-2 px-3">Contact Person</th>
                    <th className="py-2 px-3">Current Raw</th>
                    <th className="py-2 px-3 w-6 text-center">→</th>
                    <th className="py-2 px-3">Proposed Clean Mobile</th>
                    <th className="py-2 px-3">Result</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-gray-100">
                  {bulkCandidates.map(cand => {
                    const isChecked = selectedBulkCandidateIds.has(cand.contactId);
                    return (
                      <tr key={cand.contactId} className="hover:bg-slate-50 transition">
                        <td className="py-2 px-3 text-center">
                          <input
                            type="checkbox"
                            checked={isChecked}
                            onChange={e => {
                              setSelectedBulkCandidateIds(prev => {
                                const next = new Set(prev);
                                if (e.target.checked) next.add(cand.contactId);
                                else next.delete(cand.contactId);
                                return next;
                              });
                            }}
                            className="rounded text-indigo-600 focus:ring-indigo-500 cursor-pointer"
                          />
                        </td>
                        <td className="py-2 px-3 font-semibold text-gray-900">{cand.companyName}</td>
                        <td className="py-2 px-3 text-gray-700">{cand.contactPerson || '—'}</td>
                        <td className="py-2 px-3 font-mono text-gray-600 line-through decoration-rose-400">
                          {cand.currentRaw}
                        </td>
                        <td className="py-2 px-3 text-center text-gray-400 font-bold">→</td>
                        <td className="py-2 px-3 font-mono font-bold text-emerald-800 bg-emerald-50/50 rounded">
                          {cand.proposedNormalized}
                        </td>
                        <td className="py-2 px-3">
                          <span className="inline-flex items-center gap-1 text-[10px] font-bold text-emerald-700 bg-emerald-100/80 px-2 py-0.5 rounded border border-emerald-300">
                            <CheckCircle2 className="w-3 h-3 text-emerald-600" />
                            Valid Mobile
                          </span>
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>

            <div className="px-5 py-3 bg-gray-50 border-t border-gray-200 flex items-center justify-between">
              <span className="text-xs text-gray-600">
                Staff Review: <strong>{selectedBulkCandidateIds.size}</strong> records queued for update
              </span>

              <div className="flex items-center gap-2">
                <button
                  type="button"
                  onClick={() => setShowBulkPreview(false)}
                  disabled={isApplyingBulk}
                  className="px-3 py-1.5 bg-white text-gray-700 border border-gray-300 rounded text-xs font-semibold hover:bg-gray-100 transition cursor-pointer"
                >
                  Cancel
                </button>
                <button
                  type="button"
                  onClick={handleApplyBulkNormalization}
                  disabled={selectedBulkCandidateIds.size === 0 || isApplyingBulk}
                  className="px-4 py-1.5 bg-indigo-600 hover:bg-indigo-700 text-white rounded text-xs font-bold transition shadow-xs cursor-pointer flex items-center gap-1.5 disabled:opacity-50"
                >
                  {isApplyingBulk ? (
                    <>
                      <Loader2 className="w-3.5 h-3.5 animate-spin" />
                      <span>Applying Corrections...</span>
                    </>
                  ) : (
                    <>
                      <FileCheck className="w-3.5 h-3.5" />
                      <span>Confirm & Apply {selectedBulkCandidateIds.size} Corrections</span>
                    </>
                  )}
                </button>
              </div>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
