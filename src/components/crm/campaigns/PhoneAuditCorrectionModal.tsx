import React, { useState, useMemo, useCallback, useEffect } from 'react';
import { supabase } from '../../../lib/supabase';
import { useAuth } from '../../../contexts/AuthContext';
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
  ContactPhoneRecord,
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
  Plus,
  Trash2,
  Edit2,
  Star,
  Tag,
  Briefcase,
} from 'lucide-react';

export type AuditCategory = 'total' | 'eligible' | 'landline' | 'missing' | 'invalid' | 'duplicates';

export const CRM_DEPARTMENTS = [
  'Purchasing',
  'Import',
  'QA / QC',
  'Sales',
  'Finance',
  'Management',
  'General Office',
] as const;

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
  const { profile } = useAuth();
  const [selectedCategory, setSelectedCategory] = useState<AuditCategory>(initialCategory);
  const [searchQuery, setSearchQuery] = useState('');
  const [reasonFilter, setReasonFilter] = useState<string>('all');
  const [countryFilter, setCountryFilter] = useState<string>('all');
  const [departmentFilter, setDepartmentFilter] = useState<string>('all');
  const [cityFilter, setCityFilter] = useState<string>('all');
  const [phoneTypeFilter, setPhoneTypeFilter] = useState<string>('all');
  const [duplicateFilter, setDuplicateFilter] = useState<string>('all');
  const [consentFilter, setConsentFilter] = useState<string>('all');
  const [candidateFilter, setCandidateFilter] = useState<string>('all');
  const [sortField, setSortField] = useState<'company' | 'phone' | 'status' | 'dept'>('company');
  const [sortAsc, setSortAsc] = useState(true);
  const [duplicateViewMode, setDuplicateViewMode] = useState<'grouped' | 'flat'>('grouped');

  // Relational phone records from database
  const [dbPhones, setDbPhones] = useState<ContactPhoneRecord[]>([]);
  const [loadingDbPhones, setLoadingDbPhones] = useState(false);

  // Inline edit state
  const [editedPhones, setEditedPhones] = useState<Record<string, string>>({});
  const [editedPersons, setEditedPersons] = useState<Record<string, string>>({});
  const [editedDepts, setEditedDepts] = useState<Record<string, string>>({});
  const [savingRows, setSavingRows] = useState<Record<string, boolean>>({});
  const [copiedId, setCopiedId] = useState<string | null>(null);

  // Add Phone Modal state
  const [showAddModal, setShowAddModal] = useState(false);
  const [newCompanyId, setNewCompanyId] = useState('');
  const [newContactPerson, setNewContactPerson] = useState('');
  const [newDepartment, setNewDepartment] = useState('Purchasing');
  const [newPhoneNumber, setNewPhoneNumber] = useState('');
  const [newPhoneIsPrimary, setNewPhoneIsPrimary] = useState(false);
  const [isAddingPhone, setIsAddingPhone] = useState(false);

  // Delete Phone Confirmation state
  const [deleteCandidate, setDeleteCandidate] = useState<VerifiedContactItem | null>(null);
  const [isDeleting, setIsDeleting] = useState(false);

  // Bulk normalization preview modal state
  const [showBulkPreview, setShowBulkPreview] = useState(false);
  const [selectedBulkCandidateIds, setSelectedBulkCandidateIds] = useState<Set<string>>(new Set());
  const [isApplyingBulk, setIsApplyingBulk] = useState(false);

  // Reset all filters when switching category
  const handleSelectCategoryTab = useCallback((cat: AuditCategory) => {
    setSelectedCategory(cat);
    setReasonFilter('all');
    setCountryFilter('all');
    setCityFilter('all');
    setPhoneTypeFilter('all');
    setDuplicateFilter('all');
    setConsentFilter('all');
    setCandidateFilter('all');
    setDepartmentFilter('all');
    setSearchQuery('');
  }, []);

  // Sync initial category when opening and reset filters
  useEffect(() => {
    handleSelectCategoryTab(initialCategory);
  }, [initialCategory, handleSelectCategoryTab]);

  // Fetch relational phones from crm_contact_phones
  const fetchDbPhones = useCallback(async () => {
    setLoadingDbPhones(true);
    try {
      const { data, error } = await supabase
        .from('crm_contact_phones')
        .select('*')
        .order('company_name');

      if (error) {
        console.warn('Could not fetch crm_contact_phones:', error.message);
      } else if (data && data.length > 0) {
        setDbPhones(data as ContactPhoneRecord[]);
      }
    } catch (err) {
      console.warn('Error fetching crm_contact_phones:', err);
    } finally {
      setLoadingDbPhones(false);
    }
  }, []);

  useEffect(() => {
    if (isOpen) {
      fetchDbPhones();
    }
  }, [isOpen, fetchDbPhones]);

  // Copy phone number helper
  const handleCopyPhone = useCallback((phone: string, id: string) => {
    if (!phone) return;
    navigator.clipboard.writeText(phone);
    setCopiedId(id);
    setTimeout(() => setCopiedId(null), 2000);
  }, []);

  // Canonical Single Source of Truth: consume authoritative phoneAudit.items
  const allAuditItems: VerifiedContactItem[] = useMemo(() => {
    return phoneAudit.items;
  }, [phoneAudit.items]);

  // Category counts strictly consuming canonical phoneAudit stats
  const categoryStats = useMemo(() => {
    return {
      total: phoneAudit.stats.total,
      totalCompanies: phoneAudit.stats.totalCompanies || contacts.length,
      totalPhones: phoneAudit.stats.totalPhones || phoneAudit.stats.total,
      eligible: phoneAudit.stats.eligible,
      landline: phoneAudit.stats.landline,
      missing: phoneAudit.stats.missing,
      invalid: phoneAudit.stats.invalid,
      duplicates: phoneAudit.stats.duplicates,
    };
  }, [phoneAudit.stats, contacts.length]);

  // Filter items based on selected category
  const categoryItems = useMemo(() => {
    switch (selectedCategory) {
      case 'eligible':
        return allAuditItems.filter(i => i.is_eligible || i.validation.isWhatsAppEligible);
      case 'landline':
        return allAuditItems.filter(i => i.validation.type === 'landline');
      case 'missing':
        return allAuditItems.filter(i => i.validation.type === 'missing_number');
      case 'invalid':
        return allAuditItems.filter(i => i.validation.type === 'invalid_number');
      case 'duplicates':
        return allAuditItems.filter(i => i.is_duplicate);
      case 'total':
      default:
        return allAuditItems;
    }
  }, [allAuditItems, selectedCategory]);

  // Extract distinct reasons
  const distinctReasons = useMemo(() => {
    const reasons = new Set<string>();
    categoryItems.forEach(i => {
      if (i.validation.reason) reasons.add(i.validation.reason);
    });
    return Array.from(reasons).sort();
  }, [categoryItems]);

  // Extract distinct countries strictly from parsed phone numbers
  const distinctCountries = useMemo(() => {
    const countries = new Set<string>();
    categoryItems.forEach(i => {
      const info = detectCountryInfo(i.raw_phone);
      if (info.name && info.name !== 'Missing' && info.name !== 'Invalid / Unrecognized') {
        countries.add(info.name);
      }
    });
    return Array.from(countries).sort();
  }, [categoryItems]);

  // Extract distinct company cities/regions strictly from stored CRM addresses
  const distinctCities = useMemo(() => {
    const cities = new Set<string>();
    categoryItems.forEach(i => {
      if (i.city && i.city.trim()) cities.add(i.city.trim());
    });
    return Array.from(cities).sort();
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
        const dept = (item.department || '').toLowerCase();
        const raw = (item.raw_phone || '').toLowerCase();
        const norm = (item.validation.normalized || '').toLowerCase();
        const city = (item.city || '').toLowerCase();
        return (
          comp.includes(q) ||
          contact.includes(q) ||
          dept.includes(q) ||
          raw.includes(q) ||
          norm.includes(q) ||
          city.includes(q)
        );
      });
    }

    // Reason filter
    if (reasonFilter !== 'all') {
      list = list.filter(item => item.validation.reason === reasonFilter);
    }

    // Phone Country filter (strictly derived from parsed phone number)
    if (countryFilter !== 'all') {
      list = list.filter(item => {
        const info = detectCountryInfo(item.raw_phone);
        return info.name === countryFilter;
      });
    }

    // Company City / Region filter (strictly derived from stored CRM address)
    if (cityFilter !== 'all') {
      list = list.filter(item => (item.city || '').toLowerCase() === cityFilter.toLowerCase());
    }

    // Phone Type filter
    if (phoneTypeFilter !== 'all') {
      list = list.filter(item => {
        const pType = item.validation.canonical?.phoneType ||
          (item.validation.type === 'valid_mobile' ? 'mobile' : item.validation.type === 'landline' ? 'fixed_line' : 'invalid');
        return pType === phoneTypeFilter;
      });
    }

    // Duplicate filter
    if (duplicateFilter === 'duplicates') {
      list = list.filter(item => item.is_duplicate);
    } else if (duplicateFilter === 'unique') {
      list = list.filter(item => !item.is_duplicate);
    }

    // Consent filter
    if (consentFilter !== 'all') {
      list = list.filter(item => item.consent_status === consentFilter);
    }

    // Candidate filter
    if (candidateFilter === 'eligible') {
      list = list.filter(item => item.is_eligible);
    } else if (candidateFilter === 'excluded') {
      list = list.filter(item => !item.is_eligible);
    }

    // Department filter
    if (departmentFilter !== 'all') {
      list = list.filter(item => (item.department || 'General Office') === departmentFilter);
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
      } else if (sortField === 'dept') {
        const dA = a.department || '';
        const dB = b.department || '';
        cmp = dA.localeCompare(dB);
      } else if (sortField === 'status') {
        cmp = a.validation.type.localeCompare(b.validation.type);
      }
      return sortAsc ? cmp : -cmp;
    });
  }, [categoryItems, searchQuery, reasonFilter, countryFilter, cityFilter, phoneTypeFilter, duplicateFilter, consentFilter, candidateFilter, departmentFilter, sortField, sortAsc]);

  // Grouped duplicates structure
  const duplicateGroups = useMemo(() => {
    return groupDuplicates(allAuditItems);
  }, [allAuditItems]);

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
    return getBulkNormalizationCandidates(allAuditItems);
  }, [allAuditItems]);

  const handleOpenBulkPreview = useCallback(() => {
    setSelectedBulkCandidateIds(new Set(bulkCandidates.map(c => c.contactId)));
    setShowBulkPreview(true);
  }, [bulkCandidates]);

  // Inline value getters
  const getInputValue = useCallback(
    (item: VerifiedContactItem): string => {
      if (editedPhones[item.id] !== undefined) {
        return editedPhones[item.id];
      }
      return item.raw_phone || '';
    },
    [editedPhones]
  );

  const getPersonValue = useCallback(
    (item: VerifiedContactItem): string => {
      if (editedPersons[item.id] !== undefined) {
        return editedPersons[item.id];
      }
      return item.contact_person || '';
    },
    [editedPersons]
  );

  const getDeptValue = useCallback(
    (item: VerifiedContactItem): string => {
      if (editedDepts[item.id] !== undefined) {
        return editedDepts[item.id];
      }
      return item.department || 'Purchasing';
    },
    [editedDepts]
  );

  const handlePhoneInputChange = useCallback((id: string, value: string) => {
    setEditedPhones(prev => ({ ...prev, [id]: value }));
  }, []);

  const handlePersonInputChange = useCallback((id: string, value: string) => {
    setEditedPersons(prev => ({ ...prev, [id]: value }));
  }, []);

  const handleDeptInputChange = useCallback((id: string, value: string) => {
    setEditedDepts(prev => ({ ...prev, [id]: value }));
  }, []);

  // Quick auto-clean button per row
  const handleApplyQuickClean = useCallback((item: VerifiedContactItem) => {
    const raw = item.raw_phone || '';
    const suggested = suggestCleanMobileNumber(raw);
    if (suggested) {
      setEditedPhones(prev => ({ ...prev, [item.id]: suggested }));
    }
  }, []);

  // Toggle primary status for an individual phone
  const handleTogglePrimary = async (item: VerifiedContactItem) => {
    const parentContactId = item.contact_id || item.id;
    setSavingRows(prev => ({ ...prev, [item.id]: true }));

    try {
      // 1. Reset all phones for this company to non-primary in database
      await supabase
        .from('crm_contact_phones')
        .update({ is_primary: false, updated_at: new Date().toISOString() })
        .eq('contact_id', parentContactId);

      // 2. Set this phone as primary
      if (item.id && !item.id.includes('_missing')) {
        await supabase
          .from('crm_contact_phones')
          .update({ is_primary: true, updated_at: new Date().toISOString() })
          .eq('id', item.id);
      }

      // 3. Keep crm_contacts.mobile / phone in sync
      const normNumber = item.validation.normalized || item.raw_phone;
      if (normNumber) {
        const patch: Record<string, any> = {
          updated_at: new Date().toISOString(),
          updated_by: profile?.id || null,
        };
        if (item.validation.isWhatsAppEligible) {
          patch.mobile = normNumber;
        } else {
          patch.phone = normNumber;
        }
        await supabase.from('crm_contacts').update(patch).eq('id', parentContactId);

        const targetContact = contacts.find(c => c.id === parentContactId);
        if (targetContact) {
          onContactUpdated({ ...targetContact, ...patch });
        }
      }

      showToast({
        type: 'success',
        title: 'Primary Phone Updated',
        message: `${item.raw_phone} is now the primary contact phone for ${item.company_name}.`,
      });

      await fetchDbPhones();
    } catch (err: any) {
      console.error('Failed to set primary phone:', err);
      showToast({ type: 'error', title: 'Error', message: err.message || 'Could not update primary phone' });
    } finally {
      setSavingRows(prev => ({ ...prev, [item.id]: false }));
    }
  };

  // Save single contact phone update to Supabase
  const handleSaveContact = async (item: VerifiedContactItem) => {
    const newNumber = (editedPhones[item.id] !== undefined ? editedPhones[item.id] : item.raw_phone || '').trim();
    const newPerson = (editedPersons[item.id] !== undefined ? editedPersons[item.id] : item.contact_person || '').trim();
    const newDept = (editedDepts[item.id] !== undefined ? editedDepts[item.id] : item.department || 'Purchasing').trim();
    const oldRaw = item.raw_phone || '';

    const isPhoneChanged = newNumber !== oldRaw;
    const isPersonChanged = newPerson !== (item.contact_person || '');
    const isDeptChanged = newDept !== (item.department || 'Purchasing');

    if (!isPhoneChanged && !isPersonChanged && !isDeptChanged) {
      showToast({ type: 'info', title: 'No Changes', message: 'No modifications to save.' });
      return;
    }

    setSavingRows(prev => ({ ...prev, [item.id]: true }));
    try {
      const newValidation = validatePhoneNumber(newNumber);
      const parentContactId = item.contact_id || item.id.replace('_missing', '');
      const country = detectCountryInfo(newValidation.normalized || newNumber, item.city);

      // Check if this record exists in crm_contact_phones or needs insert
      const isMissingRow = item.id.includes('_missing');
      let targetPhoneId = item.id;

      if (isMissingRow) {
        // Insert new record into crm_contact_phones
        const { data: inserted, error: insertErr } = await supabase
          .from('crm_contact_phones')
          .insert({
            contact_id: parentContactId,
            company_name: item.company_name,
            contact_person: newPerson || null,
            department: newDept,
            raw_phone: newNumber,
            normalized_phone: newValidation.normalized || newNumber,
            country_code: country.code,
            country_name: country.name,
            phone_type: newValidation.type,
            is_whatsapp_eligible: newValidation.isWhatsAppEligible,
            is_primary: true,
            consent_status: 'pending',
            notes: newValidation.reason,
          })
          .select()
          .single();

        if (insertErr) throw insertErr;
        if (inserted) targetPhoneId = inserted.id;
      } else {
        // Update existing record in crm_contact_phones
        const { error: phoneErr } = await supabase
          .from('crm_contact_phones')
          .update({
            raw_phone: newNumber,
            normalized_phone: newValidation.normalized || newNumber,
            contact_person: newPerson || null,
            department: newDept,
            country_code: country.code,
            country_name: country.name,
            phone_type: newValidation.type,
            is_whatsapp_eligible: newValidation.isWhatsAppEligible,
            notes: newValidation.reason,
            updated_at: new Date().toISOString(),
          })
          .eq('id', targetPhoneId);

        if (phoneErr) throw phoneErr;
      }

      // Also keep crm_contacts in sync if primary or mobile
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
      if (newPerson) updatePayload.contact_person = newPerson;
      if (newDept) updatePayload.designation = newDept;

      const { error: updateError } = await supabase
        .from('crm_contacts')
        .update(updatePayload)
        .eq('id', parentContactId);

      if (updateError) throw updateError;

      // Insert audit note in crm_activities
      try {
        await supabase.from('crm_activities').insert({
          customer_id: parentContactId,
          activity_type: 'note',
          subject: 'Phone Number Audit Correction',
          description: `Phone audit correction for ${item.company_name}: Phone updated from "${oldRaw || 'None'}" to "${newValidation.normalized || newNumber}". Department: ${newDept}, Contact Person: ${newPerson || 'Unspecified'}. Classification: ${newValidation.type} (${newValidation.reason}).`,
          is_completed: true,
          completed_at: new Date().toISOString(),
        });
      } catch (logErr: any) {
        console.warn('Activity log note warning:', logErr);
      }

      // Update parent contact state in memory
      const targetContact = contacts.find(c => c.id === parentContactId);
      if (targetContact) {
        onContactUpdated({
          ...targetContact,
          mobile: updatePayload.mobile !== undefined ? updatePayload.mobile : targetContact.mobile,
          phone: updatePayload.phone !== undefined ? updatePayload.phone : targetContact.phone,
          contact_person: newPerson || targetContact.contact_person,
        });
      }

      // Clear edit cache for this row
      setEditedPhones(prev => {
        const next = { ...prev };
        delete next[item.id];
        return next;
      });
      setEditedPersons(prev => {
        const next = { ...prev };
        delete next[item.id];
        return next;
      });
      setEditedDepts(prev => {
        const next = { ...prev };
        delete next[item.id];
        return next;
      });

      showToast({
        type: 'success',
        title: 'Phone Saved & Verified',
        message: `${item.company_name} updated to ${newValidation.normalized || newNumber} [${newDept}] (${newValidation.type === 'valid_mobile' ? 'WhatsApp Eligible' : newValidation.type})`,
      });

      await fetchDbPhones();
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

  // Add a new phone number to an existing company
  const handleAddNewPhone = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!newCompanyId) {
      showToast({ type: 'warning', title: 'Select Company', message: 'Please select a company to attach the phone to.' });
      return;
    }
    if (!newPhoneNumber.trim()) {
      showToast({ type: 'warning', title: 'Missing Phone', message: 'Please enter a telephone or mobile number.' });
      return;
    }

    setIsAddingPhone(true);
    try {
      const targetCompany = contacts.find(c => c.id === newCompanyId);
      if (!targetCompany) throw new Error('Selected company not found.');

      const validation = validatePhoneNumber(newPhoneNumber.trim());
      const country = detectCountryInfo(validation.normalized || newPhoneNumber.trim(), targetCompany.city);

      // If marked as primary, reset existing primaries for this company
      if (newPhoneIsPrimary) {
        await supabase
          .from('crm_contact_phones')
          .update({ is_primary: false, updated_at: new Date().toISOString() })
          .eq('contact_id', newCompanyId);
      }

      const { data: inserted, error: insertErr } = await supabase
        .from('crm_contact_phones')
        .insert({
          contact_id: newCompanyId,
          company_name: targetCompany.company_name,
          contact_person: newContactPerson.trim() || targetCompany.contact_person || null,
          department: newDepartment,
          raw_phone: newPhoneNumber.trim(),
          normalized_phone: validation.normalized || newPhoneNumber.trim(),
          country_code: country.code,
          country_name: country.name,
          phone_type: validation.type,
          is_whatsapp_eligible: validation.isWhatsAppEligible,
          is_primary: newPhoneIsPrimary,
          consent_status: 'pending',
          notes: validation.reason,
        })
        .select()
        .single();

      if (insertErr) throw insertErr;

      // Keep crm_contacts in sync if primary
      if (newPhoneIsPrimary) {
        const patch: Record<string, any> = {
          updated_at: new Date().toISOString(),
          updated_by: profile?.id || null,
        };
        if (validation.isWhatsAppEligible) {
          patch.mobile = validation.normalized;
        } else {
          patch.phone = validation.normalized;
        }
        await supabase.from('crm_contacts').update(patch).eq('id', newCompanyId);
        onContactUpdated({ ...targetCompany, ...patch });
      }

      // Log in crm_activities
      try {
        await supabase.from('crm_activities').insert({
          customer_id: newCompanyId,
          activity_type: 'note',
          subject: 'Added Contact Phone Number',
          description: `Added new ${newDepartment} phone ${validation.normalized || newPhoneNumber.trim()} for ${targetCompany.company_name} (Contact: ${newContactPerson || 'Unspecified'}). Classification: ${validation.type}.`,
          is_completed: true,
          completed_at: new Date().toISOString(),
        });
      } catch (logErr) {
        console.warn('Activity log note warning:', logErr);
      }

      showToast({
        type: 'success',
        title: 'Phone Added Successfully',
        message: `Added ${validation.normalized || newPhoneNumber.trim()} (${newDepartment}) to ${targetCompany.company_name}.`,
      });

      // Reset form and close modal
      setNewCompanyId('');
      setNewContactPerson('');
      setNewDepartment('Purchasing');
      setNewPhoneNumber('');
      setNewPhoneIsPrimary(false);
      setShowAddModal(false);

      await fetchDbPhones();
    } catch (err: any) {
      console.error('Failed to add phone:', err);
      showToast({ type: 'error', title: 'Add Failed', message: err.message || 'Could not add phone record.' });
    } finally {
      setIsAddingPhone(false);
    }
  };

  // Delete an individual phone record
  const handleConfirmDelete = async () => {
    if (!deleteCandidate) return;

    setIsDeleting(true);
    try {
      const parentContactId = deleteCandidate.contact_id || deleteCandidate.id;
      const targetPhoneId = deleteCandidate.id;

      if (!targetPhoneId.includes('_missing')) {
        const { error: delErr } = await supabase
          .from('crm_contact_phones')
          .delete()
          .eq('id', targetPhoneId);

        if (delErr) throw delErr;
      }

      // If the deleted phone was primary in crm_contacts, reassign primary to the next available number
      const remainingForCompany = dbPhones.filter(
        p => p.contact_id === parentContactId && p.id !== targetPhoneId
      );

      if (deleteCandidate.is_primary && remainingForCompany.length > 0) {
        const nextPrimary = remainingForCompany.find(p => p.is_whatsapp_eligible) || remainingForCompany[0];
        await supabase
          .from('crm_contact_phones')
          .update({ is_primary: true, updated_at: new Date().toISOString() })
          .eq('id', nextPrimary.id);

        const patch: Record<string, any> = {
          updated_at: new Date().toISOString(),
          updated_by: profile?.id || null,
        };
        if (nextPrimary.is_whatsapp_eligible) {
          patch.mobile = nextPrimary.normalized_phone;
        } else {
          patch.phone = nextPrimary.normalized_phone;
        }
        await supabase.from('crm_contacts').update(patch).eq('id', parentContactId);

        const targetContact = contacts.find(c => c.id === parentContactId);
        if (targetContact) {
          onContactUpdated({ ...targetContact, ...patch });
        }
      } else if (remainingForCompany.length === 0) {
        // No numbers remaining
        await supabase
          .from('crm_contacts')
          .update({ mobile: null, phone: null, updated_at: new Date().toISOString() })
          .eq('id', parentContactId);

        const targetContact = contacts.find(c => c.id === parentContactId);
        if (targetContact) {
          onContactUpdated({ ...targetContact, mobile: null, phone: null });
        }
      }

      // Log in crm_activities
      try {
        await supabase.from('crm_activities').insert({
          customer_id: parentContactId,
          activity_type: 'note',
          subject: 'Removed Phone Number',
          description: `Removed phone ${deleteCandidate.raw_phone} (${deleteCandidate.department || 'General Office'}) from ${deleteCandidate.company_name}.`,
          is_completed: true,
          completed_at: new Date().toISOString(),
        });
      } catch (logErr) {
        console.warn('Activity log note warning:', logErr);
      }

      showToast({
        type: 'success',
        title: 'Phone Removed',
        message: `Removed ${deleteCandidate.raw_phone} from ${deleteCandidate.company_name}.`,
      });

      setDeleteCandidate(null);
      await fetchDbPhones();
    } catch (err: any) {
      console.error('Failed to delete phone:', err);
      showToast({ type: 'error', title: 'Delete Failed', message: err.message || 'Could not delete phone record.' });
    } finally {
      setIsDeleting(false);
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

        // Also update crm_contact_phones if record exists
        await supabase
          .from('crm_contact_phones')
          .update({
            raw_phone: cand.proposedNormalized,
            normalized_phone: cand.proposedNormalized,
            phone_type: 'valid_mobile',
            is_whatsapp_eligible: true,
            updated_at: new Date().toISOString(),
          })
          .eq('contact_id', cand.contactId);

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

    await fetchDbPhones();
  };

  if (!isOpen) return null;

  return (
    <div className="fixed inset-0 z-50 bg-slate-900/60 backdrop-blur-xs flex items-center justify-center p-2 sm:p-4 overflow-hidden animate-in fade-in duration-150">
      <div className="bg-white w-full max-w-7xl max-h-[95vh] rounded-xl shadow-2xl flex flex-col border border-slate-200 overflow-hidden">
        
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
                  {categoryStats.totalCompanies} Companies &bull; {categoryStats.total} Phone Records
                </span>
                {loadingDbPhones && (
                  <span className="text-[10px] text-gray-500 flex items-center gap-1 font-medium">
                    <Loader2 className="w-3 h-3 animate-spin text-emerald-600" />
                    Syncing...
                  </span>
                )}
              </div>
              <p className="text-[11px] text-gray-500">
                Multi-phone management: assign separate mobile & landline numbers to Purchasing, Import, QA/QC, and General Office contacts
              </p>
            </div>
          </div>

          <div className="flex items-center gap-2">
            <button
              type="button"
              onClick={() => setShowAddModal(true)}
              className="inline-flex items-center gap-1.5 px-3 py-1.5 bg-emerald-600 hover:bg-emerald-700 text-white rounded-md text-xs font-bold transition shadow-xs cursor-pointer"
              title="Add a new phone number to an existing company contact"
            >
              <Plus className="w-3.5 h-3.5" />
              Add Phone Number
            </button>

            {bulkCandidates.length > 0 && (
              <button
                type="button"
                onClick={handleOpenBulkPreview}
                className="inline-flex items-center gap-1.5 px-3 py-1.5 bg-indigo-50 hover:bg-indigo-100 text-indigo-700 border border-indigo-200 rounded-md text-xs font-bold transition shadow-2xs cursor-pointer"
                title="Preview and bulk-normalize unambiguous 08... formatting errors"
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
              onClick={() => handleSelectCategoryTab('total')}
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
                {categoryStats.total}
              </span>
            </button>

            {/* WA Eligible */}
            <button
              type="button"
              onClick={() => handleSelectCategoryTab('eligible')}
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
                {categoryStats.eligible}
              </span>
            </button>

            {/* Landlines */}
            <button
              type="button"
              onClick={() => handleSelectCategoryTab('landline')}
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
                {categoryStats.landline}
              </span>
            </button>

            {/* Missing Number */}
            <button
              type="button"
              onClick={() => handleSelectCategoryTab('missing')}
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
                {categoryStats.missing}
              </span>
            </button>

            {/* Invalid Formats */}
            <button
              type="button"
              onClick={() => handleSelectCategoryTab('invalid')}
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
                {categoryStats.invalid}
              </span>
            </button>

            {/* Duplicates */}
            <button
              type="button"
              onClick={() => handleSelectCategoryTab('duplicates')}
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
                {categoryStats.duplicates}
              </span>
            </button>
          </div>

          {/* Granular Reconciliation Indicator */}
          <div className="hidden xl:flex items-center gap-1.5 text-[11px] text-gray-500 bg-gray-50 px-2.5 py-1 rounded border border-gray-200 whitespace-nowrap">
            <Info className="w-3.5 h-3.5 text-blue-500 shrink-0" />
            <span>
              {categoryStats.totalCompanies} Companies &bull; {categoryStats.eligible} Mobiles &bull; {categoryStats.landline} Landlines &bull; {categoryStats.duplicates} Duplicate Instances
            </span>
          </div>
        </div>

        {/* ==================================================================== */}
        {/* 3. TOOLBAR: SEARCH, DEPARTMENT & COUNTRY FILTERS, SORTING            */}
        {/* ==================================================================== */}
        <div className="px-5 py-2.5 bg-slate-50 border-b border-slate-200 flex flex-wrap items-center justify-between gap-2.5 text-xs shrink-0">
          <div className="flex items-center gap-2 flex-1 min-w-[280px] max-w-md">
            <div className="relative w-full">
              <Search className="w-3.5 h-3.5 text-gray-400 absolute left-2.5 top-1/2 -translate-y-1/2" />
              <input
                type="text"
                placeholder="Search company, contact person, department, or phone number..."
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
            {/* Department Filter */}
            <div className="flex items-center gap-1.5">
              <Briefcase className="w-3.5 h-3.5 text-gray-400" />
              <select
                value={departmentFilter}
                onChange={e => setDepartmentFilter(e.target.value)}
                className="bg-white border border-gray-300 rounded-md px-2 py-1 text-xs text-gray-700 focus:outline-hidden focus:ring-1 focus:ring-emerald-500"
              >
                <option value="all">All Departments</option>
                {CRM_DEPARTMENTS.map(d => (
                  <option key={d} value={d}>{d}</option>
                ))}
              </select>
            </div>

            {/* Phone Country Filter (strictly derived from parsed number) */}
            <div className="flex items-center gap-1.5">
              <span className="text-[11px] text-gray-500 font-medium">Country:</span>
              <select
                value={countryFilter}
                onChange={e => setCountryFilter(e.target.value)}
                className="bg-white border border-gray-300 rounded-md px-2 py-1 text-xs text-gray-700 focus:outline-hidden focus:ring-1 focus:ring-emerald-500"
              >
                <option value="all">All Countries ({distinctCountries.length})</option>
                {distinctCountries.map(c => (
                  <option key={c} value={c}>{c}</option>
                ))}
              </select>
            </div>

            {/* Company City / Region Filter (strictly derived from CRM address) */}
            <div className="flex items-center gap-1.5">
              <Building className="w-3.5 h-3.5 text-gray-400" />
              <select
                value={cityFilter}
                onChange={e => setCityFilter(e.target.value)}
                className="bg-white border border-gray-300 rounded-md px-2 py-1 text-xs text-gray-700 focus:outline-hidden focus:ring-1 focus:ring-emerald-500"
              >
                <option value="all">All Cities ({distinctCities.length})</option>
                {distinctCities.map(city => (
                  <option key={city} value={city}>{city}</option>
                ))}
              </select>
            </div>

            {/* Phone Type Filter */}
            <div className="flex items-center gap-1.5">
              <Smartphone className="w-3.5 h-3.5 text-gray-400" />
              <select
                value={phoneTypeFilter}
                onChange={e => setPhoneTypeFilter(e.target.value)}
                className="bg-white border border-gray-300 rounded-md px-2 py-1 text-xs text-gray-700 focus:outline-hidden focus:ring-1 focus:ring-emerald-500"
              >
                <option value="all">All Phone Types</option>
                <option value="mobile">Mobile</option>
                <option value="fixed_line">Fixed Line / Landline</option>
                <option value="service_special">Service / Special / UAN</option>
                <option value="missing">Missing</option>
                <option value="invalid">Invalid</option>
                <option value="needs_review">Needs Manual Review</option>
              </select>
            </div>

            {/* Candidate Status Filter */}
            <div className="flex items-center gap-1.5">
              <ShieldCheck className="w-3.5 h-3.5 text-gray-400" />
              <select
                value={candidateFilter}
                onChange={e => setCandidateFilter(e.target.value)}
                className="bg-white border border-gray-300 rounded-md px-2 py-1 text-xs text-gray-700 focus:outline-hidden focus:ring-1 focus:ring-emerald-500"
              >
                <option value="all">All Candidates</option>
                <option value="eligible">WhatsApp Candidate</option>
                <option value="excluded">Excluded</option>
              </select>
            </div>

            {/* Duplicate Status Filter */}
            <div className="flex items-center gap-1.5">
              <Copy className="w-3.5 h-3.5 text-gray-400" />
              <select
                value={duplicateFilter}
                onChange={e => setDuplicateFilter(e.target.value)}
                className="bg-white border border-gray-300 rounded-md px-2 py-1 text-xs text-gray-700 focus:outline-hidden focus:ring-1 focus:ring-emerald-500"
              >
                <option value="all">All Records</option>
                <option value="unique">Unique Numbers Only</option>
                <option value="duplicates">Duplicates Only</option>
              </select>
            </div>

            {/* Reason Filter */}
            {distinctReasons.length > 1 && (
              <div className="flex items-center gap-1.5">
                <span className="text-[11px] text-gray-500 font-medium">Reason:</span>
                <select
                  value={reasonFilter}
                  onChange={e => setReasonFilter(e.target.value)}
                  className="bg-white border border-gray-300 rounded-md px-2 py-1 text-xs text-gray-700 max-w-[180px] truncate focus:outline-hidden focus:ring-1 focus:ring-emerald-500"
                >
                  <option value="all">All Reasons</option>
                  {distinctReasons.map(r => (
                    <option key={r} value={r} title={r}>
                      {r.length > 30 ? r.slice(0, 30) + '…' : r}
                    </option>
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
              <span>Sort: {sortField.toUpperCase()} ({sortAsc ? 'A-Z' : 'Z-A'})</span>
            </button>
          </div>
        </div>

        {/* ==================================================================== */}
        {/* 4. MAIN CONTENT AREA (TABLE OR GROUPED DUPLICATES)                   */}
        {/* ==================================================================== */}
        <div className="flex-1 overflow-y-auto bg-slate-100/50 min-h-[350px] max-h-[calc(95vh-230px)] p-4 space-y-4">

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
                            <th className="py-2 px-3">Contact Person & Dept</th>
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
                                  <span className="font-semibold">{contact.contact_person || '—'}</span>
                                  <span className="block text-[10px] text-slate-500">{contact.department || 'General'}</span>
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
                                      onChange={e => handlePhoneInputChange(contact.id, e.target.value)}
                                      placeholder="e.g. +6281234567890"
                                      className="w-full px-2 py-1 text-xs font-mono rounded border transition focus:outline-hidden border-orange-300 bg-orange-50/20"
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

            /* 4B. STANDARD COMPACT AUDIT TABLE VIEW WITH MULTI-PHONE & DEPARTMENT SUPPORT */
            <div className="bg-white rounded-lg border border-gray-200 shadow-xs overflow-hidden">
              <div className="overflow-x-auto">
                <table className="w-full text-left text-xs border-collapse">
                  <thead className="sticky top-0 bg-slate-100 border-b border-gray-200 z-10">
                    <tr className="text-[10px] uppercase font-bold text-gray-600">
                      <th className="py-2.5 px-3 w-10">#</th>
                      <th className="py-2.5 px-3 min-w-[170px]">Company</th>
                      <th className="py-2.5 px-3 min-w-[130px]">Contact Person</th>
                      <th className="py-2.5 px-3 min-w-[100px]">Department</th>
                      <th className="py-2.5 px-3 min-w-[150px]">Current Mobile / Phone</th>
                      <th className="py-2.5 px-3 min-w-[100px]">Country</th>
                      <th className="py-2.5 px-3 min-w-[120px]">Validation Result</th>
                      <th className="py-2.5 px-3 min-w-[160px]">Reason & Diagnostics</th>
                      <th className="py-2.5 px-3 min-w-[200px]">Corrected Mobile</th>
                      <th className="py-2.5 px-3 text-center min-w-[70px]">Primary</th>
                      <th className="py-2.5 px-3 text-right min-w-[110px]">Action</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-gray-100">
                    {filteredItems.length === 0 ? (
                      <tr>
                        <td colSpan={10} className="py-10 text-center text-gray-500 text-xs">
                          No contact records found matching the current category and filters.
                        </td>
                      </tr>
                    ) : (
                      filteredItems.map((item, idx) => {
                        const currentVal = getInputValue(item);
                        const currentPerson = getPersonValue(item);
                        const currentDept = getDeptValue(item);
                        const valResult = validatePhoneNumber(currentVal);

                        const isPhoneChanged = currentVal !== (item.raw_phone || '');
                        const isPersonChanged = currentPerson !== (item.contact_person || '');
                        const isDeptChanged = currentDept !== (item.department || 'Purchasing');
                        const isChanged = isPhoneChanged || isPersonChanged || isDeptChanged;

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
                            <td className="py-2.5 px-3">
                              <input
                                type="text"
                                value={currentPerson}
                                onChange={e => handlePersonInputChange(item.id, e.target.value)}
                                placeholder="Contact Name"
                                className="w-full px-2 py-0.5 text-xs bg-transparent border-b border-transparent hover:border-gray-300 focus:border-emerald-500 focus:bg-white focus:outline-hidden font-medium text-gray-900"
                              />
                              {item.email && (
                                <a
                                  href={`mailto:${item.email}`}
                                  className="text-[10px] text-blue-600 hover:underline block truncate max-w-[130px]"
                                  title={item.email}
                                >
                                  {item.email}
                                </a>
                              )}
                            </td>

                            {/* Department Badge & Selector */}
                            <td className="py-2.5 px-3">
                              <select
                                value={currentDept}
                                onChange={e => handleDeptInputChange(item.id, e.target.value)}
                                className={`text-[10px] font-bold rounded px-1.5 py-0.5 border cursor-pointer focus:outline-hidden ${
                                  currentDept === 'Purchasing'
                                    ? 'bg-blue-50 text-blue-800 border-blue-200'
                                    : currentDept === 'Import'
                                    ? 'bg-purple-50 text-purple-800 border-purple-200'
                                    : currentDept === 'QA / QC'
                                    ? 'bg-teal-50 text-teal-800 border-teal-200'
                                    : currentDept === 'Sales'
                                    ? 'bg-amber-50 text-amber-800 border-amber-200'
                                    : currentDept === 'Finance'
                                    ? 'bg-emerald-50 text-emerald-800 border-emerald-200'
                                    : 'bg-slate-100 text-slate-700 border-slate-300'
                                }`}
                              >
                                {CRM_DEPARTMENTS.map(d => (
                                  <option key={d} value={d}>{d}</option>
                                ))}
                              </select>
                            </td>

                            {/* Current Raw Phone */}
                            <td className="py-2.5 px-3 font-mono text-gray-900">
                              <div className="flex items-center gap-1.5">
                                <span className={item.raw_phone ? 'font-semibold text-xs' : 'text-gray-400 italic text-[11px]'}>
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
                              {item.extension && (
                                <span className="text-[10px] text-gray-500 font-sans block">
                                  Ext: {item.extension}
                                </span>
                              )}
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

                            {/* Type / Eligibility */}
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
                                  <span className="inline-flex items-center gap-1 px-1.5 py-0.2 rounded text-[9px] font-extrabold bg-orange-100 text-orange-900 border border-orange-300 block w-fit">
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

                            {/* Corrected Mobile */}
                            <td className="py-2.5 px-3">
                              <div className="space-y-1">
                                <div className="flex items-center gap-1">
                                  <input
                                    type="text"
                                    value={currentVal}
                                    onChange={e => handlePhoneInputChange(item.id, e.target.value)}
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

                                {isPhoneChanged && (
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

                            {/* Primary Designation */}
                            <td className="py-2.5 px-3 text-center">
                              <button
                                type="button"
                                onClick={() => handleTogglePrimary(item)}
                                className={`p-1 rounded transition cursor-pointer ${
                                  item.is_primary
                                    ? 'text-amber-500 bg-amber-50 hover:bg-amber-100'
                                    : 'text-gray-300 hover:text-gray-500'
                                }`}
                                title={item.is_primary ? 'Primary phone for this company' : 'Click to make primary phone'}
                              >
                                <Star className={`w-4 h-4 ${item.is_primary ? 'fill-amber-400 text-amber-500' : ''}`} />
                              </button>
                            </td>

                            {/* Actions (Save & Delete) */}
                            <td className="py-2.5 px-3 text-right">
                              <div className="flex items-center justify-end gap-1.5">
                                <button
                                  type="button"
                                  onClick={() => handleSaveContact(item)}
                                  disabled={!isChanged || isSaving}
                                  className={`px-2.5 py-1 rounded text-xs font-bold transition inline-flex items-center gap-1 ${
                                    isChanged
                                      ? 'bg-emerald-600 hover:bg-emerald-700 text-white cursor-pointer shadow-xs'
                                      : 'bg-gray-100 text-gray-400 cursor-not-allowed'
                                  }`}
                                  title="Save phone number updates"
                                >
                                  {isSaving ? (
                                    <Loader2 className="w-3 h-3 animate-spin" />
                                  ) : (
                                    <Check className="w-3 h-3" />
                                  )}
                                  <span>Save</span>
                                </button>

                                {!item.id.includes('_missing') && (
                                  <button
                                    type="button"
                                    onClick={() => setDeleteCandidate(item)}
                                    className="p-1 text-gray-400 hover:text-rose-600 hover:bg-rose-50 rounded transition cursor-pointer"
                                    title="Delete this phone number"
                                  >
                                    <Trash2 className="w-3.5 h-3.5" />
                                  </button>
                                )}
                              </div>
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
        {/* 5. MODAL FOOTER                                                      */}
        {/* ==================================================================== */}
        <div className="px-5 py-3 bg-slate-50 border-t border-slate-200 flex flex-col sm:flex-row items-center justify-between gap-3 text-xs shrink-0">
          <div className="flex items-center gap-2 text-gray-500 text-[11px]">
            <ShieldCheck className="w-4 h-4 text-emerald-600 shrink-0" />
            <span>
              Real-time PostgreSQL integration &bull; Multiple numbers per company supported &bull; Audited changes recorded in crm_activities
            </span>
          </div>

          <button
            type="button"
            onClick={onClose}
            className="px-4 py-1.5 bg-slate-800 hover:bg-slate-900 text-white rounded-md font-semibold transition cursor-pointer shadow-xs"
          >
            Done / Close (Return to Campaigns)
          </button>
        </div>
      </div>

      {/* ==================================================================== */}
      {/* 6. ADD PHONE NUMBER MODAL                                            */}
      {/* ==================================================================== */}
      {showAddModal && (
        <div className="fixed inset-0 z-60 bg-black/50 backdrop-blur-xs flex items-center justify-center p-4 animate-in fade-in">
          <div className="bg-white rounded-xl shadow-2xl border border-gray-200 w-full max-w-md overflow-hidden">
            <div className="px-4 py-3 bg-slate-50 border-b border-gray-200 flex items-center justify-between">
              <div className="flex items-center gap-2">
                <Plus className="w-4 h-4 text-emerald-600" />
                <h3 className="text-sm font-bold text-gray-900">Add Company Phone Number</h3>
              </div>
              <button
                type="button"
                onClick={() => setShowAddModal(false)}
                className="text-gray-400 hover:text-gray-700"
              >
                <X className="w-4 h-4" />
              </button>
            </div>

            <form onSubmit={handleAddNewPhone} className="p-4 space-y-3.5 text-xs">
              <div>
                <label className="font-bold text-gray-700 uppercase block mb-1">Company *</label>
                <select
                  value={newCompanyId}
                  onChange={e => {
                    setNewCompanyId(e.target.value);
                    const comp = contacts.find(c => c.id === e.target.value);
                    if (comp?.contact_person) setNewContactPerson(comp.contact_person);
                  }}
                  className="w-full border border-gray-300 rounded-md p-1.5 bg-white text-xs focus:outline-emerald-500"
                  required
                >
                  <option value="">Select Company ({contacts.length} available)...</option>
                  {contacts.map(c => (
                    <option key={c.id} value={c.id}>
                      {c.company_name} {c.city ? `(${c.city})` : ''}
                    </option>
                  ))}
                </select>
              </div>

              <div className="grid grid-cols-2 gap-3">
                <div>
                  <label className="font-bold text-gray-700 uppercase block mb-1">Contact Person</label>
                  <input
                    type="text"
                    value={newContactPerson}
                    onChange={e => setNewContactPerson(e.target.value)}
                    placeholder="e.g. Ibu Dewi / Bpk Rudi"
                    className="w-full border border-gray-300 rounded-md p-1.5 text-xs focus:outline-emerald-500"
                  />
                </div>

                <div>
                  <label className="font-bold text-gray-700 uppercase block mb-1">Department *</label>
                  <select
                    value={newDepartment}
                    onChange={e => setNewDepartment(e.target.value)}
                    className="w-full border border-gray-300 rounded-md p-1.5 bg-white text-xs focus:outline-emerald-500"
                  >
                    {CRM_DEPARTMENTS.map(d => (
                      <option key={d} value={d}>{d}</option>
                    ))}
                  </select>
                </div>
              </div>

              <div>
                <label className="font-bold text-gray-700 uppercase block mb-1">Phone Number *</label>
                <input
                  type="text"
                  value={newPhoneNumber}
                  onChange={e => setNewPhoneNumber(e.target.value)}
                  placeholder="e.g. 081234567890 or 021-55787162"
                  className="w-full border border-gray-300 rounded-md p-1.5 text-xs font-mono focus:outline-emerald-500"
                  required
                />
                {newPhoneNumber.trim() && (
                  <div className="mt-1 text-[10px]">
                    {validatePhoneNumber(newPhoneNumber).type === 'valid_mobile' ? (
                      <span className="text-emerald-700 font-bold">
                        ✓ Valid Mobile ({validatePhoneNumber(newPhoneNumber).normalized})
                      </span>
                    ) : validatePhoneNumber(newPhoneNumber).type === 'landline' ? (
                      <span className="text-amber-700 font-bold">
                        ☎ Landline ({validatePhoneNumber(newPhoneNumber).normalized})
                      </span>
                    ) : (
                      <span className="text-rose-700 font-bold">
                        ✕ {validatePhoneNumber(newPhoneNumber).reason}
                      </span>
                    )}
                  </div>
                )}
              </div>

              <div className="flex items-center gap-2 pt-1">
                <input
                  type="checkbox"
                  id="newPhonePrimaryCheck"
                  checked={newPhoneIsPrimary}
                  onChange={e => setNewPhoneIsPrimary(e.target.checked)}
                  className="rounded text-emerald-600 focus:ring-emerald-500 cursor-pointer"
                />
                <label htmlFor="newPhonePrimaryCheck" className="text-gray-700 font-medium cursor-pointer">
                  Designate as Primary Contact Number
                </label>
              </div>

              <div className="pt-2 flex justify-end gap-2 border-t">
                <button
                  type="button"
                  onClick={() => setShowAddModal(false)}
                  className="px-3 py-1.5 border rounded-md text-gray-600 hover:bg-gray-100"
                >
                  Cancel
                </button>
                <button
                  type="submit"
                  disabled={isAddingPhone}
                  className="px-4 py-1.5 bg-emerald-600 hover:bg-emerald-700 text-white rounded-md font-semibold disabled:opacity-50 inline-flex items-center gap-1"
                >
                  {isAddingPhone ? <Loader2 className="w-3 h-3 animate-spin" /> : <Plus className="w-3 h-3" />}
                  <span>Save Phone</span>
                </button>
              </div>
            </form>
          </div>
        </div>
      )}

      {/* ==================================================================== */}
      {/* 7. DELETE PHONE CONFIRMATION DIALOG                                  */}
      {/* ==================================================================== */}
      {deleteCandidate && (
        <div className="fixed inset-0 z-60 bg-black/50 backdrop-blur-xs flex items-center justify-center p-4 animate-in fade-in">
          <div className="bg-white rounded-xl shadow-2xl border border-gray-200 w-full max-w-sm p-4 space-y-3">
            <div className="flex items-center gap-2 text-rose-600">
              <AlertTriangle className="w-5 h-5 shrink-0" />
              <h3 className="text-sm font-bold text-gray-900">Remove Phone Number</h3>
            </div>

            <p className="text-xs text-gray-600 leading-relaxed">
              Are you sure you want to remove <strong className="font-mono text-gray-900">{deleteCandidate.raw_phone}</strong> from <strong>{deleteCandidate.company_name}</strong>?
              {deleteCandidate.is_primary && (
                <span className="block mt-1 text-amber-700 font-semibold">
                  Note: This is currently designated as the primary phone. Another number will be promoted to primary automatically.
                </span>
              )}
            </p>

            <div className="pt-2 flex justify-end gap-2 border-t">
              <button
                type="button"
                onClick={() => setDeleteCandidate(null)}
                className="px-3 py-1.5 border rounded-md text-gray-600 hover:bg-gray-100 text-xs"
              >
                Cancel
              </button>
              <button
                type="button"
                onClick={handleConfirmDelete}
                disabled={isDeleting}
                className="px-3 py-1.5 bg-rose-600 hover:bg-rose-700 text-white rounded-md font-semibold text-xs inline-flex items-center gap-1 disabled:opacity-50"
              >
                {isDeleting ? <Loader2 className="w-3 h-3 animate-spin" /> : <Trash2 className="w-3 h-3" />}
                <span>Remove</span>
              </button>
            </div>
          </div>
        </div>
      )}

      {/* ==================================================================== */}
      {/* 8. BULK NORMALIZATION PREVIEW MODAL                                  */}
      {/* ==================================================================== */}
      {showBulkPreview && (
        <div className="fixed inset-0 z-60 bg-black/50 backdrop-blur-xs flex items-center justify-center p-4 animate-in fade-in">
          <div className="bg-white rounded-xl shadow-2xl border border-gray-200 w-full max-w-3xl max-h-[85vh] flex flex-col overflow-hidden">
            <div className="px-5 py-3.5 bg-indigo-50 border-b border-indigo-200 flex items-center justify-between">
              <div className="flex items-center gap-2">
                <Sparkles className="w-4 h-4 text-indigo-600" />
                <h3 className="text-sm font-bold text-indigo-950">
                  Safe Bulk Mobile Normalization Preview ({bulkCandidates.length} Candidates)
                </h3>
              </div>
              <button
                type="button"
                onClick={() => setShowBulkPreview(false)}
                className="text-gray-400 hover:text-gray-700"
              >
                <X className="w-4 h-4" />
              </button>
            </div>

            <div className="p-4 bg-amber-50 border-b border-amber-200 text-xs text-amber-900 flex items-start gap-2">
              <Info className="w-4 h-4 text-amber-600 shrink-0 mt-0.5" />
              <div>
                <strong>Staff approval required:</strong> Only unambiguous Indonesian mobile numbers (08... &bull; 628...) are formatted to E.164 (+628...). Landlines and incomplete numbers are strictly excluded.
              </div>
            </div>

            <div className="flex-1 overflow-y-auto p-4">
              <table className="w-full text-left text-xs border-collapse">
                <thead>
                  <tr className="bg-gray-50 border-b border-gray-200 text-[10px] uppercase font-bold text-gray-500">
                    <th className="py-2 px-3 w-10">
                      <input
                        type="checkbox"
                        checked={selectedBulkCandidateIds.size === bulkCandidates.length}
                        onChange={e => {
                          if (e.target.checked) {
                            setSelectedBulkCandidateIds(new Set(bulkCandidates.map(c => c.contactId)));
                          } else {
                            setSelectedBulkCandidateIds(new Set());
                          }
                        }}
                        className="rounded text-indigo-600"
                      />
                    </th>
                    <th className="py-2 px-3">Company</th>
                    <th className="py-2 px-3">Contact Person</th>
                    <th className="py-2 px-3 font-mono">Current Raw</th>
                    <th className="py-2 px-3 font-mono text-emerald-700">Proposed Normalized</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-gray-100">
                  {bulkCandidates.map(cand => (
                    <tr key={cand.contactId} className="hover:bg-indigo-50/30">
                      <td className="py-2 px-3">
                        <input
                          type="checkbox"
                          checked={selectedBulkCandidateIds.has(cand.contactId)}
                          onChange={e => {
                            const next = new Set(selectedBulkCandidateIds);
                            if (e.target.checked) next.add(cand.contactId);
                            else next.delete(cand.contactId);
                            setSelectedBulkCandidateIds(next);
                          }}
                          className="rounded text-indigo-600"
                        />
                      </td>
                      <td className="py-2 px-3 font-semibold text-gray-900">{cand.companyName}</td>
                      <td className="py-2 px-3 text-gray-600">{cand.contactPerson || '—'}</td>
                      <td className="py-2 px-3 font-mono text-gray-700">{cand.currentRaw}</td>
                      <td className="py-2 px-3 font-mono font-bold text-emerald-700">
                        {cand.proposedNormalized}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>

            <div className="px-5 py-3 bg-gray-50 border-t border-gray-200 flex items-center justify-between text-xs">
              <span className="text-gray-500 font-medium">
                {selectedBulkCandidateIds.size} of {bulkCandidates.length} selected for normalization
              </span>
              <div className="flex items-center gap-2">
                <button
                  type="button"
                  onClick={() => setShowBulkPreview(false)}
                  className="px-3 py-1.5 border rounded-md text-gray-600 hover:bg-gray-100"
                >
                  Cancel
                </button>
                <button
                  type="button"
                  onClick={handleApplyBulkNormalization}
                  disabled={selectedBulkCandidateIds.size === 0 || isApplyingBulk}
                  className="px-4 py-1.5 bg-indigo-600 hover:bg-indigo-700 text-white rounded-md font-semibold disabled:opacity-50 inline-flex items-center gap-1.5"
                >
                  {isApplyingBulk ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <Sparkles className="w-3.5 h-3.5" />}
                  <span>Confirm & Apply ({selectedBulkCandidateIds.size})</span>
                </button>
              </div>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

export default PhoneAuditCorrectionModal;
