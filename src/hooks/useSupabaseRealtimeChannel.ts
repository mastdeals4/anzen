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

// Module-level cache of active channel names to guard against StrictMode
// double-mounts creating duplicate subscriptions.
const activeChannels = new Set<string>();

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
    if (activeChannels.has(channelName)) {
      // Best-effort removal: supabase.removeChannel accepts channel objects,
      // but getChannels() lets us find by topic.
      const existing = supabase.getChannels().find((c) => c.topic === `realtime:${channelName}`);
      if (existing) {
        supabase.removeChannel(existing);
      }
      activeChannels.delete(channelName);
    }

    const channel = supabase.channel(channelName);

    const changeConfig: Record<string, string> = {
      event,
      schema,
      table,
    };
    if (filter) changeConfig.filter = filter;

    // The postgres_changes typings are permissive; cast to any to satisfy the
    // overload without narrowing the caller payload type.
    (channel as unknown as { on: (t: string, cfg: Record<string, string>, cb: (p: RealtimePostgresChangesPayload<Record<string, unknown>>) => void) => unknown })
      .on('postgres_changes', changeConfig, (payload) => {
        onEventRef.current(payload);
      });

    channel.subscribe();
    activeChannels.add(channelName);

    return () => {
      supabase.removeChannel(channel);
      activeChannels.delete(channelName);
    };
  }, [channelName, table, schema, event, filter, enabled]);
}
