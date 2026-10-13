-- ============================================================================
-- Fix User Management: Deactivate User RLS and Delete User Safety
-- ============================================================================
-- 1. Add RLS policy allowing active administrators to UPDATE user profiles.
--    The existing policy "Users can update own profile" only allowed id = auth.uid(),
--    which caused PostgREST updates on other users to silently match 0 rows.
-- 2. Add public.admin_toggle_user_status RPC for atomic status updates.
-- 3. Add public.check_user_can_delete RPC to protect historical business & audit records.
-- 4. Add public.admin_delete_user RPC for atomic, safe deletion of unreferenced users.
-- ============================================================================

-- 1. RLS Policy on user_profiles for Administrators
DROP POLICY IF EXISTS "Admins can update user profiles" ON public.user_profiles;
CREATE POLICY "Admins can update user profiles"
  ON public.user_profiles FOR UPDATE
  TO authenticated
  USING (
    EXISTS (
      SELECT 1 FROM public.user_profiles admin_p
      WHERE admin_p.id = (SELECT auth.uid()) AND admin_p.role = 'admin' AND admin_p.is_active = true
    )
  )
  WITH CHECK (
    EXISTS (
      SELECT 1 FROM public.user_profiles admin_p
      WHERE admin_p.id = (SELECT auth.uid()) AND admin_p.role = 'admin' AND admin_p.is_active = true
    )
  );

-- 2. Atomic RPC for Toggling User Status (Activate / Deactivate)
CREATE OR REPLACE FUNCTION public.admin_toggle_user_status(
  p_user_id uuid,
  p_is_active boolean
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_caller_id uuid;
  v_caller_role text;
  v_caller_active boolean;
  v_target_user record;
  v_other_admin_count integer;
BEGIN
  v_caller_id := auth.uid();
  IF v_caller_id IS NULL THEN
    RAISE EXCEPTION 'Not authenticated';
  END IF;

  SELECT role, is_active INTO v_caller_role, v_caller_active
  FROM public.user_profiles
  WHERE id = v_caller_id;

  IF v_caller_role <> 'admin' OR v_caller_active IS NOT TRUE THEN
    RAISE EXCEPTION 'Only active administrators can modify user status';
  END IF;

  SELECT * INTO v_target_user
  FROM public.user_profiles
  WHERE id = p_user_id;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'User not found';
  END IF;

  -- Prevent self-deactivation
  IF v_caller_id = p_user_id AND p_is_active IS FALSE THEN
    RAISE EXCEPTION 'You cannot deactivate your own account';
  END IF;

  -- Ensure at least one active admin remains
  IF v_target_user.role = 'admin' AND v_target_user.is_active IS TRUE AND p_is_active IS FALSE THEN
    SELECT COUNT(*) INTO v_other_admin_count
    FROM public.user_profiles
    WHERE role = 'admin' AND is_active IS TRUE AND id <> p_user_id;

    IF v_other_admin_count = 0 THEN
      RAISE EXCEPTION 'Cannot deactivate the last active administrator';
    END IF;
  END IF;

  UPDATE public.user_profiles
  SET is_active = p_is_active,
      updated_at = now()
  WHERE id = p_user_id;

  RETURN jsonb_build_object(
    'success', true,
    'user_id', p_user_id,
    'username', v_target_user.username,
    'is_active', p_is_active
  );
END;
$$;

REVOKE ALL ON FUNCTION public.admin_toggle_user_status(uuid, boolean) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.admin_toggle_user_status(uuid, boolean) TO authenticated, service_role;

-- 3. Pre-check function to verify if a user has business or audit records
CREATE OR REPLACE FUNCTION public.check_user_can_delete(p_user_id uuid)
RETURNS TABLE(can_delete boolean, reason text, reference_count integer)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_target_user record;
  v_total_refs integer := 0;
  v_count integer;
  v_details text := '';
  v_other_admin_count integer;
BEGIN
  SELECT * INTO v_target_user
  FROM public.user_profiles
  WHERE id = p_user_id;

  IF NOT FOUND THEN
    RETURN QUERY SELECT false, 'User profile not found', 0;
    RETURN;
  END IF;

  -- Check if target is last active admin
  IF v_target_user.role = 'admin' AND v_target_user.is_active IS TRUE THEN
    SELECT COUNT(*) INTO v_other_admin_count
    FROM public.user_profiles
    WHERE role = 'admin' AND is_active IS TRUE AND id <> p_user_id;

    IF v_other_admin_count = 0 THEN
      RETURN QUERY SELECT false, 'Cannot delete the last active administrator', 0;
      RETURN;
    END IF;
  END IF;

  -- Check audit_logs
  SELECT COUNT(*) INTO v_count FROM public.audit_logs WHERE user_id = p_user_id;
  IF v_count > 0 THEN
    v_total_refs := v_total_refs + v_count;
    v_details := v_details || format('audit logs (%s), ', v_count);
  END IF;

  -- Check finance_expenses
  SELECT COUNT(*) INTO v_count FROM public.finance_expenses WHERE created_by = p_user_id OR approved_by = p_user_id;
  IF v_count > 0 THEN
    v_total_refs := v_total_refs + v_count;
    v_details := v_details || format('expenses (%s), ', v_count);
  END IF;

  -- Check sales_invoices
  SELECT COUNT(*) INTO v_count FROM public.sales_invoices WHERE created_by = p_user_id;
  IF v_count > 0 THEN
    v_total_refs := v_total_refs + v_count;
    v_details := v_details || format('sales invoices (%s), ', v_count);
  END IF;

  -- Check purchase_invoices
  SELECT COUNT(*) INTO v_count FROM public.purchase_invoices WHERE receiving_submitted_by = p_user_id OR receiving_approved_by = p_user_id;
  IF v_count > 0 THEN
    v_total_refs := v_total_refs + v_count;
    v_details := v_details || format('purchase invoices (%s), ', v_count);
  END IF;

  -- Check batches
  SELECT COUNT(*) INTO v_count FROM public.batches WHERE created_by = p_user_id;
  IF v_count > 0 THEN
    v_total_refs := v_total_refs + v_count;
    v_details := v_details || format('batches (%s), ', v_count);
  END IF;

  -- Check products
  SELECT COUNT(*) INTO v_count FROM public.products WHERE created_by = p_user_id;
  IF v_count > 0 THEN
    v_total_refs := v_total_refs + v_count;
    v_details := v_details || format('products (%s), ', v_count);
  END IF;

  -- Check inventory_transactions
  SELECT COUNT(*) INTO v_count FROM public.inventory_transactions WHERE created_by = p_user_id;
  IF v_count > 0 THEN
    v_total_refs := v_total_refs + v_count;
    v_details := v_details || format('inventory transactions (%s), ', v_count);
  END IF;

  -- Check customer_payments & vendor_payments
  SELECT COUNT(*) INTO v_count FROM public.customer_payments WHERE created_by = p_user_id;
  IF v_count > 0 THEN
    v_total_refs := v_total_refs + v_count;
    v_details := v_details || format('customer payments (%s), ', v_count);
  END IF;

  SELECT COUNT(*) INTO v_count FROM public.vendor_payments WHERE created_by = p_user_id;
  IF v_count > 0 THEN
    v_total_refs := v_total_refs + v_count;
    v_details := v_details || format('vendor payments (%s), ', v_count);
  END IF;

  -- Check tasks
  SELECT COUNT(*) INTO v_count FROM public.tasks WHERE created_by = p_user_id OR completed_by = p_user_id;
  IF v_count > 0 THEN
    v_total_refs := v_total_refs + v_count;
    v_details := v_details || format('tasks (%s), ', v_count);
  END IF;

  IF v_total_refs > 0 THEN
    v_details := rtrim(v_details, ', ');
    RETURN QUERY SELECT false, 
      format('Cannot delete user "%s": user is associated with historical financial, business, or audit records (%s). Deactivate the user instead to preserve audit history.', v_target_user.username, v_details),
      v_total_refs;
  ELSE
    RETURN QUERY SELECT true, 'User has no historical business records and can be safely deleted.', 0;
  END IF;
END;
$$;

REVOKE ALL ON FUNCTION public.check_user_can_delete(uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.check_user_can_delete(uuid) TO authenticated, service_role;

-- 4. Atomic RPC for deleting an unreferenced user
CREATE OR REPLACE FUNCTION public.admin_delete_user(p_user_id uuid)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_caller_id uuid;
  v_caller_role text;
  v_caller_active boolean;
  v_can_del boolean;
  v_reason text;
  v_refs integer;
  v_username text;
BEGIN
  v_caller_id := auth.uid();
  IF v_caller_id IS NULL THEN
    RAISE EXCEPTION 'Not authenticated';
  END IF;

  SELECT role, is_active INTO v_caller_role, v_caller_active
  FROM public.user_profiles
  WHERE id = v_caller_id;

  IF v_caller_role <> 'admin' OR v_caller_active IS NOT TRUE THEN
    RAISE EXCEPTION 'Only active administrators can delete users';
  END IF;

  IF v_caller_id = p_user_id THEN
    RAISE EXCEPTION 'You cannot delete your own account';
  END IF;

  SELECT username INTO v_username
  FROM public.user_profiles
  WHERE id = p_user_id;

  IF v_username IS NULL THEN
    RAISE EXCEPTION 'User not found';
  END IF;

  SELECT can_delete, reason, reference_count INTO v_can_del, v_reason, v_refs
  FROM public.check_user_can_delete(p_user_id);

  IF v_can_del IS NOT TRUE THEN
    RAISE EXCEPTION '%', v_reason;
  END IF;

  -- Safe to delete: remove permissions, profile, and auth record
  DELETE FROM public.user_permissions WHERE user_id = p_user_id;
  DELETE FROM public.user_profiles WHERE id = p_user_id;
  DELETE FROM auth.users WHERE id = p_user_id;

  RETURN jsonb_build_object(
    'success', true,
    'user_id', p_user_id,
    'username', v_username,
    'message', 'User deleted successfully'
  );
END;
$$;

REVOKE ALL ON FUNCTION public.admin_delete_user(uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.admin_delete_user(uuid) TO authenticated, service_role;
