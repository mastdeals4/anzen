import { useEffect, useRef } from 'react';
import type { RealtimePostgresChangesPayload } from '@supabase/supabase-js';
import { supabase } from '../lib/supabase';

export type RealtimeEvent = 'INSERT' | 'UPDATE' | 'DELETE' | '*';

export interface RealtimeChannelOptions {
  channelName: string;                  // stable per component
  table: string;
  schema?: string;                      // default 'public'
  event?: RealtimeEvent;                // default '*'
  filter?: string;                      // 'user_id=eq.<uuid>' etc.
  enabled?: boolean;                    // default true
  onEvent: (payload: RealtimePostgresChangesPayload<Record<string, unknown>>) => void;
}

// Module-level ownership map guards against StrictMode double-mounts and
// multiple mounted copies of a screen using the same stable channel name.
// The token check in cleanup prevents an older effect from removing a newer
// subscription that replaced it.
const activeChannels = new Map<string, { token: symbol; channel: ReturnType<typeof supabase.channel> }>();

/**
 * Stable, StrictMode-safe realtime subscription.
 *  - Channel created once per (channelName + table + filter + enabled) change.
 *  - onEvent is stored in a ref so identity churn does not resubscribe.
 *  - Cleans up with removeChannel on unmount / dep change.
 *  - Prevents duplicate channels with the same name in the module cache.
 */
export function useSupabaseRealtimeChannel(opts: RealtimeChannelOptions): void {
  const {
    channelName,
    table,
    schema = 'public',
    event = '*',
    filter = '',
    enabled = true,
    onEvent,
  } = opts;

  const onEventRef = useRef(onEvent);
  useEffect(() => {
    onEventRef.current = onEvent;
  });

  useEffect(() => {
    if (!enabled) return;

    // If a channel with this name is already active (StrictMode double-mount
    // or a stale subscription), tear it down first.
    const token = Symbol(channelName);
    const existingEntry = activeChannels.get(channelName);
    if (existingEntry) {
      // Best-effort removal: supabase.removeChannel accepts channel objects,
      // but getChannels() lets us find by topic.
      supabase.removeChannel(existingEntry.channel);
      activeChannels.delete(channelName);
    }

    const changeConfig: Record<string, string> = {
      event,
      schema,
      table,
    };
    if (filter) changeConfig.filter = filter;

    // Realtime connections can be unavailable temporarily (for example while
    // a device is offline or the hosted websocket endpoint is restarting).
    // Recreate the channel with bounded backoff instead of surfacing an
    // unhandled websocket error or leaving the subscription permanently dead.
    let disposed = false;
    let retryTimer: number | undefined;
    let retryAttempt = 0;
    let channel: ReturnType<typeof supabase.channel> | undefined;
    let subscribing = false;

    const scheduleRetry = () => {
      if (disposed || retryTimer !== undefined) return;
      const delay = Math.min(30_000, 1_000 * 2 ** retryAttempt++);
      retryTimer = window.setTimeout(() => {
        retryTimer = undefined;
        subscribe();
      }, delay);
    };

    const subscribe = () => {
      if (disposed || subscribing) return;
      subscribing = true;
      if (channel) supabase.removeChannel(channel);
      channel = supabase.channel(channelName);

      // The postgres_changes typings are permissive; cast to any to satisfy
      // the overload without narrowing the caller payload type.
      (channel as unknown as { on: (t: string, cfg: Record<string, string>, cb: (p: RealtimePostgresChangesPayload<Record<string, unknown>>) => void) => unknown })
        .on('postgres_changes', changeConfig, (payload) => {
          onEventRef.current(payload);
        });

      channel.subscribe((status) => {
        subscribing = false;
        if (disposed) return;
        if (status === 'SUBSCRIBED') {
          retryAttempt = 0;
          return;
        }
        if (status === 'CHANNEL_ERROR' || status === 'TIMED_OUT' || status === 'CLOSED') {
          scheduleRetry();
        }
      });
      activeChannels.set(channelName, { token, channel });
    };

    subscribe();

    return () => {
      disposed = true;
      if (retryTimer !== undefined) window.clearTimeout(retryTimer);
      if (channel) supabase.removeChannel(channel);
      const current = activeChannels.get(channelName);
      if (current?.token === token) activeChannels.delete(channelName);
    };
  }, [channelName, table, schema, event, filter, enabled]);
}
