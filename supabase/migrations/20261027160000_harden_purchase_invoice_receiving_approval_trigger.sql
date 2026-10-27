-- Migration: 20261027160000_harden_purchase_invoice_receiving_approval_trigger.sql
-- Description: Scope purchase invoice receiving approval reset to genuine commercial alterations.
-- Prevents operational inward receiving updates (batch_id, receiving_batch_number, notes)
-- from erroneously demoting approved purchase invoices back to 'pending_approval'.
-- Introduces purchase_invoice_receiving_approval_audit for full lifecycle traceability.

BEGIN;

-- 1. Create audit table for receiving approval lifecycle transitions
CREATE TABLE IF NOT EXISTS public.purchase_invoice_receiving_approval_audit (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    purchase_invoice_id uuid NOT NULL REFERENCES public.purchase_invoices(id) ON DELETE CASCADE,
    action text NOT NULL, -- 'submitted', 'approved', 'rejected', 'reset_by_commercial_edit'
    previous_status text,
    new_status text NOT NULL,
    approved_by uuid,
    approved_at timestamptz,
    reason text,
    actor_id uuid DEFAULT auth.uid(),
    created_at timestamptz DEFAULT now() NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_pi_receiving_approval_audit_invoice_id 
    ON public.purchase_invoice_receiving_approval_audit(purchase_invoice_id);

GRANT SELECT, INSERT ON public.purchase_invoice_receiving_approval_audit TO authenticated, service_role;

-- 2. Refine reset_receiving_approval_on_item_change
CREATE OR REPLACE FUNCTION public.reset_receiving_approval_on_item_change()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public', 'pg_temp'
AS $$
DECLARE
  v_invoice_id uuid := COALESCE(NEW.purchase_invoice_id, OLD.purchase_invoice_id);
  v_inv public.purchase_invoices%ROWTYPE;
  v_is_commercial_change boolean := false;
BEGIN
  -- Operational/receiving updates (batch_id, receiving_batch_number, make, expiry, container, notes, landed costs)
  -- do NOT invalidate commercial approval.
  IF TG_OP = 'UPDATE' THEN
    v_is_commercial_change := (
      NEW.product_id IS DISTINCT FROM OLD.product_id OR
      NEW.item_type IS DISTINCT FROM OLD.item_type OR
      NEW.quantity IS DISTINCT FROM OLD.quantity OR
      NEW.unit_price IS DISTINCT FROM OLD.unit_price OR
      NEW.discount_percent IS DISTINCT FROM OLD.discount_percent OR
      NEW.tax_code_id IS DISTINCT FROM OLD.tax_code_id OR
      NEW.tax_amount IS DISTINCT FROM OLD.tax_amount OR
      NEW.line_total IS DISTINCT FROM OLD.line_total OR
      NEW.expense_account_id IS DISTINCT FROM OLD.expense_account_id OR
      NEW.asset_account_id IS DISTINCT FROM OLD.asset_account_id
    );

    IF NOT v_is_commercial_change THEN
      RETURN NEW;
    END IF;
  END IF;

  SELECT * INTO v_inv FROM public.purchase_invoices WHERE id = v_invoice_id FOR UPDATE;
  IF FOUND AND v_inv.receiving_approval_status = 'approved' THEN
    -- If items have already been physically received, commercial alteration cannot silently demote status
    IF EXISTS (SELECT 1 FROM public.purchase_invoice_receiving_allocations WHERE purchase_invoice_id = v_invoice_id) THEN
      RETURN COALESCE(NEW, OLD);
    END IF;

    -- Archive prior approval info into audit log
    INSERT INTO public.purchase_invoice_receiving_approval_audit (
      purchase_invoice_id, action, previous_status, new_status, approved_by, approved_at, reason, actor_id
    ) VALUES (
      v_invoice_id, 'reset_by_commercial_edit', 'approved', 'pending_approval',
      v_inv.receiving_approved_by, v_inv.receiving_approved_at,
      'Commercial line item changed (' || TG_OP || ')', auth.uid()
    );

    UPDATE public.purchase_invoices
       SET receiving_approval_status = 'pending_approval',
           receiving_rejection_reason = NULL,
           receiving_submitted_at = now(),
           receiving_submitted_by = auth.uid(),
           updated_at = now()
     WHERE id = v_invoice_id AND receiving_approval_status = 'approved';
  END IF;

  IF TG_OP = 'DELETE' THEN RETURN OLD; END IF;
  RETURN NEW;
END;
$$;

-- 3. Replace trg_reset_receiving_approval_on_item_change with column-specific trigger
DROP TRIGGER IF EXISTS trg_reset_receiving_approval_on_item_change ON public.purchase_invoice_items;
CREATE TRIGGER trg_reset_receiving_approval_on_item_change
AFTER INSERT OR DELETE OR UPDATE OF product_id, item_type, quantity, unit_price, discount_percent, tax_code_id, tax_amount, line_total, expense_account_id, asset_account_id
ON public.purchase_invoice_items
FOR EACH ROW
EXECUTE FUNCTION public.reset_receiving_approval_on_item_change();

-- 4. Refine reset_receiving_approval_on_invoice_change
CREATE OR REPLACE FUNCTION public.reset_receiving_approval_on_invoice_change()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public', 'pg_temp'
AS $$
BEGIN
  -- Administrative edits (notes, document attachments) do not invalidate commercial receiving approval
  IF OLD.receiving_approval_status = 'approved' AND (
    NEW.supplier_id IS DISTINCT FROM OLD.supplier_id OR
    NEW.invoice_date IS DISTINCT FROM OLD.invoice_date OR
    NEW.total_amount IS DISTINCT FROM OLD.total_amount OR
    NEW.currency IS DISTINCT FROM OLD.currency
  ) THEN
    -- If items have already been physically received, preserve receiving status
    IF EXISTS (SELECT 1 FROM public.purchase_invoice_receiving_allocations WHERE purchase_invoice_id = OLD.id) THEN
      RETURN NEW;
    END IF;

    INSERT INTO public.purchase_invoice_receiving_approval_audit (
      purchase_invoice_id, action, previous_status, new_status, approved_by, approved_at, reason, actor_id
    ) VALUES (
      OLD.id, 'reset_by_commercial_edit', OLD.receiving_approval_status, 'pending_approval',
      OLD.receiving_approved_by, OLD.receiving_approved_at,
      'Commercial invoice header changed (supplier/date/total/currency)', auth.uid()
    );

    NEW.receiving_approval_status := 'pending_approval';
    NEW.receiving_rejection_reason := NULL;
    NEW.receiving_submitted_at := now();
    NEW.receiving_submitted_by := auth.uid();
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_reset_receiving_approval_on_invoice_change ON public.purchase_invoices;
CREATE TRIGGER trg_reset_receiving_approval_on_invoice_change
BEFORE UPDATE OF supplier_id, invoice_date, total_amount, currency
ON public.purchase_invoices
FOR EACH ROW
EXECUTE FUNCTION public.reset_receiving_approval_on_invoice_change();

-- 5. Harden approve_purchase_invoice_for_receiving (Idempotent & Audit-logged)
CREATE OR REPLACE FUNCTION public.approve_purchase_invoice_for_receiving(p_purchase_invoice_id uuid)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE v_invoice public.purchase_invoices%ROWTYPE;
BEGIN
  IF NOT public.inventory_v1_actor_allowed(ARRAY['admin', 'accounts']) THEN 
    RAISE EXCEPTION 'Permission denied'; 
  END IF;
  
  SELECT * INTO v_invoice FROM public.purchase_invoices WHERE id = p_purchase_invoice_id FOR UPDATE;
  IF NOT FOUND THEN 
    RAISE EXCEPTION 'Purchase Invoice not found'; 
  END IF;

  -- Idempotency: if already approved, return success without mutating metadata
  IF v_invoice.receiving_approval_status = 'approved' THEN
    RETURN jsonb_build_object('success', true, 'status', 'approved', 'already_approved', true);
  END IF;

  IF v_invoice.receiving_approval_status <> 'pending_approval' THEN 
    RAISE EXCEPTION 'Purchase Invoice must be pending approval'; 
  END IF;

  INSERT INTO public.purchase_invoice_receiving_approval_audit (
    purchase_invoice_id, action, previous_status, new_status, approved_by, approved_at, actor_id
  ) VALUES (
    p_purchase_invoice_id, 'approved', v_invoice.receiving_approval_status, 'approved',
    auth.uid(), now(), auth.uid()
  );

  UPDATE public.purchase_invoices 
     SET receiving_approval_status = 'approved',
         receiving_approved_at = now(),
         receiving_approved_by = auth.uid(),
         receiving_rejection_reason = NULL,
         updated_at = now() 
   WHERE id = p_purchase_invoice_id;

  RETURN jsonb_build_object('success', true, 'status', 'approved');
END;
$function$;

-- 6. Harden submit_purchase_invoice_for_receiving
CREATE OR REPLACE FUNCTION public.submit_purchase_invoice_for_receiving(p_purchase_invoice_id uuid)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE v_invoice public.purchase_invoices%ROWTYPE;
BEGIN
  IF NOT public.inventory_v1_actor_allowed(ARRAY['admin', 'accounts']) THEN 
    RAISE EXCEPTION 'Permission denied'; 
  END IF;
  
  SELECT * INTO v_invoice FROM public.purchase_invoices WHERE id = p_purchase_invoice_id FOR UPDATE;
  IF NOT FOUND THEN 
    RAISE EXCEPTION 'Purchase Invoice not found'; 
  END IF;
  
  IF v_invoice.status = 'cancelled' THEN 
    RAISE EXCEPTION 'Cancelled Purchase Invoice cannot be submitted'; 
  END IF;

  IF v_invoice.receiving_approval_status = 'approved' THEN
    RAISE EXCEPTION 'Purchase Invoice is already approved for receiving';
  END IF;

  INSERT INTO public.purchase_invoice_receiving_approval_audit (
    purchase_invoice_id, action, previous_status, new_status, approved_by, approved_at, actor_id
  ) VALUES (
    p_purchase_invoice_id, 'submitted', v_invoice.receiving_approval_status, 'pending_approval',
    v_invoice.receiving_approved_by, v_invoice.receiving_approved_at, auth.uid()
  );

  UPDATE public.purchase_invoices 
     SET receiving_approval_status = 'pending_approval',
         receiving_submitted_at = now(),
         receiving_submitted_by = auth.uid(),
         receiving_rejection_reason = NULL,
         updated_at = now() 
   WHERE id = p_purchase_invoice_id;

  RETURN jsonb_build_object('success', true, 'status', 'pending_approval');
END;
$function$;

COMMIT;

-- ============================================================================
-- VERIFICATION QUERIES (Read-Only)
-- ============================================================================
-- 1. Verify triggers are created with explicit column lists:
-- SELECT tgname, tgtype, tgenabled, relname 
-- FROM pg_trigger t JOIN pg_class c ON c.oid = t.tgrelid 
-- WHERE tgname IN ('trg_reset_receiving_approval_on_item_change', 'trg_reset_receiving_approval_on_invoice_change');

-- ============================================================================
-- ROLLBACK SCRIPT (Reference only)
-- ============================================================================
-- DROP TRIGGER IF EXISTS trg_reset_receiving_approval_on_item_change ON public.purchase_invoice_items;
-- CREATE TRIGGER trg_reset_receiving_approval_on_item_change AFTER INSERT OR DELETE OR UPDATE ON public.purchase_invoice_items FOR EACH ROW EXECUTE FUNCTION public.reset_receiving_approval_on_item_change();
-- DROP TRIGGER IF EXISTS trg_reset_receiving_approval_on_invoice_change ON public.purchase_invoices;
-- CREATE TRIGGER trg_reset_receiving_approval_on_invoice_change BEFORE UPDATE OF supplier_id, invoice_date, total_amount, currency, document_urls, notes ON public.purchase_invoices FOR EACH ROW EXECUTE FUNCTION public.reset_receiving_approval_on_invoice_change();
-- DROP TABLE IF EXISTS public.purchase_invoice_receiving_approval_audit;

