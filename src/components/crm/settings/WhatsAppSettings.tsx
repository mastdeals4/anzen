import React, { useState, useEffect, useCallback } from 'react';
import {
  MessageSquare,
  QrCode,
  CheckCircle2,
  AlertTriangle,
  XCircle,
  RefreshCw,
  Unplug,
  Send,
  Smartphone,
  Info,
  ExternalLink,
  Maximize2,
  X,
  Radio,
} from 'lucide-react';
import {
  EnquiryWhatsAppService,
  WhatsAppConnectionStatusResult,
} from '../../../services/enquiry/EnquiryWhatsAppService';
import { supabase } from '../../../lib/supabase';

export function WhatsAppSettings() {
  const [loading, setLoading] = useState<boolean>(true);
  const [actionLoading, setActionLoading] = useState<string | null>(null);
  const [status, setStatus] = useState<WhatsAppConnectionStatusResult | null>(null);
  const [phoneInput, setPhoneInput] = useState<string>('');
  const [isEnlarged, setIsEnlarged] = useState<boolean>(false);
  const [webhookHealth, setWebhookHealth] = useState<{
    status: 'healthy' | 'error' | 'pending';
    lastChecked?: string;
    details?: string;
  }>({ status: 'pending' });
  const [lastInboundTime, setLastInboundTime] = useState<string | null>(null);
  const [notification, setNotification] = useState<{
    type: 'success' | 'error';
    message: string;
  } | null>(null);

  const fetchStatus = useCallback(async () => {
    try {
      const res = await EnquiryWhatsAppService.getConnectionStatus();
      setStatus(res);
      if (res.businessPhone) {
        setPhoneInput(res.businessPhone);
      }

      // Check last inbound message from database
      const { data: latestMsg } = await supabase
        .from('enquiry_conversation_messages')
        .select('created_at')
        .eq('channel', 'whatsapp')
        .eq('direction', 'inbound')
        .order('created_at', { ascending: false })
        .limit(1)
        .maybeSingle();

      if (latestMsg?.created_at) {
        setLastInboundTime(latestMsg.created_at);
        setWebhookHealth((prev) => (prev.status === 'pending' ? { status: 'healthy', details: 'Ingress confirmed active' } : prev));
      }
    } catch (e: any) {
      setStatus({
        provider: 'meta_cloud',
        status: 'error',
        session: 'sapj-business-whatsapp',
        error: e.message || 'Failed to fetch status',
      });
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    fetchStatus();
    // Fast 3s polling when waiting for QR scan, 15s otherwise
    const pollInterval = status?.status === 'unpaired' ? 3000 : 15000;
    const interval = setInterval(fetchStatus, pollInterval);
    return () => clearInterval(interval);
  }, [fetchStatus, status?.status]);

  const handleConnect = async () => {
    setActionLoading('connect');
    setNotification(null);
    try {
      const res = await EnquiryWhatsAppService.connectSession();
      setStatus(res);
      setNotification({
        type: 'success',
        message: 'WhatsApp session initialized. Scan QR code to complete pairing.',
      });
    } catch (e: any) {
      setNotification({ type: 'error', message: e.message || 'Failed to initialize session' });
    } finally {
      setActionLoading(null);
    }
  };

  const handleDisconnect = async () => {
    if (!confirm('Are you sure you want to disconnect the SAPJ Business WhatsApp session?')) {
      return;
    }
    setActionLoading('disconnect');
    setNotification(null);
    try {
      const res = await EnquiryWhatsAppService.disconnectSession();
      setStatus(res);
      setNotification({ type: 'success', message: 'WhatsApp Business session disconnected.' });
    } catch (e: any) {
      setNotification({ type: 'error', message: e.message || 'Failed to disconnect session' });
    } finally {
      setActionLoading(null);
    }
  };

  const handleRefreshQr = async () => {
    setActionLoading('refresh-qr');
    setNotification(null);
    try {
      const res = await EnquiryWhatsAppService.refreshQr();
      setStatus(res);
      setNotification({ type: 'success', message: 'QR Code refreshed.' });
    } catch (e: any) {
      setNotification({ type: 'error', message: e.message || 'Failed to refresh QR code' });
    } finally {
      setActionLoading(null);
    }
  };

  const handlePair = async () => {
    setActionLoading('pair');
    setNotification(null);
    try {
      const res = await EnquiryWhatsAppService.pairSession(phoneInput);
      setStatus(res);
      setNotification({
        type: 'success',
        message: `WhatsApp Business session successfully connected (${phoneInput})!`,
      });
    } catch (e: any) {
      setNotification({ type: 'error', message: e.message || 'Failed to pair session' });
    } finally {
      setActionLoading(null);
    }
  };

  const handleTestInbound = async () => {
    setActionLoading('test-inbound');
    setNotification(null);
    try {
      const testPhone = '+628123456789';
      const testMsgId = `test_inbound_${Date.now()}`;
      const nowIso = new Date().toISOString();
      const res = await EnquiryWhatsAppService.injectTestInbound({
        messageId: testMsgId,
        chatId: `${testPhone.replace(/\D/g, '')}@c.us`,
        senderPhone: testPhone,
        senderName: 'PT Diagnostic Test Client',
        businessPhone: status?.businessPhone || undefined,
        text: `[DIAGNOSTIC TEST] Integration verification from CRM Settings (${new Date().toLocaleTimeString()}). Testing webhook ingress & message routing.`,
        receivedAt: nowIso,
        rawPayload: { is_test: true, diagnostic_source: 'CRM Settings' },
      });

      if (res.success) {
        setWebhookHealth({
          status: 'healthy',
          lastChecked: nowIso,
          details: 'Ingress authentication verified & test message routed successfully (200 OK)',
        });
        setLastInboundTime(nowIso);
        setNotification({
          type: 'success',
          message: 'Diagnostic test inbound message authenticated and mirrored to CRM Inbox successfully!',
        });
      } else {
        setWebhookHealth({
          status: 'error',
          lastChecked: nowIso,
          details: res.error || 'Webhook ingress returned an error',
        });
        setNotification({
          type: 'error',
          message: `Webhook authentication failed: ${res.error || 'Unauthorized caller'}`,
        });
      }
    } catch (e: any) {
      setWebhookHealth({
        status: 'error',
        lastChecked: new Date().toISOString(),
        details: e.message || 'Network exception',
      });
      setNotification({
        type: 'error',
        message: `Failed to trigger test inbound message: ${e.message}`,
      });
    } finally {
      setActionLoading(null);
    }
  };

  const getStatusBadge = () => {
    if (loading) {
      return (
        <span className="text-xs px-2.5 py-1 rounded-full bg-slate-100 text-slate-600 font-semibold border border-slate-200 flex items-center gap-1.5">
          <RefreshCw className="w-3 h-3 animate-spin" /> Checking...
        </span>
      );
    }

    const state = status?.status;
    if (state === 'connected') {
      return (
        <span className="text-xs px-2.5 py-1 rounded-full bg-emerald-50 text-emerald-700 font-semibold border border-emerald-200 flex items-center gap-1.5">
          <CheckCircle2 className="w-3 h-3 text-emerald-600" />
          CONNECTED
        </span>
      );
    }
    if (state === 'unpaired') {
      return (
        <span className="text-xs px-2.5 py-1 rounded-full bg-amber-50 text-amber-700 font-semibold border border-amber-200 flex items-center gap-1.5">
          <QrCode className="w-3 h-3 text-amber-600" />
          QR REQUIRED
        </span>
      );
    }
    if (state === 'error') {
      return (
        <span className="text-xs px-2.5 py-1 rounded-full bg-rose-50 text-rose-700 font-semibold border border-rose-200 flex items-center gap-1.5">
          <AlertTriangle className="w-3 h-3 text-rose-600" />
          ERROR
        </span>
      );
    }
    return (
      <span className="text-xs px-2.5 py-1 rounded-full bg-slate-100 text-slate-700 font-semibold border border-slate-200 flex items-center gap-1.5">
        <XCircle className="w-3 h-3 text-slate-500" />
        DISCONNECTED
      </span>
    );
  };

  return (
    <div className="bg-white rounded-lg border border-gray-200 p-5 shadow-sm space-y-5">
      {/* Header */}
      <div className="flex items-center justify-between pb-3 border-b border-gray-100">
        <div className="flex items-center gap-2 font-bold text-sm text-gray-900">
          <MessageSquare className="w-4 h-4 text-emerald-600" />
          WhatsApp Business Connection
        </div>
        {getStatusBadge()}
      </div>

      {/* Notifications */}
      {notification && (
        <div
          className={`p-3 rounded-md text-xs flex items-start justify-between ${
            notification.type === 'success'
              ? 'bg-emerald-50 text-emerald-800 border border-emerald-200'
              : 'bg-rose-50 text-rose-800 border border-rose-200'
          }`}
        >
          <span>{notification.message}</span>
          <button
            onClick={() => setNotification(null)}
            className="ml-2 font-bold opacity-60 hover:opacity-100"
          >
            ×
          </button>
        </div>
      )}

      {/* 4-Card Integration Status Reporting Grid */}
      <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-3">
        {/* Card 1: WhatsApp Device */}
        <div className="bg-white border border-gray-200 rounded-lg p-3 shadow-xs">
          <div className="text-[10px] font-bold text-gray-500 uppercase tracking-wider mb-1 flex items-center justify-between">
            <span>WhatsApp Device</span>
            <span
              className={`w-2 h-2 rounded-full ${
                status?.status === 'connected'
                  ? 'bg-emerald-500 animate-pulse'
                  : status?.status === 'unpaired'
                  ? 'bg-amber-500'
                  : 'bg-gray-400'
              }`}
            />
          </div>
          <div className="text-sm font-bold text-gray-900 flex items-center gap-1.5 capitalize">
            {status?.status || 'Unknown'}
          </div>
          <div className="text-[11px] text-gray-500 mt-0.5 truncate">
            Session: <span className="font-mono text-gray-700">{status?.session || 'sapj-business-whatsapp'}</span>
          </div>
        </div>

        {/* Card 2: Account Number */}
        <div className="bg-white border border-gray-200 rounded-lg p-3 shadow-xs">
          <div className="text-[10px] font-bold text-gray-500 uppercase tracking-wider mb-1 flex items-center justify-between">
            <span>Account Number</span>
            <span
              className={`w-2 h-2 rounded-full ${status?.businessPhone ? 'bg-emerald-500' : 'bg-amber-500'}`}
            />
          </div>
          <div className="text-sm font-bold text-gray-900 flex items-center gap-1 font-mono">
            {status?.businessPhone ? (
              <span className="text-emerald-800">{status.businessPhone}</span>
            ) : (
              <span className="text-amber-700 text-xs font-sans">Unable to detect</span>
            )}
          </div>
          <div className="text-[11px] text-gray-500 mt-0.5 truncate">
            {status?.identityVerifiedAt ? (
              `Verified ${new Date(status.identityVerifiedAt).toLocaleTimeString()}`
            ) : (
              'Pending session verification'
            )}
          </div>
        </div>

        {/* Card 3: Inbound Webhook */}
        <div className="bg-white border border-gray-200 rounded-lg p-3 shadow-xs">
          <div className="text-[10px] font-bold text-gray-500 uppercase tracking-wider mb-1 flex items-center justify-between">
            <span>Inbound Webhook</span>
            <span
              className={`w-2 h-2 rounded-full ${
                webhookHealth.status === 'healthy'
                  ? 'bg-emerald-500'
                  : webhookHealth.status === 'error'
                  ? 'bg-rose-500'
                  : 'bg-blue-400'
              }`}
            />
          </div>
          <div className="text-sm font-bold flex items-center gap-1.5">
            {webhookHealth.status === 'healthy' ? (
              <span className="text-emerald-700 flex items-center gap-1">
                <CheckCircle2 className="w-3.5 h-3.5 text-emerald-600" /> Healthy (200 OK)
              </span>
            ) : webhookHealth.status === 'error' ? (
              <span className="text-rose-700 flex items-center gap-1">
                <AlertTriangle className="w-3.5 h-3.5 text-rose-600" /> Auth Error
              </span>
            ) : (
              <span className="text-slate-700 text-xs">Ready for verification</span>
            )}
          </div>
          <div className="text-[11px] text-gray-500 mt-0.5 truncate" title={webhookHealth.details}>
            {webhookHealth.details || 'ERP Ingress Route (/enquiry-whatsapp-ingress)'}
          </div>
        </div>

        {/* Card 4: Last Inbound Message */}
        <div className="bg-white border border-gray-200 rounded-lg p-3 shadow-xs">
          <div className="text-[10px] font-bold text-gray-500 uppercase tracking-wider mb-1 flex items-center justify-between">
            <span>Last Inbound Message</span>
            <span className={`w-2 h-2 rounded-full ${lastInboundTime ? 'bg-emerald-500' : 'bg-gray-300'}`} />
          </div>
          <div className="text-sm font-bold text-gray-900">
            {lastInboundTime ? new Date(lastInboundTime).toLocaleTimeString() : 'Never Received'}
          </div>
          <div className="text-[11px] text-gray-500 mt-0.5 truncate">
            {lastInboundTime ? new Date(lastInboundTime).toLocaleDateString() : 'Mirrors to CRM Inbox'}
          </div>
        </div>
      </div>

      {/* Main Connection Interface */}
      {status?.status === 'connected' && (
        <div className="space-y-4">
          <div className="bg-emerald-50/60 border border-emerald-200 rounded-lg p-4 flex flex-col md:flex-row md:items-center justify-between gap-3">
            <div className="space-y-1">
              <div className="text-xs font-semibold text-emerald-900 flex items-center gap-2">
                <Smartphone className="w-4 h-4 text-emerald-600" />
                Active WhatsApp Business Number (Sender Identity):
                {status.businessPhone ? (
                  <span className="font-mono font-bold bg-white px-2 py-0.5 rounded border border-emerald-200 text-emerald-800">
                    {status.businessPhone}
                  </span>
                ) : (
                  <span className="font-semibold bg-amber-100 text-amber-900 px-2 py-0.5 rounded border border-amber-300 text-xs">
                    Unable to detect connected number
                  </span>
                )}
              </div>
              <p className="text-[11px] text-emerald-700">
                Session: <span className="font-mono font-semibold">{status.session}</span>
                {status.identityVerifiedAt && (
                  <>
                    {' '}
                    • Verified:{' '}
                    <span className="font-medium">
                      {new Date(status.identityVerifiedAt).toLocaleTimeString()}
                    </span>{' '}
                    ({status.identitySource || 'Live Session Identity'})
                  </>
                )}
                {status.lastSeen && (
                  <>
                    {' '}
                    • Last Active:{' '}
                    <span className="font-medium">
                      {new Date(status.lastSeen).toLocaleTimeString()}
                    </span>
                  </>
                )}
              </p>
            </div>

            <div className="flex items-center gap-2">
              <button
                onClick={handleTestInbound}
                disabled={actionLoading !== null}
                className="px-3 py-1.5 text-xs font-semibold bg-white text-emerald-700 border border-emerald-300 rounded hover:bg-emerald-50 transition flex items-center gap-1.5 shadow-sm disabled:opacity-50"
              >
                {actionLoading === 'test-inbound' ? (
                  <RefreshCw className="w-3.5 h-3.5 animate-spin" />
                ) : (
                  <Send className="w-3.5 h-3.5" />
                )}
                Test Inbound Message
              </button>

              <button
                onClick={handleDisconnect}
                disabled={actionLoading !== null}
                className="px-3 py-1.5 text-xs font-semibold bg-rose-50 text-rose-700 border border-rose-200 rounded hover:bg-rose-100 transition flex items-center gap-1.5 shadow-sm disabled:opacity-50"
              >
                {actionLoading === 'disconnect' ? (
                  <RefreshCw className="w-3.5 h-3.5 animate-spin" />
                ) : (
                  <Unplug className="w-3.5 h-3.5" />
                )}
                Disconnect
              </button>
            </div>
          </div>

          {/* Sender Identity vs Recipient Distinction Banner */}
          <div className="bg-slate-50 border border-slate-200 rounded-lg p-3 text-xs text-slate-700 space-y-1.5">
            <div className="font-semibold text-slate-900 flex items-center gap-1.5">
              <Info className="w-4 h-4 text-blue-600" />
              Official WhatsApp Number Architecture & Routing:
            </div>
            <div className="grid grid-cols-1 md:grid-cols-2 gap-2 pt-1 text-[11px]">
              <div className="p-2.5 bg-white rounded border border-slate-200">
                <span className="font-bold text-slate-900 block">Connected Business Number (Sender):</span>
                <span className="font-mono font-semibold text-emerald-700">
                  {status.businessPhone || 'Unable to detect connected number'}
                </span>
                <p className="text-slate-500 mt-0.5">
                  Official SAPJ sender identity verified from the active WhatsApp session. Outbound messages originate from this number.
                </p>
              </div>
              <div className="p-2.5 bg-white rounded border border-slate-200">
                <span className="font-bold text-slate-900 block">Customer Mobile Number (Recipient):</span>
                <span className="font-mono text-slate-700">+62 8xx / Individual contact</span>
                <p className="text-slate-500 mt-0.5">
                  Destination customer phone stored in CRM contacts & inquiry details. Never mixed with sender identity.
                </p>
              </div>
            </div>
          </div>
        </div>
      )}

      {status?.status === 'unpaired' && (
        <div className="space-y-4">
          <div className="bg-amber-50/60 border border-amber-200 rounded-lg p-4 space-y-3">
            <div className="flex items-start justify-between">
              <div>
                <h4 className="text-xs font-bold text-amber-900 flex items-center gap-1.5">
                  <QrCode className="w-4 h-4 text-amber-700" />
                  Scan QR Code to Authenticate SAPJ WhatsApp Business
                </h4>
                <p className="text-[11px] text-amber-700 mt-0.5">
                  Open WhatsApp on your mobile phone, go to <strong>Linked Devices</strong>, and
                  scan the QR code below.
                </p>
              </div>

              <div className="flex items-center gap-2">
                <button
                  onClick={() => setIsEnlarged(true)}
                  disabled={!status.qrCode}
                  className="px-2.5 py-1 text-xs font-medium text-slate-700 bg-white border border-slate-300 rounded hover:bg-slate-50 transition flex items-center gap-1.5 shadow-sm disabled:opacity-50"
                  title="Expand QR code to large high-contrast display"
                >
                  <Maximize2 className="w-3.5 h-3.5 text-slate-600" />
                  Enlarge QR
                </button>

                <button
                  onClick={() => {
                    const proxyUrl = import.meta.env.VITE_WHATSAPP_PROXY_URL || '/api/whatsapp';
                    window.open(`${proxyUrl}/api/session/qr`, '_blank');
                  }}
                  className="px-2.5 py-1 text-xs font-medium text-slate-700 bg-white border border-slate-300 rounded hover:bg-slate-50 transition flex items-center gap-1 shadow-sm"
                  title="Open QR in dedicated tab for easy scanning"
                >
                  <ExternalLink className="w-3 h-3 text-slate-500" />
                  Fullscreen QR
                </button>

                <button
                  onClick={handleRefreshQr}
                  disabled={actionLoading !== null}
                  className="px-2.5 py-1 text-xs font-medium text-amber-800 bg-white border border-amber-300 rounded hover:bg-amber-50 transition flex items-center gap-1 disabled:opacity-50"
                >
                  <RefreshCw
                    className={`w-3 h-3 ${actionLoading === 'refresh-qr' ? 'animate-spin' : ''}`}
                  />
                  Refresh QR
                </button>
              </div>
            </div>

            {/* QR Code container */}
            <div className="flex flex-col items-center justify-center p-5 bg-white rounded-xl border border-amber-200 shadow-inner">
              {status.qrCode ? (
                <div className="relative group p-3 bg-white rounded-xl border border-gray-100 shadow-sm">
                  <img
                    src={status.qrCode}
                    alt="WhatsApp Business QR Code"
                    className="w-72 h-72 sm:w-80 sm:h-80 md:w-96 md:h-96 max-w-[400px] aspect-square object-contain rounded"
                    style={{
                      imageRendering: 'pixelated',
                      WebkitOptimizeContrast: 'true',
                    } as React.CSSProperties}
                  />
                  <div className="absolute inset-0 bg-slate-900/15 opacity-0 group-hover:opacity-100 transition-opacity flex items-center justify-center rounded-xl backdrop-blur-[1px]">
                    <button
                      onClick={() => setIsEnlarged(true)}
                      className="bg-slate-900/90 hover:bg-slate-900 text-white text-xs font-semibold px-3.5 py-2 rounded-lg shadow-lg flex items-center gap-1.5 transition"
                    >
                      <Maximize2 className="w-3.5 h-3.5" />
                      Enlarge QR Code
                    </button>
                  </div>
                </div>
              ) : (
                <div className="w-72 h-72 sm:w-80 sm:h-80 md:w-96 md:h-96 max-w-[400px] aspect-square flex flex-col items-center justify-center text-gray-400 border border-dashed border-gray-300 rounded-xl">
                  <RefreshCw className="w-7 h-7 animate-spin mb-2.5 text-amber-500" />
                  <span className="text-xs font-medium text-gray-600">Generating Authentic QR...</span>
                  <span className="text-[11px] text-gray-400 mt-0.5">Starting WhatsApp Chromium instance</span>
                </div>
              )}
              <div className="flex items-center gap-2 mt-3">
                <span className="text-xs text-gray-500">
                  Session: <span className="font-mono text-gray-700 font-semibold">{status.session}</span>
                </span>
                <span className="text-gray-300">&bull;</span>
                <button
                  onClick={() => setIsEnlarged(true)}
                  disabled={!status.qrCode}
                  className="text-xs text-amber-700 hover:text-amber-800 font-medium underline inline-flex items-center gap-1 disabled:opacity-50"
                >
                  <Maximize2 className="w-3 h-3" />
                  Click to enlarge (high-contrast view)
                </button>
              </div>
            </div>

            {/* Automatic Detection Info */}
            <div className="pt-2 border-t border-amber-200/60 flex items-center justify-between text-xs text-amber-900">
              <div className="flex items-center gap-2">
                <span className="w-2 h-2 rounded-full bg-amber-500 animate-pulse" />
                <span className="font-medium">
                  Awaiting scan from WhatsApp Business... Camera active. Linking will confirm
                  automatically.
                </span>
              </div>
              <span className="text-[11px] text-amber-700 font-mono">Auto-refreshes every 3s</span>
            </div>
          </div>

          {/* Enlarged QR Modal */}
          {isEnlarged && status?.qrCode && (
            <div
              className="fixed inset-0 z-50 bg-slate-950/85 backdrop-blur-sm flex items-center justify-center p-4"
              onClick={() => setIsEnlarged(false)}
            >
              <div
                className="bg-slate-900 border border-slate-700 rounded-2xl p-6 sm:p-7 max-w-lg w-full text-center relative shadow-2xl flex flex-col items-center animate-in fade-in duration-200"
                onClick={(e) => e.stopPropagation()}
              >
                <button
                  onClick={() => setIsEnlarged(false)}
                  className="absolute top-4 right-4 p-1.5 rounded-full bg-slate-800 hover:bg-slate-700 text-slate-300 hover:text-white transition"
                  title="Close modal"
                >
                  <X className="w-5 h-5" />
                </button>

                <div className="inline-flex items-center gap-2 bg-emerald-500/10 border border-emerald-500/20 text-emerald-400 text-xs font-semibold px-3 py-1 rounded-full mb-3">
                  <span className="w-2 h-2 rounded-full bg-emerald-400 animate-pulse" />
                  High-Contrast Pairing Mode
                </div>

                <h3 className="text-lg font-bold text-white mb-1">Scan WhatsApp Business QR</h3>
                <p className="text-xs text-slate-400 mb-5 max-w-xs">
                  Open WhatsApp Business &rarr; Linked Devices &rarr; Link a Device and point camera at the code below.
                </p>

                <div className="bg-white p-5 rounded-2xl shadow-xl flex items-center justify-center">
                  <img
                    src={status.qrCode}
                    alt="WhatsApp QR Enlarged"
                    className="w-72 h-72 sm:w-96 sm:h-96 md:w-[420px] md:h-[420px] aspect-square object-contain"
                    style={{
                      imageRendering: 'pixelated',
                      WebkitOptimizeContrast: 'true',
                    } as React.CSSProperties}
                  />
                </div>

                <div className="flex items-center justify-between w-full mt-5 pt-4 border-t border-slate-800 text-xs text-slate-400">
                  <span>Session: <code className="text-sky-400 font-mono font-semibold">{status.session}</code></span>
                  <span className="text-slate-500">Auto-refreshes live every 3s</span>
                </div>
              </div>
            </div>
          )}
        </div>
      )}

      {(status?.status === 'disconnected' || !status?.status) && (
        <div className="space-y-4">
          <div className="bg-slate-50 border border-slate-200 rounded-lg p-5 text-center space-y-3">
            <Smartphone className="w-8 h-8 text-slate-400 mx-auto" />
            <div>
              <h4 className="text-sm font-bold text-gray-900">WhatsApp Business Not Connected</h4>
              <p className="text-xs text-gray-600 mt-1 max-w-md mx-auto">
                Connect the SAPJ WhatsApp Business number to receive customer inquiries, send
                quotes, and reply directly from the unified CRM Inbox.
              </p>
            </div>

            <button
              onClick={handleConnect}
              disabled={actionLoading !== null}
              className="px-4 py-2 text-xs font-bold text-white bg-emerald-600 hover:bg-emerald-700 rounded-lg shadow transition inline-flex items-center gap-2 disabled:opacity-50"
            >
              {actionLoading === 'connect' ? (
                <RefreshCw className="w-3.5 h-3.5 animate-spin" />
              ) : (
                <QrCode className="w-3.5 h-3.5" />
              )}
              Connect Business WhatsApp
            </button>
          </div>
        </div>
      )}

      {status?.status === 'error' && (
        <div className="space-y-4">
          <div className="bg-rose-50 border border-rose-200 rounded-lg p-4 space-y-3">
            <div className="flex items-start gap-2 text-rose-800">
              <AlertTriangle className="w-4 h-4 text-rose-600 shrink-0 mt-0.5" />
              <div className="text-xs">
                <p className="font-bold">WhatsApp Session Error</p>
                <p className="mt-0.5 text-rose-700">
                  {status.error || 'Connection failed or transport adapter unreachable.'}
                </p>
              </div>
            </div>

            <div className="flex justify-end gap-2 pt-2">
              <button
                onClick={handleConnect}
                disabled={actionLoading !== null}
                className="px-3 py-1.5 text-xs font-semibold bg-rose-600 text-white rounded hover:bg-rose-700 transition flex items-center gap-1.5 shadow-sm disabled:opacity-50"
              >
                <RefreshCw
                  className={`w-3.5 h-3.5 ${actionLoading === 'connect' ? 'animate-spin' : ''}`}
                />
                Retry Connection
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Integration Guide Footer */}
      <div className="pt-2 border-t border-gray-100 flex items-center justify-between text-[11px] text-gray-500">
        <span>
          Adapter:{' '}
          <code className="text-gray-700">
            Protected Local Proxy (/api/whatsapp &rarr; localhost:3100)
          </code>
        </span>
        <span>
          Recipient Matching: <code className="text-gray-700">Enquiry Tier-1 Safe Matching</code>
        </span>
      </div>
    </div>
  );
}
