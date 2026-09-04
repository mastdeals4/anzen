/*
  Fix upsert_notification reference_id type mismatch.

  notifications.reference_id is uuid. The RPC was created with
  p_reference_id text, which makes PostgreSQL insert a text expression into a
  uuid column and causes:
    column "reference_id" is of type uuid but expression is of type text

  Legitimate notification references are row ids from uuid primary keys, or
  NULL for daily aggregate notifications. Keep that contract explicit.
*/

DROP FUNCTION IF EXISTS public.upsert_notification(uuid, text, text, text, text, text);

CREATE OR REPLACE FUNCTION public.upsert_notification(
  p_user_id uuid,
  p_type text,
  p_title text,
  p_message text,
  p_reference_id uuid DEFAULT NULL,
  p_reference_type text DEFAULT NULL
)
RETURNS boolean
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $$
DECLARE
  v_inserted boolean := false;
BEGIN
  IF auth.uid() IS NULL THEN
    RAISE EXCEPTION 'Not authenticated';
  END IF;

  INSERT INTO notifications (user_id, type, title, message, reference_id, reference_type, is_read)
  VALUES (p_user_id, p_type, p_title, p_message, p_reference_id, p_reference_type, false)
  ON CONFLICT DO NOTHING;

  GET DIAGNOSTICS v_inserted = ROW_COUNT;
  RETURN v_inserted > 0;
EXCEPTION
  WHEN unique_violation THEN
    RETURN false;
END;
$$;

REVOKE ALL ON FUNCTION public.upsert_notification(uuid, text, text, text, uuid, text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.upsert_notification(uuid, text, text, text, uuid, text) TO authenticated;
