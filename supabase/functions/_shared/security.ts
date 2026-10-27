import { createClient } from "npm:@supabase/supabase-js@2.57.4";

export const jsonResponse = (
  body: Record<string, unknown>,
  status: number,
  corsHeaders: Record<string, string>,
) => new Response(JSON.stringify(body), {
  status,
  headers: { ...corsHeaders, "Content-Type": "application/json" },
});

export interface AuthContext {
  user: { id: string; email?: string | null };
  role: string;
  isActive: boolean;
}

export async function requireRole(
  req: Request,
  supabaseUrl: string,
  serviceKey: string,
  allowedRoles: string[],
  corsHeaders: Record<string, string>,
): Promise<{ ok: true; adminClient: ReturnType<typeof createClient>; auth: AuthContext } | { ok: false; response: Response }> {
  const authHeader = req.headers.get("Authorization") || "";
  const jwt = authHeader.startsWith("Bearer ") ? authHeader.slice(7) : "";
  if (!jwt) {
    return { ok: false, response: jsonResponse({ error: "Missing authorization header" }, 401, corsHeaders) };
  }

  const adminClient = createClient(supabaseUrl, serviceKey, {
    auth: { autoRefreshToken: false, persistSession: false },
  });

  const { data: { user }, error: userError } = await adminClient.auth.getUser(jwt);
  if (userError || !user) {
    return { ok: false, response: jsonResponse({ error: "Unauthorized" }, 401, corsHeaders) };
  }

  const { data: profile, error: profileError } = await adminClient
    .from("user_profiles")
    .select("role,is_active")
    .eq("id", user.id)
    .maybeSingle();

  const role = String(profile?.role || "").toLowerCase();
  const isActive = profile?.is_active !== false;
  if (profileError || !profile || !isActive || !allowedRoles.includes(role)) {
    return { ok: false, response: jsonResponse({ error: "Forbidden" }, 403, corsHeaders) };
  }

  return {
    ok: true,
    adminClient,
    auth: {
      user: { id: user.id, email: user.email },
      role,
      isActive,
    },
  };
}

export async function writeSecurityAudit(
  adminClient: ReturnType<typeof createClient>,
  auth: AuthContext,
  action: string,
  details: Record<string, unknown>,
) {
  try {
    await adminClient.from("audit_logs").insert({
      user_id: auth.user.id,
      user_email: auth.user.email || null,
      table_name: "edge_function_security",
      action_type: "insert",
      new_values: {
        action,
        role: auth.role,
        ...details,
      },
      changed_fields: Object.keys(details),
    });
  } catch (error) {
    console.warn("Security audit log insert failed:", error);
  }
}
