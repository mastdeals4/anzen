/*
  Security hardening sprint.

  Scope:
  - Remove anonymous user_profiles enumeration while preserving username login through an RPC.
  - Add Gmail token audit fields and pgcrypto-backed encryption-at-rest helpers.
  - Add storage audit/lockdown helper SQL without changing bucket permissions automatically.
*/

CREATE EXTENSION IF NOT EXISTS pgcrypto;

-- 1) user_profiles: remove broad anonymous SELECT and replace with narrow SECURITY DEFINER lookup.
DROP POLICY IF EXISTS "Allow anon username lookup for login" ON public.user_profiles;
DROP POLICY IF EXISTS "Allow username lookup for login" ON public.user_profiles;

CREATE OR REPLACE FUNCTION public.lookup_email_for_username_login(p_username text)
RETURNS TABLE(email text, is_active boolean)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  RETURN QUERY
  SELECT up.email, COALESCE(up.is_active, true)
  FROM public.user_profiles up
  WHERE up.username = lower(trim(p_username))
  LIMIT 1;
END;
$$;

REVOKE ALL ON FUNCTION public.lookup_email_for_username_login(text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.lookup_email_for_username_login(text) TO anon, authenticated;

-- 2) Gmail token encryption and audit fields.
ALTER TABLE IF EXISTS public.gmail_connections
  ADD COLUMN IF NOT EXISTS access_token_encrypted bytea,
  ADD COLUMN IF NOT EXISTS refresh_token_encrypted bytea,
  ADD COLUMN IF NOT EXISTS token_accessed_at timestamptz,
  ADD COLUMN IF NOT EXISTS token_refreshed_at timestamptz,
  ADD COLUMN IF NOT EXISTS revoked_at timestamptz;

CREATE OR REPLACE FUNCTION public.gmail_token_encryption_key()
RETURNS text
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_key text;
BEGIN
  v_key := current_setting('app.gmail_token_encryption_key', true);
  IF v_key IS NULL OR length(v_key) < 32 THEN
    RAISE EXCEPTION 'Gmail token encryption key is not configured';
  END IF;
  RETURN v_key;
END;
$$;

REVOKE ALL ON FUNCTION public.gmail_token_encryption_key() FROM PUBLIC;

CREATE OR REPLACE FUNCTION public.encrypt_gmail_token(p_token text)
RETURNS bytea
LANGUAGE sql
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT CASE
    WHEN p_token IS NULL OR p_token = '' THEN NULL
    ELSE pgp_sym_encrypt(p_token, public.gmail_token_encryption_key(), 'cipher-algo=aes256,compress-algo=1')
  END;
$$;

CREATE OR REPLACE FUNCTION public.decrypt_gmail_token(p_token bytea)
RETURNS text
LANGUAGE sql
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT CASE
    WHEN p_token IS NULL THEN NULL
    ELSE pgp_sym_decrypt(p_token, public.gmail_token_encryption_key())
  END;
$$;

REVOKE ALL ON FUNCTION public.encrypt_gmail_token(text) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.decrypt_gmail_token(bytea) FROM PUBLIC;

CREATE OR REPLACE FUNCTION public.trg_encrypt_gmail_connection_tokens()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  IF NEW.access_token IS NOT NULL THEN
    NEW.access_token_encrypted := public.encrypt_gmail_token(NEW.access_token);
    NEW.access_token := NULL;
  END IF;

  IF NEW.refresh_token IS NOT NULL THEN
    NEW.refresh_token_encrypted := public.encrypt_gmail_token(NEW.refresh_token);
    NEW.refresh_token := NULL;
  END IF;

  IF TG_OP = 'UPDATE' AND NEW.access_token_encrypted IS DISTINCT FROM OLD.access_token_encrypted THEN
    NEW.token_refreshed_at := now();
  END IF;

  IF NEW.is_connected = false AND OLD.is_connected IS DISTINCT FROM false THEN
    NEW.revoked_at := COALESCE(NEW.revoked_at, now());
  END IF;

  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS encrypt_gmail_connection_tokens ON public.gmail_connections;
CREATE TRIGGER encrypt_gmail_connection_tokens
  BEFORE INSERT OR UPDATE OF access_token, refresh_token, is_connected
  ON public.gmail_connections
  FOR EACH ROW
  EXECUTE FUNCTION public.trg_encrypt_gmail_connection_tokens();

CREATE OR REPLACE FUNCTION public.get_gmail_connection_secret(
  p_connection_id uuid DEFAULT NULL,
  p_user_id uuid DEFAULT NULL
)
RETURNS TABLE(
  id uuid,
  user_id uuid,
  email_address text,
  access_token text,
  refresh_token text,
  access_token_expires_at timestamptz,
  is_connected boolean,
  sync_enabled boolean,
  last_sync timestamptz,
  sync_frequency_minutes integer
)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  IF auth.role() <> 'service_role' THEN
    IF auth.uid() IS NULL THEN
      RAISE EXCEPTION 'Not authenticated';
    END IF;
    IF p_user_id IS NOT NULL AND p_user_id <> auth.uid() THEN
      RAISE EXCEPTION 'Forbidden';
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
    COALESCE(gc.access_token, public.decrypt_gmail_token(gc.access_token_encrypted)) AS access_token,
    COALESCE(gc.refresh_token, public.decrypt_gmail_token(gc.refresh_token_encrypted)) AS refresh_token,
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
$$;

REVOKE ALL ON FUNCTION public.get_gmail_connection_secret(uuid, uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.get_gmail_connection_secret(uuid, uuid) TO authenticated, service_role;

-- Encrypt existing plaintext tokens only after app.gmail_token_encryption_key has been configured.
DO $$
BEGIN
  IF current_setting('app.gmail_token_encryption_key', true) IS NOT NULL THEN
    UPDATE public.gmail_connections
    SET
      access_token_encrypted = COALESCE(access_token_encrypted, public.encrypt_gmail_token(access_token)),
      refresh_token_encrypted = COALESCE(refresh_token_encrypted, public.encrypt_gmail_token(refresh_token)),
      access_token = NULL,
      refresh_token = NULL
    WHERE access_token IS NOT NULL OR refresh_token IS NOT NULL;
  END IF;
END $$;

-- 3) Storage audit helpers. These do not change bucket permissions.
CREATE OR REPLACE VIEW public.storage_bucket_security_audit AS
SELECT
  b.id AS bucket_name,
  b.public,
  CASE b.id
    WHEN 'crm-documents' THEN 'CRM inquiry/product documents'
    WHEN 'sales-order-documents' THEN 'Sales order and customer PO documents'
    WHEN 'documents' THEN 'General app documents'
    WHEN 'purchase-invoices' THEN 'Purchase invoice documents'
    WHEN 'petty-cash-receipts' THEN 'Petty cash receipts'
    WHEN 'expense-documents' THEN 'Expense documents'
    WHEN 'bank-statements' THEN 'Bank statement uploads'
    WHEN 'task-attachments' THEN 'Task attachments'
    WHEN 'product-documents' THEN 'Product documents'
    WHEN 'product-source-documents' THEN 'Product source documents'
    WHEN 'batch-documents' THEN 'Batch/import documents'
    WHEN 'rejection_photos' THEN 'Stock rejection photos'
    WHEN 'inventory_photos' THEN 'Inventory photos'
    ELSE 'Review required'
  END AS purpose
FROM storage.buckets b
ORDER BY b.id;

GRANT SELECT ON public.storage_bucket_security_audit TO authenticated;
