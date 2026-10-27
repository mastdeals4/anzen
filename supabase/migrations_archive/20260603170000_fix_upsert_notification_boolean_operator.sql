/*
  Fix upsert_notification: operator does not exist: boolean > integer

  Root cause:
    v_inserted was declared as boolean but GET DIAGNOSTICS ROW_COUNT
    returns bigint. PostgreSQL coerces the value for assignment, but
    RETURN v_inserted > 0 then tries boolean > integer — an operator
    that doesn't exist.

  Fix:
    Declare v_inserted as integer (ROW_COUNT is bigint, but integer
    is wide enough for row counts and avoids a cast when comparing).
*/

DROP FUNCTION IF EXISTS public.upsert_notification(uuid, text, text, text, text, text);
DROP FUNCTION IF EXISTS public.upsert_notification(uuid, text, text, text, uuid, text);

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
  v_inserted integer := 0;
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
