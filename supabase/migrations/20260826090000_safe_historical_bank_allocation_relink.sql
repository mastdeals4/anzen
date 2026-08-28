-- Controlled allocation-only relink support.  This migration changes no
-- accounting data; it adds a guarded path for moving an allocation from a
-- reversed journal to its already-posted replacement journal.

CREATE OR REPLACE FUNCTION public.historical_allocation_relink_context_active()
RETURNS boolean
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
  SELECT COALESCE(current_setting('app.historical_allocation_relink', true), 'off') = 'on'
    AND (current_user IN ('postgres', 'supabase_admin') OR auth.role() = 'service_role');
$$;

REVOKE ALL ON FUNCTION public.historical_allocation_relink_context_active() FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.historical_allocation_relink_context_active() TO service_role;

-- Preserve normal reconciliation behavior. During a controlled relink only,
-- an already-confirmed paired fund-transfer leg prevents this line from being
-- promoted to confirmed, avoiding the existing unique confirmation constraint.
CREATE OR REPLACE FUNCTION public.refresh_bank_statement_allocation_status(p_bank_line_id uuid)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_total numeric;
  v_allocated numeric;
  v_existing_status text;
  v_existing_matching_status text;
  v_fund_transfer uuid;
  v_conflict boolean := false;
  v_matching_status text;
BEGIN
  SELECT COALESCE(NULLIF(debit_amount, 0), credit_amount, 0),
         reconciliation_status, matching_status, matched_fund_transfer_id
    INTO v_total, v_existing_status, v_existing_matching_status, v_fund_transfer
    FROM public.bank_statement_lines
   WHERE id = p_bank_line_id
   FOR UPDATE;

  SELECT COALESCE(sum(allocation_amount), 0)
    INTO v_allocated
    FROM public.bank_statement_allocations
   WHERE bank_statement_line_id = p_bank_line_id;

  IF v_allocated > 0.01 AND v_allocated >= v_total - 0.01
     AND v_fund_transfer IS NOT NULL
     AND public.historical_allocation_relink_context_active()
     AND EXISTS (
       SELECT 1
         FROM public.bank_statement_lines other
        WHERE other.id <> p_bank_line_id
          AND other.matched_fund_transfer_id = v_fund_transfer
          AND other.matching_status = 'confirmed'
     ) THEN
    v_conflict := true;
  END IF;

  v_matching_status := CASE
    WHEN v_allocated <= 0.01 THEN 'none'
    WHEN v_conflict AND v_existing_matching_status <> 'confirmed' THEN 'suggested'
    ELSE 'confirmed'
  END;

  UPDATE public.bank_statement_lines
     SET reconciliation_status = CASE
           WHEN v_allocated <= 0.01 THEN 'unmatched'
           WHEN v_allocated < v_total - 0.01 THEN 'partially_reconciled'
           ELSE 'matched'
         END,
         matching_status = v_matching_status,
         matched_at = CASE WHEN v_allocated <= 0.01 THEN NULL ELSE COALESCE(matched_at, now()) END,
         matched_by = CASE WHEN v_allocated <= 0.01 THEN NULL ELSE COALESCE(matched_by, auth.uid()) END,
         manually_unlinked = true
   WHERE id = p_bank_line_id;
END;
$$;

CREATE OR REPLACE FUNCTION public.relink_historical_bank_allocation(
  p_allocation_id uuid,
  p_replacement_journal_id uuid
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_alloc public.bank_statement_allocations%rowtype;
  v_old public.journal_entries%rowtype;
  v_new public.journal_entries%rowtype;
  v_before_amount numeric;
BEGIN
  IF current_user NOT IN ('postgres', 'supabase_admin')
     AND auth.role() <> 'service_role'
     AND NOT EXISTS (
       SELECT 1 FROM public.user_profiles
        WHERE id = auth.uid() AND is_active = true AND role = 'admin'
     ) THEN
    RAISE EXCEPTION 'Historical allocation relink requires admin or service_role';
  END IF;

  SELECT * INTO v_alloc
    FROM public.bank_statement_allocations
   WHERE id = p_allocation_id
   FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'Allocation not found'; END IF;

  SELECT * INTO v_old FROM public.journal_entries WHERE id = v_alloc.journal_entry_id FOR UPDATE;
  SELECT * INTO v_new FROM public.journal_entries WHERE id = p_replacement_journal_id FOR UPDATE;
  IF v_old.id IS NULL OR NOT v_old.is_reversed THEN
    RAISE EXCEPTION 'Source journal must be reversed';
  END IF;
  IF v_new.id IS NULL OR NOT v_new.is_posted OR v_new.is_reversed THEN
    RAISE EXCEPTION 'Replacement journal must be posted and not reversed';
  END IF;
  IF v_old.reference_id IS DISTINCT FROM v_new.reference_id
     AND NOT EXISTS (
       SELECT 1 FROM public.fund_transfers ft_old
       JOIN public.fund_transfers ft_new ON ft_new.id = ft_old.id
       WHERE ft_old.journal_entry_id = v_old.id AND ft_new.journal_entry_id = v_new.id
     ) THEN
    RAISE EXCEPTION 'Journals do not belong to the same underlying transaction';
  END IF;
  IF v_alloc.journal_entry_id = v_new.id THEN
    RETURN jsonb_build_object('idempotent', true, 'allocation_id', v_alloc.id,
      'journal_entry_id', v_new.id, 'allocation_amount', v_alloc.allocation_amount);
  END IF;

  v_before_amount := v_alloc.allocation_amount;
  PERFORM set_config('app.historical_allocation_relink', 'on', true);
  UPDATE public.bank_statement_allocations
     SET journal_entry_id = v_new.id
   WHERE id = v_alloc.id;

  IF (SELECT allocation_amount FROM public.bank_statement_allocations WHERE id = v_alloc.id) <> v_before_amount THEN
    RAISE EXCEPTION 'Allocation amount changed';
  END IF;

  RETURN jsonb_build_object('idempotent', false, 'allocation_id', v_alloc.id,
    'old_journal_entry_id', v_old.id, 'new_journal_entry_id', v_new.id,
    'allocation_amount', v_before_amount);
END;
$$;

REVOKE ALL ON FUNCTION public.relink_historical_bank_allocation(uuid, uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.relink_historical_bank_allocation(uuid, uuid) TO authenticated, service_role;
