/*
  # Fix permission denied on generate_inquiry_number for authenticated users

  1. Problem
    - The sales role (authenticated) gets "permission denied for function
      generate_inquiry_number" when creating inquiries via CRM Command Center.
    - The trigger `set_inquiry_number` calls `generate_inquiry_number()` during
      INSERT on `crm_inquiries`. Both are SECURITY DEFINER but lacked an
      explicit GRANT EXECUTE to `authenticated`.
    - Security hardening migrations revoked PUBLIC execute from SECURITY DEFINER
      functions but never re-granted these two inquiry helpers.

  2. Fix
    - GRANT EXECUTE on `generate_inquiry_number()` to authenticated
    - GRANT EXECUTE on `set_inquiry_number()` to authenticated
    - Both functions remain SECURITY DEFINER (they need to read all rows for
      sequence numbering) and are safe to expose since they only generate a
      sequential text number.

  3. Security Notes
    - No change to function bodies or ownership
    - No change to RLS policies
    - Only adds EXECUTE permission that was inadvertently removed
*/

GRANT EXECUTE ON FUNCTION public.generate_inquiry_number() TO authenticated;
GRANT EXECUTE ON FUNCTION public.set_inquiry_number() TO authenticated;
