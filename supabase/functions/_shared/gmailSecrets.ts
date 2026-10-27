export interface GmailConnectionSecret {
  id: string;
  user_id: string;
  email_address: string;
  access_token: string;
  refresh_token: string;
  access_token_expires_at: string | null;
  is_connected: boolean;
  sync_enabled?: boolean;
  last_sync?: string | null;
  sync_frequency_minutes?: number | null;
}

export async function getGmailConnectionSecret(
  supabase: any,
  args: { connectionId?: string | null; userId?: string | null },
): Promise<GmailConnectionSecret | null> {
  const { data, error } = await supabase
    .rpc("get_gmail_connection_secret", {
      p_connection_id: args.connectionId || null,
      p_user_id: args.userId || null,
    });

  if (!error && Array.isArray(data) && data[0]) {
    return data[0] as GmailConnectionSecret;
  }

  // Backward-compatible fallback for deployments before the encryption migration.
  let query = supabase.from("gmail_connections").select("*").eq("is_connected", true);
  if (args.connectionId) query = query.eq("id", args.connectionId);
  if (args.userId) query = query.eq("user_id", args.userId);
  const { data: legacy } = await query.limit(1).maybeSingle();
  return legacy as GmailConnectionSecret | null;
}

export async function listGmailConnectionSecrets(
  supabase: any,
  args: { userId?: string | null; syncEnabled?: boolean },
): Promise<GmailConnectionSecret[]> {
  const { data, error } = await supabase
    .rpc("get_gmail_connection_secret", {
      p_connection_id: null,
      p_user_id: args.userId || null,
    });

  if (!error && Array.isArray(data)) {
    return (data as GmailConnectionSecret[])
      .filter(conn => args.syncEnabled === undefined || conn.sync_enabled === args.syncEnabled);
  }

  let query = supabase.from("gmail_connections").select("*").eq("is_connected", true);
  if (args.userId) query = query.eq("user_id", args.userId);
  if (args.syncEnabled !== undefined) query = query.eq("sync_enabled", args.syncEnabled);
  const { data: legacy } = await query;
  return (legacy || []) as GmailConnectionSecret[];
}
