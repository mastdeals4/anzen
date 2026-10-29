/**
 * SAPJ ERP — Centralized In-App & Cross-Tab Real-Time Synchronization Bus
 *
 * Provides ultra-fast, zero-I/O real-time coordination across open browser tabs,
 * parent/child components, modals, and screens, combined with Supabase Realtime
 * for cross-user/cross-device synchronization.
 *
 * Resource Efficiency Guardrails:
 * - 0ms cross-tab latency via browser BroadcastChannel (zero Supabase database requests).
 * - Debounced execution (default 150ms) prevents redundant queries during batch mutations.
 * - Tab visibility awareness: tabs in background queue a single dirty flag and refresh
 *   only when the operator switches back into view.
 */

import { useEffect, useRef } from 'react';
import { supabase } from '../lib/supabase';

export type ErpDomain =
  | 'sales_orders'
  | 'inventory'
  | 'delivery_challans'
  | 'sales_invoices'
  | 'credit_notes'
  | 'expenses'
  | 'petty_cash'
  | 'bank_transactions'
  | 'vouchers'
  | 'purchases'
  | 'material_returns'
  | 'crm'
  | 'dashboard';

export type ErpSyncAction =
  | 'created'
  | 'updated'
  | 'approved'
  | 'rejected'
  | 'cancelled'
  | 'deleted'
  | 'dispatched'
  | 'received'
  | 'settled'
  | 'reconciled'
  | 'status_changed'
  | 'refresh_all';

export interface ErpSyncEvent {
  domain: ErpDomain;
  action: ErpSyncAction;
  entityId?: string;
  entityNumber?: string;
  payload?: Record<string, unknown>;
  timestamp: number;
  originTabId: string;
}

// Stable session ID for this browser tab
const TAB_ID = typeof crypto !== 'undefined' && crypto.randomUUID
  ? crypto.randomUUID()
  : `tab_${Math.random().toString(36).substring(2, 9)}_${Date.now()}`;

const BROADCAST_CHANNEL_NAME = 'sapj_erp_sync_bus';
const DOM_EVENT_NAME = 'sapj_erp_internal_sync';
const SUPABASE_SYNC_CHANNEL_NAME = 'sapj_erp_broadcast_sync';

// Global BroadcastChannel instance
let broadcastChannel: BroadcastChannel | null = null;
if (typeof window !== 'undefined' && 'BroadcastChannel' in window) {
  try {
    broadcastChannel = new BroadcastChannel(BROADCAST_CHANNEL_NAME);
  } catch (err) {
    console.warn('[ErpSyncBus] BroadcastChannel not supported in this context:', err);
  }
}

// In-memory listeners registry
type ListenerCallback = (event: ErpSyncEvent) => void;
const domainListeners = new Map<ErpDomain, Set<ListenerCallback>>();

// Dispatch event to local in-memory listeners
function notifyLocalListeners(event: ErpSyncEvent): void {
  const listeners = domainListeners.get(event.domain);
  if (listeners) {
    listeners.forEach((callback) => {
      try {
        callback(event);
      } catch (err) {
        console.error(`[ErpSyncBus] Error in listener for domain ${event.domain}:`, err);
      }
    });
  }

  // Also dispatch DOM CustomEvent for loose decoupled listeners
  if (typeof window !== 'undefined') {
    try {
      window.dispatchEvent(new CustomEvent(DOM_EVENT_NAME, { detail: event }));
    } catch {
      // ignore DOM dispatch error
    }
  }
}

// Listen for incoming events from OTHER tabs via BroadcastChannel
if (broadcastChannel) {
  broadcastChannel.onmessage = (messageEvent: MessageEvent<ErpSyncEvent>) => {
    const data = messageEvent.data;
    if (data && data.originTabId !== TAB_ID) {
      notifyLocalListeners(data);
    }
  };
}

// Global Supabase Realtime broadcast channel for cross-device/cross-user sync
let supabaseRealtimeSyncChannel: ReturnType<typeof supabase.channel> | null = null;
if (typeof window !== 'undefined') {
  try {
    supabaseRealtimeSyncChannel = supabase.channel(SUPABASE_SYNC_CHANNEL_NAME);
    supabaseRealtimeSyncChannel
      .on('broadcast', { event: 'erp_sync' }, (envelope) => {
        const payload = envelope.payload as ErpSyncEvent;
        if (payload && payload.originTabId !== TAB_ID) {
          notifyLocalListeners(payload);
        }
      })
      .subscribe((status) => {
        if (status === 'CHANNEL_ERROR') {
          console.warn('[ErpSyncBus] Supabase broadcast channel error, local BroadcastChannel remains active.');
        }
      });
  } catch (err) {
    console.warn('[ErpSyncBus] Failed to initialize Supabase Realtime broadcast:', err);
  }
}

/**
 * Broadcast an ERP synchronization event.
 * Dispatches immediately in the current tab (0ms), across browser tabs (0ms via BroadcastChannel),
 * and across the network to other users via Supabase Realtime broadcast.
 */
export function emitErpSync(
  domain: ErpDomain,
  action: ErpSyncAction,
  details?: {
    entityId?: string;
    entityNumber?: string;
    payload?: Record<string, unknown>;
  }
): void {
  const event: ErpSyncEvent = {
    domain,
    action,
    entityId: details?.entityId,
    entityNumber: details?.entityNumber,
    payload: details?.payload,
    timestamp: Date.now(),
    originTabId: TAB_ID,
  };

  // 1. Notify current tab's components immediately
  notifyLocalListeners(event);

  // 2. Notify other browser tabs
  if (broadcastChannel) {
    try {
      broadcastChannel.postMessage(event);
    } catch (err) {
      console.warn('[ErpSyncBus] BroadcastChannel postMessage failed:', err);
    }
  }

  // 3. Notify other connected users via Supabase Realtime Broadcast
  if (supabaseRealtimeSyncChannel) {
    try {
      supabaseRealtimeSyncChannel.send({
        type: 'broadcast',
        event: 'erp_sync',
        payload: event,
      }).catch(() => {
        // non-blocking
      });
    } catch {
      // non-blocking
    }
  }
}

/**
 * Register a listener for one or more ERP domains.
 */
export function subscribeErpSync(
  domains: ErpDomain | ErpDomain[],
  callback: ListenerCallback
): () => void {
  const domainList = Array.isArray(domains) ? domains : [domains];

  domainList.forEach((domain) => {
    let set = domainListeners.get(domain);
    if (!set) {
      set = new Set();
      domainListeners.set(domain, set);
    }
    set.add(callback);
  });

  return () => {
    domainList.forEach((domain) => {
      const set = domainListeners.get(domain);
      if (set) {
        set.delete(callback);
        if (set.size === 0) {
          domainListeners.delete(domain);
        }
      }
    });
  };
}

export interface UseErpSyncOptions {
  enabled?: boolean;
  debounceMs?: number;
  refreshOnFocus?: boolean;
}

/**
 * React Hook for automatic real-time synchronization of any screen/component.
 *
 * Features:
 * - Listens for domain events from the current tab, other tabs, and other users.
 * - Debounces rapid triggers (e.g. bulk line items or sequential triggers) into ONE fetch.
 * - Queueing when document is hidden: does not waste I/O while user is on another tab;
 *   refreshes once when user focuses the tab.
 */
export function useErpSyncListener(
  domains: ErpDomain | ErpDomain[],
  onSync: () => void | Promise<void>,
  options: UseErpSyncOptions = {}
): void {
  const {
    enabled = true,
    debounceMs = 150,
    refreshOnFocus = true,
  } = options;

  const callbackRef = useRef(onSync);
  useEffect(() => {
    callbackRef.current = onSync;
  });

  const timerRef = useRef<NodeJS.Timeout | null>(null);
  const pendingDirtyRef = useRef(false);
  const domainsKey = Array.isArray(domains) ? domains.join(',') : domains;

  useEffect(() => {
    if (!enabled) return;

    const executeRefresh = () => {
      if (timerRef.current) {
        clearTimeout(timerRef.current);
      }
      timerRef.current = setTimeout(() => {
        timerRef.current = null;
        pendingDirtyRef.current = false;
        try {
          const res = callbackRef.current();
          if (res && typeof (res as Promise<unknown>).catch === 'function') {
            (res as Promise<unknown>).catch((err) => {
              console.error('[useErpSyncListener] Async refresh error:', err);
            });
          }
        } catch (err) {
          console.error('[useErpSyncListener] Sync callback error:', err);
        }
      }, debounceMs);
    };

    const handleEvent = (_event: ErpSyncEvent) => {
      // If the tab is hidden, mark dirty and refresh upon return
      if (typeof document !== 'undefined' && document.hidden) {
        pendingDirtyRef.current = true;
        return;
      }
      executeRefresh();
    };

    // Handle user switching back to this tab
    const handleVisibilityChange = () => {
      if (typeof document !== 'undefined' && !document.hidden && pendingDirtyRef.current) {
        executeRefresh();
      }
    };

    const unsubscribe = subscribeErpSync(domains, handleEvent);

    if (refreshOnFocus && typeof document !== 'undefined') {
      document.addEventListener('visibilitychange', handleVisibilityChange);
      window.addEventListener('focus', handleVisibilityChange);
    }

    return () => {
      unsubscribe();
      if (timerRef.current) {
        clearTimeout(timerRef.current);
      }
      if (refreshOnFocus && typeof document !== 'undefined') {
        document.removeEventListener('visibilitychange', handleVisibilityChange);
        window.removeEventListener('focus', handleVisibilityChange);
      }
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [domainsKey, enabled, debounceMs, refreshOnFocus]);
}
