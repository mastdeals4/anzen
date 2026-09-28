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
} from 'lucide-react';
import { EnquiryWhatsAppService, WhatsAppConnectionStatusResult } from '../../../services/enquiry/EnquiryWhatsAppService';

export function WhatsAppSettings() {
  const [loading, setLoading] = useState<boolean>(true);
  const [actionLoading, setActionLoading] = useState<string | null>(null);
  const [status, setStatus] = useState<WhatsAppConnectionStatusResult | null>(null);
  const [phoneInput, setPhoneInput] = useState<string>('+628119999999');
  const [notification, setNotification] = useState<{ type: 'success' | 'error'; message: string } | null>(null);

  const fetchStatus = useCallback(async () => {
    try {
      const res = await EnquiryWhatsAppService.getConnectionStatus();
      setStatus(res);
      if (res.businessPhone) {
        setPhoneInput(res.businessPhone);
      }
    } catch (e: any) {
      setStatus({
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
    const interval = setInterval(fetchStatus, 15000);
    return () => clearInterval(interval);
  }, [fetchStatus]);

  const handleConnect = async () => {
    setActionLoading('connect');
    setNotification(null);
    try {
      const res = await EnquiryWhatsAppService.connectSession();
      setStatus(res);
      setNotification({ type: 'success', message: 'WhatsApp session initialized. Scan QR code to complete pairing.' });
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
      setNotification({ type: 'success', message: `WhatsApp Business session successfully connected (${phoneInput})!` });
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
      const res = await EnquiryWhatsAppService.injectTestInbound({
        messageId: testMsgId,
        chatId: `${testPhone.replace(/\D/g, '')}@c.us`,
        senderPhone: testPhone,
        senderName: 'PT Test Customer',
        businessPhone: status?.businessPhone || phoneInput,
        text: 'Halo SAPJ, kami butuh penawaran resmi untuk Paracetamol BP dan Amoxicillin Trihydrate 500kg. Mohon info ketersediaan stok.',
        receivedAt: new Date().toISOString(),
      });

      if (res.success) {
        setNotification({
          type: 'success',
          message: 'Test inbound message successfully mirrored! Check CRM → Inbox → WhatsApp tab.',
        });
      } else {
        setNotification({ type: 'error', message: res.error || 'Failed to inject test inbound message' });
      }
    } catch (e: any) {
      setNotification({ type: 'error', message: e.message || 'Error sending test inbound message' });
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

      {/* Main Connection Interface */}
      {status?.status === 'connected' && (
        <div className="space-y-4">
          <div className="bg-emerald-50/60 border border-emerald-200 rounded-lg p-4 flex flex-col md:flex-row md:items-center justify-between gap-3">
            <div className="space-y-1">
              <div className="text-xs font-semibold text-emerald-900 flex items-center gap-2">
                <Smartphone className="w-4 h-4 text-emerald-600" />
                Active WhatsApp Business Number:
                <span className="font-mono font-bold bg-white px-2 py-0.5 rounded border border-emerald-200 text-emerald-800">
                  {status.businessPhone || '+628119999999'}
                </span>
              </div>
              <p className="text-[11px] text-emerald-700">
                Session: <span className="font-mono">{status.session}</span> • Last Active:{' '}
                {status.lastSeen ? new Date(status.lastSeen).toLocaleTimeString() : 'Just now'}
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

          <div className="bg-slate-50 border border-slate-200 rounded-lg p-3 text-xs text-slate-600 space-y-1">
            <p className="font-semibold text-slate-800 flex items-center gap-1">
              <Info className="w-3.5 h-3.5 text-blue-500" />
              Omnichannel Inbox Routing:
            </p>
            <p>
              Inbound messages sent to <strong>{status.businessPhone || '+628119999999'}</strong> are mirrored directly into{' '}
              <strong>CRM → Inbox → WhatsApp</strong> tab. Outbound replies sent by staff will originate from this number.
            </p>
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
                  Open WhatsApp on your mobile phone, go to <strong>Linked Devices</strong>, and scan the QR code below.
                </p>
              </div>

              <button
                onClick={handleRefreshQr}
                disabled={actionLoading !== null}
                className="px-2.5 py-1 text-xs font-medium text-amber-800 bg-white border border-amber-300 rounded hover:bg-amber-50 transition flex items-center gap-1 disabled:opacity-50"
              >
                <RefreshCw className={`w-3 h-3 ${actionLoading === 'refresh-qr' ? 'animate-spin' : ''}`} />
                Refresh QR
              </button>
            </div>

            {/* QR Code container */}
            <div className="flex flex-col items-center justify-center p-4 bg-white rounded-lg border border-amber-200 shadow-inner">
              {status.qrCode ? (
                <img
                  src={status.qrCode}
                  alt="WhatsApp Business QR Code"
                  className="w-48 h-48 rounded border border-gray-200 shadow-sm"
                />
              ) : (
                <div className="w-48 h-48 flex flex-col items-center justify-center text-gray-400 border border-dashed border-gray-300 rounded">
                  <RefreshCw className="w-6 h-6 animate-spin mb-2 text-amber-500" />
                  <span className="text-xs">Generating QR...</span>
                </div>
              )}
              <span className="text-[11px] text-gray-500 mt-2">
                Session ID: <span className="font-mono text-gray-700">{status.session}</span>
              </span>
            </div>

            {/* Manual Pair / Confirmation Option */}
            <div className="pt-2 border-t border-amber-200/60 flex flex-col sm:flex-row items-center justify-between gap-3">
              <div className="w-full sm:w-auto flex items-center gap-2">
                <label className="text-xs font-semibold text-amber-900 whitespace-nowrap">
                  Business Phone:
                </label>
                <input
                  type="text"
                  value={phoneInput}
                  onChange={(e) => setPhoneInput(e.target.value)}
                  placeholder="+628119999999"
                  className="px-2.5 py-1 text-xs border border-gray-300 rounded focus:ring-1 focus:ring-amber-500 font-mono w-40"
                />
              </div>

              <button
                onClick={handlePair}
                disabled={actionLoading !== null}
                className="w-full sm:w-auto px-4 py-1.5 text-xs font-bold text-white bg-emerald-600 hover:bg-emerald-700 rounded shadow transition flex items-center justify-center gap-1.5 disabled:opacity-50"
              >
                {actionLoading === 'pair' ? (
                  <RefreshCw className="w-3.5 h-3.5 animate-spin" />
                ) : (
                  <CheckCircle2 className="w-3.5 h-3.5" />
                )}
                Confirm QR Scanned / Pair
              </button>
            </div>
          </div>
        </div>
      )}

      {(status?.status === 'disconnected' || !status?.status) && (
        <div className="space-y-4">
          <div className="bg-slate-50 border border-slate-200 rounded-lg p-5 text-center space-y-3">
            <Smartphone className="w-8 h-8 text-slate-400 mx-auto" />
            <div>
              <h4 className="text-sm font-bold text-gray-900">WhatsApp Business Not Connected</h4>
              <p className="text-xs text-gray-600 mt-1 max-w-md mx-auto">
                Connect the SAPJ WhatsApp Business number to receive customer inquiries, send quotes, and reply directly from the unified CRM Inbox.
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
                <p className="mt-0.5 text-rose-700">{status.error || 'Connection failed or transport adapter unreachable.'}</p>
              </div>
            </div>

            <div className="flex justify-end gap-2 pt-2">
              <button
                onClick={handleConnect}
                disabled={actionLoading !== null}
                className="px-3 py-1.5 text-xs font-semibold bg-rose-600 text-white rounded hover:bg-rose-700 transition flex items-center gap-1.5 shadow-sm disabled:opacity-50"
              >
                <RefreshCw className={`w-3.5 h-3.5 ${actionLoading === 'connect' ? 'animate-spin' : ''}`} />
                Retry Connection
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Integration Guide Footer */}
      <div className="pt-2 border-t border-gray-100 flex items-center justify-between text-[11px] text-gray-500">
        <span>Adapter: <code className="text-gray-700">OpenWA Transport (Port 3100)</code></span>
        <span>Recipient Matching: <code className="text-gray-700">Enquiry Tier-1 Safe Matching</code></span>
      </div>
    </div>
  );
}
