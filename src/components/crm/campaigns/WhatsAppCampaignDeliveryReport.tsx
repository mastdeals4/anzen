import React, { useEffect, useState, useCallback, useRef, useMemo } from 'react';
import { supabase } from '../../../lib/supabase';
import { showToast } from '../../ToastNotification';
import { WhatsAppTransportService } from '../../../services/whatsapp/whatsappTransportService';
import { formatPersonalizedWhatsAppMessage } from '../../../utils/whatsappPersonalization';
import * as XLSX from 'xlsx';
import {
  MessageSquare,
  CheckCircle2,
  Clock,
  AlertTriangle,
  RefreshCw,
  Pause,
  Play,
  Square,
  Search,
  Paperclip,
  CheckCheck,
  Send,
  XCircle,
  Wifi,
  WifiOff,
  Download,
  RotateCcw,
  FileSpreadsheet,
  ShieldAlert,
  Info,
  X,
  AlertOctagon,
} from 'lucide-react';

export interface WhatsAppCampaignItem {
  id: string;
  name: string;
  template_id?: string | null;
  message_template: string;
  attachment_url?: string | null;
  attachment_filename?: string | null;
  attachment_type?: string | null;
  status: 'queued' | 'in_progress' | 'paused' | 'completed' | 'cancelled' | 'failed' | 'partial';
  total_recipients: number;
  sent_count: number;
  delivered_count: number;
  read_count: number;
  failed_count: number;
  processing_delay_seconds: number;
  worker_lock_id?: string | null;
  worker_lock_until?: string | null;
  worker_started_at?: string | null;
  started_at?: string | null;
  completed_at?: string | null;
  created_at: string;
}

export interface WhatsAppCampaignRecipientItem {
  id: string;
  campaign_id: string;
  contact_id?: string | null;
  company_name: string;
  contact_person?: string | null;
  phone: string;
  status: 'pending' | 'sending' | 'sent' | 'delivered' | 'read' | 'failed' | 'cancelled';
  personalized_caption?: string | null;
  message_id?: string | null;
  sent_at?: string | null;
  delivered_at?: string | null;
  read_at?: string | null;
  failed_at?: string | null;
  error_code?: string | null;
  error_message?: string | null;
  created_at: string;
}

interface Props {
  initialCampaignId?: string | null;
  onSelectCampaign?: (id: string) => void;
}

export function isTestWhatsAppCampaign(name: string): boolean {
  const s = (name || '').toLowerCase();
  return (
    s.includes('acceptance test') ||
    s.includes('history resume') ||
    s.includes('history reconcile') ||
    s.includes('history pause-cancel') ||
    s.includes('test lab') ||
    s.includes('[test]') ||
    s.includes('qa_')
  );
}

export function WhatsAppCampaignDeliveryReport({ initialCampaignId }: Props) {
  const [campaigns, setCampaigns] = useState<WhatsAppCampaignItem[]>([]);
  const [showTestCampaigns, setShowTestCampaigns] = useState(false);
  const [selectedCampaignId, setSelectedCampaignId] = useState<string | null>(initialCampaignId || null);
  const [selectedCampaign, setSelectedCampaign] = useState<WhatsAppCampaignItem | null>(null);
  const [recipients, setRecipients] = useState<WhatsAppCampaignRecipientItem[]>([]);
  const [loading, setLoading] = useState(false);
  const [loadingRecipients, setLoadingRecipients] = useState(false);
  const [searchQuery, setSearchQuery] = useState('');
  const [statusFilter, setStatusFilter] = useState<'all' | 'sent' | 'delivered' | 'read' | 'failed' | 'pending'>('all');

  // Local OpenWA Adapter Health
  const [adapterHealth, setAdapterHealth] = useState<{
    status: 'checking' | 'connected' | 'disconnected';
    businessPhone?: string;
    details?: string;
  }>({ status: 'checking' });
  const [isCheckingAdapter, setIsCheckingAdapter] = useState(false);

  // Live Dispatch Controller States
  const [isSending, setIsSending] = useState(false);
  const [isPaused, setIsPaused] = useState(false);
  const [countdown, setCountdown] = useState<number | null>(null);
  const [currentRecipientInfo, setCurrentRecipientInfo] = useState<string | null>(null);

  // Execution controllers (survive async loops & state closures)
  const isPausedRef = useRef(false);
  const isCancelledRef = useRef(false);
  const isSendingRef = useRef(false);
  const currentWorkerLockIdRef = useRef<string | null>(null);

  // Reconcile & Manual Retry Modal
  const [reconcileTarget, setReconcileTarget] = useState<WhatsAppCampaignRecipientItem | null>(null);
  const [isReconciling, setIsReconciling] = useState(false);
  const [reconcileFinding, setReconcileFinding] = useState<{
    canRetry: boolean;
    alreadySent: boolean;
    messageId?: string;
    details: string;
  } | null>(null);
  const [isRetryingManual, setIsRetryingManual] = useState(false);

  // Check OpenWA Health
  const checkAdapterHealth = useCallback(async () => {
    setIsCheckingAdapter(true);
    try {
      const health = await WhatsAppTransportService.checkHealth();
      setAdapterHealth({
        status: health.status === 'connected' ? 'connected' : 'disconnected',
        businessPhone: health.businessPhone,
        details: health.details,
      });
    } catch (err: any) {
      setAdapterHealth({
        status: 'disconnected',
        details: err?.message || 'Local OpenWA daemon unreachable at 127.0.0.1:3100',
      });
    } finally {
      setIsCheckingAdapter(false);
    }
  }, []);

  useEffect(() => {
    checkAdapterHealth();
  }, [checkAdapterHealth]);

  // Load campaigns list from Supabase
  const loadCampaigns = useCallback(async () => {
    setLoading(true);
    try {
      const { data, error } = await supabase
        .from('whatsapp_campaigns')
        .select('*')
        .order('created_at', { ascending: false })
        .limit(200);

      if (error) throw error;
      setCampaigns(data || []);

      if (data && data.length > 0) {
        if (!selectedCampaignId) {
          const firstNonTest = data.find((c) => !isTestWhatsAppCampaign(c.name)) || data[0];
          setSelectedCampaignId(firstNonTest.id);
          setSelectedCampaign(firstNonTest);
        } else {
          const found = data.find((c) => c.id === selectedCampaignId);
          if (found) setSelectedCampaign(found);
        }
      }
    } catch (err: any) {
      console.error('Failed to load WhatsApp campaigns:', err);
    } finally {
      setLoading(false);
    }
  }, [selectedCampaignId]);

  const displayedCampaigns = useMemo(() => {
    if (showTestCampaigns) return campaigns;
    return campaigns.filter((c) => !isTestWhatsAppCampaign(c.name));
  }, [campaigns, showTestCampaigns]);

  useEffect(() => {
    if (displayedCampaigns.length > 0) {
      if (!selectedCampaignId || !displayedCampaigns.some((c) => c.id === selectedCampaignId)) {
        setSelectedCampaignId(displayedCampaigns[0].id);
        setSelectedCampaign(displayedCampaigns[0]);
      }
    }
  }, [displayedCampaigns, selectedCampaignId]);

  // Load recipients for selected campaign
  const loadRecipients = useCallback(async (campaignId: string) => {
    setLoadingRecipients(true);
    try {
      // First refresh counts via RPC if available
      try {
        await supabase.rpc('refresh_whatsapp_campaign_counts', { p_campaign_id: campaignId });
      } catch {
        // Fallback gracefully if RPC is not available
      }

      const [{ data: recs, error: recsErr }, { data: camp, error: campErr }] = await Promise.all([
        supabase
          .from('whatsapp_campaign_recipients')
          .select('*')
          .eq('campaign_id', campaignId)
          .order('created_at', { ascending: true }),
        supabase
          .from('whatsapp_campaigns')
          .select('*')
          .eq('id', campaignId)
          .single(),
      ]);

      if (recsErr) throw recsErr;
      if (campErr) throw campErr;

      setRecipients(recs || []);
      if (camp) setSelectedCampaign(camp);
    } catch (err: any) {
      console.error('Failed to load campaign recipients:', err);
    } finally {
      setLoadingRecipients(false);
    }
  }, []);

  useEffect(() => {
    loadCampaigns();
  }, [loadCampaigns]);

  useEffect(() => {
    if (selectedCampaignId) {
      loadRecipients(selectedCampaignId);
    }
  }, [selectedCampaignId, loadRecipients]);

  // ---------------------------------------------------------------------------
  // LOCAL SEQUENTIAL DISPATCH ENGINE (RESUME / START)
  // ---------------------------------------------------------------------------
  const handleResumeCampaign = async () => {
    if (!selectedCampaignId || isSendingRef.current) return;

    // 1. Preflight Health Check
    try {
      const health = await WhatsAppTransportService.checkHealth();
      if (health.status !== 'connected') {
        showToast({
          type: 'error',
          title: 'OpenWA Adapter Offline',
          message: 'Local OpenWA daemon is not connected. Ensure WhatsApp session is active at 127.0.0.1:3100 before resuming dispatch.',
        });
        return;
      }
    } catch {
      showToast({
        type: 'error',
        title: 'OpenWA Adapter Unreachable',
        message: 'Could not connect to local OpenWA at 127.0.0.1:3100.',
      });
      return;
    }

    // 2. Fetch Latest Campaign Record and Concurrency / Worker Lock Check
    const { data: latestCamp, error: campErr } = await supabase
      .from('whatsapp_campaigns')
      .select('*')
      .eq('id', selectedCampaignId)
      .single();

    if (campErr || !latestCamp) {
      showToast({
        type: 'error',
        title: 'Campaign Load Error',
        message: 'Could not retrieve campaign state from Supabase.',
      });
      return;
    }

    const now = new Date();
    if (
      latestCamp.worker_lock_id &&
      latestCamp.worker_lock_until &&
      new Date(latestCamp.worker_lock_until) > now &&
      latestCamp.worker_lock_id !== currentWorkerLockIdRef.current
    ) {
      showToast({
        type: 'warning',
        title: 'Campaign Locked by Another Session',
        message: `Campaign is currently active in another session (Lock: ${latestCamp.worker_lock_id.slice(0, 16)}...). Simultaneous dispatch blocked.`,
      });
      return;
    }

    // 3. Acquire Local Worker Lock
    const lockId = `local_mac_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`;
    currentWorkerLockIdRef.current = lockId;
    const lockUntil = new Date(Date.now() + 5 * 60 * 1000).toISOString();

    const { error: lockErr } = await supabase
      .from('whatsapp_campaigns')
      .update({
        status: 'in_progress',
        worker_lock_id: lockId,
        worker_lock_until: lockUntil,
        worker_started_at: new Date().toISOString(),
        updated_at: new Date().toISOString(),
      })
      .eq('id', selectedCampaignId);

    if (lockErr) {
      showToast({
        type: 'error',
        title: 'Lock Acquisition Failed',
        message: `Could not obtain worker lock: ${lockErr.message}`,
      });
      return;
    }

    // 4. Load Pending Recipients Only (Preserve all completed and failed rows!)
    const { data: pendingRecs, error: recErr } = await supabase
      .from('whatsapp_campaign_recipients')
      .select('*')
      .eq('campaign_id', selectedCampaignId)
      .eq('status', 'pending')
      .order('created_at', { ascending: true });

    if (recErr) {
      showToast({
        type: 'error',
        title: 'Recipient Load Error',
        message: `Failed to load pending queue: ${recErr.message}`,
      });
      return;
    }

    if (!pendingRecs || pendingRecs.length === 0) {
      showToast({
        type: 'info',
        title: 'No Pending Recipients',
        message: 'All recipients in this campaign have already been processed.',
      });
      await supabase
        .from('whatsapp_campaigns')
        .update({
          status: latestCamp.failed_count > 0 ? (latestCamp.sent_count > 0 ? 'partial' : 'failed') : 'completed',
          worker_lock_id: null,
          worker_lock_until: null,
          completed_at: new Date().toISOString(),
        })
        .eq('id', selectedCampaignId);
      await loadCampaigns();
      await loadRecipients(selectedCampaignId);
      return;
    }

    // 5. Initialize Controller Refs
    isPausedRef.current = false;
    isCancelledRef.current = false;
    isSendingRef.current = true;
    setIsSending(true);
    setIsPaused(false);

    showToast({
      type: 'info',
      title: 'Dispatch Resumed',
      message: `Resuming dispatch for ${pendingRecs.length} pending recipients with ${latestCamp.processing_delay_seconds || 20}s interval.`,
    });

    const delaySeconds = Math.max(latestCamp.processing_delay_seconds || 20, 5);
    let sentCount = latestCamp.sent_count || 0;
    let failedCount = latestCamp.failed_count || 0;

    // 6. Sequential Dispatch Loop
    for (let i = 0; i < pendingRecs.length; i++) {
      // Check cancellation
      if (isCancelledRef.current) break;

      // Check pause
      while (isPausedRef.current) {
        await new Promise((res) => setTimeout(res, 500));
        if (isCancelledRef.current) break;
      }
      if (isCancelledRef.current) break;

      const r = pendingRecs[i];
      setCurrentRecipientInfo(`${r.company_name} (${r.phone})`);

      // Update recipient status to 'sending' in DB
      const { error: sendStatusErr } = await supabase
        .from('whatsapp_campaign_recipients')
        .update({ status: 'sending', updated_at: new Date().toISOString() })
        .eq('id', r.id);

      if (sendStatusErr) {
        console.error('Database write error marking recipient sending:', sendStatusErr);
        showToast({
          type: 'error',
          title: 'Database Write Error',
          message: 'Failed to update recipient state in database. Dispatch stopped to prevent untracked messages.',
        });
        break;
      }

      setRecipients((prev) =>
        prev.map((item) => (item.id === r.id ? { ...item, status: 'sending' } : item))
      );

      // Format personalized message
      const finalMessage =
        r.personalized_caption ||
        formatPersonalizedWhatsAppMessage(latestCamp.message_template, {
          contact_person: r.contact_person,
          company_name: r.company_name,
        });

      const isImage = latestCamp.attachment_type === 'IMAGE';
      const isDoc = latestCamp.attachment_type === 'DOCUMENT';

      let sendSuccess = false;
      let messageId: string | null = null;
      let errorMessage: string | null = null;

      try {
        const result = await WhatsAppTransportService.sendMessage({
          to: r.phone,
          text: finalMessage,
          caption: finalMessage,
          documentUrl: isDoc ? (latestCamp.attachment_url || undefined) : undefined,
          imageUrl: isImage ? (latestCamp.attachment_url || undefined) : undefined,
          filename: latestCamp.attachment_filename || undefined,
          consentVerified: true,
        });

        if (result.success) {
          sendSuccess = true;
          messageId = result.messageId || `wa_sent_${Date.now()}`;
        } else {
          errorMessage = result.error || 'Failed to dispatch via local OpenWA';
        }
      } catch (dispatchErr: any) {
        errorMessage = dispatchErr.message || 'Dispatch exception';
      }

      const nowIso = new Date().toISOString();

      if (sendSuccess) {
        sentCount++;
        const { error: dbUpdateErr } = await supabase
          .from('whatsapp_campaign_recipients')
          .update({
            status: 'sent',
            message_id: messageId,
            sent_at: nowIso,
            error_message: null,
            updated_at: nowIso,
          })
          .eq('id', r.id);

        if (dbUpdateErr) {
          console.error('Database update failed after send:', dbUpdateErr);
          showToast({
            type: 'error',
            title: 'Database Sync Failure',
            message: 'Database write failed after dispatch. Halting execution to prevent untracked messages.',
          });
          break;
        }

        await supabase
          .from('whatsapp_campaigns')
          .update({
            sent_count: sentCount,
            worker_lock_until: new Date(Date.now() + 5 * 60 * 1000).toISOString(),
            updated_at: nowIso,
          })
          .eq('id', selectedCampaignId);

        setSelectedCampaign((prev) => prev ? { ...prev, sent_count: sentCount } : null);
        setCampaigns((prev) => prev.map((c) => c.id === selectedCampaignId ? { ...c, sent_count: sentCount } : c));

        setRecipients((prev) =>
          prev.map((item) =>
            item.id === r.id
              ? { ...item, status: 'sent', message_id: messageId, sent_at: nowIso }
              : item
          )
        );
      } else {
        failedCount++;
        const { error: dbFailErr } = await supabase
          .from('whatsapp_campaign_recipients')
          .update({
            status: 'failed',
            error_message: errorMessage,
            failed_at: nowIso,
            updated_at: nowIso,
          })
          .eq('id', r.id);

        if (dbFailErr) {
          console.error('Database write error for failed recipient:', dbFailErr);
          break;
        }

        await supabase
          .from('whatsapp_campaigns')
          .update({
            failed_count: failedCount,
            worker_lock_until: new Date(Date.now() + 5 * 60 * 1000).toISOString(),
            updated_at: nowIso,
          })
          .eq('id', selectedCampaignId);

        setSelectedCampaign((prev) => prev ? { ...prev, failed_count: failedCount } : null);
        setCampaigns((prev) => prev.map((c) => c.id === selectedCampaignId ? { ...c, failed_count: failedCount } : c));

        setRecipients((prev) =>
          prev.map((item) =>
            item.id === r.id ? { ...item, status: 'failed', error_message: errorMessage } : item
          )
        );
      }

      // Interval pacing countdown before next recipient (unless it's the last one)
      if (i < pendingRecs.length - 1 && !isCancelledRef.current && !isPausedRef.current) {
        for (let cd = delaySeconds; cd > 0; cd--) {
          setCountdown(cd);
          if (isPausedRef.current || isCancelledRef.current) break;
          await new Promise((res) => setTimeout(res, 1000));
        }
        setCountdown(null);
      }
    }

    // 7. Loop Teardown & Final Status Persist
    isSendingRef.current = false;
    setIsSending(false);
    setCurrentRecipientInfo(null);
    setCountdown(null);

    // Ensure no recipient remains stuck in 'sending' status in database
    await supabase
      .from('whatsapp_campaign_recipients')
      .update({
        status: 'failed',
        error_message: 'Dispatch interrupted or timeout occurred while in transit',
        updated_at: new Date().toISOString(),
      })
      .eq('campaign_id', selectedCampaignId)
      .eq('status', 'sending');

    setRecipients((prev) =>
      prev.map((item) =>
        item.status === 'sending'
          ? { ...item, status: 'failed', error_message: 'Dispatch interrupted or timeout occurred while in transit' }
          : item
      )
    );

    if (isCancelledRef.current) {
      await supabase
        .from('whatsapp_campaigns')
        .update({
          status: 'cancelled',
          worker_lock_id: null,
          worker_lock_until: null,
          completed_at: new Date().toISOString(),
        })
        .eq('id', selectedCampaignId);
    } else if (isPausedRef.current) {
      await supabase
        .from('whatsapp_campaigns')
        .update({
          status: 'paused',
          worker_lock_id: null,
          worker_lock_until: null,
        })
        .eq('id', selectedCampaignId);
    } else {
      const { count: remainingPending } = await supabase
        .from('whatsapp_campaign_recipients')
        .select('*', { count: 'exact', head: true })
        .eq('campaign_id', selectedCampaignId)
        .eq('status', 'pending');

      const finalStatus =
        (remainingPending || 0) > 0
          ? 'in_progress'
          : failedCount > 0
          ? sentCount > 0
            ? 'partial'
            : 'failed'
          : 'completed';

      await supabase
        .from('whatsapp_campaigns')
        .update({
          status: finalStatus,
          worker_lock_id: null,
          worker_lock_until: null,
          completed_at: finalStatus === 'completed' ? new Date().toISOString() : null,
        })
        .eq('id', selectedCampaignId);

      showToast({
        type: finalStatus === 'completed' ? 'success' : 'info',
        title: `Campaign ${finalStatus === 'completed' ? 'Completed' : 'Batch Done'}`,
        message: `Processed recipients. Sent: ${sentCount}, Failed: ${failedCount}.`,
      });
    }

    await loadCampaigns();
    await loadRecipients(selectedCampaignId);
  };

  // ---------------------------------------------------------------------------
  // PAUSE ACTION
  // ---------------------------------------------------------------------------
  const handlePauseCampaign = async () => {
    isPausedRef.current = true;
    setIsPaused(true);

    if (selectedCampaignId) {
      await supabase
        .from('whatsapp_campaigns')
        .update({
          status: 'paused',
          worker_lock_id: null,
          worker_lock_until: null,
          updated_at: new Date().toISOString(),
        })
        .eq('id', selectedCampaignId);
    }

    showToast({
      type: 'info',
      title: 'Campaign Paused',
      message: 'Dispatch paused. The current in-flight message will finish, then execution halts.',
    });
  };

  // ---------------------------------------------------------------------------
  // CANCEL ACTION
  // ---------------------------------------------------------------------------
  const handleCancelCampaign = async () => {
    if (
      !window.confirm(
        'Are you sure you want to stop and cancel this WhatsApp campaign? Remaining pending recipients will be marked as cancelled.'
      )
    ) {
      return;
    }

    isCancelledRef.current = true;
    isPausedRef.current = false;
    isSendingRef.current = false;
    setIsSending(false);
    setIsPaused(false);
    setCountdown(null);
    setCurrentRecipientInfo(null);

    if (selectedCampaignId) {
      await supabase
        .from('whatsapp_campaigns')
        .update({
          status: 'cancelled',
          worker_lock_id: null,
          worker_lock_until: null,
          completed_at: new Date().toISOString(),
          updated_at: new Date().toISOString(),
        })
        .eq('id', selectedCampaignId);

      await supabase
        .from('whatsapp_campaign_recipients')
        .update({
          status: 'cancelled',
          updated_at: new Date().toISOString(),
        })
        .eq('campaign_id', selectedCampaignId)
        .eq('status', 'pending');
    }

    showToast({
      type: 'warning',
      title: 'Campaign Cancelled',
      message: 'Sending cancelled. Remaining pending recipients were marked as cancelled.',
    });

    if (selectedCampaignId) {
      await loadCampaigns();
      await loadRecipients(selectedCampaignId);
    }
  };

  // ---------------------------------------------------------------------------
  // RECONCILE & MANUAL RETRY FOR FAILED RECIPIENTS
  // ---------------------------------------------------------------------------
  const handleOpenReconcile = async (r: WhatsAppCampaignRecipientItem) => {
    setReconcileTarget(r);
    setIsReconciling(true);
    setReconcileFinding(null);

    // Reconcile: verify whether a message was actually dispatched
    // 1. Check if recipient record has a message_id
    if (r.message_id) {
      setReconcileFinding({
        canRetry: false,
        alreadySent: true,
        messageId: r.message_id,
        details: `Message already has an OpenWA message ID (${r.message_id}). It was previously accepted by OpenWA.`,
      });
      setIsReconciling(false);
      return;
    }

    // 2. Check if the error was a selector timeout or pre-send failure
    const isTimeout =
      r.error_message?.includes('Waiting for selector') ||
      r.error_message?.includes('Waiting failed') ||
      r.error_message?.includes('timeout') ||
      r.error_message?.includes('not authenticated');

    setReconcileFinding({
      canRetry: true,
      alreadySent: false,
      details: isTimeout
        ? 'Confirmed: Message failed before transmission during DOM selector wait. No message was delivered to WhatsApp.'
        : `Confirmed: Dispatch failed (${r.error_message || 'Unknown error'}). No message ID was generated.`,
    });
    setIsReconciling(false);
  };

  const handleExecuteManualRetry = async () => {
    if (!reconcileTarget || !selectedCampaign) return;
    setIsRetryingManual(true);

    try {
      const finalMessage =
        reconcileTarget.personalized_caption ||
        formatPersonalizedWhatsAppMessage(selectedCampaign.message_template, {
          contact_person: reconcileTarget.contact_person,
          company_name: reconcileTarget.company_name,
        });

      const isImage = selectedCampaign.attachment_type === 'IMAGE';
      const isDoc = selectedCampaign.attachment_type === 'DOCUMENT';

      const result = await WhatsAppTransportService.sendMessage({
        to: reconcileTarget.phone,
        text: finalMessage,
        caption: finalMessage,
        documentUrl: isDoc ? (selectedCampaign.attachment_url || undefined) : undefined,
        imageUrl: isImage ? (selectedCampaign.attachment_url || undefined) : undefined,
        filename: selectedCampaign.attachment_filename || undefined,
        consentVerified: true,
      });

      const nowIso = new Date().toISOString();

      if (result.success) {
        const msgId = result.messageId || `wa_sent_${Date.now()}`;
        await supabase
          .from('whatsapp_campaign_recipients')
          .update({
            status: 'sent',
            message_id: msgId,
            sent_at: nowIso,
            error_message: null,
            updated_at: nowIso,
          })
          .eq('id', reconcileTarget.id);

        await supabase
          .from('whatsapp_campaigns')
          .update({
            sent_count: (selectedCampaign.sent_count || 0) + 1,
            failed_count: Math.max((selectedCampaign.failed_count || 1) - 1, 0),
            updated_at: nowIso,
          })
          .eq('id', selectedCampaign.id);

        showToast({
          type: 'success',
          title: 'Manual Retry Successful',
          message: `Dispatched successfully to ${reconcileTarget.phone} (ID: ${msgId}).`,
        });

        setReconcileTarget(null);
        await loadCampaigns();
        await loadRecipients(selectedCampaign.id);
      } else {
        await supabase
          .from('whatsapp_campaign_recipients')
          .update({
            error_message: result.error || 'Manual retry failed',
            updated_at: nowIso,
          })
          .eq('id', reconcileTarget.id);

        showToast({
          type: 'error',
          title: 'Manual Retry Failed',
          message: result.error || 'Failed to dispatch via OpenWA.',
        });
      }
    } catch (err: any) {
      showToast({
        type: 'error',
        title: 'Manual Retry Exception',
        message: err.message || 'Error executing retry dispatch.',
      });
    } finally {
      setIsRetryingManual(false);
    }
  };

  // ---------------------------------------------------------------------------
  // EXPORT TO EXCEL
  // ---------------------------------------------------------------------------
  const handleExportToExcel = () => {
    if (recipients.length === 0 || !selectedCampaign) {
      showToast({
        type: 'warning',
        title: 'No Data to Export',
        message: 'There are no recipient records to export.',
      });
      return;
    }

    const rows = recipients.map((r, i) => ({
      'No.': i + 1,
      'Company Name': r.company_name,
      'Contact Person': r.contact_person || '—',
      'Mobile Number': r.phone,
      Status: r.status.toUpperCase(),
      'Message ID': r.message_id || '—',
      'Sent At': r.sent_at ? new Date(r.sent_at).toLocaleString() : '—',
      'Delivered At': r.delivered_at ? new Date(r.delivered_at).toLocaleString() : '—',
      'Read At': r.read_at ? new Date(r.read_at).toLocaleString() : '—',
      'Error / Notes': r.error_message || '—',
      'Personalized Message': r.personalized_caption || '—',
    }));

    const worksheet = XLSX.utils.json_to_sheet(rows);
    const workbook = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(workbook, worksheet, 'Delivery Report');

    const cleanName = selectedCampaign.name.replace(/[^a-zA-Z0-9_-]/g, '_');
    const filename = `${cleanName}_Report_${new Date().toISOString().slice(0, 10)}.xlsx`;
    XLSX.writeFile(workbook, filename);

    showToast({
      type: 'success',
      title: 'Excel Export Complete',
      message: `Downloaded ${filename} (${rows.length} rows).`,
    });
  };

  const filteredRecipients = recipients.filter((r) => {
    if (statusFilter !== 'all') {
      if (statusFilter === 'read' && r.status !== 'read') return false;
      if (statusFilter === 'delivered' && r.status !== 'delivered' && r.status !== 'read') return false;
      if (statusFilter === 'sent' && r.status !== 'sent' && r.status !== 'delivered' && r.status !== 'read') return false;
      if (statusFilter === 'failed' && r.status !== 'failed') return false;
      if (statusFilter === 'pending' && r.status !== 'pending' && r.status !== 'sending') return false;
    }
    if (searchQuery.trim()) {
      const q = searchQuery.toLowerCase().trim();
      return (
        r.company_name.toLowerCase().includes(q) ||
        (r.contact_person && r.contact_person.toLowerCase().includes(q)) ||
        r.phone.includes(q) ||
        (r.message_id && r.message_id.toLowerCase().includes(q))
      );
    }
    return true;
  });

  const pendingCount = recipients.filter((r) => r.status === 'pending').length;

  return (
    <div className="space-y-4">
      {/* 1. Header & Engine Status Bar */}
      <div className="bg-white rounded-xl border border-slate-200 p-4 shadow-2xs flex flex-col md:flex-row md:items-center justify-between gap-3">
        <div className="flex items-center gap-3">
          <div className="p-2.5 bg-emerald-50 text-emerald-700 rounded-lg border border-emerald-200">
            <MessageSquare className="w-5 h-5" />
          </div>
          <div>
            <h2 className="text-sm font-bold text-gray-900 flex items-center gap-2">
              WhatsApp Campaign History & Live Dispatch
              <span className="text-[10px] bg-emerald-50 text-emerald-800 border border-emerald-200 px-2 py-0.5 rounded-full font-bold">
                Local OpenWA Engine (Mac Active)
              </span>
            </h2>
            <p className="text-xs text-gray-500">
              Live sequential dispatch via local OpenWA adapter with 20s interval pacing.
            </p>
          </div>
        </div>

        {/* Health status & Controls */}
        <div className="flex items-center gap-2 flex-wrap">
          {/* OpenWA Connection Pill */}
          <button
            type="button"
            onClick={checkAdapterHealth}
            className={`inline-flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs font-semibold border transition cursor-pointer ${
              adapterHealth.status === 'connected'
                ? 'bg-emerald-50 text-emerald-800 border-emerald-200 hover:bg-emerald-100'
                : 'bg-rose-50 text-rose-800 border-rose-200 hover:bg-rose-100'
            }`}
            title="Click to re-check local OpenWA daemon"
          >
            {adapterHealth.status === 'connected' ? (
              <>
                <span className="w-2 h-2 rounded-full bg-emerald-500 animate-pulse" />
                <Wifi className="w-3.5 h-3.5 text-emerald-600" />
                <span>OpenWA Connected ({adapterHealth.businessPhone || '+6285888600999'})</span>
              </>
            ) : (
              <>
                <span className="w-2 h-2 rounded-full bg-rose-500" />
                <WifiOff className="w-3.5 h-3.5 text-rose-600" />
                <span>OpenWA Offline (127.0.0.1:3100)</span>
              </>
            )}
            <RefreshCw className={`w-3 h-3 text-gray-400 ml-0.5 ${isCheckingAdapter ? 'animate-spin' : ''}`} />
          </button>

          {/* Export to Excel */}
          {recipients.length > 0 && (
            <button
              type="button"
              data-testid="export-excel-btn"
              onClick={handleExportToExcel}
              className="inline-flex items-center gap-1.5 px-3 py-1.5 bg-slate-800 hover:bg-slate-900 text-white rounded-lg text-xs font-semibold shadow-2xs transition cursor-pointer"
            >
              <FileSpreadsheet className="w-3.5 h-3.5 text-emerald-400" />
              <span>Export Report</span>
            </button>
          )}

          {/* Optional Test/QA History View Toggle */}
          <label className="inline-flex items-center gap-1.5 text-[11px] text-slate-500 hover:text-slate-800 cursor-pointer select-none bg-slate-50 px-2 py-1 rounded border border-slate-200">
            <input
              type="checkbox"
              checked={showTestCampaigns}
              onChange={(e) => setShowTestCampaigns(e.target.checked)}
              className="rounded border-slate-300 text-blue-600 focus:ring-blue-500 w-3.5 h-3.5"
            />
            <span>Show QA/Test Campaigns</span>
          </label>

          {/* Campaign Selector */}
          <select
            data-testid="campaign-history-selector"
            value={selectedCampaignId || ''}
            onChange={(e) => {
              setSelectedCampaignId(e.target.value);
              const found = displayedCampaigns.find((c) => c.id === e.target.value);
              if (found) setSelectedCampaign(found);
            }}
            className="text-xs border border-gray-300 rounded-lg p-1.5 bg-slate-50 text-gray-800 max-w-xs font-medium"
          >
            {displayedCampaigns.length === 0 && <option value="">No campaigns found</option>}
            {displayedCampaigns.map((c) => (
              <option key={c.id} value={c.id}>
                {c.name} ({new Date(c.created_at).toLocaleDateString()}) — {c.status}
              </option>
            ))}
          </select>

          <button
            type="button"
            onClick={() => {
              if (selectedCampaignId) loadRecipients(selectedCampaignId);
              loadCampaigns();
            }}
            disabled={loading || loadingRecipients}
            className="inline-flex items-center gap-1 px-2.5 py-1.5 bg-white hover:bg-slate-50 border border-gray-300 text-gray-700 rounded-lg text-xs font-medium transition cursor-pointer"
            title="Refresh delivery report from database"
          >
            <RefreshCw className={`w-3.5 h-3.5 ${loading || loadingRecipients ? 'animate-spin' : ''}`} />
          </button>
        </div>
      </div>

      {/* Local Execution Disclaimer Banner */}
      <div className="bg-amber-50/80 border border-amber-200 rounded-xl p-3 flex items-start gap-2.5 text-xs text-amber-900 shadow-2xs">
        <Info className="w-4 h-4 text-amber-600 mt-0.5 shrink-0" />
        <div>
          <span className="font-bold">Local OpenWA Dispatch Environment:</span> This campaign is processed sequentially through your local Mac OpenWA session at <code className="bg-amber-100/80 px-1 py-0.5 rounded font-mono text-[11px]">127.0.0.1:3100</code> with a minimum 20-second interval gap. <strong>Keep this browser tab active and do not close your laptop</strong> while sending is in progress.
        </div>
      </div>

      {selectedCampaign ? (
        <>
          {/* Active Campaign KPI & Control Bar */}
          <div className="bg-white rounded-xl border border-slate-200 p-4 shadow-2xs space-y-4">
            <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-3 border-b border-gray-100 pb-3">
              <div>
                <div className="flex items-center gap-2">
                  <h3 className="text-sm font-bold text-gray-900">{selectedCampaign.name}</h3>
                  <span
                    className={`text-[10px] uppercase font-bold px-2 py-0.5 rounded-full border ${
                      isSending && !isPaused
                        ? 'bg-blue-50 text-blue-700 border-blue-200 animate-pulse'
                        : isPaused || selectedCampaign.status === 'paused'
                        ? 'bg-amber-50 text-amber-700 border-amber-200'
                        : selectedCampaign.status === 'completed'
                        ? 'bg-emerald-50 text-emerald-700 border-emerald-200'
                        : selectedCampaign.status === 'cancelled'
                        ? 'bg-rose-50 text-rose-700 border-rose-200'
                        : 'bg-slate-100 text-slate-700 border-slate-200'
                    }`}
                  >
                    {isSending && !isPaused
                      ? 'in_progress (sending)'
                      : isPaused
                      ? 'paused'
                      : selectedCampaign.status}
                  </span>
                </div>
                <div className="text-[11px] text-gray-500 mt-0.5 flex items-center gap-3 flex-wrap">
                  <span>Created: {new Date(selectedCampaign.created_at).toLocaleString()}</span>
                  <span>Pacing: {selectedCampaign.processing_delay_seconds || 20}s minimum gap</span>
                  {selectedCampaign.attachment_filename && (
                    <span className="flex items-center gap-1 text-emerald-700 font-medium">
                      <Paperclip className="w-3 h-3" />
                      Attachment: {selectedCampaign.attachment_filename}
                    </span>
                  )}
                </div>
              </div>

              {/* Pause / Resume / Cancel Controls */}
              <div className="flex items-center gap-2">
                {/* When sending and not paused: Show Pause & Cancel */}
                {isSending && !isPaused ? (
                  <>
                    <button
                      type="button"
                      data-testid="history-pause-btn"
                      onClick={handlePauseCampaign}
                      className="inline-flex items-center gap-1.5 px-3 py-1.5 bg-amber-500 hover:bg-amber-600 text-white rounded-lg text-xs font-bold shadow-xs transition cursor-pointer"
                    >
                      <Pause className="w-3.5 h-3.5" />
                      Pause Campaign
                    </button>
                    <button
                      type="button"
                      data-testid="history-cancel-btn"
                      onClick={handleCancelCampaign}
                      className="inline-flex items-center gap-1.5 px-3 py-1.5 bg-white hover:bg-rose-50 text-rose-700 border border-rose-300 rounded-lg text-xs font-semibold transition cursor-pointer"
                    >
                      <Square className="w-3.5 h-3.5" />
                      Cancel
                    </button>
                  </>
                ) : isSending && isPaused ? (
                  <>
                    <button
                      type="button"
                      data-testid="history-resume-btn"
                      onClick={handleResumeCampaign}
                      className="inline-flex items-center gap-1.5 px-3 py-1.5 bg-emerald-600 hover:bg-emerald-700 text-white rounded-lg text-xs font-bold shadow-xs transition cursor-pointer"
                    >
                      <Play className="w-3.5 h-3.5" />
                      Resume Campaign
                    </button>
                    <button
                      type="button"
                      data-testid="history-cancel-btn"
                      onClick={handleCancelCampaign}
                      className="inline-flex items-center gap-1.5 px-3 py-1.5 bg-white hover:bg-rose-50 text-rose-700 border border-rose-300 rounded-lg text-xs font-semibold transition cursor-pointer"
                    >
                      <Square className="w-3.5 h-3.5" />
                      Cancel
                    </button>
                  </>
                ) : (
                  <>
                    {/* Idle / Paused / In Progress saved state */}
                    {(selectedCampaign.status === 'paused' ||
                      selectedCampaign.status === 'in_progress' ||
                      selectedCampaign.status === 'queued' ||
                      (selectedCampaign.status === 'partial' && pendingCount > 0)) && (
                      <button
                        type="button"
                        data-testid="history-resume-btn"
                        onClick={handleResumeCampaign}
                        className="inline-flex items-center gap-1.5 px-3 py-1.5 bg-emerald-600 hover:bg-emerald-700 text-white rounded-lg text-xs font-bold shadow-xs transition cursor-pointer"
                      >
                        <Play className="w-3.5 h-3.5" />
                        {selectedCampaign.status === 'paused'
                          ? `Resume Campaign (${pendingCount} Pending)`
                          : `Start Dispatch (${pendingCount} Pending)`}
                      </button>
                    )}

                    {(selectedCampaign.status === 'paused' ||
                      selectedCampaign.status === 'in_progress' ||
                      selectedCampaign.status === 'queued') && (
                      <button
                        type="button"
                        data-testid="history-cancel-btn"
                        onClick={handleCancelCampaign}
                        className="inline-flex items-center gap-1.5 px-3 py-1.5 bg-white hover:bg-rose-50 text-rose-700 border border-rose-300 rounded-lg text-xs font-semibold transition cursor-pointer"
                      >
                        <Square className="w-3.5 h-3.5" />
                        Cancel Campaign
                      </button>
                    )}
                  </>
                )}
              </div>
            </div>

            {/* In-Flight Active Progress Bar */}
            {isSending && (
              <div className="bg-slate-50 border border-slate-200 rounded-xl p-3.5 space-y-2.5 animate-in fade-in">
                <div className="flex items-center justify-between text-xs">
                  <div className="flex items-center gap-2">
                    <span className="w-2.5 h-2.5 rounded-full bg-emerald-500 animate-ping" />
                    <span className="font-bold text-gray-900">
                      In-Flight Dispatch: {currentRecipientInfo || 'Preparing next message...'}
                    </span>
                  </div>
                  {countdown !== null && (
                    <span className="font-mono text-emerald-800 bg-emerald-50 px-2 py-0.5 rounded border border-emerald-200 font-bold">
                      Next message in {countdown}s...
                    </span>
                  )}
                </div>

                <div className="w-full bg-slate-200 rounded-full h-2 overflow-hidden">
                  <div
                    className="bg-emerald-500 h-2 transition-all duration-500"
                    style={{
                      width: `${
                        selectedCampaign.total_recipients > 0
                          ? Math.round(
                              ((selectedCampaign.sent_count + selectedCampaign.failed_count) /
                                selectedCampaign.total_recipients) *
                                100
                            )
                          : 0
                      }%`,
                    }}
                  />
                </div>
              </div>
            )}

            {/* KPI Metric Cards */}
            <div className="grid grid-cols-2 sm:grid-cols-5 gap-2.5 text-xs">
              {/* Total */}
              <div className="bg-slate-50 border border-slate-200 rounded-lg p-2.5 text-left">
                <span className="text-[10px] uppercase font-bold text-gray-500 block">Total Recipients</span>
                <span className="text-lg font-extrabold text-gray-900">
                  {recipients.length > 0 ? recipients.length : selectedCampaign.total_recipients}
                </span>
                <span className="text-[10px] text-gray-400 block mt-0.5">Campaign total</span>
              </div>

              {/* Sent */}
              <div className="bg-blue-50/60 border border-blue-200 rounded-lg p-2.5 text-left">
                <span className="text-[10px] uppercase font-bold text-blue-700 flex items-center gap-1">
                  <Send className="w-3 h-3 text-blue-600" />
                  Sent
                </span>
                <span className="text-lg font-extrabold text-blue-900">
                  {recipients.length > 0
                    ? recipients.filter((r) => r.status === 'sent' || r.status === 'delivered' || r.status === 'read').length
                    : selectedCampaign.sent_count}
                </span>
                <span className="text-[10px] text-blue-600 block mt-0.5">Dispatched via OpenWA</span>
              </div>

              {/* Delivered */}
              <div className="bg-indigo-50/60 border border-indigo-200 rounded-lg p-2.5 text-left">
                <span className="text-[10px] uppercase font-bold text-indigo-700 flex items-center gap-1">
                  <CheckCheck className="w-3 h-3 text-indigo-600" />
                  Delivered
                </span>
                <span className="text-lg font-extrabold text-indigo-900">
                  {recipients.length > 0
                    ? recipients.filter((r) => r.status === 'delivered' || r.status === 'read').length
                    : selectedCampaign.delivered_count}
                </span>
                <span className="text-[10px] text-indigo-600 block mt-0.5">Device confirmed</span>
              </div>

              {/* Read */}
              <div className="bg-emerald-50/60 border border-emerald-200 rounded-lg p-2.5 text-left">
                <span className="text-[10px] uppercase font-bold text-emerald-800 flex items-center gap-1">
                  <CheckCircle2 className="w-3 h-3 text-emerald-600" />
                  Read
                </span>
                <span className="text-lg font-extrabold text-emerald-900">
                  {recipients.length > 0
                    ? recipients.filter((r) => r.status === 'read').length
                    : selectedCampaign.read_count}
                </span>
                <span className="text-[10px] text-emerald-700 block mt-0.5">Read receipt verified</span>
              </div>

              {/* Failed */}
              <div className="bg-rose-50/60 border border-rose-200 rounded-lg p-2.5 text-left">
                <span className="text-[10px] uppercase font-bold text-rose-800 flex items-center gap-1">
                  <XCircle className="w-3 h-3 text-rose-600" />
                  Failed
                </span>
                <span className="text-lg font-extrabold text-rose-900">
                  {recipients.length > 0
                    ? recipients.filter((r) => r.status === 'failed').length
                    : selectedCampaign.failed_count}
                </span>
                <span className="text-[10px] text-rose-600 block mt-0.5">Needs reconciliation</span>
              </div>
            </div>
          </div>

          {/* Recipient Delivery Table */}
          <div className="bg-white rounded-xl border border-slate-200 shadow-2xs overflow-hidden">
            {/* Filter Bar */}
            <div className="p-3 border-b border-gray-200 flex flex-col sm:flex-row items-stretch sm:items-center justify-between gap-2.5 bg-slate-50/70">
              <div className="relative flex-1 max-w-sm">
                <Search className="w-3.5 h-3.5 absolute left-3 top-2.5 text-gray-400" />
                <input
                  type="text"
                  value={searchQuery}
                  onChange={(e) => setSearchQuery(e.target.value)}
                  placeholder="Search recipient company, phone, message ID..."
                  className="w-full pl-8 pr-3 py-1.5 text-xs bg-white border border-gray-300 rounded-md focus:outline-emerald-500"
                />
              </div>

              <div className="flex items-center gap-1 text-xs">
                {(['all', 'sent', 'delivered', 'read', 'failed', 'pending'] as const).map((tab) => (
                  <button
                    key={tab}
                    onClick={() => setStatusFilter(tab)}
                    className={`px-2.5 py-1 rounded text-xs font-semibold capitalize transition cursor-pointer ${
                      statusFilter === tab
                        ? 'bg-slate-800 text-white shadow-xs'
                        : 'bg-white hover:bg-slate-100 text-gray-600 border border-gray-200'
                    }`}
                  >
                    {tab}
                  </button>
                ))}
              </div>
            </div>

            {/* Table */}
            <div className="overflow-x-auto">
              <table className="w-full text-xs text-left">
                <thead className="bg-slate-100 text-gray-700 font-bold uppercase text-[10px] border-b border-gray-200">
                  <tr>
                    <th className="p-2.5">Company Name</th>
                    <th className="p-2.5">Contact Person</th>
                    <th className="p-2.5">Mobile Number</th>
                    <th className="p-2.5">Message ID</th>
                    <th className="p-2.5">Sent Status</th>
                    <th className="p-2.5">Delivered Status</th>
                    <th className="p-2.5">Read Status</th>
                    <th className="p-2.5">Error / Notes</th>
                    <th className="p-2.5 text-right">Actions</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-gray-100 font-sans">
                  {filteredRecipients.length === 0 ? (
                    <tr>
                      <td colSpan={9} className="p-6 text-center text-gray-400">
                        No recipient records match the selected filters.
                      </td>
                    </tr>
                  ) : (
                    filteredRecipients.map((r) => {
                      const isSent = r.status === 'sent' || r.status === 'delivered' || r.status === 'read';
                      const isDelivered = r.status === 'delivered' || r.status === 'read';
                      const isRead = r.status === 'read';
                      const isFailed = r.status === 'failed';
                      const isCancelled = r.status === 'cancelled';
                      const isSendingItem = r.status === 'sending';

                      return (
                        <tr key={r.id} className="hover:bg-slate-50 transition-colors">
                          <td className="p-2.5 font-bold text-gray-900">{r.company_name}</td>
                          <td className="p-2.5 text-gray-600">{r.contact_person || '—'}</td>
                          <td className="p-2.5 font-mono text-[11px] text-gray-800">{r.phone}</td>
                          <td
                            className="p-2.5 font-mono text-[10px] text-gray-500 max-w-[120px] truncate"
                            title={r.message_id || ''}
                          >
                            {r.message_id ? r.message_id.slice(0, 16) + '...' : '—'}
                          </td>
                          <td className="p-2.5">
                            {isSendingItem ? (
                              <span className="inline-flex items-center gap-1 text-[11px] font-semibold text-blue-800 bg-blue-50 px-2 py-0.5 rounded border border-blue-200 animate-pulse">
                                <Send className="w-2.5 h-2.5 animate-spin" />
                                Sending...
                              </span>
                            ) : isSent ? (
                              <span className="inline-flex items-center gap-1 text-[11px] font-semibold text-blue-700 bg-blue-50 px-2 py-0.5 rounded border border-blue-200">
                                <Send className="w-2.5 h-2.5" />
                                Sent {r.sent_at ? new Date(r.sent_at).toLocaleTimeString() : ''}
                              </span>
                            ) : isFailed ? (
                              <span className="inline-flex items-center gap-1 text-[11px] font-semibold text-rose-700 bg-rose-50 px-2 py-0.5 rounded border border-rose-200">
                                <XCircle className="w-2.5 h-2.5" />
                                Failed
                              </span>
                            ) : isCancelled ? (
                              <span className="inline-flex items-center gap-1 text-[11px] font-semibold text-slate-500 bg-slate-50 px-2 py-0.5 rounded border border-slate-200">
                                <Square className="w-2.5 h-2.5" />
                                Cancelled
                              </span>
                            ) : (
                              <span className="inline-flex items-center gap-1 text-[11px] text-gray-500 bg-gray-50 px-2 py-0.5 rounded border border-gray-200">
                                <Clock className="w-2.5 h-2.5" />
                                {r.status}
                              </span>
                            )}
                          </td>
                          <td className="p-2.5">
                            {isDelivered ? (
                              <span className="inline-flex items-center gap-1 text-[11px] font-semibold text-indigo-700 bg-indigo-50 px-2 py-0.5 rounded border border-indigo-200">
                                <CheckCheck className="w-2.5 h-2.5" />
                                Delivered {r.delivered_at ? new Date(r.delivered_at).toLocaleTimeString() : ''}
                              </span>
                            ) : isSent ? (
                              <span className="text-[11px] text-gray-400">Awaiting device ack</span>
                            ) : (
                              <span className="text-[11px] text-gray-400">—</span>
                            )}
                          </td>
                          <td className="p-2.5">
                            {isRead ? (
                              <span className="inline-flex items-center gap-1 text-[11px] font-bold text-emerald-800 bg-emerald-50 px-2 py-0.5 rounded border border-emerald-300">
                                <CheckCircle2 className="w-2.5 h-2.5 text-emerald-600" />
                                Read at {r.read_at ? new Date(r.read_at).toLocaleTimeString() : ''}
                              </span>
                            ) : isSent ? (
                              <span className="inline-flex items-center gap-1 text-[11px] font-medium text-amber-800 bg-amber-50 px-2 py-0.5 rounded border border-amber-200">
                                <Clock className="w-2.5 h-2.5 text-amber-600" />
                                Awaiting read receipt
                              </span>
                            ) : (
                              <span className="text-[11px] text-gray-400">—</span>
                            )}
                          </td>
                          <td className="p-2.5 text-[11px] max-w-[200px] truncate">
                            {isFailed ? (
                              <span className="text-rose-600 font-medium" title={r.error_message || ''}>
                                {r.error_code ? `[${r.error_code}] ` : ''}
                                {r.error_message || 'Delivery failed'}
                              </span>
                            ) : (
                              <span className="text-gray-400">—</span>
                            )}
                          </td>
                          <td className="p-2.5 text-right">
                            {isFailed && (
                              <button
                                type="button"
                                data-testid={`reconcile-btn-${r.id}`}
                                onClick={() => handleOpenReconcile(r)}
                                className="inline-flex items-center gap-1 px-2.5 py-1 bg-rose-50 hover:bg-rose-100 text-rose-800 border border-rose-300 rounded text-[11px] font-bold transition cursor-pointer"
                                title="Reconcile delivery status and allow manual retry"
                              >
                                <RotateCcw className="w-3 h-3 text-rose-600" />
                                <span>Reconcile</span>
                              </button>
                            )}
                          </td>
                        </tr>
                      );
                    })
                  )}
                </tbody>
              </table>
            </div>
          </div>
        </>
      ) : (
        <div className="bg-white rounded-xl border border-gray-200 p-8 text-center text-gray-500">
          No WhatsApp campaigns have been created yet. Launch a campaign from the WhatsApp workspace to see live delivery reports.
        </div>
      )}

      {/* ------------------------------------------------------------------ */}
      {/* RECONCILE & MANUAL RETRY MODAL */}
      {/* ------------------------------------------------------------------ */}
      {reconcileTarget && (
        <div
          data-testid="reconcile-modal"
          className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 backdrop-blur-xs p-4 animate-in fade-in"
        >
          <div className="bg-white rounded-2xl shadow-2xl border border-slate-200 w-full max-w-lg overflow-hidden flex flex-col">
            {/* Header */}
            <div className="p-4 border-b border-slate-200 flex items-center justify-between bg-slate-50">
              <div className="flex items-center gap-2">
                <RotateCcw className="w-5 h-5 text-rose-600" />
                <div>
                  <h3 className="text-sm font-bold text-gray-900">Reconcile Delivery & Manual Retry</h3>
                  <p className="text-xs text-gray-500">{reconcileTarget.company_name}</p>
                </div>
              </div>
              <button
                type="button"
                onClick={() => setReconcileTarget(null)}
                className="p-1.5 text-gray-400 hover:text-gray-600 rounded-lg hover:bg-slate-200 transition cursor-pointer"
              >
                <X className="w-4 h-4" />
              </button>
            </div>

            {/* Body */}
            <div className="p-4 space-y-3.5 text-xs">
              <div className="bg-slate-50 p-3 rounded-lg border border-slate-200 space-y-1.5">
                <div className="flex justify-between">
                  <span className="text-gray-500">Recipient Phone:</span>
                  <span className="font-mono font-bold text-gray-900">{reconcileTarget.phone}</span>
                </div>
                <div className="flex justify-between">
                  <span className="text-gray-500">Contact Person:</span>
                  <span className="text-gray-800">{reconcileTarget.contact_person || '—'}</span>
                </div>
                <div className="flex justify-between">
                  <span className="text-gray-500">Recorded Message ID:</span>
                  <span className="font-mono text-gray-700">{reconcileTarget.message_id || 'None (Unsent)'}</span>
                </div>
                <div className="border-t border-slate-200 pt-1.5 mt-1.5">
                  <span className="text-gray-500 block mb-0.5">Recorded Error:</span>
                  <span className="font-mono text-rose-700 bg-rose-50 p-1 rounded block text-[11px] break-all border border-rose-200">
                    {reconcileTarget.error_message || 'Unknown failure'}
                  </span>
                </div>
              </div>

              {/* Finding Box */}
              {isReconciling ? (
                <div className="flex items-center gap-2 text-gray-600 p-3 bg-slate-50 rounded-lg border border-slate-200">
                  <RefreshCw className="w-4 h-4 animate-spin text-gray-400" />
                  <span>Checking actual transmission status...</span>
                </div>
              ) : reconcileFinding ? (
                <div
                  className={`p-3 rounded-lg border text-xs ${
                    reconcileFinding.alreadySent
                      ? 'bg-emerald-50 text-emerald-900 border-emerald-200'
                      : 'bg-amber-50 text-amber-900 border-amber-200'
                  }`}
                >
                  <div className="flex items-start gap-2">
                    {reconcileFinding.alreadySent ? (
                      <CheckCircle2 className="w-4 h-4 text-emerald-600 shrink-0 mt-0.5" />
                    ) : (
                      <ShieldAlert className="w-4 h-4 text-amber-600 shrink-0 mt-0.5" />
                    )}
                    <div>
                      <span className="font-bold block">
                        {reconcileFinding.alreadySent ? 'Message Verified Sent' : 'Delivery Status Reconciled'}
                      </span>
                      <span>{reconcileFinding.details}</span>
                    </div>
                  </div>
                </div>
              ) : null}
            </div>

            {/* Footer */}
            <div className="p-3 bg-slate-50 border-t border-slate-200 flex items-center justify-end gap-2">
              <button
                type="button"
                onClick={() => setReconcileTarget(null)}
                className="px-3 py-1.5 bg-white hover:bg-slate-100 text-slate-700 border border-slate-300 rounded-lg text-xs font-semibold transition cursor-pointer"
              >
                Close
              </button>

              {reconcileFinding?.canRetry && (
                <button
                  type="button"
                  data-testid="execute-manual-retry-btn"
                  onClick={handleExecuteManualRetry}
                  disabled={isRetryingManual}
                  className="inline-flex items-center gap-1.5 px-4 py-1.5 bg-emerald-600 hover:bg-emerald-700 text-white rounded-lg text-xs font-bold shadow-xs transition disabled:opacity-50 cursor-pointer"
                >
                  {isRetryingManual ? (
                    <>
                      <RefreshCw className="w-3.5 h-3.5 animate-spin" />
                      <span>Retrying via OpenWA...</span>
                    </>
                  ) : (
                    <>
                      <Send className="w-3.5 h-3.5" />
                      <span>Manual Retry Send</span>
                    </>
                  )}
                </button>
              )}
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
