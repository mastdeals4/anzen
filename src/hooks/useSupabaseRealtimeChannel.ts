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

    // Create one channel for this effect lifecycle. Supabase's client manages
    // reconnects for an established channel; replacing channels here can
    // create overlapping sockets and noisy close-before-established errors.
    let disposed = false;
    let channel: ReturnType<typeof supabase.channel> | undefined;
    let subscribing = false;

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
          return;
        }
        // Supabase owns reconnecting an established socket. Avoid creating
        // replacement channels here: doing so while a connection is still
        // opening causes repeated close-before-established errors and
        // duplicate subscriptions.
      });
      activeChannels.set(channelName, { token, channel });
    };

    subscribe();

    return () => {
      disposed = true;
      if (channel) supabase.removeChannel(channel);
      const current = activeChannels.get(channelName);
      if (current?.token === token) activeChannels.delete(channelName);
    };
  }, [channelName, table, schema, event, filter, enabled]);
}
