-- Fix gmail_connections schema mismatch and consolidate get_gmail_connection_secret
-- 1. Ensure token_accessed_at column exists on public.gmail_connections
-- 2. Drop conflicting 1-argument get_gmail_connection_secret(uuid) overload
-- 3. Consolidate to canonical get_gmail_connection_secret(uuid, uuid) referencing live schema columns

BEGIN;

-- 1. Add token_accessed_at audit column intended by earlier migrations
ALTER TABLE public.gmail_connections
  ADD COLUMN IF NOT EXISTS token_accessed_at timestamptz;

-- 2. Drop the duplicate/conflicting 1-argument overload returning text
DROP FUNCTION IF EXISTS public.get_gmail_connection_secret(uuid);

-- 3. Consolidate to the canonical implementation returning TABLE
CREATE OR REPLACE FUNCTION public.get_gmail_connection_secret(
  p_connection_id uuid DEFAULT NULL::uuid,
  p_user_id uuid DEFAULT NULL::uuid
)
RETURNS TABLE(
  id uuid,
  user_id uuid,
  email_address text,
  access_token text,
  refresh_token text,
  access_token_expires_at timestamp with time zone,
  is_connected boolean,
  sync_enabled boolean,
  last_sync timestamp with time zone,
  sync_frequency_minutes integer
)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public', 'pg_temp'
AS $function$
BEGIN
  IF auth.role() <> 'service_role' THEN
    IF auth.uid() IS NULL THEN
      RAISE EXCEPTION 'Not authenticated';
    END IF;
    -- Both scoping args cannot be NULL — that would return every row.
    IF p_connection_id IS NULL AND p_user_id IS NULL THEN
      RAISE EXCEPTION 'A connection_id or user_id must be provided';
    END IF;
    -- If user_id is provided, it must match auth.uid().
    IF p_user_id IS NOT NULL AND p_user_id <> auth.uid() THEN
      RAISE EXCEPTION 'Forbidden';
    END IF;
    -- If only connection_id is provided, verify it belongs to the caller.
    IF p_user_id IS NULL AND p_connection_id IS NOT NULL THEN
      IF NOT EXISTS (
        SELECT 1 FROM public.gmail_connections gc
        WHERE gc.id = p_connection_id AND gc.user_id = auth.uid()
      ) THEN
        RAISE EXCEPTION 'Forbidden';
      END IF;
    END IF;
  END IF;

  UPDATE public.gmail_connections gc
  SET token_accessed_at = now()
  WHERE (p_connection_id IS NULL OR gc.id = p_connection_id)
    AND (p_user_id IS NULL OR gc.user_id = p_user_id)
    AND gc.is_connected = true;

  RETURN QUERY
  SELECT
    gc.id,
    gc.user_id,
    gc.email_address,
    gc.access_token,
    gc.refresh_token,
    gc.access_token_expires_at,
    gc.is_connected,
    gc.sync_enabled,
    gc.last_sync,
    gc.sync_frequency_minutes
  FROM public.gmail_connections gc
  WHERE (p_connection_id IS NULL OR gc.id = p_connection_id)
    AND (p_user_id IS NULL OR gc.user_id = p_user_id)
    AND gc.is_connected = true;
END;
$function$;

REVOKE ALL ON FUNCTION public.get_gmail_connection_secret(uuid, uuid) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.get_gmail_connection_secret(uuid, uuid) FROM anon;
GRANT EXECUTE ON FUNCTION public.get_gmail_connection_secret(uuid, uuid) TO authenticated, service_role;

COMMIT;
