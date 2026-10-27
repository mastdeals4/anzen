/*
  Enforce active customer name uniqueness.

  Rules:
  - Active customer names are unique case-insensitively.
  - Leading/trailing spaces are ignored.
  - Existing duplicates are not deleted or silently merged. If duplicates exist,
    this migration stops and reports the conflicting normalized names. Review
    public.duplicate_active_customer_names, then merge records manually or call
    public.rename_customer_for_deduplication(customer_id, new_name) before
    rerunning this migration.
*/

DO $$
DECLARE
  v_duplicates text;
BEGIN
  SELECT string_agg(format('%s (%s records)', normalized_name, duplicate_count), ', ')
  INTO v_duplicates
  FROM public.duplicate_active_customer_names;

  IF v_duplicates IS NOT NULL THEN
    RAISE EXCEPTION
      'Duplicate active customer names found: %. Review public.duplicate_active_customer_names, then merge records manually or call public.rename_customer_for_deduplication(customer_id, new_name) before rerunning this migration.',
      v_duplicates;
  END IF;
END $$;

CREATE UNIQUE INDEX IF NOT EXISTS customers_company_name_normalized_active_unique
  ON public.customers (lower(btrim(company_name)))
  WHERE COALESCE(is_active, true) = true;

CREATE OR REPLACE FUNCTION public.customer_name_exists(
  p_company_name text,
  p_exclude_customer_id uuid DEFAULT NULL
)
RETURNS boolean
LANGUAGE sql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
  SELECT EXISTS (
    SELECT 1
    FROM public.customers c
    WHERE COALESCE(c.is_active, true) = true
      AND lower(btrim(c.company_name)) = lower(btrim(p_company_name))
      AND (p_exclude_customer_id IS NULL OR c.id <> p_exclude_customer_id)
  );
$$;

REVOKE ALL ON FUNCTION public.customer_name_exists(text, uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.customer_name_exists(text, uuid) TO authenticated;

COMMENT ON INDEX public.customers_company_name_normalized_active_unique IS
  'Prevents duplicate active customer company names, ignoring case and leading/trailing spaces.';

NOTIFY pgrst, 'reload schema';
