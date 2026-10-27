/*
  # Posting guard logic

  Adds a reusable posting guard to enforce:
  1) approval_status must be 'approved'
  2) posting date cannot be earlier than locked_period_date
*/

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM information_schema.columns
    WHERE table_schema = 'public'
      AND table_name = 'app_settings'
      AND column_name = 'locked_period_date'
  ) THEN
    ALTER TABLE public.app_settings
      ADD COLUMN locked_period_date date;
  END IF;
END $$;

CREATE OR REPLACE FUNCTION public.assert_posting_allowed(
  p_approval_status text,
  p_posting_date date
)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_locked_period_date date;
BEGIN
  IF COALESCE(p_approval_status, '') <> 'approved' THEN
    RAISE EXCEPTION 'Posting blocked: approval_status must be ''approved''. Current value: %.', COALESCE(p_approval_status, 'NULL');
  END IF;

  IF p_posting_date IS NULL THEN
    RAISE EXCEPTION 'Posting blocked: posting date is required.';
  END IF;

  SELECT s.locked_period_date
  INTO v_locked_period_date
  FROM public.app_settings s
  ORDER BY s.updated_at DESC NULLS LAST, s.created_at DESC NULLS LAST
  LIMIT 1;

  IF v_locked_period_date IS NOT NULL AND p_posting_date < v_locked_period_date THEN
    RAISE EXCEPTION 'Posting blocked: posting date (%) is before locked period date (%).', p_posting_date, v_locked_period_date;
  END IF;
END;
$$;

GRANT EXECUTE ON FUNCTION public.assert_posting_allowed(text, date) TO authenticated;

COMMENT ON FUNCTION public.assert_posting_allowed(text, date) IS
'Reusable posting guard. Allows posting only when approval_status = approved and posting_date >= app_settings.locked_period_date (if configured).';
