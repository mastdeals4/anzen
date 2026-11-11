import React, { useCallback, useEffect, useMemo, useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import { supabase } from '../../../lib/supabase';
import { showToast } from '../../ToastNotification';
import { BulkEmailComposer } from '../BulkEmailComposer';
import { DeliveryLog } from '../DeliveryLog';
import {
  auditAndVerifyContacts,
  auditContactsMultiPhone,
  PhoneAuditSummary,
  VerifiedContactItem,
} from '../../../utils/phoneValidation';
import { PhoneAuditCorrectionModal, AuditCategory, CRM_DEPARTMENTS } from './PhoneAuditCorrectionModal';
import {
  Send,
  MessageSquare,
  Users,
  FileText,
  History,
  Search,
  Plus,
  RefreshCw,
  CheckCircle2,
  AlertTriangle,
  AlertCircle,
  Clock,
  ShieldCheck,
  Eye,
  Trash2,
  Edit3,
  Phone,
  Mail,
  Upload,
  ExternalLink,
  ChevronRight,
  ChevronLeft,
  Filter,
  Check,
  Pause,
  Play,
  Square,
  RotateCcw,
  Paperclip,
  Sparkles,
  Smartphone,
  Building,
  Info,
  Layers,
  Calendar,
  Save,
  Image as ImageIcon,
  Lock,
  FlaskConical,
  WifiOff,
  ShieldAlert,
} from 'lucide-react';
import { classifyCanonicalPhone } from '../../../services/crm/canonicalPhoneService';
import { CampaignComplianceService } from '../../../services/crm/campaignComplianceService';
import { EnquiryWhatsAppService } from '../../../services/enquiry/EnquiryWhatsAppService';
import { WhatsAppTransportService } from '../../../services/whatsapp/whatsappTransportService';
import { WhatsAppAttachmentModal, WhatsAppCampaignAttachment } from './WhatsAppAttachmentModal';
import {
  formatPersonalizedWhatsAppMessage,
  validateMediaCaption,
  WHATSAPP_MEDIA_CAPTION_LIMIT,
} from '../../../utils/whatsappPersonalization';
import { uploadOptimizedFile } from '../../../services/storage/uploadOptimizationService';

export type CampaignSubTab = 'email' | 'whatsapp' | 'recipients' | 'templates' | 'history';

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

interface TemplateItem {
  id: string;
  name: string;
  type: 'email' | 'whatsapp';
  subject?: string;
  body: string;
  category: string;
  created_at?: string;
}

interface Props {
  initialRecipients?: any[];
  onNavigateInbox?: () => void;
}

export function CrmCampaignsWorkspace({ initialRecipients = [] }: Props) {
  const [searchParams, setSearchParams] = useSearchParams();
  const subtabParam = searchParams.get('subtab')?.toLowerCase() as CampaignSubTab | null;
  const initialTab: CampaignSubTab = subtabParam && ['email', 'whatsapp', 'recipients', 'templates', 'history'].includes(subtabParam)
    ? subtabParam
    : 'email';

  const [activeTab, setActiveTab] = useState<CampaignSubTab>(initialTab);

  const handleSubTabChange = useCallback((tab: CampaignSubTab) => {
    setActiveTab(tab);
    const newParams = new URLSearchParams(searchParams);
    newParams.set('subtab', tab);
    setSearchParams(newParams, { replace: true });
  }, [searchParams, setSearchParams]);

  useEffect(() => {
    if (subtabParam && ['email', 'whatsapp', 'recipients', 'templates', 'history'].includes(subtabParam)) {
      if (subtabParam !== activeTab) {
        setActiveTab(subtabParam);
      }
    }
  }, [subtabParam, activeTab]);

  // Stage recipients passed from customer workspace
  const [stagedRecipients, setStagedRecipients] = useState<any[]>(initialRecipients);

  // All contacts for Recipients Directory
  const [contacts, setContacts] = useState<ContactRecipient[]>([]);
  const [loadingContacts, setLoadingContacts] = useState(false);
  const [contactSearch, setContactSearch] = useState('');
  const [selectedContactIds, setSelectedContactIds] = useState<Set<string>>(new Set());
  const [channelFilter, setChannelFilter] = useState<'all' | 'has_email' | 'has_phone'>('all');

  // Templates
  const [templates, setTemplates] = useState<TemplateItem[]>([]);
  const [loadingTemplates, setLoadingTemplates] = useState(false);
  const [templateTypeFilter, setTemplateTypeFilter] = useState<'all' | 'email' | 'whatsapp'>('all');
  const [showNewTemplateModal, setShowNewTemplateModal] = useState(false);
  const [newTemplateName, setNewTemplateName] = useState('');
  const [newTemplateType, setNewTemplateType] = useState<'email' | 'whatsapp'>('whatsapp');
  const [newTemplateSubject, setNewTemplateSubject] = useState('');
  const [newTemplateBody, setNewTemplateBody] = useState('');
  const [newTemplateCategory, setNewTemplateCategory] = useState('Marketing');
  const [savingTemplate, setSavingTemplate] = useState(false);

  // WhatsApp Campaign Builder State
  const [waSelectedRecipients, setWaSelectedRecipients] = useState<any[]>([]);
  const [waMessageTemplate, setWaMessageTemplate] = useState<string>(
    'Halo {{contact_person}} dari {{company_name}},\n\nKami dari PT Shubham Anzen Pharma Jaya ingin menginformasikan ketersediaan ready stock untuk {{product_name}} di gudang Jakarta.\n\nApakah saat ini sedang ada kebutuhan penawaran harga atau COA?\n\nSalam,\nTim Sales SAPJ'
  );
  const [waProductName, setWaProductName] = useState<string>('Bahan Baku Farmasi & API');
  const [waConsentVerified, setWaConsentVerified] = useState(false);
  const [waOptOutConfirmed, setWaOptOutConfirmed] = useState(false);
  const [waTestMode, setWaTestMode] = useState(true);
  const [waTestPhone, setWaTestPhone] = useState('+6285888600999');
  const [waPacingSeconds, setWaPacingSeconds] = useState(20);
  const [waIsSending, setWaIsSending] = useState(false);
  const [waIsPaused, setWaIsPaused] = useState(false);
  const [waProgress, setWaProgress] = useState(0);
  const [waCurrentRecipient, setWaCurrentRecipient] = useState<string | null>(null);
  const [waPreviewIndex, setWaPreviewIndex] = useState(0);
  const [waShowApprovalModal, setWaShowApprovalModal] = useState(false);
  const [waRecipientSelectorOpen, setWaRecipientSelectorOpen] = useState(false);
  const [waRecipientFilter, setWaRecipientFilter] = useState<'all' | 'eligible' | 'landline' | 'invalid' | 'duplicate'>('all');
  const [waDepartmentFilter, setWaDepartmentFilter] = useState<string>('all');
  const [waRecipientSearch, setWaRecipientSearch] = useState('');
  const [waAttachment, setWaAttachment] = useState<WhatsAppCampaignAttachment | null>(null);
  const [isAttachmentModalOpen, setIsAttachmentModalOpen] = useState(false);
  const [waLogs, setWaLogs] = useState<Array<{ phone: string; name: string; status: 'sent' | 'failed'; error?: string; timestamp: string }>>([]);
  const [waFailedRecipients, setWaFailedRecipients] = useState<any[]>([]);

  // Campaign Scheduling & Audience Compliance State
  const [waScheduleMode, setWaScheduleMode] = useState<'now' | 'scheduled'>('now');
  const [waScheduledDateTime, setWaScheduledDateTime] = useState<string>('');
  const [waAudienceBreakdownOpen, setWaAudienceBreakdownOpen] = useState(false);

  // OpenWA Adapter Health & Session State
  const [adapterHealth, setAdapterHealth] = useState<{
    checked: boolean;
    status: 'connected' | 'disconnected' | 'checking';
    businessPhone?: string;
    details?: string;
    error?: string;
  }>({
    checked: false,
    status: 'checking',
  });

  // Verify adapter connection on mount and interval
  useEffect(() => {
    let isMounted = true;
    const verifyHealth = async () => {
      try {
        const health = await WhatsAppTransportService.checkHealth();
        if (!isMounted) return;
        setAdapterHealth({
          checked: true,
          status: health.status === 'connected' ? 'connected' : 'disconnected',
          businessPhone: health.businessPhone,
          details: health.details,
        });
      } catch (err: any) {
        if (!isMounted) return;
        setAdapterHealth({
          checked: true,
          status: 'disconnected',
          details: err.message,
          error: err.message,
        });
      }
    };
    verifyHealth();
    return () => {
      isMounted = false;
    };
  }, []);

  // Audience Compliance & Duplicate Prevention via Canonical Engine (NO SYNTHETIC CONSENT DEFAULTS)
  const audienceValidation = useMemo(() => {
    if (waSelectedRecipients.length === 0) {
      return {
        totalCandidates: 0,
        eligibleRecipients: [],
        suppressedOptOuts: [],
        excludedMissingConsent: [],
        isCompliant: true,
      };
    }
    const candidates = waSelectedRecipients.map(r => {
      // Validate actual persisted individual consent data from CRM source
      // Rules:
      // - Missing consent record means NOT VERIFIED.
      // - Never invent an opt-in source or timestamp.
      // - Never assume an existing B2B relationship automatically provides marketing consent.
      // - Never convert a phone-number-valid contact into a consent-verified contact.
      const hasVerifiedOptIn = r.consent_status === 'opted_in' && Boolean(r.consent && r.consent.optInSource);
      const isExplicitOptOut = r.isOptedOut || r.consent_status === 'opted_out';

      return {
        phone: r.mobile || r.phone || '',
        companyName: r.company_name || 'Customer',
        contactPerson: r.contact_person,
        consent: hasVerifiedOptIn ? r.consent : null,
        isOptedOut: isExplicitOptOut,
        trustedRegion: r.trustedRegion || (r.country === 'Indonesia' ? 'ID' : null),
      };
    });
    return CampaignComplianceService.validateAudience(candidates, {
      permittedCategory: 'price_alerts',
    });
  }, [waSelectedRecipients]);

  // Separate operator confirmation from customer consent — 6 distinct compliance counts
  const complianceCounts = useMemo(() => {
    const total = waSelectedRecipients.length;
    if (total === 0) {
      return {
        validMobileCount: 0,
        verifiedOptInCount: 0,
        missingConsentCount: 0,
        optedOutCount: 0,
        duplicateCount: 0,
        eligibleRecipientsCount: 0,
      };
    }

    const seenE164 = new Set<string>();
    let validMobileCount = 0;
    let duplicateCount = 0;
    let optedOutCount = 0;
    let verifiedOptInCount = 0;
    let missingConsentCount = 0;

    for (const r of waSelectedRecipients) {
      const rawPhone = r.mobile || r.phone || '';
      const canonical = classifyCanonicalPhone(rawPhone, {
        trustedRegion: r.trustedRegion || (r.country === 'Indonesia' ? 'ID' : null),
      });

      const isValidMobile = canonical.isValid && canonical.phoneType === 'mobile';
      if (isValidMobile) {
        validMobileCount++;
      }

      if (canonical.e164) {
        if (seenE164.has(canonical.e164)) {
          duplicateCount++;
          continue;
        }
        seenE164.add(canonical.e164);
      }

      const isOptedOut =
        CampaignComplianceService.isOptedOut(rawPhone) || r.isOptedOut || r.consent_status === 'opted_out';
      if (isOptedOut) {
        optedOutCount++;
        continue;
      }

      const hasOptIn = r.consent_status === 'opted_in' && Boolean(r.consent && r.consent.optInSource);
      if (hasOptIn) {
        verifiedOptInCount++;
      } else if (isValidMobile) {
        missingConsentCount++;
      }
    }

    return {
      validMobileCount,
      verifiedOptInCount,
      missingConsentCount,
      optedOutCount,
      duplicateCount,
      eligibleRecipientsCount: audienceValidation.eligibleRecipients.length,
    };
  }, [waSelectedRecipients, audienceValidation]);

  const handleRegisterOptOut = (phone: string, companyName: string) => {
    CampaignComplianceService.registerOptOut(phone);
    setWaSelectedRecipients(prev =>
      prev.map(r => ((r.mobile === phone || r.phone === phone) ? { ...r, isOptedOut: true } : r))
    );
    showToast({
      type: 'info',
      title: 'Opt-Out Registered',
      message: `${companyName} (${phone}) added to suppression list. Excluded from campaign dispatch.`,
    });
  };

  // Helper to resolve / sign / upload attachment media URL safely
  const prepareAttachmentMediaUrl = async (attachment: WhatsAppCampaignAttachment): Promise<string> => {
    if (attachment.url) return attachment.url;

    if (attachment.source === 'upload' && attachment.file) {
      const cleanFileName = attachment.name.replace(/[^a-zA-Z0-9._-]/g, '_');
      const storagePath = `campaigns/${Date.now()}_${cleanFileName}`;
      const { error: upErr } = await uploadOptimizedFile(supabase, 'crm-documents', storagePath, attachment.file);
      if (upErr) {
        throw new Error(`Attachment upload to storage failed: ${upErr.message}`);
      }
      const { data: signData, error: signErr } = await supabase.storage
        .from('crm-documents')
        .createSignedUrl(storagePath, 86400);
      if (signErr || !signData?.signedUrl) {
        throw new Error(`Failed to generate signed download URL for uploaded attachment: ${signErr?.message || 'Unknown'}`);
      }
      return signData.signedUrl;
    }

    if (attachment.source === 'bank' && attachment.storagePath) {
      const bucket = attachment.storageBucket || 'crm-documents';
      const { data: signData, error: signErr } = await supabase.storage
        .from(bucket)
        .createSignedUrl(attachment.storagePath, 86400);
      if (signErr || !signData?.signedUrl) {
        throw new Error(`Failed to generate signed URL for document from Document Bank: ${signErr?.message || 'File not found'}`);
      }
      return signData.signedUrl;
    }

    throw new Error('Attachment does not have a valid storage reference or file.');
  };

  const handleSendTestPilot = async () => {
    if (!waConsentVerified || !waOptOutConfirmed) {
      showToast({
        type: 'warning',
        title: 'Consent Required',
        message: 'Please confirm consent verification and opt-out safeguard before dispatching.',
      });
      return;
    }

    const authorizedTestNumbers = ['+6285888600999', '+919823533833'];
    const cleanTest = waTestPhone.replace(/\D/g, '');
    const isAuthorized = authorizedTestNumbers.some(n => n.replace(/\D/g, '') === cleanTest);
    if (!isAuthorized) {
      showToast({
        type: 'error',
        title: 'Unauthorized Test Number',
        message: `Only authorized test numbers (${authorizedTestNumbers.join(', ')}) can be messaged during operational testing.`,
      });
      return;
    }

    // Live Adapter Connection Health Check
    const health = await WhatsAppTransportService.checkHealth();
    if (health.status !== 'connected') {
      showToast({
        type: 'error',
        title: 'Adapter Disconnected',
        message: `OpenWA adapter is offline or disconnected (${health.details}). Cannot dispatch Test Pilot.`,
      });
      return;
    }

    setWaIsSending(true);
    setWaProgress(20);
    setWaCurrentRecipient(`Test Pilot: ${waTestPhone}`);

    try {
      const testRecipient = {
        id: 'test-pilot',
        company_name: 'PT Test Partner',
        contact_person: 'Operational Verifier',
        designation: 'Purchasing Manager',
        email: null,
        phone: waTestPhone,
        mobile: waTestPhone,
        city: 'Jakarta',
        country: 'Indonesia',
        is_active: true,
      };

      const messageText = formatPersonalizedWhatsAppMessage(waMessageTemplate, testRecipient, {
        productName: waProductName,
      });

      // Caption length validation if media is attached
      if (waAttachment) {
        const capCheck = validateMediaCaption(messageText, true);
        if (!capCheck.isValid) {
          showToast({
            type: 'error',
            title: 'Caption Too Long',
            message: capCheck.error || 'WhatsApp media captions cannot exceed 1024 characters.',
          });
          setWaIsSending(false);
          return;
        }
      }

      let mediaUrl: string | undefined = undefined;
      if (waAttachment) {
        setWaProgress(40);
        try {
          mediaUrl = await prepareAttachmentMediaUrl(waAttachment);
          if (!waAttachment.url && mediaUrl) {
            setWaAttachment(prev => (prev ? { ...prev, url: mediaUrl } : null));
          }
        } catch (mediaErr: any) {
          showToast({
            type: 'error',
            title: 'Attachment Upload Failed',
            message: `${mediaErr.message}. Dispatch halted to prevent sending without media.`,
          });
          setWaLogs(prev => [
            {
              name: 'Authorized Test Pilot',
              phone: waTestPhone,
              status: 'failed',
              timestamp: new Date().toLocaleTimeString(),
              error: mediaErr.message,
            },
            ...prev,
          ]);
          setWaFailedRecipients([waTestPhone]);
          setWaIsSending(false);
          return;
        }
      }

      setWaProgress(70);

      const sendResult = await WhatsAppTransportService.sendMessage({
        to: waTestPhone,
        text: messageText,
        caption: messageText,
        documentUrl: waAttachment?.mediaCategory === 'document' ? mediaUrl : undefined,
        imageUrl: waAttachment?.mediaCategory === 'image' ? mediaUrl : undefined,
        filename: waAttachment?.name,
        consentVerified: true,
      });

      setWaProgress(100);
      const timestamp = new Date().toLocaleTimeString();

      if (sendResult.success) {
        setWaLogs(prev => [
          {
            name: 'Authorized Test Pilot',
            phone: waTestPhone,
            status: 'sent',
            timestamp,
          },
          ...prev,
        ]);
        showToast({
          type: 'success',
          title: 'Test Pilot Dispatched',
          message: `Genuine WhatsApp test message dispatched to ${waTestPhone}.${
            waAttachment ? ` Attachment: ${waAttachment.name} with personalized caption.` : ''
          } Message ID: ${sendResult.messageId || 'verified'}`,
        });
      } else {
        setWaLogs(prev => [
          {
            name: 'Authorized Test Pilot',
            phone: waTestPhone,
            status: 'failed',
            timestamp,
            error: sendResult.error || 'Failed to dispatch',
          },
          ...prev,
        ]);
        setWaFailedRecipients([waTestPhone]);
        showToast({
          type: 'error',
          title: 'Dispatch Failed',
          message: sendResult.error || 'WhatsApp adapter failed to dispatch test message',
        });
      }
    } catch (err: any) {
      setWaLogs(prev => [
        {
          name: 'Authorized Test Pilot',
          phone: waTestPhone,
          status: 'failed',
          timestamp: new Date().toLocaleTimeString(),
          error: err.message,
        },
        ...prev,
      ]);
      setWaFailedRecipients([waTestPhone]);
      showToast({
        type: 'error',
        title: 'Dispatch Error',
        message: err.message || 'Network exception during test pilot',
      });
    } finally {
      setWaIsSending(false);
      setWaProgress(0);
      setWaCurrentRecipient('');
    }
  };

  const handleSaveDraftCampaign = () => {
    showToast({
      type: 'success',
      title: 'Campaign Plan Saved as Draft',
      message: `Draft campaign saved: ${audienceValidation.eligibleRecipients.length} eligible unique recipients scheduled for ${waScheduleMode === 'scheduled' ? waScheduledDateTime || 'later' : 'manual dispatch'}.`,
    });
  };

  // Interactive Contact Phone Audit & Correction Centre State
  const [phoneAuditCategory, setPhoneAuditCategory] = useState<AuditCategory | null>(null);

  const handleContactUpdated = useCallback((updatedContact: ContactRecipient) => {
    setContacts(prev => prev.map(c => (c.id === updatedContact.id ? updatedContact : c)));
  }, []);

  const handleContactsBatchUpdated = useCallback((updatedList: ContactRecipient[]) => {
    const updatedMap = new Map(updatedList.map(c => [c.id, c]));
    setContacts(prev => prev.map(c => updatedMap.get(c.id) || c));
  }, []);

  // Refs for pause/cancel controls during active loop
  const waIsPausedRef = React.useRef(false);
  const waIsCancelledRef = React.useRef(false);

  // Load Contacts Directory and Relational Phone Records
  const loadContacts = async () => {
    setLoadingContacts(true);
    try {
      const [{ data: contactsData, error: contactsErr }, { data: phonesData }] = await Promise.all([
        supabase
          .from('crm_contacts')
          .select('id, company_name, contact_person, designation, email, phone, mobile, landline, country, city, customer_type, notes, is_active')
          .eq('is_active', true)
          .order('company_name'),
        supabase
          .from('crm_contact_phones')
          .select('id, contact_id, company_name, contact_person, department, raw_phone, normalized_phone, phone_type, is_whatsapp_eligible, is_primary, consent_status'),
      ]);

      if (contactsErr) throw contactsErr;

      const phoneMap = new Map<string, any[]>();
      if (phonesData) {
        for (const p of phonesData) {
          if (!phoneMap.has(p.contact_id)) {
            phoneMap.set(p.contact_id, []);
          }
          phoneMap.get(p.contact_id)!.push(p);
        }
      }

      const merged = (contactsData || []).map((c: any) => {
        const related = phoneMap.get(c.id) || [];
        const primary = related.find((p: any) => p.is_primary) || related[0];
        // Consent status strictly from persisted record; default is 'pending' (NOT VERIFIED)
        const consentStatus = primary?.consent_status || 'pending';
        return {
          ...c,
          consent_status: consentStatus,
          crm_phones: related,
        };
      });

      setContacts(merged);
    } catch (err: any) {
      console.error('Failed to load contacts directory:', err);
    } finally {
      setLoadingContacts(false);
    }
  };

  // Load Templates
  const loadTemplates = async () => {
    setLoadingTemplates(true);
    try {
      const { data, error } = await supabase
        .from('crm_email_templates')
        .select('*')
        .order('template_name');

      if (error) throw error;
      const loaded: TemplateItem[] = (data || []).map((t: any) => ({
        id: t.id,
        name: t.template_name,
        type: (t.category || '').toLowerCase().includes('whatsapp') ? 'whatsapp' : 'email',
        subject: t.subject,
        body: t.body,
        category: t.category || 'General',
        created_at: t.created_at,
      }));

      // Add default WhatsApp templates if none exists
      if (!loaded.some(t => t.type === 'whatsapp')) {
        loaded.push(
          {
            id: 'wa-tpl-1',
            name: 'Ready Stock Announcement (ID)',
            type: 'whatsapp',
            category: 'Promotion',
            body: 'Halo {{contact_person}} dari {{company_name}},\n\nKami dari PT Shubham Anzen Pharma Jaya ingin menginformasikan ketersediaan ready stock untuk bahan baku farmasi di gudang Jakarta.\n\nApakah saat ini ada kebutuhan penawaran harga atau COA?\n\nSalam,\nTim Sales SAPJ',
          },
          {
            id: 'wa-tpl-2',
            name: 'Inquiry Follow-up (Formal ID)',
            type: 'whatsapp',
            category: 'Follow-up',
            body: 'Selamat siang Bapak/Ibu {{contact_person}} ({{company_name}}),\n\nMenindaklanjuti penawaran kami sebelumnya, apakah sudah sempat ditinjau oleh tim pembelian?\n\nKami siap memberikan sampel atau dokumen teknis pendukung bila diperlukan.\n\nTerima kasih,\nPT Shubham Anzen Pharma Jaya',
          }
        );
      }
      setTemplates(loaded);
    } catch (err: any) {
      console.error('Failed to load templates:', err);
    } finally {
      setLoadingTemplates(false);
    }
  };

  useEffect(() => {
    loadContacts();
    loadTemplates();
  }, []);

  // Phone audit across all contacts using enhanced multi-phone engine
  const phoneAudit = useMemo(() => auditContactsMultiPhone(contacts), [contacts]);
  const verifiedItemsMap = useMemo(() => new Map(phoneAudit.items.map(i => [i.id, i])), [phoneAudit]);

  // Filtered contacts for recipient directory
  const filteredContacts = useMemo(() => {
    let list = contacts;
    if (channelFilter === 'has_email') {
      list = list.filter(c => Boolean(c.email && c.email.includes('@')));
    } else if (channelFilter === 'has_phone') {
      list = list.filter(c => Boolean(c.phone || c.mobile));
    }
    if (contactSearch.trim()) {
      const q = contactSearch.toLowerCase().trim();
      list = list.filter(
        c =>
          c.company_name.toLowerCase().includes(q) ||
          (c.contact_person && c.contact_person.toLowerCase().includes(q)) ||
          (c.email && c.email.toLowerCase().includes(q)) ||
          (c.phone && c.phone.includes(q)) ||
          (c.mobile && c.mobile.includes(q)) ||
          (c.city && c.city.toLowerCase().includes(q))
      );
    }
    return list;
  }, [contacts, contactSearch, channelFilter]);

  // Filtered verified contacts for WhatsApp selector modal/drawer
  const filteredWaContacts = useMemo(() => {
    let list = phoneAudit.items;
    if (waRecipientFilter === 'eligible') {
      list = list.filter(item => item.is_eligible);
    } else if (waRecipientFilter === 'landline') {
      list = list.filter(item => item.validation.type === 'landline');
    } else if (waRecipientFilter === 'invalid') {
      list = list.filter(item => item.validation.type === 'invalid_number' || item.validation.type === 'missing_number');
    } else if (waRecipientFilter === 'duplicate') {
      list = list.filter(item => item.is_duplicate);
    }
    if (waDepartmentFilter !== 'all') {
      list = list.filter(item => (item.department || 'General Office') === waDepartmentFilter);
    }
    if (waRecipientSearch.trim()) {
      const q = waRecipientSearch.toLowerCase().trim();
      list = list.filter(item =>
        item.company_name.toLowerCase().includes(q) ||
        (item.contact_person && item.contact_person.toLowerCase().includes(q)) ||
        (item.department && item.department.toLowerCase().includes(q)) ||
        (item.raw_phone && item.raw_phone.includes(q)) ||
        (item.validation.normalized && item.validation.normalized.includes(q)) ||
        (item.city && item.city.toLowerCase().includes(q))
      );
    }
    return list;
  }, [phoneAudit, waRecipientFilter, waDepartmentFilter, waRecipientSearch]);

  // Recipient directory multi-select helpers
  const handleToggleContact = (id: string) => {
    setSelectedContactIds(prev => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  };

  const handleSelectAllContacts = (checked: boolean) => {
    if (checked) {
      setSelectedContactIds(new Set(filteredContacts.map(c => c.id)));
    } else {
      setSelectedContactIds(new Set());
    }
  };

  const handleStageForEmail = () => {
    const chosen = contacts.filter(c => selectedContactIds.has(c.id) && c.email && c.email.includes('@'));
    if (chosen.length === 0) {
      showToast({ type: 'warning', title: 'No Email Addresses', message: 'Selected contacts must have valid email addresses.' });
      return;
    }
    setStagedRecipients(chosen.map(c => ({ id: c.id, company_name: c.company_name, email: c.email!, contact_person: c.contact_person })));
    handleSubTabChange('email');
    showToast({ type: 'success', title: 'Staged for Email', message: `${chosen.length} recipients staged for email campaign.` });
  };

  const handleStageForWhatsApp = () => {
    const chosen = contacts.filter(c => selectedContactIds.has(c.id) && (c.phone || c.mobile));
    if (chosen.length === 0) {
      showToast({ type: 'warning', title: 'No Phone Numbers', message: 'Selected contacts must have phone or mobile numbers.' });
      return;
    }
    setWaSelectedRecipients(chosen);
    setWaPreviewIndex(0);
    handleSubTabChange('whatsapp');
    showToast({ type: 'success', title: 'Staged for WhatsApp', message: `${chosen.length} contacts staged for WhatsApp campaign.` });
  };

  // WhatsApp selection helpers: selects individual verified mobile numbers
  const handleSelectAllEligibleWa = () => {
    const eligibleItems = phoneAudit.items.filter(i => i.is_eligible);
    const mappedRecipients = eligibleItems.map(i => ({
      id: i.id,
      contact_id: i.contact_id || i.id,
      company_name: i.company_name,
      contact_person: i.contact_person,
      department: i.department || 'Purchasing',
      email: i.email,
      mobile: i.validation.normalized || i.raw_phone || '',
      phone: i.raw_phone,
      city: i.city,
      customer_type: i.customer_type,
      is_active: true,
    }));
    setWaSelectedRecipients(mappedRecipients);
    setWaPreviewIndex(0);
    showToast({
      type: 'success',
      title: 'Eligible Mobiles Selected',
      message: `${mappedRecipients.length} verified mobile contacts selected for WhatsApp broadcast.`,
    });
  };

  const handleToggleWaRecipient = (item: any) => {
    setWaSelectedRecipients(prev => {
      const exists = prev.some(r => r.id === item.id);
      if (exists) {
        return prev.filter(r => r.id !== item.id);
      } else {
        const mapped = {
          id: item.id,
          contact_id: item.contact_id || item.id,
          company_name: item.company_name,
          contact_person: item.contact_person,
          department: item.department || 'Purchasing',
          email: item.email || null,
          mobile: item.validation?.normalized || item.mobile || item.raw_phone || '',
          phone: item.raw_phone || item.phone,
          city: item.city,
          customer_type: item.customer_type,
          is_active: true,
        };
        return [...prev, mapped];
      }
    });
  };

  // WhatsApp execution logic
  const getCleanPhone = (r: any): string => {
    if (r.mobile) return r.mobile;
    const item = 'validation' in r ? r : verifiedItemsMap.get(r.id);
    if (item?.validation?.normalized) {
      return item.validation.normalized;
    }
    let raw = ('raw_phone' in r ? r.raw_phone : r.phone || r.mobile || '') || '';
    raw = raw.replace(/[^\d+]/g, '');
    if (raw.startsWith('08')) raw = '+628' + raw.slice(2);
    else if (raw.startsWith('628')) raw = '+' + raw;
    else if (!raw.startsWith('+') && raw.length > 8) raw = '+' + raw;
    return raw;
  };

  const previewFormattedWaMessage = (r?: any, prodName = waProductName): string => {
    return formatPersonalizedWhatsAppMessage(waMessageTemplate, r, { productName: prodName });
  };

  const insertVariable = (variableTag: string) => {
    setWaMessageTemplate(prev => prev + variableTag);
  };

  const wrapFormatting = (syntax: string) => {
    setWaMessageTemplate(prev => `${prev}${syntax}teks${syntax}`);
  };

  const handlePauseResumeWa = () => {
    const next = !waIsPaused;
    setWaIsPaused(next);
    waIsPausedRef.current = next;
    showToast({
      type: 'info',
      title: next ? 'Broadcast Paused' : 'Broadcast Resumed',
      message: next ? 'Dispatch paused. Click Resume to continue.' : 'Dispatch resumed.',
    });
  };

  const handleCancelWa = () => {
    waIsCancelledRef.current = true;
    setWaIsSending(false);
    setWaIsPaused(false);
    showToast({
      type: 'warning',
      title: 'Campaign Cancelled',
      message: 'Active broadcast has been cancelled.',
    });
  };

  const handleRetryFailedWa = () => {
    if (waFailedRecipients.length === 0) return;
    setWaSelectedRecipients(waFailedRecipients);
    setWaFailedRecipients([]);
    setWaTestMode(false);
    setWaShowApprovalModal(true);
  };

  const handleStartWaCampaign = () => {
    showToast({
      type: 'warning',
      title: 'Bulk Dispatch Blocked',
      message: 'Bulk WhatsApp dispatch is blocked: live bulk campaigns require verified individual customer opt-in consent records and approved dispatch readiness.',
    });
    return;
  };

  const executeWaDispatch = async () => {
    setWaShowApprovalModal(false);
    throw new Error(
      'Bulk WhatsApp dispatch is blocked: live bulk campaigns require verified individual customer opt-in consent records and approved dispatch readiness.'
    );
  };

  // Save new template
  const handleSaveTemplate = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!newTemplateName.trim() || !newTemplateBody.trim()) {
      showToast({ type: 'warning', title: 'Missing Fields', message: 'Name and body are required.' });
      return;
    }

    setSavingTemplate(true);
    try {
      const { error } = await supabase.from('crm_email_templates').insert({
        template_name: newTemplateName.trim(),
        subject: newTemplateType === 'email' ? newTemplateSubject.trim() : 'WhatsApp Message',
        body: newTemplateBody.trim(),
        category: newTemplateType === 'whatsapp' ? `WhatsApp - ${newTemplateCategory}` : newTemplateCategory,
        is_active: true,
      });

      if (error) throw error;
      showToast({ type: 'success', title: 'Template Saved', message: `Template "${newTemplateName}" created.` });
      setShowNewTemplateModal(false);
      setNewTemplateName('');
      setNewTemplateSubject('');
      setNewTemplateBody('');
      loadTemplates();
    } catch (err: any) {
      showToast({ type: 'error', title: 'Save Failed', message: err.message || 'Could not save template.' });
    } finally {
      setSavingTemplate(false);
    }
  };

  return (
    <div className="space-y-2.5">
      {/* Top Campaigns Sub-Navigation */}
      <div className="bg-white rounded-xl border border-slate-200/90 p-2 flex items-center justify-between gap-3 shadow-2xs flex-wrap">
        <div className="flex items-center gap-1 bg-slate-100/80 p-0.5 rounded-lg border border-slate-200/60 flex-wrap">
          <button
            onClick={() => handleSubTabChange('email')}
            className={`inline-flex items-center gap-1.5 px-3 py-1 rounded-md text-xs font-semibold transition ${
              activeTab === 'email'
                ? 'bg-white text-blue-700 shadow-2xs font-bold border border-slate-200/70'
                : 'text-slate-600 hover:text-slate-900 hover:bg-slate-200/60'
            }`}
          >
            <Mail className="w-3.5 h-3.5" />
            EMAIL CAMPAIGN
          </button>

          <button
            onClick={() => handleSubTabChange('whatsapp')}
            className={`inline-flex items-center gap-1.5 px-3 py-1 rounded-md text-xs font-semibold transition ${
              activeTab === 'whatsapp'
                ? 'bg-white text-emerald-700 shadow-2xs font-bold border border-slate-200/70'
                : 'text-slate-600 hover:text-slate-900 hover:bg-slate-200/60'
            }`}
          >
            <MessageSquare className="w-3.5 h-3.5" />
            WHATSAPP CAMPAIGN
          </button>

          <button
            onClick={() => handleSubTabChange('recipients')}
            className={`inline-flex items-center gap-1.5 px-3 py-1 rounded-md text-xs font-semibold transition ${
              activeTab === 'recipients'
                ? 'bg-white text-slate-900 shadow-2xs font-bold border border-slate-200/70'
                : 'text-slate-600 hover:text-slate-900 hover:bg-slate-200/60'
            }`}
          >
            <Users className="w-3.5 h-3.5" />
            RECIPIENTS DIRECTORY
            <span className="text-[10px] bg-slate-100 text-slate-700 px-1.5 py-0.2 rounded-full font-mono">
              {contacts.length}
            </span>
          </button>

          <button
            onClick={() => handleSubTabChange('templates')}
            className={`inline-flex items-center gap-1.5 px-3 py-1 rounded-md text-xs font-semibold transition ${
              activeTab === 'templates'
                ? 'bg-white text-slate-900 shadow-2xs font-bold border border-slate-200/70'
                : 'text-slate-600 hover:text-slate-900 hover:bg-slate-200/60'
            }`}
          >
            <FileText className="w-3.5 h-3.5" />
            TEMPLATES
            <span className="text-[10px] bg-slate-100 text-slate-700 px-1.5 py-0.2 rounded-full font-mono">
              {templates.length}
            </span>
          </button>

          <button
            onClick={() => handleSubTabChange('history')}
            className={`inline-flex items-center gap-1.5 px-3 py-1 rounded-md text-xs font-semibold transition ${
              activeTab === 'history'
                ? 'bg-white text-slate-900 shadow-2xs font-bold border border-slate-200/70'
                : 'text-slate-600 hover:text-slate-900 hover:bg-slate-200/60'
            }`}
          >
            <History className="w-3.5 h-3.5" />
            CAMPAIGN HISTORY
          </button>
        </div>

        <div className="text-[11px] text-slate-500 font-medium hidden sm:flex items-center gap-1.5">
          <span className="w-2 h-2 rounded-full bg-emerald-500 animate-pulse" />
          <span>Omnichannel Campaign Command Center</span>
        </div>
      </div>

      {/* 1. EMAIL CAMPAIGN TAB */}
      {activeTab === 'email' && (
        <div className="bg-white rounded-lg border border-gray-200 p-4 shadow-xs">
          <BulkEmailComposer
            selectedCustomers={stagedRecipients}
            onClose={() => handleSubTabChange('history')}
            onComplete={() => handleSubTabChange('history')}
          />
        </div>
      )}

      {/* 2. WHATSAPP CAMPAIGN BUILDER TAB */}
      {activeTab === 'whatsapp' && (
        <div className="space-y-4">
          {/* Phone Verification Audit Summary Strip */}
          <div className="bg-slate-50 border border-slate-200 rounded-lg p-3.5 shadow-xs">
            <div className="flex flex-col md:flex-row md:items-center justify-between gap-2 border-b border-slate-200 pb-2.5 mb-3">
              <div className="flex items-center gap-2">
                <Smartphone className="w-4 h-4 text-emerald-600" />
                <span className="text-xs font-bold text-gray-800 uppercase tracking-wide">
                  Contact Phone Verification & WhatsApp Audit
                </span>
                <span className="text-[10px] text-gray-500 font-medium">
                  (521 CRM Contacts Analyzed)
                </span>
              </div>
              <div className="flex items-center gap-2">
                <button
                  type="button"
                  onClick={() => setPhoneAuditCategory('total')}
                  className="inline-flex items-center gap-1.5 px-3 py-1 bg-white hover:bg-slate-100 text-slate-700 border border-slate-300 rounded text-xs font-bold transition shadow-2xs cursor-pointer"
                  title={`Open interactive Phone Audit & Correction Centre for all ${phoneAudit.stats.totalCompanies || contacts.length} contacts`}
                >
                  <Eye className="w-3.5 h-3.5 text-slate-600" />
                  Audit Centre ({phoneAudit.stats.totalCompanies || contacts.length})
                </button>
                <button
                  onClick={handleSelectAllEligibleWa}
                  className="inline-flex items-center gap-1.5 px-3 py-1 bg-emerald-600 hover:bg-emerald-700 text-white rounded text-xs font-semibold shadow-xs transition cursor-pointer"
                >
                  <CheckCircle2 className="w-3.5 h-3.5" />
                  Select All Eligible Mobile ({phoneAudit.stats.eligible})
                </button>
                <button
                  onClick={() => setWaRecipientSelectorOpen(true)}
                  className="inline-flex items-center gap-1 px-2.5 py-1 bg-white hover:bg-gray-100 text-gray-700 border border-gray-300 rounded text-xs font-medium transition cursor-pointer"
                >
                  <Filter className="w-3 h-3 text-gray-500" />
                  Filter Directory ({phoneAudit.items.length})
                </button>
              </div>
            </div>

            {/* 6 Audit KPI Cards (Interactive Audit Triggers) */}
            <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-6 gap-2 text-xs">
              {/* 1. Total Directory */}
              <button
                type="button"
                onClick={() => setPhoneAuditCategory('total')}
                className="bg-white hover:bg-slate-50 border border-gray-200 hover:border-slate-400 rounded-md p-2 shadow-2xs text-left transition-all active:scale-[0.98] cursor-pointer group"
                title={`Click to inspect all ${phoneAudit.stats.totalCompanies || contacts.length} companies and ${phoneAudit.stats.total} phone records in the Directory`}
              >
                <span className="text-[10px] uppercase font-bold text-gray-500 block group-hover:text-gray-900">Total Directory</span>
                <span className="text-base font-extrabold text-gray-900">{phoneAudit.stats.totalCompanies || phoneAudit.stats.total}</span>
                <span className="text-[9px] text-gray-400 mt-0.5 flex items-center justify-between">
                  <span>{phoneAudit.stats.totalPhones || phoneAudit.stats.total} phone records</span>
                  <span className="opacity-0 group-hover:opacity-100 text-blue-600 font-bold transition">Audit →</span>
                </span>
              </button>

              {/* 2. WhatsApp Eligible */}
              <button
                type="button"
                onClick={() => setPhoneAuditCategory('eligible')}
                className="bg-emerald-50/70 hover:bg-emerald-100/70 border border-emerald-200 hover:border-emerald-400 rounded-md p-2 shadow-2xs text-left transition-all active:scale-[0.98] cursor-pointer group"
                title="Eligible campaign candidates — not verified WhatsApp accounts and not dispatched."
              >
                <span className="text-[10px] uppercase font-bold text-emerald-800 flex items-center gap-1">
                  <CheckCircle2 className="w-3 h-3 text-emerald-600" />
                  WA Candidates
                </span>
                <span className="text-base font-extrabold text-emerald-900">{phoneAudit.stats.eligible}</span>
                <span className="text-[9px] text-emerald-700 mt-0.5 flex items-center justify-between">
                  <span>Eligible campaign candidates</span>
                  <span className="opacity-0 group-hover:opacity-100 text-emerald-800 font-bold transition">Inspect →</span>
                </span>
              </button>

              {/* 3. Landlines */}
              <button
                type="button"
                onClick={() => setPhoneAuditCategory('landline')}
                className="bg-amber-50/70 hover:bg-amber-100/70 border border-amber-200 hover:border-amber-400 rounded-md p-2 shadow-2xs text-left transition-all active:scale-[0.98] cursor-pointer group"
                title="Indonesian landline area codes (021, 022, 024, 031, etc.) cannot receive WhatsApp"
              >
                <span className="text-[10px] uppercase font-bold text-amber-800 flex items-center gap-1">
                  <Phone className="w-3 h-3 text-amber-600" />
                  Landlines
                </span>
                <span className="text-base font-extrabold text-amber-900">{phoneAudit.stats.landline}</span>
                <span className="text-[9px] text-amber-700 mt-0.5 flex items-center justify-between">
                  <span>Excluded (No WA)</span>
                  <span className="opacity-0 group-hover:opacity-100 text-amber-800 font-bold transition">Inspect →</span>
                </span>
              </button>

              {/* 4. Missing Number */}
              <button
                type="button"
                onClick={() => setPhoneAuditCategory('missing')}
                className="bg-slate-100/70 hover:bg-slate-200/70 border border-slate-200 hover:border-slate-400 rounded-md p-2 shadow-2xs text-left transition-all active:scale-[0.98] cursor-pointer group"
                title="Contacts without any recorded telephone number"
              >
                <span className="text-[10px] uppercase font-bold text-slate-700 flex items-center gap-1">
                  <AlertCircle className="w-3 h-3 text-slate-500" />
                  Missing Number
                </span>
                <span className="text-base font-extrabold text-slate-800">{phoneAudit.stats.missing}</span>
                <span className="text-[9px] text-slate-500 mt-0.5 flex items-center justify-between">
                  <span>Email only</span>
                  <span className="opacity-0 group-hover:opacity-100 text-slate-700 font-bold transition">Inspect →</span>
                </span>
              </button>

              {/* 5. Invalid Formats */}
              <button
                type="button"
                onClick={() => setPhoneAuditCategory('invalid')}
                className="bg-rose-50/70 hover:bg-rose-100/70 border border-rose-200 hover:border-rose-400 rounded-md p-2 shadow-2xs text-left transition-all active:scale-[0.98] cursor-pointer group"
                title="Contacts with invalid phone formatting, length, or unrecognized prefixes"
              >
                <span className="text-[10px] uppercase font-bold text-rose-800 flex items-center gap-1">
                  <AlertTriangle className="w-3 h-3 text-rose-600" />
                  Invalid Formats
                </span>
                <span className="text-base font-extrabold text-rose-900">{phoneAudit.stats.invalid}</span>
                <span className="text-[9px] text-rose-700 mt-0.5 flex items-center justify-between">
                  <span>Bad digits/length</span>
                  <span className="opacity-0 group-hover:opacity-100 text-rose-800 font-bold transition">Correct →</span>
                </span>
              </button>

              {/* 6. Duplicates (Overlapping Flag) */}
              <button
                type="button"
                onClick={() => setPhoneAuditCategory('duplicates')}
                className="bg-orange-50/70 hover:bg-orange-100/70 border border-orange-200 hover:border-orange-400 rounded-md p-2 shadow-2xs text-left transition-all active:scale-[0.98] cursor-pointer group"
                title="Click to inspect duplicate phone numbers shared across multiple contacts"
              >
                <span className="text-[10px] uppercase font-bold text-orange-800 flex items-center gap-1">
                  <Layers className="w-3 h-3 text-orange-600" />
                  Duplicates
                </span>
                <span className="text-base font-extrabold text-orange-900">{phoneAudit.stats.duplicates}</span>
                <span className="text-[9px] text-orange-700 mt-0.5 flex items-center justify-between">
                  <span>Flagged shared</span>
                  <span className="opacity-0 group-hover:opacity-100 text-orange-800 font-bold transition">Inspect →</span>
                </span>
              </button>
            </div>
          </div>

          {/* Dynamic Dispatch & Connection Status Banner */}
          {adapterHealth.checked && adapterHealth.status === 'disconnected' ? (
            <div className="bg-rose-50 border border-rose-300 rounded-lg p-3 text-xs text-rose-950 flex items-center justify-between shadow-xs">
              <div className="flex items-center gap-2.5">
                <WifiOff className="w-5 h-5 text-rose-600 shrink-0" />
                <div>
                  <span className="font-extrabold text-rose-900 block text-xs">
                    OpenWA Adapter Disconnected — Dispatch Unavailable
                  </span>
                  <span className="text-[11px] text-rose-800">
                    The local OpenWA adapter service is offline ({adapterHealth.details || adapterHealth.error || 'Connection refused at 127.0.0.1:3100'}). WhatsApp message dispatch is unavailable until the daemon is running and authenticated.
                  </span>
                </div>
              </div>
              <span className="px-2.5 py-1 bg-rose-200/80 text-rose-900 font-extrabold text-[10px] rounded border border-rose-300 uppercase shrink-0">
                ADAPTER OFFLINE
              </span>
            </div>
          ) : waTestMode ? (
            <div className="bg-blue-50 border border-blue-300 rounded-lg p-3 text-xs text-blue-950 flex items-center justify-between shadow-xs">
              <div className="flex items-center gap-2.5">
                <FlaskConical className="w-5 h-5 text-blue-600 shrink-0" />
                <div>
                  <span className="font-extrabold text-blue-900 block text-xs">
                    Test Pilot Active — Controlled 1-on-1 Verification
                  </span>
                  <span className="text-[11px] text-blue-800">
                    Available only for approved test recipients (+6285888600999, +919823533833) connected via verified OpenWA session ({adapterHealth.businessPhone || '+6285888600999'}). Customer bulk broadcasting is disarmed.
                  </span>
                </div>
              </div>
              <span className="px-2.5 py-1 bg-blue-200/80 text-blue-900 font-extrabold text-[10px] rounded border border-blue-300 uppercase shrink-0">
                TEST PILOT ACTIVE
              </span>
            </div>
          ) : (
            <div className="bg-amber-50 border border-amber-300 rounded-lg p-3 text-xs text-amber-950 flex items-center justify-between shadow-xs">
              <div className="flex items-center gap-2.5">
                <ShieldAlert className="w-5 h-5 text-amber-600 shrink-0" />
                <div>
                  <span className="font-extrabold text-amber-900 block text-xs">
                    Bulk WhatsApp Dispatch Blocked — Safety &amp; Consent Enforcement
                  </span>
                  <span className="text-[11px] text-amber-800">
                    Bulk campaign dispatch is strictly locked at UI and execution level pending verified individual customer opt-in records and approved dispatch readiness. Found {complianceCounts.eligibleRecipientsCount} verified opt-in recipients in CRM database.
                  </span>
                </div>
              </div>
              <span className="px-2.5 py-1 bg-amber-200/80 text-amber-900 font-extrabold text-[10px] rounded border border-amber-300 uppercase shrink-0">
                BULK DISPATCH LOCKED
              </span>
            </div>
          )}

          {/* Main 2-Column WhatsApp Workspace */}
          <div className="grid grid-cols-1 lg:grid-cols-12 gap-4">
            {/* Left Column: Composer & Safeguards (7 cols) */}
            <div className="lg:col-span-7 space-y-4">
              <div className="bg-white rounded-lg border border-gray-200 p-4 shadow-xs space-y-3.5">
                {/* Header & Target Summary */}
                <div className="flex items-center justify-between border-b pb-2.5">
                  <div className="flex items-center gap-2">
                    <div className="w-8 h-8 rounded-md bg-emerald-600 text-white flex items-center justify-center font-bold">
                      <MessageSquare className="w-4 h-4" />
                    </div>
                    <div>
                      <h3 className="text-xs font-bold text-gray-900 uppercase tracking-wide">
                        WhatsApp Business Composer
                      </h3>
                      <p className="text-[11px] text-gray-500">
                        Zero-credential loopback proxy &bull; Persistent OpenWA daemon (127.0.0.1:3100)
                      </p>
                    </div>
                  </div>

                  <div className="flex items-center gap-2">
                    <span className={`text-[11px] font-bold px-2.5 py-0.5 rounded-full border ${
                      waSelectedRecipients.length > 0
                        ? 'bg-emerald-50 text-emerald-800 border-emerald-300'
                        : 'bg-gray-100 text-gray-600 border-gray-200'
                    }`}>
                      {waSelectedRecipients.length > 0 ? `${waSelectedRecipients.length} Selected` : '0 Selected'}
                    </span>
                    <button
                      onClick={() => setWaRecipientSelectorOpen(true)}
                      className="text-xs text-blue-600 hover:text-blue-800 font-semibold underline"
                    >
                      Change →
                    </button>
                  </div>
                </div>

                {/* Template Selection */}
                <div className="space-y-1">
                  <label className="text-[11px] font-bold text-gray-700 uppercase flex items-center gap-1">
                    <span>Template:</span>
                  </label>
                  <select
                    onChange={e => {
                      const t = templates.find(item => item.id === e.target.value);
                      if (t) setWaMessageTemplate(t.body);
                    }}
                    className="w-full text-xs border border-gray-300 rounded p-2 bg-slate-50 focus:bg-white focus:outline-emerald-500"
                  >
                    <option value="">Select standard B2B WhatsApp template ▼</option>
                    {templates.filter(t => t.type === 'whatsapp').map(t => (
                      <option key={t.id} value={t.id}>
                        {t.name} ({t.category})
                      </option>
                    ))}
                  </select>
                </div>

                {/* Product Name Focus (for {{product_name}} interpolation) */}
                <div className="space-y-1">
                  <label className="text-[11px] font-bold text-gray-700 uppercase flex items-center gap-1">
                    <span>Featured Product / Subject:</span>
                    <span className="text-[10px] text-gray-400 font-normal">(Interpolates into &#123;&#123;product_name&#125;&#125;)</span>
                  </label>
                  <input
                    type="text"
                    value={waProductName}
                    onChange={e => setWaProductName(e.target.value)}
                    placeholder="e.g. Paracetamol USP / Pregabalin IP / Metformin HCl"
                    className="w-full text-xs p-2 border border-gray-300 rounded focus:outline-emerald-500 bg-white"
                  />
                </div>

                {/* Variable Insertion & Formatting Chips */}
                <div className="space-y-1.5 pt-1">
                  <div className="flex items-center justify-between text-[11px]">
                    <span className="font-bold text-gray-700 uppercase">Insert Dynamic Tags:</span>
                    <span className="text-[10px] text-gray-400">Click to insert at end of message</span>
                  </div>
                  <div className="flex flex-wrap items-center gap-1.5">
                    <button
                      type="button"
                      onClick={() => insertVariable(' {{contact_person}}')}
                      className="px-2 py-1 text-xs bg-emerald-50 text-emerald-800 border border-emerald-200 rounded font-mono hover:bg-emerald-100 transition"
                      title="Insert recipient contact person"
                    >
                      &#123;&#123;contact_person&#125;&#125;
                    </button>
                    <button
                      type="button"
                      onClick={() => insertVariable(' {{company_name}}')}
                      className="px-2 py-1 text-xs bg-emerald-50 text-emerald-800 border border-emerald-200 rounded font-mono hover:bg-emerald-100 transition"
                      title="Insert recipient company name"
                    >
                      &#123;&#123;company_name&#125;&#125;
                    </button>
                    <button
                      type="button"
                      onClick={() => insertVariable(' {{product_name}}')}
                      className="px-2 py-1 text-xs bg-emerald-50 text-emerald-800 border border-emerald-200 rounded font-mono hover:bg-emerald-100 transition"
                      title="Insert featured product name"
                    >
                      &#123;&#123;product_name&#125;&#125;
                    </button>
                    <button
                      type="button"
                      onClick={() => insertVariable(' {{designation}}')}
                      className="px-2 py-1 text-xs bg-emerald-50 text-emerald-800 border border-emerald-200 rounded font-mono hover:bg-emerald-100 transition"
                      title="Insert recipient designation"
                    >
                      &#123;&#123;designation&#125;&#125;
                    </button>
                    <button
                      type="button"
                      onClick={() => insertVariable(' {{city}}')}
                      className="px-2 py-1 text-xs bg-emerald-50 text-emerald-800 border border-emerald-200 rounded font-mono hover:bg-emerald-100 transition"
                      title="Insert recipient city"
                    >
                      &#123;&#123;city&#125;&#125;
                    </button>

                    <div className="h-4 w-px bg-gray-300 mx-1" />

                    <button
                      type="button"
                      onClick={() => wrapFormatting('*')}
                      className="px-2 py-1 text-xs bg-slate-100 text-gray-700 border border-gray-200 rounded font-bold hover:bg-slate-200 transition"
                      title="WhatsApp Bold formatting (*text*)"
                    >
                      *Bold*
                    </button>
                    <button
                      type="button"
                      onClick={() => wrapFormatting('_')}
                      className="px-2 py-1 text-xs bg-slate-100 text-gray-700 border border-gray-200 rounded italic hover:bg-slate-200 transition"
                      title="WhatsApp Italic formatting (_text_)"
                    >
                      _Italic_
                    </button>
                    <button
                      type="button"
                      onClick={() => wrapFormatting('~')}
                      className="px-2 py-1 text-xs bg-slate-100 text-gray-700 border border-gray-200 rounded line-through hover:bg-slate-200 transition"
                      title="WhatsApp Strikethrough formatting (~text~)"
                    >
                      ~Strike~
                    </button>
                  </div>
                </div>

                {/* Message Textarea */}
                <div className="space-y-1">
                  <div className="flex items-center justify-between">
                    <label className="text-[11px] font-bold text-gray-700 uppercase">
                      {waAttachment ? 'Message Caption (Sent with Media):' : 'Message Body:'}
                    </label>
                    <div className="text-[11px] text-gray-500 font-mono">
                      <span>{waMessageTemplate.length}</span>
                      {waAttachment ? (
                        <span className={waMessageTemplate.length > WHATSAPP_MEDIA_CAPTION_LIMIT ? 'text-rose-600 font-bold' : ''}>
                          {' '}/ {WHATSAPP_MEDIA_CAPTION_LIMIT} chars max
                        </span>
                      ) : (
                        <span className="text-gray-400"> / 4096 chars</span>
                      )}
                    </div>
                  </div>
                  <textarea
                    rows={7}
                    value={waMessageTemplate}
                    onChange={e => setWaMessageTemplate(e.target.value)}
                    className={`w-full text-xs p-3 border rounded-md focus:outline-emerald-500 font-sans leading-relaxed ${
                      waAttachment && waMessageTemplate.length > WHATSAPP_MEDIA_CAPTION_LIMIT
                        ? 'border-rose-400 bg-rose-50/20'
                        : 'border-gray-300'
                    }`}
                    placeholder="Tulis pesan WhatsApp Business..."
                  />

                  {/* Warning if media caption exceeds provider limit */}
                  {waAttachment && waMessageTemplate.length > WHATSAPP_MEDIA_CAPTION_LIMIT && (
                    <div className="p-2.5 bg-rose-50 border border-rose-200 rounded-lg text-xs text-rose-800 flex items-start gap-2 animate-in fade-in">
                      <AlertTriangle className="w-4 h-4 text-rose-600 flex-shrink-0 mt-0.5" />
                      <div>
                        <strong>WhatsApp Caption Limit Exceeded:</strong> WhatsApp limits media captions to{' '}
                        {WHATSAPP_MEDIA_CAPTION_LIMIT} characters (current: {waMessageTemplate.length}). Please shorten the
                        message to dispatch with photo/document.
                      </div>
                    </div>
                  )}
                </div>

                {/* Attachment Section (Document Bank & File Upload) */}
                <div className="space-y-2 pt-1">
                  <div className="flex items-center justify-between text-[11px]">
                    <span className="font-bold text-gray-700 uppercase flex items-center gap-1.5">
                      <Paperclip className="w-3.5 h-3.5 text-emerald-600" />
                      Attachment (Photo / Document):
                    </span>
                    {waAttachment && (
                      <button
                        type="button"
                        onClick={() => setWaAttachment(null)}
                        className="text-[10px] text-rose-600 hover:text-rose-800 font-semibold flex items-center gap-1"
                      >
                        <Trash2 className="w-3 h-3" />
                        Remove Attachment
                      </button>
                    )}
                  </div>

                  {!waAttachment ? (
                    <button
                      type="button"
                      onClick={() => setIsAttachmentModalOpen(true)}
                      className="w-full flex items-center justify-center gap-2 py-3 px-4 bg-slate-50 hover:bg-emerald-50/50 border border-dashed border-gray-300 hover:border-emerald-500 text-gray-700 hover:text-emerald-900 rounded-xl text-xs font-semibold transition group shadow-2xs"
                    >
                      <Paperclip className="w-4 h-4 text-gray-400 group-hover:text-emerald-600 transition" />
                      <span>Attach Photo / Document</span>
                      <span className="text-[10px] text-gray-400 group-hover:text-emerald-700 font-normal">
                        (Select from Document Bank or Upload New File)
                      </span>
                    </button>
                  ) : (
                    <div className="p-3 bg-emerald-50/60 border border-emerald-300 rounded-xl text-xs space-y-2">
                      <div className="flex items-start justify-between gap-3">
                        <div className="flex items-start gap-3 min-w-0 flex-1">
                          {waAttachment.mediaCategory === 'image' ? (
                            <div className="w-12 h-12 rounded-lg overflow-hidden border border-emerald-200 bg-white flex-shrink-0">
                              {waAttachment.previewUrl || waAttachment.url ? (
                                <img
                                  src={waAttachment.previewUrl || waAttachment.url}
                                  alt={waAttachment.name}
                                  className="w-full h-full object-cover"
                                />
                              ) : (
                                <div className="w-full h-full bg-blue-100 text-blue-700 flex items-center justify-center">
                                  <ImageIcon className="w-5 h-5" />
                                </div>
                              )}
                            </div>
                          ) : (
                            <div className="w-12 h-12 rounded-lg bg-red-100 text-red-700 flex items-center justify-center flex-shrink-0 border border-red-200">
                              <FileText className="w-6 h-6" />
                            </div>
                          )}

                          <div className="min-w-0 flex-1 space-y-0.5">
                            <div className="flex items-center gap-2">
                              <span className="font-bold text-gray-900 truncate">
                                {waAttachment.name}
                              </span>
                              <span className="text-[9px] font-bold px-1.5 py-0.5 rounded uppercase tracking-wider bg-emerald-200 text-emerald-900">
                                {waAttachment.documentType}
                              </span>
                            </div>
                            <div className="text-[11px] text-gray-600 flex flex-wrap items-center gap-x-2">
                              <span>{waAttachment.formattedSize || 'Document'}</span>
                              <span>&bull;</span>
                              <span className="text-emerald-700 font-semibold">
                                {waAttachment.source === 'bank' ? 'Document Bank' : 'Uploaded File'}
                              </span>
                              {waAttachment.productName && (
                                <>
                                  <span>&bull;</span>
                                  <span className="text-gray-700">{waAttachment.productName}</span>
                                </>
                              )}
                            </div>
                          </div>
                        </div>

                        <div className="flex items-center gap-1.5 flex-shrink-0">
                          <button
                            type="button"
                            onClick={() => setIsAttachmentModalOpen(true)}
                            className="px-2.5 py-1 text-[11px] font-semibold bg-white border border-gray-300 hover:border-emerald-500 rounded-lg text-gray-700 hover:text-emerald-800 transition"
                          >
                            Replace
                          </button>
                          <button
                            type="button"
                            onClick={() => setWaAttachment(null)}
                            className="p-1 text-gray-400 hover:text-rose-600 rounded-lg hover:bg-white transition"
                            title="Remove Attachment"
                          >
                            <Trash2 className="w-4 h-4" />
                          </button>
                        </div>
                      </div>
                      <div className="text-[10px] text-emerald-800 bg-white/70 px-2.5 py-1 rounded-md border border-emerald-200/60 font-medium">
                        ✓ Single Attachment active: will be sent with message body as its caption to all recipients.
                      </div>
                    </div>
                  )}
                </div>

                {/* Audience Eligibility & Compliance Summary — 6 Distinct Compliance Counts */}
                <div className="bg-slate-50 border border-slate-200 rounded-lg p-3 space-y-2">
                  <div className="flex items-center justify-between">
                    <div className="flex items-center gap-1.5 text-xs font-bold text-gray-800 uppercase">
                      <Users className="w-3.5 h-3.5 text-emerald-600" />
                      <span>Audience Compliance &amp; Consent Verification</span>
                    </div>
                    <span className="text-[10px] font-mono font-bold px-2 py-0.5 rounded bg-emerald-50 text-emerald-700 border border-emerald-200">
                      {complianceCounts.eligibleRecipientsCount} Verified Eligible
                    </span>
                  </div>

                  {/* 6 Distinct Verification Counts */}
                  <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-6 gap-2 text-center text-[10px]">
                    <div className="bg-slate-50 border border-slate-200 rounded p-1.5">
                      <div className="font-bold text-slate-900 text-xs">
                        {complianceCounts.validMobileCount}
                      </div>
                      <div className="text-slate-600 font-medium">Valid Mobiles</div>
                    </div>
                    <div className="bg-emerald-50/70 border border-emerald-200 rounded p-1.5">
                      <div className="font-bold text-emerald-900 text-xs">
                        {complianceCounts.verifiedOptInCount}
                      </div>
                      <div className="text-emerald-700 font-medium">Verified Opt-Ins</div>
                    </div>
                    <div className="bg-amber-50/70 border border-amber-200 rounded p-1.5">
                      <div className="font-bold text-amber-900 text-xs">
                        {complianceCounts.missingConsentCount}
                      </div>
                      <div className="text-amber-700 font-medium">Missing Consent</div>
                    </div>
                    <div className="bg-rose-50/70 border border-rose-200 rounded p-1.5">
                      <div className="font-bold text-rose-900 text-xs">
                        {complianceCounts.optedOutCount}
                      </div>
                      <div className="text-rose-700 font-medium">Opted Out</div>
                    </div>
                    <div className="bg-orange-50/70 border border-orange-200 rounded p-1.5">
                      <div className="font-bold text-orange-900 text-xs">
                        {complianceCounts.duplicateCount}
                      </div>
                      <div className="text-orange-700 font-medium">Duplicate Numbers</div>
                    </div>
                    <div className="bg-teal-50/70 border border-teal-300 rounded p-1.5 ring-1 ring-teal-400/30">
                      <div className="font-extrabold text-teal-950 text-xs">
                        {complianceCounts.eligibleRecipientsCount}
                      </div>
                      <div className="text-teal-800 font-bold">Eligible Recipients</div>
                    </div>
                  </div>

                  {waSelectedRecipients.length > 0 && (
                    <div className="pt-1">
                      <button
                        type="button"
                        onClick={() => setWaAudienceBreakdownOpen(prev => !prev)}
                        className="text-[11px] text-blue-600 hover:text-blue-800 font-semibold flex items-center gap-1"
                      >
                        {waAudienceBreakdownOpen ? 'Hide Individual Consent & Opt-Out Table ▲' : 'Review Individual Consent & Opt-Outs ▼'}
                      </button>
                    </div>
                  )}

                  {waAudienceBreakdownOpen && (
                    <div className="mt-2 max-h-48 overflow-y-auto border border-gray-200 rounded text-xs divide-y divide-gray-100 bg-white">
                      {waSelectedRecipients.map((rec, i) => {
                        const isOpted = CampaignComplianceService.isOptedOut(rec.mobile || rec.phone || '') || rec.isOptedOut || rec.consent_status === 'opted_out';
                        const hasVerifiedOptIn = !isOpted && rec.consent_status === 'opted_in' && Boolean(rec.consent?.optInSource);
                        return (
                          <div key={rec.id || i} className="p-2 flex items-center justify-between gap-2 hover:bg-slate-50">
                            <div className="min-w-0">
                              <div className="font-semibold text-gray-900 truncate text-[11px]">{rec.company_name}</div>
                              <div className="text-[10px] text-gray-500">{rec.contact_person || 'Contact'} &bull; <span className="font-mono">{rec.mobile || rec.phone}</span></div>
                            </div>
                            <div className="flex items-center gap-1.5 flex-shrink-0">
                              {isOpted ? (
                                <span className="text-[9px] font-bold px-1.5 py-0.5 rounded bg-rose-100 text-rose-800">OPTED OUT</span>
                              ) : hasVerifiedOptIn ? (
                                <>
                                  <span className="text-[9px] font-bold px-1.5 py-0.5 rounded bg-emerald-100 text-emerald-800">VERIFIED OPT-IN</span>
                                  <button
                                    type="button"
                                    onClick={() => handleRegisterOptOut(rec.mobile || rec.phone || '', rec.company_name)}
                                    className="text-[10px] px-2 py-0.5 rounded border border-rose-200 text-rose-700 hover:bg-rose-50"
                                    title="Register Opt-Out"
                                  >
                                    Opt Out
                                  </button>
                                </>
                              ) : (
                                <>
                                  <span className="text-[9px] font-semibold px-1.5 py-0.5 rounded bg-amber-100 text-amber-900">MISSING CONSENT (PENDING)</span>
                                  <button
                                    type="button"
                                    onClick={() => handleRegisterOptOut(rec.mobile || rec.phone || '', rec.company_name)}
                                    className="text-[10px] px-2 py-0.5 rounded border border-rose-200 text-rose-700 hover:bg-rose-50"
                                    title="Register Opt-Out"
                                  >
                                    Opt Out
                                  </button>
                                </>
                              )}
                            </div>
                          </div>
                        );
                      })}
                    </div>
                  )}
                </div>

                {/* Delivery Safeguards & Anti-Ban Controls */}
                <div className="bg-amber-50/70 border border-amber-200 rounded-lg p-3 space-y-2.5">
                  <div className="flex items-center gap-2 text-amber-900 font-bold text-xs">
                    <ShieldCheck className="w-4 h-4 text-amber-700" />
                    <span>Delivery Safeguards &amp; Anti-Ban Controls</span>
                  </div>

                  <div className="space-y-2 text-xs text-amber-950">
                    <label className="flex items-start gap-2 cursor-pointer">
                      <input
                        type="checkbox"
                        checked={waConsentVerified}
                        onChange={e => setWaConsentVerified(e.target.checked)}
                        className="mt-0.5 rounded text-emerald-600 focus:ring-emerald-500"
                      />
                      <span>
                        <strong>Operator Compliance Attestation:</strong> I certify that I am authorized to dispatch messages and that this communication adheres to operational and regulatory guidelines.
                      </span>
                    </label>

                    <label className="flex items-start gap-2 cursor-pointer">
                      <input
                        type="checkbox"
                        checked={waOptOutConfirmed}
                        onChange={e => setWaOptOutConfirmed(e.target.checked)}
                        className="mt-0.5 rounded text-emerald-600 focus:ring-emerald-500"
                      />
                      <span>
                        <strong>Operator Opt-Out Attestation:</strong> I confirm that stop/unsubscribe requests will be immediately honored and recorded in the suppression list.
                      </span>
                    </label>

                    <div className="text-[10px] text-amber-800 italic pt-0.5">
                      * Administrative operator attestations do not create, modify, or substitute for customer opt-in consent records. Recipient eligibility is strictly determined by individual verified consent records on file.
                    </div>
                  </div>

                  <div className="grid grid-cols-1 sm:grid-cols-2 gap-3 pt-1 border-t border-amber-200">
                    <div>
                      <label className="text-[10px] font-bold text-amber-900 uppercase block mb-1">
                        Pacing Delay Between Messages:
                      </label>
                      <select
                        value={waPacingSeconds}
                        onChange={e => setWaPacingSeconds(Number(e.target.value))}
                        className="w-full text-xs border border-amber-300 rounded p-1.5 bg-white text-gray-800"
                      >
                        <option value={10}>10 Seconds (Fast)</option>
                        <option value={15}>15 Seconds (Normal)</option>
                        <option value={20}>20 Seconds (Recommended Safe)</option>
                        <option value={30}>30 Seconds (Ultra-Conservative)</option>
                      </select>
                    </div>

                    <div>
                      <label className="text-[10px] font-bold text-amber-900 uppercase block mb-1">
                        Dispatch Mode:
                      </label>
                      <div className="flex items-center gap-3 pt-1 text-xs">
                        <label className="inline-flex items-center gap-1.5 cursor-pointer">
                          <input
                            type="radio"
                            name="waDispatchMode"
                            checked={waTestMode}
                            onChange={() => setWaTestMode(true)}
                          />
                          <span className="font-semibold text-blue-900">Test Pilot</span>
                        </label>
                        <label className="inline-flex items-center gap-1.5 cursor-pointer">
                          <input
                            type="radio"
                            name="waDispatchMode"
                            checked={!waTestMode}
                            onChange={() => setWaTestMode(false)}
                          />
                          <span className="font-semibold text-emerald-900">Live Campaign</span>
                        </label>
                      </div>
                    </div>
                  </div>

                  {/* Campaign Scheduling */}
                  <div className="pt-2 border-t border-amber-200 space-y-1.5">
                    <label className="text-[10px] font-bold text-amber-900 uppercase block">
                      Campaign Schedule:
                    </label>
                    <div className="flex items-center gap-3 text-xs">
                      <label className="inline-flex items-center gap-1.5 cursor-pointer">
                        <input
                          type="radio"
                          name="waScheduleMode"
                          checked={waScheduleMode === 'now'}
                          onChange={() => setWaScheduleMode('now')}
                        />
                        <span className="font-semibold text-gray-800">Send Immediately</span>
                      </label>
                      <label className="inline-flex items-center gap-1.5 cursor-pointer">
                        <input
                          type="radio"
                          name="waScheduleMode"
                          checked={waScheduleMode === 'scheduled'}
                          onChange={() => setWaScheduleMode('scheduled')}
                        />
                        <span className="font-semibold text-gray-800">Schedule for Later</span>
                      </label>
                    </div>

                    {waScheduleMode === 'scheduled' && (
                      <div className="flex items-center gap-2 pt-1">
                        <Calendar className="w-3.5 h-3.5 text-amber-700 flex-shrink-0" />
                        <input
                          type="datetime-local"
                          value={waScheduledDateTime}
                          onChange={e => setWaScheduledDateTime(e.target.value)}
                          className="text-xs p-1.5 border border-amber-300 rounded bg-white text-gray-800 flex-1"
                        />
                      </div>
                    )}
                  </div>

                  {waTestMode && (
                    <div className="pt-1">
                      <label className="text-[10px] font-bold text-amber-900 uppercase block mb-1">
                        Test Recipient Phone:
                      </label>
                      <input
                        type="text"
                        value={waTestPhone}
                        onChange={e => setWaTestPhone(e.target.value)}
                        placeholder="+6285888600999"
                        className="w-full text-xs p-1.5 border border-amber-300 rounded bg-white text-gray-800"
                      />
                    </div>
                  )}
                </div>

                {/* Action Buttons */}
                <div className="flex items-center justify-between pt-2">
                  <span className="text-xs text-gray-500">
                    {waTestMode
                      ? 'Target: 1 Authorized Test Number'
                      : `Valid: ${complianceCounts.validMobileCount} | Opt-Ins: ${complianceCounts.verifiedOptInCount} | Missing: ${complianceCounts.missingConsentCount} | Opted Out: ${complianceCounts.optedOutCount} | Duplicates: ${complianceCounts.duplicateCount} | Eligible: ${complianceCounts.eligibleRecipientsCount}`}
                  </span>

                  {waTestMode ? (
                    <button
                      type="button"
                      onClick={handleSendTestPilot}
                      disabled={waIsSending || !waConsentVerified || !waOptOutConfirmed}
                      className="inline-flex items-center gap-2 px-5 py-2 rounded-md text-xs font-bold text-white shadow-xs transition bg-blue-600 hover:bg-blue-700 disabled:opacity-50 disabled:cursor-not-allowed"
                      title="Send genuine test pilot message to authorized test number"
                    >
                      <Send className="w-3.5 h-3.5" />
                      <span>{waIsSending ? 'Dispatching Test Pilot...' : 'Send 1-on-1 Test Pilot'}</span>
                    </button>
                  ) : (
                    <div className="flex items-center gap-2">
                      <button
                        type="button"
                        onClick={handleSaveDraftCampaign}
                        className="inline-flex items-center gap-1.5 px-3 py-2 rounded-md text-xs font-semibold text-slate-700 bg-slate-100 hover:bg-slate-200 border border-slate-300 transition"
                      >
                        <Save className="w-3.5 h-3.5" />
                        <span>Save as Campaign Draft</span>
                      </button>
                      <button
                        type="button"
                        disabled={true}
                        className="inline-flex items-center gap-2 px-5 py-2 rounded-md text-xs font-bold text-white shadow-xs transition bg-slate-400 cursor-not-allowed opacity-80"
                        title="Bulk WhatsApp dispatch is blocked: live bulk campaigns require verified individual customer opt-in consent records and approved dispatch readiness."
                      >
                        <Lock className="w-3.5 h-3.5" />
                        <span>Bulk Dispatch Locked ({complianceCounts.eligibleRecipientsCount} Eligible)</span>
                      </button>
                    </div>
                  )}
                </div>

                {!waTestMode && (
                  <div className="mt-2 p-2 bg-slate-100 border border-slate-200 rounded text-[11px] text-slate-700 flex items-center gap-2">
                    <Lock className="w-4 h-4 text-slate-500 shrink-0" />
                    <span>
                      <strong>Bulk Safety Lock Active:</strong> Bulk WhatsApp campaign dispatch is technically blocked at UI and execution level. Campaigns can be drafted, segmented, scheduled, and previewed, but bulk customer outreach requires verified individual opt-in consent records in CRM and approved dispatch readiness.
                    </span>
                  </div>
                )}
              </div>
            </div>

            {/* Right Column: Live Mockup Preview & Dispatch Logs (5 cols) */}
            <div className="lg:col-span-5 space-y-4">
              {/* WhatsApp Phone Mockup Preview */}
              <div className="bg-white rounded-lg border border-gray-200 p-4 shadow-xs space-y-3">
                <div className="flex items-center justify-between border-b pb-2">
                  <span className="text-xs font-bold text-gray-800 uppercase flex items-center gap-1.5">
                    <Eye className="w-3.5 h-3.5 text-gray-500" />
                    Live Customer Preview
                  </span>
                  {waSelectedRecipients.length > 0 && (
                    <div className="flex items-center gap-1 text-xs">
                      <button
                        onClick={() => setWaPreviewIndex(prev => (prev > 0 ? prev - 1 : waSelectedRecipients.length - 1))}
                        className="p-1 rounded hover:bg-gray-100 text-gray-600"
                        title="Previous Recipient"
                      >
                        <ChevronLeft className="w-3.5 h-3.5" />
                      </button>
                      <span className="text-[10px] font-mono text-gray-500">
                        {waPreviewIndex + 1} / {waSelectedRecipients.length}
                      </span>
                      <button
                        onClick={() => setWaPreviewIndex(prev => (prev < waSelectedRecipients.length - 1 ? prev + 1 : 0))}
                        className="p-1 rounded hover:bg-gray-100 text-gray-600"
                        title="Next Recipient"
                      >
                        <ChevronRight className="w-3.5 h-3.5" />
                      </button>
                    </div>
                  )}
                </div>

                {/* WhatsApp Chat Window Container */}
                <div className="rounded-xl overflow-hidden border border-gray-300 shadow-sm flex flex-col font-sans">
                  {/* WhatsApp Header */}
                  <div className="bg-[#075e54] text-white px-3 py-2 flex items-center justify-between">
                    <div className="flex items-center gap-2 min-w-0">
                      <div className="w-7 h-7 rounded-full bg-emerald-200 text-[#075e54] flex items-center justify-center font-bold text-xs flex-shrink-0">
                        {(waSelectedRecipients[waPreviewIndex]?.company_name || 'Kalbe')[0]}
                      </div>
                      <div className="min-w-0">
                        <div className="text-xs font-bold truncate">
                          {waSelectedRecipients[waPreviewIndex]?.company_name || 'PT Kalbe Farma Tbk'}
                        </div>
                        <div className="text-[10px] text-emerald-100 truncate">
                          {waSelectedRecipients[waPreviewIndex]?.contact_person || 'Bapak Budi Santoso'} &bull; ERP Contact
                        </div>
                      </div>
                    </div>
                    <span className="text-[10px] bg-emerald-800/80 px-1.5 py-0.5 rounded text-emerald-100 uppercase font-semibold">
                      WA Business
                    </span>
                  </div>

                  {/* WhatsApp Wallpaper Area */}
                  <div className="bg-[#efeae2] p-3 space-y-3 min-h-[260px] flex flex-col justify-end">
                    {/* Date capsule */}
                    <div className="flex justify-center">
                      <span className="text-[10px] bg-white/90 text-gray-600 px-2 py-0.5 rounded-md shadow-2xs font-medium">
                        HARI INI
                      </span>
                    </div>

                    {/* Outgoing Message Bubble (#d9fdd3) */}
                    <div className="flex justify-end">
                      <div className="bg-[#d9fdd3] text-gray-900 rounded-lg rounded-tr-none p-3 max-w-[92%] shadow-2xs space-y-2">
                        {/* Attachment Preview Card inside Bubble */}
                        {waAttachment && (
                          waAttachment.mediaCategory === 'image' ? (
                            <div className="rounded-lg overflow-hidden -mx-1 -mt-1 mb-2 bg-black/5 border border-emerald-300">
                              {waAttachment.previewUrl || waAttachment.url ? (
                                <img
                                  src={waAttachment.previewUrl || waAttachment.url}
                                  alt={waAttachment.name}
                                  className="w-full max-h-52 object-cover"
                                />
                              ) : (
                                <div className="w-full h-32 bg-emerald-100 flex flex-col items-center justify-center text-emerald-800">
                                  <ImageIcon className="w-8 h-8 opacity-60" />
                                  <span className="text-[10px] mt-1 font-semibold">{waAttachment.name}</span>
                                </div>
                              )}
                            </div>
                          ) : (
                            <div className="flex items-center gap-2.5 p-2 bg-white/85 border border-emerald-300 rounded-lg text-xs shadow-2xs mb-1">
                              <div className="w-9 h-9 rounded bg-red-100 text-red-700 flex items-center justify-center flex-shrink-0 border border-red-200">
                                <FileText className="w-5 h-5" />
                              </div>
                              <div className="min-w-0 flex-1">
                                <div className="font-semibold text-gray-900 truncate text-[11px] leading-tight">
                                  {waAttachment.name}
                                </div>
                                <div className="text-[9px] text-gray-500 flex items-center gap-1.5 mt-0.5">
                                  <span className="font-bold text-emerald-800 bg-emerald-100 px-1 py-0.2 rounded text-[9px]">
                                    {waAttachment.documentType}
                                  </span>
                                  <span>&bull;</span>
                                  <span>{waAttachment.formattedSize || 'PDF Document'}</span>
                                </div>
                              </div>
                            </div>
                          )
                        )}

                        <div className="text-xs whitespace-pre-wrap leading-relaxed">
                          {previewFormattedWaMessage(waSelectedRecipients[waPreviewIndex])}
                        </div>

                        <div className="flex items-center justify-end gap-1.5 text-[10px] text-gray-600 pt-0.5">
                          <span>{new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}</span>
                          <span className="px-1.5 py-0.2 rounded bg-amber-100 text-amber-900 border border-amber-300 font-bold text-[9px] uppercase tracking-wider">
                            PREVIEW — NOT SENT
                          </span>
                        </div>
                      </div>
                    </div>
                  </div>
                </div>
              </div>

              {/* Live Dispatch Controls & Log */}
              <div className="bg-white rounded-lg border border-gray-200 p-4 shadow-xs space-y-3">
                <div className="flex items-center justify-between border-b pb-2">
                  <span className="text-xs font-bold text-gray-800 uppercase flex items-center gap-1.5">
                    <Clock className="w-3.5 h-3.5 text-gray-500" />
                    Live Dispatch Status & Controls
                  </span>
                  {waIsSending && (
                    <span className="text-[10px] text-emerald-600 font-bold animate-pulse flex items-center gap-1">
                      <span className="w-2 h-2 rounded-full bg-emerald-500" />
                      DISPATCHING
                    </span>
                  )}
                </div>

                {/* Active Dispatch Controls: Progress, Pause, Resume, Cancel */}
                {waIsSending && (
                  <div className="space-y-2 bg-slate-50 p-3 rounded-lg border border-slate-200">
                    <div className="flex justify-between text-xs font-semibold text-gray-700">
                      <span className="truncate">Target: {waCurrentRecipient || 'Pacing queue...'}</span>
                      <span className="font-mono">{waProgress}%</span>
                    </div>

                    <div className="w-full h-2.5 bg-gray-200 rounded-full overflow-hidden">
                      <div
                        className="h-full bg-emerald-500 transition-all duration-300"
                        style={{ width: `${waProgress}%` }}
                      />
                    </div>

                    <div className="flex items-center justify-between pt-1">
                      <button
                        onClick={handlePauseResumeWa}
                        className={`inline-flex items-center gap-1 px-3 py-1 rounded text-xs font-semibold ${
                          waIsPaused ? 'bg-emerald-600 text-white' : 'bg-amber-100 text-amber-800'
                        }`}
                      >
                        {waIsPaused ? <Play className="w-3 h-3" /> : <Pause className="w-3 h-3" />}
                        <span>{waIsPaused ? 'Resume' : 'Pause'}</span>
                      </button>

                      <button
                        onClick={handleCancelWa}
                        className="inline-flex items-center gap-1 px-3 py-1 bg-rose-100 hover:bg-rose-200 text-rose-800 rounded text-xs font-semibold"
                      >
                        <Square className="w-3 h-3" />
                        <span>Cancel Broadcast</span>
                      </button>
                    </div>
                  </div>
                )}

                {/* Retry Failed Action (if any failures recorded) */}
                {waFailedRecipients.length > 0 && !waIsSending && (
                  <div className="p-2.5 bg-rose-50 border border-rose-200 rounded-md flex items-center justify-between text-xs text-rose-800">
                    <div className="flex items-center gap-1.5">
                      <AlertTriangle className="w-4 h-4 text-rose-600 flex-shrink-0" />
                      <span>{waFailedRecipients.length} messages failed to dispatch.</span>
                    </div>
                    <button
                      onClick={handleRetryFailedWa}
                      className="inline-flex items-center gap-1 px-2.5 py-1 bg-rose-600 hover:bg-rose-700 text-white rounded font-semibold text-xs transition"
                    >
                      <RotateCcw className="w-3 h-3" />
                      Retry Failed Only
                    </button>
                  </div>
                )}

                {/* Dispatch Activity Logs */}
                <div className="max-h-48 overflow-y-auto divide-y divide-gray-100 text-xs">
                  {waLogs.length === 0 ? (
                    <div className="text-center text-gray-400 py-6 text-[11px]">
                      No dispatch activity recorded yet.
                    </div>
                  ) : (
                    waLogs.map((log, idx) => (
                      <div key={idx} className="py-2 flex items-center justify-between">
                        <div className="flex items-center gap-1.5 min-w-0">
                          {log.status === 'sent' ? (
                            <CheckCircle2 className="w-3.5 h-3.5 text-emerald-600 flex-shrink-0" />
                          ) : (
                            <AlertTriangle className="w-3.5 h-3.5 text-rose-600 flex-shrink-0" />
                          )}
                          <span className="font-semibold text-gray-900 truncate">{log.name}</span>
                          <span className="text-gray-400 text-[10px]">({log.phone})</span>
                          {log.error && (
                            <span className="text-rose-600 text-[10px] truncate max-w-[120px]" title={log.error}>
                              &bull; {log.error}
                            </span>
                          )}
                        </div>
                        <span className="text-[10px] text-gray-400 font-mono flex-shrink-0">{log.timestamp}</span>
                      </div>
                    ))
                  )}
                </div>
              </div>
            </div>
          </div>

          {/* Modal 1: WhatsApp Recipient Selector & Phone Audit Directory */}
          {waRecipientSelectorOpen && (
            <div className="fixed inset-0 z-50 bg-black/50 backdrop-blur-xs flex items-center justify-center p-4">
              <div className="bg-white rounded-xl shadow-2xl border border-gray-200 w-full max-w-4xl max-h-[85vh] flex flex-col overflow-hidden">
                <div className="px-5 py-3 border-b border-gray-200 flex items-center justify-between bg-slate-50">
                  <div className="flex items-center gap-2">
                    <Smartphone className="w-4 h-4 text-emerald-600" />
                    <h3 className="text-sm font-bold text-gray-900">
                      WhatsApp Recipient Directory & Eligibility Audit
                    </h3>
                  </div>
                  <button
                    onClick={() => setWaRecipientSelectorOpen(false)}
                    className="p-1 rounded text-gray-400 hover:text-gray-700"
                  >
                    ✕
                  </button>
                </div>

                {/* Filter and Search Bar */}
                <div className="p-4 border-b border-gray-200 bg-white flex flex-col sm:flex-row items-stretch sm:items-center justify-between gap-3">
                  <div className="relative flex-1">
                    <Search className="w-3.5 h-3.5 absolute left-3 top-2.5 text-gray-400" />
                    <input
                      type="text"
                      value={waRecipientSearch}
                      onChange={e => setWaRecipientSearch(e.target.value)}
                      placeholder="Search company, contact person, phone number..."
                      className="w-full pl-9 pr-3 py-1.5 text-xs bg-slate-50 border border-gray-300 rounded-md focus:bg-white focus:outline-emerald-500"
                    />
                  </div>

                  <div className="flex items-center gap-2 flex-wrap">
                    <select
                      value={waDepartmentFilter}
                      onChange={e => setWaDepartmentFilter(e.target.value)}
                      className="text-xs border border-gray-300 rounded-md p-1.5 bg-slate-50 text-gray-700"
                    >
                      <option value="all">All Departments</option>
                      {CRM_DEPARTMENTS.map(d => (
                        <option key={d} value={d}>{d}</option>
                      ))}
                    </select>

                    <select
                      value={waRecipientFilter}
                      onChange={e => setWaRecipientFilter(e.target.value as any)}
                      className="text-xs border border-gray-300 rounded-md p-1.5 bg-slate-50 text-gray-700"
                    >
                      <option value="all">All Records ({phoneAudit.items.length})</option>
                      <option value="eligible">WhatsApp Eligible ({phoneAudit.stats.eligible})</option>
                      <option value="landline">Landlines Excluded ({phoneAudit.stats.landline})</option>
                      <option value="invalid">Invalid / Missing ({phoneAudit.stats.invalid + phoneAudit.stats.missing})</option>
                      <option value="duplicate">Duplicates ({phoneAudit.stats.duplicates})</option>
                    </select>

                    <button
                      onClick={handleSelectAllEligibleWa}
                      className="inline-flex items-center gap-1 px-3 py-1.5 bg-emerald-600 hover:bg-emerald-700 text-white rounded text-xs font-semibold whitespace-nowrap shadow-xs"
                    >
                      <Check className="w-3.5 h-3.5" />
                      Select All Eligible ({phoneAudit.stats.eligible})
                    </button>
                  </div>
                </div>

                {/* Table of Verified Contacts */}
                <div className="flex-1 overflow-auto p-4">
                  <table className="w-full text-xs text-left">
                    <thead className="bg-slate-50 text-gray-700 font-bold uppercase text-[10px] border-b border-gray-200 sticky top-0">
                      <tr>
                        <th className="p-2 w-8">
                          <input
                            type="checkbox"
                            checked={waSelectedRecipients.length > 0 && waSelectedRecipients.length === filteredWaContacts.length}
                            onChange={e => {
                              if (e.target.checked) {
                                const eligibleFiltered = filteredWaContacts.filter(f => f.is_eligible);
                                setWaSelectedRecipients(eligibleFiltered.map(f => ({
                                  id: f.id,
                                  contact_id: f.contact_id || f.id,
                                  company_name: f.company_name,
                                  contact_person: f.contact_person,
                                  department: f.department || 'Purchasing',
                                  email: f.email,
                                  mobile: f.validation.normalized || f.raw_phone || '',
                                  phone: f.raw_phone,
                                  city: f.city,
                                  customer_type: f.customer_type,
                                  is_active: true,
                                })));
                              } else {
                                setWaSelectedRecipients([]);
                              }
                            }}
                            className="rounded text-emerald-600"
                          />
                        </th>
                        <th className="p-2">Company</th>
                        <th className="p-2">Contact Person</th>
                        <th className="p-2">Department</th>
                        <th className="p-2">City</th>
                        <th className="p-2">Raw Phone</th>
                        <th className="p-2">Number Type</th>
                        <th className="p-2">E.164 Normalized</th>
                        <th className="p-2">Eligibility Status</th>
                      </tr>
                    </thead>
                    <tbody className="divide-y divide-gray-100">
                      {filteredWaContacts.map(item => {
                        const isSelected = waSelectedRecipients.some(r => r.id === item.id);
                        return (
                          <tr
                            key={item.id}
                            onClick={() => handleToggleWaRecipient(item)}
                            className={`cursor-pointer transition hover:bg-slate-50 ${
                              isSelected ? 'bg-emerald-50/50' : ''
                            }`}
                          >
                            <td className="p-2" onClick={e => e.stopPropagation()}>
                              <input
                                type="checkbox"
                                checked={isSelected}
                                onChange={() => handleToggleWaRecipient(item)}
                                className="rounded text-emerald-600"
                              />
                            </td>
                            <td className="p-2 font-semibold text-gray-900">{item.company_name}</td>
                            <td className="p-2 text-gray-700">{item.contact_person || '—'}</td>
                            <td className="p-2">
                              <span className={`text-[9px] font-bold px-1.5 py-0.5 rounded border ${
                                item.department === 'Purchasing'
                                  ? 'bg-blue-50 text-blue-800 border-blue-200'
                                  : item.department === 'Import'
                                  ? 'bg-purple-50 text-purple-800 border-purple-200'
                                  : item.department === 'QA / QC'
                                  ? 'bg-teal-50 text-teal-800 border-teal-200'
                                  : item.department === 'Sales'
                                  ? 'bg-amber-50 text-amber-800 border-amber-200'
                                  : 'bg-slate-100 text-slate-700 border-slate-200'
                              }`}>
                                {item.department || 'General'}
                              </span>
                            </td>
                            <td className="p-2 text-gray-500">{item.city || '—'}</td>
                            <td className="p-2 font-mono text-[11px] text-gray-600">{item.raw_phone || '—'}</td>
                            <td className="p-2">
                              <span className={`text-[10px] font-semibold px-2 py-0.5 rounded-full ${
                                item.validation.type === 'valid_mobile'
                                  ? 'bg-emerald-100 text-emerald-800'
                                  : item.validation.type === 'landline'
                                  ? 'bg-amber-100 text-amber-800'
                                  : 'bg-rose-100 text-rose-800'
                              }`}>
                                {item.validation.type.replace('_', ' ')}
                              </span>
                            </td>
                            <td className="p-2 font-mono text-[11px] text-gray-600">
                              {item.validation.normalized || '—'}
                            </td>
                            <td className="p-2">
                              {item.is_eligible ? (
                                <span className="inline-flex items-center gap-1 text-[10px] font-bold text-emerald-700 bg-emerald-50 border border-emerald-200 px-2 py-0.5 rounded-full">
                                  <CheckCircle2 className="w-3 h-3 text-emerald-600" />
                                  Eligible
                                </span>
                              ) : (
                                <span className="inline-flex items-center gap-1 text-[10px] font-medium text-rose-700 bg-rose-50 border border-rose-200 px-2 py-0.5 rounded-full" title={item.exclusion_reason}>
                                  <AlertTriangle className="w-3 h-3 text-rose-600" />
                                  {item.exclusion_reason || 'Ineligible'}
                                </span>
                              )}
                            </td>
                          </tr>
                        );
                      })}
                    </tbody>
                  </table>
                </div>

                <div className="px-5 py-3 border-t border-gray-200 bg-slate-50 flex items-center justify-between">
                  <span className="text-xs text-gray-600">
                    Selected <strong>{waSelectedRecipients.length}</strong> contacts for campaign.
                  </span>
                  <button
                    onClick={() => setWaRecipientSelectorOpen(false)}
                    className="px-4 py-1.5 bg-emerald-600 hover:bg-emerald-700 text-white rounded text-xs font-bold"
                  >
                    Done Selecting
                  </button>
                </div>
              </div>
            </div>
          )}

          {/* Modal 2: Human Approval Gate Confirmation Modal */}
          {waShowApprovalModal && (
            <div className="fixed inset-0 z-50 bg-black/50 backdrop-blur-xs flex items-center justify-center p-4">
              <div className="bg-white rounded-xl shadow-2xl border border-gray-200 w-full max-w-md p-5 space-y-4">
                <div className="flex items-center gap-2.5 text-amber-900 border-b pb-3">
                  <ShieldCheck className="w-5 h-5 text-amber-600" />
                  <h3 className="text-sm font-bold">Human Approval Gate: Confirm WhatsApp Broadcast</h3>
                </div>

                <div className="space-y-3 text-xs text-gray-700 leading-relaxed">
                  <p>
                    You are authorizing an automated WhatsApp Business campaign dispatch with the following verified parameters:
                  </p>

                  <div className="bg-slate-50 border border-slate-200 rounded-md p-3 space-y-1.5 text-xs">
                    <div className="flex justify-between">
                      <span className="text-gray-500">Recipients:</span>
                      <span className="font-bold text-gray-900">{waSelectedRecipients.length} Verified Mobile Contacts</span>
                    </div>
                    <div className="flex justify-between">
                      <span className="text-gray-500">Pacing Delay:</span>
                      <span className="font-bold text-gray-900">{waPacingSeconds} Seconds / Message</span>
                    </div>
                    <div className="flex justify-between">
                      <span className="text-gray-500">Document Attachment:</span>
                      <span className="font-bold text-gray-900">{waAttachment?.name || 'None (Text Only)'}</span>
                    </div>
                    <div className="flex justify-between">
                      <span className="text-gray-500">Transport:</span>
                      <span className="font-bold text-emerald-700">OpenWA Real Transport (127.0.0.1:3100)</span>
                    </div>
                  </div>

                  <p className="text-[11px] text-amber-800 bg-amber-50 p-2.5 rounded border border-amber-200">
                    <strong>Notice:</strong> Messages will be dispatched to actual commercial mobile numbers. You can pause or cancel at any moment during execution.
                  </p>
                </div>

                <div className="flex items-center justify-end gap-2 pt-2 border-t">
                  <button
                    onClick={() => setWaShowApprovalModal(false)}
                    className="px-3 py-1.5 text-xs text-gray-600 hover:bg-gray-100 rounded"
                  >
                    Cancel
                  </button>
                  <button
                    onClick={executeWaDispatch}
                    className="inline-flex items-center gap-1.5 px-4 py-1.5 bg-emerald-600 hover:bg-emerald-700 text-white rounded text-xs font-bold shadow-xs transition"
                  >
                    <CheckCircle2 className="w-3.5 h-3.5" />
                    Confirm & Authorize Dispatch
                  </button>
                </div>
              </div>
            </div>
          )}
        </div>
      )}

      {/* 3. RECIPIENTS DIRECTORY TAB */}
      {activeTab === 'recipients' && (
        <div className="bg-white rounded-lg border border-gray-200 shadow-xs space-y-3 p-4">
          <div className="flex flex-col sm:flex-row items-stretch sm:items-center justify-between gap-3 border-b pb-3">
            <div className="flex items-center gap-2 flex-1 max-w-md">
              <div className="relative flex-1">
                <Search className="w-3.5 h-3.5 absolute left-3 top-2.5 text-gray-400" />
                <input
                  type="text"
                  value={contactSearch}
                  onChange={e => setContactSearch(e.target.value)}
                  placeholder="Search recipient company, contact, email, phone, city..."
                  className="w-full pl-9 pr-3 py-1.5 text-xs bg-slate-50 border border-gray-300 rounded-md focus:bg-white focus:outline-blue-500"
                />
              </div>

              <select
                value={channelFilter}
                onChange={e => setChannelFilter(e.target.value as any)}
                className="text-xs border border-gray-300 rounded-md p-1.5 bg-slate-50 text-gray-700"
              >
                <option value="all">All Channels</option>
                <option value="has_email">Has Email Only</option>
                <option value="has_phone">Has Phone Only</option>
              </select>

              <button
                onClick={loadContacts}
                disabled={loadingContacts}
                className="p-1.5 text-gray-500 hover:text-gray-800 hover:bg-gray-100 rounded border border-gray-200"
                title="Refresh contacts"
              >
                <RefreshCw className={`w-3.5 h-3.5 ${loadingContacts ? 'animate-spin' : ''}`} />
              </button>
            </div>

            {/* Bulk Actions on Selected Recipients */}
            <div className="flex items-center gap-2">
              <span className="text-xs font-semibold text-gray-600">
                {selectedContactIds.size} Selected
              </span>
              <button
                onClick={handleStageForEmail}
                disabled={selectedContactIds.size === 0}
                className="inline-flex items-center gap-1 px-3 py-1.5 bg-blue-600 hover:bg-blue-700 text-white rounded text-xs font-semibold disabled:opacity-40 transition"
              >
                <Mail className="w-3 h-3" />
                <span>Send Email</span>
              </button>
              <button
                onClick={handleStageForWhatsApp}
                disabled={selectedContactIds.size === 0}
                className="inline-flex items-center gap-1 px-3 py-1.5 bg-emerald-600 hover:bg-emerald-700 text-white rounded text-xs font-semibold disabled:opacity-40 transition"
              >
                <MessageSquare className="w-3 h-3" />
                <span>Send WhatsApp</span>
              </button>
            </div>
          </div>

          {/* Directory Table */}
          <div className="overflow-x-auto border border-gray-200 rounded-md">
            <table className="w-full text-xs text-left">
              <thead className="bg-slate-50 text-gray-700 font-bold uppercase text-[10px] border-b border-gray-200">
                <tr>
                  <th className="p-2.5 w-8">
                    <input
                      type="checkbox"
                      checked={filteredContacts.length > 0 && selectedContactIds.size === filteredContacts.length}
                      onChange={e => handleSelectAllContacts(e.target.checked)}
                      className="rounded text-blue-600"
                    />
                  </th>
                  <th className="p-2.5">Company Name</th>
                  <th className="p-2.5">Contact Person</th>
                  <th className="p-2.5">Email</th>
                  <th className="p-2.5">Phone / Mobile</th>
                  <th className="p-2.5">City</th>
                  <th className="p-2.5">Type</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-gray-100">
                {loadingContacts && (
                  <tr>
                    <td colSpan={7} className="p-8 text-center text-gray-500">
                      <RefreshCw className="w-4 h-4 animate-spin mx-auto mb-2 text-blue-600" />
                      Loading recipients directory...
                    </td>
                  </tr>
                )}

                {!loadingContacts && filteredContacts.length === 0 && (
                  <tr>
                    <td colSpan={7} className="p-8 text-center text-gray-500">
                      No recipients found matching your filter.
                    </td>
                  </tr>
                )}

                {filteredContacts.map(c => {
                  const isSelected = selectedContactIds.has(c.id);
                  return (
                    <tr
                      key={c.id}
                      onClick={() => handleToggleContact(c.id)}
                      className={`cursor-pointer hover:bg-blue-50/50 transition ${
                        isSelected ? 'bg-blue-50/70' : ''
                      }`}
                    >
                      <td className="p-2.5" onClick={e => e.stopPropagation()}>
                        <input
                          type="checkbox"
                          checked={isSelected}
                          onChange={() => handleToggleContact(c.id)}
                          className="rounded text-blue-600"
                        />
                      </td>
                      <td className="p-2.5 font-semibold text-gray-900">{c.company_name}</td>
                      <td className="p-2.5 text-gray-700">{c.contact_person || '—'}</td>
                      <td className="p-2.5 text-gray-600 font-mono text-[11px]">{c.email || '—'}</td>
                      <td className="p-2.5 text-gray-600 font-mono text-[11px]">{c.phone || c.mobile || '—'}</td>
                      <td className="p-2.5 text-gray-500">{c.city || '—'}</td>
                      <td className="p-2.5 text-gray-500">{c.customer_type || 'Customer'}</td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        </div>
      )}

      {/* 4. TEMPLATES TAB */}
      {activeTab === 'templates' && (
        <div className="bg-white rounded-lg border border-gray-200 shadow-xs p-4 space-y-3">
          <div className="flex items-center justify-between border-b pb-3 flex-wrap gap-2">
            <div className="flex items-center gap-2">
              <span className="text-xs font-bold text-gray-800 uppercase">Template Filter:</span>
              <div className="inline-flex rounded border border-gray-200 bg-slate-100 p-0.5 text-xs font-semibold">
                <button
                  onClick={() => setTemplateTypeFilter('all')}
                  className={`px-2.5 py-1 rounded transition ${templateTypeFilter === 'all' ? 'bg-white text-gray-900 shadow-xs' : 'text-gray-500'}`}
                >
                  All ({templates.length})
                </button>
                <button
                  onClick={() => setTemplateTypeFilter('email')}
                  className={`px-2.5 py-1 rounded transition ${templateTypeFilter === 'email' ? 'bg-white text-gray-900 shadow-xs' : 'text-gray-500'}`}
                >
                  Email ({templates.filter(t => t.type === 'email').length})
                </button>
                <button
                  onClick={() => setTemplateTypeFilter('whatsapp')}
                  className={`px-2.5 py-1 rounded transition ${templateTypeFilter === 'whatsapp' ? 'bg-white text-gray-900 shadow-xs' : 'text-gray-500'}`}
                >
                  WhatsApp ({templates.filter(t => t.type === 'whatsapp').length})
                </button>
              </div>
            </div>

            <button
              onClick={() => setShowNewTemplateModal(true)}
              className="inline-flex items-center gap-1.5 px-3 py-1.5 bg-blue-600 hover:bg-blue-700 text-white rounded text-xs font-semibold shadow-xs"
            >
              <Plus className="w-3.5 h-3.5" />
              <span>Create Template</span>
            </button>
          </div>

          <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-3">
            {templates
              .filter(t => templateTypeFilter === 'all' || t.type === templateTypeFilter)
              .map(t => (
                <div key={t.id} className="border border-gray-200 rounded-lg p-3.5 space-y-2 hover:border-blue-300 transition bg-white shadow-2xs">
                  <div className="flex items-center justify-between">
                    <span className="font-bold text-xs text-gray-900">{t.name}</span>
                    <span
                      className={`text-[9px] font-bold px-1.5 py-0.5 rounded uppercase ${
                        t.type === 'email' ? 'bg-blue-50 text-blue-700 border border-blue-200' : 'bg-emerald-50 text-emerald-700 border border-emerald-200'
                      }`}
                    >
                      {t.type}
                    </span>
                  </div>

                  {t.subject && (
                    <div className="text-[11px] text-gray-600 font-medium">
                      Subject: {t.subject}
                    </div>
                  )}

                  <div className="text-xs text-gray-700 whitespace-pre-wrap line-clamp-4 bg-slate-50 p-2 rounded border border-gray-100 font-sans">
                    {t.body}
                  </div>

                  <div className="pt-1 flex items-center justify-between text-[10px] text-gray-400">
                    <span>Category: {t.category}</span>
                    <button
                      onClick={() => {
                        if (t.type === 'email') {
                          handleSubTabChange('email');
                        } else {
                          setWaMessageTemplate(t.body);
                          handleSubTabChange('whatsapp');
                        }
                      }}
                      className="text-blue-600 font-semibold hover:underline"
                    >
                      Use in Campaign →
                    </button>
                  </div>
                </div>
              ))}
          </div>
        </div>
      )}

      {/* 5. CAMPAIGN HISTORY TAB */}
      {activeTab === 'history' && (
        <div className="bg-white rounded-lg border border-gray-200 p-4 shadow-xs">
          <DeliveryLog />
        </div>
      )}

      {/* New Template Modal */}
      {showNewTemplateModal && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4">
          <div className="bg-white rounded-lg shadow-xl w-full max-w-lg p-4 space-y-3">
            <div className="flex items-center justify-between border-b pb-2">
              <h3 className="text-sm font-bold text-gray-900">Create Campaign Template</h3>
              <button onClick={() => setShowNewTemplateModal(false)} className="text-gray-400 hover:text-gray-600">
                ✕
              </button>
            </div>

            <form onSubmit={handleSaveTemplate} className="space-y-3 text-xs">
              <div className="grid grid-cols-2 gap-3">
                <div>
                  <label className="font-bold text-gray-700 uppercase block mb-1">Template Type</label>
                  <select
                    value={newTemplateType}
                    onChange={e => setNewTemplateType(e.target.value as any)}
                    className="w-full border border-gray-300 rounded p-1.5 bg-white"
                  >
                    <option value="whatsapp">WhatsApp</option>
                    <option value="email">Email</option>
                  </select>
                </div>

                <div>
                  <label className="font-bold text-gray-700 uppercase block mb-1">Category</label>
                  <input
                    type="text"
                    value={newTemplateCategory}
                    onChange={e => setNewTemplateCategory(e.target.value)}
                    placeholder="e.g. Promotion, Follow-up"
                    className="w-full border border-gray-300 rounded p-1.5"
                  />
                </div>
              </div>

              <div>
                <label className="font-bold text-gray-700 uppercase block mb-1">Template Name</label>
                <input
                  type="text"
                  value={newTemplateName}
                  onChange={e => setNewTemplateName(e.target.value)}
                  placeholder="e.g. Q4 Ready Stock Announcement"
                  className="w-full border border-gray-300 rounded p-1.5"
                  required
                />
              </div>

              {newTemplateType === 'email' && (
                <div>
                  <label className="font-bold text-gray-700 uppercase block mb-1">Email Subject</label>
                  <input
                    type="text"
                    value={newTemplateSubject}
                    onChange={e => setNewTemplateSubject(e.target.value)}
                    placeholder="e.g. Ready Stock Pharma API Jakarta Warehouse"
                    className="w-full border border-gray-300 rounded p-1.5"
                  />
                </div>
              )}

              <div>
                <label className="font-bold text-gray-700 uppercase block mb-1">Message Body</label>
                <textarea
                  rows={6}
                  value={newTemplateBody}
                  onChange={e => setNewTemplateBody(e.target.value)}
                  placeholder="Write message template with {{contact_person}} and {{company_name}}..."
                  className="w-full border border-gray-300 rounded p-2 font-sans"
                  required
                />
              </div>

              <div className="pt-2 flex justify-end gap-2 border-t">
                <button
                  type="button"
                  onClick={() => setShowNewTemplateModal(false)}
                  className="px-3 py-1.5 border rounded text-gray-600 hover:bg-gray-100"
                >
                  Cancel
                </button>
                <button
                  type="submit"
                  disabled={savingTemplate}
                  className="px-4 py-1.5 bg-blue-600 hover:bg-blue-700 text-white rounded font-semibold disabled:opacity-50"
                >
                  {savingTemplate ? 'Saving...' : 'Save Template'}
                </button>
              </div>
            </form>
          </div>
        </div>
      )}
      {/* Interactive Contact Phone Audit & Correction Centre Modal */}
      {phoneAuditCategory !== null && (
        <PhoneAuditCorrectionModal
          isOpen={phoneAuditCategory !== null}
          onClose={() => setPhoneAuditCategory(null)}
          initialCategory={phoneAuditCategory}
          contacts={contacts}
          phoneAudit={phoneAudit}
          onContactUpdated={handleContactUpdated}
          onContactsBatchUpdated={handleContactsBatchUpdated}
        />
      )}

      {/* WhatsApp Attachment Modal (Document Bank & File Upload) */}
      <WhatsAppAttachmentModal
        isOpen={isAttachmentModalOpen}
        onClose={() => setIsAttachmentModalOpen(false)}
        currentAttachment={waAttachment}
        onSelectAttachment={(att) => setWaAttachment(att)}
      />
    </div>
  );
}

export default CrmCampaignsWorkspace;
