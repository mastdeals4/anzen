/*
  Prepare active customer name deduplication.

  This migration does not delete, merge, or rename any customer rows. It creates
  a report view for duplicate active customer names and a guarded helper that
  can be used to rename one duplicate at a time before enforcing uniqueness.
*/

CREATE OR REPLACE VIEW public.duplicate_active_customer_names AS
SELECT
  lower(btrim(company_name)) AS normalized_name,
  count(*) AS duplicate_count,
  jsonb_agg(
    jsonb_build_object(
      'id', id,
      'company_name', company_name,
      'contact_person', contact_person,
      'email', email,
      'phone', phone,
      'created_at', created_at
    )
    ORDER BY created_at, id
  ) AS customers
FROM public.customers
WHERE COALESCE(is_active, true) = true
GROUP BY lower(btrim(company_name))
HAVING count(*) > 1;

CREATE OR REPLACE FUNCTION public.rename_customer_for_deduplication(
  p_customer_id uuid,
  p_new_company_name text
)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
BEGIN
  IF btrim(COALESCE(p_new_company_name, '')) = '' THEN
    RAISE EXCEPTION 'Customer name is required';
  END IF;

  IF EXISTS (
    SELECT 1
    FROM public.customers c
    WHERE COALESCE(c.is_active, true) = true
      AND c.id <> p_customer_id
      AND lower(btrim(c.company_name)) = lower(btrim(p_new_company_name))
  ) THEN
    RAISE EXCEPTION 'A customer with this name already exists.';
  END IF;

  UPDATE public.customers
  SET company_name = btrim(p_new_company_name),
      updated_at = now()
  WHERE id = p_customer_id;
END;
$$;

REVOKE ALL ON FUNCTION public.rename_customer_for_deduplication(uuid, text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.rename_customer_for_deduplication(uuid, text) TO authenticated;
GRANT SELECT ON public.duplicate_active_customer_names TO authenticated;

COMMENT ON VIEW public.duplicate_active_customer_names IS
  'Lists active customer records that conflict under lower(btrim(company_name)); use before enforcing the unique index.';

COMMENT ON FUNCTION public.rename_customer_for_deduplication(uuid, text) IS
  'Renames a customer after checking the new name does not conflict with another active customer.';
