/*
  # Security Fix Part 1: Convert number generators and RLS helpers to SECURITY INVOKER

  ## Changes

  ### Number generators (11 functions) → SECURITY INVOKER
  These functions do MAX()/COUNT() on tables the authenticated user already has
  SELECT access to via RLS. SECURITY DEFINER was never needed.

  ### RLS helper functions (3 functions) → SECURITY INVOKER
  - current_user_has_pricing_role: only reads user_profiles WHERE id = auth.uid()
  - is_read_only_user: only reads user_profiles WHERE id = auth.uid()
  - lookup_email_by_username: only reads user_profiles by username (public lookup needed at login)

  All three only read the current user's own row or public username data —
  RLS SELECT policies already permit this for authenticated users.

  ## Security Impact
  - Eliminates 14 unnecessary SECURITY DEFINER privileges
  - No functional change: the queries inside are unchanged
  - anon role retains no access to any of these
*/

-- ============================================================================
-- Number generators: SECURITY INVOKER
-- ============================================================================
ALTER FUNCTION public.generate_credit_note_number()       SECURITY INVOKER;
ALTER FUNCTION public.generate_fund_transfer_number()     SECURITY INVOKER;
ALTER FUNCTION public.generate_grn_number()               SECURITY INVOKER;
ALTER FUNCTION public.generate_import_cost_number()       SECURITY INVOKER;
ALTER FUNCTION public.generate_inquiry_number()           SECURITY INVOKER;
ALTER FUNCTION public.generate_journal_entry_number()     SECURITY INVOKER;
ALTER FUNCTION public.generate_po_number()                SECURITY INVOKER;
ALTER FUNCTION public.generate_rejection_number()         SECURITY INVOKER;
ALTER FUNCTION public.generate_return_number()            SECURITY INVOKER;
ALTER FUNCTION public.generate_so_number()                SECURITY INVOKER;
ALTER FUNCTION public.generate_voucher_number(text)       SECURITY INVOKER;
ALTER FUNCTION public.next_journal_entry_number()         SECURITY INVOKER;

-- ============================================================================
-- RLS helper functions: SECURITY INVOKER
-- ============================================================================
ALTER FUNCTION public.current_user_has_pricing_role(text[])  SECURITY INVOKER;
ALTER FUNCTION public.is_read_only_user()                    SECURITY INVOKER;
ALTER FUNCTION public.lookup_email_by_username(text)         SECURITY INVOKER;
