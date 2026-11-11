import React, { useEffect, useState, useCallback, useRef } from 'react';
import { supabase } from '../../../lib/supabase';
import { showToast } from '../../ToastNotification';
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
  Eye,
  Paperclip,
  CheckCheck,
  Send,
  XCircle,
  ExternalLink,
  ChevronRight,
  Filter,
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

export function WhatsAppCampaignDeliveryReport({ initialCampaignId }: Props) {
  const [campaigns, setCampaigns] = useState<WhatsAppCampaignItem[]>([]);
  const [selectedCampaignId, setSelectedCampaignId] = useState<string | null>(initialCampaignId || null);
  const [selectedCampaign, setSelectedCampaign] = useState<WhatsAppCampaignItem | null>(null);
  const [recipients, setRecipients] = useState<WhatsAppCampaignRecipientItem[]>([]);
  const [loading, setLoading] = useState(false);
  const [loadingRecipients, setLoadingRecipients] = useState(false);
  const [actionLoading, setActionLoading] = useState(false);
  const [searchQuery, setSearchQuery] = useState('');
  const [statusFilter, setStatusFilter] = useState<'all' | 'sent' | 'delivered' | 'read' | 'failed' | 'pending'>('all');

  // Load campaigns list
  const loadCampaigns = useCallback(async () => {
    setLoading(true);
    try {
      const { data, error } = await supabase
        .from('whatsapp_campaigns')
        .select('*')
        .order('created_at', { ascending: false })
        .limit(30);

      if (error) throw error;
      setCampaigns(data || []);

      if (data && data.length > 0) {
        if (!selectedCampaignId) {
          setSelectedCampaignId(data[0].id);
          setSelectedCampaign(data[0]);
        } else {
          const found = data.find(c => c.id === selectedCampaignId);
          if (found) setSelectedCampaign(found);
        }
      }
    } catch (err: any) {
      console.error('Failed to load WhatsApp campaigns:', err);
    } finally {
      setLoading(false);
    }
  }, [selectedCampaignId]);

  // Load recipients for selected campaign
  const loadRecipients = useCallback(async (campaignId: string) => {
    setLoadingRecipients(true);
    try {
      // First refresh counts via RPC
      await supabase.rpc('refresh_whatsapp_campaign_counts', { p_campaign_id: campaignId });

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

  // Auto-refresh when campaign is in_progress
  useEffect(() => {
    if (!selectedCampaign || selectedCampaign.status !== 'in_progress') return;

    const interval = setInterval(() => {
      if (selectedCampaignId) {
        loadRecipients(selectedCampaignId);
      }
    }, 5000);

    return () => clearInterval(interval);
  }, [selectedCampaign, selectedCampaignId, loadRecipients]);

  // Campaign control actions (pause, resume, cancel)
  const handleControlAction = async (action: 'pause' | 'resume' | 'cancel') => {
    if (!selectedCampaignId) return;
    setActionLoading(true);
    try {
      const { error } = await supabase.functions.invoke('process-whatsapp-campaign', {
        body: {
          campaignId: selectedCampaignId,
          action,
        },
      });

      if (error) throw error;

      showToast({
        type: 'success',
        title: `Campaign ${action === 'pause' ? 'Paused' : action === 'resume' ? 'Resumed' : 'Cancelled'}`,
        message: `Command sent to server worker.`,
      });

      await loadRecipients(selectedCampaignId);
      await loadCampaigns();
    } catch (err: any) {
      showToast({
        type: 'error',
        title: 'Action Failed',
        message: err.message || 'Could not update campaign status',
      });
    } finally {
      setActionLoading(false);
    }
  };

  const filteredRecipients = recipients.filter(r => {
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

  return (
    <div className="space-y-4">
      {/* Header & Campaign Selector */}
      <div className="bg-white rounded-xl border border-slate-200 p-4 shadow-2xs flex flex-col md:flex-row md:items-center justify-between gap-3">
        <div className="flex items-center gap-3">
          <div className="p-2.5 bg-emerald-50 text-emerald-700 rounded-lg border border-emerald-200">
            <MessageSquare className="w-5 h-5" />
          </div>
          <div>
            <h2 className="text-sm font-bold text-gray-900 flex items-center gap-2">
              WhatsApp Campaign Live Delivery Report
              <span className="text-[10px] bg-slate-100 text-slate-700 px-2 py-0.5 rounded-full font-mono font-medium">
                Server-Side Always-On Queue
              </span>
            </h2>
            <p className="text-xs text-gray-500">
              Live recipient delivery confirmation with official Meta WhatsApp Cloud API webhooks.
            </p>
          </div>
        </div>

        <div className="flex items-center gap-2">
          <select
            value={selectedCampaignId || ''}
            onChange={e => {
              setSelectedCampaignId(e.target.value);
              const found = campaigns.find(c => c.id === e.target.value);
              if (found) setSelectedCampaign(found);
            }}
            className="text-xs border border-gray-300 rounded-md p-1.5 bg-slate-50 text-gray-800 max-w-xs font-medium"
          >
            {campaigns.length === 0 && <option value="">No campaigns found</option>}
            {campaigns.map(c => (
              <option key={c.id} value={c.id}>
                {c.name} ({new Date(c.created_at).toLocaleDateString()}) - {c.status}
              </option>
            ))}
          </select>

          <button
            onClick={() => {
              if (selectedCampaignId) loadRecipients(selectedCampaignId);
              loadCampaigns();
            }}
            disabled={loading || loadingRecipients}
            className="inline-flex items-center gap-1 px-2.5 py-1.5 bg-white hover:bg-slate-50 border border-gray-300 text-gray-700 rounded-md text-xs font-medium transition cursor-pointer"
            title="Refresh delivery report from database"
          >
            <RefreshCw className={`w-3.5 h-3.5 ${loading || loadingRecipients ? 'animate-spin' : ''}`} />
            Refresh Status
          </button>
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
                      selectedCampaign.status === 'in_progress'
                        ? 'bg-blue-50 text-blue-700 border-blue-200 animate-pulse'
                        : selectedCampaign.status === 'completed'
                        ? 'bg-emerald-50 text-emerald-700 border-emerald-200'
                        : selectedCampaign.status === 'paused'
                        ? 'bg-amber-50 text-amber-700 border-amber-200'
                        : selectedCampaign.status === 'cancelled'
                        ? 'bg-rose-50 text-rose-700 border-rose-200'
                        : 'bg-slate-100 text-slate-700 border-slate-200'
                    }`}
                  >
                    {selectedCampaign.status}
                  </span>
                </div>
                <div className="text-[11px] text-gray-500 mt-0.5 flex items-center gap-3">
                  <span>Started: {new Date(selectedCampaign.created_at).toLocaleString()}</span>
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
                {selectedCampaign.status === 'in_progress' && (
                  <button
                    onClick={() => handleControlAction('pause')}
                    disabled={actionLoading}
                    className="inline-flex items-center gap-1 px-3 py-1.5 bg-amber-50 hover:bg-amber-100 text-amber-800 border border-amber-300 rounded text-xs font-bold transition cursor-pointer"
                  >
                    <Pause className="w-3.5 h-3.5" />
                    Pause Campaign
                  </button>
                )}

                {selectedCampaign.status === 'paused' && (
                  <button
                    onClick={() => handleControlAction('resume')}
                    disabled={actionLoading}
                    className="inline-flex items-center gap-1 px-3 py-1.5 bg-emerald-600 hover:bg-emerald-700 text-white rounded text-xs font-bold shadow-xs transition cursor-pointer"
                  >
                    <Play className="w-3.5 h-3.5" />
                    Resume Campaign
                  </button>
                )}

                {(selectedCampaign.status === 'in_progress' || selectedCampaign.status === 'paused') && (
                  <button
                    onClick={() => handleControlAction('cancel')}
                    disabled={actionLoading}
                    className="inline-flex items-center gap-1 px-3 py-1.5 bg-white hover:bg-rose-50 text-rose-700 border border-rose-300 rounded text-xs font-semibold transition cursor-pointer"
                  >
                    <Square className="w-3.5 h-3.5" />
                    Cancel Campaign
                  </button>
                )}
              </div>
            </div>

            {/* KPI Metric Cards */}
            <div className="grid grid-cols-2 sm:grid-cols-5 gap-2.5 text-xs">
              {/* Total */}
              <div className="bg-slate-50 border border-slate-200 rounded-lg p-2.5 text-left">
                <span className="text-[10px] uppercase font-bold text-gray-500 block">Total Recipients</span>
                <span className="text-lg font-extrabold text-gray-900">{selectedCampaign.total_recipients}</span>
                <span className="text-[10px] text-gray-400 block mt-0.5">Queued on server</span>
              </div>

              {/* Sent */}
              <div className="bg-blue-50/60 border border-blue-200 rounded-lg p-2.5 text-left">
                <span className="text-[10px] uppercase font-bold text-blue-700 flex items-center gap-1">
                  <Send className="w-3 h-3 text-blue-600" />
                  Sent
                </span>
                <span className="text-lg font-extrabold text-blue-900">{selectedCampaign.sent_count}</span>
                <span className="text-[10px] text-blue-600 block mt-0.5">Dispatched to Meta</span>
              </div>

              {/* Delivered */}
              <div className="bg-indigo-50/60 border border-indigo-200 rounded-lg p-2.5 text-left">
                <span className="text-[10px] uppercase font-bold text-indigo-700 flex items-center gap-1">
                  <CheckCheck className="w-3 h-3 text-indigo-600" />
                  Delivered
                </span>
                <span className="text-lg font-extrabold text-indigo-900">{selectedCampaign.delivered_count}</span>
                <span className="text-[10px] text-indigo-600 block mt-0.5">Device confirmed</span>
              </div>

              {/* Read */}
              <div className="bg-emerald-50/60 border border-emerald-200 rounded-lg p-2.5 text-left">
                <span className="text-[10px] uppercase font-bold text-emerald-800 flex items-center gap-1">
                  <CheckCircle2 className="w-3 h-3 text-emerald-600" />
                  Read
                </span>
                <span className="text-lg font-extrabold text-emerald-900">{selectedCampaign.read_count}</span>
                <span className="text-[10px] text-emerald-700 block mt-0.5">Read receipt verified</span>
              </div>

              {/* Failed */}
              <div className="bg-rose-50/60 border border-rose-200 rounded-lg p-2.5 text-left">
                <span className="text-[10px] uppercase font-bold text-rose-800 flex items-center gap-1">
                  <XCircle className="w-3 h-3 text-rose-600" />
                  Failed
                </span>
                <span className="text-lg font-extrabold text-rose-900">{selectedCampaign.failed_count}</span>
                <span className="text-[10px] text-rose-600 block mt-0.5">Undeliverable / Rejected</span>
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
                  onChange={e => setSearchQuery(e.target.value)}
                  placeholder="Search recipient company, phone, message ID..."
                  className="w-full pl-8 pr-3 py-1.5 text-xs bg-white border border-gray-300 rounded-md focus:outline-blue-500"
                />
              </div>

              <div className="flex items-center gap-1 text-xs">
                {(['all', 'sent', 'delivered', 'read', 'failed', 'pending'] as const).map(tab => (
                  <button
                    key={tab}
                    onClick={() => setStatusFilter(tab)}
                    className={`px-2.5 py-1 rounded text-xs font-semibold capitalize transition ${
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
                  </tr>
                </thead>
                <tbody className="divide-y divide-gray-100 font-sans">
                  {filteredRecipients.length === 0 ? (
                    <tr>
                      <td colSpan={8} className="p-6 text-center text-gray-400">
                        No recipient records match the selected filters.
                      </td>
                    </tr>
                  ) : (
                    filteredRecipients.map(r => {
                      const isSent = r.status === 'sent' || r.status === 'delivered' || r.status === 'read';
                      const isDelivered = r.status === 'delivered' || r.status === 'read';
                      const isRead = r.status === 'read';
                      const isFailed = r.status === 'failed';

                      return (
                        <tr key={r.id} className="hover:bg-slate-50 transition-colors">
                          <td className="p-2.5 font-bold text-gray-900">{r.company_name}</td>
                          <td className="p-2.5 text-gray-600">{r.contact_person || '—'}</td>
                          <td className="p-2.5 font-mono text-[11px] text-gray-800">{r.phone}</td>
                          <td className="p-2.5 font-mono text-[10px] text-gray-500 max-w-[120px] truncate" title={r.message_id || ''}>
                            {r.message_id ? r.message_id.slice(0, 16) + '...' : '—'}
                          </td>
                          <td className="p-2.5">
                            {isSent ? (
                              <span className="inline-flex items-center gap-1 text-[11px] font-semibold text-blue-700 bg-blue-50 px-2 py-0.5 rounded border border-blue-200">
                                <Send className="w-2.5 h-2.5" />
                                Sent {r.sent_at ? new Date(r.sent_at).toLocaleTimeString() : ''}
                              </span>
                            ) : isFailed ? (
                              <span className="inline-flex items-center gap-1 text-[11px] font-semibold text-rose-700 bg-rose-50 px-2 py-0.5 rounded border border-rose-200">
                                <XCircle className="w-2.5 h-2.5" />
                                Failed
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
                          <td className="p-2.5 text-[11px]">
                            {isFailed ? (
                              <span className="text-rose-600 font-medium" title={r.error_message || ''}>
                                {r.error_code ? `[${r.error_code}] ` : ''}
                                {r.error_message || 'Delivery failed'}
                              </span>
                            ) : (
                              <span className="text-gray-400">—</span>
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
    </div>
  );
}

