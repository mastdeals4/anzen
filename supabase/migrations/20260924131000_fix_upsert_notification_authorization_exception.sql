-- Fix upsert_notification to deny unauthorized cross-user notifications gracefully
-- without raising fatal database exceptions that storm postgres logs and cause statement timeouts.

BEGIN;

CREATE OR REPLACE FUNCTION public.upsert_notification(
  p_user_id uuid,
  p_type text,
  p_title text,
  p_message text,
  p_reference_id uuid DEFAULT NULL::uuid,
  p_reference_type text DEFAULT NULL::text
)
RETURNS boolean
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_inserted integer := 0;
  v_caller uuid := auth.uid();
  v_jwt_role text := current_setting('request.jwt.claim.role', true);
BEGIN
  -- Service role is always authorized
  IF v_jwt_role = 'service_role' THEN
    INSERT INTO notifications (user_id, type, title, message, reference_id, reference_type, is_read)
    VALUES (p_user_id, p_type, p_title, p_message, p_reference_id, p_reference_type, false)
    ON CONFLICT DO NOTHING;

    GET DIAGNOSTICS v_inserted = ROW_COUNT;
    RETURN v_inserted > 0;
  END IF;

  -- Must be authenticated
  IF v_caller IS NULL THEN
    RETURN false;
  END IF;

  -- Caller can only notify themselves unless they are admin or manager
  IF v_caller != p_user_id THEN
    IF NOT EXISTS (
      SELECT 1 FROM public.user_profiles 
      WHERE id = v_caller AND role IN ('admin', 'manager')
    ) THEN
      -- Deny unauthorized cross-user notification gracefully without raising a fatal DB exception
      RETURN false;
    END IF;
  END IF;

  INSERT INTO notifications (user_id, type, title, message, reference_id, reference_type, is_read)
  VALUES (p_user_id, p_type, p_title, p_message, p_reference_id, p_reference_type, false)
  ON CONFLICT DO NOTHING;

  GET DIAGNOSTICS v_inserted = ROW_COUNT;
  RETURN v_inserted > 0;
END;
$$;

REVOKE ALL ON FUNCTION public.upsert_notification(uuid, text, text, text, uuid, text) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.upsert_notification(uuid, text, text, text, uuid, text) FROM anon;
GRANT EXECUTE ON FUNCTION public.upsert_notification(uuid, text, text, text, uuid, text) TO authenticated, service_role;

COMMIT;
